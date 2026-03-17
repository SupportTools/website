---
title: "Go Kubernetes Client Production Patterns: client-go Deep Dive"
date: 2027-12-12T00:00:00-05:00
draft: false
tags: ["Go", "Kubernetes", "client-go", "Operators", "Informers", "Programming", "DevOps"]
categories:
- Go
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Production patterns for the Go Kubernetes client-go library: Informers, SharedInformerFactory, WorkQueue, dynamic client, server-side apply, rate limiting, leader election, and fake client testing."
more_link: "yes"
url: "/go-kubernetes-client-production-patterns-guide/"
---

The `client-go` library is the foundation of every Kubernetes operator, controller, and CLI tool written in Go. Using it correctly requires understanding the full machinery: Informers for efficient watch-based state management, WorkQueues for reliable reconciliation, the dynamic client for runtime type handling, and server-side apply for conflict-free updates. This guide covers production-grade patterns for each component with working code examples drawn from real operator implementations.

<!--more-->

# Go Kubernetes Client Production Patterns: client-go Deep Dive

## Client Construction

### In-Cluster Configuration

```go
package main

import (
    "fmt"
    "os"

    "k8s.io/client-go/kubernetes"
    "k8s.io/client-go/rest"
    "k8s.io/client-go/tools/clientcmd"
)

// NewClient creates a Kubernetes client supporting both in-cluster
// and out-of-cluster configurations.
func NewClient() (*kubernetes.Clientset, error) {
    config, err := rest.InClusterConfig()
    if err != nil {
        // Fall back to kubeconfig for local development
        kubeconfig := os.Getenv("KUBECONFIG")
        if kubeconfig == "" {
            home, _ := os.UserHomeDir()
            kubeconfig = home + "/.kube/config"
        }
        config, err = clientcmd.BuildConfigFromFlags("", kubeconfig)
        if err != nil {
            return nil, fmt.Errorf("building kubeconfig: %w", err)
        }
    }

    // Configure rate limiting for production
    config.QPS = 50
    config.Burst = 100
    config.Timeout = 30 * time.Second

    client, err := kubernetes.NewForConfig(config)
    if err != nil {
        return nil, fmt.Errorf("creating kubernetes client: %w", err)
    }
    return client, nil
}
```

### Rate Limiting Configuration

The default client rate limits are often too low for controllers managing many resources. Configure based on cluster size:

```go
import (
    "k8s.io/client-go/rest"
    "k8s.io/client-go/util/flowcontrol"
)

func newRateLimitedConfig(baseConfig *rest.Config) *rest.Config {
    config := rest.CopyConfig(baseConfig)

    // For small clusters (< 100 nodes)
    config.QPS = 50
    config.Burst = 100

    // For large clusters (> 500 nodes), increase significantly
    // config.QPS = 200
    // config.Burst = 400

    // Use token bucket rate limiter
    config.RateLimiter = flowcontrol.NewTokenBucketRateLimiter(
        float32(config.QPS),
        int(config.Burst),
    )

    return config
}
```

## Informers and SharedInformerFactory

Informers are the correct way to watch Kubernetes resources. They maintain a local cache (backed by an indexed store), register event handlers, and handle reconnection automatically. Direct list/watch calls without informers will overwhelm the API server at scale.

### SharedInformerFactory

```go
package controller

import (
    "context"
    "fmt"
    "time"

    corev1 "k8s.io/api/core/v1"
    appsv1 "k8s.io/api/apps/v1"
    "k8s.io/apimachinery/pkg/api/errors"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/labels"
    "k8s.io/client-go/informers"
    "k8s.io/client-go/kubernetes"
    listerscorev1 "k8s.io/client-go/listers/core/v1"
    listersappsv1 "k8s.io/client-go/listers/apps/v1"
    "k8s.io/client-go/tools/cache"
    "k8s.io/client-go/util/workqueue"
    "k8s.io/klog/v2"
)

type Controller struct {
    client          kubernetes.Interface
    deploymentLister listersappsv1.DeploymentLister
    deploymentSynced cache.InformerSynced
    podLister       listerscorev1.PodLister
    podSynced       cache.InformerSynced
    queue           workqueue.RateLimitingInterface
}

func NewController(
    client kubernetes.Interface,
    factory informers.SharedInformerFactory,
) *Controller {
    deploymentInformer := factory.Apps().V1().Deployments()
    podInformer := factory.Core().V1().Pods()

    c := &Controller{
        client:           client,
        deploymentLister: deploymentInformer.Lister(),
        deploymentSynced: deploymentInformer.Informer().HasSynced,
        podLister:        podInformer.Lister(),
        podSynced:        podInformer.Informer().HasSynced,
        queue: workqueue.NewNamedRateLimitingQueue(
            workqueue.DefaultControllerRateLimiter(),
            "deployments",
        ),
    }

    // Register event handlers
    deploymentInformer.Informer().AddEventHandler(cache.ResourceEventHandlerFuncs{
        AddFunc: c.enqueueDeployment,
        UpdateFunc: func(old, new interface{}) {
            c.enqueueDeployment(new)
        },
        DeleteFunc: c.enqueueDeployment,
    })

    return c
}

func (c *Controller) enqueueDeployment(obj interface{}) {
    key, err := cache.DeletionHandlingMetaNamespaceKeyFunc(obj)
    if err != nil {
        klog.ErrorS(err, "Error getting key for object", "object", obj)
        return
    }
    c.queue.Add(key)
}

func (c *Controller) Run(ctx context.Context, workers int) error {
    defer c.queue.ShutDown()

    // Wait for caches to sync before starting workers
    klog.Info("Waiting for informer caches to sync")
    if !cache.WaitForCacheSync(ctx.Done(), c.deploymentSynced, c.podSynced) {
        return fmt.Errorf("timed out waiting for caches to sync")
    }
    klog.Info("Caches synced, starting workers")

    for i := 0; i < workers; i++ {
        go func() {
            for c.processNextItem(ctx) {
            }
        }()
    }

    <-ctx.Done()
    return nil
}
```

### WorkQueue Pattern

The WorkQueue is the reconciliation engine. It handles:
- Deduplication (multiple updates to the same object trigger one reconcile)
- Rate limiting with exponential backoff on failure
- Ordered processing with concurrency control

```go
func (c *Controller) processNextItem(ctx context.Context) bool {
    // Get next item - blocks until item available or queue shut down
    key, quit := c.queue.Get()
    if quit {
        return false
    }
    defer c.queue.Done(key)

    err := c.reconcile(ctx, key.(string))
    if err == nil {
        // Success: reset failure count
        c.queue.Forget(key)
        return true
    }

    // Error handling with rate limiting
    if c.queue.NumRequeues(key) < 5 {
        klog.ErrorS(err, "Error reconciling key, retrying", "key", key)
        // Re-queue with exponential backoff
        c.queue.AddRateLimited(key)
        return true
    }

    // Max retries exceeded: drop and log
    klog.ErrorS(err, "Dropping key after max retries", "key", key)
    c.queue.Forget(key)
    return true
}

func (c *Controller) reconcile(ctx context.Context, key string) error {
    namespace, name, err := cache.SplitMetaNamespaceKey(key)
    if err != nil {
        return fmt.Errorf("invalid key %q: %w", key, err)
    }

    deployment, err := c.deploymentLister.Deployments(namespace).Get(name)
    if errors.IsNotFound(err) {
        // Object deleted - clean up
        klog.InfoS("Deployment deleted, cleaning up", "name", name, "namespace", namespace)
        return nil
    }
    if err != nil {
        return fmt.Errorf("getting deployment %s/%s: %w", namespace, name, err)
    }

    // Reconcile logic here
    return c.ensureResources(ctx, deployment)
}
```

## FieldSelector and LabelSelector Optimization

Fetching all resources and filtering in memory is an anti-pattern. Use server-side filtering to reduce API server load and network transfer.

```go
import (
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/labels"
    "k8s.io/apimachinery/pkg/fields"
)

// ListPodsOnNode fetches only pods scheduled on a specific node.
// Without fieldSelector, this would return ALL pods cluster-wide.
func ListPodsOnNode(ctx context.Context, client kubernetes.Interface, nodeName string) ([]*corev1.Pod, error) {
    selector := fields.OneTermEqualSelector("spec.nodeName", nodeName)

    pods, err := client.CoreV1().Pods("").List(ctx, metav1.ListOptions{
        FieldSelector: selector.String(),
        Limit:         500,
    })
    if err != nil {
        return nil, fmt.Errorf("listing pods on node %s: %w", nodeName, err)
    }

    result := make([]*corev1.Pod, len(pods.Items))
    for i := range pods.Items {
        result[i] = &pods.Items[i]
    }
    return result, nil
}

// ListDeploymentsByLabel uses label selectors to filter at the API server.
func ListDeploymentsByLabel(
    ctx context.Context,
    client kubernetes.Interface,
    namespace string,
    labelRequirements map[string]string,
) ([]*appsv1.Deployment, error) {
    set := labels.Set(labelRequirements)
    selector := labels.SelectorFromSet(set)

    deployments, err := client.AppsV1().Deployments(namespace).List(ctx, metav1.ListOptions{
        LabelSelector: selector.String(),
    })
    if err != nil {
        return nil, fmt.Errorf("listing deployments: %w", err)
    }

    result := make([]*appsv1.Deployment, len(deployments.Items))
    for i := range deployments.Items {
        result[i] = &deployments.Items[i]
    }
    return result, nil
}
```

### Informer with Field Selectors

Use `NewFilteredSharedInformerFactory` to scope informers to specific labels or fields:

```go
import (
    "k8s.io/apimachinery/pkg/fields"
    "k8s.io/client-go/informers"
)

// Create informer watching only pods on the current node
nodeName := os.Getenv("MY_NODE_NAME")  // Injected via downward API

factory := informers.NewFilteredSharedInformerFactory(
    client,
    30*time.Second,
    "",  // All namespaces
    func(opts *metav1.ListOptions) {
        opts.FieldSelector = fields.OneTermEqualSelector(
            "spec.nodeName", nodeName,
        ).String()
    },
)
```

## Dynamic Client

The dynamic client operates on `unstructured.Unstructured` objects, enabling interaction with custom resources or resources where the Go type is not available at compile time.

```go
import (
    "k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
    "k8s.io/apimachinery/pkg/runtime/schema"
    "k8s.io/client-go/dynamic"
    "k8s.io/client-go/dynamic/dynamicinformer"
)

// GetCustomResource retrieves a custom resource using the dynamic client.
func GetCustomResource(
    ctx context.Context,
    dynClient dynamic.Interface,
    namespace, name string,
) (*unstructured.Unstructured, error) {
    gvr := schema.GroupVersionResource{
        Group:    "example.com",
        Version:  "v1alpha1",
        Resource: "myresources",
    }

    obj, err := dynClient.Resource(gvr).Namespace(namespace).Get(ctx, name, metav1.GetOptions{})
    if err != nil {
        return nil, fmt.Errorf("getting MyResource %s/%s: %w", namespace, name, err)
    }
    return obj, nil
}

// UpdateCustomResourceStatus updates a custom resource's status subresource.
func UpdateCustomResourceStatus(
    ctx context.Context,
    dynClient dynamic.Interface,
    obj *unstructured.Unstructured,
    statusFields map[string]interface{},
) error {
    gvr := schema.GroupVersionResource{
        Group:    "example.com",
        Version:  "v1alpha1",
        Resource: "myresources",
    }

    // Update status fields
    status := map[string]interface{}{}
    for k, v := range statusFields {
        status[k] = v
    }

    existing, _ := obj.Object["status"].(map[string]interface{})
    if existing == nil {
        existing = map[string]interface{}{}
    }
    for k, v := range status {
        existing[k] = v
    }
    obj.Object["status"] = existing

    _, err := dynClient.Resource(gvr).Namespace(obj.GetNamespace()).
        UpdateStatus(ctx, obj, metav1.UpdateOptions{})
    if err != nil {
        return fmt.Errorf("updating status for %s/%s: %w",
            obj.GetNamespace(), obj.GetName(), err)
    }
    return nil
}
```

## Server-Side Apply

Server-Side Apply (SSA) is the preferred update mechanism for controllers. Unlike client-side apply, SSA tracks field ownership server-side, preventing conflicts between multiple controllers managing the same object.

```go
import (
    "encoding/json"

    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/types"
    corev1 "k8s.io/api/core/v1"
    appsv1 "k8s.io/api/apps/v1"
)

// ApplyDeployment applies a Deployment using server-side apply.
// The fieldManager identifies this controller as the owner of the fields it sets.
func ApplyDeployment(
    ctx context.Context,
    client kubernetes.Interface,
    deployment *appsv1.Deployment,
    fieldManager string,
) error {
    data, err := json.Marshal(deployment)
    if err != nil {
        return fmt.Errorf("marshaling deployment: %w", err)
    }

    _, err = client.AppsV1().Deployments(deployment.Namespace).
        Patch(ctx, deployment.Name, types.ApplyPatchType, data, metav1.PatchOptions{
            FieldManager: fieldManager,
            Force:        boolPtr(true), // Force apply takes ownership of conflicting fields
        })
    if err != nil {
        return fmt.Errorf("applying deployment %s/%s: %w",
            deployment.Namespace, deployment.Name, err)
    }
    return nil
}

func boolPtr(b bool) *bool { return &b }
```

### SSA with Strategic Merge Patch

For partial updates that should not affect other fields:

```go
// PatchDeploymentReplicas updates only the replica count without affecting other fields.
func PatchDeploymentReplicas(
    ctx context.Context,
    client kubernetes.Interface,
    namespace, name string,
    replicas int32,
) error {
    patch := []byte(fmt.Sprintf(
        `{"spec":{"replicas":%d}}`,
        replicas,
    ))

    _, err := client.AppsV1().Deployments(namespace).
        Patch(ctx, name, types.MergePatchType, patch, metav1.PatchOptions{})
    if err != nil {
        return fmt.Errorf("patching replicas for %s/%s: %w", namespace, name, err)
    }
    return nil
}
```

### JSON Patch for Precise Field Updates

```go
import "k8s.io/apimachinery/pkg/util/json"

type JSONPatchOp struct {
    Op    string      `json:"op"`
    Path  string      `json:"path"`
    Value interface{} `json:"value,omitempty"`
}

// AddAnnotation adds or updates a single annotation without affecting others.
func AddAnnotation(
    ctx context.Context,
    client kubernetes.Interface,
    namespace, name, key, value string,
) error {
    // JSON Patch requires escaping / in keys
    escapedKey := strings.ReplaceAll(key, "/", "~1")

    ops := []JSONPatchOp{
        {
            Op:    "add",
            Path:  "/metadata/annotations/" + escapedKey,
            Value: value,
        },
    }

    data, err := json.Marshal(ops)
    if err != nil {
        return err
    }

    _, err = client.CoreV1().Pods(namespace).
        Patch(ctx, name, types.JSONPatchType, data, metav1.PatchOptions{})
    return err
}
```

## Leader Election

Controllers that run multiple replicas for high availability require leader election. Only the leader reconciles; followers are on standby.

```go
import (
    "os"

    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/client-go/tools/leaderelection"
    "k8s.io/client-go/tools/leaderelection/resourcelock"
)

func RunWithLeaderElection(ctx context.Context, client kubernetes.Interface, runFunc func(ctx context.Context)) {
    id, err := os.Hostname()
    if err != nil {
        klog.Fatal(err)
    }
    // Add random suffix to avoid split-brain if hostname changes
    id = id + "_" + string(uuid.NewUUID())

    lock := &resourcelock.LeaseLock{
        LeaseMeta: metav1.ObjectMeta{
            Name:      "my-controller-leader",
            Namespace: "kube-system",
        },
        Client: client.CoordinationV1(),
        LockConfig: resourcelock.ResourceLockConfig{
            Identity: id,
        },
    }

    leaderelection.RunOrDie(ctx, leaderelection.LeaderElectionConfig{
        Lock:            lock,
        ReleaseOnCancel: true,
        LeaseDuration:   15 * time.Second,
        RenewDeadline:   10 * time.Second,
        RetryPeriod:     2 * time.Second,
        Callbacks: leaderelection.LeaderCallbacks{
            OnStartedLeading: func(ctx context.Context) {
                klog.InfoS("Started leading", "id", id)
                runFunc(ctx)
            },
            OnStoppedLeading: func() {
                klog.InfoS("Stopped leading", "id", id)
                os.Exit(0)
            },
            OnNewLeader: func(identity string) {
                if identity == id {
                    return
                }
                klog.InfoS("New leader elected", "leader", identity)
            },
        },
    })
}
```

## Fake Client for Testing

The `k8s.io/client-go/kubernetes/fake` package provides an in-memory client for unit tests without requiring a real cluster.

```go
package controller_test

import (
    "context"
    "testing"

    appsv1 "k8s.io/api/apps/v1"
    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime"
    "k8s.io/client-go/informers"
    fakekubernetes "k8s.io/client-go/kubernetes/fake"
    "k8s.io/client-go/tools/cache"
)

func TestControllerReconcile(t *testing.T) {
    // Create initial objects
    deployment := &appsv1.Deployment{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "test-deployment",
            Namespace: "default",
            Labels: map[string]string{
                "app": "test",
            },
        },
        Spec: appsv1.DeploymentSpec{
            Replicas: int32Ptr(3),
            Selector: &metav1.LabelSelector{
                MatchLabels: map[string]string{"app": "test"},
            },
            Template: corev1.PodTemplateSpec{
                ObjectMeta: metav1.ObjectMeta{
                    Labels: map[string]string{"app": "test"},
                },
                Spec: corev1.PodSpec{
                    Containers: []corev1.Container{
                        {
                            Name:  "app",
                            Image: "nginx:latest",
                        },
                    },
                },
            },
        },
    }

    // Create fake client with initial objects
    fakeClient := fakekubernetes.NewSimpleClientset(deployment)

    // Create informer factory
    factory := informers.NewSharedInformerFactory(fakeClient, 0)
    controller := NewController(fakeClient, factory)

    // Start informers
    ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
    defer cancel()

    factory.Start(ctx.Done())

    // Wait for cache sync
    if !cache.WaitForCacheSync(ctx.Done(), controller.deploymentSynced) {
        t.Fatal("caches did not sync")
    }

    // Trigger reconcile
    err := controller.reconcile(ctx, "default/test-deployment")
    if err != nil {
        t.Fatalf("reconcile failed: %v", err)
    }

    // Verify expected state
    result, err := fakeClient.AppsV1().Deployments("default").
        Get(ctx, "test-deployment", metav1.GetOptions{})
    if err != nil {
        t.Fatalf("getting deployment: %v", err)
    }

    if *result.Spec.Replicas != 3 {
        t.Errorf("expected 3 replicas, got %d", *result.Spec.Replicas)
    }
}

func int32Ptr(i int32) *int32 { return &i }
```

### Testing with Reactor Functions

Fake clients support reactors for simulating API server errors:

```go
func TestControllerHandlesAPIError(t *testing.T) {
    fakeClient := fakekubernetes.NewSimpleClientset()

    // Inject error for Get operations on Deployments
    fakeClient.PrependReactor("get", "deployments",
        func(action k8stesting.Action) (bool, runtime.Object, error) {
            return true, nil, errors.NewInternalError(fmt.Errorf("simulated API server error"))
        },
    )

    factory := informers.NewSharedInformerFactory(fakeClient, 0)
    controller := NewController(fakeClient, factory)

    ctx := context.Background()
    err := controller.reconcile(ctx, "default/test-deployment")

    // Verify error is handled correctly
    if err == nil {
        t.Fatal("expected error, got nil")
    }
}
```

## Custom Informer Indexers

Index informer caches for O(1) lookups instead of O(n) list + filter:

```go
import "k8s.io/client-go/tools/cache"

const podByNodeIndex = "pod-by-node"
const podByServiceAccountIndex = "pod-by-service-account"

func addPodIndexers(informer cache.SharedIndexInformer) error {
    return informer.AddIndexers(cache.Indexers{
        podByNodeIndex: func(obj interface{}) ([]string, error) {
            pod, ok := obj.(*corev1.Pod)
            if !ok {
                return nil, fmt.Errorf("expected Pod, got %T", obj)
            }
            return []string{pod.Spec.NodeName}, nil
        },
        podByServiceAccountIndex: func(obj interface{}) ([]string, error) {
            pod, ok := obj.(*corev1.Pod)
            if !ok {
                return nil, fmt.Errorf("expected Pod, got %T", obj)
            }
            // Index key: namespace/service-account
            key := pod.Namespace + "/" + pod.Spec.ServiceAccountName
            return []string{key}, nil
        },
    })
}

// Usage: O(1) lookup all pods on a specific node
func GetPodsOnNode(indexer cache.Indexer, nodeName string) ([]*corev1.Pod, error) {
    objs, err := indexer.ByIndex(podByNodeIndex, nodeName)
    if err != nil {
        return nil, err
    }
    pods := make([]*corev1.Pod, 0, len(objs))
    for _, obj := range objs {
        pod, ok := obj.(*corev1.Pod)
        if !ok {
            continue
        }
        pods = append(pods, pod)
    }
    return pods, nil
}
```

## Owning References and Garbage Collection

Set owner references to enable automatic garbage collection when a parent resource is deleted:

```go
import "k8s.io/apimachinery/pkg/runtime/schema"

// setOwnerReference adds an owner reference to the child object,
// causing Kubernetes to garbage collect the child when the owner is deleted.
func setOwnerReference(
    owner metav1.Object,
    ownerGVK schema.GroupVersionKind,
    child metav1.Object,
) {
    isController := true
    blockOwnerDeletion := true

    child.SetOwnerReferences([]metav1.OwnerReference{
        {
            APIVersion:         ownerGVK.GroupVersion().String(),
            Kind:               ownerGVK.Kind,
            Name:               owner.GetName(),
            UID:                owner.GetUID(),
            Controller:         &isController,
            BlockOwnerDeletion: &blockOwnerDeletion,
        },
    })
}
```

## Retry Logic for Conflicts

Resource version conflicts occur when multiple goroutines update the same object. Use `retry.RetryOnConflict` for robust updates:

```go
import (
    "k8s.io/apimachinery/pkg/api/errors"
    "k8s.io/client-go/util/retry"
)

// UpdateDeploymentWithRetry handles optimistic concurrency conflicts gracefully.
func UpdateDeploymentWithRetry(
    ctx context.Context,
    client kubernetes.Interface,
    namespace, name string,
    updateFn func(*appsv1.Deployment) error,
) error {
    return retry.RetryOnConflict(retry.DefaultBackoff, func() error {
        deployment, err := client.AppsV1().Deployments(namespace).
            Get(ctx, name, metav1.GetOptions{})
        if err != nil {
            return err
        }

        // Apply the desired changes
        if err := updateFn(deployment); err != nil {
            return err
        }

        _, err = client.AppsV1().Deployments(namespace).
            Update(ctx, deployment, metav1.UpdateOptions{})
        return err
    })
}
```

## Summary

Building production controllers with client-go requires mastering four interconnected patterns. Informers + SharedInformerFactory provide the efficient watch-and-cache foundation; never list/watch directly. WorkQueues provide deduplication and backoff-based retry; never call reconcile directly from event handlers. Server-side apply handles field ownership and prevents controller conflicts; prefer it over Update for controller-managed fields. Fake clients enable deterministic unit testing without a cluster; use reactors to simulate error conditions.

The common mistakes in production controllers: using Get instead of Lister for cache reads (bypasses the cache, hammers the API server), updating status using full object updates instead of the status subresource (causes version conflicts), and omitting owner references (leaks child resources when parents are deleted). Following the patterns in this guide avoids all three classes of bugs.
