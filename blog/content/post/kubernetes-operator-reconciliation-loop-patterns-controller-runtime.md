---
title: "Kubernetes Operator Reconciliation Loop Patterns: Controller-Runtime Deep Dive"
date: 2029-12-05T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Operator", "controller-runtime", "Go", "Reconciliation", "Finalizers", "Owner References"]
categories:
- Kubernetes
- Go
- Operators
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide covering controller-runtime predicates, work queues, rate limiting, event filtering, owner references, and finalizer patterns for production Kubernetes operators."
more_link: "yes"
url: "/kubernetes-operator-reconciliation-loop-patterns-controller-runtime/"
---

Building production-grade Kubernetes operators requires deep understanding of how the controller-runtime reconciliation loop works under the hood. Most operator tutorials show you how to scaffold a basic reconciler, but the real complexity emerges when you need fine-grained control over event filtering, queue depth tuning, cascading ownership, and safe deletion via finalizers. This guide covers the patterns that separate toy operators from enterprise-grade controllers.

<!--more-->

## Understanding the Reconciliation Model

The controller-runtime library implements a level-triggered reconciliation model. Unlike edge-triggered systems that fire on every change event, level-triggered reconciliation fires when the current state differs from the desired state — and crucially, it re-enqueues failed reconciliations rather than dropping them.

The core interface is deceptively simple:

```go
type Reconciler interface {
    Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error)
}
```

`ctrl.Request` carries only the namespace/name of the object. The reconciler must fetch fresh state from the informer cache at the start of each reconciliation. This is intentional — by always working from the current observed state rather than from the delta that triggered the reconcile, you avoid a class of race conditions endemic to edge-triggered systems.

```go
func (r *MyAppReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    log := log.FromContext(ctx)

    // Always fetch fresh state — never rely on the triggering event's payload
    var app myv1.MyApp
    if err := r.Get(ctx, req.NamespacedName, &app); err != nil {
        if apierrors.IsNotFound(err) {
            // Object deleted before we could reconcile — not an error
            return ctrl.Result{}, nil
        }
        return ctrl.Result{}, fmt.Errorf("fetching MyApp: %w", err)
    }

    // Reconcile logic follows
    return r.reconcileApp(ctx, &app)
}
```

## Work Queue and Rate Limiting

The controller-runtime work queue wraps `client-go`'s `workqueue.RateLimitingInterface`. Understanding the default rate limiter behavior is critical for operators that interact with external APIs.

The default rate limiter uses a base delay of 5ms and a max delay of 1000s with exponential backoff per item. For operators that call cloud provider APIs, this can cause problems: a transient 429 from the AWS API might result in the item being retried every 5ms for the first few attempts, generating a burst that worsens the throttle.

Override the rate limiter with a custom implementation:

```go
import (
    "golang.org/x/time/rate"
    "k8s.io/client-go/util/workqueue"
    ctrl "sigs.k8s.io/controller-runtime"
)

func NewRateLimiter() workqueue.RateLimiter {
    return workqueue.NewMaxOfRateLimiter(
        // Per-item exponential backoff: 500ms base, 60s max
        workqueue.NewItemExponentialFailureRateLimiter(500*time.Millisecond, 60*time.Second),
        // Overall bucket: 10 QPS, burst of 100
        &workqueue.BucketRateLimiter{
            Limiter: rate.NewLimiter(rate.Limit(10), 100),
        },
    )
}

// Apply when building the controller
ctrl.NewControllerManagedBy(mgr).
    For(&myv1.MyApp{}).
    WithOptions(controller.Options{
        RateLimiter: NewRateLimiter(),
        MaxConcurrentReconciles: 5,
    }).
    Complete(r)
```

`MaxConcurrentReconciles` controls how many goroutines pull from the work queue simultaneously. The default is 1, which is safe but serializes all reconciliations. For operators managing large fleets (thousands of objects), increasing this value dramatically improves throughput. Ensure your reconciler is safe for concurrent execution — avoid shared mutable state outside the Kubernetes API.

## Predicates: Event Filtering at the Source

Without predicates, every Create, Update, Delete, and Generic event for your watched resources enqueues a reconcile request. For high-churn resources like Pods or ConfigMaps, this can overwhelm the queue. Predicates filter events before they reach the queue.

### Built-in Predicates

```go
import "sigs.k8s.io/controller-runtime/pkg/predicate"

ctrl.NewControllerManagedBy(mgr).
    For(&myv1.MyApp{}, builder.WithPredicates(
        // Only reconcile on generation changes (spec changes), not status updates
        predicate.GenerationChangedPredicate{},
    )).
    Complete(r)
```

`GenerationChangedPredicate` is one of the most important built-in predicates. The `metadata.generation` field increments only when the spec changes, not when status subresource updates occur. Without this predicate, every status patch your reconciler writes back triggers another reconcile, creating a tight loop.

### Custom Predicates

```go
// LabelChangedPredicate reconciles only when a specific label changes
type LabelChangedPredicate struct {
    predicate.Funcs
    LabelKey string
}

func (p LabelChangedPredicate) Update(e event.UpdateEvent) bool {
    oldVal := e.ObjectOld.GetLabels()[p.LabelKey]
    newVal := e.ObjectNew.GetLabels()[p.LabelKey]
    return oldVal != newVal
}

// AnnotationPredicate skips objects with a specific annotation
type SkipAnnotationPredicate struct {
    predicate.Funcs
    Annotation string
}

func (p SkipAnnotationPredicate) Create(e event.CreateEvent) bool {
    _, skip := e.Object.GetAnnotations()[p.Annotation]
    return !skip
}

func (p SkipAnnotationPredicate) Update(e event.UpdateEvent) bool {
    _, skip := e.ObjectNew.GetAnnotations()[p.Annotation]
    return !skip
}
```

Predicates compose with `predicate.And` and `predicate.Or`:

```go
ctrl.NewControllerManagedBy(mgr).
    For(&myv1.MyApp{}, builder.WithPredicates(
        predicate.And(
            predicate.GenerationChangedPredicate{},
            SkipAnnotationPredicate{Annotation: "myapp.io/skip-reconcile"},
        ),
    )).
    Complete(r)
```

## Watching Secondary Resources

A production operator typically manages multiple child resources (Deployments, Services, ConfigMaps). Changes to these children must trigger reconciliation of the parent. This is accomplished via `.Owns()` for resources you create, or `.Watches()` for resources you observe but don't own.

```go
ctrl.NewControllerManagedBy(mgr).
    For(&myv1.MyApp{}).
    // Owns() automatically sets owner references and enqueues the parent
    Owns(&appsv1.Deployment{}).
    Owns(&corev1.Service{}).
    // Watches() for resources without owner references — map to the parent manually
    Watches(
        &corev1.ConfigMap{},
        handler.EnqueueRequestsFromMapFunc(r.findAppsForConfigMap),
        builder.WithPredicates(predicate.ResourceVersionChangedPredicate{}),
    ).
    Complete(r)

func (r *MyAppReconciler) findAppsForConfigMap(ctx context.Context, obj client.Object) []reconcile.Request {
    cm := obj.(*corev1.ConfigMap)
    // Find all MyApp objects that reference this ConfigMap
    var appList myv1.MyAppList
    if err := r.List(ctx, &appList, client.InNamespace(cm.Namespace),
        client.MatchingFields{"spec.configMapRef": cm.Name}); err != nil {
        return nil
    }
    requests := make([]reconcile.Request, len(appList.Items))
    for i, app := range appList.Items {
        requests[i] = reconcile.Request{
            NamespacedName: types.NamespacedName{
                Name:      app.Name,
                Namespace: app.Namespace,
            },
        }
    }
    return requests
}
```

To enable field indexing used in the query above, register it with the manager's field indexer at startup:

```go
if err := mgr.GetFieldIndexer().IndexField(
    ctx,
    &myv1.MyApp{},
    "spec.configMapRef",
    func(obj client.Object) []string {
        app := obj.(*myv1.MyApp)
        if app.Spec.ConfigMapRef == "" {
            return nil
        }
        return []string{app.Spec.ConfigMapRef}
    },
); err != nil {
    return err
}
```

## Owner References and Cascading Deletion

Owner references are the mechanism by which Kubernetes implements garbage collection. When the owner object is deleted, the garbage collector deletes all objects that list it as an owner. Controller-runtime's `.Owns()` sets owner references automatically, but for cross-namespace or cluster-scoped scenarios you must manage them manually.

```go
import "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

func (r *MyAppReconciler) reconcileDeployment(ctx context.Context, app *myv1.MyApp) error {
    deploy := &appsv1.Deployment{
        ObjectMeta: metav1.ObjectMeta{
            Name:      app.Name,
            Namespace: app.Namespace,
        },
    }

    op, err := controllerutil.CreateOrUpdate(ctx, r.Client, deploy, func() error {
        // Set owner reference so the Deployment is garbage-collected with MyApp
        if err := controllerutil.SetControllerReference(app, deploy, r.Scheme); err != nil {
            return err
        }
        // Mutate spec
        deploy.Spec = buildDeploymentSpec(app)
        return nil
    })
    if err != nil {
        return fmt.Errorf("reconciling Deployment: %w", err)
    }
    log.FromContext(ctx).Info("Deployment reconciled", "operation", op)
    return nil
}
```

`CreateOrUpdate` is the idiomatic way to manage child resources. It fetches the current state, calls the mutate function, and either creates or patches as needed. The key insight is that the mutate function runs on the live object, so you must overwrite fields rather than replacing the object wholesale to avoid clobbering fields set by other controllers (like `status` or `resourceVersion`).

### Blocking Owner Deletion: foreground deletion policy

For resources where you need to run cleanup logic before the owned resource disappears, use the `foregroundDeletion` finalizer on child resources combined with `blockOwnerDeletion: true` on the owner reference:

```go
ownerRef := metav1.OwnerReference{
    APIVersion:         app.APIVersion,
    Kind:               app.Kind,
    Name:               app.Name,
    UID:                app.UID,
    Controller:         ptr.To(true),
    BlockOwnerDeletion: ptr.To(true),
}
```

## Finalizer Patterns

Finalizers are the correct mechanism for running pre-deletion cleanup — draining connections, deleting external resources, removing DNS records. A finalizer is simply a string in `metadata.finalizers`. The API server will not physically delete an object with non-empty finalizers; it sets `metadata.deletionTimestamp` and waits.

### The Three-Phase Finalizer Pattern

```go
const myAppFinalizer = "myapp.io/finalizer"

func (r *MyAppReconciler) reconcileApp(ctx context.Context, app *myv1.MyApp) (ctrl.Result, error) {
    log := log.FromContext(ctx)

    // Phase 1: Add finalizer on creation
    if !controllerutil.ContainsFinalizer(app, myAppFinalizer) {
        controllerutil.AddFinalizer(app, myAppFinalizer)
        if err := r.Update(ctx, app); err != nil {
            return ctrl.Result{}, fmt.Errorf("adding finalizer: %w", err)
        }
        // Re-fetch after update to get new resourceVersion
        return ctrl.Result{Requeue: true}, nil
    }

    // Phase 2: Handle deletion
    if !app.DeletionTimestamp.IsZero() {
        log.Info("Running pre-deletion cleanup", "name", app.Name)
        if err := r.cleanupExternalResources(ctx, app); err != nil {
            return ctrl.Result{}, fmt.Errorf("cleanup failed: %w", err)
        }
        // Phase 3: Remove finalizer to allow physical deletion
        controllerutil.RemoveFinalizer(app, myAppFinalizer)
        if err := r.Update(ctx, app); err != nil {
            return ctrl.Result{}, fmt.Errorf("removing finalizer: %w", err)
        }
        return ctrl.Result{}, nil
    }

    // Normal reconciliation path
    return r.reconcileNormalState(ctx, app)
}
```

### Idempotent Cleanup

The cleanup function must be idempotent because the reconciler may be interrupted and re-run multiple times during deletion. Check whether the external resource still exists before attempting to delete it:

```go
func (r *MyAppReconciler) cleanupExternalResources(ctx context.Context, app *myv1.MyApp) error {
    // Check if external resource exists
    exists, err := r.ExternalClient.ResourceExists(ctx, app.Spec.ExternalResourceID)
    if err != nil {
        return fmt.Errorf("checking external resource existence: %w", err)
    }
    if !exists {
        // Already cleaned up — idempotent success
        return nil
    }
    return r.ExternalClient.DeleteResource(ctx, app.Spec.ExternalResourceID)
}
```

## Status Conditions Pattern

Use `metav1.Condition` and the `apimachinery/pkg/api/meta` helpers to manage status conditions. Never set conditions directly; use `meta.SetStatusCondition` which handles transition timestamps correctly:

```go
import apimeta "k8s.io/apimachinery/pkg/api/meta"

func (r *MyAppReconciler) setReadyCondition(ctx context.Context, app *myv1.MyApp, ready bool, reason, msg string) error {
    status := metav1.ConditionFalse
    if ready {
        status = metav1.ConditionTrue
    }
    apimeta.SetStatusCondition(&app.Status.Conditions, metav1.Condition{
        Type:               "Ready",
        Status:             status,
        ObservedGeneration: app.Generation,
        Reason:             reason,
        Message:            msg,
    })
    // Use StatusClient to update status subresource only
    return r.Status().Update(ctx, app)
}
```

Always update status via the status subresource (`r.Status().Update`) rather than the main resource update. This avoids incrementing `metadata.generation` on status-only changes.

## Requeueing Strategies

`ctrl.Result` controls when the reconciler runs again:

```go
// No requeue — reconciler is done until next watch event
return ctrl.Result{}, nil

// Requeue after a fixed delay — useful for polling external state
return ctrl.Result{RequeueAfter: 30 * time.Second}, nil

// Requeue immediately (next queue slot) — use sparingly; prefer events
return ctrl.Result{Requeue: true}, nil

// Return an error — triggers exponential backoff via the rate limiter
return ctrl.Result{}, fmt.Errorf("transient failure: %w", err)
```

The distinction between returning an error and `RequeueAfter` matters for observability. Errors increment the work queue failure metric and appear in controller logs with stack context. `RequeueAfter` is silent. Use errors for genuine failures; use `RequeueAfter` for expected polling scenarios.

## Testing Reconcilers with envtest

The `envtest` package starts a real API server and etcd without the full kubelet, allowing integration tests that exercise the full reconciliation path:

```go
import (
    "sigs.k8s.io/controller-runtime/pkg/envtest"
)

var (
    testEnv   *envtest.Environment
    k8sClient client.Client
)

func TestMain(m *testing.M) {
    testEnv = &envtest.Environment{
        CRDDirectoryPaths: []string{filepath.Join("..", "..", "config", "crd", "bases")},
    }
    cfg, err := testEnv.Start()
    // ... setup manager and reconciler ...
    os.Exit(m.Run())
}

func TestMyAppReconciler_CreatesDeployment(t *testing.T) {
    ctx := context.Background()
    app := &myv1.MyApp{
        ObjectMeta: metav1.ObjectMeta{Name: "test-app", Namespace: "default"},
        Spec:       myv1.MyAppSpec{Replicas: 3},
    }
    require.NoError(t, k8sClient.Create(ctx, app))

    // Poll for the Deployment to appear
    var deploy appsv1.Deployment
    require.Eventually(t, func() bool {
        err := k8sClient.Get(ctx, types.NamespacedName{
            Name: "test-app", Namespace: "default",
        }, &deploy)
        return err == nil
    }, 10*time.Second, 100*time.Millisecond)

    assert.Equal(t, int32(3), *deploy.Spec.Replicas)
}
```

## Production Checklist

Before shipping an operator to production, validate these properties:

- **Idempotency**: Running reconcile N times on the same input produces the same result as running it once.
- **Finalizer safety**: If the pod running the controller crashes mid-deletion, the next instance picks up and completes cleanup correctly.
- **Generation guard**: Status updates do not trigger infinite reconcile loops. Use `GenerationChangedPredicate` or check `ObservedGeneration`.
- **Panic recovery**: The controller-runtime manager installs a recover wrapper, but log and alert on panics — they indicate bugs, not transient failures.
- **Leader election**: For HA deployments, enable leader election. Only the leader reconciles; others stand by.
- **Metrics**: Expose `controller_runtime_reconcile_total`, `controller_runtime_reconcile_errors_total`, and `controller_runtime_reconcile_time_seconds` via the manager's metrics server.

```go
mgr, err := ctrl.NewManager(cfg, ctrl.Options{
    Scheme:                 scheme,
    MetricsBindAddress:     ":8080",
    HealthProbeBindAddress: ":8081",
    LeaderElection:         true,
    LeaderElectionID:       "myapp-controller-leader",
})
```

Controller-runtime operators that follow these patterns handle production traffic reliably, scale to thousands of managed objects, and survive rolling restarts and leader failovers without data loss or orphaned resources.
