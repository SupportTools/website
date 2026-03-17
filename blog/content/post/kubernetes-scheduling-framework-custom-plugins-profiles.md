---
title: "Kubernetes Scheduling Framework: Custom Plugins and Profiles"
date: 2029-09-15T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Scheduler", "Custom Plugins", "Scheduling Framework", "Profiles"]
categories: ["Kubernetes", "Development"]
author: "Matthew Mattox - mmattox@support.tools"
description: "In-depth guide to the Kubernetes scheduling framework: Filter, Score, Bind, and other extension points, implementing custom scheduling plugins, configuring scheduling profiles, and deploying multi-scheduler architectures."
more_link: "yes"
url: "/kubernetes-scheduling-framework-custom-plugins-profiles/"
---

The Kubernetes scheduler is a pluggable system since the scheduling framework landed in 1.19 as stable. Every default scheduling behavior — resource fitting, inter-pod affinity, taint toleration, pod topology spread — is implemented as a plugin. You can add your own plugins to the same binary, configure which plugins run and in what order, and create multiple scheduling profiles that different pods can opt into. This post walks through each extension point, shows how to implement a custom plugin, and explains scheduling profiles and multi-scheduler deployments.

<!--more-->

# Kubernetes Scheduling Framework: Custom Plugins and Profiles

## The Scheduling Framework Architecture

The scheduler processes each unbound pod through a series of phases. Plugins register at one or more extension points within these phases.

### Scheduling Cycle (Per Pod)

```
PreFilter   → Filter     → PostFilter  →  PreScore  →  Score  →  NormalizeScore
                                                                         |
                                                                   Reserve → Permit

Phase 1: Filtering
  PreFilter:   Initialize state for filter plugins; can reject pods early
  Filter:      Each plugin votes whether each node passes; node must pass ALL filters
  PostFilter:  Called when no nodes pass Filter (preemption logic lives here)

Phase 2: Scoring
  PreScore:    Initialize state for score plugins
  Score:       Each plugin scores each remaining node (0-100)
  NormalizeScore: Optional normalization of scores to [0, 100] range
```

### Binding Cycle (Per Selected Node)

```
Reserve → Permit → PreBind → Bind → PostBind

Reserve:  Claim resources in plugin state (e.g., IP allocation)
Permit:   Approve, deny, or wait on the binding
PreBind:  Pre-binding actions (e.g., provisioning volumes)
Bind:     Actually bind the pod to the node (default: update Pod.Spec.NodeName)
PostBind: Post-binding cleanup/bookkeeping
```

### Extension Points Summary

| Extension Point | Called | Can reject? | Can score? |
|---|---|---|---|
| QueueSort | Pod enters queue | N/A (ordering) | No |
| PreEnqueue | Pod enters queue | Yes | No |
| PreFilter | Per scheduling cycle | Yes | No |
| Filter | Per node, per cycle | Yes | No |
| PostFilter | After Filter failure | Yes | No |
| PreScore | Per scoring cycle | No | No |
| Score | Per node, scoring | No | Yes (0-100) |
| NormalizeScore | Per plugin | No | Yes (normalization) |
| Reserve | Before binding | Yes | No |
| Permit | Before binding | Yes | No |
| PreBind | Before Bind | Yes | No |
| Bind | Binding | Yes | No |
| PostBind | After Bind | No | No |

## Implementing a Custom Filter Plugin

A Filter plugin decides whether a node is eligible to run a pod. The classic use case: pods with a specific label should only schedule on nodes in a certain network zone.

```go
// plugin/zone_filter/zone_filter.go
package zone_filter

import (
    "context"
    "fmt"

    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/runtime"
    "k8s.io/kubernetes/pkg/scheduler/framework"
)

const (
    PluginName         = "ZoneFilter"
    ZoneLabelKey       = "example.com/required-zone"
    NodeZoneLabelKey   = "topology.kubernetes.io/zone"
)

// ZoneFilterPlugin enforces that pods with a zone requirement
// are only scheduled to nodes in that zone
type ZoneFilterPlugin struct{}

// Verify interface compliance at compile time
var _ framework.FilterPlugin = &ZoneFilterPlugin{}

func New(obj runtime.Object, h framework.Handle) (framework.Plugin, error) {
    return &ZoneFilterPlugin{}, nil
}

func (p *ZoneFilterPlugin) Name() string {
    return PluginName
}

// Filter is called for every node during the filtering phase
func (p *ZoneFilterPlugin) Filter(
    ctx context.Context,
    cycleState *framework.CycleState,
    pod *corev1.Pod,
    nodeInfo *framework.NodeInfo,
) *framework.Status {
    requiredZone, ok := pod.Labels[ZoneLabelKey]
    if !ok {
        // Pod has no zone requirement; this node passes
        return nil
    }

    node := nodeInfo.Node()
    if node == nil {
        return framework.NewStatus(framework.Error, "node not found")
    }

    nodeZone, ok := node.Labels[NodeZoneLabelKey]
    if !ok {
        return framework.NewStatus(framework.Unschedulable,
            fmt.Sprintf("node %s has no zone label %s", node.Name, NodeZoneLabelKey))
    }

    if nodeZone != requiredZone {
        return framework.NewStatus(framework.Unschedulable,
            fmt.Sprintf("node zone %s != required zone %s", nodeZone, requiredZone))
    }

    return nil  // nil status means success (node passes)
}
```

### Using CycleState for Cross-Extension-Point Communication

To avoid recomputing data in multiple extension points, store it in CycleState during PreFilter:

```go
// plugin/cache_aware/cache_aware.go
package cache_aware

import (
    "context"
    "fmt"

    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/runtime"
    "k8s.io/kubernetes/pkg/scheduler/framework"
)

const PluginName = "CacheAware"

// stateKey is used to store/retrieve state from CycleState
type stateKey struct{}

type computedState struct {
    requiredCacheSize int64
    cacheType         string
}

func (cs *computedState) Clone() framework.StateData {
    copy := *cs
    return &copy
}

type CacheAwarePlugin struct {
    handle framework.Handle
}

var (
    _ framework.PreFilterPlugin = &CacheAwarePlugin{}
    _ framework.FilterPlugin    = &CacheAwarePlugin{}
    _ framework.ScorePlugin     = &CacheAwarePlugin{}
)

func New(obj runtime.Object, h framework.Handle) (framework.Plugin, error) {
    return &CacheAwarePlugin{handle: h}, nil
}

func (p *CacheAwarePlugin) Name() string {
    return PluginName
}

// PreFilter computes pod requirements once and stores in CycleState
func (p *CacheAwarePlugin) PreFilter(
    ctx context.Context,
    state *framework.CycleState,
    pod *corev1.Pod,
) (*framework.PreFilterResult, *framework.Status) {
    cacheSize := int64(0)
    cacheType := ""

    if val, ok := pod.Annotations["example.com/cache-size-mb"]; ok {
        fmt.Sscanf(val, "%d", &cacheSize)
    }
    if val, ok := pod.Annotations["example.com/cache-type"]; ok {
        cacheType = val
    }

    // Store in cycle state for Filter and Score to use
    state.Write(stateKey{}, &computedState{
        requiredCacheSize: cacheSize,
        cacheType:         cacheType,
    })

    return nil, nil
}

func (p *CacheAwarePlugin) PreFilterExtensions() framework.PreFilterExtensions {
    return nil
}

// Filter uses data from PreFilter via CycleState
func (p *CacheAwarePlugin) Filter(
    ctx context.Context,
    state *framework.CycleState,
    pod *corev1.Pod,
    nodeInfo *framework.NodeInfo,
) *framework.Status {
    // Retrieve pre-computed state
    data, err := state.Read(stateKey{})
    if err != nil {
        return nil // No requirements stored; pass
    }
    cs := data.(*computedState)

    if cs.requiredCacheSize == 0 {
        return nil
    }

    node := nodeInfo.Node()
    if node == nil {
        return framework.NewStatus(framework.Error, "node not found")
    }

    // Check if node has sufficient cache capacity (from node annotations/labels)
    nodeCacheMB := int64(0)
    if val, ok := node.Labels["example.com/cache-mb"]; ok {
        fmt.Sscanf(val, "%d", &nodeCacheMB)
    }

    if nodeCacheMB < cs.requiredCacheSize {
        return framework.NewStatus(framework.Unschedulable,
            fmt.Sprintf("node has %dMB cache, pod requires %dMB",
                nodeCacheMB, cs.requiredCacheSize))
    }

    return nil
}

// Score prefers nodes with more cache headroom
func (p *CacheAwarePlugin) Score(
    ctx context.Context,
    state *framework.CycleState,
    pod *corev1.Pod,
    nodeName string,
) (int64, *framework.Status) {
    data, err := state.Read(stateKey{})
    if err != nil || data == nil {
        return 0, nil
    }
    cs := data.(*computedState)

    nodeInfo, err := p.handle.SnapshotSharedLister().NodeInfos().Get(nodeName)
    if err != nil {
        return 0, framework.AsStatus(err)
    }

    node := nodeInfo.Node()
    nodeCacheMB := int64(0)
    if val, ok := node.Labels["example.com/cache-mb"]; ok {
        fmt.Sscanf(val, "%d", &nodeCacheMB)
    }

    // Score: more cache headroom = higher score
    headroom := nodeCacheMB - cs.requiredCacheSize
    if headroom < 0 {
        return 0, nil
    }
    // Normalize to [0, 100] (assuming max cache is 512GB)
    score := headroom * 100 / (512 * 1024)
    if score > 100 {
        score = 100
    }

    return score, nil
}

func (p *CacheAwarePlugin) ScoreExtensions() framework.ScoreExtensions {
    return nil
}
```

## Implementing a Permit Plugin

The Permit extension point can delay binding until conditions are met — useful for gang scheduling (bind all pods in a group together or none):

```go
// plugin/gang_scheduler/gang_scheduler.go
package gang_scheduler

import (
    "context"
    "fmt"
    "sync"
    "time"

    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/runtime"
    "k8s.io/kubernetes/pkg/scheduler/framework"
)

const (
    PluginName    = "GangScheduler"
    GangLabelKey  = "example.com/gang-name"
    GangSizeKey   = "example.com/gang-size"
)

type GangSchedulerPlugin struct {
    mu     sync.RWMutex
    gangs  map[string]*gang
    handle framework.Handle
}

type gang struct {
    name     string
    size     int
    approved []string // pod names
    waiting  []framework.WaitingPod
}

var _ framework.PermitPlugin = &GangSchedulerPlugin{}

func New(obj runtime.Object, h framework.Handle) (framework.Plugin, error) {
    return &GangSchedulerPlugin{
        gangs:  make(map[string]*gang),
        handle: h,
    }, nil
}

func (p *GangSchedulerPlugin) Name() string {
    return PluginName
}

func (p *GangSchedulerPlugin) Permit(
    ctx context.Context,
    state *framework.CycleState,
    pod *corev1.Pod,
    nodeName string,
) (*framework.Status, time.Duration) {
    gangName, ok := pod.Labels[GangLabelKey]
    if !ok {
        return nil, 0  // Not a gang pod; allow immediately
    }

    gangSize := 0
    if sizeStr, ok := pod.Labels[GangSizeKey]; ok {
        fmt.Sscanf(sizeStr, "%d", &gangSize)
    }
    if gangSize <= 0 {
        return nil, 0  // Invalid gang config; allow immediately
    }

    p.mu.Lock()
    defer p.mu.Unlock()

    g, exists := p.gangs[gangName]
    if !exists {
        g = &gang{name: gangName, size: gangSize}
        p.gangs[gangName] = g
    }

    g.approved = append(g.approved, pod.Name)

    if len(g.approved) >= g.size {
        // All gang members scheduled; approve all waiting pods
        for _, wp := range g.waiting {
            wp.Allow(PluginName)
        }
        g.waiting = nil
        delete(p.gangs, gangName)
        return nil, 0  // Approve this pod immediately
    }

    // Not all gang members scheduled yet; wait
    // Return Wait status with 30 second timeout
    return framework.NewStatus(framework.Wait, "waiting for gang"), 30 * time.Second
}

// Called when a waiting pod is added to the waiting queue
// We need to track it so we can approve it later
func (p *GangSchedulerPlugin) WaitOnPermit(
    ctx context.Context,
    pod *corev1.Pod,
) *framework.Status {
    // The waiting pod can be retrieved from the handle
    // and stored for later approval
    gangName := pod.Labels[GangLabelKey]

    p.mu.Lock()
    g, exists := p.gangs[gangName]
    if !exists {
        p.mu.Unlock()
        return nil
    }
    // Get the waiting pod interface
    wp := p.handle.GetWaitingPod(pod.UID)
    if wp != nil {
        g.waiting = append(g.waiting, wp)
    }
    p.mu.Unlock()

    return nil
}
```

## Building the Custom Scheduler Binary

Custom plugins must be compiled into the scheduler binary. The recommended approach is using the `scheduler-plugins` pattern:

```go
// cmd/scheduler/main.go
package main

import (
    "os"

    "k8s.io/kubernetes/cmd/kube-scheduler/app"
    "k8s.io/kubernetes/pkg/scheduler/framework/runtime"

    zone_filter "github.com/myorg/my-scheduler/plugin/zone_filter"
    cache_aware "github.com/myorg/my-scheduler/plugin/cache_aware"
    gang_scheduler "github.com/myorg/my-scheduler/plugin/gang_scheduler"
)

func main() {
    // Create scheduler command with custom plugins registered
    command := app.NewSchedulerCommand(
        app.WithPlugin(zone_filter.PluginName, zone_filter.New),
        app.WithPlugin(cache_aware.PluginName, cache_aware.New),
        app.WithPlugin(gang_scheduler.PluginName, gang_scheduler.New),
    )

    if err := command.Execute(); err != nil {
        os.Exit(1)
    }
}
```

```dockerfile
# Dockerfile for custom scheduler
FROM golang:1.22 AS builder

WORKDIR /build
COPY . .
RUN CGO_ENABLED=0 go build -o scheduler ./cmd/scheduler/

FROM gcr.io/distroless/static
COPY --from=builder /build/scheduler /scheduler
ENTRYPOINT ["/scheduler"]
```

## Scheduling Profiles

Scheduling profiles allow a single scheduler binary to run multiple configurations simultaneously. Each profile has a name, and pods select their profile via the `schedulerName` field.

### KubeSchedulerProfile Configuration

```yaml
# scheduler-config.yaml
apiVersion: kubescheduler.config.k8s.io/v1
kind: KubeSchedulerConfiguration
profiles:
  # Default profile (replaces kube-scheduler behavior)
  - schedulerName: default-scheduler
    plugins:
      preFilter:
        enabled:
          - name: NodeResourcesFit
          - name: NodePorts
          - name: PodTopologySpread
          - name: InterPodAffinity
          - name: VolumeBinding
          - name: NodeAffinity
      filter:
        enabled:
          - name: NodeUnschedulable
          - name: NodeName
          - name: TaintToleration
          - name: NodeAffinity
          - name: NodePorts
          - name: NodeResourcesFit
          - name: VolumeRestrictions
          - name: EBSLimits
          - name: GCEPDLimits
          - name: NodeVolumeLimits
          - name: AzureDiskLimits
          - name: VolumeBinding
          - name: VolumeZone
          - name: PodTopologySpread
          - name: InterPodAffinity
      score:
        enabled:
          - name: NodeResourcesBalancedAllocation
            weight: 1
          - name: ImageLocality
            weight: 1
          - name: InterPodAffinity
            weight: 1
          - name: NodeResourcesFit
            weight: 1
          - name: NodeAffinity
            weight: 1
          - name: PodTopologySpread
            weight: 2
          - name: TaintToleration
            weight: 1

  # High-performance profile: zone filtering + cache awareness
  - schedulerName: high-perf-scheduler
    plugins:
      filter:
        enabled:
          - name: NodeUnschedulable
          - name: NodeName
          - name: TaintToleration
          - name: NodeAffinity
          - name: NodeResourcesFit
          - name: ZoneFilter        # Custom plugin
      preFilter:
        enabled:
          - name: NodeResourcesFit
          - name: CacheAware        # Custom plugin
      score:
        enabled:
          - name: NodeResourcesBalancedAllocation
            weight: 1
          - name: CacheAware        # Custom plugin
            weight: 5               # Higher weight for cache preference

  # Gang scheduling profile
  - schedulerName: gang-scheduler
    plugins:
      permit:
        enabled:
          - name: GangScheduler     # Custom plugin
      filter:
        enabled:
          - name: NodeUnschedulable
          - name: NodeResourcesFit
          - name: TaintToleration
      score:
        enabled:
          - name: NodeResourcesBalancedAllocation
            weight: 1

  # Batch profile: lighter scheduling, no affinity/spread
  - schedulerName: batch-scheduler
    plugins:
      filter:
        disabled:
          - name: "*"               # Disable all default filter plugins
        enabled:
          - name: NodeUnschedulable
          - name: NodeResourcesFit
          - name: TaintToleration
      score:
        disabled:
          - name: "*"
        enabled:
          - name: NodeResourcesBalancedAllocation
            weight: 1
```

### Plugin Args Configuration

Plugins can accept configuration arguments:

```yaml
profiles:
  - schedulerName: default-scheduler
    plugins:
      score:
        enabled:
          - name: NodeResourcesFit
    pluginConfig:
      - name: NodeResourcesFit
        args:
          scoringStrategy:
            type: LeastAllocated    # or MostAllocated, RequestedToCapacityRatio
            resources:
              - name: cpu
                weight: 1
              - name: memory
                weight: 1
      - name: PodTopologySpread
        args:
          defaultConstraints:
            - maxSkew: 1
              topologyKey: "topology.kubernetes.io/zone"
              whenUnsatisfiable: DoNotSchedule
          defaultingType: List
```

## Pods Selecting a Scheduling Profile

```yaml
# Pod using the high-performance profile
apiVersion: v1
kind: Pod
metadata:
  name: latency-sensitive-app
  labels:
    example.com/required-zone: "us-east-1a"
    example.com/cache-size-mb: "4096"
spec:
  schedulerName: high-perf-scheduler  # Select the profile
  containers:
    - name: app
      image: myapp:latest
      resources:
        requests:
          cpu: "4"
          memory: "8Gi"
---
# Pod using gang scheduling
apiVersion: v1
kind: Pod
metadata:
  name: ml-worker-0
  labels:
    example.com/gang-name: "ml-job-123"
    example.com/gang-size: "4"
spec:
  schedulerName: gang-scheduler
  containers:
    - name: ml-worker
      image: ml-training:latest
```

## Deploying the Custom Scheduler

```yaml
# scheduler-deployment.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: custom-scheduler
  namespace: kube-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: custom-scheduler
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: system:kube-scheduler
subjects:
  - kind: ServiceAccount
    name: custom-scheduler
    namespace: kube-system
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: custom-scheduler-config
  namespace: kube-system
data:
  scheduler-config.yaml: |
    apiVersion: kubescheduler.config.k8s.io/v1
    kind: KubeSchedulerConfiguration
    leaderElection:
      leaderElect: true
      resourceNamespace: kube-system
      resourceName: custom-scheduler
    profiles:
      - schedulerName: high-perf-scheduler
        plugins:
          filter:
            enabled:
              - name: ZoneFilter
          preFilter:
            enabled:
              - name: CacheAware
          score:
            enabled:
              - name: CacheAware
                weight: 5
              - name: NodeResourcesBalancedAllocation
                weight: 1
      - schedulerName: gang-scheduler
        plugins:
          permit:
            enabled:
              - name: GangScheduler
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: custom-scheduler
  namespace: kube-system
spec:
  replicas: 2  # For HA with leader election
  selector:
    matchLabels:
      app: custom-scheduler
  template:
    metadata:
      labels:
        app: custom-scheduler
    spec:
      serviceAccountName: custom-scheduler
      containers:
        - name: scheduler
          image: myorg/custom-scheduler:v1.0.0
          args:
            - --config=/etc/kubernetes/scheduler-config.yaml
            - --v=2
          volumeMounts:
            - name: config
              mountPath: /etc/kubernetes
          resources:
            requests:
              cpu: "100m"
              memory: "256Mi"
            limits:
              cpu: "500m"
              memory: "512Mi"
          livenessProbe:
            httpGet:
              path: /healthz
              port: 10259
              scheme: HTTPS
          readinessProbe:
            httpGet:
              path: /readyz
              port: 10259
              scheme: HTTPS
      volumes:
        - name: config
          configMap:
            name: custom-scheduler-config
      tolerations:
        - key: node-role.kubernetes.io/control-plane
          operator: Exists
          effect: NoSchedule
      nodeSelector:
        node-role.kubernetes.io/control-plane: ""
```

## Debugging Scheduling Decisions

```bash
# Enable verbose scheduler logging (temporarily)
kubectl patch deployment custom-scheduler -n kube-system \
    --type json \
    -p '[{"op":"replace","path":"/spec/template/spec/containers/0/args/1","value":"--v=10"}]'

# Watch scheduler logs for a specific pod
kubectl logs -n kube-system -l app=custom-scheduler --follow | \
    grep "my-pod-name"

# Check scheduling events
kubectl describe pod my-pod

# View events in the namespace
kubectl get events -n default --sort-by='.lastTimestamp' | \
    grep "my-pod-name"

# Use scheduler extender debug endpoint
curl -k https://scheduler-node:10259/debug/pprof/

# Check scheduler metrics
kubectl get --raw "/api/v1/namespaces/kube-system/services/https:custom-scheduler:10259/proxy/metrics" | \
    grep scheduler_

# Key metrics:
# scheduler_scheduling_duration_seconds: Total scheduling duration
# scheduler_e2e_scheduling_duration_seconds: End-to-end scheduling time
# scheduler_schedule_attempts_total: Scheduling attempts by result
# scheduler_preemption_victims: Victims in preemption
# scheduler_pod_scheduling_duration_seconds: Per-pod scheduling duration
```

## Testing Scheduling Plugins

The scheduler-framework provides testing utilities:

```go
package zone_filter_test

import (
    "context"
    "testing"

    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/kubernetes/pkg/scheduler/framework"
    "k8s.io/kubernetes/pkg/scheduler/framework/runtime"

    zone_filter "github.com/myorg/my-scheduler/plugin/zone_filter"
)

func TestZoneFilterPlugin(t *testing.T) {
    tests := []struct {
        name       string
        pod        *corev1.Pod
        node       *corev1.Node
        wantStatus framework.Code
    }{
        {
            name: "pod without zone requirement passes any node",
            pod: &corev1.Pod{
                ObjectMeta: metav1.ObjectMeta{Name: "test-pod"},
            },
            node: &corev1.Node{
                ObjectMeta: metav1.ObjectMeta{
                    Labels: map[string]string{
                        "topology.kubernetes.io/zone": "us-east-1a",
                    },
                },
            },
            wantStatus: framework.Success,
        },
        {
            name: "pod requiring zone us-east-1a passes matching node",
            pod: &corev1.Pod{
                ObjectMeta: metav1.ObjectMeta{
                    Labels: map[string]string{
                        "example.com/required-zone": "us-east-1a",
                    },
                },
            },
            node: &corev1.Node{
                ObjectMeta: metav1.ObjectMeta{
                    Labels: map[string]string{
                        "topology.kubernetes.io/zone": "us-east-1a",
                    },
                },
            },
            wantStatus: framework.Success,
        },
        {
            name: "pod requiring zone us-east-1a fails on us-east-1b node",
            pod: &corev1.Pod{
                ObjectMeta: metav1.ObjectMeta{
                    Labels: map[string]string{
                        "example.com/required-zone": "us-east-1a",
                    },
                },
            },
            node: &corev1.Node{
                ObjectMeta: metav1.ObjectMeta{
                    Labels: map[string]string{
                        "topology.kubernetes.io/zone": "us-east-1b",
                    },
                },
            },
            wantStatus: framework.Unschedulable,
        },
        {
            name: "pod requiring zone fails on node without zone label",
            pod: &corev1.Pod{
                ObjectMeta: metav1.ObjectMeta{
                    Labels: map[string]string{
                        "example.com/required-zone": "us-east-1a",
                    },
                },
            },
            node: &corev1.Node{
                ObjectMeta: metav1.ObjectMeta{
                    Labels: map[string]string{}, // No zone label
                },
            },
            wantStatus: framework.Unschedulable,
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            plugin := &zone_filter.ZoneFilterPlugin{}

            nodeInfo := framework.NewNodeInfo()
            nodeInfo.SetNode(tt.node)

            status := plugin.Filter(
                context.Background(),
                framework.NewCycleState(),
                tt.pod,
                nodeInfo,
            )

            var gotCode framework.Code
            if status == nil {
                gotCode = framework.Success
            } else {
                gotCode = status.Code()
            }

            if gotCode != tt.wantStatus {
                t.Errorf("Filter() = %v, want %v", gotCode, tt.wantStatus)
                if status != nil {
                    t.Errorf("Message: %s", status.Message())
                }
            }
        })
    }
}
```

## Summary

The Kubernetes scheduling framework transforms the scheduler from a monolithic component into a composable, extensible system:

- Extension points span the full scheduling lifecycle: QueueSort, PreEnqueue, PreFilter, Filter, PostFilter, PreScore, Score, NormalizeScore, Reserve, Permit, PreBind, Bind, PostBind
- Filter plugins return nil (pass) or a Status with Unschedulable/Error code; all plugins must pass for a node to be eligible
- Score plugins return an int64 (0-100); scores from all plugins are combined using their configured weights
- CycleState stores per-scheduling-cycle data, allowing PreFilter to compute once and Filter/Score to reuse
- Permit plugins can block pod binding until conditions are met (e.g., gang scheduling quorum)
- Custom plugins are compiled into the scheduler binary — not loaded as external processes
- Scheduling profiles run within a single scheduler binary, each with their own plugin configuration
- Pods select a profile via `spec.schedulerName`; unspecified pods use `default-scheduler`
- Multiple scheduler deployments (separate binaries) coexist by using different `resourceName` values for leader election
- The scheduler's `/debug/pprof` and `/metrics` endpoints are essential for diagnosing scheduling performance issues
