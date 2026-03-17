---
title: "Kubernetes Controller Manager and Scheduler: Configuration and Custom Scheduling"
date: 2027-08-23T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Scheduler", "Controller Manager"]
categories:
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into kube-controller-manager and kube-scheduler configuration, custom scheduling plugins, scheduler extenders, scheduling policy tuning, leader election configuration, and writing a custom scheduler plugin in Go."
more_link: "yes"
url: "/kubernetes-controller-manager-scheduler-guide/"
---

The kube-controller-manager and kube-scheduler are the automation engines that transform declarative intent into running infrastructure. The controller manager reconciles desired state for dozens of resource types; the scheduler makes placement decisions that directly affect workload performance, availability, and cost. Both components are tunable, extensible, and frequently underoptimized in production clusters.

<!--more-->

## kube-controller-manager Deep Dive

### Controller Inventory

The controller manager runs dozens of control loops in a single binary:

```bash
# View all controllers managed by kube-controller-manager
kubectl get pod kube-controller-manager-<node> -n kube-system -o yaml | \
  grep "controllers\|enable\|disable"

# Key controllers and their functions:
# node              — Node lifecycle management, taint NoExecute after failures
# deployment        — Manages ReplicaSets for Deployments
# replicaset        — Ensures desired replica count
# statefulset       — Ordered StatefulSet pod management
# job               — Batch Job completion tracking
# endpoint          — Populates Endpoints objects from pod readiness
# serviceaccount    — Creates default ServiceAccounts in new namespaces
# persistentvolume  — PV/PVC binding and reclaim
# garbage-collector — Cascading deletion via owner references
# horizontal-pod-autoscaler — HPA reconciliation
# namespace         — Namespace lifecycle finalization
# cronjob           — CronJob schedule enforcement
```

### Performance-Critical Configuration Flags

```yaml
# kube-controller-manager.yaml (kubeadm static pod)
spec:
  containers:
    - command:
        - kube-controller-manager
        # Worker thread counts — increase for large clusters
        - --concurrent-deployment-syncs=10       # Default 5
        - --concurrent-replicaset-syncs=10       # Default 5
        - --concurrent-statefulset-syncs=5       # Default 5
        - --concurrent-endpoint-syncs=10         # Default 5
        - --concurrent-service-syncs=2           # Default 1
        - --concurrent-gc-syncs=40               # Default 20

        # Node management
        - --node-monitor-period=5s               # How often node status is checked
        - --node-monitor-grace-period=40s        # Before marking node Unknown
        - --pod-eviction-timeout=5m              # Before evicting pods from Unknown node

        # Rate limiting to etcd
        - --kube-api-qps=100                     # Default 20
        - --kube-api-burst=150                   # Default 30

        # Leader election
        - --leader-elect=true
        - --leader-elect-lease-duration=15s
        - --leader-elect-renew-deadline=10s
        - --leader-elect-retry-period=2s
```

### Leader Election Mechanics

For HA control planes, all controller manager instances compete for a leader lease. Only the leader runs controllers; standby instances wait:

```bash
# Check which instance holds the controller manager lease
kubectl get lease kube-controller-manager -n kube-system -o yaml

# Monitor lease renewals
kubectl get lease kube-controller-manager -n kube-system -w
```

The lease timeout hierarchy:
- `lease-duration`: How long the lease is valid (default 15s)
- `renew-deadline`: How long the leader must renew before losing the lease (default 10s)
- `retry-period`: How often standby instances retry (default 2s)

For production, the defaults are acceptable. Reducing `leader-elect-lease-duration` speeds failover but increases sensitivity to temporary API server unavailability.

### Controller Rate Limiting

```yaml
# Tune rate limiting for large clusters (many resources)
- --kube-api-qps=100
- --kube-api-burst=150

# For very large clusters (5000+ nodes):
- --kube-api-qps=200
- --kube-api-burst=300
- --concurrent-deployment-syncs=20
- --concurrent-replicaset-syncs=20
```

Monitor controller manager queue depth:

```bash
kubectl get --raw /metrics | grep workqueue | grep -E "depth|latency"
# workqueue_depth{name="deployment"} 0
# workqueue_queue_duration_seconds_bucket — time items wait in queue
```

## kube-scheduler Architecture

### Scheduling Framework

The Kubernetes scheduler uses a plugin-based framework with defined extension points:

```
Pod enters scheduling queue
    ↓
Sort (PreEnqueue → QueueSort)
    ↓
Filter Phase
  ├── PreFilter      — Compute shared state
  ├── Filter         — Eliminate infeasible nodes
  └── PostFilter     — Handle all-nodes-failed (preemption)
    ↓
Score Phase
  ├── PreScore       — Prepare scoring state
  ├── Score          — Rate each feasible node
  └── NormalizeScore — Normalize scores to 0–100
    ↓
Select highest-scoring node
    ↓
Reserve         — Mark resources as reserved
    ↓
Permit          — Batch or gate scheduling
    ↓
PreBind         — Pre-binding operations
    ↓
Bind            — Write binding to API server
    ↓
PostBind        — Cleanup
```

### Built-in Plugin Configuration

```yaml
# scheduler-config.yaml
apiVersion: kubescheduler.config.k8s.io/v1
kind: KubeSchedulerConfiguration
profiles:
  - schedulerName: default-scheduler
    plugins:
      score:
        enabled:
          - name: NodeAffinity
            weight: 2
          - name: PodTopologySpread
            weight: 5
          - name: InterPodAffinity
            weight: 2
          - name: NodeResourcesBalancedAllocation
            weight: 1
          - name: NodeResourcesFit
            weight: 1
        disabled:
          - name: NodeResourcesLeastAllocated  # Replace with custom if needed
      filter:
        enabled:
          - name: NodeUnschedulable
          - name: NodeName
          - name: TaintToleration
          - name: NodeAffinity
          - name: NodePorts
          - name: NodeResourcesFit
          - name: VolumeRestrictions
          - name: VolumeBinding
          - name: PodTopologySpread
    pluginConfig:
      - name: PodTopologySpread
        args:
          defaultConstraints:
            - maxSkew: 1
              topologyKey: topology.kubernetes.io/zone
              whenUnsatisfiable: ScheduleAnyway
          defaultingType: System
      - name: NodeResourcesFit
        args:
          scoringStrategy:
            type: MostAllocated   # Pack nodes tightly (cost optimization)
            # Use LeastAllocated to spread across nodes (performance)
```

Enable the custom scheduler config:

```yaml
# kube-scheduler.yaml (kubeadm static pod)
spec:
  containers:
    - command:
        - kube-scheduler
        - --config=/etc/kubernetes/scheduler-config.yaml
        - --leader-elect=true
        - --v=2
      volumeMounts:
        - name: scheduler-config
          mountPath: /etc/kubernetes/scheduler-config.yaml
          readOnly: true
  volumes:
    - name: scheduler-config
      hostPath:
        path: /etc/kubernetes/scheduler-config.yaml
        type: File
```

### Multiple Scheduler Profiles

Different workload types can use different scheduling strategies:

```yaml
# multi-profile-scheduler-config.yaml
apiVersion: kubescheduler.config.k8s.io/v1
kind: KubeSchedulerConfiguration
profiles:
  # Default: balanced scheduling
  - schedulerName: default-scheduler
    plugins:
      score:
        enabled:
          - name: NodeResourcesBalancedAllocation
            weight: 3

  # High-performance: pack nodes (GPU workloads, spot cost optimization)
  - schedulerName: high-density-scheduler
    plugins:
      score:
        enabled:
          - name: NodeResourcesFit
            weight: 10
    pluginConfig:
      - name: NodeResourcesFit
        args:
          scoringStrategy:
            type: MostAllocated

  # Spread scheduler: maximize availability across zones
  - schedulerName: spread-scheduler
    plugins:
      score:
        enabled:
          - name: PodTopologySpread
            weight: 10
    pluginConfig:
      - name: PodTopologySpread
        args:
          defaultConstraints:
            - maxSkew: 1
              topologyKey: topology.kubernetes.io/zone
              whenUnsatisfiable: DoNotSchedule
```

Reference a named scheduler in a Pod:

```yaml
spec:
  schedulerName: high-density-scheduler
```

## Writing a Custom Scheduler Plugin in Go

### Plugin Interface

```go
// pkg/scheduler/plugin/resource_aware.go
package resourceaware

import (
	"context"
	"fmt"
	"math"

	v1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/kubernetes/pkg/scheduler/framework"
)

const Name = "ResourceAwareScorer"

// ResourceAwareScorer scores nodes based on custom resource availability
type ResourceAwareScorer struct {
	handle framework.Handle
}

// Ensure interface compliance at compile time
var _ framework.ScorePlugin = &ResourceAwareScorer{}
var _ framework.ScoreExtensions = &ResourceAwareScorer{}

func New(_ runtime.Object, h framework.Handle) (framework.Plugin, error) {
	return &ResourceAwareScorer{handle: h}, nil
}

func (r *ResourceAwareScorer) Name() string {
	return Name
}

// Score assigns a score to each node (0–100)
func (r *ResourceAwareScorer) Score(ctx context.Context, state *framework.CycleState, pod *v1.Pod, nodeName string) (int64, *framework.Status) {
	nodeInfo, err := r.handle.SnapshotSharedLister().NodeInfos().Get(nodeName)
	if err != nil {
		return 0, framework.AsStatus(fmt.Errorf("getting node %q from snapshot: %w", nodeName, err))
	}

	node := nodeInfo.Node()
	if node == nil {
		return 0, framework.AsStatus(fmt.Errorf("node %q not found", nodeName))
	}

	// Score based on GPU availability (custom resource)
	allocatableGPU := node.Status.Allocatable.Name("nvidia.com/gpu", "")
	requestedGPU := nodeInfo.Requested.ScalarResources["nvidia.com/gpu"]

	allocatable := float64(allocatableGPU.Value())
	if allocatable == 0 {
		return 0, nil  // No GPU — lowest score
	}

	available := allocatable - float64(requestedGPU)
	score := int64(math.Round((available / allocatable) * 100))

	return score, nil
}

func (r *ResourceAwareScorer) ScoreExtensions() framework.ScoreExtensions {
	return r
}

// NormalizeScore normalizes scores across all nodes
func (r *ResourceAwareScorer) NormalizeScore(ctx context.Context, state *framework.CycleState, pod *v1.Pod, scores framework.NodeScoreList) *framework.Status {
	var maxScore int64
	for _, score := range scores {
		if score.Score > maxScore {
			maxScore = score.Score
		}
	}

	if maxScore == 0 {
		return nil
	}

	for i := range scores {
		scores[i].Score = scores[i].Score * framework.MaxNodeScore / maxScore
	}

	return nil
}
```

### Custom Scheduler Main Function

```go
// cmd/scheduler/main.go
package main

import (
	"os"

	"k8s.io/component-base/cli"
	"k8s.io/kubernetes/pkg/scheduler/app"

	resourceaware "github.com/example/custom-scheduler/pkg/scheduler/plugin"
)

func main() {
	command := app.NewSchedulerCommand(
		app.WithPlugin(resourceaware.Name, resourceaware.New),
	)

	code := cli.Run(command)
	os.Exit(code)
}
```

### Building and Deploying the Custom Scheduler

```dockerfile
# Dockerfile
FROM golang:1.22 AS builder
WORKDIR /workspace
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -a -o custom-scheduler ./cmd/scheduler/

FROM gcr.io/distroless/static:nonroot
COPY --from=builder /workspace/custom-scheduler /usr/local/bin/
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/custom-scheduler"]
```

```yaml
# custom-scheduler-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: custom-scheduler
  namespace: kube-system
spec:
  replicas: 2        # HA — leader election handles active/standby
  selector:
    matchLabels:
      component: custom-scheduler
  template:
    metadata:
      labels:
        component: custom-scheduler
    spec:
      serviceAccountName: custom-scheduler
      priorityClassName: system-cluster-critical
      tolerations:
        - key: "node-role.kubernetes.io/control-plane"
          effect: NoSchedule
      containers:
        - name: custom-scheduler
          image: registry.example.com/custom-scheduler:v1.0.0
          command:
            - /usr/local/bin/custom-scheduler
            - --config=/etc/kubernetes/custom-scheduler-config.yaml
            - --leader-elect=true
            - --leader-elect-resource-name=custom-scheduler
            - --leader-elect-resource-namespace=kube-system
          volumeMounts:
            - name: config
              mountPath: /etc/kubernetes/custom-scheduler-config.yaml
              readOnly: true
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi
          livenessProbe:
            httpGet:
              path: /healthz
              port: 10259
              scheme: HTTPS
            initialDelaySeconds: 15
      volumes:
        - name: config
          configMap:
            name: custom-scheduler-config
```

## Scheduler Extenders

Scheduler extenders are HTTP webhooks that the scheduler calls during filter and score phases. Unlike plugins, extenders run out-of-process, useful for integrating external scheduling constraints:

```yaml
# scheduler-with-extender.yaml
apiVersion: kubescheduler.config.k8s.io/v1
kind: KubeSchedulerConfiguration
profiles:
  - schedulerName: default-scheduler
    plugins:
      filter:
        enabled:
          - name: NodeAffinity
extenders:
  - urlPrefix: "https://scheduler-extender.scheduling.svc.cluster.local"
    filterVerb: "filter"
    prioritizeVerb: "prioritize"
    bindVerb: ""
    weight: 5
    enableHTTPS: true
    tlsConfig:
      insecure: false
      caFile: "/etc/ssl/scheduler-extender-ca.crt"
    httpTimeout: 10s
    nodeCacheCapable: true
    managedResources:
      - name: "custom.io/network-bandwidth"
        ignoredByScheduler: false
    ignorable: false     # false = filter failures block scheduling
```

The extender HTTP API expects and returns the standard `ExtenderArgs` / `ExtenderFilterResult` structs from `k8s.io/kube-scheduler/extender/v1`.

## Monitoring Scheduler Performance

```yaml
# scheduler-prometheus-alerts.yaml
groups:
  - name: scheduler
    rules:
      - alert: SchedulerUnschedulablePods
        expr: scheduler_unschedulable_pods > 10
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "{{ $value }} pods unschedulable — check resource capacity or affinity rules"

      - alert: SchedulerHighLatency
        expr: |
          histogram_quantile(0.99,
            sum(rate(scheduler_scheduling_algorithm_duration_seconds_bucket[5m]))
            by (le)
          ) > 1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Scheduler p99 algorithm latency {{ $value }}s"

      - alert: ControllerManagerWorkQueueDepth
        expr: workqueue_depth{name="deployment"} > 100
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Deployment controller queue depth {{ $value }} — may indicate controller overload"
```

Custom scheduler plugins provide precise control over placement decisions without the overhead of out-of-process extenders, while the multi-profile configuration allows different workload types to use independently-tuned scheduling strategies. The controller manager's concurrent sync workers have a direct impact on how quickly the cluster responds to changes — sizing them appropriately for cluster scale prevents reconciliation backlogs during rolling deployments or node failures.
