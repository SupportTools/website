---
title: "Kubernetes Finalizers: Preventing Premature Deletion and Cleanup Patterns"
date: 2029-09-09T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Finalizers", "Garbage Collection", "Controllers", "Operators"]
categories: ["Kubernetes", "Development"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Kubernetes finalizers: how they prevent premature object deletion, garbage collection mechanics, ownerReferences, cleanup controller patterns, and common finalizer removal gotchas in production environments."
more_link: "yes"
url: "/kubernetes-finalizers-cleanup-patterns/"
---

Finalizers are one of the more subtle Kubernetes primitives, but they underpin critical cleanup workflows. Without proper finalizer usage, operators can delete Kubernetes objects while the external resources they represent still exist — leaving orphaned cloud resources, stale DNS entries, or broken infrastructure. This post covers the complete finalizer lifecycle, the relationship between finalizers and garbage collection, ownerReferences patterns, and how to write cleanup controllers that are resilient to restarts and partial failures.

<!--more-->

# Kubernetes Finalizers: Preventing Premature Deletion and Cleanup Patterns

## What Finalizers Do

A finalizer is a string in a Kubernetes object's `metadata.finalizers` slice that prevents the API server from deleting the object until all finalizers are removed. The full deletion sequence is:

1. Client sends DELETE request to the API server
2. API server sets `metadata.deletionTimestamp` to the current time (instead of immediately deleting)
3. The object now has a "deletion in progress" status — it is immutable except for removing finalizers
4. Controller(s) watching this object type detect the `deletionTimestamp` and perform cleanup
5. After cleanup, each controller removes its finalizer string
6. When `metadata.finalizers` is empty, the API server deletes the object

```yaml
# Object before deletion is requested
apiVersion: myapp.example.com/v1
kind: Database
metadata:
  name: production-db
  namespace: data
  finalizers:
    - databases.myapp.example.com/cleanup-external-resources
    - databases.myapp.example.com/remove-dns-record
spec:
  engine: postgresql
  version: "15"
  storageGB: 500
```

After a DELETE request:

```yaml
apiVersion: myapp.example.com/v1
kind: Database
metadata:
  name: production-db
  namespace: data
  deletionTimestamp: "2029-09-09T14:30:00Z"   # Set by API server
  finalizers:
    - databases.myapp.example.com/cleanup-external-resources
    - databases.myapp.example.com/remove-dns-record
  # DeletionGracePeriodSeconds may also be set
```

## Adding Finalizers

Finalizers should be added when an object is first created (or first reconciled), not later. Adding a finalizer to an object that already exists works too, but there is a brief window where the object could be deleted without finalizer processing if the controller is not watching.

### In a Controller Reconciler

```go
package controllers

import (
    "context"
    "fmt"

    myappv1 "github.com/example/my-operator/api/v1"
    "k8s.io/apimachinery/pkg/api/errors"
    "k8s.io/apimachinery/pkg/runtime"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
)

const (
    databaseFinalizer = "databases.myapp.example.com/cleanup"
)

type DatabaseReconciler struct {
    client.Client
    Scheme *runtime.Scheme
}

func (r *DatabaseReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    log := ctrl.LoggerFrom(ctx)

    // Fetch the Database object
    db := &myappv1.Database{}
    if err := r.Get(ctx, req.NamespacedName, db); err != nil {
        if errors.IsNotFound(err) {
            // Object deleted before we reconciled - nothing to do
            return ctrl.Result{}, nil
        }
        return ctrl.Result{}, fmt.Errorf("failed to get Database: %w", err)
    }

    // Check if the object is being deleted
    if !db.DeletionTimestamp.IsZero() {
        // Object is marked for deletion; perform cleanup
        if controllerutil.ContainsFinalizer(db, databaseFinalizer) {
            if err := r.cleanup(ctx, db); err != nil {
                log.Error(err, "Failed to clean up database external resources")
                // Return error to requeue; do NOT remove finalizer until cleanup succeeds
                return ctrl.Result{}, err
            }

            // Cleanup succeeded; remove finalizer so object can be deleted
            controllerutil.RemoveFinalizer(db, databaseFinalizer)
            if err := r.Update(ctx, db); err != nil {
                return ctrl.Result{}, fmt.Errorf("failed to remove finalizer: %w", err)
            }
        }
        return ctrl.Result{}, nil
    }

    // Object is not being deleted; ensure finalizer is present
    if !controllerutil.ContainsFinalizer(db, databaseFinalizer) {
        controllerutil.AddFinalizer(db, databaseFinalizer)
        if err := r.Update(ctx, db); err != nil {
            return ctrl.Result{}, fmt.Errorf("failed to add finalizer: %w", err)
        }
        // Requeue to continue reconciliation after adding finalizer
        return ctrl.Result{Requeue: true}, nil
    }

    // Normal reconciliation: ensure desired state
    return r.reconcileNormalState(ctx, db)
}

func (r *DatabaseReconciler) cleanup(ctx context.Context, db *myappv1.Database) error {
    log := ctrl.LoggerFrom(ctx)
    log.Info("Cleaning up external resources", "database", db.Name)

    // Delete cloud database instance
    if err := r.deleteCloudDatabase(ctx, db); err != nil {
        return fmt.Errorf("failed to delete cloud database: %w", err)
    }

    // Remove DNS record
    if err := r.removeDNSRecord(ctx, db); err != nil {
        return fmt.Errorf("failed to remove DNS record: %w", err)
    }

    // Remove monitoring dashboards
    if err := r.removeMonitoring(ctx, db); err != nil {
        // Non-critical: log but don't fail cleanup
        log.Error(err, "Failed to remove monitoring dashboard (non-critical)")
    }

    log.Info("Cleanup completed successfully")
    return nil
}

func (r *DatabaseReconciler) deleteCloudDatabase(ctx context.Context, db *myappv1.Database) error {
    // Implementation depends on your cloud provider SDK
    // Example with idempotency check:
    exists, err := r.cloudClient.DatabaseExists(ctx, db.Status.CloudID)
    if err != nil {
        return err
    }
    if !exists {
        // Already deleted; cleanup is idempotent
        return nil
    }
    return r.cloudClient.DeleteDatabase(ctx, db.Status.CloudID)
}

func (r *DatabaseReconciler) reconcileNormalState(ctx context.Context, db *myappv1.Database) (ctrl.Result, error) {
    // Normal reconciliation logic here
    return ctrl.Result{}, nil
}

func (r *DatabaseReconciler) removeDNSRecord(ctx context.Context, db *myappv1.Database) error {
    return nil
}

func (r *DatabaseReconciler) removeMonitoring(ctx context.Context, db *myappv1.Database) error {
    return nil
}
```

## ownerReferences and Garbage Collection

ownerReferences implement parent-child relationships between Kubernetes objects. When the owner is deleted, Kubernetes garbage collection automatically deletes all owned objects.

### Setting ownerReferences

```go
package controllers

import (
    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime/schema"
    "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
)

// SetOwnerReference makes parent the owner of child.
// When parent is deleted, child will be automatically garbage collected.
func setOwnerReference(parent, child metav1.Object, parentGVK schema.GroupVersionKind) {
    child.SetOwnerReferences([]metav1.OwnerReference{
        {
            APIVersion:         parentGVK.GroupVersion().String(),
            Kind:               parentGVK.Kind,
            Name:               parent.GetName(),
            UID:                parent.GetUID(),
            Controller:         boolPtr(true),    // This is the controlling owner
            BlockOwnerDeletion: boolPtr(true),    // Block deletion until child is gone
        },
    })
}

// Using controller-runtime's SetControllerReference (preferred)
func (r *DatabaseReconciler) ensureConfigMap(ctx context.Context, db *myappv1.Database) error {
    cm := &corev1.ConfigMap{
        ObjectMeta: metav1.ObjectMeta{
            Name:      fmt.Sprintf("%s-config", db.Name),
            Namespace: db.Namespace,
        },
        Data: map[string]string{
            "database-url": fmt.Sprintf("postgres://db.%s.svc.cluster.local:5432/%s",
                db.Namespace, db.Name),
        },
    }

    // Set Database as the owner of this ConfigMap
    // When the Database is deleted, the ConfigMap is automatically deleted
    if err := controllerutil.SetControllerReference(db, cm, r.Scheme); err != nil {
        return err
    }

    // CreateOrUpdate handles the idempotency
    _, err := controllerutil.CreateOrUpdate(ctx, r.Client, cm, func() error {
        cm.Data["database-url"] = fmt.Sprintf("postgres://db.%s.svc.cluster.local:5432/%s",
            db.Namespace, db.Name)
        return nil
    })
    return err
}

func boolPtr(b bool) *bool { return &b }
```

### Garbage Collection Policies

When an owner is deleted, the garbage collector can use three deletion policies:

```go
// Foreground deletion: owner is "terminating" until all owned objects are gone
// Use this when you need to wait for children to be cleaned up before owner disappears
deletePolicy := metav1.DeletePropagationForeground
err := r.Delete(ctx, db, &client.DeleteOptions{
    PropagationPolicy: &deletePolicy,
})

// Background deletion: owner disappears immediately; GC deletes children asynchronously
// Default behavior if no policy specified
deletePolicy := metav1.DeletePropagationBackground

// Orphan: owner is deleted but owned objects are NOT deleted
// Use when you want to preserve child resources after parent deletion
deletePolicy := metav1.DeletePropagationOrphan
```

The difference between foreground deletion and finalizers:
- `Foreground` deletion blocks until owned objects are gone (via `foregroundDeletion` finalizer added by kube-controller-manager)
- Custom finalizers block until your controller performs arbitrary cleanup logic

## Multi-Finalizer Coordination

When multiple controllers each add their own finalizer, they must coordinate cleanup:

```yaml
metadata:
  finalizers:
    - infrastructure.myapp.com/delete-cloud-lb
    - networking.myapp.com/remove-dns
    - monitoring.myapp.com/archive-metrics
```

Each finalizer is owned by a different controller. They can run cleanup concurrently because each controller only removes its own finalizer:

```go
// Infrastructure controller
func (r *InfraController) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    obj := &myappv1.Application{}
    if err := r.Get(ctx, req.NamespacedName, obj); err != nil {
        return ctrl.Result{}, client.IgnoreNotFound(err)
    }

    const myFinalizer = "infrastructure.myapp.com/delete-cloud-lb"

    if !obj.DeletionTimestamp.IsZero() {
        if controllerutil.ContainsFinalizer(obj, myFinalizer) {
            if err := r.deleteLoadBalancer(ctx, obj); err != nil {
                return ctrl.Result{}, err
            }
            // Only remove OUR finalizer; other controllers handle theirs
            controllerutil.RemoveFinalizer(obj, myFinalizer)
            return ctrl.Result{}, r.Update(ctx, obj)
        }
    }
    // ... normal reconciliation
    return ctrl.Result{}, nil
}
```

The object is only deleted when ALL finalizers have been removed — ensuring all controllers complete their cleanup before the object disappears.

## Finalizer Removal Gotchas

### Conflict on Update

Removing a finalizer requires an Update call that may conflict if another controller also modified the object. Use retry logic:

```go
import (
    "k8s.io/apimachinery/pkg/util/retry"
    "sigs.k8s.io/controller-runtime/pkg/client"
)

func (r *DatabaseReconciler) removeFinalizer(ctx context.Context, db *myappv1.Database) error {
    return retry.RetryOnConflict(retry.DefaultRetry, func() error {
        // Re-fetch to get latest resourceVersion
        latest := &myappv1.Database{}
        if err := r.Get(ctx, client.ObjectKeyFromObject(db), latest); err != nil {
            return err
        }

        if !controllerutil.ContainsFinalizer(latest, databaseFinalizer) {
            // Another reconcile already removed it
            return nil
        }

        controllerutil.RemoveFinalizer(latest, databaseFinalizer)
        return r.Update(ctx, latest)
    })
}
```

### Cleanup Idempotency is Critical

The controller may restart mid-cleanup. The cleanup function MUST be idempotent — safe to call multiple times:

```go
func (r *DatabaseReconciler) deleteCloudDatabase(ctx context.Context, db *myappv1.Database) error {
    if db.Status.CloudID == "" {
        // Never created externally; nothing to clean up
        return nil
    }

    // Idempotent: check existence before deleting
    exists, err := r.cloudAPI.Exists(ctx, db.Status.CloudID)
    if err != nil {
        return fmt.Errorf("checking existence of cloud resource %s: %w", db.Status.CloudID, err)
    }

    if !exists {
        // Already deleted (possibly from a previous reconcile attempt)
        return nil
    }

    // Delete with context for timeout
    deleteCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
    defer cancel()

    if err := r.cloudAPI.Delete(deleteCtx, db.Status.CloudID); err != nil {
        return fmt.Errorf("deleting cloud resource %s: %w", db.Status.CloudID, err)
    }

    return nil
}
```

### Do Not Block Indefinitely

If cleanup requires waiting for an external system, use exponential backoff with a timeout rather than blocking indefinitely:

```go
func (r *DatabaseReconciler) waitForDeletion(ctx context.Context, cloudID string) error {
    // Poll with exponential backoff
    backoff := wait.Backoff{
        Steps:    10,
        Duration: 5 * time.Second,
        Factor:   2.0,
        Jitter:   0.1,
        Cap:      5 * time.Minute,
    }

    return wait.ExponentialBackoffWithContext(ctx, backoff, func(ctx context.Context) (bool, error) {
        status, err := r.cloudAPI.GetStatus(ctx, cloudID)
        if err != nil {
            return false, err  // Actual error; stop retrying
        }
        if status == "DELETED" {
            return true, nil   // Done
        }
        if status == "DELETING" {
            return false, nil  // Still in progress; retry
        }
        return false, fmt.Errorf("unexpected status: %s", status)
    })
}
```

### Finalizer on Namespace Deletion

When a namespace is deleted, all objects in it are deleted. If those objects have finalizers and your controller is not running (or crashes), the namespace will be stuck in "Terminating" state indefinitely.

Best practices to avoid stuck namespaces:
1. Ensure your controller has high availability (multiple replicas)
2. Set a timeout in cleanup: if cleanup takes too long, log a warning and remove the finalizer anyway
3. For critical systems, implement a "forced cleanup" mechanism triggered by annotation

```go
func (r *DatabaseReconciler) cleanup(ctx context.Context, db *myappv1.Database) error {
    // Check for forced cleanup annotation
    if db.Annotations["myapp.example.com/force-delete"] == "true" {
        log := ctrl.LoggerFrom(ctx)
        log.Warning("Force-delete annotation set; skipping external cleanup",
            "database", db.Name)
        return nil
    }

    // Normal cleanup with timeout
    cleanupCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
    defer cancel()

    return r.performCleanup(cleanupCtx, db)
}
```

## Status Conditions During Finalizer Processing

Use status conditions to communicate cleanup progress:

```go
import (
    "k8s.io/apimachinery/pkg/api/meta"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func (r *DatabaseReconciler) setCleanupCondition(ctx context.Context,
    db *myappv1.Database, status metav1.ConditionStatus, reason, message string) error {

    meta.SetStatusCondition(&db.Status.Conditions, metav1.Condition{
        Type:               "CleanupInProgress",
        Status:             status,
        ObservedGeneration: db.Generation,
        LastTransitionTime: metav1.Now(),
        Reason:             reason,
        Message:            message,
    })

    return r.Status().Update(ctx, db)
}

func (r *DatabaseReconciler) cleanup(ctx context.Context, db *myappv1.Database) error {
    // Mark cleanup as in progress
    if err := r.setCleanupCondition(ctx, db,
        metav1.ConditionTrue,
        "CleanupStarted",
        "Deleting external cloud resources"); err != nil {
        return err
    }

    if err := r.deleteCloudDatabase(ctx, db); err != nil {
        _ = r.setCleanupCondition(ctx, db,
            metav1.ConditionFalse,
            "CloudDeleteFailed",
            err.Error())
        return err
    }

    if err := r.removeDNSRecord(ctx, db); err != nil {
        _ = r.setCleanupCondition(ctx, db,
            metav1.ConditionFalse,
            "DNSRemovalFailed",
            err.Error())
        return err
    }

    _ = r.setCleanupCondition(ctx, db,
        metav1.ConditionFalse,
        "CleanupComplete",
        "All external resources deleted")
    return nil
}
```

## The foregroundDeletion Finalizer

Kubernetes itself uses finalizers internally. When you request foreground deletion, kube-controller-manager adds `foregroundDeletion` to the object's finalizers and waits for all owned objects to be deleted before removing it.

```bash
# Request foreground deletion
kubectl delete database production-db --cascade=foreground

# Observe the foregroundDeletion finalizer added
kubectl get database production-db -o yaml
# metadata:
#   finalizers:
#   - foregroundDeletion

# Objects in "Terminating" state with foregroundDeletion finalizer
kubectl get database production-db
# NAME            STATUS       AGE
# production-db   Terminating  5m
```

If the foreground deletion is stuck (because an owned object also has finalizers and its controller is not running), you can investigate:

```bash
# Check owned objects still present
kubectl get all -n data -l app=production-db

# Check if owned objects have finalizers
kubectl get pods -n data -o json | jq '.items[].metadata.finalizers'

# Emergency: remove stuck finalizer (use with caution!)
kubectl patch database production-db -p '{"metadata":{"finalizers":[]}}' --type=merge
```

## Webhook Validation for Finalizer Protection

You can add a validating webhook that prevents removal of critical finalizers unless specific conditions are met:

```go
package webhooks

import (
    "context"
    "fmt"
    "net/http"

    admissionv1 "k8s.io/api/admission/v1"
    "sigs.k8s.io/controller-runtime/pkg/webhook/admission"
)

type DatabaseValidator struct {
    decoder admission.Decoder
}

func (v *DatabaseValidator) Handle(ctx context.Context, req admission.Request) admission.Response {
    if req.Operation != admissionv1.Update {
        return admission.Allowed("not an update")
    }

    oldDB := &myappv1.Database{}
    if err := v.decoder.DecodeRaw(req.OldObject, oldDB); err != nil {
        return admission.Errored(http.StatusBadRequest, err)
    }

    newDB := &myappv1.Database{}
    if err := v.decoder.Decode(req, newDB); err != nil {
        return admission.Errored(http.StatusBadRequest, err)
    }

    // Prevent finalizer removal unless deletionTimestamp is set
    if newDB.DeletionTimestamp.IsZero() {
        hadFinalizer := containsFinalizer(oldDB.Finalizers, databaseFinalizer)
        hasFinalizer := containsFinalizer(newDB.Finalizers, databaseFinalizer)

        if hadFinalizer && !hasFinalizer {
            return admission.Denied(
                "finalizer can only be removed when object is being deleted")
        }
    }

    return admission.Allowed("validation passed")
}

func containsFinalizer(finalizers []string, finalizer string) bool {
    for _, f := range finalizers {
        if f == finalizer {
            return true
        }
    }
    return false
}
```

## Testing Finalizer Logic

```go
package controllers_test

import (
    "context"
    "testing"
    "time"

    . "github.com/onsi/ginkgo/v2"
    . "github.com/onsi/gomega"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "sigs.k8s.io/controller-runtime/pkg/client"
)

var _ = Describe("DatabaseReconciler", func() {
    Context("when deleting a database", func() {
        It("should clean up external resources before finalizer removal", func() {
            ctx := context.Background()

            // Create the database object
            db := &myappv1.Database{
                ObjectMeta: metav1.ObjectMeta{
                    Name:      "test-db",
                    Namespace: "default",
                },
                Spec: myappv1.DatabaseSpec{
                    Engine: "postgresql",
                },
            }
            Expect(k8sClient.Create(ctx, db)).To(Succeed())

            // Wait for finalizer to be added
            Eventually(func() []string {
                _ = k8sClient.Get(ctx, client.ObjectKeyFromObject(db), db)
                return db.Finalizers
            }, 10*time.Second, 100*time.Millisecond).Should(
                ContainElement(databaseFinalizer))

            // Delete the object
            Expect(k8sClient.Delete(ctx, db)).To(Succeed())

            // Verify deletionTimestamp is set but object still exists
            Eventually(func() *metav1.Time {
                _ = k8sClient.Get(ctx, client.ObjectKeyFromObject(db), db)
                return db.DeletionTimestamp
            }, 5*time.Second).ShouldNot(BeNil())

            // Verify external cleanup was called (mock verification)
            Eventually(func() bool {
                return mockCloudAPI.DeleteCalled
            }, 30*time.Second).Should(BeTrue())

            // Verify finalizer is removed and object is gone
            Eventually(func() bool {
                err := k8sClient.Get(ctx, client.ObjectKeyFromObject(db), db)
                return errors.IsNotFound(err)
            }, 30*time.Second).Should(BeTrue())
        })
    })
})
```

## Summary

Finalizers are the correct mechanism for ensuring cleanup of resources that exist outside the Kubernetes object store. Key principles:

- Add finalizers when an object is first reconciled, before creating external resources
- Only remove your own finalizer; never remove another controller's finalizer
- Make cleanup logic idempotent — the controller can restart and replay cleanup at any time
- Use `retry.RetryOnConflict` when removing finalizers to handle concurrent updates
- Avoid blocking indefinitely; implement timeouts and forced-cleanup escape hatches
- ownerReferences handle in-cluster garbage collection; finalizers handle external resource cleanup
- Status conditions communicate cleanup progress to users and monitoring systems
- Foreground deletion adds the `foregroundDeletion` finalizer managed by kube-controller-manager
- Validating webhooks can prevent unauthorized finalizer removal on critical objects
