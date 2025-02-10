---
title: "Deep Dive: Kubernetes Scheduler"
date: 2025-01-01T00:00:00-05:00
draft: false
tags: ["kubernetes", "scheduler", "control plane", "pod scheduling"]
categories: ["Kubernetes Deep Dive"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive deep dive into the Kubernetes Scheduler architecture, algorithms, and configuration"
url: "/training/kubernetes-deep-dive/kube-scheduler/"
---

The Kubernetes Scheduler is responsible for assigning pods to nodes based on various constraints and policies. This deep dive explores its architecture, scheduling algorithms, and configuration options.

<!--more-->

# [Architecture Overview](#architecture)

## Component Architecture
```plaintext
API Server -> Scheduler -> Scheduling Queue
                      -> Scheduling Cycle
                      -> Binding Cycle
```

## Key Components
1. **Scheduling Queue**
   - Priority Queue
   - Active/Backoff Queues
   - Event Handlers

2. **Scheduling Cycle**
   - Node Filtering
   - Node Scoring
   - Node Selection

3. **Binding Cycle**
   - Volume Binding
   - Pod Binding
   - Post-Binding

# [Scheduling Process](#scheduling)

## 1. Filtering Phase
```go
// Node filtering example
type FilterPlugin interface {
    Filter(ctx context.Context, state *CycleState, pod *v1.Pod, nodeInfo *NodeInfo) *Status
}

// Example filter plugin
type NodeResourcesFit struct {...}

func (pl *NodeResourcesFit) Filter(ctx context.Context, state *CycleState, pod *v1.Pod, nodeInfo *NodeInfo) *Status {
    if nodeHasEnoughResources(nodeInfo, pod) {
        return nil
    }
    return framework.NewStatus(framework.Unschedulable, "Insufficient resources")
}
```

## 2. Scoring Phase
```go
// Node scoring example
type ScorePlugin interface {
    Score(ctx context.Context, state *CycleState, pod *v1.Pod, nodeName string) (int64, *Status)
}

// Example score plugin
type NodeResourcesBalancedAllocation struct {...}

func (pl *NodeResourcesBalancedAllocation) Score(ctx context.Context, state *CycleState, pod *v1.Pod, nodeName string) (int64, *Status) {
    // Calculate resource balance score
    return calculateBalanceScore(node, pod), nil
}
```

# [Scheduler Configuration](#configuration)

## 1. Scheduler Profiles
```yaml
apiVersion: kubescheduler.config.k8s.io/v1
kind: KubeSchedulerConfiguration
profiles:
- schedulerName: default-scheduler
  plugins:
    score:
      disabled:
      - name: NodeResourcesLeastAllocated
      enabled:
      - name: NodeResourcesMostAllocated
        weight: 1
```

## 2. Custom Scheduler
```yaml
apiVersion: v1
kind: Pod
metadata:
  name: custom-scheduled-pod
spec:
  schedulerName: my-custom-scheduler
  containers:
  - name: container
    image: nginx
```

# [Scheduling Policies](#policies)

## 1. Node Affinity
```yaml
apiVersion: v1
kind: Pod
metadata:
  name: affinity-pod
spec:
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
        - matchExpressions:
          - key: kubernetes.io/e2e-az-name
            operator: In
            values:
            - e2e-az1
            - e2e-az2
```

## 2. Pod Affinity/Anti-Affinity
```yaml
apiVersion: v1
kind: Pod
metadata:
  name: pod-affinity
spec:
  affinity:
    podAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
      - labelSelector:
          matchExpressions:
          - key: security
            operator: In
            values:
            - S1
        topologyKey: topology.kubernetes.io/zone
```

# [Resource Management](#resources)

## 1. Resource Requests and Limits
```yaml
apiVersion: v1
kind: Pod
metadata:
  name: resource-pod
spec:
  containers:
  - name: app
    image: nginx
    resources:
      requests:
        memory: "64Mi"
        cpu: "250m"
      limits:
        memory: "128Mi"
        cpu: "500m"
```

## 2. Priority and Preemption
```yaml
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: high-priority
value: 1000000
globalDefault: false
description: "High priority pods"
```

# [Advanced Scheduling](#advanced)

## 1. Taints and Tolerations
```yaml
# Node taint
kubectl taint nodes node1 key=value:NoSchedule

# Pod toleration
apiVersion: v1
kind: Pod
metadata:
  name: tolerating-pod
spec:
  tolerations:
  - key: "key"
    operator: "Equal"
    value: "value"
    effect: "NoSchedule"
```

## 2. Custom Scheduler Extenders
```yaml
apiVersion: kubescheduler.config.k8s.io/v1
kind: KubeSchedulerConfiguration
extenders:
- urlPrefix: "http://extender.example.com"
  filterVerb: "filter"
  prioritizeVerb: "prioritize"
  weight: 1
  bindVerb: "bind"
  enableHTTPS: true
```

# [Performance Tuning](#performance)

## 1. Scheduler Settings
```yaml
apiVersion: kubescheduler.config.k8s.io/v1
kind: KubeSchedulerConfiguration
percentageOfNodesToScore: 50
profiles:
- schedulerName: default-scheduler
  plugins:
    preFilter:
      enabled:
      - name: NodeResourcesFit
    filter:
      enabled:
      - name: NodeUnschedulable
      - name: NodeResourcesFit
```

## 2. Optimization Techniques
```yaml
# Cache optimization
apiVersion: kubescheduler.config.k8s.io/v1
kind: KubeSchedulerConfiguration
profiles:
- schedulerName: default-scheduler
  plugins:
    preFilter:
      enabled:
      - name: NodeResourcesFit
        weight: 1
  nodeResourcesFitArgs:
    scoringStrategy:
      type: MostAllocated
```

# [Monitoring and Debugging](#monitoring)

## 1. Metrics Collection
```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: scheduler
spec:
  endpoints:
  - interval: 30s
    port: https-metrics
    scheme: https
    bearerTokenFile: /var/run/secrets/kubernetes.io/serviceaccount/token
    tlsConfig:
      insecureSkipVerify: true
```

## 2. Debugging Tools
```bash
# View scheduler logs
kubectl logs -n kube-system kube-scheduler-master

# Check scheduler events
kubectl get events --field-selector reason=FailedScheduling

# Debug scheduling decisions
kubectl get pod pod-name -o yaml | kubectl alpha debug -it --image=busybox
```

# [Troubleshooting](#troubleshooting)

## Common Issues

1. **Pod Pending State**
```bash
# Check scheduler logs
kubectl logs -n kube-system kube-scheduler-master

# View pod events
kubectl describe pod pending-pod
```

2. **Resource Constraints**
```bash
# Check node resources
kubectl describe node node-name

# View resource quotas
kubectl describe quota
```

3. **Affinity/Anti-affinity Issues**
```bash
# Verify node labels
kubectl get nodes --show-labels

# Check pod placement
kubectl get pods -o wide
```

# [Best Practices](#best-practices)

1. **Configuration**
   - Use appropriate scheduler profiles
   - Configure resource quotas
   - Set proper node affinities

2. **Performance**
   - Optimize percentage of nodes to score
   - Use efficient filtering plugins
   - Configure proper priorities

3. **Monitoring**
   - Track scheduling latency
   - Monitor queue depth
   - Set up alerts for failures

For more information, check out:
- [API Server Deep Dive](/training/kubernetes-deep-dive/kube-apiserver/)
- [Resource Management](/training/kubernetes-deep-dive/resource-management/)
- [Node Management](/training/kubernetes-deep-dive/node-management/)
