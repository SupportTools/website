---
title: "Kubernetes Finalizers, Owner References, and Garbage Collection: Deep Dive"
date: 2027-04-27T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Finalizers", "Controller", "Garbage Collection", "Go", "Operator"]
categories: ["Kubernetes", "Development"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep technical guide to Kubernetes object lifecycle management covering finalizers, owner references, garbage collection policies, cascading deletions, and proper implementation patterns in operators and controllers."
more_link: "yes"
url: "/kubernetes-finalizers-owner-references-garbage-collection-guide/"
---

Kubernetes provides a sophisticated object lifecycle management system that is frequently misunderstood and even more frequently misused. Finalizers block object deletion until external cleanup completes. Owner references encode parent-child relationships that drive automatic garbage collection. When these mechanisms interact with operator logic, the results range from elegantly automatic resource cleanup to permanently stuck objects that cannot be deleted by any user.

Understanding these primitives at the implementation level is essential for anyone writing Kubernetes operators or controllers. This guide covers the complete object lifecycle model with production-ready Go patterns.

<!--more-->

# The Kubernetes Object Lifecycle Model

## How Object Deletion Actually Works

When a user or controller issues a DELETE request for a Kubernetes object, the API server does not necessarily remove the object immediately. The deletion process involves two distinct phases that are governed by finalizers.

**Phase 1: Deletion timestamp is set.** The API server sets `metadata.deletionTimestamp` to the current time and sets `metadata.deletionGracePeriodSeconds`. The object is now "terminating." No new finalizers can be added at this point.

**Phase 2: Finalizers are processed.** Each controller that owns a finalizer string on the object must perform its cleanup and remove its finalizer entry. When `metadata.finalizers` becomes empty, the API server permanently removes the object from etcd.

```
┌──────────────────────────────────────────────────────────────────────┐
│                  Kubernetes Deletion Flow                           │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  kubectl delete MyResource foo                                       │
│         │                                                            │
│         ▼                                                            │
│  API Server checks finalizers                                        │
│         │                                                            │
│         ├── finalizers: []          ──► DELETE immediately           │
│         │                                                            │
│         └── finalizers: ["my-controller/cleanup"]                   │
│                   │                                                  │
│                   ▼                                                  │
│  API Server sets deletionTimestamp                                   │
│  Object remains in etcd (terminating state)                          │
│         │                                                            │
│         ▼                                                            │
│  Controller detects deletionTimestamp != nil                         │
│  Controller performs cleanup:                                        │
│    - delete external resources                                       │
│    - release reservations                                            │
│    - remove cloud resources                                          │
│         │                                                            │
│         ▼                                                            │
│  Controller removes finalizer from object                            │
│  (PATCH /metadata/finalizers remove "my-controller/cleanup")         │
│         │                                                            │
│         ▼                                                            │
│  finalizers == [] ──► API Server permanently deletes object          │
└──────────────────────────────────────────────────────────────────────┘
```

## Owner References and Garbage Collection

Owner references create directed acyclic graph (DAG) relationships between Kubernetes objects. When an owner object is deleted, the garbage collector automatically deletes all objects that reference it via `metadata.ownerReferences`.

```
┌──────────────────────────────────────────────────────────────────────┐
│               Owner Reference Garbage Collection Graph              │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Deployment (owner)                                                  │
│  ├── ownerReferences: []                                             │
│  │                                                                   │
│  ├── ReplicaSet A (owned)                                            │
│  │   ├── ownerReferences: [{Deployment/my-app}]                      │
│  │   ├── Pod A1 ──► ownerReferences: [{ReplicaSet/rs-abc}]           │
│  │   └── Pod A2 ──► ownerReferences: [{ReplicaSet/rs-abc}]           │
│  │                                                                   │
│  └── ReplicaSet B (old, owned)                                       │
│      ├── ownerReferences: [{Deployment/my-app}]                      │
│      └── Pod B1 ──► ownerReferences: [{ReplicaSet/rs-xyz}]           │
│                                                                      │
│  Delete Deployment ──► GC deletes ReplicaSets ──► GC deletes Pods   │
│  (background policy: asynchronous cascade)                           │
└──────────────────────────────────────────────────────────────────────┘
```

The garbage collector in `kube-controller-manager` watches for objects whose owners no longer exist and deletes them. This is how Deployments, Jobs, and StatefulSets clean up their dependents automatically without any operator code.

# Implementing Finalizers in Operators

## The Standard Finalizer Pattern in Go

The canonical finalizer pattern in a controller reconcile loop follows a strict sequence: check for deletion, run cleanup if deleting, update the object. The most common error is performing cleanup and then failing to remove the finalizer, causing the object to be stuck permanently.

```go
// finalizer-controller.go - Production finalizer pattern with controller-runtime
package controllers

import (
	"context"
	"fmt"

	myv1alpha1 "github.com/my-org/my-operator/api/v1alpha1"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/log"
	ctrl "sigs.k8s.io/controller-runtime"
)

const (
	// Finalizer name should be namespaced to your controller
	// Format: <domain>/<controller-name>
	myResourceFinalizer = "my-org.io/my-resource-cleanup"
)

type MyResourceReconciler struct {
	client.Client
	ExternalService ExternalServiceClient
}

func (r *MyResourceReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := log.FromContext(ctx)

	// 1. Fetch the object
	resource := &myv1alpha1.MyResource{}
	if err := r.Get(ctx, req.NamespacedName, resource); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	// 2. Check if the object is being deleted
	if !resource.DeletionTimestamp.IsZero() {
		return r.handleDeletion(ctx, resource)
	}

	// 3. Ensure finalizer is present on live (non-deleting) objects
	if !controllerutil.ContainsFinalizer(resource, myResourceFinalizer) {
		controllerutil.AddFinalizer(resource, myResourceFinalizer)
		if err := r.Update(ctx, resource); err != nil {
			return ctrl.Result{}, fmt.Errorf("adding finalizer: %w", err)
		}
		log.Info("Added finalizer", "finalizer", myResourceFinalizer)
		// Requeue to continue with normal reconciliation
		return ctrl.Result{Requeue: true}, nil
	}

	// 4. Normal reconciliation logic
	return r.reconcileNormal(ctx, resource)
}

func (r *MyResourceReconciler) handleDeletion(ctx context.Context, resource *myv1alpha1.MyResource) (ctrl.Result, error) {
	log := log.FromContext(ctx)

	if !controllerutil.ContainsFinalizer(resource, myResourceFinalizer) {
		// Finalizer already removed - nothing to do
		return ctrl.Result{}, nil
	}

	log.Info("Running cleanup for deleted resource",
		"name", resource.Name,
		"namespace", resource.Namespace)

	// 5. Perform external cleanup
	// CRITICAL: this must be idempotent - the controller may run cleanup
	// multiple times if it crashes after cleanup but before finalizer removal
	if err := r.ExternalService.DeleteResources(ctx, resource.Spec.ExternalResourceID); err != nil {
		// If cleanup fails, return an error to requeue
		// Do NOT remove the finalizer - the object must stay until cleanup succeeds
		log.Error(err, "External cleanup failed, will retry")
		return ctrl.Result{}, fmt.Errorf("external cleanup: %w", err)
	}

	// 6. Remove the finalizer only after successful cleanup
	// Use a patch to minimize conflict risk (not Update which sends the full object)
	patch := client.MergeFrom(resource.DeepCopy())
	controllerutil.RemoveFinalizer(resource, myResourceFinalizer)
	if err := r.Patch(ctx, resource, patch); err != nil {
		return ctrl.Result{}, fmt.Errorf("removing finalizer: %w", err)
	}

	log.Info("Cleanup complete, finalizer removed")
	return ctrl.Result{}, nil
}

func (r *MyResourceReconciler) reconcileNormal(ctx context.Context, resource *myv1alpha1.MyResource) (ctrl.Result, error) {
	// Normal reconciliation: create/update external resources
	// ...
	return ctrl.Result{}, nil
}
```

## Multiple Finalizers and Ordering

When multiple controllers need to perform cleanup on the same object, each controller adds its own finalizer. The finalizers are processed independently and in no guaranteed order — if your cleanup has ordering requirements, implement them within a single controller's cleanup function rather than relying on finalizer ordering.

```go
// multi-finalizer-pattern.go
const (
	databaseFinalizer    = "my-org.io/database-cleanup"
	storageFinalizer     = "my-org.io/storage-cleanup"
	monitoringFinalizer  = "my-org.io/monitoring-cleanup"
)

func (r *AppReconciler) handleDeletion(ctx context.Context, app *myv1alpha1.App) (ctrl.Result, error) {
	log := log.FromContext(ctx)

	// When multiple cleanup steps have ordering requirements,
	// implement the ordering in one controller rather than across
	// multiple controllers with separate finalizers.

	// Step 1: Must happen first - stop traffic
	if controllerutil.ContainsFinalizer(app, monitoringFinalizer) {
		if err := r.removeMonitoringAlerts(ctx, app); err != nil {
			return ctrl.Result{}, fmt.Errorf("monitoring cleanup: %w", err)
		}
		patch := client.MergeFrom(app.DeepCopy())
		controllerutil.RemoveFinalizer(app, monitoringFinalizer)
		if err := r.Patch(ctx, app, patch); err != nil {
			return ctrl.Result{}, fmt.Errorf("removing monitoring finalizer: %w", err)
		}
		// Requeue to pick up the next finalizer in a fresh reconcile loop
		return ctrl.Result{Requeue: true}, nil
	}

	// Step 2: Database cleanup (only runs after monitoring finalizer is removed)
	if controllerutil.ContainsFinalizer(app, databaseFinalizer) {
		if err := r.dropDatabaseSchema(ctx, app); err != nil {
			return ctrl.Result{}, fmt.Errorf("database cleanup: %w", err)
		}
		patch := client.MergeFrom(app.DeepCopy())
		controllerutil.RemoveFinalizer(app, databaseFinalizer)
		if err := r.Patch(ctx, app, patch); err != nil {
			return ctrl.Result{}, fmt.Errorf("removing database finalizer: %w", err)
		}
		return ctrl.Result{Requeue: true}, nil
	}

	// Step 3: Storage cleanup (last step)
	if controllerutil.ContainsFinalizer(app, storageFinalizer) {
		if err := r.deleteStorageBucket(ctx, app); err != nil {
			return ctrl.Result{}, fmt.Errorf("storage cleanup: %w", err)
		}
		patch := client.MergeFrom(app.DeepCopy())
		controllerutil.RemoveFinalizer(app, storageFinalizer)
		if err := r.Patch(ctx, app, patch); err != nil {
			return ctrl.Result{}, fmt.Errorf("removing storage finalizer: %w", err)
		}
		log.Info("All cleanup complete")
	}

	return ctrl.Result{}, nil
}
```

## Preventing Finalizer Deadlocks

The most dangerous finalizer mistake is adding a finalizer to an object that the finalizer's own controller creates. If Controller A creates objects of type B and adds a finalizer to them, and the cleanup logic in Controller A requires deleting resources that are also managed by Controller A, there is a risk of deadlock.

```go
// deadlock-prevention.go

// BAD PATTERN: Controller creates child objects and adds finalizer on parent.
// If the cleanup tries to delete children but children also have finalizers
// pointing back to the parent, nothing can be deleted.

// GOOD PATTERN: Use owner references for automatic child cleanup
// instead of finalizers when the parent->child relationship is simple.

func (r *ParentReconciler) reconcileNormal(ctx context.Context, parent *myv1alpha1.Parent) (ctrl.Result, error) {
	// Create a child object with an owner reference instead of managing
	// it through finalizers. The garbage collector handles cleanup automatically.
	child := &myv1alpha1.Child{
		ObjectMeta: metav1.ObjectMeta{
			Name:      fmt.Sprintf("%s-child", parent.Name),
			Namespace: parent.Namespace,
		},
		Spec: myv1alpha1.ChildSpec{
			Config: parent.Spec.Config,
		},
	}

	// SetControllerReference sets the owner reference AND adds a watch
	// so the parent reconciler is triggered when the child changes.
	if err := ctrl.SetControllerReference(parent, child, r.Scheme); err != nil {
		return ctrl.Result{}, fmt.Errorf("setting owner reference: %w", err)
	}

	// CreateOrUpdate handles the idempotent create/update case
	result, err := controllerutil.CreateOrUpdate(ctx, r.Client, child, func() error {
		child.Spec = myv1alpha1.ChildSpec{
			Config: parent.Spec.Config,
		}
		return nil
	})
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("reconciling child: %w", err)
	}
	log.FromContext(ctx).Info("Child reconciled", "result", result)

	// No finalizer needed on the parent for child cleanup:
	// When parent is deleted, GC automatically deletes child via ownerRef.
	// Only add a finalizer to the parent if there are EXTERNAL resources
	// (outside Kubernetes) that need cleanup.

	return ctrl.Result{}, nil
}
```

# Owner References in Detail

## Setting Owner References Correctly

Owner references have two important boolean fields: `controller` and `blockOwnerDeletion`. The `controller` field marks one specific owner as the "controlling" owner (there can only be one per object). The `blockOwnerDeletion` field, when true, adds the owned object to the owner's deletion wait list.

```go
// owner-reference-patterns.go
package controllers

import (
	"context"
	"fmt"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/utils/pointer"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
)

// SetControllerReference is the standard way to set an owner reference
// that marks the parent as the controller. Equivalent to:
//   child.OwnerReferences = append(child.OwnerReferences, metav1.OwnerReference{
//     APIVersion:         parent.APIVersion,
//     Kind:               parent.Kind,
//     Name:               parent.Name,
//     UID:                parent.UID,
//     Controller:         pointer.Bool(true),
//     BlockOwnerDeletion: pointer.Bool(true),
//   })

func reconcileConfigMap(ctx context.Context, c client.Client, scheme *runtime.Scheme,
	parent *myv1alpha1.MyResource) error {

	cm := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{
			Name:      parent.Name + "-config",
			Namespace: parent.Namespace,
		},
	}

	// ctrl.SetControllerReference handles all the owner reference details
	if err := ctrl.SetControllerReference(parent, cm, scheme); err != nil {
		return fmt.Errorf("setting owner ref on configmap: %w", err)
	}

	_, err := controllerutil.CreateOrUpdate(ctx, c, cm, func() error {
		cm.Data = map[string]string{
			"config.yaml": parent.Spec.Config,
		}
		return nil
	})
	return err
}

// Cross-namespace owner references are NOT supported by the Kubernetes
// garbage collector. If a parent in namespace A owns a child in namespace B,
// the GC will not clean up the child when the parent is deleted.
// In this case, use finalizers on the parent to manage cross-namespace cleanup.

func reconcileCrossNamespaceResource(ctx context.Context, c client.Client,
	parent *myv1alpha1.MyResource) error {

	// For cross-namespace ownership, we must use a finalizer instead
	// There is no safe owner reference pattern here.
	// The parent's finalizer cleanup logic must explicitly delete
	// the cross-namespace resource.
	return nil
}

// Non-controller owner references (multiple owners of one object)
// Useful when a resource is shared between multiple owners.
func addNonControllerOwnerRef(child metav1.Object, owner metav1.Object) {
	// A non-controller owner reference: owner "knows about" child
	// but does not exclusively control it.
	// blockOwnerDeletion: false means the owned object does not block
	// the owner's deletion.
	child.SetOwnerReferences(append(child.GetOwnerReferences(), metav1.OwnerReference{
		APIVersion:         "my-org.io/v1alpha1",
		Kind:               "MyResource",
		Name:               owner.GetName(),
		UID:                owner.GetUID(),
		Controller:         pointer.Bool(false),
		BlockOwnerDeletion: pointer.Bool(false),
	}))
}
```

## Cross-Namespace Resources and Cluster-Scoped Resources

Kubernetes only supports same-namespace owner references for namespace-scoped resources. Cluster-scoped resources can be owned by other cluster-scoped resources. The combinations that work:

```
┌──────────────────────────────────────────────────────────────────────┐
│              Owner Reference Validity Matrix                        │
├──────────────────────┬────────────────────────┬─────────────────────┤
│  Owner               │  Owned                 │  GC Supported?      │
├──────────────────────┼────────────────────────┼─────────────────────┤
│  Namespace-scoped    │  Namespace-scoped       │  YES (same NS only) │
│  (same namespace)    │  (same namespace)       │                     │
├──────────────────────┼────────────────────────┼─────────────────────┤
│  Namespace-scoped    │  Namespace-scoped       │  NO (rejected by    │
│  (different NS)      │  (different NS)         │  API server)        │
├──────────────────────┼────────────────────────┼─────────────────────┤
│  Cluster-scoped      │  Namespace-scoped       │  YES                │
│                      │                         │                     │
├──────────────────────┼────────────────────────┼─────────────────────┤
│  Namespace-scoped    │  Cluster-scoped         │  NO (rejected)      │
├──────────────────────┼────────────────────────┼─────────────────────┤
│  Cluster-scoped      │  Cluster-scoped         │  YES                │
└──────────────────────┴────────────────────────┴─────────────────────┘
```

# Garbage Collection Policies

## Foreground, Background, and Orphan Deletion

Kubernetes supports three deletion propagation policies:

**Background (default):** The owner is deleted immediately. The garbage collector then asynchronously deletes dependents. Users see the owner gone before dependents are cleaned up.

**Foreground:** The owner enters a "foreground deletion" state (indicated by the `foregroundDeletion` finalizer and a `deletionTimestamp`). The GC first deletes all `blockOwnerDeletion: true` dependents, then removes the owner. Users see the owner persist until all dependents are deleted.

**Orphan:** The owner is deleted but dependents are not. The owner references on dependents are not removed — orphaned objects simply lose their owner. They persist until explicitly deleted.

```go
// deletion-propagation.go
package main

import (
	"context"
	"fmt"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

func deleteWithPropagation(ctx context.Context, k8s kubernetes.Interface,
	namespace, name string, policy metav1.DeletionPropagation) error {

	deleteOptions := metav1.DeleteOptions{
		PropagationPolicy: &policy,
	}

	err := k8s.AppsV1().Deployments(namespace).Delete(ctx, name, deleteOptions)
	if err != nil {
		return fmt.Errorf("deleting deployment %s/%s: %w", namespace, name, err)
	}
	return nil
}

// Delete a deployment and wait for all pods to terminate (foreground)
func deleteAndWaitForPods(ctx context.Context, k8s kubernetes.Interface,
	namespace, deploymentName string) error {

	foreground := metav1.DeletePropagationForeground
	if err := deleteWithPropagation(ctx, k8s, namespace, deploymentName, foreground); err != nil {
		return err
	}

	// In foreground deletion, the deployment stays in the API until
	// all pods with blockOwnerDeletion=true are gone.
	// We can watch for the deployment to disappear.
	// (Implementation of watch logic omitted for brevity)
	return nil
}

// Adopt orphaned resources: update their owner references to point to a new owner
func adoptOrphanedPods(ctx context.Context, k8s kubernetes.Interface,
	namespace string, newOwnerRef metav1.OwnerReference) error {

	pods, err := k8s.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{
		LabelSelector: "app=my-app",
	})
	if err != nil {
		return fmt.Errorf("listing pods: %w", err)
	}

	for i := range pods.Items {
		pod := &pods.Items[i]
		if len(pod.OwnerReferences) == 0 {
			pod.OwnerReferences = []metav1.OwnerReference{newOwnerRef}
			if _, err := k8s.CoreV1().Pods(namespace).Update(ctx, pod, metav1.UpdateOptions{}); err != nil {
				return fmt.Errorf("adopting pod %s: %w", pod.Name, err)
			}
		}
	}
	return nil
}
```

## Controlling Garbage Collection in CRD Operators

```go
// operator-gc-patterns.go
package controllers

import (
	"context"
	"fmt"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

// DatabaseClusterReconciler manages database clusters.
// When a DatabaseCluster is deleted:
//   1. External cloud database is deleted (via finalizer)
//   2. Kubernetes Deployments/Services are deleted (via owner references)
//   3. PVCs are intentionally orphaned to protect data (via Orphan policy)

type DatabaseClusterReconciler struct {
	client.Client
	CloudDB CloudDatabaseClient
}

func (r *DatabaseClusterReconciler) reconcileNormal(ctx context.Context,
	cluster *myv1alpha1.DatabaseCluster) (ctrl.Result, error) {

	// Create StatefulSet with owner reference - auto-deleted when cluster is deleted
	sts := r.buildStatefulSet(cluster)
	if err := ctrl.SetControllerReference(cluster, sts, r.Scheme); err != nil {
		return ctrl.Result{}, err
	}

	// Create PVC *without* owner reference - intentionally orphaned
	// We do NOT want data to be lost when the cluster CR is deleted
	pvc := r.buildPVC(cluster)
	// Deliberately not setting owner reference on PVC
	// The finalizer logic will handle PVC cleanup if data deletion is requested

	// Apply both resources
	if err := r.applyStatefulSet(ctx, sts); err != nil {
		return ctrl.Result{}, err
	}
	if err := r.applyPVCIfNotExists(ctx, pvc); err != nil {
		return ctrl.Result{}, err
	}

	return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
}

func (r *DatabaseClusterReconciler) handleDeletion(ctx context.Context,
	cluster *myv1alpha1.DatabaseCluster) (ctrl.Result, error) {

	const finalizer = "my-org.io/database-cluster-cleanup"

	if !controllerutil.ContainsFinalizer(cluster, finalizer) {
		return ctrl.Result{}, nil
	}

	// Check if data deletion was requested
	if cluster.Spec.DeletionPolicy == "Delete" {
		// Delete PVCs explicitly (they were orphaned from owner refs)
		if err := r.deletePVCs(ctx, cluster); err != nil {
			return ctrl.Result{}, fmt.Errorf("deleting pvcs: %w", err)
		}
	}
	// If DeletionPolicy == "Retain", leave PVCs in place

	// Delete the external cloud database
	if err := r.CloudDB.Delete(ctx, cluster.Status.CloudDatabaseID); err != nil {
		return ctrl.Result{}, fmt.Errorf("deleting cloud database: %w", err)
	}

	// Remove finalizer - StatefulSet will be garbage collected via ownerRef
	patch := client.MergeFrom(cluster.DeepCopy())
	controllerutil.RemoveFinalizer(cluster, finalizer)
	return ctrl.Result{}, r.Patch(ctx, cluster, patch)
}

func (r *DatabaseClusterReconciler) deletePVCs(ctx context.Context,
	cluster *myv1alpha1.DatabaseCluster) error {

	pvcList := &corev1.PersistentVolumeClaimList{}
	if err := r.List(ctx, pvcList, client.InNamespace(cluster.Namespace),
		client.MatchingLabels{
			"database-cluster": cluster.Name,
		}); err != nil {
		return fmt.Errorf("listing pvcs: %w", err)
	}

	for i := range pvcList.Items {
		pvc := &pvcList.Items[i]
		if err := r.Delete(ctx, pvc); err != nil && !errors.IsNotFound(err) {
			return fmt.Errorf("deleting pvc %s: %w", pvc.Name, err)
		}
	}
	return nil
}

// buildStatefulSet returns a StatefulSet for the database cluster.
// Fields omitted for brevity.
func (r *DatabaseClusterReconciler) buildStatefulSet(cluster *myv1alpha1.DatabaseCluster) *appsv1.StatefulSet {
	return &appsv1.StatefulSet{
		ObjectMeta: metav1.ObjectMeta{
			Name:      cluster.Name,
			Namespace: cluster.Namespace,
			Labels: map[string]string{
				"database-cluster": cluster.Name,
			},
		},
	}
}

// buildPVC returns a PVC for the database cluster without owner references.
func (r *DatabaseClusterReconciler) buildPVC(cluster *myv1alpha1.DatabaseCluster) *corev1.PersistentVolumeClaim {
	return &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{
			Name:      fmt.Sprintf("%s-data", cluster.Name),
			Namespace: cluster.Namespace,
			Labels: map[string]string{
				"database-cluster": cluster.Name,
			},
			// NO ownerReferences here - data preservation
		},
	}
}

func (r *DatabaseClusterReconciler) applyStatefulSet(ctx context.Context, sts *appsv1.StatefulSet) error {
	existing := &appsv1.StatefulSet{}
	err := r.Get(ctx, types.NamespacedName{Name: sts.Name, Namespace: sts.Namespace}, existing)
	if errors.IsNotFound(err) {
		return r.Create(ctx, sts)
	}
	if err != nil {
		return err
	}
	// Update logic...
	return nil
}

func (r *DatabaseClusterReconciler) applyPVCIfNotExists(ctx context.Context, pvc *corev1.PersistentVolumeClaim) error {
	existing := &corev1.PersistentVolumeClaim{}
	err := r.Get(ctx, types.NamespacedName{Name: pvc.Name, Namespace: pvc.Namespace}, existing)
	if errors.IsNotFound(err) {
		return r.Create(ctx, pvc)
	}
	return err
}

// Helper: Unused variable prevention for the labels package import
var _ = labels.Set{}
```

# Debugging Stuck Objects

## Why Objects Get Stuck

An object can be stuck in terminating state for several reasons:

1. The controller that owns the finalizer is not running (crashed, scaled to zero, or never deployed)
2. The controller has a bug that never successfully removes the finalizer
3. The external cleanup operation is permanently failing
4. A network partition prevents the controller from reaching the API server

```bash
# Check terminating objects in a namespace
kubectl get all -n my-namespace --show-kind \
  | grep -v "Running\|Completed" \
  | head -30

# Find all objects with finalizers in a namespace
kubectl get all -n my-namespace -o json | \
  jq -r '.items[] | select(.metadata.finalizers | length > 0) | "\(.kind)/\(.metadata.name): \(.metadata.finalizers)"'

# Check all CRDs for stuck objects across the cluster
for crd in $(kubectl get crd -o name); do
  resource=$(echo "${crd}" | cut -d/ -f2 | cut -d. -f1)
  count=$(kubectl get "${resource}" --all-namespaces 2>/dev/null | \
    grep -c "Terminating" 2>/dev/null || echo 0)
  if [ "${count}" -gt 0 ]; then
    echo "${resource}: ${count} terminating"
  fi
done

# Get details on a stuck object
kubectl get myresource my-object -n my-namespace -o yaml | \
  grep -A 10 "finalizers:\|deletionTimestamp:\|ownerReferences:"
```

## Safely Removing a Stuck Finalizer

Before removing a finalizer manually, determine why the controller failed to remove it. If the external resource was already cleaned up or the controller logic has a permanent bug, manual removal may be appropriate. Document the decision.

```bash
# Check if the controller that owns the finalizer is running
kubectl -n my-controller-namespace get deployment my-controller
kubectl -n my-controller-namespace logs -l app=my-controller --tail=50 | \
  grep -i "error\|finalizer\|my-object"

# Option 1: Remove finalizer via kubectl patch (preferred - auditable)
kubectl patch myresource my-object -n my-namespace \
  --type='json' \
  -p='[{"op":"remove","path":"/metadata/finalizers/0"}]'

# Option 2: If multiple finalizers, remove by value
kubectl patch myresource my-object -n my-namespace \
  --type='merge' \
  -p='{"metadata":{"finalizers":[]}}'

# Option 3: Edit directly (use only when patch operations are unclear)
kubectl edit myresource my-object -n my-namespace
# Delete the entire finalizers: [...] block and save

# After removing the finalizer, verify the object is gone
kubectl get myresource my-object -n my-namespace
# Should return: Error from server (NotFound): myresources.my-org.io "my-object" not found
```

## Finding and Cleaning Up Orphaned Resources

```bash
#!/bin/bash
# find-orphaned-resources.sh - Find resources whose owners no longer exist

echo "=== Finding orphaned resources with dangling owner references ==="

# Process all namespaced resources
for resource in pods replicasets deployments configmaps services; do
  kubectl get "${resource}" --all-namespaces -o json 2>/dev/null | \
    jq -r --arg res "${resource}" '.items[] |
      select(.metadata.ownerReferences | length > 0) |
      "\(.metadata.namespace) \(.metadata.name) \(.metadata.ownerReferences[0].kind) \(.metadata.ownerReferences[0].name) \(.metadata.ownerReferences[0].uid)"' | \
    while read -r NS NAME OWNER_KIND OWNER_NAME OWNER_UID; do
      # Check if owner still exists
      OWNER_RESOURCE=$(echo "${OWNER_KIND}" | tr '[:upper:]' '[:lower:]')s
      OWNER_EXISTS=$(kubectl get "${OWNER_RESOURCE}" "${OWNER_NAME}" \
        -n "${NS}" 2>/dev/null | grep -c "${OWNER_NAME}" || echo 0)
      if [ "${OWNER_EXISTS}" -eq 0 ]; then
        echo "ORPHANED: ${resource}/${NS}/${NAME} (owner: ${OWNER_KIND}/${OWNER_NAME} not found)"
      fi
    done
done
```

## Garbage Collector Health Check

```bash
# Check GC controller metrics
kubectl -n kube-system get pods -l component=kube-controller-manager

# GC related metrics (if kube-controller-manager metrics are accessible)
# garbagecollector_attempt_to_delete_queue_length
# garbagecollector_attempt_to_orphan_queue_length
# garbagecollector_dirty_processing_latency_milliseconds

# Force GC processing by creating and deleting a test object with ownerRef
kubectl create namespace gc-test
kubectl run gc-test-pod --image=nginx -n gc-test
kubectl delete pod gc-test-pod -n gc-test --grace-period=0
kubectl delete namespace gc-test

# Check for events indicating GC failures
kubectl get events --all-namespaces \
  --field-selector reason=GCed,reason=OwnerRefInvalidNamespace \
  --sort-by='.lastTimestamp'
```

# Common Pitfalls and Production Patterns

## The Stale Cache Problem

When a controller adds a finalizer and then immediately tries to read the object back, it may get a cached version without the finalizer due to the informer cache's eventual consistency. Always use the reconcile loop's re-queue mechanism rather than trying to work around the cache.

```go
// stale-cache-pattern.go

// BAD: Reading from cache after write may return stale data
func (r *MyReconciler) badPattern(ctx context.Context, obj *myv1alpha1.MyResource) error {
	controllerutil.AddFinalizer(obj, myFinalizer)
	if err := r.Update(ctx, obj); err != nil {
		return err
	}
	// This may return the version WITHOUT the finalizer (cache not yet updated)
	freshObj := &myv1alpha1.MyResource{}
	r.Get(ctx, client.ObjectKeyFromObject(obj), freshObj) // potentially stale!
	_ = freshObj
	return nil
}

// GOOD: After any write, return Requeue=true and let the reconciler
// fetch the fresh version on the next reconcile loop pass
func (r *MyReconciler) goodPattern(ctx context.Context, obj *myv1alpha1.MyResource) (ctrl.Result, error) {
	if !controllerutil.ContainsFinalizer(obj, myFinalizer) {
		controllerutil.AddFinalizer(obj, myFinalizer)
		if err := r.Update(ctx, obj); err != nil {
			return ctrl.Result{}, err
		}
		// Return immediately - next reconcile will have fresh state
		return ctrl.Result{Requeue: true}, nil
	}
	// Continue with logic knowing finalizer is present
	return ctrl.Result{}, nil
}
```

## Status Update Conflicts

Updating the object's spec/metadata and its status in the same reconcile loop creates conflicts. Use the status subresource for status updates.

```go
// status-update-pattern.go

func (r *MyReconciler) updateStatus(ctx context.Context,
	obj *myv1alpha1.MyResource, phase myv1alpha1.Phase, message string) error {

	// Always work on a copy for status updates to avoid overwriting
	// spec changes made in the same reconcile
	statusPatch := client.MergeFrom(obj.DeepCopy())
	obj.Status.Phase = phase
	obj.Status.Message = message
	obj.Status.ObservedGeneration = obj.Generation

	// Use StatusClient to update via the /status subresource
	// This does not trigger spec validation webhooks
	return r.Status().Patch(ctx, obj, statusPatch)
}
```

Kubernetes finalizers, owner references, and garbage collection form a cohesive lifecycle management system that, when used correctly, enables operators to manage complex distributed state with confidence. The key principles are: finalizers for external resource cleanup, owner references for automatic Kubernetes-native resource cleanup, and explicit deletion policy controls for data that outlives the objects that reference it. Careful attention to idempotency, stale cache handling, and finalizer deadlock prevention distinguishes production-grade operators from fragile implementations that create stuck objects under failure conditions.
