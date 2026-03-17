---
title: "Kubernetes Operator Patterns: Reconciliation Loops, Finalizers, and Owner References"
date: 2029-02-18T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Operators", "Go", "controller-runtime", "CRD", "Reconciliation"]
categories:
- Kubernetes
- Development
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to building production-grade Kubernetes operators using reconciliation loop design, finalizer lifecycle management, and owner reference garbage collection patterns."
more_link: "yes"
url: "/kubernetes-operator-patterns-reconciliation-finalizers-enterprise/"
---

Kubernetes operators represent the highest form of infrastructure automation — encoding operational knowledge directly into the control plane. When implemented correctly, operators eliminate entire categories of manual toil, enforce invariants that humans routinely miss under pressure, and enable self-healing behaviors that scale across thousands of clusters. When implemented poorly, they become a source of infinite loops, resource leaks, cascading failures, and undebuggable state drift.

This guide examines the foundational patterns that separate production-grade operators from fragile prototypes: reconciliation loop design, finalizer lifecycle management, and owner reference garbage collection. Each section presents concrete implementation patterns drawn from real-world operator development, with particular attention to edge cases that only surface under production load.

<!--more-->

## The Reconciliation Loop: Design Principles

The reconciliation loop is the central abstraction of the operator pattern. At its core, the reconciler receives a namespaced name, fetches the current object from the API server, compares desired state to actual state, and drives the system toward convergence. This sounds simple. The complexity emerges from the properties the loop must maintain.

### Idempotency as a First-Class Constraint

Every reconciliation must be idempotent. The control plane guarantees at-least-once delivery — the same event may be delivered multiple times, the loop may be interrupted mid-execution, and the operator may restart at any point. Code that creates resources without checking for prior existence will accumulate duplicates. Code that assumes a prior step completed will panic on nil dereferences.

```go
package controllers

import (
    "context"
    "fmt"

    appsv1 "k8s.io/api/apps/v1"
    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/api/errors"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime"
    "k8s.io/apimachinery/pkg/types"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/log"

    myv1alpha1 "example.com/myoperator/api/v1alpha1"
)

type AppReconciler struct {
    client.Client
    Scheme *runtime.Scheme
}

func (r *AppReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    logger := log.FromContext(ctx).WithValues("app", req.NamespacedName)

    // Fetch the App instance. Not-found is not an error — the object was deleted.
    app := &myv1alpha1.App{}
    if err := r.Get(ctx, req.NamespacedName, app); err != nil {
        if errors.IsNotFound(err) {
            logger.Info("App resource not found, likely deleted")
            return ctrl.Result{}, nil
        }
        return ctrl.Result{}, fmt.Errorf("fetching App: %w", err)
    }

    // Reconcile the Deployment owned by this App.
    if err := r.reconcileDeployment(ctx, app); err != nil {
        return ctrl.Result{}, fmt.Errorf("reconciling Deployment: %w", err)
    }

    // Reconcile the Service owned by this App.
    if err := r.reconcileService(ctx, app); err != nil {
        return ctrl.Result{}, fmt.Errorf("reconciling Service: %w", err)
    }

    // Update status to reflect current observed state.
    if err := r.updateStatus(ctx, app); err != nil {
        return ctrl.Result{}, fmt.Errorf("updating status: %w", err)
    }

    return ctrl.Result{}, nil
}

func (r *AppReconciler) reconcileDeployment(ctx context.Context, app *myv1alpha1.App) error {
    desired := r.desiredDeployment(app)

    // Set owner reference so the Deployment is garbage collected with the App.
    if err := ctrl.SetControllerReference(app, desired, r.Scheme); err != nil {
        return fmt.Errorf("setting controller reference: %w", err)
    }

    existing := &appsv1.Deployment{}
    err := r.Get(ctx, types.NamespacedName{
        Name:      desired.Name,
        Namespace: desired.Namespace,
    }, existing)

    if errors.IsNotFound(err) {
        return r.Create(ctx, desired)
    }
    if err != nil {
        return fmt.Errorf("getting Deployment: %w", err)
    }

    // Patch only the fields we own, preserving fields set by other controllers.
    patch := client.MergeFrom(existing.DeepCopy())
    existing.Spec.Replicas = desired.Spec.Replicas
    existing.Spec.Template.Spec.Containers = desired.Spec.Template.Spec.Containers
    existing.Labels = desired.Labels

    return r.Patch(ctx, existing, patch)
}

func (r *AppReconciler) desiredDeployment(app *myv1alpha1.App) *appsv1.Deployment {
    labels := map[string]string{
        "app.kubernetes.io/name":       app.Name,
        "app.kubernetes.io/managed-by": "myoperator",
    }
    replicas := app.Spec.Replicas
    return &appsv1.Deployment{
        ObjectMeta: metav1.ObjectMeta{
            Name:      app.Name,
            Namespace: app.Namespace,
            Labels:    labels,
        },
        Spec: appsv1.DeploymentSpec{
            Replicas: &replicas,
            Selector: &metav1.LabelSelector{MatchLabels: labels},
            Template: corev1.PodTemplateSpec{
                ObjectMeta: metav1.ObjectMeta{Labels: labels},
                Spec: corev1.PodSpec{
                    Containers: []corev1.Container{
                        {
                            Name:  "app",
                            Image: app.Spec.Image,
                            Ports: []corev1.ContainerPort{
                                {ContainerPort: 8080, Protocol: corev1.ProtocolTCP},
                            },
                        },
                    },
                },
            },
        },
    }
}
```

### Returning Results: Requeue Semantics

The `ctrl.Result` return value controls whether and when the reconciler runs again. Understanding the semantics prevents both missed reconciliations and tight CPU-burning loops.

```go
// Do not requeue — the watch will trigger the next reconciliation when state changes.
return ctrl.Result{}, nil

// Requeue after a specific duration — used for polling external systems.
return ctrl.Result{RequeueAfter: 30 * time.Second}, nil

// Requeue immediately — use sparingly, typically when a resource is not yet ready.
return ctrl.Result{Requeue: true}, nil

// Return an error — the workqueue will requeue with exponential backoff.
// Maximum backoff is typically 1000 seconds with controller-runtime defaults.
return ctrl.Result{}, fmt.Errorf("transient failure: %w", err)
```

The distinction between `RequeueAfter` and returning an error matters significantly. Errors trigger exponential backoff, which is appropriate for transient failures but not for known polling intervals. Use `RequeueAfter` when the operator needs to check back at a predictable cadence — for example, waiting for a database to become ready, or polling an external API.

### Error Handling and Status Conditions

Production operators must distinguish between transient errors (API unavailability, rate limiting) and permanent errors (invalid configuration, unsupported resource version). The standard mechanism is the `metav1.Condition` type on the status subresource.

```go
func (r *AppReconciler) updateStatus(ctx context.Context, app *myv1alpha1.App) error {
    patch := client.MergeFrom(app.DeepCopy())

    // Compute observed generation to detect stale status.
    app.Status.ObservedGeneration = app.Generation

    // Set a Condition indicating successful reconciliation.
    meta.SetStatusCondition(&app.Status.Conditions, metav1.Condition{
        Type:               "Ready",
        Status:             metav1.ConditionTrue,
        ObservedGeneration: app.Generation,
        Reason:             "ReconciliationSucceeded",
        Message:            "All owned resources are present and correctly configured",
    })

    return r.Status().Patch(ctx, app, patch)
}

func setDegradedCondition(app *myv1alpha1.App, reason, message string) {
    meta.SetStatusCondition(&app.Status.Conditions, metav1.Condition{
        Type:               "Ready",
        Status:             metav1.ConditionFalse,
        ObservedGeneration: app.Generation,
        Reason:             reason,
        Message:            message,
    })
}
```

## Finalizers: Ensuring Cleanup on Deletion

Kubernetes uses finalizers to implement pre-deletion hooks. A finalizer is a string in `metadata.finalizers` that prevents the API server from deleting the object until the finalizer is removed. The operator is responsible for performing cleanup and then removing the finalizer.

### The Finalizer Pattern

```go
const myFinalizer = "myoperator.example.com/finalizer"

func (r *AppReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    logger := log.FromContext(ctx)

    app := &myv1alpha1.App{}
    if err := r.Get(ctx, req.NamespacedName, app); err != nil {
        if errors.IsNotFound(err) {
            return ctrl.Result{}, nil
        }
        return ctrl.Result{}, err
    }

    // Check if the object is being deleted.
    if !app.DeletionTimestamp.IsZero() {
        return r.handleDeletion(ctx, app)
    }

    // Add finalizer if not present.
    if !controllerutil.ContainsFinalizer(app, myFinalizer) {
        patch := client.MergeFrom(app.DeepCopy())
        controllerutil.AddFinalizer(app, myFinalizer)
        if err := r.Patch(ctx, app, patch); err != nil {
            return ctrl.Result{}, fmt.Errorf("adding finalizer: %w", err)
        }
        // Patching the object will trigger a new reconciliation automatically.
        return ctrl.Result{}, nil
    }

    // Normal reconciliation path.
    return r.reconcileNormal(ctx, app)
}

func (r *AppReconciler) handleDeletion(ctx context.Context, app *myv1alpha1.App) (ctrl.Result, error) {
    logger := log.FromContext(ctx)

    if !controllerutil.ContainsFinalizer(app, myFinalizer) {
        // Finalizer already removed, nothing to do.
        return ctrl.Result{}, nil
    }

    logger.Info("Running cleanup before deletion")

    // Perform external cleanup — e.g., deregister from a service registry,
    // delete external DNS records, revoke certificates.
    if err := r.cleanupExternalResources(ctx, app); err != nil {
        // Do not remove the finalizer if cleanup failed.
        // The workqueue will retry with backoff.
        return ctrl.Result{}, fmt.Errorf("cleaning up external resources: %w", err)
    }

    // Cleanup succeeded — remove the finalizer.
    patch := client.MergeFrom(app.DeepCopy())
    controllerutil.RemoveFinalizer(app, myFinalizer)
    if err := r.Patch(ctx, app, patch); err != nil {
        return ctrl.Result{}, fmt.Errorf("removing finalizer: %w", err)
    }

    logger.Info("Cleanup complete, finalizer removed")
    return ctrl.Result{}, nil
}

func (r *AppReconciler) cleanupExternalResources(ctx context.Context, app *myv1alpha1.App) error {
    // Example: deregister from an external load balancer API.
    // This must be idempotent — the cleanup may be called multiple times.
    logger := log.FromContext(ctx)
    logger.Info("Deregistering from external load balancer",
        "endpoint", app.Status.ExternalEndpoint)

    // If the resource was never registered, treat as success.
    if app.Status.ExternalEndpoint == "" {
        return nil
    }

    // Call external API...
    return nil
}
```

### Finalizer Anti-Patterns

Several patterns cause operators to deadlock during deletion. The most common is holding a finalizer while waiting for owned resources to delete — but those owned resources have their own finalizers that are waiting on the parent. The rule: never block finalizer removal on the deletion of child objects that themselves have finalizers unless the operator explicitly manages those child finalizers.

Another anti-pattern is adding a finalizer during the deletion path. If the reconciler's first action is unconditionally adding a finalizer, and the object is already being deleted, the operator will perpetually re-add the finalizer and the object will never be deleted.

```go
// WRONG: Adding finalizer without checking DeletionTimestamp first.
func (r *BadReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    obj := &myv1alpha1.App{}
    r.Get(ctx, req.NamespacedName, obj)

    // This will re-add the finalizer even during deletion, causing an infinite loop.
    controllerutil.AddFinalizer(obj, myFinalizer)
    r.Update(ctx, obj)
    return ctrl.Result{}, nil
}

// CORRECT: Always check DeletionTimestamp before adding finalizers.
func (r *GoodReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    obj := &myv1alpha1.App{}
    r.Get(ctx, req.NamespacedName, obj)

    if !obj.DeletionTimestamp.IsZero() {
        // Handle deletion path — never add finalizers here.
        return r.handleDeletion(ctx, obj)
    }

    if !controllerutil.ContainsFinalizer(obj, myFinalizer) {
        controllerutil.AddFinalizer(obj, myFinalizer)
        r.Update(ctx, obj)
    }
    return ctrl.Result{}, nil
}
```

## Owner References and Garbage Collection

Owner references create a parent-child relationship between Kubernetes objects. When the owner is deleted, the garbage collector automatically deletes all objects that have an owner reference pointing to it. This eliminates entire classes of resource leak bugs.

### Setting Owner References

```go
func (r *AppReconciler) reconcileConfigMap(ctx context.Context, app *myv1alpha1.App) error {
    cm := &corev1.ConfigMap{
        ObjectMeta: metav1.ObjectMeta{
            Name:      fmt.Sprintf("%s-config", app.Name),
            Namespace: app.Namespace,
        },
        Data: map[string]string{
            "config.yaml": generateConfig(app),
        },
    }

    // SetControllerReference sets the owner reference AND marks this owner as
    // the controller, preventing multiple controllers from fighting over the object.
    if err := ctrl.SetControllerReference(app, cm, r.Scheme); err != nil {
        return fmt.Errorf("setting owner reference on ConfigMap: %w", err)
    }

    existing := &corev1.ConfigMap{}
    err := r.Get(ctx, client.ObjectKeyFromObject(cm), existing)
    if errors.IsNotFound(err) {
        return r.Create(ctx, cm)
    }
    if err != nil {
        return err
    }

    patch := client.MergeFrom(existing.DeepCopy())
    existing.Data = cm.Data
    return r.Patch(ctx, existing, patch)
}
```

### Cross-Namespace Owner References

Owner references only support garbage collection within the same namespace. Cross-namespace ownership is not supported by the Kubernetes garbage collector. Operators that need to clean up cluster-scoped or cross-namespace resources must use finalizers instead.

```go
// Cross-namespace cleanup must use finalizers, not owner references.
const crossNsCleanupFinalizer = "myoperator.example.com/cross-ns-cleanup"

func (r *AppReconciler) reconcileClusterResource(
    ctx context.Context,
    app *myv1alpha1.App,
) error {
    // For cluster-scoped resources, we cannot use owner references.
    // Instead, use a finalizer on the parent App to drive cleanup.
    clusterRole := &rbacv1.ClusterRole{
        ObjectMeta: metav1.ObjectMeta{
            Name: fmt.Sprintf("app-%s-%s", app.Namespace, app.Name),
            // Store the owning App's coordinates in an annotation for cleanup.
            Annotations: map[string]string{
                "myoperator.example.com/owner-namespace": app.Namespace,
                "myoperator.example.com/owner-name":      app.Name,
            },
        },
        Rules: []rbacv1.PolicyRule{
            {
                APIGroups: []string{""},
                Resources: []string{"pods"},
                Verbs:     []string{"get", "list", "watch"},
            },
        },
    }

    existing := &rbacv1.ClusterRole{}
    err := r.Get(ctx, client.ObjectKeyFromObject(clusterRole), existing)
    if errors.IsNotFound(err) {
        return r.Create(ctx, clusterRole)
    }
    return err
}
```

### Watching Owned Resources

By default, changes to owned resources do not trigger reconciliation of the owner. Operators must explicitly configure watches to propagate events upward.

```go
func (r *AppReconciler) SetupWithManager(mgr ctrl.Manager) error {
    return ctrl.NewControllerManagedBy(mgr).
        For(&myv1alpha1.App{}).
        // Trigger reconciliation when owned Deployments change.
        Owns(&appsv1.Deployment{}).
        // Trigger reconciliation when owned Services change.
        Owns(&corev1.Service{}).
        // Trigger reconciliation when owned ConfigMaps change.
        Owns(&corev1.ConfigMap{}).
        // Watch a secondary resource that is not owned, using a custom predicate.
        Watches(
            &corev1.Secret{},
            handler.EnqueueRequestsFromMapFunc(r.findAppsForSecret),
            builder.WithPredicates(predicate.ResourceVersionChangedPredicate{}),
        ).
        // Limit concurrent reconciliations to avoid thundering herd on startup.
        WithOptions(controller.Options{MaxConcurrentReconciles: 5}).
        Complete(r)
}

func (r *AppReconciler) findAppsForSecret(
    ctx context.Context,
    secret client.Object,
) []reconcile.Request {
    appList := &myv1alpha1.AppList{}
    if err := r.List(ctx, appList,
        client.InNamespace(secret.GetNamespace()),
        client.MatchingFields{"spec.secretName": secret.GetName()},
    ); err != nil {
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

## CRD Design: Spec, Status, and Validation

A well-designed CRD makes the operator's intent explicit and prevents invalid configurations from reaching the reconciler.

```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: apps.myoperator.example.com
spec:
  group: myoperator.example.com
  versions:
    - name: v1alpha1
      served: true
      storage: true
      subresources:
        status: {}
      additionalPrinterColumns:
        - name: Replicas
          type: integer
          jsonPath: .spec.replicas
        - name: Ready
          type: string
          jsonPath: .status.conditions[?(@.type=="Ready")].status
        - name: Age
          type: date
          jsonPath: .metadata.creationTimestamp
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              required: ["image", "replicas"]
              properties:
                image:
                  type: string
                  pattern: '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(/[a-z0-9]([a-z0-9.-]*)?)*:[a-zA-Z0-9._-]+$'
                replicas:
                  type: integer
                  minimum: 1
                  maximum: 100
                  default: 1
                secretName:
                  type: string
            status:
              type: object
              properties:
                observedGeneration:
                  type: integer
                externalEndpoint:
                  type: string
                conditions:
                  type: array
                  items:
                    type: object
                    required: ["type", "status", "reason", "message"]
                    properties:
                      type:
                        type: string
                      status:
                        type: string
                        enum: ["True", "False", "Unknown"]
                      observedGeneration:
                        type: integer
                      lastTransitionTime:
                        type: string
                        format: date-time
                      reason:
                        type: string
                      message:
                        type: string
  scope: Namespaced
  names:
    plural: apps
    singular: app
    kind: App
    shortNames: ["ap"]
```

## Admission Webhooks: Defaulting and Validation

Operators frequently need admission webhooks to default fields at creation time and validate complex invariants that cannot be expressed in OpenAPI schema.

```go
package v1alpha1

import (
    "fmt"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/webhook"
)

// Ensure App implements the defaulter and validator interfaces.
var _ webhook.Defaulter = &App{}
var _ webhook.Validator = &App{}

func (a *App) Default() {
    if a.Spec.Replicas == 0 {
        a.Spec.Replicas = 1
    }
    if a.Labels == nil {
        a.Labels = make(map[string]string)
    }
    a.Labels["app.kubernetes.io/managed-by"] = "myoperator"
}

func (a *App) ValidateCreate() error {
    return a.validateSpec()
}

func (a *App) ValidateUpdate(old runtime.Object) error {
    oldApp := old.(*App)
    if a.Spec.Image != oldApp.Spec.Image {
        // Validate image format on update.
        return a.validateSpec()
    }
    return nil
}

func (a *App) ValidateDelete() error {
    // Allow deletion unconditionally — finalizers handle cleanup.
    return nil
}

func (a *App) validateSpec() error {
    if a.Spec.Replicas < 1 || a.Spec.Replicas > 100 {
        return fmt.Errorf("spec.replicas must be between 1 and 100, got %d",
            a.Spec.Replicas)
    }
    return nil
}

func (a *App) SetupWebhookWithManager(mgr ctrl.Manager) error {
    return ctrl.NewWebhookManagedBy(mgr).For(a).Complete()
}
```

## Operator Metrics and Observability

Production operators must expose metrics that allow SRE teams to monitor operator health and diagnose reconciliation failures.

```go
package controllers

import (
    "github.com/prometheus/client_golang/prometheus"
    "sigs.k8s.io/controller-runtime/pkg/metrics"
)

var (
    reconcileTotal = prometheus.NewCounterVec(
        prometheus.CounterOpts{
            Name: "myoperator_reconcile_total",
            Help: "Total number of reconciliations by result",
        },
        []string{"controller", "result"},
    )

    reconcileDuration = prometheus.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "myoperator_reconcile_duration_seconds",
            Help:    "Duration of reconcile loop executions",
            Buckets: []float64{0.01, 0.05, 0.1, 0.5, 1.0, 5.0, 10.0},
        },
        []string{"controller"},
    )

    managedResources = prometheus.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "myoperator_managed_resources",
            Help: "Number of resources currently managed by the operator",
        },
        []string{"controller", "namespace"},
    )
)

func init() {
    metrics.Registry.MustRegister(reconcileTotal, reconcileDuration, managedResources)
}
```

## Testing Operator Logic

Operators must be tested with envtest, which runs a real Kubernetes API server and etcd, enabling integration tests that exercise the full reconciliation loop.

```go
package controllers_test

import (
    "context"
    "time"

    . "github.com/onsi/ginkgo/v2"
    . "github.com/onsi/gomega"
    appsv1 "k8s.io/api/apps/v1"
    "k8s.io/apimachinery/pkg/types"
    "sigs.k8s.io/controller-runtime/pkg/client"

    myv1alpha1 "example.com/myoperator/api/v1alpha1"
)

var _ = Describe("App controller", func() {
    const (
        appName      = "test-app"
        appNamespace = "default"
        timeout      = 10 * time.Second
        interval     = 250 * time.Millisecond
    )

    ctx := context.Background()

    It("should create a Deployment when an App is created", func() {
        app := &myv1alpha1.App{
            ObjectMeta: metav1.ObjectMeta{
                Name:      appName,
                Namespace: appNamespace,
            },
            Spec: myv1alpha1.AppSpec{
                Image:    "nginx:1.25.3",
                Replicas: 2,
            },
        }
        Expect(k8sClient.Create(ctx, app)).To(Succeed())

        deploymentKey := types.NamespacedName{
            Name:      appName,
            Namespace: appNamespace,
        }
        deployment := &appsv1.Deployment{}

        Eventually(func() bool {
            return k8sClient.Get(ctx, deploymentKey, deployment) == nil
        }, timeout, interval).Should(BeTrue())

        Expect(*deployment.Spec.Replicas).To(Equal(int32(2)))
        Expect(deployment.OwnerReferences).To(HaveLen(1))
        Expect(deployment.OwnerReferences[0].Name).To(Equal(appName))
    })

    It("should remove owned resources when the App is deleted", func() {
        app := &myv1alpha1.App{}
        Expect(k8sClient.Get(ctx, types.NamespacedName{
            Name:      appName,
            Namespace: appNamespace,
        }, app)).To(Succeed())

        Expect(k8sClient.Delete(ctx, app)).To(Succeed())

        deployment := &appsv1.Deployment{}
        Eventually(func() bool {
            err := k8sClient.Get(ctx, types.NamespacedName{
                Name:      appName,
                Namespace: appNamespace,
            }, deployment)
            return errors.IsNotFound(err)
        }, timeout, interval).Should(BeTrue())
    })
})
```

## Production Deployment Checklist

Before deploying a new operator to production, verify the following:

```bash
# Verify RBAC permissions are least-privilege.
kubectl auth can-i --list --as=system:serviceaccount:operators:myoperator

# Confirm leader election is enabled for HA.
kubectl get deployment -n operators myoperator -o jsonpath='{.spec.template.spec.containers[0].args}' \
  | grep leader-elect

# Verify the operator respects resource quotas in target namespaces.
kubectl describe quota -n production

# Check that CRD conversion webhooks are configured for multi-version CRDs.
kubectl get crd apps.myoperator.example.com -o jsonpath='{.spec.conversion}'

# Validate finalizer removal is not blocked by lingering owned resources.
kubectl get apps -A -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}: {.metadata.finalizers}{"\n"}{end}'
```

The operator pattern, implemented with these foundational principles, enables infrastructure teams to encode years of operational knowledge into the Kubernetes control plane — creating systems that maintain correctness automatically, respond to failure without human intervention, and scale to cluster counts that would be impossible to manage manually.
