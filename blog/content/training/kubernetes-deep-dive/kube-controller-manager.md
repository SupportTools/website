---
title: "Deep Dive: Kubernetes Controller Manager"
date: 2025-01-01T00:00:00-05:00
draft: false
tags: ["kubernetes", "controller-manager", "control plane", "controllers"]
categories: ["Kubernetes Deep Dive"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive deep dive into the Kubernetes Controller Manager architecture, controllers, and reconciliation loops"
url: "/training/kubernetes-deep-dive/kube-controller-manager/"
---

The Kubernetes Controller Manager is responsible for running controllers that regulate the state of the cluster. This deep dive explores its architecture, built-in controllers, and how they maintain desired state.

<!--more-->

# [Architecture Overview](#architecture)

## Component Architecture
```plaintext
API Server -> Controller Manager -> Controllers
                               -> Work Queues
                               -> Informers
```

## Key Components
1. **Core Controllers**
   - Node Controller
   - Replication Controller
   - Endpoints Controller
   - Service Account Controller

2. **Informer Pattern**
   - Cache
   - Event Handlers
   - Work Queues

3. **Reconciliation Loops**
   - Observe Current State
   - Compare with Desired State
   - Take Action

# [Core Controllers](#core-controllers)

## 1. Node Controller
```go
// Node controller workflow
type NodeController struct {
    knownNodes    map[string]*v1.Node
    healthyNodes  map[string]*v1.Node
    zonePodEvictor map[string]*RateLimitedTimedQueue
}

func (nc *NodeController) monitorNodeHealth() {
    for node := range nc.knownNodes {
        if !isNodeHealthy(node) {
            nc.markNodeUnhealthy(node)
        }
    }
}
```

## 2. Replication Controller
```go
// Replication controller reconciliation
func (rc *ReplicationController) syncReplicaSet(key string) error {
    namespace, name := cache.SplitMetaNamespaceKey(key)
    rs := rc.getReplicaSet(namespace, name)
    
    currentReplicas := rc.getCurrentReplicas(rs)
    desiredReplicas := rs.Spec.Replicas
    
    if currentReplicas < desiredReplicas {
        rc.createPods(rs, desiredReplicas - currentReplicas)
    } else if currentReplicas > desiredReplicas {
        rc.deletePods(rs, currentReplicas - desiredReplicas)
    }
    return nil
}
```

# [Controller Implementation](#implementation)

## 1. Basic Controller Structure
```go
type Controller struct {
    queue    workqueue.RateLimitingInterface
    informer cache.SharedIndexInformer
    lister   listers.PodLister
}

func (c *Controller) Run(workers int, stopCh <-chan struct{}) {
    defer c.queue.ShutDown()
    
    // Start informer
    go c.informer.Run(stopCh)
    
    // Wait for cache sync
    if !cache.WaitForCacheSync(stopCh, c.informer.HasSynced) {
        return
    }
    
    // Start workers
    for i := 0; i < workers; i++ {
        go wait.Until(c.runWorker, time.Second, stopCh)
    }
    
    <-stopCh
}
```

## 2. Reconciliation Loop
```go
func (c *Controller) reconcile(key string) error {
    // Get object
    obj, exists, err := c.informer.GetIndexer().GetByKey(key)
    if err != nil {
        return err
    }
    
    // Handle deletion
    if !exists {
        return c.handleDeletion(key)
    }
    
    // Handle update/creation
    return c.handleSync(obj)
}
```

# [Controller Configuration](#configuration)

## 1. Controller Settings
```yaml
apiVersion: kubecontroller.config.k8s.io/v1alpha1
kind: KubeControllerManagerConfiguration
controllers:
- "*"
nodeMonitorPeriod: 5s
nodeMonitorGracePeriod: 40s
podEvictionTimeout: 5m
```

## 2. Leader Election
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: kube-controller-manager
  namespace: kube-system
data:
  config.yaml: |
    apiVersion: kubecontroller.config.k8s.io/v1alpha1
    kind: KubeControllerManagerConfiguration
    leaderElection:
      leaderElect: true
      resourceLock: endpoints
      leaseDuration: 15s
      renewDeadline: 10s
      retryPeriod: 2s
```

# [Custom Controllers](#custom-controllers)

## 1. Custom Controller Example
```go
type CustomController struct {
    clientset    kubernetes.Interface
    customLister listers.CustomResourceLister
    customSynced cache.InformerSynced
    workqueue    workqueue.RateLimitingInterface
}

func (c *CustomController) processNextWorkItem() bool {
    obj, shutdown := c.workqueue.Get()
    if shutdown {
        return false
    }
    
    defer c.workqueue.Done(obj)
    
    key, ok := obj.(string)
    if !ok {
        c.workqueue.Forget(obj)
        return true
    }
    
    if err := c.syncHandler(key); err != nil {
        c.workqueue.AddRateLimited(key)
        return true
    }
    
    c.workqueue.Forget(obj)
    return true
}
```

## 2. Custom Resource Definition
```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: customresources.example.com
spec:
  group: example.com
  versions:
    - name: v1
      served: true
      storage: true
  scope: Namespaced
  names:
    plural: customresources
    singular: customresource
    kind: CustomResource
```

# [Performance Tuning](#performance)

## 1. Resource Management
```yaml
apiVersion: v1
kind: Pod
metadata:
  name: kube-controller-manager
  namespace: kube-system
spec:
  containers:
  - name: kube-controller-manager
    resources:
      requests:
        cpu: "200m"
        memory: "512Mi"
      limits:
        cpu: "1"
        memory: "1Gi"
```

## 2. Concurrency Settings
```yaml
apiVersion: kubecontroller.config.k8s.io/v1alpha1
kind: KubeControllerManagerConfiguration
concurrentDeploymentSyncs: 5
concurrentEndpointSyncs: 5
concurrentRCSyncs: 5
concurrentServiceSyncs: 1
```

# [Monitoring and Debugging](#monitoring)

## 1. Metrics Collection
```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: controller-manager
spec:
  endpoints:
  - interval: 30s
    port: https-metrics
    scheme: https
    bearerTokenFile: /var/run/secrets/kubernetes.io/serviceaccount/token
    tlsConfig:
      insecureSkipVerify: true
```

## 2. Controller Logs
```bash
# View controller manager logs
kubectl logs -n kube-system kube-controller-manager-master

# Debug specific controller
kubectl logs -n kube-system kube-controller-manager-master | grep "replication controller"
```

# [Troubleshooting](#troubleshooting)

## Common Issues

1. **Controller Not Reconciling**
```bash
# Check controller manager status
kubectl get pods -n kube-system | grep controller-manager

# View controller logs
kubectl logs -n kube-system kube-controller-manager-master
```

2. **Leader Election Issues**
```bash
# Check leader election status
kubectl get endpoints kube-controller-manager -n kube-system -o yaml

# View election events
kubectl get events -n kube-system | grep "leader election"
```

3. **Resource Synchronization Problems**
```bash
# Check resource status
kubectl describe deployment failing-deployment

# View controller events
kubectl get events --field-selector reason=FailedSync
```

# [Best Practices](#best-practices)

1. **High Availability**
   - Enable leader election
   - Configure proper timeouts
   - Monitor controller health

2. **Performance**
   - Set appropriate concurrency
   - Configure resource limits
   - Use efficient work queues

3. **Monitoring**
   - Track reconciliation loops
   - Monitor resource usage
   - Set up alerting

For more information, check out:
- [API Server Deep Dive](/training/kubernetes-deep-dive/kube-apiserver/)
- [Custom Controllers](/training/kubernetes-deep-dive/custom-controllers/)
- [Resource Management](/training/kubernetes-deep-dive/resource-management/)
