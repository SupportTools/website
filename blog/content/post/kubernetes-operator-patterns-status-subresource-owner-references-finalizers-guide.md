---
title: "Kubernetes Operator Patterns: Status Subresource, Owner References, and Finalizers"
date: 2030-05-10T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Operators", "controller-runtime", "Go", "CRD", "Finalizers", "Owner References"]
categories: ["Kubernetes", "Development"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production-grade Kubernetes operator implementation: status subresource best practices, owner reference garbage collection, finalizer implementation for cleanup, orphan resource prevention, and robust controller reconciliation patterns."
more_link: "yes"
url: "/kubernetes-operator-patterns-status-subresource-owner-references-finalizers-guide/"
---

Building production-quality Kubernetes operators requires mastery of several Kubernetes API patterns that go beyond simple CRUD operations on custom resources. The status subresource separates observed state from desired state, preventing reconciliation loops. Owner references enable automatic garbage collection of dependent resources. Finalizers block deletion until cleanup logic completes, preventing orphaned external resources. Together, these patterns form the foundation of operators that behave correctly under concurrent modifications, controller restarts, and partial failures.

This guide provides concrete implementations of each pattern with the edge cases and failure modes that matter in production.

<!--more-->

## Controller Architecture Overview

### The Reconciliation Loop

```
┌─────────────────────────────────────────────────────────────────────┐
│                      Controller Reconcile Loop                       │
│                                                                     │
│  Watch(CRD, owned resources)                                        │
│          │                                                          │
│          ▼                                                          │
│   Event Received                                                    │
│          │                                                          │
│          ▼                                                          │
│   Enqueue NamespacedName ──► Work Queue (deduplicated)              │
│                                      │                              │
│                                      ▼                              │
│                              Reconcile(NamespacedName)               │
│                                      │                              │
│               ┌──────────────────────┤                              │
│               │                      │                              │
│               ▼                      ▼                              │
│          Resource deleted?    Resource exists?                      │
│               │                      │                              │
│               ▼                      ▼                              │
│          Handle finalizers    Read desired state                    │
│               │               Calculate diff                        │
│               │               Create/Update/Delete children         │
│               │               Update status                         │
│               │                      │                              │
│               └──────────────────────┘                              │
│                              │                                      │
│                    Return Result{Requeue: true/false}               │
└─────────────────────────────────────────────────────────────────────┘
```

### Project Setup with controller-runtime

```go
// main.go
package main

import (
    "flag"
    "os"

    appsv1 "k8s.io/api/apps/v1"
    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/runtime"
    utilruntime "k8s.io/apimachinery/pkg/util/runtime"
    clientgoscheme "k8s.io/client-go/kubernetes/scheme"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/healthz"
    "sigs.k8s.io/controller-runtime/pkg/log/zap"
    "sigs.k8s.io/controller-runtime/pkg/metrics/server"

    databasev1alpha1 "myoperator/api/v1alpha1"
    "myoperator/controllers"
)

var scheme = runtime.NewScheme()

func init() {
    utilruntime.Must(clientgoscheme.AddToScheme(scheme))
    utilruntime.Must(databasev1alpha1.AddToScheme(scheme))
}

func main() {
    var metricsAddr string
    var probeAddr string
    var enableLeaderElection bool

    flag.StringVar(&metricsAddr, "metrics-bind-address", ":8080", "")
    flag.StringVar(&probeAddr, "health-probe-bind-address", ":8081", "")
    flag.BoolVar(&enableLeaderElection, "leader-elect", false, "")
    flag.Parse()

    ctrl.SetLogger(zap.New(zap.UseFlagOptions(&zap.Options{Development: false})))

    mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
        Scheme: scheme,
        Metrics: server.Options{
            BindAddress: metricsAddr,
        },
        HealthProbeBindAddress: probeAddr,
        LeaderElection:         enableLeaderElection,
        LeaderElectionID:       "myoperator.example.com",
        // Key: enable leader election for HA operator deployments
    })
    if err != nil {
        setupLog.Error(err, "unable to start manager")
        os.Exit(1)
    }

    if err = (&controllers.DatabaseReconciler{
        Client: mgr.GetClient(),
        Scheme: mgr.GetScheme(),
        Recorder: mgr.GetEventRecorderFor("database-controller"),
    }).SetupWithManager(mgr); err != nil {
        setupLog.Error(err, "unable to create controller")
        os.Exit(1)
    }

    mgr.AddHealthzCheck("healthz", healthz.Ping)
    mgr.AddReadyzCheck("readyz", healthz.Ping)

    if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
        setupLog.Error(err, "problem running manager")
        os.Exit(1)
    }
}
```

## Status Subresource Best Practices

### CRD Status Schema Design

```go
// api/v1alpha1/database_types.go
package v1alpha1

import (
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// DatabaseSpec defines the desired state
type DatabaseSpec struct {
    // +kubebuilder:validation:MinLength=1
    // +kubebuilder:validation:MaxLength=63
    Name string `json:"name"`

    // +kubebuilder:validation:Enum=postgres;mysql;mariadb
    Engine string `json:"engine"`

    // +kubebuilder:validation:Minimum=1
    // +kubebuilder:validation:Maximum=100
    Replicas int32 `json:"replicas"`

    // +kubebuilder:validation:Pattern=`^\d+Gi$`
    StorageSize string `json:"storageSize"`

    Version string `json:"version"`
}

// DatabaseStatus defines the observed state
// CRITICAL: Status is separate from Spec - never put observed state in Spec
type DatabaseStatus struct {
    // Conditions follow the standard Kubernetes condition format
    // +listType=map
    // +listMapKey=type
    // +optional
    Conditions []metav1.Condition `json:"conditions,omitempty"`

    // Phase is a high-level summary of where the Database is in its lifecycle
    // +kubebuilder:validation:Enum=Pending;Provisioning;Ready;Failed;Deleting
    // +optional
    Phase string `json:"phase,omitempty"`

    // ObservedGeneration tracks which spec generation was last reconciled
    // Used to detect if spec has changed since last reconciliation
    // +optional
    ObservedGeneration int64 `json:"observedGeneration,omitempty"`

    // ReadyReplicas is the number of replicas that are currently ready
    // +optional
    ReadyReplicas int32 `json:"readyReplicas,omitempty"`

    // ConnectionString is the full DSN for application use
    // +optional
    ConnectionString string `json:"connectionString,omitempty"`

    // PrimaryEndpoint is the hostname:port of the primary database server
    // +optional
    PrimaryEndpoint string `json:"primaryEndpoint,omitempty"`

    // LastBackupTime is when the most recent backup completed
    // +optional
    LastBackupTime *metav1.Time `json:"lastBackupTime,omitempty"`
}

// Standard condition types
const (
    ConditionProvisioned = "Provisioned"
    ConditionReady       = "Ready"
    ConditionDegraded    = "Degraded"
    ConditionProgressing = "Progressing"
)

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="Ready",type=string,JSONPath=`.status.readyReplicas`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`
type Database struct {
    metav1.TypeMeta   `json:",inline"`
    metav1.ObjectMeta `json:"metadata,omitempty"`

    Spec   DatabaseSpec   `json:"spec,omitempty"`
    Status DatabaseStatus `json:"status,omitempty"`
}
```

### Status Update Pattern

```go
// controllers/database_controller.go
package controllers

import (
    "context"
    "fmt"
    "time"

    appsv1 "k8s.io/api/apps/v1"
    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/api/errors"
    "k8s.io/apimachinery/pkg/api/meta"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime"
    "k8s.io/client-go/tools/record"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
    "sigs.k8s.io/controller-runtime/pkg/log"

    databasev1alpha1 "myoperator/api/v1alpha1"
)

const databaseFinalizer = "database.example.com/finalizer"

type DatabaseReconciler struct {
    client.Client
    Scheme   *runtime.Scheme
    Recorder record.EventRecorder
}

func (r *DatabaseReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    log := log.FromContext(ctx)

    // 1. Fetch the custom resource
    db := &databasev1alpha1.Database{}
    if err := r.Get(ctx, req.NamespacedName, db); err != nil {
        if errors.IsNotFound(err) {
            // Object has been deleted - nothing to do
            return ctrl.Result{}, nil
        }
        return ctrl.Result{}, fmt.Errorf("fetching database: %w", err)
    }

    // 2. Handle deletion
    if !db.DeletionTimestamp.IsZero() {
        return r.handleDeletion(ctx, db)
    }

    // 3. Add finalizer if not present
    if !controllerutil.ContainsFinalizer(db, databaseFinalizer) {
        controllerutil.AddFinalizer(db, databaseFinalizer)
        if err := r.Update(ctx, db); err != nil {
            return ctrl.Result{}, fmt.Errorf("adding finalizer: %w", err)
        }
        // Requeue after adding finalizer - the update triggers a new reconcile
        return ctrl.Result{Requeue: true}, nil
    }

    // 4. Track observedGeneration to detect spec changes
    // IMPORTANT: Only update status via the status subresource
    if db.Status.ObservedGeneration == db.Generation {
        // Spec hasn't changed - may still need to reconcile for health checks
        log.V(1).Info("Spec unchanged, checking current state")
    }

    // 5. Reconcile desired state
    result, reconcileErr := r.reconcileDatabase(ctx, db)

    // 6. Always update status, even if reconciliation failed
    // CRITICAL: Use Status().Update() not Update() for status changes
    // This prevents race conditions with spec updates
    statusPatch := client.MergeFrom(db.DeepCopy())
    db.Status.ObservedGeneration = db.Generation

    if err := r.Status().Patch(ctx, db, statusPatch); err != nil {
        log.Error(err, "Failed to update status")
        // If we can't update status, requeue
        return ctrl.Result{RequeueAfter: 10 * time.Second}, nil
    }

    return result, reconcileErr
}

// reconcileDatabase performs the actual reconciliation work.
func (r *DatabaseReconciler) reconcileDatabase(
    ctx context.Context,
    db *databasev1alpha1.Database,
) (ctrl.Result, error) {
    log := log.FromContext(ctx)

    // Update phase to Provisioning
    r.setCondition(db, databasev1alpha1.ConditionProgressing, metav1.ConditionTrue,
        "Reconciling", "Reconciling database resources")

    // Reconcile StatefulSet
    if err := r.reconcileStatefulSet(ctx, db); err != nil {
        r.setPhase(db, "Failed")
        r.setCondition(db, databasev1alpha1.ConditionProvisioned, metav1.ConditionFalse,
            "StatefulSetFailed", err.Error())
        r.Recorder.Eventf(db, corev1.EventTypeWarning, "ProvisionFailed",
            "Failed to provision StatefulSet: %v", err)
        return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
    }

    // Reconcile Service
    if err := r.reconcileService(ctx, db); err != nil {
        r.setPhase(db, "Failed")
        r.setCondition(db, databasev1alpha1.ConditionProvisioned, metav1.ConditionFalse,
            "ServiceFailed", err.Error())
        return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
    }

    // Check if replicas are ready
    sts := &appsv1.StatefulSet{}
    stsName := client.ObjectKey{Name: db.Name, Namespace: db.Namespace}
    if err := r.Get(ctx, stsName, sts); err != nil {
        return ctrl.Result{RequeueAfter: 10 * time.Second}, nil
    }

    db.Status.ReadyReplicas = sts.Status.ReadyReplicas

    if sts.Status.ReadyReplicas == db.Spec.Replicas {
        r.setPhase(db, "Ready")
        r.setCondition(db, databasev1alpha1.ConditionReady, metav1.ConditionTrue,
            "AllReplicasReady", fmt.Sprintf("%d/%d replicas ready",
                sts.Status.ReadyReplicas, db.Spec.Replicas))
        r.setCondition(db, databasev1alpha1.ConditionProgressing, metav1.ConditionFalse,
            "Reconciled", "All resources are in desired state")

        db.Status.PrimaryEndpoint = fmt.Sprintf("%s.%s.svc.cluster.local:5432",
            db.Name, db.Namespace)

        r.Recorder.Eventf(db, corev1.EventTypeNormal, "Ready",
            "Database %s is ready with %d replicas", db.Name, db.Spec.Replicas)

        log.Info("Database reconciled successfully", "replicas", db.Spec.Replicas)
        // No requeue needed - watch events will trigger as needed
        return ctrl.Result{}, nil
    }

    // Not all replicas ready yet - requeue
    r.setPhase(db, "Provisioning")
    log.Info("Waiting for replicas",
        "ready", sts.Status.ReadyReplicas,
        "desired", db.Spec.Replicas)
    return ctrl.Result{RequeueAfter: 10 * time.Second}, nil
}

// setCondition updates or adds a condition to the status.
func (r *DatabaseReconciler) setCondition(
    db *databasev1alpha1.Database,
    conditionType string,
    status metav1.ConditionStatus,
    reason, message string,
) {
    meta.SetStatusCondition(&db.Status.Conditions, metav1.Condition{
        Type:               conditionType,
        Status:             status,
        Reason:             reason,
        Message:            message,
        ObservedGeneration: db.Generation,
    })
}

func (r *DatabaseReconciler) setPhase(db *databasev1alpha1.Database, phase string) {
    db.Status.Phase = phase
}
```

## Owner References for Garbage Collection

### Setting Owner References

Owner references create a parent-child relationship: when the parent (owner) is deleted, Kubernetes garbage collects the child automatically. This prevents orphaned resources.

```go
// owner_references.go
package controllers

import (
    "context"
    "fmt"

    appsv1 "k8s.io/api/apps/v1"
    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/api/errors"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime/schema"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

    databasev1alpha1 "myoperator/api/v1alpha1"
)

// reconcileStatefulSet creates or updates the StatefulSet with proper owner reference.
func (r *DatabaseReconciler) reconcileStatefulSet(
    ctx context.Context,
    db *databasev1alpha1.Database,
) error {
    labels := map[string]string{
        "app.kubernetes.io/name":       "database",
        "app.kubernetes.io/instance":   db.Name,
        "app.kubernetes.io/managed-by": "database-operator",
        "database.example.com/name":    db.Name,
    }

    sts := &appsv1.StatefulSet{
        ObjectMeta: metav1.ObjectMeta{
            Name:      db.Name,
            Namespace: db.Namespace,
            Labels:    labels,
        },
        Spec: appsv1.StatefulSetSpec{
            Replicas: &db.Spec.Replicas,
            Selector: &metav1.LabelSelector{
                MatchLabels: map[string]string{
                    "database.example.com/name": db.Name,
                },
            },
            ServiceName: db.Name,
            Template: corev1.PodTemplateSpec{
                ObjectMeta: metav1.ObjectMeta{
                    Labels: labels,
                },
                Spec: corev1.PodSpec{
                    Containers: []corev1.Container{
                        {
                            Name:  "database",
                            Image: fmt.Sprintf("postgres:%s", db.Spec.Version),
                        },
                    },
                },
            },
        },
    }

    // CRITICAL: SetControllerReference sets the owner reference.
    // This makes the StatefulSet a child of the Database CR.
    // When Database is deleted, the StatefulSet is garbage collected.
    //
    // Parameters:
    // - owner: the Database CR (must be in the same namespace for namespaced resources)
    // - controlled: the StatefulSet being owned
    // - scheme: the scheme for looking up GVK information
    if err := controllerutil.SetControllerReference(db, sts, r.Scheme); err != nil {
        return fmt.Errorf("setting controller reference on StatefulSet: %w", err)
    }

    // Use CreateOrUpdate to handle both creation and updates
    result, err := controllerutil.CreateOrUpdate(ctx, r.Client, sts, func() error {
        // This function is called with the current state from the API server
        // Update only fields we manage - don't overwrite what others set
        sts.Spec.Replicas = &db.Spec.Replicas
        sts.Spec.Template.Spec.Containers[0].Image =
            fmt.Sprintf("postgres:%s", db.Spec.Version)
        return nil
    })
    if err != nil {
        return fmt.Errorf("creating/updating StatefulSet: %w", err)
    }

    if result != controllerutil.OperationResultNone {
        log.FromContext(ctx).Info("StatefulSet reconciled",
            "operation", result,
            "name", sts.Name)
    }

    return nil
}

// reconcileService creates or updates the Service.
func (r *DatabaseReconciler) reconcileService(
    ctx context.Context,
    db *databasev1alpha1.Database,
) error {
    svc := &corev1.Service{
        ObjectMeta: metav1.ObjectMeta{
            Name:      db.Name,
            Namespace: db.Namespace,
            Labels: map[string]string{
                "app.kubernetes.io/managed-by": "database-operator",
            },
        },
        Spec: corev1.ServiceSpec{
            Selector: map[string]string{
                "database.example.com/name": db.Name,
            },
            Ports: []corev1.ServicePort{
                {Port: 5432, Name: "postgres"},
            },
            ClusterIP: "None", // Headless service for StatefulSet
        },
    }

    // Owner reference ensures service is deleted with the Database CR
    if err := controllerutil.SetControllerReference(db, svc, r.Scheme); err != nil {
        return fmt.Errorf("setting controller reference on Service: %w", err)
    }

    _, err := controllerutil.CreateOrUpdate(ctx, r.Client, svc, func() error {
        svc.Spec.Selector = map[string]string{
            "database.example.com/name": db.Name,
        }
        return nil
    })
    return err
}

// Cross-namespace owner references require ClusterScoped owners.
// For namespace-scoped owners, you cannot set owner references across namespaces.
// In that case, use labels + a separate cleanup controller instead:
func (r *DatabaseReconciler) createCrossNamespaceResource(
    ctx context.Context,
    db *databasev1alpha1.Database,
    targetNamespace string,
) error {
    // Cannot use SetControllerReference across namespaces!
    // Instead: use labels to track ownership, and handle cleanup in finalizer

    configMap := &corev1.ConfigMap{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "db-config-" + db.Name,
            Namespace: targetNamespace,
            Labels: map[string]string{
                // Use labels to track the owning Database
                "database.example.com/owner-name":      db.Name,
                "database.example.com/owner-namespace": db.Namespace,
                "database.example.com/owner-uid":       string(db.UID),
            },
            // No owner reference - would be rejected by API server
        },
        Data: map[string]string{
            "endpoint": fmt.Sprintf("%s.%s.svc.cluster.local", db.Name, db.Namespace),
        },
    }

    if err := r.Create(ctx, configMap); err != nil && !errors.IsAlreadyExists(err) {
        return fmt.Errorf("creating cross-namespace configmap: %w", err)
    }

    // The finalizer must clean this up since there's no owner reference
    return nil
}
```

## Finalizer Implementation

### Robust Finalizer Pattern

```go
// finalizer.go
package controllers

import (
    "context"
    "fmt"
    "time"

    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/api/errors"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
    "sigs.k8s.io/controller-runtime/pkg/log"

    databasev1alpha1 "myoperator/api/v1alpha1"
)

// handleDeletion is called when a Database resource has a DeletionTimestamp set.
// It performs cleanup and removes the finalizer to allow deletion to complete.
func (r *DatabaseReconciler) handleDeletion(
    ctx context.Context,
    db *databasev1alpha1.Database,
) (ctrl.Result, error) {
    log := log.FromContext(ctx)

    if !controllerutil.ContainsFinalizer(db, databaseFinalizer) {
        // Finalizer already removed, nothing to do
        return ctrl.Result{}, nil
    }

    log.Info("Running finalizer cleanup", "database", db.Name)

    // Update status to indicate deletion in progress
    statusPatch := client.MergeFrom(db.DeepCopy())
    db.Status.Phase = "Deleting"
    r.setCondition(db, "Deleting", metav1.ConditionTrue,
        "DeletionInProgress", "Cleaning up external resources")
    if err := r.Status().Patch(ctx, db, statusPatch); err != nil {
        log.Error(err, "Failed to update deletion status")
        // Continue anyway - we still need to clean up
    }

    // Step 1: Delete cross-namespace resources (not covered by owner references)
    if err := r.deleteCrossNamespaceResources(ctx, db); err != nil {
        log.Error(err, "Failed to delete cross-namespace resources")
        r.Recorder.Eventf(db, corev1.EventTypeWarning, "CleanupFailed",
            "Failed to delete cross-namespace resources: %v", err)
        // Requeue to retry cleanup
        return ctrl.Result{RequeueAfter: 15 * time.Second}, nil
    }

    // Step 2: Delete external cloud resources (e.g., AWS RDS, managed certificates)
    if err := r.deleteExternalResources(ctx, db); err != nil {
        log.Error(err, "Failed to delete external resources")
        r.Recorder.Eventf(db, corev1.EventTypeWarning, "ExternalCleanupFailed",
            "Failed to delete external resources: %v", err)
        return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
    }

    // Step 3: Wait for StatefulSet pods to terminate
    // (Owner references handle StatefulSet deletion, but we may need to wait)
    if done, err := r.waitForPodsTerminated(ctx, db); err != nil {
        return ctrl.Result{RequeueAfter: 10 * time.Second}, nil
    } else if !done {
        log.Info("Waiting for pods to terminate")
        return ctrl.Result{RequeueAfter: 10 * time.Second}, nil
    }

    // Step 4: All cleanup complete - remove the finalizer
    // This unblocks the Kubernetes garbage collector to delete the resource
    controllerutil.RemoveFinalizer(db, databaseFinalizer)
    if err := r.Update(ctx, db); err != nil {
        if errors.IsNotFound(err) {
            // Already deleted - fine
            return ctrl.Result{}, nil
        }
        return ctrl.Result{}, fmt.Errorf("removing finalizer: %w", err)
    }

    log.Info("Finalizer removed, database deletion complete")
    r.Recorder.Eventf(db, corev1.EventTypeNormal, "Deleted",
        "Database %s successfully deleted", db.Name)

    return ctrl.Result{}, nil
}

// deleteCrossNamespaceResources cleans up resources in other namespaces
// that have labels identifying them as owned by this Database.
func (r *DatabaseReconciler) deleteCrossNamespaceResources(
    ctx context.Context,
    db *databasev1alpha1.Database,
) error {
    // Find ConfigMaps in other namespaces with our ownership labels
    cmList := &corev1.ConfigMapList{}
    if err := r.List(ctx, cmList, client.MatchingLabels{
        "database.example.com/owner-name":      db.Name,
        "database.example.com/owner-namespace": db.Namespace,
        "database.example.com/owner-uid":       string(db.UID),
    }); err != nil {
        return fmt.Errorf("listing cross-namespace configmaps: %w", err)
    }

    for _, cm := range cmList.Items {
        cm := cm // capture range variable
        if err := r.Delete(ctx, &cm); err != nil && !errors.IsNotFound(err) {
            return fmt.Errorf("deleting configmap %s/%s: %w",
                cm.Namespace, cm.Name, err)
        }
        log.FromContext(ctx).Info("Deleted cross-namespace ConfigMap",
            "namespace", cm.Namespace, "name", cm.Name)
    }

    return nil
}

// deleteExternalResources handles cleanup of resources outside Kubernetes.
func (r *DatabaseReconciler) deleteExternalResources(
    ctx context.Context,
    db *databasev1alpha1.Database,
) error {
    // Example: delete an external DNS record
    // In production this would call Route53, CloudDNS, etc.
    log.FromContext(ctx).Info("Deleting external DNS record",
        "hostname", fmt.Sprintf("%s.db.example.com", db.Name))

    // Your external API call here:
    // if err := r.DNSClient.DeleteRecord(ctx, db.Name+".db.example.com"); err != nil {
    //     if !isNotFoundError(err) {
    //         return err
    //     }
    // }

    return nil
}

// waitForPodsTerminated returns true when all pods owned by this Database are gone.
func (r *DatabaseReconciler) waitForPodsTerminated(
    ctx context.Context,
    db *databasev1alpha1.Database,
) (bool, error) {
    podList := &corev1.PodList{}
    if err := r.List(ctx, podList,
        client.InNamespace(db.Namespace),
        client.MatchingLabels{"database.example.com/name": db.Name},
    ); err != nil {
        return false, err
    }

    if len(podList.Items) == 0 {
        return true, nil
    }

    log.FromContext(ctx).Info("Waiting for pods",
        "count", len(podList.Items))
    return false, nil
}
```

## Preventing Orphan Resources

### Label-Based Adoption

When an operator is first installed into a cluster that has pre-existing resources, those resources need to be "adopted" by setting owner references:

```go
// adoption.go
package controllers

import (
    "context"
    "fmt"

    appsv1 "k8s.io/api/apps/v1"
    "k8s.io/apimachinery/pkg/api/errors"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

    databasev1alpha1 "myoperator/api/v1alpha1"
)

// adoptOrphanedResources finds resources that should be owned by this Database
// but don't have an owner reference set yet.
func (r *DatabaseReconciler) adoptOrphanedResources(
    ctx context.Context,
    db *databasev1alpha1.Database,
) error {
    // Find StatefulSets that match by label but lack owner reference
    stsList := &appsv1.StatefulSetList{}
    if err := r.List(ctx, stsList,
        client.InNamespace(db.Namespace),
        client.MatchingLabels{"database.example.com/name": db.Name},
    ); err != nil {
        return fmt.Errorf("listing StatefulSets for adoption: %w", err)
    }

    for _, sts := range stsList.Items {
        sts := sts

        // Skip if already owned (by us or someone else)
        for _, ref := range sts.OwnerReferences {
            if ref.Controller != nil && *ref.Controller {
                continue // Already has a controller owner
            }
        }

        // Adopt by setting owner reference
        if err := controllerutil.SetControllerReference(db, &sts, r.Scheme); err != nil {
            return fmt.Errorf("setting owner reference for adoption of %s: %w",
                sts.Name, err)
        }

        if err := r.Update(ctx, &sts); err != nil {
            if errors.IsConflict(err) {
                continue // Someone else updated it, skip
            }
            return fmt.Errorf("updating StatefulSet for adoption: %w", err)
        }

        log.FromContext(ctx).Info("Adopted orphaned StatefulSet", "name", sts.Name)
    }

    return nil
}
```

### Resource Drift Detection

```go
// drift_detection.go
package controllers

import (
    "context"
    "fmt"
    "reflect"

    appsv1 "k8s.io/api/apps/v1"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"

    databasev1alpha1 "myoperator/api/v1alpha1"
)

// detectAndCorrectDrift checks if owned resources have drifted from desired state
// and corrects them. This handles the case where someone manually edits a
// StatefulSet that should be managed by the operator.
func (r *DatabaseReconciler) detectAndCorrectDrift(
    ctx context.Context,
    db *databasev1alpha1.Database,
) (ctrl.Result, error) {
    sts := &appsv1.StatefulSet{}
    if err := r.Get(ctx, client.ObjectKey{
        Name:      db.Name,
        Namespace: db.Namespace,
    }, sts); err != nil {
        return ctrl.Result{}, client.IgnoreNotFound(err)
    }

    // Check if replicas have been manually changed
    currentReplicas := int32(1)
    if sts.Spec.Replicas != nil {
        currentReplicas = *sts.Spec.Replicas
    }

    if currentReplicas != db.Spec.Replicas {
        log.FromContext(ctx).Info("Correcting replica drift",
            "current", currentReplicas,
            "desired", db.Spec.Replicas)

        patch := client.MergeFrom(sts.DeepCopy())
        sts.Spec.Replicas = &db.Spec.Replicas
        if err := r.Patch(ctx, sts, patch); err != nil {
            return ctrl.Result{}, fmt.Errorf("correcting replica drift: %w", err)
        }

        r.Recorder.Eventf(db, "Normal", "DriftCorrected",
            "Corrected replica count from %d to %d",
            currentReplicas, db.Spec.Replicas)
    }

    // Check if image has been manually changed
    desiredImage := fmt.Sprintf("postgres:%s", db.Spec.Version)
    if len(sts.Spec.Template.Spec.Containers) > 0 {
        currentImage := sts.Spec.Template.Spec.Containers[0].Image
        if currentImage != desiredImage {
            log.FromContext(ctx).Info("Correcting image drift",
                "current", currentImage,
                "desired", desiredImage)

            patch := client.MergeFrom(sts.DeepCopy())
            sts.Spec.Template.Spec.Containers[0].Image = desiredImage
            if err := r.Patch(ctx, sts, patch); err != nil {
                return ctrl.Result{}, fmt.Errorf("correcting image drift: %w", err)
            }
        }
    }

    return ctrl.Result{}, nil
}
```

## Controller Setup and Watches

### SetupWithManager: Watching Owned Resources

```go
// setup.go
package controllers

import (
    appsv1 "k8s.io/api/apps/v1"
    corev1 "k8s.io/api/core/v1"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/builder"
    "sigs.k8s.io/controller-runtime/pkg/handler"
    "sigs.k8s.io/controller-runtime/pkg/predicate"

    databasev1alpha1 "myoperator/api/v1alpha1"
)

func (r *DatabaseReconciler) SetupWithManager(mgr ctrl.Manager) error {
    return ctrl.NewControllerManagedBy(mgr).
        // Primary resource: watch Database CRDs
        For(&databasev1alpha1.Database{}).
        // Owned resources: when these change, reconcile the owning Database
        // builder.WithPredicates limits which events trigger reconciliation
        Owns(&appsv1.StatefulSet{},
            builder.WithPredicates(predicate.ResourceVersionChangedPredicate{})).
        Owns(&corev1.Service{},
            builder.WithPredicates(predicate.ResourceVersionChangedPredicate{})).
        // Watch Pods even though we don't own them directly
        // When pod status changes, reconcile the owning Database
        Watches(
            &corev1.Pod{},
            handler.EnqueueRequestForOwner(
                mgr.GetScheme(),
                mgr.GetRESTMapper(),
                &databasev1alpha1.Database{},
                handler.OnlyControllerOwner(),
            ),
            builder.WithPredicates(predicate.NewPredicateFuncs(func(obj client.Object) bool {
                // Only trigger on pod phase changes
                pod, ok := obj.(*corev1.Pod)
                if !ok {
                    return false
                }
                return pod.Status.Phase == corev1.PodRunning ||
                    pod.Status.Phase == corev1.PodFailed
            })),
        ).
        // Set concurrency: how many databases can be reconciled in parallel
        WithOptions(controller.Options{
            MaxConcurrentReconciles: 5,
            // RecoverPanic prevents one bad reconcile from crashing all others
            RecoverPanic: func() bool { return true },
        }).
        Complete(r)
}
```

## Error Handling and Retry Strategy

### Production Error Handling

```go
// errors.go
package controllers

import (
    "context"
    "fmt"
    "time"

    "k8s.io/apimachinery/pkg/api/errors"
    ctrl "sigs.k8s.io/controller-runtime"
)

// ReconcileError wraps errors with context for the reconciliation log.
type ReconcileError struct {
    Op      string
    Message string
    Err     error
    Retry   bool
    After   time.Duration
}

func (e *ReconcileError) Error() string {
    return fmt.Sprintf("%s: %s: %v", e.Op, e.Message, e.Err)
}

func (e *ReconcileError) Unwrap() error {
    return e.Err
}

// handleReconcileError converts errors to appropriate ctrl.Result values.
// This is the central error handling point for the reconciler.
func handleReconcileError(err error) (ctrl.Result, error) {
    if err == nil {
        return ctrl.Result{}, nil
    }

    var reconcileErr *ReconcileError
    if ok := errors.As(err, &reconcileErr); ok {
        if !reconcileErr.Retry {
            // Non-retryable error: log and don't requeue
            return ctrl.Result{}, nil
        }
        if reconcileErr.After > 0 {
            return ctrl.Result{RequeueAfter: reconcileErr.After}, nil
        }
        return ctrl.Result{Requeue: true}, nil
    }

    // API server errors
    if errors.IsConflict(err) {
        // Conflict: another update happened, retry quickly
        return ctrl.Result{RequeueAfter: 2 * time.Second}, nil
    }
    if errors.IsNotFound(err) {
        // Resource disappeared: requeue to handle the deletion
        return ctrl.Result{Requeue: true}, nil
    }
    if errors.IsServerTimeout(err) || errors.IsTooManyRequests(err) {
        // Rate limiting: back off
        return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
    }

    // Unknown error: requeue with default backoff
    return ctrl.Result{}, err
}
```

## Key Takeaways

Production Kubernetes operators require getting several foundational patterns right before considering feature completeness.

**Status subresource eliminates reconciliation loops**: Always update status via `Status().Update()` or `Status().Patch()`, never via the main `Update()`. When spec and status share a single update path, controllers can accidentally trigger their own reconciliation loop. The `observedGeneration` field tells you whether the controller has processed the latest spec version.

**Owner references are the correct garbage collection mechanism**: Resources created by your operator should always have the CRD instance as their controller owner via `controllerutil.SetControllerReference`. This ensures that deleting the CRD instance propagates to all owned resources without requiring finalizer logic. The exception is cross-namespace resources, which require label-based tracking and explicit finalizer cleanup.

**Finalizers must be idempotent and defensive**: Finalizer logic runs during deletion and may be interrupted and retried. Every cleanup operation must be idempotent (safe to call multiple times) and must handle not-found errors gracefully (the resource may have already been deleted in a previous run). Never return an error that causes infinite retry loops for permanent failures.

**Adopt orphaned resources to prevent conflicts**: When your operator is first deployed into a cluster with existing resources, it must adopt those resources by setting owner references. Without adoption, your operator creates duplicates while the existing resources remain unmanaged.

**Watch owned resources to react to external changes**: Setting up watches on StatefulSets, Services, and Pods via `Owns()` ensures your operator detects when someone manually modifies a resource and corrects the drift. Without this, an operator that only reconciles on CRD spec changes will silently allow configuration drift indefinitely.
