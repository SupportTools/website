---
title: "Kubernetes Custom Scheduler: Building and Deploying Scheduling Plugins"
date: 2029-01-15T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Scheduler", "Scheduling Framework", "Custom Scheduler", "Plugin Development", "Go"]
categories:
- Kubernetes
- Go
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to building custom Kubernetes scheduler plugins using the scheduling framework, covering Filter, Score, and Reserve extension points, plugin registration, deployment patterns, and production validation."
more_link: "yes"
url: "/kubernetes-custom-scheduler-plugins/"
---

The Kubernetes scheduling framework, introduced in Kubernetes 1.19 and stabilized in 1.22, provides a well-defined plugin API that replaces the previous predicates-and-priorities architecture. Custom scheduling logic is now expressed as plugins implementing specific extension points in the scheduling cycle. This guide covers building production-grade scheduler plugins, from development environment setup through deployment and validation in enterprise clusters.

<!--more-->

## Scheduling Framework Architecture

The scheduling framework defines a scheduling cycle (per-pod, single-threaded) and a binding cycle (concurrent). Plugins register for one or more extension points:

**Scheduling Cycle Extension Points:**
- `PreFilter`: Pre-compute state for subsequent Filter calls
- `Filter`: Determine if a node is eligible (replace "predicates")
- `PostFilter`: Called when no node passes Filter (implement preemption logic)
- `PreScore`: Pre-compute state for Score calls
- `Score`: Rank eligible nodes (replace "priorities")
- `NormalizeScore`: Scale scores to [0, 100]
- `Reserve`: Reserve resources on the selected node
- `Permit`: Gate binding (delay or reject)

**Binding Cycle Extension Points:**
- `PreBind`: Execute before binding (e.g., provision PVs)
- `Bind`: Actually bind the pod to the node
- `PostBind`: Post-bind cleanup

## Development Environment Setup

### Project Structure

```bash
mkdir -p custom-scheduler/{cmd/scheduler,pkg/plugins,config}
cd custom-scheduler

go mod init github.com/corp/custom-scheduler

# Pin to a specific Kubernetes release
go get k8s.io/kubernetes@v1.31.0
go get k8s.io/component-base@v0.31.0
go get k8s.io/kube-scheduler@v0.31.0

# The scheduler plugin API lives in the scheduler package
go get k8s.io/kubernetes/pkg/scheduler/framework@v0.31.0
```

### Plugin Interface Requirements

Every plugin must implement at minimum the `framework.Plugin` interface, which requires a `Name() string` method. Extension point interfaces are implemented as needed.

```go
// pkg/plugins/topology_spread.go
package plugins

import (
    "context"
    "fmt"
    "sync"

    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/runtime"
    "k8s.io/component-base/featuregate"
    "k8s.io/kubernetes/pkg/scheduler/framework"
)

const (
    // PluginName is the name used to register this plugin.
    Name = "CustomRackAwareScheduler"
)

// Args holds the plugin configuration passed via KubeSchedulerProfile.
type Args struct {
    // RackLabel is the node label used to identify rack membership.
    RackLabel string `json:"rackLabel"`
    // MaxPodsPerRack limits how many pods from a deployment land on one rack.
    MaxPodsPerRack int `json:"maxPodsPerRack"`
}

// RackAwarePlugin implements PreFilter and Filter to ensure pods
// spread across physical rack boundaries.
type RackAwarePlugin struct {
    args   *Args
    handle framework.Handle
    mu     sync.Mutex
}

// Verify at compile time that RackAwarePlugin implements the required interfaces.
var _ framework.PreFilterPlugin = &RackAwarePlugin{}
var _ framework.FilterPlugin = &RackAwarePlugin{}
var _ framework.ScorePlugin = &RackAwarePlugin{}

// Name returns the plugin name. Must match the registered name.
func (r *RackAwarePlugin) Name() string {
    return Name
}

// New is the factory function called by the scheduler to instantiate the plugin.
func New(_ context.Context, obj runtime.Object, h framework.Handle) (framework.Plugin, error) {
    args, ok := obj.(*Args)
    if !ok {
        return nil, fmt.Errorf("expected *Args, got %T", obj)
    }

    if args.RackLabel == "" {
        args.RackLabel = "topology.kubernetes.io/rack"
    }
    if args.MaxPodsPerRack <= 0 {
        args.MaxPodsPerRack = 5
    }

    return &RackAwarePlugin{
        args:   args,
        handle: h,
    }, nil
}
```

### PreFilter Extension Point

PreFilter runs once per scheduling cycle and stores state in `CycleState` for reuse by Filter and Score calls.

```go
// stateKey is the key for storing PreFilter state in CycleState.
type stateKey struct{}

// preFilterState holds per-scheduling-cycle state computed in PreFilter.
type preFilterState struct {
    // podDeploymentName is the deployment owning this pod.
    podDeploymentName string
    // rackPodCount maps rack label value → number of pods from this deployment.
    rackPodCount map[string]int
}

func (s *preFilterState) Clone() framework.StateData {
    clone := &preFilterState{
        podDeploymentName: s.podDeploymentName,
        rackPodCount:      make(map[string]int, len(s.rackPodCount)),
    }
    for k, v := range s.rackPodCount {
        clone.rackPodCount[k] = v
    }
    return clone
}

// PreFilter computes the current rack distribution of the pod's deployment siblings.
func (r *RackAwarePlugin) PreFilter(
    ctx context.Context,
    state *framework.CycleState,
    pod *corev1.Pod,
) (*framework.PreFilterResult, *framework.Status) {
    deploymentName := pod.Labels["app.kubernetes.io/name"]
    if deploymentName == "" {
        // Pod has no deployment association; skip rack-aware scheduling
        return nil, framework.NewStatus(framework.Skip)
    }

    // List all pods with the same deployment label
    allPods, err := r.handle.SnapshotSharedLister().NodeInfos().List()
    if err != nil {
        return nil, framework.AsStatus(fmt.Errorf("listing node infos: %w", err))
    }

    rackCount := make(map[string]int)
    for _, nodeInfo := range allPods {
        node := nodeInfo.Node()
        if node == nil {
            continue
        }
        rack := node.Labels[r.args.RackLabel]
        if rack == "" {
            continue
        }

        for _, podInfo := range nodeInfo.Pods {
            if podInfo.Pod.Labels["app.kubernetes.io/name"] == deploymentName &&
                podInfo.Pod.Namespace == pod.Namespace {
                rackCount[rack]++
            }
        }
    }

    state.Write(stateKey{}, &preFilterState{
        podDeploymentName: deploymentName,
        rackPodCount:      rackCount,
    })

    return nil, nil
}

// PreFilterExtensions returns nil (no add/remove node extensions needed).
func (r *RackAwarePlugin) PreFilterExtensions() framework.PreFilterExtensions {
    return nil
}
```

### Filter Extension Point

```go
// Filter returns Unschedulable if placing the pod on this node would
// exceed MaxPodsPerRack for the pod's deployment.
func (r *RackAwarePlugin) Filter(
    ctx context.Context,
    state *framework.CycleState,
    pod *corev1.Pod,
    nodeInfo *framework.NodeInfo,
) *framework.Status {
    data, err := state.Read(stateKey{})
    if err != nil {
        // No state means PreFilter skipped this pod (no deployment label)
        return nil
    }

    s := data.(*preFilterState)
    node := nodeInfo.Node()
    if node == nil {
        return framework.NewStatus(framework.Error, "node not found in node info")
    }

    rack := node.Labels[r.args.RackLabel]
    if rack == "" {
        // Node has no rack label; do not restrict placement
        return nil
    }

    currentCount := s.rackPodCount[rack]
    if currentCount >= r.args.MaxPodsPerRack {
        return framework.NewStatus(
            framework.Unschedulable,
            fmt.Sprintf("rack %q already has %d/%d pods from deployment %q",
                rack, currentCount, r.args.MaxPodsPerRack, s.podDeploymentName),
        )
    }

    return nil
}
```

### Score Extension Point

```go
const (
    // maxScore is the maximum score a node can receive.
    maxScore int64 = 100
)

// Score ranks nodes by their current rack utilization — prefer racks
// with fewer pods from this deployment.
func (r *RackAwarePlugin) Score(
    ctx context.Context,
    state *framework.CycleState,
    pod *corev1.Pod,
    nodeName string,
) (int64, *framework.Status) {
    data, err := state.Read(stateKey{})
    if err != nil {
        return 0, nil
    }

    s := data.(*preFilterState)
    nodeInfo, err := r.handle.SnapshotSharedLister().NodeInfos().Get(nodeName)
    if err != nil {
        return 0, framework.AsStatus(fmt.Errorf("getting node %s: %w", nodeName, err))
    }

    node := nodeInfo.Node()
    rack := node.Labels[r.args.RackLabel]
    if rack == "" {
        return maxScore / 2, nil // Neutral score for rack-less nodes
    }

    currentCount := s.rackPodCount[rack]
    if r.args.MaxPodsPerRack == 0 {
        return maxScore, nil
    }

    // Invert utilization: fuller racks score lower
    utilization := float64(currentCount) / float64(r.args.MaxPodsPerRack)
    score := int64(float64(maxScore) * (1.0 - utilization))
    if score < 0 {
        score = 0
    }
    return score, nil
}

// ScoreExtensions returns nil (no NormalizeScore implementation needed;
// scores are already in [0, 100]).
func (r *RackAwarePlugin) ScoreExtensions() framework.ScoreExtensions {
    return nil
}
```

## Scheduler Binary with Plugin Registration

```go
// cmd/scheduler/main.go
package main

import (
    "os"

    "k8s.io/component-base/cli"
    "k8s.io/kubernetes/cmd/kube-scheduler/app"
    "k8s.io/kubernetes/pkg/scheduler/framework"

    "github.com/corp/custom-scheduler/pkg/plugins"
)

func main() {
    // OutOfTreeRegistry maps plugin names to their factory functions.
    // These plugins are registered alongside the default scheduler plugins.
    outOfTreeRegistry := map[string]app.RegistryFunc{
        plugins.Name: func(ctx context.Context, obj runtime.Object, h framework.Handle) (framework.Plugin, error) {
            return plugins.New(ctx, obj, h)
        },
    }

    command := app.NewSchedulerCommand(
        app.WithPlugin(plugins.Name, plugins.New),
    )

    code := cli.Run(command)
    os.Exit(code)
}
```

## Scheduler Configuration

The scheduler is configured via a `KubeSchedulerConfiguration` file that specifies which plugins are enabled and their arguments.

```yaml
# config/scheduler-config.yaml
apiVersion: kubescheduler.config.k8s.io/v1
kind: KubeSchedulerConfiguration
leaderElection:
  leaderElect: true
  resourceNamespace: kube-system
  resourceName: custom-scheduler-lock
profiles:
  - schedulerName: custom-scheduler  # Pods request this with schedulerName field
    plugins:
      preFilter:
        enabled:
          - name: CustomRackAwareScheduler
      filter:
        enabled:
          - name: CustomRackAwareScheduler
      score:
        enabled:
          - name: CustomRackAwareScheduler
            weight: 2          # Double weight relative to default plugins
      # Keep all default plugins enabled unless explicitly disabling
      multiPoint:
        enabled:
          - name: DefaultPreemption
          - name: NodeResourcesFit
          - name: NodeName
          - name: NodePorts
          - name: NodeAffinity
          - name: VolumeBinding
          - name: TaintToleration
          - name: InterPodAffinity
          - name: PodTopologySpread
    pluginConfig:
      - name: CustomRackAwareScheduler
        args:
          rackLabel: topology.kubernetes.io/rack
          maxPodsPerRack: 8
  - schedulerName: default-scheduler  # Also run as default scheduler
    plugins:
      multiPoint:
        enabled:
          - name: DefaultPreemption
          - name: NodeResourcesFit
clientConnection:
  acceptContentTypes: ""
  burst: 100
  contentType: application/vnd.kubernetes.protobuf
  kubeconfig: ""
  qps: 50
```

## Deployment Manifests

```yaml
# deploy/custom-scheduler.yaml
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: custom-scheduler
  namespace: kube-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: custom-scheduler-as-kube-scheduler
subjects:
  - kind: ServiceAccount
    name: custom-scheduler
    namespace: kube-system
roleRef:
  kind: ClusterRole
  name: system:kube-scheduler
  apiGroup: rbac.authorization.k8s.io
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: custom-scheduler-volume-scheduler
subjects:
  - kind: ServiceAccount
    name: custom-scheduler
    namespace: kube-system
roleRef:
  kind: ClusterRole
  name: system:volume-scheduler
  apiGroup: rbac.authorization.k8s.io
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
      resourceName: custom-scheduler-lock
    profiles:
      - schedulerName: custom-scheduler
        plugins:
          preFilter:
            enabled:
              - name: CustomRackAwareScheduler
          filter:
            enabled:
              - name: CustomRackAwareScheduler
          score:
            enabled:
              - name: CustomRackAwareScheduler
                weight: 2
        pluginConfig:
          - name: CustomRackAwareScheduler
            args:
              rackLabel: topology.kubernetes.io/rack
              maxPodsPerRack: 8
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: custom-scheduler
  namespace: kube-system
  labels:
    component: custom-scheduler
spec:
  replicas: 2
  selector:
    matchLabels:
      component: custom-scheduler
  template:
    metadata:
      labels:
        component: custom-scheduler
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "10251"
        prometheus.io/path: "/metrics"
    spec:
      serviceAccountName: custom-scheduler
      priorityClassName: system-cluster-critical
      nodeSelector:
        node-role.kubernetes.io/control-plane: ""
      tolerations:
        - key: node-role.kubernetes.io/control-plane
          operator: Exists
          effect: NoSchedule
      containers:
        - name: custom-scheduler
          image: registry.corp.example.com/custom-scheduler:v1.31.0-rack-aware-1.2.0
          command:
            - /custom-scheduler
            - --config=/etc/kubernetes/scheduler-config.yaml
            - --v=2
          ports:
            - containerPort: 10251
              name: http
            - containerPort: 10259
              name: https
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
            periodSeconds: 20
            failureThreshold: 3
          readinessProbe:
            httpGet:
              path: /healthz
              port: 10259
              scheme: HTTPS
            initialDelaySeconds: 5
            periodSeconds: 10
          volumeMounts:
            - name: config
              mountPath: /etc/kubernetes
            - name: kubeconfig
              mountPath: /etc/scheduler-kubeconfig
          securityContext:
            runAsNonRoot: true
            runAsUser: 65532
            readOnlyRootFilesystem: true
            allowPrivilegeEscalation: false
            seccompProfile:
              type: RuntimeDefault
            capabilities:
              drop: ["ALL"]
      volumes:
        - name: config
          configMap:
            name: custom-scheduler-config
        - name: kubeconfig
          secret:
            secretName: custom-scheduler-kubeconfig
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              component: custom-scheduler
```

## Using the Custom Scheduler

Pods opt into the custom scheduler by setting `spec.schedulerName`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-api
  namespace: production
spec:
  replicas: 12
  selector:
    matchLabels:
      app.kubernetes.io/name: payment-api
  template:
    metadata:
      labels:
        app.kubernetes.io/name: payment-api
    spec:
      schedulerName: custom-scheduler    # Request custom scheduler
      containers:
        - name: payment-api
          image: registry.corp.example.com/payment-api:v3.2.1
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: 2000m
              memory: 2Gi
```

## Testing and Validation

### Unit Testing Plugins

```go
// pkg/plugins/topology_spread_test.go
package plugins

import (
    "context"
    "testing"

    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/kubernetes/pkg/scheduler/framework"
    "k8s.io/kubernetes/pkg/scheduler/framework/fake"
)

func TestRackAwareFilter(t *testing.T) {
    tests := []struct {
        name           string
        pod            *corev1.Pod
        node           *corev1.Node
        existingPods   []*corev1.Pod
        maxPodsPerRack int
        wantStatus     *framework.Status
    }{
        {
            name: "node under rack limit - allow",
            pod:  podWithLabel("payment-api", "production"),
            node: nodeWithRack("node-01", "rack-a"),
            existingPods: []*corev1.Pod{
                podOnNodeWithLabel("payment-api", "node-02", "production"),
            },
            maxPodsPerRack: 3,
            wantStatus:     nil,
        },
        {
            name: "node at rack limit - deny",
            pod:  podWithLabel("payment-api", "production"),
            node: nodeWithRack("node-03", "rack-a"),
            existingPods: []*corev1.Pod{
                podOnNodeWithLabel("payment-api", "node-01", "production"),
                podOnNodeWithLabel("payment-api", "node-02", "production"),
                podOnNodeWithLabel("payment-api", "node-03", "production"),
            },
            maxPodsPerRack: 3,
            wantStatus:     framework.NewStatus(framework.Unschedulable),
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            // Build fake scheduler state
            snapshot := fake.NewSnapshot(tt.existingPods, []*corev1.Node{tt.node})
            fakeHandle := fake.NewFrameworkHandle(snapshot)

            plugin, err := New(context.Background(), &Args{
                RackLabel:      "topology.kubernetes.io/rack",
                MaxPodsPerRack: tt.maxPodsPerRack,
            }, fakeHandle)
            if err != nil {
                t.Fatalf("creating plugin: %v", err)
            }

            rackPlugin := plugin.(*RackAwarePlugin)
            state := framework.NewCycleState()

            // Run PreFilter to populate state
            _, status := rackPlugin.PreFilter(context.Background(), state, tt.pod)
            if !status.IsSuccess() && status.Code() != framework.Skip {
                t.Fatalf("PreFilter failed: %v", status)
            }

            // Run Filter
            nodeInfo := framework.NewNodeInfo()
            nodeInfo.SetNode(tt.node)
            for _, p := range tt.existingPods {
                nodeInfo.AddPod(p)
            }

            gotStatus := rackPlugin.Filter(context.Background(), state, tt.pod, nodeInfo)
            if tt.wantStatus == nil {
                if !gotStatus.IsSuccess() {
                    t.Errorf("expected success, got %v", gotStatus)
                }
            } else {
                if gotStatus.Code() != tt.wantStatus.Code() {
                    t.Errorf("expected status code %v, got %v", tt.wantStatus.Code(), gotStatus.Code())
                }
            }
        })
    }
}

func podWithLabel(appName, namespace string) *corev1.Pod {
    return &corev1.Pod{
        ObjectMeta: metav1.ObjectMeta{
            Name:      appName + "-new",
            Namespace: namespace,
            Labels:    map[string]string{"app.kubernetes.io/name": appName},
        },
    }
}

func nodeWithRack(name, rack string) *corev1.Node {
    return &corev1.Node{
        ObjectMeta: metav1.ObjectMeta{
            Name:   name,
            Labels: map[string]string{"topology.kubernetes.io/rack": rack},
        },
    }
}

func podOnNodeWithLabel(appName, nodeName, namespace string) *corev1.Pod {
    return &corev1.Pod{
        ObjectMeta: metav1.ObjectMeta{
            Name:      appName + "-" + nodeName,
            Namespace: namespace,
            Labels:    map[string]string{"app.kubernetes.io/name": appName},
        },
        Spec: corev1.PodSpec{NodeName: nodeName},
        Status: corev1.PodStatus{Phase: corev1.PodRunning},
    }
}
```

### Integration Validation

```bash
# Verify the custom scheduler is running and leading
kubectl get lease custom-scheduler-lock -n kube-system
kubectl logs -n kube-system deploy/custom-scheduler | grep "Attempting to acquire leader lease"

# Check scheduler events for a pod
kubectl describe pod payment-api-abc12 -n production | grep -A 5 "Events:"
# Events:
#   Type    Reason     Age   From              Message
#   ----    ------     ----  ----              -------
#   Normal  Scheduled  10s   custom-scheduler  Successfully assigned production/payment-api-abc12 to node-07

# Verify rack distribution of payment-api pods
kubectl get pods -n production -l app.kubernetes.io/name=payment-api \
  -o jsonpath='{range .items[*]}{.spec.nodeName}{"\n"}{end}' | \
  xargs -I{} kubectl get node {} -o jsonpath='{.metadata.labels.topology\.kubernetes\.io/rack}{"\n"}' | \
  sort | uniq -c | sort -rn
# 4 rack-c
# 4 rack-b
# 4 rack-a

# Check scheduling framework metrics
kubectl port-forward -n kube-system svc/custom-scheduler 10259:10259
curl -sk https://localhost:10259/metrics | grep -E 'scheduler_plugin|scheduler_framework'
# scheduler_framework_extension_point_duration_seconds{extension_point="Filter",plugin="CustomRackAwareScheduler",status="Success"}
# scheduler_framework_extension_point_duration_seconds{extension_point="Score",plugin="CustomRackAwareScheduler",status="Success"}
```

## Monitoring Custom Scheduler Plugins

```yaml
# prometheus/rules/custom-scheduler.yaml
groups:
  - name: custom_scheduler
    rules:
      - alert: CustomSchedulerPluginHighLatency
        expr: |
          histogram_quantile(0.99,
            rate(scheduler_framework_extension_point_duration_seconds_bucket{
              plugin="CustomRackAwareScheduler"
            }[5m])
          ) > 0.010
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Custom scheduler plugin p99 latency > 10ms"
          description: >
            The CustomRackAwareScheduler plugin is taking {{ $value }}s at p99.
            This will slow down pod scheduling for all pods using custom-scheduler.

      - alert: CustomSchedulerPendingPods
        expr: |
          scheduler_pending_pods{scheduler="custom-scheduler"} > 20
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Pods pending in custom-scheduler queue"
          description: >
            {{ $value }} pods are stuck in the custom-scheduler pending queue.
```

## Summary

The Kubernetes scheduling framework provides a clean, testable API for implementing custom scheduling logic without forking the scheduler binary. Key production considerations:

- Run the custom scheduler as a separate deployment alongside the default scheduler; do not replace it
- Implement `PreFilter` to cache expensive per-cycle computations; `Filter` and `Score` are called once per eligible node and must be fast (< 1ms each)
- Use `framework.CycleState` for per-scheduling-cycle state sharing between extension points — never use global state
- Test plugins with the framework's fake handles to avoid requiring a real cluster for unit tests
- Monitor `scheduler_framework_extension_point_duration_seconds` to catch plugins that introduce scheduling latency
- Use `schedulerName` in Pod specs to opt in explicitly; avoid using the custom scheduler as the default unless intentional
