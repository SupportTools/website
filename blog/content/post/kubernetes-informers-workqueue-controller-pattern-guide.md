---
title: "Kubernetes Informers and WorkQueues: Building Efficient Controllers"
date: 2027-04-28T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Informers", "WorkQueue", "Controller", "Go", "Operator"]
categories: ["Kubernetes", "Development"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Technical guide to building high-performance Kubernetes controllers using client-go informers and work queues, covering cache synchronization, event handlers, rate limiting, and controller patterns."
more_link: "yes"
url: "/kubernetes-informers-workqueue-controller-pattern-guide/"
---

Every Kubernetes controller — from the built-in ReplicaSet controller to a custom operator — is built on the same client-go primitives: informers that maintain a local cache of API server state, and work queues that decouple event detection from event processing. Understanding these components at the implementation level is the difference between writing a controller that works in demos and one that performs correctly under the load, event storms, and partial failures of a production cluster.

This guide covers the complete controller architecture from raw client-go through controller-runtime abstractions, with production-ready Go implementations throughout.

<!--more-->

# The Informer Architecture

## Why Informers Exist

The naive approach to writing a controller is to call the API server on every reconciliation: list all objects, compare desired versus actual state, apply changes. This approach breaks at scale for two reasons:

1. **Rate limiting:** The API server enforces per-client and per-resource rate limits. A controller that polls even at 1-second intervals across hundreds of resources will hit these limits.

2. **Thundering herd:** If every controller watches the raw API independently, each adds load to the API server. With 50 controllers each polling 20 resource types, the API server receives thousands of list requests per second.

Informers solve both problems. An informer establishes a single watch connection to the API server for a specific resource type. Received events are processed into an in-memory cache (the store). All reads by the controller go to the local cache, not the API server. The result is that controller logic can call `List` and `Get` thousands of times per second with no additional API server load.

```
┌──────────────────────────────────────────────────────────────────────┐
│                  Informer Architecture                              │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  API Server                                                          │
│  ┌─────────────────┐                                                 │
│  │  Watch Stream   │  single long-running connection per resource    │
│  │  (pods, etc.)   │  type per controller process                   │
│  └────────┬────────┘                                                 │
│           │ events (ADDED, MODIFIED, DELETED)                        │
│           ▼                                                          │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  ListWatcher                                                   │  │
│  │  - Initial LIST populates cache                                │  │
│  │  - WATCH maintains incremental updates                         │  │
│  └───────────────────────────┬────────────────────────────────────┘  │
│                              │                                       │
│              ┌───────────────┴────────────────┐                      │
│              │                                │                      │
│              ▼                                ▼                      │
│  ┌─────────────────────┐        ┌──────────────────────────────────┐ │
│  │  Thread-safe Store  │        │  EventHandlers                   │ │
│  │  (local cache)      │        │  OnAdd, OnUpdate, OnDelete       │ │
│  │                     │        │                                  │ │
│  │  controller.List()  │        │  → enqueue item key to WorkQueue │ │
│  │  controller.Get()   │        │    ("namespace/name")            │ │
│  │  (zero API calls)   │        │                                  │ │
│  └─────────────────────┘        └──────────────────────────────────┘ │
│                                              │                       │
│                                              ▼                       │
│                              ┌───────────────────────────────────┐  │
│                              │  WorkQueue                        │  │
│                              │  - deduplication                  │  │
│                              │  - rate limiting                  │  │
│                              │  - retry with backoff             │  │
│                              └───────────────────────────────────┘  │
│                                              │                       │
│                                              ▼                       │
│                              ┌───────────────────────────────────┐  │
│                              │  Worker Goroutines                │  │
│                              │  reconcile(key) {                 │  │
│                              │    obj := cache.Get(key)          │  │
│                              │    // reconcile logic             │  │
│                              │  }                                │  │
│                              └───────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

## SharedIndexInformer vs SharedInformer

`SharedInformer` allows multiple controllers to share the same watch connection and cache for a resource type. `SharedIndexInformer` adds index support, enabling O(1) lookups by arbitrary fields rather than full-cache scans.

The `SharedInformerFactory` manages a pool of `SharedIndexInformer` instances, ensuring only one informer exists per resource type regardless of how many controllers request it.

```go
// informer-factory-setup.go
package main

import (
	"context"
	"fmt"
	"os"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/runtime"
	"k8s.io/apimachinery/pkg/util/wait"
	"k8s.io/client-go/informers"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/cache"
	"k8s.io/client-go/tools/clientcmd"
	"k8s.io/client-go/util/workqueue"
)

func buildKubeClient() (kubernetes.Interface, error) {
	loadingRules := clientcmd.NewDefaultClientConfigLoadingRules()
	configOverrides := &clientcmd.ConfigOverrides{}
	kubeConfig := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(
		loadingRules, configOverrides)
	config, err := kubeConfig.ClientConfig()
	if err != nil {
		return nil, fmt.Errorf("building kubeconfig: %w", err)
	}

	// Set appropriate QPS and burst for production controllers
	config.QPS = 50
	config.Burst = 100

	client, err := kubernetes.NewForConfig(config)
	if err != nil {
		return nil, fmt.Errorf("building client: %w", err)
	}
	return client, nil
}

func main() {
	client, err := buildKubeClient()
	if err != nil {
		fmt.Fprintf(os.Stderr, "ERROR: %v\n", err)
		os.Exit(1)
	}

	// Create a shared informer factory.
	// resyncPeriod triggers a full re-list and re-sync of all objects
	// even without API server events. This is a safety net for missed events.
	// 30 minutes is a common production value; 0 disables periodic resync.
	factory := informers.NewSharedInformerFactory(client, 30*time.Minute)

	// For namespace-scoped watching:
	// factory := informers.NewSharedInformerFactoryWithOptions(
	//   client, 30*time.Minute,
	//   informers.WithNamespace("my-namespace"),
	// )

	// Register informers for the resources we care about
	// Calling these methods registers the informer in the factory but does not start it.
	podInformer := factory.Core().V1().Pods()
	deploymentInformer := factory.Apps().V1().Deployments()

	// Build the controller
	ctrl := NewDeploymentController(client, deploymentInformer, podInformer)

	// Start the factory - this begins the List+Watch for all registered informers
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	factory.Start(ctx.Done())

	// Wait for caches to sync before starting worker goroutines.
	// This ensures the local store is fully populated from the initial LIST.
	cacheSyncMap := factory.WaitForCacheSync(ctx.Done())
	for informerType, synced := range cacheSyncMap {
		if !synced {
			fmt.Fprintf(os.Stderr, "ERROR: cache for %v never synced\n", informerType)
			os.Exit(1)
		}
	}
	fmt.Println("All caches synced, starting workers")

	ctrl.Run(ctx, 2) // run with 2 worker goroutines
}

// DeploymentController reconciles Deployments.
type DeploymentController struct {
	client       kubernetes.Interface
	deployLister cache.GenericNamespaceLister
	podLister    cache.GenericNamespaceLister
	queue        workqueue.RateLimitingInterface
	deploySynced cache.InformerSynced
	podSynced    cache.InformerSynced
}
```

# Event Handlers and Work Queue Integration

## Registering Event Handlers

Event handlers should be fast and non-blocking. Their only job is to extract a key from the object and enqueue it. All reconciliation logic happens in the worker goroutine, never in the event handler.

```go
// event-handlers.go

func NewDeploymentController(
	client kubernetes.Interface,
	deployInformer informersappsv1.DeploymentInformer,
	podInformer informerscorev1.PodInformer,
) *DeploymentController {

	// Use the rate-limiting queue with exponential backoff
	// BucketRateLimiter handles steady-state load
	// ItemExponentialFailureRateLimiter handles per-item retry backoff
	queue := workqueue.NewRateLimitingQueue(
		workqueue.NewMaxOfRateLimiter(
			workqueue.NewItemExponentialFailureRateLimiter(5*time.Second, 1000*time.Second),
			&workqueue.BucketRateLimiter{Limiter: rate.NewLimiter(rate.Limit(10), 100)},
		),
	)

	ctrl := &DeploymentController{
		client:       client,
		queue:        queue,
		deploySynced: deployInformer.Informer().HasSynced,
		podSynced:    podInformer.Informer().HasSynced,
	}

	// Register deployment event handlers
	deployInformer.Informer().AddEventHandler(cache.ResourceEventHandlerFuncs{
		AddFunc: func(obj interface{}) {
			key, err := cache.MetaNamespaceKeyFunc(obj)
			if err != nil {
				runtime.HandleError(fmt.Errorf("getting key for added object: %w", err))
				return
			}
			queue.Add(key)
		},
		UpdateFunc: func(oldObj, newObj interface{}) {
			// Only enqueue if the spec or important metadata changed.
			// Ignoring resource version changes caused by status updates
			// prevents unnecessary reconcile loops.
			oldDeploy := oldObj.(*appsv1.Deployment)
			newDeploy := newObj.(*appsv1.Deployment)
			if oldDeploy.ResourceVersion == newDeploy.ResourceVersion {
				// Resync triggered this - still enqueue but could also skip
			}
			key, err := cache.MetaNamespaceKeyFunc(newObj)
			if err != nil {
				runtime.HandleError(fmt.Errorf("getting key for updated object: %w", err))
				return
			}
			queue.Add(key)
		},
		DeleteFunc: func(obj interface{}) {
			// When an object is deleted from the cache, obj may be a
			// DeletedFinalStateUnknown wrapper if the watch missed the delete event.
			key, err := cache.DeletionHandlingMetaNamespaceKeyFunc(obj)
			if err != nil {
				runtime.HandleError(fmt.Errorf("getting key for deleted object: %w", err))
				return
			}
			queue.Add(key)
		},
	})

	// Register pod event handlers to watch for pod changes owned by deployments.
	// When a pod changes, enqueue the owner deployment.
	podInformer.Informer().AddEventHandler(cache.ResourceEventHandlerFuncs{
		AddFunc: func(obj interface{}) {
			ctrl.handlePodEvent(obj)
		},
		UpdateFunc: func(oldObj, newObj interface{}) {
			ctrl.handlePodEvent(newObj)
		},
		DeleteFunc: func(obj interface{}) {
			ctrl.handlePodEvent(obj)
		},
	})

	ctrl.deployLister = deployInformer.Lister().Deployments(metav1.NamespaceAll)
	ctrl.podLister = podInformer.Lister().Pods(metav1.NamespaceAll)

	return ctrl
}

// handlePodEvent maps a pod event back to its owner Deployment and enqueues it.
func (c *DeploymentController) handlePodEvent(obj interface{}) {
	// Handle tombstone from missed delete events
	if tombstone, ok := obj.(cache.DeletedFinalStateUnknown); ok {
		obj = tombstone.Obj
	}
	pod, ok := obj.(*corev1.Pod)
	if !ok {
		return
	}

	// Walk owner references to find the controlling Deployment
	for _, ref := range pod.OwnerReferences {
		if ref.Kind == "ReplicaSet" && ref.Controller != nil && *ref.Controller {
			// Pods are owned by ReplicaSets, which are owned by Deployments.
			// We'd need to look up the ReplicaSet to find its Deployment owner.
			// For simplicity, enqueue a synthetic key that the reconciler handles.
			// In practice, use an indexer for this lookup.
			c.queue.Add(fmt.Sprintf("%s/%s", pod.Namespace, ref.Name))
			return
		}
	}
}
```

## Working with Indexers for Efficient Lookups

Without indexers, finding all pods owned by a specific deployment requires listing all pods and filtering. With an indexer, this becomes an O(1) lookup.

```go
// indexer-patterns.go

const (
	// Index key for looking up pods by their owner ReplicaSet
	podByReplicaSetIndex = "podByReplicaSet"
	// Index key for looking up deployments by their ingress
	deploymentByIngressIndex = "deploymentByIngress"
)

// indexPodByOwner is an IndexFunc that extracts owner names from pods.
// It is registered with the pod informer to build an index.
func indexPodByOwner(obj interface{}) ([]string, error) {
	pod, ok := obj.(*corev1.Pod)
	if !ok {
		return nil, fmt.Errorf("expected Pod, got %T", obj)
	}

	var owners []string
	for _, ref := range pod.OwnerReferences {
		if ref.Controller != nil && *ref.Controller {
			owners = append(owners, ref.Name)
		}
	}
	return owners, nil
}

// AddEventHandlerWithResyncPeriod allows per-handler resync periods.
// A handler that needs more frequent resyncs than others can register
// with a shorter period without affecting the global factory resync.
func registerHandlersWithCustomResync(informer cache.SharedIndexInformer) {
	// Add index to the informer's store
	if err := informer.AddIndexers(cache.Indexers{
		podByReplicaSetIndex: indexPodByOwner,
	}); err != nil {
		panic(fmt.Sprintf("adding indexer: %v", err))
	}

	// Register a handler with a 5-minute resync (independent of factory's 30min)
	informer.AddEventHandlerWithResyncPeriod(
		cache.ResourceEventHandlerFuncs{
			AddFunc:    func(obj interface{}) { /* ... */ },
			UpdateFunc: func(old, new interface{}) { /* ... */ },
		},
		5*time.Minute,
	)
}

// lookupPodsForReplicaSet uses the index for O(1) lookup of pods by owner.
func lookupPodsForReplicaSet(podIndexer cache.Indexer, rsName string) ([]*corev1.Pod, error) {
	objs, err := podIndexer.ByIndex(podByReplicaSetIndex, rsName)
	if err != nil {
		return nil, fmt.Errorf("indexer lookup: %w", err)
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

# Work Queue Deep Dive

## Rate Limiter Configuration

The work queue rate limiter controls two things: the per-item retry backoff (how long to wait before re-processing a failed item) and the overall throughput rate (items per second across all items).

```go
// workqueue-configuration.go

func buildProductionQueue(name string) workqueue.RateLimitingInterface {
	// MaxOfRateLimiter applies the most restrictive of all child limiters.
	// Combines per-item backoff with overall throughput limiting.
	rateLimiter := workqueue.NewMaxOfRateLimiter(
		// Per-item exponential backoff: first failure waits 5s,
		// doubles each failure up to 16 minutes max.
		workqueue.NewItemExponentialFailureRateLimiter(
			5*time.Second,   // base delay
			16*time.Minute,  // max delay
		),
		// Token bucket for overall queue throughput.
		// Allows burst of 100 items, then limits to 10/second steady state.
		&workqueue.BucketRateLimiter{
			Limiter: rate.NewLimiter(rate.Limit(10), 100),
		},
	)

	return workqueue.NewNamedRateLimitingQueue(rateLimiter, name)
}

// For controllers that need faster recovery (shorter backoff):
func buildFastRetryQueue(name string) workqueue.RateLimitingInterface {
	return workqueue.NewNamedRateLimitingQueue(
		workqueue.NewItemExponentialFailureRateLimiter(
			500*time.Millisecond, // 500ms initial backoff
			30*time.Second,       // 30s max backoff
		),
		name,
	)
}
```

## The Worker Loop Pattern

```go
// worker-loop.go

// Run starts the controller workers and blocks until ctx is cancelled.
func (c *DeploymentController) Run(ctx context.Context, workers int) {
	defer runtime.HandleCrash()
	defer c.queue.ShutDown()

	// Wait for cache sync before starting workers.
	// This is critical: if workers start before caches are synced,
	// they may reconcile against stale (empty) state.
	if !cache.WaitForNamedCacheSync("deployment-controller", ctx.Done(),
		c.deploySynced, c.podSynced) {
		return
	}

	for i := 0; i < workers; i++ {
		go wait.UntilWithContext(ctx, c.runWorker, time.Second)
	}

	<-ctx.Done()
}

// runWorker drains the queue until it shuts down.
func (c *DeploymentController) runWorker(ctx context.Context) {
	for c.processNextItem(ctx) {
	}
}

// processNextItem gets one item from the queue, processes it, and marks it done.
func (c *DeploymentController) processNextItem(ctx context.Context) bool {
	// Get blocks until an item is available or the queue shuts down.
	// Returns false when the queue is shut down.
	item, shutdown := c.queue.Get()
	if shutdown {
		return false
	}

	// Wrap in a function to guarantee Done() is called with defer.
	err := func() error {
		// Always mark item done when we return, even on error.
		// Forget removes the item from the rate limiter's failure tracking.
		// Done signals that the item has been processed (allowing re-Add).
		defer c.queue.Done(item)

		key, ok := item.(string)
		if !ok {
			// Invalid item - discard it, don't retry
			c.queue.Forget(item)
			return fmt.Errorf("expected string key, got %T", item)
		}

		if err := c.reconcile(ctx, key); err != nil {
			// Re-add item with rate limiting (exponential backoff)
			// Do NOT call Forget - we want the backoff to accumulate
			c.queue.AddRateLimited(item)
			return fmt.Errorf("reconciling %s: %w (requeued with backoff)", key, err)
		}

		// Success: tell the queue this item's failure count can be reset
		c.queue.Forget(item)
		return nil
	}()

	if err != nil {
		runtime.HandleError(err)
	}
	return true
}
```

## The Reconcile Function

```go
// reconcile-function.go

func (c *DeploymentController) reconcile(ctx context.Context, key string) error {
	log := klog.FromContext(ctx).WithValues("key", key)

	// Split the namespace/name key
	namespace, name, err := cache.SplitMetaNamespaceKey(key)
	if err != nil {
		// Invalid key format - do not retry
		return nil
	}

	// Get the object from the local cache (NOT from the API server)
	// This is the cache.Get() call that makes informers efficient.
	deploy, err := c.deployLister.Deployments(namespace).Get(name)
	if errors.IsNotFound(err) {
		// Object was deleted - clean up any external state
		log.V(4).Info("Deployment not found, may have been deleted")
		return c.handleDeletedDeployment(ctx, namespace, name)
	}
	if err != nil {
		return fmt.Errorf("fetching deployment from cache: %w", err)
	}

	// Work on a deep copy to avoid mutating the cache
	deploy = deploy.DeepCopy()

	log.V(4).Info("Reconciling deployment",
		"replicas", deploy.Spec.Replicas,
		"readyReplicas", deploy.Status.ReadyReplicas)

	// Example reconciliation: ensure a ConfigMap exists for the deployment
	if err := c.ensureConfigMap(ctx, deploy); err != nil {
		return fmt.Errorf("ensuring configmap: %w", err)
	}

	return nil
}

func (c *DeploymentController) handleDeletedDeployment(ctx context.Context,
	namespace, name string) error {
	// Clean up external resources associated with the deleted deployment.
	// Since the cache no longer has the object, we must use stored state
	// (like a finalizer on an associated CRD) to know what to clean up.
	return nil
}

func (c *DeploymentController) ensureConfigMap(ctx context.Context,
	deploy *appsv1.Deployment) error {

	cmName := fmt.Sprintf("%s-config", deploy.Name)

	// List from cache - zero API server calls
	cm, err := c.podLister.ConfigMaps(deploy.Namespace).Get(cmName)
	if errors.IsNotFound(err) {
		// Create via API (this IS an API call, but it's a write, not a read)
		newCM := &corev1.ConfigMap{
			ObjectMeta: metav1.ObjectMeta{
				Name:      cmName,
				Namespace: deploy.Namespace,
				OwnerReferences: []metav1.OwnerReference{
					*metav1.NewControllerRef(deploy, appsv1.SchemeGroupVersion.WithKind("Deployment")),
				},
			},
			Data: map[string]string{
				"app": deploy.Name,
			},
		}
		_, err = c.client.CoreV1().ConfigMaps(deploy.Namespace).Create(
			ctx, newCM, metav1.CreateOptions{})
		return err
	}
	if err != nil {
		return fmt.Errorf("getting configmap from cache: %w", err)
	}

	// ConfigMap exists; ensure it has the right data
	if cm.Data["app"] != deploy.Name {
		cmCopy := cm.DeepCopy()
		cmCopy.Data["app"] = deploy.Name
		_, err = c.client.CoreV1().ConfigMaps(deploy.Namespace).Update(
			ctx, cmCopy, metav1.UpdateOptions{})
		return err
	}

	return nil
}
```

# Controller-Runtime: The Higher-Level Abstraction

## How controller-runtime Uses Informers Internally

controller-runtime (used by Kubebuilder and Operator SDK) wraps the raw informer/workqueue primitives in a `Manager` and `Reconciler` interface. Understanding the mapping helps when debugging or when controller-runtime's abstractions are insufficient.

```
controller-runtime concepts → client-go primitives

Manager             → SharedInformerFactory + LeaderElector
Reconciler          → Worker goroutine + reconcile()
Builder.Watches     → AddEventHandler on SharedIndexInformer
ctrl.Request        → workqueue item (namespace/name key)
client.Get/List     → cache.Store Get/List (zero API calls for reads)
client.Create/Update → Direct API server calls (writes)
ctrl.Result.Requeue → queue.AddRateLimited (with backoff)
ctrl.Result{}       → queue.Forget (success)
```

```go
// controller-runtime-reconciler.go
package controllers

import (
	"context"
	"fmt"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/builder"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/event"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	"sigs.k8s.io/controller-runtime/pkg/predicate"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"
	"sigs.k8s.io/controller-runtime/pkg/source"
)

// AppReconciler demonstrates production controller-runtime patterns.
type AppReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// SetupWithManager registers the controller and its watches with the Manager.
// This is where informer event handlers and queue configuration are set up.
func (r *AppReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		// Primary resource: enqueue App on any change
		For(&myv1alpha1.App{}).
		// Owned resource: enqueue App when owned Deployment changes
		// This uses ownerReference traversal to find the App to enqueue.
		Owns(&appsv1.Deployment{}).
		Owns(&corev1.Service{}).
		// Watch a non-owned resource (ConfigMap) and map events to App keys.
		// Useful when the App depends on a shared ConfigMap it doesn't own.
		Watches(
			&corev1.ConfigMap{},
			handler.EnqueueRequestsFromMapFunc(r.configMapToApps),
			builder.WithPredicates(predicate.NewPredicateFuncs(func(obj client.Object) bool {
				// Only watch ConfigMaps with the specific label
				_, ok := obj.GetLabels()["app.my-org.io/config"]
				return ok
			})),
		).
		// Filter update events: only reconcile if generation changed
		// (i.e., spec changed, not just status or metadata)
		WithEventFilter(predicate.Or(
			predicate.GenerationChangedPredicate{},
			predicate.LabelChangedPredicate{},
			predicate.AnnotationChangedPredicate{},
		)).
		// Configure the controller queue rate limiter
		WithOptions(controller.Options{
			MaxConcurrentReconciles: 5,
			RateLimiter: workqueue.NewMaxOfRateLimiter(
				workqueue.NewItemExponentialFailureRateLimiter(5*time.Second, 1000*time.Second),
				&workqueue.BucketRateLimiter{Limiter: rate.NewLimiter(rate.Limit(10), 100)},
			),
		}).
		Complete(r)
}

// configMapToApps maps a ConfigMap event to the list of Apps that reference it.
func (r *AppReconciler) configMapToApps(ctx context.Context, obj client.Object) []reconcile.Request {
	appList := &myv1alpha1.AppList{}
	if err := r.List(ctx, appList,
		client.InNamespace(obj.GetNamespace()),
		client.MatchingLabels{"config-ref": obj.GetName()}); err != nil {
		return nil
	}

	requests := make([]reconcile.Request, len(appList.Items))
	for i, app := range appList.Items {
		requests[i] = reconcile.Request{
			NamespacedName: client.ObjectKeyFromObject(&app),
		}
	}
	return requests
}

func (r *AppReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := ctrl.LoggerFrom(ctx)

	// client.Get reads from the cache - no API call
	app := &myv1alpha1.App{}
	if err := r.Get(ctx, req.NamespacedName, app); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	// Reconcile the Deployment
	if result, err := r.reconcileDeployment(ctx, app); err != nil || result.Requeue {
		return result, err
	}

	// Reconcile the Service
	if result, err := r.reconcileService(ctx, app); err != nil || result.Requeue {
		return result, err
	}

	// Update status
	if err := r.updateAppStatus(ctx, app); err != nil {
		return ctrl.Result{}, err
	}

	log.V(4).Info("Reconcile complete")
	return ctrl.Result{}, nil
}

func (r *AppReconciler) reconcileDeployment(ctx context.Context,
	app *myv1alpha1.App) (ctrl.Result, error) {

	deploy := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{
			Name:      app.Name,
			Namespace: app.Namespace,
		},
	}

	result, err := controllerutil.CreateOrUpdate(ctx, r.Client, deploy, func() error {
		// Set owner reference so Deployment is garbage collected with App
		if err := ctrl.SetControllerReference(app, deploy, r.Scheme); err != nil {
			return err
		}
		deploy.Spec = appsv1.DeploymentSpec{
			Replicas: &app.Spec.Replicas,
			Selector: &metav1.LabelSelector{
				MatchLabels: map[string]string{"app": app.Name},
			},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{
					Labels: map[string]string{"app": app.Name},
				},
				Spec: corev1.PodSpec{
					Containers: []corev1.Container{
						{
							Name:  "app",
							Image: app.Spec.Image,
						},
					},
				},
			},
		}
		return nil
	})
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("reconciling deployment: %w", err)
	}
	if result == controllerutil.OperationResultCreated {
		// Requeue quickly to update status with the new Deployment's state
		return ctrl.Result{RequeueAfter: 2 * time.Second}, nil
	}
	return ctrl.Result{}, nil
}

func (r *AppReconciler) reconcileService(ctx context.Context,
	app *myv1alpha1.App) (ctrl.Result, error) {
	// Similar pattern to reconcileDeployment...
	return ctrl.Result{}, nil
}

func (r *AppReconciler) updateAppStatus(ctx context.Context, app *myv1alpha1.App) error {
	// Fetch the Deployment from cache for status
	deploy := &appsv1.Deployment{}
	if err := r.Get(ctx, client.ObjectKeyFromObject(app), deploy); err != nil {
		if errors.IsNotFound(err) {
			return nil
		}
		return err
	}

	patch := client.MergeFrom(app.DeepCopy())
	app.Status.ReadyReplicas = deploy.Status.ReadyReplicas
	app.Status.ObservedGeneration = app.Generation

	return r.Status().Patch(ctx, app, patch)
}
```

# Testing Controllers

## Unit Testing with a Fake Client

```go
// controller-unit-test.go
package controllers_test

import (
	"context"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	myv1alpha1 "github.com/my-org/my-operator/api/v1alpha1"
	"github.com/my-org/my-operator/controllers"
)

func TestAppReconciler_CreatesDeployment(t *testing.T) {
	// Build a scheme with all required types registered
	scheme := runtime.NewScheme()
	_ = myv1alpha1.AddToScheme(scheme)
	_ = appsv1.AddToScheme(scheme)
	_ = corev1.AddToScheme(scheme)

	// Create the test App object
	app := &myv1alpha1.App{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "test-app",
			Namespace: "default",
		},
		Spec: myv1alpha1.AppSpec{
			Image:    "nginx:1.25",
			Replicas: 2,
		},
	}

	// Build a fake client pre-populated with the App
	fakeClient := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(app).
		WithStatusSubresource(app). // Required for status updates
		Build()

	// Create the reconciler with the fake client
	reconciler := &controllers.AppReconciler{
		Client: fakeClient,
		Scheme: scheme,
	}

	// Run reconcile
	req := ctrl.Request{
		NamespacedName: types.NamespacedName{
			Name:      "test-app",
			Namespace: "default",
		},
	}
	result, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("Reconcile returned error: %v", err)
	}
	_ = result

	// Verify the Deployment was created
	deploy := &appsv1.Deployment{}
	if err := fakeClient.Get(context.Background(), types.NamespacedName{
		Name:      "test-app",
		Namespace: "default",
	}, deploy); err != nil {
		t.Fatalf("Deployment not found: %v", err)
	}

	if *deploy.Spec.Replicas != 2 {
		t.Errorf("Expected 2 replicas, got %d", *deploy.Spec.Replicas)
	}
	if deploy.Spec.Template.Spec.Containers[0].Image != "nginx:1.25" {
		t.Errorf("Wrong image: %s", deploy.Spec.Template.Spec.Containers[0].Image)
	}

	// Verify owner reference was set
	if len(deploy.OwnerReferences) == 0 {
		t.Error("Expected owner reference on Deployment")
	}
	if deploy.OwnerReferences[0].Name != "test-app" {
		t.Errorf("Wrong owner: %s", deploy.OwnerReferences[0].Name)
	}
}

func TestAppReconciler_IdempotentOnRequeue(t *testing.T) {
	scheme := runtime.NewScheme()
	_ = myv1alpha1.AddToScheme(scheme)
	_ = appsv1.AddToScheme(scheme)

	app := &myv1alpha1.App{
		ObjectMeta: metav1.ObjectMeta{Name: "test-app", Namespace: "default"},
		Spec:       myv1alpha1.AppSpec{Image: "nginx:1.25", Replicas: 1},
	}

	fakeClient := fake.NewClientBuilder().WithScheme(scheme).WithObjects(app).Build()
	reconciler := &controllers.AppReconciler{Client: fakeClient, Scheme: scheme}

	req := ctrl.Request{NamespacedName: client.ObjectKeyFromObject(app)}

	// First reconcile
	_, err := reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("First reconcile: %v", err)
	}

	// Second reconcile (simulates requeue) - must not fail or duplicate objects
	_, err = reconciler.Reconcile(context.Background(), req)
	if err != nil {
		t.Fatalf("Second reconcile: %v", err)
	}

	// Count Deployments - should be exactly 1
	deployList := &appsv1.DeploymentList{}
	if err := fakeClient.List(context.Background(), deployList,
		client.InNamespace("default")); err != nil {
		t.Fatal(err)
	}
	if len(deployList.Items) != 1 {
		t.Errorf("Expected 1 Deployment, got %d", len(deployList.Items))
	}
}
```

## Integration Testing with envtest

```go
// controller-integration-test.go
package controllers_test

import (
	"path/filepath"
	"testing"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	"k8s.io/client-go/rest"
	"sigs.k8s.io/controller-runtime/pkg/envtest"
)

var (
	cfg     *rest.Config
	testEnv *envtest.Environment
)

func TestControllers(t *testing.T) {
	RegisterFailHandler(Fail)
	RunSpecs(t, "Controller Suite")
}

var _ = BeforeSuite(func() {
	testEnv = &envtest.Environment{
		CRDDirectoryPaths: []string{
			filepath.Join("..", "config", "crd", "bases"),
		},
		ErrorIfCRDPathMissing: true,
	}

	var err error
	cfg, err = testEnv.Start()
	Expect(err).NotTo(HaveOccurred())
	Expect(cfg).NotTo(BeNil())
})

var _ = AfterSuite(func() {
	Expect(testEnv.Stop()).To(Succeed())
})

var _ = Describe("AppReconciler", func() {
	Context("When creating a new App", func() {
		It("Should create a Deployment with the correct spec", func() {
			// Full integration test against a real (in-process) API server
			// Uses the real controller loop and event handlers
			// Tests can assert on timing and event ordering
		})
	})
})
```

# Resync and Cache Coherence

## Understanding Resync

The periodic resync (`resyncPeriod` in the SharedInformerFactory) triggers `UpdateFunc` event handlers for all objects in the cache, even if the objects have not changed on the API server. This is a safety mechanism that ensures controllers re-process all objects periodically, catching any state that was missed due to dropped watch events.

```bash
# Monitor cache sync status and resync events in a running controller
# (if controller exposes /metrics endpoint with workqueue metrics)

# workqueue_depth: current queue depth
# workqueue_adds_total: total items added
# workqueue_queue_duration_seconds: time items spend in queue
# workqueue_work_duration_seconds: time spent processing
# workqueue_retries_total: number of retries

curl -s http://controller-pod:8080/metrics | grep workqueue
```

```go
// resync-handling.go
// When resync triggers UpdateFunc with identical old/new objects,
// the controller should handle this gracefully without unnecessary API calls.

func (c *DeploymentController) needsUpdate(old, new *appsv1.Deployment) bool {
	// Compare resource versions first - if same, this is a resync
	if old.ResourceVersion == new.ResourceVersion {
		// It's a resync - we may still want to reconcile if our external
		// state could have drifted, but we can be smarter about it.
		// For most controllers, return false here to skip no-op reconciles.
		return false
	}

	// Compare generation (spec changes only)
	if old.Generation != new.Generation {
		return true
	}

	// Compare labels/annotations if we act on them
	if !reflect.DeepEqual(old.Labels, new.Labels) {
		return true
	}

	return false
}
```

# Performance Tuning Reference

## Key Configuration Parameters

```go
// performance-config-reference.go

// Controller-runtime Manager options
ctrl.NewManager(cfg, ctrl.Options{
	// Sync period: how often to resync all objects
	// Shorter means more reconcile calls during quiet periods
	// Longer means slower recovery from missed events
	SyncPeriod: func(d time.Duration) *time.Duration { return &d }(10 * time.Minute),

	// Enable leader election for HA deployments
	// Only one replica reconciles at a time; others are standby
	LeaderElection:          true,
	LeaderElectionID:        "my-controller.my-org.io",
	LeaderElectionNamespace: "my-controller-system",
	// Renew deadline should be less than LeaseDuration
	LeaseDuration: func(d time.Duration) *time.Duration { return &d }(15 * time.Second),
	RenewDeadline: func(d time.Duration) *time.Duration { return &d }(10 * time.Second),
	RetryPeriod:   func(d time.Duration) *time.Duration { return &d }(2 * time.Second),

	// Metrics for monitoring queue depth and reconcile latency
	MetricsBindAddress: ":8080",
	HealthProbeBindAddress: ":8081",

	// Restrict informers to specific namespaces
	// Cache: cache.Options{
	//   DefaultNamespaces: map[string]cache.Config{
	//     "my-namespace": {},
	//   },
	// },
})

// Per-controller options
ctrl.NewControllerManagedBy(mgr).
	For(&myv1alpha1.App{}).
	WithOptions(controller.Options{
		// Number of goroutines processing the queue concurrently
		// Higher values increase throughput but increase API server load
		MaxConcurrentReconciles: 10,

		// Skip reconcile for objects being deleted (unless they have finalizers)
		// Can reduce unnecessary reconcile calls
		NeedsLeaderElection: pointer.Bool(true),
	}).
	Complete(r)
```

Building efficient Kubernetes controllers requires a thorough understanding of the informer-workqueue architecture. The key insight is that reads are cheap (local cache) and writes are expensive (API server calls) — controller logic should maximize cache reads and minimize write operations. Proper event handler design, indexer usage for complex lookups, rate limiter tuning, and idempotent reconcile functions are the foundations of a controller that performs well at production scale. The controller-runtime framework provides well-chosen defaults for most of these parameters while exposing the knobs needed for advanced tuning.
