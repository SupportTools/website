---
title: "Kubernetes Scheduling Deep Dive: Custom Schedulers, Scheduler Extenders, and DRA"
date: 2030-03-09T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Scheduling", "DRA", "GPU", "Custom Scheduler", "Platform Engineering"]
categories: ["Kubernetes", "Platform Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to the Kubernetes scheduler framework plugins, building scheduler extenders, Dynamic Resource Allocation for specialized hardware, and priority classes with preemption."
more_link: "yes"
url: "/kubernetes-scheduling-deep-dive-custom-schedulers-dra/"
---

The Kubernetes scheduler is a control loop that watches for unscheduled pods and assigns them to nodes using a multi-phase filtering and scoring algorithm. While the default scheduler handles the vast majority of workloads effectively, production environments with specialized hardware (GPUs, FPGAs, high-bandwidth networking), compliance requirements, or complex placement constraints often need custom scheduling behavior. This guide covers the scheduler framework architecture, how to extend it correctly, and the Dynamic Resource Allocation API for next-generation hardware management.

<!--more-->

## Kubernetes Scheduler Architecture

The scheduler operates as a separate control plane component (kube-scheduler) that watches the API server for pods with no `.spec.nodeName` and attempts to bind them to suitable nodes.

### The Scheduling Cycle

The scheduling process for each pod consists of two phases:

**Scheduling Cycle** (runs once per pod, single-threaded per scheduler):
1. `PreFilter` — Pre-compute information needed for filtering
2. `Filter` — Remove nodes that don't meet hard requirements
3. `PostFilter` — Called when filtering produces no results (enables preemption)
4. `PreScore` — Pre-compute information needed for scoring
5. `Score` — Rank remaining nodes by preference (0-100)
6. `NormalizeScore` — Normalize scores across all plugins
7. `Reserve` — Reserve resources on the chosen node
8. `Permit` — Allow, deny, or wait (for gang scheduling)

**Binding Cycle** (runs concurrently):
9. `PreBind` — Prepare for binding (e.g., provision volumes)
10. `Bind` — Write the pod binding to the API server
11. `PostBind` — Cleanup after binding

### Scheduler Framework Plugin Interface

```go
// The complete framework.Plugin interface chain
// From k8s.io/kubernetes/pkg/scheduler/framework

package framework

import (
    "context"
    v1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/runtime"
)

// Plugin is the parent interface for all scheduler plugins
type Plugin interface {
    Name() string
}

// PreFilterPlugin pre-computes state for the Filter phase
type PreFilterPlugin interface {
    Plugin
    PreFilter(ctx context.Context, state *CycleState, p *v1.Pod) (*PreFilterResult, *Status)
    PreFilterExtensions() PreFilterExtensions
}

// FilterPlugin eliminates nodes that cannot run the pod
type FilterPlugin interface {
    Plugin
    Filter(ctx context.Context, state *CycleState, pod *v1.Pod, nodeInfo *NodeInfo) *Status
}

// ScorePlugin scores feasible nodes
type ScorePlugin interface {
    Plugin
    Score(ctx context.Context, state *CycleState, p *v1.Pod, nodeName string) (int64, *Status)
    ScoreExtensions() ScoreExtensions
}

// ReservePlugin reserves resources when a node is selected
type ReservePlugin interface {
    Plugin
    Reserve(ctx context.Context, state *CycleState, p *v1.Pod, nodeName string) *Status
    Unreserve(ctx context.Context, state *CycleState, p *v1.Pod, nodeName string)
}

// BindPlugin binds the pod to the selected node
type BindPlugin interface {
    Plugin
    Bind(ctx context.Context, state *CycleState, p *v1.Pod, nodeName string) *Status
}
```

## Building a Custom Scheduler Plugin

We'll build a plugin that prefers nodes with a specific label value and enforces co-location of pods belonging to the same application group.

### Plugin Structure

```go
// pkg/scheduler/plugin/appgroup/plugin.go
package appgroup

import (
    "context"
    "fmt"
    "sync"

    v1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/labels"
    "k8s.io/apimachinery/pkg/runtime"
    "k8s.io/client-go/informers"
    clientset "k8s.io/client-go/kubernetes"
    "k8s.io/kubernetes/pkg/scheduler/framework"
)

const (
    // PluginName is the name of this plugin
    PluginName = "AppGroupColocator"

    // AppGroupLabel is the pod label that identifies an application group
    AppGroupLabel = "app.example.com/group"

    // MaxScore is the maximum score returned by this plugin
    MaxScore = 100

    // stateKey is the key for storing pre-computed state
    stateKey = "AppGroupColocatorState"
)

// AppGroupColocator implements scheduling plugins for app group co-location
type AppGroupColocator struct {
    handle    framework.Handle
    clientset clientset.Interface

    mu          sync.RWMutex
    groupNodes  map[string]map[string]int // group -> nodeName -> pod count
}

// precomputedState is stored in CycleState and passed between phases
type precomputedState struct {
    appGroup      string
    existingNodes map[string]int // nodes already running pods of this group
}

func (s *precomputedState) Clone() framework.StateData {
    cloned := &precomputedState{
        appGroup:      s.appGroup,
        existingNodes: make(map[string]int, len(s.existingNodes)),
    }
    for k, v := range s.existingNodes {
        cloned.existingNodes[k] = v
    }
    return cloned
}

// New creates a new AppGroupColocator plugin
func New(obj runtime.Object, h framework.Handle) (framework.Plugin, error) {
    client := h.ClientSet()
    plugin := &AppGroupColocator{
        handle:     h,
        clientset:  client,
        groupNodes: make(map[string]map[string]int),
    }

    // Set up informer to track pod placements
    podInformer := h.SharedInformerFactory().Core().V1().Pods()
    podInformer.Informer().AddEventHandler(plugin.podEventHandler())

    return plugin, nil
}

func (p *AppGroupColocator) Name() string {
    return PluginName
}

// PreFilter computes the app group and existing node distribution
func (p *AppGroupColocator) PreFilter(
    ctx context.Context,
    state *framework.CycleState,
    pod *v1.Pod,
) (*framework.PreFilterResult, *framework.Status) {
    appGroup := pod.Labels[AppGroupLabel]

    preState := &precomputedState{
        appGroup:      appGroup,
        existingNodes: make(map[string]int),
    }

    if appGroup != "" {
        p.mu.RLock()
        if nodeMap, ok := p.groupNodes[appGroup]; ok {
            for node, count := range nodeMap {
                preState.existingNodes[node] = count
            }
        }
        p.mu.RUnlock()
    }

    state.Write(stateKey, preState)
    return nil, nil
}

func (p *AppGroupColocator) PreFilterExtensions() framework.PreFilterExtensions {
    return nil
}

// Score assigns higher scores to nodes already running pods of the same group
func (p *AppGroupColocator) Score(
    ctx context.Context,
    state *framework.CycleState,
    pod *v1.Pod,
    nodeName string,
) (int64, *framework.Status) {
    data, err := state.Read(stateKey)
    if err != nil {
        return 0, framework.NewStatus(framework.Error, fmt.Sprintf("reading state: %v", err))
    }
    preState := data.(*precomputedState)

    // If no app group, no preference
    if preState.appGroup == "" {
        return 0, nil
    }

    // If no pods of this group are scheduled yet, all nodes score equally
    if len(preState.existingNodes) == 0 {
        return MaxScore / 2, nil
    }

    // Score based on co-location: more pods of the group on this node = higher score
    count := preState.existingNodes[nodeName]
    totalPods := 0
    for _, c := range preState.existingNodes {
        totalPods += c
    }

    if totalPods == 0 {
        return MaxScore / 2, nil
    }

    // Normalize: node with the most pods of this group gets MaxScore
    maxOnAnyNode := 0
    for _, c := range preState.existingNodes {
        if c > maxOnAnyNode {
            maxOnAnyNode = c
        }
    }
    if maxOnAnyNode == 0 {
        return 0, nil
    }

    score := int64(float64(count) / float64(maxOnAnyNode) * MaxScore)
    return score, nil
}

func (p *AppGroupColocator) ScoreExtensions() framework.ScoreExtensions {
    return nil
}

// Reserve updates the in-memory group-node tracking
func (p *AppGroupColocator) Reserve(
    ctx context.Context,
    state *framework.CycleState,
    pod *v1.Pod,
    nodeName string,
) *framework.Status {
    appGroup := pod.Labels[AppGroupLabel]
    if appGroup == "" {
        return nil
    }

    p.mu.Lock()
    defer p.mu.Unlock()
    if _, ok := p.groupNodes[appGroup]; !ok {
        p.groupNodes[appGroup] = make(map[string]int)
    }
    p.groupNodes[appGroup][nodeName]++
    return nil
}

// Unreserve rolls back the reservation on failure
func (p *AppGroupColocator) Unreserve(
    ctx context.Context,
    state *framework.CycleState,
    pod *v1.Pod,
    nodeName string,
) {
    appGroup := pod.Labels[AppGroupLabel]
    if appGroup == "" {
        return
    }

    p.mu.Lock()
    defer p.mu.Unlock()
    if nodeMap, ok := p.groupNodes[appGroup]; ok {
        if nodeMap[nodeName] > 0 {
            nodeMap[nodeName]--
        }
        if nodeMap[nodeName] == 0 {
            delete(nodeMap, nodeName)
        }
    }
}

// podEventHandler handles pod add/update/delete events
func (p *AppGroupColocator) podEventHandler() cache.ResourceEventHandlerFuncs {
    return cache.ResourceEventHandlerFuncs{
        AddFunc: func(obj interface{}) {
            pod := obj.(*v1.Pod)
            if pod.Spec.NodeName == "" {
                return
            }
            appGroup := pod.Labels[AppGroupLabel]
            if appGroup == "" {
                return
            }
            p.mu.Lock()
            defer p.mu.Unlock()
            if _, ok := p.groupNodes[appGroup]; !ok {
                p.groupNodes[appGroup] = make(map[string]int)
            }
            p.groupNodes[appGroup][pod.Spec.NodeName]++
        },
        DeleteFunc: func(obj interface{}) {
            pod, ok := obj.(*v1.Pod)
            if !ok {
                return
            }
            if pod.Spec.NodeName == "" {
                return
            }
            appGroup := pod.Labels[AppGroupLabel]
            if appGroup == "" {
                return
            }
            p.mu.Lock()
            defer p.mu.Unlock()
            if nodeMap, ok := p.groupNodes[appGroup]; ok {
                if nodeMap[pod.Spec.NodeName] > 0 {
                    nodeMap[pod.Spec.NodeName]--
                }
            }
        },
    }
}
```

### Building the Custom Scheduler Binary

```go
// cmd/custom-scheduler/main.go
package main

import (
    "os"

    "k8s.io/component-base/cli"
    "k8s.io/kubernetes/pkg/scheduler/app"
    "k8s.io/kubernetes/pkg/scheduler/framework/plugins/defaultpreemption"
    "k8s.io/kubernetes/pkg/scheduler/framework/plugins/names"

    "github.com/example/custom-scheduler/pkg/scheduler/plugin/appgroup"
)

func main() {
    command := app.NewSchedulerCommand(
        app.WithPlugin(appgroup.PluginName, appgroup.New),
        // Keep default plugins available
        app.WithPlugin(names.DefaultPreemption, defaultpreemption.New),
    )

    if err := cli.Run(command); err != nil {
        os.Exit(1)
    }
}
```

```yaml
# KubeSchedulerConfiguration for the custom scheduler
# /etc/kubernetes/custom-scheduler-config.yaml
apiVersion: kubescheduler.config.k8s.io/v1
kind: KubeSchedulerConfiguration
profiles:
  - schedulerName: custom-scheduler

    plugins:
      preFilter:
        enabled:
          - name: AppGroupColocator
      score:
        enabled:
          - name: AppGroupColocator
            weight: 3
      reserve:
        enabled:
          - name: AppGroupColocator
      # Disable plugins not needed for our use case
      multiPoint:
        disabled:
          - name: PodTopologySpread   # We handle this ourselves

    pluginConfig:
      - name: AppGroupColocator
        args:
          # Plugin-specific configuration
          maxGroupSize: 100
```

```yaml
# Deploying the custom scheduler
apiVersion: apps/v1
kind: Deployment
metadata:
  name: custom-scheduler
  namespace: kube-system
spec:
  replicas: 1
  selector:
    matchLabels:
      component: custom-scheduler
  template:
    metadata:
      labels:
        component: custom-scheduler
    spec:
      serviceAccountName: custom-scheduler
      containers:
      - name: custom-scheduler
        image: myregistry/custom-scheduler:v1.0.0
        args:
        - --config=/etc/kubernetes/custom-scheduler-config.yaml
        - --v=2
        - --leader-elect=true
        - --leader-elect-resource-name=custom-scheduler
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 1
            memory: 512Mi
        volumeMounts:
        - name: scheduler-config
          mountPath: /etc/kubernetes
          readOnly: true
      volumes:
      - name: scheduler-config
        configMap:
          name: custom-scheduler-config
---
# RBAC for custom scheduler
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: custom-scheduler
rules:
- apiGroups: [""]
  resources: ["pods", "nodes", "namespaces", "persistentvolumeclaims",
               "persistentvolumes", "replicationcontrollers", "services",
               "endpoints", "configmaps", "replicationcontrollers/status"]
  verbs: ["get", "list", "watch"]
- apiGroups: [""]
  resources: ["pods/binding", "pods/status", "bindings", "events"]
  verbs: ["create", "update", "patch"]
- apiGroups: ["apps"]
  resources: ["statefulsets", "replicasets"]
  verbs: ["get", "list", "watch"]
- apiGroups: ["coordination.k8s.io"]
  resources: ["leases"]
  verbs: ["get", "list", "watch", "create", "update", "patch"]
```

## Scheduler Extenders

Scheduler extenders are HTTP webhooks called by the main kube-scheduler. They are simpler to deploy than custom scheduler plugins but have higher latency due to the HTTP round-trip.

```go
// cmd/scheduler-extender/main.go - HTTP server implementing the scheduler extender API
package main

import (
    "encoding/json"
    "fmt"
    "log"
    "net/http"

    v1 "k8s.io/api/core/v1"
    extenderv1 "k8s.io/kube-scheduler/extender/v1"
)

type extenderHandler struct{}

// Filter removes nodes that don't meet custom requirements
func (e *extenderHandler) Filter(w http.ResponseWriter, r *http.Request) {
    var args extenderv1.ExtenderArgs
    if err := json.NewDecoder(r.Body).Decode(&args); err != nil {
        http.Error(w, err.Error(), http.StatusBadRequest)
        return
    }

    pod := args.Pod
    nodes := args.Nodes

    var filteredNodes []v1.Node
    var failedNodes extenderv1.FailedNodesMap

    for _, node := range nodes.Items {
        if err := canSchedulePod(pod, &node); err != nil {
            if failedNodes == nil {
                failedNodes = make(extenderv1.FailedNodesMap)
            }
            failedNodes[node.Name] = err.Error()
        } else {
            filteredNodes = append(filteredNodes, node)
        }
    }

    result := extenderv1.ExtenderFilterResult{
        Nodes: &v1.NodeList{Items: filteredNodes},
        FailedNodes: failedNodes,
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(result)
}

// Prioritize assigns scores to nodes
func (e *extenderHandler) Prioritize(w http.ResponseWriter, r *http.Request) {
    var args extenderv1.ExtenderArgs
    if err := json.NewDecoder(r.Body).Decode(&args); err != nil {
        http.Error(w, err.Error(), http.StatusBadRequest)
        return
    }

    var hostPriorityList extenderv1.HostPriorityList

    for _, node := range args.Nodes.Items {
        score := computeNodeScore(args.Pod, &node)
        hostPriorityList = append(hostPriorityList, extenderv1.HostPriority{
            Host:  node.Name,
            Score: score,
        })
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(hostPriorityList)
}

func canSchedulePod(pod *v1.Pod, node *v1.Node) error {
    // Custom scheduling logic:
    // Example: require specific annotation on nodes for GPU workloads
    if _, ok := pod.Labels["workload-type"]; ok {
        if pod.Labels["workload-type"] == "gpu-training" {
            if _, ok := node.Labels["gpu-class"]; !ok {
                return fmt.Errorf("node %s does not have required gpu-class label", node.Name)
            }
            required := pod.Labels["required-gpu-class"]
            actual := node.Labels["gpu-class"]
            if required != "" && required != actual {
                return fmt.Errorf("node has gpu-class=%s, pod requires %s", actual, required)
            }
        }
    }
    return nil
}

func computeNodeScore(pod *v1.Pod, node *v1.Node) int64 {
    // Prefer nodes with more available memory (simple example)
    allocatable := node.Status.Allocatable.Memory()
    if allocatable == nil {
        return 0
    }
    // Normalize to 0-100 scale
    // (simplified - real implementation would use actual availability)
    gbAvailable := allocatable.Value() / (1024 * 1024 * 1024)
    if gbAvailable > 100 {
        return 100
    }
    return gbAvailable
}

func main() {
    h := &extenderHandler{}
    mux := http.NewServeMux()
    mux.HandleFunc("/filter", h.Filter)
    mux.HandleFunc("/prioritize", h.Prioritize)

    log.Println("Starting scheduler extender on :8888")
    log.Fatal(http.ListenAndServe(":8888", mux))
}
```

```yaml
# KubeSchedulerConfiguration with extender
apiVersion: kubescheduler.config.k8s.io/v1
kind: KubeSchedulerConfiguration
extenders:
  - urlPrefix: "http://scheduler-extender.kube-system.svc:8888"
    filterVerb: "filter"
    prioritizeVerb: "prioritize"
    weight: 5
    enableHTTPS: false
    nodeCacheCapable: false
    # Only call extender for pods with this label
    bindVerb: ""
    managedResources:
      - name: "example.com/custom-resource"
        ignoredByScheduler: false
```

## Dynamic Resource Allocation (DRA)

DRA is a Kubernetes API (graduated to stable in 1.32) for hardware devices that don't fit the simple quantity-of-resource model. GPUs, FPGAs, high-performance NICs, and custom ASICs all benefit from DRA's device-class model.

### DRA Architecture

```
ResourceClass  ->  defines WHAT can be allocated (driver, parameters)
ResourceClaim  ->  requests specific resources for a workload
ResourceClaimTemplate -> creates per-pod claims
DeviceClass    ->  categorizes devices (in new structured parameters model)
ResourceSlice  ->  advertises available devices from a node
```

### Defining Device Classes

```yaml
# DeviceClass for NVIDIA GPUs
apiVersion: resource.k8s.io/v1beta1
kind: DeviceClass
metadata:
  name: nvidia.com-gpu
spec:
  selectors:
    - cel:
        expression: device.driver == "gpu.resource.nvidia.com"
  config:
    - opaque:
        driver: gpu.resource.nvidia.com
        parameters:
          apiVersion: gpu.resource.nvidia.com/v1alpha1
          kind: GpuClaimParameters
          spec:
            count: 1
---
# DeviceClass for high-memory GPUs
apiVersion: resource.k8s.io/v1beta1
kind: DeviceClass
metadata:
  name: nvidia.com-gpu-80gb
spec:
  selectors:
    - cel:
        expression: >
          device.driver == "gpu.resource.nvidia.com" &&
          device.attributes["gpu.resource.nvidia.com"].memory >= 80000
```

### ResourceClaim for AI/ML Workloads

```yaml
# ResourceClaim requesting 2 GPUs with NVLink connectivity
apiVersion: resource.k8s.io/v1beta1
kind: ResourceClaim
metadata:
  name: training-job-gpus
  namespace: ml-workloads
spec:
  devices:
    requests:
    - name: gpu
      deviceClassName: nvidia.com-gpu
      count: 2
      selectors:
      - cel:
          # Require GPUs with NVLink (for multi-GPU all-reduce)
          expression: >
            device.attributes["gpu.resource.nvidia.com"].memory >= 40000 &&
            device.attributes["gpu.resource.nvidia.com"].nvlink == true
      allocationMode: ExactCount
    # Optionally request a specific network interface alongside the GPU
    - name: rdma-nic
      deviceClassName: rdma.cni.cncf.io
      count: 1
      allocationMode: ExactCount
---
# Pod using the ResourceClaim
apiVersion: v1
kind: Pod
metadata:
  name: training-job
  namespace: ml-workloads
spec:
  resourceClaims:
  - name: gpu-claim
    resourceClaimName: training-job-gpus
  containers:
  - name: trainer
    image: pytorch/pytorch:2.2.0-cuda12.1-cudnn8-runtime
    resources:
      claims:
      - name: gpu-claim
        request: gpu
    command: ["python", "train.py", "--gpus=2"]
    env:
    - name: NVIDIA_VISIBLE_DEVICES
      valueFrom:
        resourceFieldRef:
          resource: requests.gpu-claim/gpu
```

### ResourceClaimTemplate for StatefulSets

```yaml
# Each pod in the StatefulSet gets its own unique GPU allocation
apiVersion: resource.k8s.io/v1beta1
kind: ResourceClaimTemplate
metadata:
  name: inference-gpu-template
  namespace: ml-workloads
spec:
  metadata:
    labels:
      workload: inference
  spec:
    devices:
      requests:
      - name: gpu
        deviceClassName: nvidia.com-gpu
        count: 1
        allocationMode: ExactCount
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: inference-servers
  namespace: ml-workloads
spec:
  serviceName: inference
  replicas: 4
  selector:
    matchLabels:
      app: inference-server
  template:
    metadata:
      labels:
        app: inference-server
    spec:
      resourceClaims:
      - name: gpu
        resourceClaimTemplateName: inference-gpu-template
      containers:
      - name: inference
        image: myregistry/inference-server:latest
        resources:
          claims:
          - name: gpu
```

### Writing a DRA Driver

A DRA driver is a DaemonSet that implements the `NodeResourcePlugin` gRPC API to advertise and allocate devices.

```go
// pkg/dra/driver/server.go
package driver

import (
    "context"
    "fmt"
    "log"
    "net"
    "os"
    "path/filepath"

    "google.golang.org/grpc"
    drapbv1beta1 "k8s.io/kubelet/pkg/apis/dra/v1beta1"
)

const (
    pluginName      = "mydevice.example.com"
    pluginSocketDir = "/var/lib/kubelet/plugins"
)

type DeviceDriver struct {
    drapbv1beta1.UnimplementedDRAPluginServer
    devices map[string]*DeviceInfo
}

type DeviceInfo struct {
    ID          string
    Vendor      string
    Model       string
    Memory      uint64
    Available   bool
    AllocatedTo string
}

func NewDeviceDriver() *DeviceDriver {
    return &DeviceDriver{
        devices: discoverDevices(),
    }
}

// NodePrepareResources prepares the allocated devices for use by a pod
func (d *DeviceDriver) NodePrepareResources(
    ctx context.Context,
    req *drapbv1beta1.NodePrepareResourcesRequest,
) (*drapbv1beta1.NodePrepareResourcesResponse, error) {
    resp := &drapbv1beta1.NodePrepareResourcesResponse{
        Claims: make(map[string]*drapbv1beta1.NodePrepareResourceResponse),
    }

    for claimUID, claim := range req.Claims {
        prepared, err := d.prepareClaim(ctx, claimUID, claim)
        if err != nil {
            resp.Claims[claimUID] = &drapbv1beta1.NodePrepareResourceResponse{
                Error: err.Error(),
            }
            continue
        }
        resp.Claims[claimUID] = &drapbv1beta1.NodePrepareResourceResponse{
            Devices: prepared,
        }
    }

    return resp, nil
}

// NodeUnprepareResources releases resources after pod termination
func (d *DeviceDriver) NodeUnprepareResources(
    ctx context.Context,
    req *drapbv1beta1.NodeUnprepareResourcesRequest,
) (*drapbv1beta1.NodeUnprepareResourcesResponse, error) {
    resp := &drapbv1beta1.NodeUnprepareResourcesResponse{
        Claims: make(map[string]*drapbv1beta1.NodeUnprepareResourceResponse),
    }

    for claimUID := range req.Claims {
        if err := d.releaseClaim(ctx, claimUID); err != nil {
            resp.Claims[claimUID] = &drapbv1beta1.NodeUnprepareResourceResponse{
                Error: err.Error(),
            }
        } else {
            resp.Claims[claimUID] = &drapbv1beta1.NodeUnprepareResourceResponse{}
        }
    }

    return resp, nil
}

func (d *DeviceDriver) prepareClaim(ctx context.Context, claimUID string, claim *drapbv1beta1.Claim) ([]*drapbv1beta1.Device, error) {
    var prepared []*drapbv1beta1.Device

    for _, requestName := range claim.ResourceHandles {
        for _, handle := range requestName.Data {
            deviceID := handle.Data  // Device ID from allocation result

            device, ok := d.devices[deviceID]
            if !ok {
                return nil, fmt.Errorf("device %s not found", deviceID)
            }

            // Perform actual device preparation (e.g., create device node, set up cgroups)
            if err := d.setupDevice(device, claimUID); err != nil {
                return nil, fmt.Errorf("setting up device %s: %w", deviceID, err)
            }

            device.Available = false
            device.AllocatedTo = claimUID

            prepared = append(prepared, &drapbv1beta1.Device{
                RequestNames: []string{requestName.DriverName},
                PoolName:     "mydevice-pool",
                DeviceName:   deviceID,
                CDIDeviceIDs: []string{fmt.Sprintf("mydevice.example.com/device=%s", deviceID)},
            })
        }
    }

    return prepared, nil
}

func (d *DeviceDriver) setupDevice(device *DeviceInfo, claimUID string) error {
    // Create CDI spec, configure device permissions, set up cgroup access, etc.
    log.Printf("Setting up device %s for claim %s\n", device.ID, claimUID)
    // Real implementation: write CDI spec file, set up device symlinks, etc.
    return nil
}

func (d *DeviceDriver) releaseClaim(ctx context.Context, claimUID string) error {
    for _, device := range d.devices {
        if device.AllocatedTo == claimUID {
            device.Available = true
            device.AllocatedTo = ""
            log.Printf("Released device %s from claim %s\n", device.ID, claimUID)
        }
    }
    return nil
}

func discoverDevices() map[string]*DeviceInfo {
    // Enumerate hardware devices (e.g., via /sys/bus/pci, lspci, etc.)
    return map[string]*DeviceInfo{
        "device-0": {ID: "device-0", Vendor: "ExampleCorp", Model: "Model-X", Memory: 40960, Available: true},
        "device-1": {ID: "device-1", Vendor: "ExampleCorp", Model: "Model-X", Memory: 40960, Available: true},
    }
}

func (d *DeviceDriver) Serve() error {
    socketPath := filepath.Join(pluginSocketDir, pluginName, "plugin.sock")
    if err := os.MkdirAll(filepath.Dir(socketPath), 0750); err != nil {
        return err
    }
    os.Remove(socketPath)

    listener, err := net.Listen("unix", socketPath)
    if err != nil {
        return fmt.Errorf("listening on %s: %w", socketPath, err)
    }

    server := grpc.NewServer()
    drapbv1beta1.RegisterDRAPluginServer(server, d)

    log.Printf("DRA driver listening on %s\n", socketPath)
    return server.Serve(listener)
}
```

## Priority Classes and Preemption

Priority classes allow the scheduler to preempt (evict) lower-priority pods when higher-priority pods cannot be scheduled.

```yaml
# Define priority classes for your organization
---
# Critical system components (never preempted)
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: platform-critical
value: 1000000000
globalDefault: false
preemptionPolicy: PreemptLowerPriority
description: "Critical platform infrastructure - never preempt"

---
# High-priority production workloads
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: production-high
value: 100000
globalDefault: false
preemptionPolicy: PreemptLowerPriority
description: "Production critical path workloads"

---
# Standard production workloads
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: production-standard
value: 10000
globalDefault: true
preemptionPolicy: PreemptLowerPriority
description: "Standard production workloads (default)"

---
# Batch and development workloads
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: batch
value: 1000
globalDefault: false
preemptionPolicy: PreemptLowerPriority
description: "Batch jobs and development workloads - may be preempted"

---
# Spot/preemptible workloads
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: spot-best-effort
value: 100
globalDefault: false
preemptionPolicy: Never  # This class never preempts others
description: "Best-effort workloads that accept preemption"
```

### Configuring Preemption Behavior

```yaml
# Pod with priority class and preemption configuration
apiVersion: v1
kind: Pod
metadata:
  name: critical-api-server
spec:
  priorityClassName: production-high
  containers:
  - name: api
    image: myapp:latest
    resources:
      requests:
        cpu: "2"
        memory: "4Gi"
      limits:
        cpu: "4"
        memory: "8Gi"
---
# Batch job that can be preempted
apiVersion: batch/v1
kind: Job
metadata:
  name: data-processing-batch
spec:
  template:
    spec:
      priorityClassName: batch
      restartPolicy: OnFailure
      containers:
      - name: processor
        image: dataprocessor:latest
        resources:
          requests:
            cpu: "8"
            memory: "16Gi"
```

### Monitoring Scheduler Performance

```bash
# Check scheduler metrics
kubectl get --raw /metrics | grep scheduler

# Key metrics:
# scheduler_scheduling_algorithm_duration_seconds - time per scheduling cycle
# scheduler_e2e_scheduling_duration_seconds - end-to-end scheduling latency
# scheduler_pod_scheduling_attempts - number of attempts before scheduling
# scheduler_preemption_attempts_total - preemption events
# scheduler_preemption_victims - pods preempted

# Watch scheduling failures
kubectl get events --field-selector reason=FailedScheduling -A

# Verbose scheduler logs
# Add --v=4 to kube-scheduler for detailed scheduling decisions

# Dashboard: pending pods by priority class
kubectl get pods -A --field-selector=status.phase=Pending \
    -o custom-columns=\
"NS:.metadata.namespace,NAME:.metadata.name,PRIORITY:.spec.priorityClassName,\
NODE:.spec.nodeName,AGE:.metadata.creationTimestamp"
```

## Key Takeaways

The Kubernetes scheduler framework provides multiple extension points that allow precise control over pod placement without maintaining a separate scheduler fork. The right extension mechanism depends on your use case:

1. Scheduler framework plugins are the preferred approach for new custom scheduling logic — they are in-process (no HTTP latency), type-safe, and receive all scheduling context
2. Scheduler extenders work well for existing HTTP-based systems that need to influence scheduling, but add 5-50ms per scheduling cycle in latency
3. DRA should be used for any specialized hardware (GPUs, FPGAs, high-performance NICs) that requires per-device configuration rather than simple resource quantity management
4. Store pre-computed state in `CycleState` during `PreFilter` to avoid redundant computation in `Filter` and `Score` phases — the state is isolated per pod scheduling cycle
5. Implement both `Reserve` and `Unreserve` as a pair — if `Reserve` succeeds and subsequent phases fail, `Unreserve` must exactly undo the reservation to prevent resource leaks
6. Priority classes should be defined at the cluster level before deploying workloads, not per-team — a consistent hierarchy prevents priority inflation where every team marks everything as "critical"
7. The `preemptionPolicy: Never` setting on spot/batch priority classes ensures these workloads never preempt others even if they have higher numerical priority values than expected
8. Test custom scheduler plugins with the scheduler simulation framework (`kube-scheduler-simulator`) before deploying to production to validate scoring behavior across representative node pools
