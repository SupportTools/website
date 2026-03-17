---
title: "Kubernetes Custom Scheduler: Building Placement Logic with Scheduler Framework"
date: 2028-02-02T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Scheduler", "Go", "Platform Engineering", "Volcano", "Gang Scheduling"]
categories: ["Kubernetes", "Platform Engineering", "Go"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Kubernetes custom scheduler development using the scheduler framework plugin API, including Filter and Score plugin implementation in Go, scheduler extender webhooks, multi-scheduler deployment, and gang scheduling with Volcano."
more_link: "yes"
url: "/kubernetes-custom-scheduler-guide/"
---

The default Kubernetes scheduler works well for the majority of workloads, but platform teams encounter cases where its built-in placement logic is insufficient: AI/ML batch jobs that require all replicas to start simultaneously (gang scheduling), workloads that must respect custom node attributes not expressible as standard labels, or placement policies that require cross-namespace awareness. The Kubernetes scheduler framework provides a plugin API that allows implementing custom scheduling logic as compiled-in plugins or as external webhook extenders, without forking the scheduler.

<!--more-->

# Kubernetes Custom Scheduler: Building Placement Logic with Scheduler Framework

## Scheduler Framework Architecture

The scheduler processes each pod through a sequence of extension points. Plugins register at one or more extension points and are called in the order defined by the scheduler profile.

```
Scheduling Cycle (per pod):
  PreFilter     → Augment pod info, pre-validate conditions
  Filter        → Eliminate nodes that cannot run the pod
  PostFilter     → Called if Filter eliminated all nodes (preemption)
  PreScore      → Prepare data for Score plugins
  Score         → Rank remaining nodes (0-100 scale)
  NormalizeScore → Normalize scores to 0-100 range
  Reserve       → Reserve resources on the selected node
  Permit        → Allow/deny/wait before binding
  PreBind       → Perform pre-binding operations
  Bind          → Actually bind the pod to the node
  PostBind      → Cleanup after successful binding

Binding Cycle (parallel with next scheduling cycle):
  Bind
  PostBind
```

Key properties:
- **Filter plugins** run in parallel — a node is eliminated if ANY filter rejects it
- **Score plugins** run in parallel — scores are summed with weights
- **Reserve** and **Permit** are sequential and can block scheduling

## Implementing a Custom Filter Plugin

### Plugin: NodeGPUModel Filter

This plugin filters nodes based on a GPU model annotation, allowing workloads to specify required GPU types that are not expressible via standard resource requests.

```go
// pkg/scheduler/plugin/gpumodel/gpumodel.go
package gpumodel

import (
    "context"
    "fmt"

    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/runtime"
    "k8s.io/kubernetes/pkg/scheduler/framework"
)

const (
    // PluginName is the name of this scheduler plugin
    PluginName = "GPUModelFilter"

    // PodAnnotationGPUModel is the annotation key on pods requesting a specific GPU
    PodAnnotationGPUModel = "scheduling.example.com/gpu-model"

    // NodeAnnotationGPUModel is the annotation key on nodes declaring their GPU
    NodeAnnotationGPUModel = "node.example.com/gpu-model"
)

// GPUModelFilter is a Filter plugin that ensures pods are scheduled
// only on nodes with the requested GPU model.
type GPUModelFilter struct {
    handle framework.Handle
}

// Ensure GPUModelFilter implements the Filter interface
var _ framework.FilterPlugin = &GPUModelFilter{}

// Name returns the plugin name
func (g *GPUModelFilter) Name() string {
    return PluginName
}

// New creates a new GPUModelFilter plugin instance.
// This function signature is required by the framework.
func New(_ runtime.Object, h framework.Handle) (framework.Plugin, error) {
    return &GPUModelFilter{handle: h}, nil
}

// Filter checks if the pod's GPU model requirement is satisfied by the node.
// Returns Success if the pod has no GPU model requirement,
// or if the node's GPU model matches the pod's requirement.
// Returns Unschedulable if there is a mismatch.
func (g *GPUModelFilter) Filter(
    ctx context.Context,
    cycleState *framework.CycleState,
    pod *corev1.Pod,
    nodeInfo *framework.NodeInfo,
) *framework.Status {
    // Check if the pod requests a specific GPU model
    requiredModel, exists := pod.Annotations[PodAnnotationGPUModel]
    if !exists {
        // No GPU model requirement — this filter does not apply
        return framework.NewStatus(framework.Success, "")
    }

    // Check the node's GPU model annotation
    node := nodeInfo.Node()
    if node == nil {
        return framework.NewStatus(framework.Error, "node not found in nodeInfo")
    }

    nodeModel, exists := node.Annotations[NodeAnnotationGPUModel]
    if !exists {
        // Node has no GPU model annotation — cannot satisfy the requirement
        return framework.NewStatus(
            framework.Unschedulable,
            fmt.Sprintf("node %s does not have GPU model annotation %s",
                node.Name, NodeAnnotationGPUModel),
        )
    }

    if nodeModel != requiredModel {
        return framework.NewStatus(
            framework.Unschedulable,
            fmt.Sprintf("node %s has GPU model %q but pod requires %q",
                node.Name, nodeModel, requiredModel),
        )
    }

    return framework.NewStatus(framework.Success, "")
}
```

## Implementing a Custom Score Plugin

### Plugin: DataLocalityScore

This score plugin prefers nodes that have the input data for a batch job in local storage, reducing data transfer costs.

```go
// pkg/scheduler/plugin/datalocality/datalocality.go
package datalocality

import (
    "context"
    "fmt"

    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/runtime"
    "k8s.io/kubernetes/pkg/scheduler/framework"
)

const (
    // PluginName is the name of this scheduler plugin
    PluginName = "DataLocalityScore"

    // PodAnnotationDataNode identifies nodes that have the pod's input data
    PodAnnotationDataNode = "scheduling.example.com/data-nodes"

    // MaxScore is the maximum score this plugin can assign
    MaxScore int64 = 100
)

// DataLocalityScore is a Score plugin that prefers nodes with local data.
type DataLocalityScore struct {
    handle framework.Handle
}

var _ framework.ScorePlugin = &DataLocalityScore{}

// Name returns the plugin name
func (d *DataLocalityScore) Name() string {
    return PluginName
}

// New creates a new DataLocalityScore plugin instance.
func New(_ runtime.Object, h framework.Handle) (framework.Plugin, error) {
    return &DataLocalityScore{handle: h}, nil
}

// Score assigns a score to a node based on data locality.
// Nodes listed in the pod's data-nodes annotation receive a high score.
func (d *DataLocalityScore) Score(
    ctx context.Context,
    state *framework.CycleState,
    pod *corev1.Pod,
    nodeName string,
) (int64, *framework.Status) {
    // Get the list of nodes with local data from the pod annotation
    dataNodesCSV, exists := pod.Annotations[PodAnnotationDataNode]
    if !exists {
        // No data locality preference — assign neutral score
        return MaxScore / 2, framework.NewStatus(framework.Success, "")
    }

    // Parse comma-separated node names
    dataNodes := parseNodeList(dataNodesCSV)

    // Check if this node is in the data-local set
    for _, dataNode := range dataNodes {
        if dataNode == nodeName {
            // This node has local data — maximum score
            return MaxScore, framework.NewStatus(framework.Success, "")
        }
    }

    // Node does not have local data — low but non-zero score
    // (allows scheduling here if no data-local nodes are available)
    return 10, framework.NewStatus(framework.Success, "")
}

// ScoreExtensions returns a ScoreExtensions interface if the plugin implements one.
func (d *DataLocalityScore) ScoreExtensions() framework.ScoreExtensions {
    return nil
}

// parseNodeList splits a comma-separated node list
func parseNodeList(csv string) []string {
    var nodes []string
    current := ""
    for _, c := range csv {
        if c == ',' {
            if current != "" {
                nodes = append(nodes, current)
                current = ""
            }
        } else {
            current += string(c)
        }
    }
    if current != "" {
        nodes = append(nodes, current)
    }
    return nodes
}

// PreScore is called before Score to precompute state shared across Score calls
func (d *DataLocalityScore) PreScore(
    ctx context.Context,
    state *framework.CycleState,
    pod *corev1.Pod,
    nodes []*corev1.Node,
) *framework.Status {
    // Nothing to precompute in this simple implementation
    return framework.NewStatus(framework.Success, "")
}

// Validate plugin name for debugging
var _ fmt.Stringer = &DataLocalityScore{}

func (d *DataLocalityScore) String() string {
    return fmt.Sprintf("DataLocalityScore plugin")
}
```

## Implementing a Permit Plugin (Waiting/Gang Scheduling)

The Permit extension point allows a plugin to approve, deny, or temporarily hold a pod after it has been scheduled to a node. This is used for gang scheduling: hold all pods of a job until enough nodes are available.

```go
// pkg/scheduler/plugin/gangscheduling/gangscheduling.go
package gangscheduling

import (
    "context"
    "sync"
    "time"

    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/runtime"
    "k8s.io/kubernetes/pkg/scheduler/framework"
)

const (
    PluginName = "GangScheduling"

    // PodLabelJobGroup identifies pods belonging to the same gang
    PodLabelJobGroup = "scheduling.example.com/job-group"

    // PodAnnotationMinMembers specifies the minimum number of pods that
    // must be schedulable before any of them is allowed to bind
    PodAnnotationMinMembers = "scheduling.example.com/min-members"

    // WaitTimeout is how long a pod waits for all gang members to be ready
    WaitTimeout = 30 * time.Second
)

// gangState tracks the state of a gang scheduling group
type gangState struct {
    mu          sync.Mutex
    // Total expected members for this gang
    totalMembers int
    // Pods that have been permitted (waiting)
    waitingPods  []string
}

// GangScheduling is a Permit plugin for gang scheduling.
// All pods in a gang wait until minMembers pods are ready before binding.
type GangScheduling struct {
    handle framework.Handle
    mu     sync.RWMutex
    gangs  map[string]*gangState
}

var _ framework.PermitPlugin = &GangScheduling{}

func (g *GangScheduling) Name() string {
    return PluginName
}

// New creates a new GangScheduling plugin
func New(_ runtime.Object, h framework.Handle) (framework.Plugin, error) {
    gs := &GangScheduling{
        handle: h,
        gangs:  make(map[string]*gangState),
    }
    return gs, nil
}

// Permit checks if this pod's gang has enough members ready to proceed.
func (g *GangScheduling) Permit(
    ctx context.Context,
    state *framework.CycleState,
    pod *corev1.Pod,
    nodeName string,
) (*framework.Status, time.Duration) {
    // Get the job group label
    jobGroup, exists := pod.Labels[PodLabelJobGroup]
    if !exists {
        // Not part of a gang — allow immediately
        return framework.NewStatus(framework.Success, ""), 0
    }

    // Get the minimum members annotation
    minMembersStr, exists := pod.Annotations[PodAnnotationMinMembers]
    if !exists {
        return framework.NewStatus(framework.Success, ""), 0
    }

    var minMembers int
    fmt.Sscanf(minMembersStr, "%d", &minMembers)
    if minMembers <= 1 {
        return framework.NewStatus(framework.Success, ""), 0
    }

    // Get or create the gang state
    g.mu.Lock()
    gang, exists := g.gangs[jobGroup]
    if !exists {
        gang = &gangState{totalMembers: minMembers}
        g.gangs[jobGroup] = gang
    }
    g.mu.Unlock()

    // Add this pod to the waiting list
    gang.mu.Lock()
    gang.waitingPods = append(gang.waitingPods, pod.Name)
    currentCount := len(gang.waitingPods)
    gang.mu.Unlock()

    if currentCount >= minMembers {
        // All required gang members are ready — allow all waiting pods
        g.allowGang(jobGroup)
        return framework.NewStatus(framework.Success, ""), 0
    }

    // Not enough gang members yet — wait
    return framework.NewStatus(framework.Wait,
        fmt.Sprintf("waiting for gang %s: %d/%d members ready",
            jobGroup, currentCount, minMembers),
    ), WaitTimeout
}

// allowGang signals all waiting pods in the gang to proceed
func (g *GangScheduling) allowGang(jobGroup string) {
    // Signal all waiting pods to proceed using the framework handle
    g.handle.IterateOverWaitingPods(func(wp framework.WaitingPod) {
        if wp.GetPod().Labels[PodLabelJobGroup] == jobGroup {
            wp.Allow(PluginName)
        }
    })

    // Clean up the gang state
    g.mu.Lock()
    delete(g.gangs, jobGroup)
    g.mu.Unlock()
}
```

## Building and Registering the Custom Scheduler

```go
// cmd/custom-scheduler/main.go
package main

import (
    "os"

    "k8s.io/component-base/logs"
    "k8s.io/kubernetes/cmd/kube-scheduler/app"

    // Import custom plugins
    gpumodel "github.com/my-org/custom-scheduler/pkg/scheduler/plugin/gpumodel"
    datalocality "github.com/my-org/custom-scheduler/pkg/scheduler/plugin/datalocality"
    gangscheduling "github.com/my-org/custom-scheduler/pkg/scheduler/plugin/gangscheduling"
)

func main() {
    logs.InitLogs()
    defer logs.FlushLogs()

    command := app.NewSchedulerCommand(
        // Register custom plugins with the scheduler
        app.WithPlugin(gpumodel.PluginName, gpumodel.New),
        app.WithPlugin(datalocality.PluginName, datalocality.New),
        app.WithPlugin(gangscheduling.PluginName, gangscheduling.New),
    )

    if err := command.Execute(); err != nil {
        os.Exit(1)
    }
}
```

## Scheduler Profile Configuration

The scheduler profile enables plugins per-scheduler-name. Multiple profiles can run in a single scheduler binary.

```yaml
# scheduler-config.yaml
apiVersion: kubescheduler.config.k8s.io/v1
kind: KubeSchedulerConfiguration
leaderElection:
  leaderElect: true
clientConnection:
  qps: 100
  burst: 200
profiles:
  # Default profile: standard scheduling
  - schedulerName: default-scheduler
    plugins:
      filter:
        enabled:
          - name: GPUModelFilter
      score:
        enabled:
          - name: DataLocalityScore
            weight: 10
    pluginConfig:
      - name: DataLocalityScore
        args:
          # Any configuration the plugin needs
          defaultScore: 50

  # GPU profile: specialized for AI/ML workloads
  - schedulerName: gpu-scheduler
    plugins:
      filter:
        enabled:
          - name: GPUModelFilter
        disabled:
          # Disable volume topology filter — GPU nodes may not be in the same zone
          - name: VolumeZone
      score:
        enabled:
          - name: DataLocalityScore
            weight: 20
        disabled:
          # Disable default pod spreading for GPU jobs that benefit from co-location
          - name: PodTopologySpread
      permit:
        enabled:
          - name: GangScheduling

  # Batch profile: for queue-based batch processing
  - schedulerName: batch-scheduler
    plugins:
      permit:
        enabled:
          - name: GangScheduling
    pluginConfig:
      - name: GangScheduling
        args:
          waitTimeout: 60s
```

## Deploying the Custom Scheduler

```yaml
# k8s/custom-scheduler-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: custom-scheduler
  namespace: kube-system
  labels:
    component: custom-scheduler
spec:
  replicas: 2  # Run two replicas for HA (uses leader election)
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
      containers:
        - name: scheduler
          image: gcr.io/my-org/custom-scheduler:v1.0.0
          command:
            - /custom-scheduler
            - --config=/etc/kubernetes/scheduler-config.yaml
            - --v=2
          volumeMounts:
            - name: scheduler-config
              mountPath: /etc/kubernetes
              readOnly: true
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              memory: 256Mi
          livenessProbe:
            httpGet:
              path: /healthz
              port: 10259
              scheme: HTTPS
            initialDelaySeconds: 15
            periodSeconds: 10
      volumes:
        - name: scheduler-config
          configMap:
            name: custom-scheduler-config
---
# RBAC for the custom scheduler
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: custom-scheduler
rules:
  # Standard scheduler permissions
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch", "update", "patch"]
  - apiGroups: [""]
    resources: ["nodes"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["pods/binding", "pods/status"]
    verbs: ["create", "update", "patch"]
  - apiGroups: [""]
    resources: ["events"]
    verbs: ["create", "patch", "update"]
  - apiGroups: ["apps"]
    resources: ["replicasets", "statefulsets"]
    verbs: ["get", "list", "watch"]
  # Storage classes for volume scheduling
  - apiGroups: ["storage.k8s.io"]
    resources: ["storageclasses", "csinodes", "csidrivers", "csistoragecapacities"]
    verbs: ["get", "list", "watch"]
  # Coordination for leader election
  - apiGroups: ["coordination.k8s.io"]
    resources: ["leases"]
    verbs: ["get", "create", "update"]
```

## Scheduler Extender (Webhook Alternative)

If compiling a custom scheduler binary is not feasible, a scheduler extender adds custom logic as an HTTP webhook called by the standard scheduler.

```go
// cmd/scheduler-extender/main.go
package main

import (
    "encoding/json"
    "fmt"
    "log"
    "net/http"

    corev1 "k8s.io/api/core/v1"
    extenderv1 "k8s.io/kube-scheduler/extender/v1"
)

// ExtenderFilterResult is returned by the Filter webhook
type ExtenderFilterResult struct {
    Nodes       *corev1.NodeList `json:"nodes,omitempty"`
    FailedNodes map[string]string `json:"failedNodes,omitempty"`
    Error       string            `json:"error,omitempty"`
}

// filterHandler implements the extender Filter endpoint
func filterHandler(w http.ResponseWriter, r *http.Request) {
    var args extenderv1.ExtenderArgs
    if err := json.NewDecoder(r.Body).Decode(&args); err != nil {
        http.Error(w, fmt.Sprintf("decoding args: %v", err), http.StatusBadRequest)
        return
    }

    pod := args.Pod
    nodes := args.Nodes

    var filteredNodes corev1.NodeList
    failedNodes := make(map[string]string)

    // Custom filter logic: check for a node annotation
    for _, node := range nodes.Items {
        if checkNodeSatisfiesCustomRequirement(pod, node) {
            filteredNodes.Items = append(filteredNodes.Items, node)
        } else {
            failedNodes[node.Name] = "does not satisfy custom placement requirement"
        }
    }

    result := ExtenderFilterResult{
        Nodes:       &filteredNodes,
        FailedNodes: failedNodes,
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(result)
}

func checkNodeSatisfiesCustomRequirement(pod *corev1.Pod, node corev1.Node) bool {
    // Implement custom logic here
    // Example: check a custom annotation on the node
    required, exists := pod.Annotations["custom.example.com/node-tier"]
    if !exists {
        return true // No requirement
    }
    nodeTier, exists := node.Annotations["custom.example.com/tier"]
    return exists && nodeTier == required
}

func main() {
    http.HandleFunc("/filter", filterHandler)
    log.Printf("Scheduler extender listening on :8888")
    log.Fatal(http.ListenAndServeTLS(":8888", "/certs/tls.crt", "/certs/tls.key", nil))
}
```

### Registering the Extender in the Scheduler Config

```yaml
# scheduler-config-with-extender.yaml
apiVersion: kubescheduler.config.k8s.io/v1
kind: KubeSchedulerConfiguration
profiles:
  - schedulerName: default-scheduler
extenders:
  - urlPrefix: "https://scheduler-extender.kube-system.svc.cluster.local:8888"
    filterVerb: filter
    # Extender is not authoritative: if extender fails, scheduling proceeds
    ignorable: true
    httpTimeout: 5s
    enableHTTPS: true
    tlsConfig:
      caData: <base64-ca-cert>
    # List of resources managed by the extender
    managedResources:
      - name: "custom.example.com/gpu-slot"
        ignoredByScheduler: false
```

## Volcano: Production Gang Scheduling

For production AI/ML workloads, Volcano provides a mature gang scheduling implementation with queue management, job preemption, and fair-share resource allocation.

```yaml
# volcano/queue-high-priority.yaml
apiVersion: scheduling.volcano.sh/v1beta1
kind: Queue
metadata:
  name: ml-training-high
spec:
  # Maximum CPU and memory this queue can use
  capability:
    cpu: 64
    memory: 256Gi
  # Guaranteed resources even under pressure
  guarantee:
    resource:
      cpu: 16
      memory: 64Gi
  # Reclaimable: excess capacity can be borrowed by other queues
  reclaimable: true
  # Priority: higher number = higher priority
  weight: 10
---
# volcano/vcjob-training.yaml
# A Volcano job that uses gang scheduling
apiVersion: batch.volcano.sh/v1alpha1
kind: Job
metadata:
  name: distributed-training-job
  namespace: ml-platform
spec:
  # Minimum number of pods that must start simultaneously
  # If fewer than minAvailable nodes are available, no pods start
  minAvailable: 8
  queue: ml-training-high
  # Scheduling policy: All or nothing
  policies:
    # Restart the entire job if any task fails
    - event: PodFailed
      action: RestartJob
    # Complete the job when all master tasks succeed
    - event: TaskCompleted
      action: CompleteJob
  tasks:
    # Parameter server (PS) tasks
    - replicas: 2
      name: ps
      policies:
        - event: TaskFailed
          action: RestartJob
      template:
        metadata:
          labels:
            role: parameter-server
        spec:
          containers:
            - name: ps
              image: gcr.io/my-org/training:v1.0
              command: ["python", "ps_server.py"]
              resources:
                requests:
                  cpu: 4
                  memory: 16Gi
    # Worker tasks
    - replicas: 6
      name: worker
      template:
        metadata:
          labels:
            role: worker
        spec:
          containers:
            - name: worker
              image: gcr.io/my-org/training:v1.0
              command: ["python", "train.py"]
              resources:
                requests:
                  cpu: 8
                  memory: 32Gi
                  nvidia.com/gpu: 1
```

## Advanced Topology Spread Constraints

```yaml
# For workloads that need careful distribution without a custom scheduler,
# topology spread constraints provide zone-aware spreading built into the
# default scheduler.

# deployment-topology-spread.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: high-availability-api
  namespace: production
spec:
  replicas: 9
  template:
    spec:
      topologySpreadConstraints:
        # Spread evenly across availability zones
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule  # Hard constraint
          labelSelector:
            matchLabels:
              app: high-availability-api
          # Only consider nodes where the pod can actually run
          nodeAffinityPolicy: Honor
          nodeTaintsPolicy: Honor

        # Spread evenly across nodes within each zone
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: ScheduleAnyway  # Soft constraint
          labelSelector:
            matchLabels:
              app: high-availability-api

        # Keep pods away from each other's underlying physical hosts
        # (if your cluster has host topology labels)
        - maxSkew: 2
          topologyKey: node.example.com/physical-host
          whenUnsatisfiable: ScheduleAnyway
          labelSelector:
            matchLabels:
              app: high-availability-api
```

## Debugging Scheduler Decisions

```bash
# Enable verbose scheduler logging
# Add to the scheduler deployment args:
# --v=4 (shows scheduler decision details)
# --v=10 (shows all filter results — very verbose)

# Watch scheduler events for a specific pod
kubectl describe pod my-pod -n production | grep -A 10 "Events:"

# Check scheduler log for filter failures
kubectl logs -n kube-system deployment/kube-scheduler \
  | grep -i "filter\|unable to schedule\|fit failure" | tail -20

# Use kubectl explain to check scheduler-related fields
kubectl explain pod.spec.schedulerName

# Assign a pod to the custom scheduler profile
# (pod will use the gpu-scheduler profile instead of default-scheduler)
apiVersion: v1
kind: Pod
metadata:
  name: gpu-workload
spec:
  schedulerName: gpu-scheduler  # Reference to the profile name
  containers:
    - name: training
      image: gcr.io/my-org/training:v1.0

# Check node fit for a specific pod (dry-run scheduling)
kubectl apply -f pod.yaml --dry-run=server 2>&1 | head -20
```

## Summary

The Kubernetes scheduler framework provides a clean plugin API for implementing custom scheduling logic at every stage of the scheduling pipeline. Filter plugins eliminate nodes that cannot satisfy custom requirements, Score plugins rank remaining candidates based on business-specific metrics, Reserve plugins claim resources atomically, and Permit plugins enable complex coordination patterns like gang scheduling. For teams that cannot compile a custom scheduler binary, the extender webhook mechanism provides access to the same Filter and Score extension points via HTTP callbacks. Volcano provides a production-grade implementation of gang scheduling with queue management and fair-share allocation suitable for large-scale AI/ML platform teams. Advanced topology spread constraints, built into the default scheduler, handle the majority of zone-aware distribution requirements without requiring custom code.
