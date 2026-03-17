---
title: "Go Generics for Infrastructure Code: Type-Safe Kubernetes Client Wrappers"
date: 2029-09-30T00:00:00-05:00
draft: false
tags: ["Go", "Generics", "Kubernetes", "Controller-Runtime", "Type Safety", "Operators"]
categories: ["Go", "Kubernetes"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A practical guide to leveraging Go generics for Kubernetes infrastructure code, covering generic reconciler patterns, type-safe lister and informer wrappers, generic cache implementations, and techniques for reducing controller boilerplate."
more_link: "yes"
url: "/go-generics-infrastructure-code-kubernetes-client-wrappers/"
---

Go 1.18 introduced generics, and while the feature has had a measured adoption in the broader Go ecosystem, it provides substantial value in Kubernetes operator and controller code. The `controller-runtime` library and the Kubernetes client-go code base are built around `interface{}` and reflection — patterns that predate generics. Layering generic wrappers on top of these interfaces eliminates large categories of type assertions, reduces boilerplate, and surfaces type errors at compile time rather than runtime.

This guide demonstrates practical generic patterns for Kubernetes infrastructure code: type-safe reconcilers, generic lister/informer wrappers, cache implementations, and techniques for building reusable controller components.

<!--more-->

# Go Generics for Infrastructure Code: Type-Safe Kubernetes Client Wrappers

## Section 1: The Problem with Current Kubernetes Client Patterns

The standard `controller-runtime` reconciler pattern requires type assertions throughout:

```go
// Traditional pattern — type assertions at every step
func (r *MyReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    // Get the object — must know the type explicitly
    obj := &myv1.MyResource{}
    if err := r.Get(ctx, req.NamespacedName, obj); err != nil {
        return ctrl.Result{}, client.IgnoreNotFound(err)
    }

    // Every List call requires knowing and constructing the type
    childList := &myv1.MyChildList{}
    if err := r.List(ctx, childList,
        client.InNamespace(obj.Namespace),
        client.MatchingFields{"spec.ownerRef": obj.Name},
    ); err != nil {
        return ctrl.Result{}, err
    }

    // Casting from interface{} in informer caches
    rawObj, exists, err := r.Informer.GetStore().GetByKey(req.NamespacedName.String())
    if err != nil || !exists {
        return ctrl.Result{}, err
    }
    typedObj, ok := rawObj.(*myv1.MyResource)
    if !ok {
        return ctrl.Result{}, fmt.Errorf("unexpected type %T", rawObj)
    }
    _ = typedObj
    // ...
}
```

With generics, the type assertions disappear and the relationship between input and output types is expressed in the type system.

## Section 2: Generic Reconciler Base

The core pattern is a generic reconciler that accepts the resource type as a type parameter:

```go
package reconciler

import (
    "context"
    "fmt"

    "k8s.io/apimachinery/pkg/runtime"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"
)

// Object is the constraint for Kubernetes objects — must be a pointer
// to a struct that implements client.Object.
type Object[T any] interface {
    *T
    client.Object
}

// ReconcileFunc is the type-safe reconciliation function signature.
type ReconcileFunc[T any, PT Object[T]] func(
    ctx context.Context,
    obj PT,
) (ctrl.Result, error)

// GenericReconciler is a type-safe wrapper around controller-runtime.
type GenericReconciler[T any, PT Object[T]] struct {
    client.Client
    Scheme      *runtime.Scheme
    ReconcileFn ReconcileFunc[T, PT]
}

// Reconcile implements reconcile.Reconciler.
func (r *GenericReconciler[T, PT]) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    // Instantiate the concrete type without type assertions
    obj := PT(new(T))

    if err := r.Get(ctx, req.NamespacedName, obj); err != nil {
        return ctrl.Result{}, client.IgnoreNotFound(err)
    }

    return r.ReconcileFn(ctx, obj)
}

// SetupWithManager registers the reconciler with the controller manager.
func (r *GenericReconciler[T, PT]) SetupWithManager(mgr ctrl.Manager) error {
    obj := PT(new(T))
    return ctrl.NewControllerManagedBy(mgr).
        For(obj).
        Complete(r)
}
```

### Usage

```go
package controllers

import (
    "context"

    myv1 "github.com/example/my-operator/api/v1"
    "github.com/example/my-operator/pkg/reconciler"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"
)

func SetupMyResourceController(mgr ctrl.Manager) error {
    r := &reconciler.GenericReconciler[myv1.MyResource, *myv1.MyResource]{
        Client: mgr.GetClient(),
        Scheme: mgr.GetScheme(),
        ReconcileFn: reconcileMyResource,
    }
    return r.SetupWithManager(mgr)
}

// reconcileMyResource has full type information — no assertions needed.
func reconcileMyResource(
    ctx context.Context,
    obj *myv1.MyResource,
) (ctrl.Result, error) {
    // obj is *myv1.MyResource, not interface{} or client.Object
    if obj.Spec.Replicas == 0 {
        return ctrl.Result{}, fmt.Errorf("replicas must be > 0")
    }
    // ...
    return ctrl.Result{}, nil
}
```

## Section 3: Generic CRUD Operations

Wrapping the `client.Client` interface with generic methods eliminates type repetition in Get/List/Create/Update operations:

```go
package k8sclient

import (
    "context"

    "k8s.io/apimachinery/pkg/types"
    "sigs.k8s.io/controller-runtime/pkg/client"
)

// TypedClient provides generic CRUD operations over controller-runtime's client.Client.
type TypedClient struct {
    client.Client
}

// Get fetches a single object by name/namespace.
func Get[T any, PT Object[T]](
    ctx context.Context,
    c client.Client,
    name types.NamespacedName,
) (PT, error) {
    obj := PT(new(T))
    if err := c.Get(ctx, name, obj); err != nil {
        return nil, err
    }
    return obj, nil
}

// List fetches a list of objects matching the given options.
// Requires a List type that corresponds to the object type.
type ObjectList[T any, PT Object[T]] interface {
    *T
    client.ObjectList
}

// We need a different approach for List since the List type is separate from Object type
// This uses a factory function pattern:
func ListObjects[L client.ObjectList](
    ctx context.Context,
    c client.Client,
    listFactory func() L,
    opts ...client.ListOption,
) (L, error) {
    list := listFactory()
    if err := c.List(ctx, list, opts...); err != nil {
        var zero L
        return zero, err
    }
    return list, nil
}

// Create creates a new object and returns it with server-populated fields.
func Create[T any, PT Object[T]](
    ctx context.Context,
    c client.Client,
    obj PT,
) (PT, error) {
    if err := c.Create(ctx, obj); err != nil {
        return nil, err
    }
    return obj, nil
}

// Update updates an existing object.
func Update[T any, PT Object[T]](
    ctx context.Context,
    c client.Client,
    obj PT,
    mutate func(PT),
) (PT, error) {
    // Get the latest version
    latest := PT(new(T))
    if err := c.Get(ctx, client.ObjectKeyFromObject(obj), latest); err != nil {
        return nil, err
    }

    // Apply mutations
    mutate(latest)

    if err := c.Update(ctx, latest); err != nil {
        return nil, err
    }
    return latest, nil
}

// EnsureExists creates the object if it doesn't exist, or updates it if it does.
func EnsureExists[T any, PT Object[T]](
    ctx context.Context,
    c client.Client,
    desired PT,
    mutate func(existing, desired PT),
) error {
    existing := PT(new(T))
    err := c.Get(ctx,
        client.ObjectKeyFromObject(desired), existing)
    if err != nil {
        if client.IgnoreNotFound(err) != nil {
            return err
        }
        // Not found — create it
        return c.Create(ctx, desired)
    }

    // Found — apply mutations and update
    mutate(existing, desired)
    return c.Update(ctx, existing)
}
```

### Usage Example

```go
package controllers

import (
    "context"

    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/types"
    k8sclient "github.com/example/my-operator/pkg/k8sclient"
    "sigs.k8s.io/controller-runtime/pkg/client"
)

func reconcileConfigMap(ctx context.Context, c client.Client, name types.NamespacedName) error {
    // Type-safe Get — returns *corev1.ConfigMap, not interface{}
    cm, err := k8sclient.Get[corev1.ConfigMap](ctx, c, name)
    if err != nil {
        return err
    }
    _ = cm.Data // Direct field access, no assertion needed

    // Type-safe Update with mutation function
    updated, err := k8sclient.Update[corev1.ConfigMap](ctx, c, cm, func(obj *corev1.ConfigMap) {
        obj.Data["last-updated"] = time.Now().Format(time.RFC3339)
    })
    if err != nil {
        return err
    }
    _ = updated.ResourceVersion
    return nil
}
```

## Section 4: Generic Informer Wrappers

The client-go informer framework uses `interface{}` in its store and event handlers. Generic wrappers restore type safety:

```go
package informer

import (
    "context"
    "fmt"

    "k8s.io/client-go/tools/cache"
)

// TypedInformer wraps a cache.SharedIndexInformer and provides typed access.
type TypedInformer[T any, PT Object[T]] struct {
    informer cache.SharedIndexInformer
}

// NewTypedInformer creates a typed wrapper around an existing informer.
func NewTypedInformer[T any, PT Object[T]](
    informer cache.SharedIndexInformer,
) *TypedInformer[T, PT] {
    return &TypedInformer[T, PT]{informer: informer}
}

// GetByKey retrieves an object from the cache by key.
func (i *TypedInformer[T, PT]) GetByKey(key string) (PT, bool, error) {
    raw, exists, err := i.informer.GetStore().GetByKey(key)
    if err != nil || !exists {
        return nil, exists, err
    }

    obj, ok := raw.(PT)
    if !ok {
        return nil, false, fmt.Errorf("unexpected type in store: got %T, want %T", raw, PT(nil))
    }
    return obj, true, nil
}

// List returns all objects in the cache.
func (i *TypedInformer[T, PT]) List() []PT {
    items := i.informer.GetStore().List()
    result := make([]PT, 0, len(items))
    for _, item := range items {
        if obj, ok := item.(PT); ok {
            result = append(result, obj)
        }
    }
    return result
}

// AddEventHandler adds a typed event handler.
func (i *TypedInformer[T, PT]) AddEventHandler(handler TypedEventHandler[T, PT]) (cache.ResourceEventHandlerRegistration, error) {
    return i.informer.AddEventHandler(cache.ResourceEventHandlerFuncs{
        AddFunc: func(obj interface{}) {
            if typed, ok := obj.(PT); ok {
                handler.OnAdd(typed)
            }
        },
        UpdateFunc: func(oldObj, newObj interface{}) {
            oldTyped, ok1 := oldObj.(PT)
            newTyped, ok2 := newObj.(PT)
            if ok1 && ok2 {
                handler.OnUpdate(oldTyped, newTyped)
            }
        },
        DeleteFunc: func(obj interface{}) {
            // Handle tombstone objects
            if typed, ok := obj.(PT); ok {
                handler.OnDelete(typed)
                return
            }
            // Unwrap tombstone
            if tombstone, ok := obj.(cache.DeletedFinalStateUnknown); ok {
                if typed, ok := tombstone.Obj.(PT); ok {
                    handler.OnDelete(typed)
                }
            }
        },
    })
}

// TypedEventHandler defines typed callbacks for informer events.
type TypedEventHandler[T any, PT Object[T]] interface {
    OnAdd(obj PT)
    OnUpdate(oldObj, newObj PT)
    OnDelete(obj PT)
}

// TypedEventHandlerFuncs is a convenience type implementing TypedEventHandler.
type TypedEventHandlerFuncs[T any, PT Object[T]] struct {
    AddFunc    func(obj PT)
    UpdateFunc func(oldObj, newObj PT)
    DeleteFunc func(obj PT)
}

func (h TypedEventHandlerFuncs[T, PT]) OnAdd(obj PT) {
    if h.AddFunc != nil {
        h.AddFunc(obj)
    }
}

func (h TypedEventHandlerFuncs[T, PT]) OnUpdate(oldObj, newObj PT) {
    if h.UpdateFunc != nil {
        h.UpdateFunc(oldObj, newObj)
    }
}

func (h TypedEventHandlerFuncs[T, PT]) OnDelete(obj PT) {
    if h.DeleteFunc != nil {
        h.DeleteFunc(obj)
    }
}
```

### Usage

```go
// Register typed event handler for Deployments
deploymentInformer := NewTypedInformer[appsv1.Deployment](
    informerFactory.Apps().V1().Deployments().Informer(),
)

deploymentInformer.AddEventHandler(TypedEventHandlerFuncs[appsv1.Deployment, *appsv1.Deployment]{
    AddFunc: func(deploy *appsv1.Deployment) {
        // deploy is *appsv1.Deployment, no assertion needed
        log.Printf("deployment added: %s/%s, replicas: %d",
            deploy.Namespace, deploy.Name, *deploy.Spec.Replicas)
    },
    UpdateFunc: func(old, new *appsv1.Deployment) {
        if old.ResourceVersion != new.ResourceVersion {
            log.Printf("deployment updated: %s/%s", new.Namespace, new.Name)
        }
    },
    DeleteFunc: func(deploy *appsv1.Deployment) {
        log.Printf("deployment deleted: %s/%s", deploy.Namespace, deploy.Name)
    },
})
```

## Section 5: Generic Cache with Expiry

A common pattern in controllers is maintaining a local cache of computed state to avoid redundant work. Generics make this reusable:

```go
package cache

import (
    "sync"
    "time"
)

// Entry holds a cached value with expiry metadata.
type Entry[V any] struct {
    Value     V
    ExpiresAt time.Time
}

// IsExpired returns true if the entry has expired.
func (e Entry[V]) IsExpired() bool {
    return time.Now().After(e.ExpiresAt)
}

// Cache is a generic TTL cache safe for concurrent access.
type Cache[K comparable, V any] struct {
    mu      sync.RWMutex
    entries map[K]Entry[V]
    ttl     time.Duration
}

// NewCache creates a new cache with the specified TTL.
func NewCache[K comparable, V any](ttl time.Duration) *Cache[K, V] {
    c := &Cache[K, V]{
        entries: make(map[K]Entry[V]),
        ttl:     ttl,
    }
    go c.cleanup()
    return c
}

// Get retrieves a value from the cache.
func (c *Cache[K, V]) Get(key K) (V, bool) {
    c.mu.RLock()
    defer c.mu.RUnlock()

    entry, ok := c.entries[key]
    if !ok || entry.IsExpired() {
        var zero V
        return zero, false
    }
    return entry.Value, true
}

// Set stores a value in the cache with the configured TTL.
func (c *Cache[K, V]) Set(key K, value V) {
    c.mu.Lock()
    defer c.mu.Unlock()

    c.entries[key] = Entry[V]{
        Value:     value,
        ExpiresAt: time.Now().Add(c.ttl),
    }
}

// GetOrCompute retrieves from cache or computes and caches the value.
func (c *Cache[K, V]) GetOrCompute(key K, compute func() (V, error)) (V, error) {
    if val, ok := c.Get(key); ok {
        return val, nil
    }

    val, err := compute()
    if err != nil {
        return val, err
    }

    c.Set(key, val)
    return val, nil
}

// Delete removes a key from the cache.
func (c *Cache[K, V]) Delete(key K) {
    c.mu.Lock()
    defer c.mu.Unlock()
    delete(c.entries, key)
}

// cleanup runs a background goroutine to remove expired entries.
func (c *Cache[K, V]) cleanup() {
    ticker := time.NewTicker(c.ttl)
    defer ticker.Stop()

    for range ticker.C {
        c.mu.Lock()
        now := time.Now()
        for key, entry := range c.entries {
            if now.After(entry.ExpiresAt) {
                delete(c.entries, key)
            }
        }
        c.mu.Unlock()
    }
}

// Controller usage: cache expensive lookups
type MyController struct {
    client       client.Client
    serviceCache *cache.Cache[string, *corev1.Service]
}

func NewMyController(c client.Client) *MyController {
    return &MyController{
        client:       c,
        serviceCache: cache.NewCache[string, *corev1.Service](30 * time.Second),
    }
}

func (ctrl *MyController) getService(ctx context.Context, key string) (*corev1.Service, error) {
    return ctrl.serviceCache.GetOrCompute(key, func() (*corev1.Service, error) {
        parts := strings.SplitN(key, "/", 2)
        svc := &corev1.Service{}
        err := ctrl.client.Get(ctx, types.NamespacedName{
            Namespace: parts[0],
            Name:      parts[1],
        }, svc)
        return svc, err
    })
}
```

## Section 6: Generic Status Conditions

Kubernetes objects often have a `Conditions []metav1.Condition` field. Managing conditions follows a repetitive pattern that generics can abstract:

```go
package conditions

import (
    "time"

    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ConditionManager manages conditions on Kubernetes objects.
// T must be a pointer type whose pointed-to type has a Conditions field.
type ConditionManager[T ConditionAccessor] struct {
    obj T
}

// ConditionAccessor can get and set conditions.
type ConditionAccessor interface {
    GetConditions() []metav1.Condition
    SetConditions([]metav1.Condition)
}

// NewConditionManager creates a condition manager for the given object.
func NewConditionManager[T ConditionAccessor](obj T) *ConditionManager[T] {
    return &ConditionManager[T]{obj: obj}
}

// Set sets a condition on the object.
func (m *ConditionManager[T]) Set(condType string, status metav1.ConditionStatus, reason, message string) {
    conditions := m.obj.GetConditions()
    now := metav1.Now()

    for i, c := range conditions {
        if c.Type == condType {
            if c.Status == status && c.Reason == reason {
                return // No change needed
            }
            conditions[i] = metav1.Condition{
                Type:               condType,
                Status:             status,
                ObservedGeneration: 0,
                LastTransitionTime: now,
                Reason:             reason,
                Message:            message,
            }
            m.obj.SetConditions(conditions)
            return
        }
    }

    // Condition doesn't exist — add it
    m.obj.SetConditions(append(conditions, metav1.Condition{
        Type:               condType,
        Status:             status,
        LastTransitionTime: now,
        Reason:             reason,
        Message:            message,
    }))
}

// IsTrue checks if a condition is True.
func (m *ConditionManager[T]) IsTrue(condType string) bool {
    for _, c := range m.obj.GetConditions() {
        if c.Type == condType {
            return c.Status == metav1.ConditionTrue
        }
    }
    return false
}

// SetReady sets the standard Ready condition.
func (m *ConditionManager[T]) SetReady(isReady bool, reason, message string) {
    status := metav1.ConditionFalse
    if isReady {
        status = metav1.ConditionTrue
    }
    m.Set("Ready", status, reason, message)
}

// Example implementation for a custom resource
type MyResource struct {
    metav1.TypeMeta   `json:",inline"`
    metav1.ObjectMeta `json:"metadata,omitempty"`
    Spec              MyResourceSpec   `json:"spec"`
    Status            MyResourceStatus `json:"status"`
}

type MyResourceStatus struct {
    Conditions []metav1.Condition `json:"conditions,omitempty"`
}

func (r *MyResource) GetConditions() []metav1.Condition {
    return r.Status.Conditions
}

func (r *MyResource) SetConditions(c []metav1.Condition) {
    r.Status.Conditions = c
}

// Usage in reconciler
func reconcile(ctx context.Context, obj *MyResource) error {
    cm := NewConditionManager(obj)

    if err := doWork(ctx, obj); err != nil {
        cm.SetReady(false, "WorkFailed", err.Error())
        cm.Set("Synced", metav1.ConditionFalse, "SyncError", err.Error())
        return err
    }

    cm.SetReady(true, "Ready", "All resources reconciled successfully")
    cm.Set("Synced", metav1.ConditionTrue, "Synced", "")
    return nil
}
```

## Section 7: Generic Owner References

Setting owner references is another repetitive operation in controllers:

```go
package ownership

import (
    "fmt"

    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
)

// SetOwner sets obj as owned by owner. Uses generics to ensure type safety.
func SetOwner[
    Owner any, OPtr Object[Owner],
    Owned any, OwnedPtr Object[Owned],
](
    scheme *runtime.Scheme,
    owner OPtr,
    owned OwnedPtr,
) error {
    return controllerutil.SetControllerReference(owner, owned, scheme)
}

// IsOwnedBy checks if an object is owned by the specified owner.
func IsOwnedBy[Owner any, OPtr Object[Owner]](
    owned client.Object,
    owner OPtr,
) bool {
    for _, ref := range owned.GetOwnerReferences() {
        if ref.UID == owner.GetUID() {
            return true
        }
    }
    return false
}

// FilterOwnedBy returns only objects from the list that are owned by owner.
func FilterOwnedBy[T any, PT Object[T], Owner any, OPtr Object[Owner]](
    objects []PT,
    owner OPtr,
) []PT {
    var owned []PT
    for _, obj := range objects {
        if IsOwnedBy[Owner, OPtr](obj, owner) {
            owned = append(owned, obj)
        }
    }
    return owned
}
```

## Section 8: Generic Finalizer Management

```go
package finalizer

import (
    "context"
    "fmt"

    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
)

// Manager handles finalizer lifecycle for a specific object type.
type Manager[T any, PT Object[T]] struct {
    client        client.Client
    finalizerName string
    cleanup       func(ctx context.Context, obj PT) error
}

// NewManager creates a finalizer manager.
func NewManager[T any, PT Object[T]](
    c client.Client,
    finalizerName string,
    cleanup func(ctx context.Context, obj PT) error,
) *Manager[T, PT] {
    return &Manager[T, PT]{
        client:        c,
        finalizerName: finalizerName,
        cleanup:       cleanup,
    }
}

// HandleFinalizer processes finalizer logic for an object.
// Returns (done, error) where done=true means reconciliation is complete.
func (m *Manager[T, PT]) HandleFinalizer(ctx context.Context, obj PT) (bool, error) {
    if obj.GetDeletionTimestamp().IsZero() {
        // Object is not being deleted — ensure finalizer is present
        if !controllerutil.ContainsFinalizer(obj, m.finalizerName) {
            controllerutil.AddFinalizer(obj, m.finalizerName)
            if err := m.client.Update(ctx, obj); err != nil {
                return false, fmt.Errorf("failed to add finalizer: %w", err)
            }
        }
        return false, nil
    }

    // Object is being deleted
    if controllerutil.ContainsFinalizer(obj, m.finalizerName) {
        // Run cleanup
        if err := m.cleanup(ctx, obj); err != nil {
            return false, fmt.Errorf("cleanup failed: %w", err)
        }

        // Remove finalizer
        controllerutil.RemoveFinalizer(obj, m.finalizerName)
        if err := m.client.Update(ctx, obj); err != nil {
            return false, fmt.Errorf("failed to remove finalizer: %w", err)
        }
    }

    return true, nil // Deletion in progress, stop reconciliation
}

// Usage in a reconciler
type DatabaseReconciler struct {
    client.Client
    finalizer *finalizer.Manager[myv1.Database, *myv1.Database]
}

func NewDatabaseReconciler(c client.Client) *DatabaseReconciler {
    r := &DatabaseReconciler{Client: c}
    r.finalizer = finalizer.NewManager[myv1.Database, *myv1.Database](
        c,
        "database.example.com/cleanup",
        func(ctx context.Context, db *myv1.Database) error {
            // Type-safe cleanup — db is *myv1.Database
            return r.cleanupDatabaseResources(ctx, db)
        },
    )
    return r
}

func (r *DatabaseReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    db, err := k8sclient.Get[myv1.Database](ctx, r.Client, req.NamespacedName)
    if err != nil {
        return ctrl.Result{}, client.IgnoreNotFound(err)
    }

    done, err := r.finalizer.HandleFinalizer(ctx, db)
    if err != nil || done {
        return ctrl.Result{}, err
    }

    // Normal reconciliation...
    return ctrl.Result{}, nil
}
```

## Section 9: Generic Retry and Conflict Resolution

```go
package retry

import (
    "context"
    "fmt"

    "k8s.io/apimachinery/pkg/api/errors"
    "sigs.k8s.io/controller-runtime/pkg/client"
)

// RetryOnConflict retries a mutating operation when there is a resource version conflict.
// The fetch function retrieves the latest version; mutate applies the desired changes.
func RetryOnConflict[T any, PT Object[T]](
    ctx context.Context,
    c client.Client,
    key client.ObjectKey,
    maxRetries int,
    mutate func(PT) error,
) error {
    for attempt := 0; attempt < maxRetries; attempt++ {
        obj := PT(new(T))
        if err := c.Get(ctx, key, obj); err != nil {
            return fmt.Errorf("get failed: %w", err)
        }

        if err := mutate(obj); err != nil {
            return fmt.Errorf("mutation failed: %w", err)
        }

        if err := c.Update(ctx, obj); err != nil {
            if errors.IsConflict(err) && attempt < maxRetries-1 {
                continue // Retry
            }
            return fmt.Errorf("update failed after %d attempts: %w", attempt+1, err)
        }

        return nil // Success
    }
    return fmt.Errorf("max retries (%d) exceeded", maxRetries)
}

// PatchStatus performs a status subresource patch with conflict retry.
func PatchStatus[T any, PT Object[T]](
    ctx context.Context,
    c client.Client,
    obj PT,
    mutate func(PT),
) error {
    patch := client.MergeFrom(obj.DeepCopyObject().(PT))
    mutate(obj)
    return c.Status().Patch(ctx, obj, patch)
}
```

## Section 10: Putting It All Together — A Complete Controller

```go
package controllers

import (
    "context"
    "fmt"

    appsv1 "k8s.io/api/apps/v1"
    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"

    myv1 "github.com/example/operator/api/v1"
    "github.com/example/operator/pkg/cache"
    "github.com/example/operator/pkg/conditions"
    "github.com/example/operator/pkg/finalizer"
    k8sclient "github.com/example/operator/pkg/k8sclient"
)

type WebAppReconciler struct {
    client.Client
    scheme        *runtime.Scheme
    deployCache   *cache.Cache[string, *appsv1.Deployment]
    finalizerMgr  *finalizer.Manager[myv1.WebApp, *myv1.WebApp]
}

func NewWebAppReconciler(mgr ctrl.Manager) *WebAppReconciler {
    r := &WebAppReconciler{
        Client:      mgr.GetClient(),
        scheme:      mgr.GetScheme(),
        deployCache: cache.NewCache[string, *appsv1.Deployment](30 * time.Second),
    }
    r.finalizerMgr = finalizer.NewManager[myv1.WebApp, *myv1.WebApp](
        mgr.GetClient(),
        "webapp.example.com/cleanup",
        r.cleanup,
    )
    return r
}

func (r *WebAppReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    // Type-safe Get
    app, err := k8sclient.Get[myv1.WebApp](ctx, r.Client, req.NamespacedName)
    if err != nil {
        return ctrl.Result{}, client.IgnoreNotFound(err)
    }

    // Generic finalizer handling
    done, err := r.finalizerMgr.HandleFinalizer(ctx, app)
    if err != nil || done {
        return ctrl.Result{}, err
    }

    // Generic condition management
    condMgr := conditions.NewConditionManager(app)

    // Reconcile the deployment
    if err := r.reconcileDeployment(ctx, app); err != nil {
        condMgr.SetReady(false, "DeploymentFailed", err.Error())
        if statusErr := r.Client.Status().Update(ctx, app); statusErr != nil {
            return ctrl.Result{}, statusErr
        }
        return ctrl.Result{}, err
    }

    condMgr.SetReady(true, "Reconciled", "Deployment is ready")
    if err := r.Client.Status().Update(ctx, app); err != nil {
        return ctrl.Result{}, err
    }

    return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
}

func (r *WebAppReconciler) reconcileDeployment(ctx context.Context, app *myv1.WebApp) error {
    desired := r.buildDeployment(app)

    return k8sclient.EnsureExists[appsv1.Deployment](
        ctx, r.Client, desired,
        func(existing, desired *appsv1.Deployment) {
            existing.Spec = desired.Spec
        },
    )
}

func (r *WebAppReconciler) cleanup(ctx context.Context, app *myv1.WebApp) error {
    // app is *myv1.WebApp — full type safety
    log.Printf("Cleaning up WebApp %s/%s", app.Namespace, app.Name)
    // ... cleanup logic
    return nil
}
```

## Summary

Go generics provide substantial value in Kubernetes operator code:

- Generic reconciler bases eliminate the boilerplate of type assertion in `Reconcile` methods
- Type-safe CRUD wrappers (`Get[T]`, `EnsureExists[T]`) surface type errors at compile time and reduce cognitive overhead
- Generic informer wrappers eliminate tombstone handling bugs and type assertion failures in event handlers
- Generic TTL caches are straightforward to implement and reuse across controllers without copying code
- Generic condition managers, finalizer managers, and retry utilities create a composable toolkit that makes individual controllers smaller and more focused

The key design constraint is the pointer type parameter pattern: since `client.Object` is implemented by pointer receivers, type parameters typically need two parameters `[T any, PT Object[T]]` where `PT` is `*T`. This is verbose but necessary given Go's current type system, and the `Object` constraint alias eliminates most of the repetition in practice.
