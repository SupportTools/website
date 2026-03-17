---
title: "Kubernetes Node Problem Detector: Identifying and Responding to Node Failures"
date: 2028-10-30T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Node Management", "Troubleshooting", "Monitoring", "SRE"]
categories:
- Kubernetes
- SRE
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Node Problem Detector deployment, built-in problem daemons, custom problem definitions, NodeCondition reporting, Cluster Autoscaler integration, Prometheus metrics, and correlating node conditions with application issues."
more_link: "yes"
url: "/kubernetes-node-problem-detector-troubleshooting-guide/"
---

Kubernetes nodes fail in subtle ways that are invisible to standard health checks. A kernel OOM killer event, an NFS mount hanging, GPU driver crashes, and corrupt container runtime state all degrade pods without triggering `NodeNotReady`. Node Problem Detector (NPD) fills this gap by monitoring kernel logs, system logs, and custom scripts, surfacing problems as NodeConditions and Kubernetes Events that can trigger automated remediation or Cluster Autoscaler node replacement.

<!--more-->

# Kubernetes Node Problem Detector: Production Deployment Guide

## Understanding Node Problem Detector Architecture

NPD runs as a DaemonSet, one pod per node. Each pod runs multiple "problem daemons" that watch specific log sources or run scripts. When a problem is detected, NPD does one of two things:

1. **NodeCondition**: Sets a condition on the Node object (e.g., `KernelDeadlock=True`). Conditions persist until cleared.
2. **Event**: Creates a Kubernetes Event on the Node. Events expire after 1 hour by default.

The Cluster Autoscaler and custom controllers can watch for specific NodeConditions and trigger node replacement or cordon/drain operations.

## Installation as DaemonSet

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
        # Scrape NPD's Prometheus metrics
        prometheus.io/scrape: "true"
        prometheus.io/port: "20257"
        prometheus.io/path: "/metrics"
    spec:
      # Run on all nodes including masters/control-plane
      tolerations:
      - effect: NoSchedule
        operator: Exists
      - effect: NoExecute
        operator: Exists
      - key: CriticalAddonsOnly
        operator: Exists
      nodeSelector: {}
      serviceAccountName: node-problem-detector
      priorityClassName: system-node-critical
      hostNetwork: false
      # Must run as root to read kernel logs
      securityContext:
        runAsUser: 0
      containers:
      - name: node-problem-detector
        image: registry.k8s.io/node-problem-detector/node-problem-detector:v0.8.19
        command:
        - /node-problem-detector
        - --logtostderr
        - --config.system-log-monitor=/config/kernel-monitor.json
        - --config.system-log-monitor=/config/docker-monitor.json
        - --config.system-log-monitor=/config/containerd-monitor.json
        - --config.custom-plugin-monitor=/config/custom-plugins.json
        - --address=0.0.0.0:20257
        - --prometheus-address=0.0.0.0:20257
        - --k8s-exporter-heartbeat-period=5m
        ports:
        - containerPort: 20257
          name: metrics
          protocol: TCP
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
            memory: 20Mi
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
  verbs: ["patch"]
- apiGroups: [""]
  resources: ["events"]
  verbs: ["create", "patch", "update"]
```

## Built-in Problem Daemons

### Kernel Monitor

The kernel monitor watches `/dev/kmsg` for kernel log messages matching regex patterns.

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
      "pattern": "Kill process \\d+ (.+) score \\d+ or sacrifice child\\nKilled process \\d+ (.+) total-vm:\\d+kB, anon-rss:\\d+kB, file-rss:\\d+kB, shmem-rss:\\d+kB"
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

### Containerd Monitor

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
      "type": "ContainerRuntimeUnhealthy",
      "reason": "ContainerRuntimeIsHealthy",
      "message": "container runtime on the node is functioning properly"
    }
  ],
  "rules": [
    {
      "type": "temporary",
      "reason": "ContainerRuntimeCrash",
      "pattern": "containerd: exit status \\d+"
    },
    {
      "type": "permanent",
      "condition": "ContainerRuntimeUnhealthy",
      "reason": "ContainerRuntimeCrash",
      "pattern": "containerd: died (exited with code [^0])"
    }
  ]
}
```

## Custom Problem Definitions

### Detecting NFS/EFS mount hangs

Hung NFS mounts are a common node problem that doesn't affect node readiness but causes all pods using that PVC to hang.

```json
{
  "plugin": "custom",
  "pluginConfig": {
    "invoke_interval": "30s",
    "timeout": "5s",
    "max_output_length": 80,
    "concurrency": 1
  },
  "source": "nfs-monitor",
  "conditions": [
    {
      "type": "NFSMountHung",
      "reason": "NFSMountIsHealthy",
      "message": "NFS mounts are responding normally"
    }
  ],
  "rules": [
    {
      "type": "permanent",
      "condition": "NFSMountHung",
      "reason": "NFSMountTimeout",
      "path": "/custom-plugins/check-nfs-mounts.sh"
    }
  ]
}
```

The custom plugin script:

```bash
#!/bin/bash
# /custom-plugins/check-nfs-mounts.sh
# Exit 0 if healthy, non-zero if problem detected

set -euo pipefail

TIMEOUT_SECONDS=3

# Find all NFS mounts
NFS_MOUNTS=$(awk '$3 == "nfs" || $3 == "nfs4" {print $2}' /proc/mounts)

if [ -z "$NFS_MOUNTS" ]; then
  # No NFS mounts — healthy
  exit 0
fi

for MOUNT in $NFS_MOUNTS; do
  # Try to stat the mount with a timeout
  if ! timeout "$TIMEOUT_SECONDS" stat "$MOUNT" >/dev/null 2>&1; then
    echo "NFS mount $MOUNT is not responding within ${TIMEOUT_SECONDS}s"
    exit 1
  fi
done

exit 0
```

### Detecting GPU driver failures

```json
{
  "plugin": "custom",
  "pluginConfig": {
    "invoke_interval": "60s",
    "timeout": "10s",
    "max_output_length": 512,
    "concurrency": 1
  },
  "source": "gpu-monitor",
  "conditions": [
    {
      "type": "GPUUnhealthy",
      "reason": "GPUIsHealthy",
      "message": "NVIDIA GPU driver is functioning normally"
    }
  ],
  "rules": [
    {
      "type": "permanent",
      "condition": "GPUUnhealthy",
      "reason": "NvidiaSMIFailed",
      "path": "/custom-plugins/check-gpu.sh"
    }
  ]
}
```

```bash
#!/bin/bash
# /custom-plugins/check-gpu.sh

# Skip if no GPUs present
if ! command -v nvidia-smi &>/dev/null; then
  exit 0
fi

# Check if nvidia-smi can query all GPUs
if ! nvidia-smi --query-gpu=name,memory.used,memory.total \
     --format=csv,noheader >/dev/null 2>&1; then
  echo "nvidia-smi query failed — GPU driver may be crashed"
  exit 1
fi

# Check for ECC errors (memory errors indicate hardware failure)
ECC_ERRORS=$(nvidia-smi --query-gpu=ecc.errors.uncorrected.volatile.total \
  --format=csv,noheader 2>/dev/null | grep -v "N/A" | awk '$1 > 0' | wc -l)

if [ "$ECC_ERRORS" -gt 0 ]; then
  echo "GPU has uncorrected ECC errors — hardware may be failing"
  exit 1
fi

exit 0
```

### Detecting disk pressure from inode exhaustion

```bash
#!/bin/bash
# /custom-plugins/check-inodes.sh

THRESHOLD=90  # Alert when inode usage exceeds 90%

# Check all mounted filesystems
while IFS= read -r line; do
  USAGE=$(echo "$line" | awk '{print $5}' | tr -d '%')
  MOUNT=$(echo "$line" | awk '{print $6}')

  if [ -n "$USAGE" ] && [ "$USAGE" -ge "$THRESHOLD" ]; then
    echo "Inode usage on $MOUNT is ${USAGE}% (threshold: ${THRESHOLD}%)"
    exit 1
  fi
done < <(df -i --output=source,itotal,iused,ifree,ipcent,target 2>/dev/null | tail -n +2 | grep -v tmpfs)

exit 0
```

## ConfigMap with All Problem Daemons

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

  custom-plugins.json: |
    {
      "plugin": "custom",
      "pluginConfig": {
        "invoke_interval": "60s",
        "timeout": "10s",
        "max_output_length": 512,
        "concurrency": 3
      },
      "source": "custom-plugin-monitor",
      "conditions": [
        {
          "type": "NFSMountHung",
          "reason": "NFSMountIsHealthy",
          "message": "NFS mounts are responding normally"
        },
        {
          "type": "DiskIOHung",
          "reason": "DiskIOIsNormal",
          "message": "Disk I/O is functioning normally"
        }
      ],
      "rules": [
        {
          "type": "permanent",
          "condition": "NFSMountHung",
          "reason": "NFSMountTimeout",
          "path": "/custom-plugins/check-nfs-mounts.sh"
        },
        {
          "type": "permanent",
          "condition": "DiskIOHung",
          "reason": "DiskIOHung",
          "path": "/custom-plugins/check-disk-io.sh"
        }
      ]
    }
```

## NodeCondition vs Event Reporting

Understanding when to use each type:

**NodeCondition** (permanent state):
- Set when a problem persists over time
- Cleared only when the underlying issue is resolved
- The Cluster Autoscaler can be configured to remove nodes with specific conditions
- Visible in `kubectl describe node`
- Affects pod scheduling if the condition is registered with the taint manager

**Event** (temporary occurrence):
- Created for transient problems (OOM kills, brief hangs)
- Expires after 1 hour
- Does not affect scheduling
- Useful for triggering alerts

```bash
# View current NodeConditions
kubectl describe node worker-node-1 | grep -A 30 "Conditions:"
# Example output showing NPD-reported conditions:
# Type                       Status  Reason                       Message
# ----                       ------  ------                       -------
# KernelDeadlock             False   KernelHasNoDeadlock          kernel has no deadlock
# ReadonlyFilesystem         False   FilesystemIsNotReadOnly      Filesystem is not read-only
# ContainerRuntimeUnhealthy  False   ContainerRuntimeIsHealthy    ...
# NFSMountHung               False   NFSMountIsHealthy            NFS mounts are responding...

# View NPD-generated events
kubectl get events -n kube-system \
  --field-selector reason=OOMKilling \
  --sort-by='.metadata.creationTimestamp'
```

## Cluster Autoscaler Integration

Configure the Cluster Autoscaler to replace nodes with critical NodeConditions automatically.

```yaml
# Cluster Autoscaler ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: cluster-autoscaler-status
  namespace: kube-system
data:
  nodes-with-conditions.yaml: |
    # Node conditions that cause the Cluster Autoscaler to drain and terminate the node
    nodeConditions:
    - type: KernelDeadlock
    - type: ReadonlyFilesystem
    - type: ContainerRuntimeUnhealthy
    - type: NFSMountHung
    - type: GPUUnhealthy
```

Add the flag to the Cluster Autoscaler deployment:

```yaml
- command:
  - ./cluster-autoscaler
  - --cloud-provider=aws
  - --node-group-auto-discovery=asg:tag=k8s.io/cluster-autoscaler/enabled,k8s.io/cluster-autoscaler/my-cluster
  - --balance-similar-node-groups=true
  - --skip-nodes-with-system-pods=false
  # Treat nodes with these conditions as having failed health checks
  - --status-config-map-name=cluster-autoscaler-status
  - --expendable-pods-priority-cutoff=-10
```

### Custom controller for auto-remediation

For more sophisticated remediation — draining and replacing specific nodes when conditions are set — a controller watches NodeConditions and takes action.

```go
package main

import (
	"context"
	"fmt"
	"log"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/informers"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/cache"
	"k8s.io/client-go/tools/clientcmd"
)

// CriticalConditions are NodeConditions that trigger node remediation.
var CriticalConditions = map[string]bool{
	"KernelDeadlock":           true,
	"ReadonlyFilesystem":       true,
	"ContainerRuntimeUnhealthy": true,
	"GPUUnhealthy":             true,
}

func main() {
	config, err := clientcmd.BuildConfigFromFlags("", "")
	if err != nil {
		log.Fatal(err)
	}
	client, err := kubernetes.NewForConfig(config)
	if err != nil {
		log.Fatal(err)
	}

	factory := informers.NewSharedInformerFactory(client, 5*time.Minute)
	nodeInformer := factory.Core().V1().Nodes().Informer()

	nodeInformer.AddEventHandler(cache.ResourceEventHandlerFuncs{
		UpdateFunc: func(old, new interface{}) {
			oldNode := old.(*corev1.Node)
			newNode := new.(*corev1.Node)
			handleNodeUpdate(client, oldNode, newNode)
		},
	})

	stopCh := make(chan struct{})
	factory.Start(stopCh)
	factory.WaitForCacheSync(stopCh)

	log.Println("Node remediation controller started")
	<-stopCh
}

func handleNodeUpdate(client kubernetes.Interface, old, new *corev1.Node) {
	for _, condition := range new.Status.Conditions {
		if !CriticalConditions[string(condition.Type)] {
			continue
		}
		if condition.Status != corev1.ConditionTrue {
			continue
		}

		// Check if we recently already acted on this condition
		if alreadyAnnotated(new, condition.Type) {
			continue
		}

		log.Printf("CRITICAL: Node %s has condition %s: %s",
			new.Name, condition.Type, condition.Message)

		// Cordon the node to prevent new pods from scheduling
		if err := cordonNode(client, new.Name); err != nil {
			log.Printf("failed to cordon %s: %v", new.Name, err)
			continue
		}

		// Annotate to prevent duplicate actions
		annotateNode(client, new.Name, string(condition.Type))

		// In a full implementation, you would:
		// 1. Drain the node (evict pods respecting PDBs)
		// 2. Delete the node from Kubernetes
		// 3. Terminate the underlying EC2 instance
		// 4. Allow the autoscaler to provision a replacement
		log.Printf("Node %s cordoned due to condition %s", new.Name, condition.Type)
	}
}

func cordonNode(client kubernetes.Interface, nodeName string) error {
	node, err := client.CoreV1().Nodes().Get(context.Background(), nodeName, metav1.GetOptions{})
	if err != nil {
		return err
	}
	node.Spec.Unschedulable = true
	_, err = client.CoreV1().Nodes().Update(context.Background(), node, metav1.UpdateOptions{})
	return err
}

func alreadyAnnotated(node *corev1.Node, conditionType corev1.NodeConditionType) bool {
	key := fmt.Sprintf("remediation.node/%s", conditionType)
	_, exists := node.Annotations[key]
	return exists
}

func annotateNode(client kubernetes.Interface, nodeName string, condition string) {
	node, err := client.CoreV1().Nodes().Get(context.Background(), nodeName, metav1.GetOptions{})
	if err != nil {
		return
	}
	if node.Annotations == nil {
		node.Annotations = make(map[string]string)
	}
	key := fmt.Sprintf("remediation.node/%s", condition)
	node.Annotations[key] = time.Now().UTC().Format(time.RFC3339)
	client.CoreV1().Nodes().Update(context.Background(), node, metav1.UpdateOptions{})
}
```

## Prometheus Metrics from NPD

NPD exposes metrics on port 20257 in the Prometheus format.

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: node-problem-detector
  namespace: kube-system
  labels:
    release: prometheus
spec:
  selector:
    matchLabels:
      app: node-problem-detector
  endpoints:
  - port: metrics
    interval: 30s
    path: /metrics
```

Key NPD metrics:

```
# Number of nodes with each condition
problem_gauge{type="KernelDeadlock",node="worker-1"} 0
problem_gauge{type="ReadonlyFilesystem",node="worker-1"} 0

# Number of temporary problems (events) detected
problem_counter{type="OOMKilling",node="worker-1"} 3

# Whether NPD itself is healthy
node_problem_detector_start_time_seconds
```

### Alert rules for NPD conditions

```yaml
groups:
- name: node-problem-detector
  rules:
  - alert: NodeKernelDeadlock
    expr: problem_gauge{type="KernelDeadlock"} == 1
    for: 1m
    labels:
      severity: critical
    annotations:
      summary: "Node {{ $labels.node }} has a kernel deadlock"
      description: "Immediate action required — drain and replace the node."
      runbook_url: "https://runbooks.example.com/kubernetes/node-kernel-deadlock"

  - alert: NodeReadonlyFilesystem
    expr: problem_gauge{type="ReadonlyFilesystem"} == 1
    for: 1m
    labels:
      severity: critical
    annotations:
      summary: "Node {{ $labels.node }} filesystem has gone read-only"
      description: "The node's filesystem is read-only, likely due to I/O errors."

  - alert: NodeContainerRuntimeUnhealthy
    expr: problem_gauge{type="ContainerRuntimeUnhealthy"} == 1
    for: 5m
    labels:
      severity: critical
    annotations:
      summary: "Container runtime unhealthy on node {{ $labels.node }}"

  - alert: NodeFrequentOOMKills
    expr: |
      increase(problem_counter{type="OOMKilling"}[30m]) > 5
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "Node {{ $labels.node }} has had {{ $value }} OOM kills in 30 minutes"
      description: "Workloads on this node are running out of memory. Review resource limits."

  - alert: NodeGPUUnhealthy
    expr: problem_gauge{type="GPUUnhealthy"} == 1
    for: 5m
    labels:
      severity: critical
    annotations:
      summary: "GPU failure detected on node {{ $labels.node }}"
```

## Correlating Node Conditions with Application Issues

When users report application errors, check node conditions first:

```bash
# Step 1: Find the nodes where affected pods are running
kubectl get pods -n production -o wide | grep -v Running

# Step 2: Check NodeConditions on those nodes
NODE="worker-node-5"
kubectl describe node $NODE | grep -A 40 "Conditions:"

# Step 3: Check for recent NPD events
kubectl get events --all-namespaces \
  --field-selector involvedObject.name=$NODE \
  --sort-by='.metadata.creationTimestamp' | tail -20

# Step 4: Check NPD logs for the specific node
kubectl logs -n kube-system \
  -l app=node-problem-detector \
  --field-selector spec.nodeName=$NODE \
  --since=1h | grep -v "^I" | grep -E "(error|warn|problem)"

# Step 5: Cross-reference with application pod events
kubectl get events -n production \
  --field-selector involvedObject.kind=Pod \
  --sort-by='.metadata.creationTimestamp' | tail -30

# Step 6: Check if recent OOM kills on the node explain pod failures
kubectl get events --all-namespaces \
  --field-selector reason=OOMKilling \
  --sort-by='.metadata.creationTimestamp' | grep $NODE
```

### NPD + Grafana correlation dashboard

```
# PromQL query to correlate OOM kills with pod restarts
sum by (node) (
  increase(problem_counter{type="OOMKilling"}[1h])
)

# Join with pod restart rate on the same nodes
sum by (node) (
  increase(kube_pod_container_status_restarts_total[1h])
) * on(node) group_left() (
  sum by (node) (problem_counter{type="OOMKilling"}) > 0
)
```

## Helm-based Installation

```bash
helm repo add deliveryhero https://charts.deliveryhero.io/
helm repo update

helm upgrade --install node-problem-detector \
  deliveryhero/node-problem-detector \
  --namespace kube-system \
  --set settings.log_monitors[0]=/config/kernel-monitor.json \
  --set settings.custom_plugin_monitors[0]=/config/custom-plugins.json \
  --set extraVolumes[0].name=custom-plugins \
  --set extraVolumes[0].configMap.name=node-problem-detector-custom-plugins \
  --set extraVolumeMounts[0].name=custom-plugins \
  --set extraVolumeMounts[0].mountPath=/custom-plugins \
  --set metrics.enabled=true \
  --set serviceMonitor.enabled=true \
  --set serviceMonitor.namespace=monitoring
```

## Summary

Node Problem Detector is a critical component for production Kubernetes clusters operating at scale:

- Deploy as a DaemonSet with `system-node-critical` priority so it runs even when nodes are under pressure.
- Enable at minimum the kernel monitor and containerd/docker monitor for basic problem detection.
- Write custom plugins for environment-specific issues: NFS mounts, GPU health, inode exhaustion.
- Configure the Cluster Autoscaler to recognize NPD conditions so unhealthy nodes are automatically replaced.
- Alert on persistent NodeConditions (`problem_gauge == 1`) immediately, and on high rates of temporary problems (OOM kills) as a warning.
- Use NPD events as the first correlation point when investigating application failures — OOM kills, kernel hangs, and filesystem errors on the node often explain seemingly random pod crashes.
