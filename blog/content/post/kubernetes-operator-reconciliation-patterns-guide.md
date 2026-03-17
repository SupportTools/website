---
title: "Kubernetes Operator Patterns: Reconciliation Loops, Status Conditions, Finalizers, and Owner References"
date: 2028-07-29T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Operators", "Controller Runtime", "CRDs", "Reconciliation"]
categories:
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Kubernetes operator development covering reconciliation loop design, status condition management, finalizer patterns for safe deletion, owner reference garbage collection, and error handling strategies."
more_link: "yes"
url: "/kubernetes-operator-reconciliation-patterns-guide/"
---

Kubernetes operators extend the control plane with domain-specific automation. But writing an operator that works in a demo is very different from writing one that is reliable in production. Most operator tutorials cover the happy path and skip the scenarios that actually cause production incidents: what happens when a reconciliation is interrupted mid-way, how to clean up resources when a custom resource is deleted, how to surface meaningful status information, and how to prevent thundering-herd storms when the cluster is under pressure.

This guide covers the operator development patterns that matter most in production: idempotent reconciliation loops, proper status conditions, finalizer-based cleanup, owner reference chains, event recording, and error handling strategies that distinguish transient failures from permanent ones.

<!--more-->

# Kubernetes Operator Patterns: Production Reconciliation

## The Reconciliation Mental Model

Every operator is built around a single principle: **desired state vs. observed state**. The reconciler's job is to observe the current state of the world and make changes to bring it closer to the desired state. This must work correctly even when:

- The reconciler crashes in the middle of an operation
- The same reconciliation is triggered multiple times concurrently
- External resources are in unexpected states
- API calls fail transiently or permanently

The key insight is that reconciliation must be **idempotent**: running it twice in a row must produce the same result as running it once.

## Section 1: Project Setup

```bash
# Install the operator SDK.
curl -LO "https://github.com/operator-framework/operator-sdk/releases/download/v1.34.0/operator-sdk_linux_amd64"
chmod +x operator-sdk_linux_amd64
mv operator-sdk_linux_amd64 /usr/local/bin/operator-sdk

# Or use kubebuilder directly.
curl -L -o kubebuilder "https://go.kubebuilder.io/dl/latest/$(go env GOOS)/$(go env GOARCH)"
chmod +x kubebuilder
mv kubebuilder /usr/local/bin/

# Initialize a new operator project.
mkdir -p ~/go/src/github.com/example/database-operator
cd ~/go/src/github.com/example/database-operator
kubebuilder init --domain example.com --repo github.com/example/database-operator

# Create a new API (CRD + controller skeleton).
kubebuilder create api \
  --group database \
  --version v1alpha1 \
  --kind PostgresCluster \
  --resource \
  --controller
```

## Section 2: Custom Resource Definition

```go
// api/v1alpha1/postgrescluster_types.go
package v1alpha1

import (
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// PostgresClusterSpec defines the desired state of PostgresCluster.
type PostgresClusterSpec struct {
	// Replicas is the number of PostgreSQL instances.
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=7
	Replicas int32 `json:"replicas"`

	// Version is the PostgreSQL version to deploy.
	// +kubebuilder:validation:Enum="14";"15";"16"
	Version string `json:"version"`

	// StorageSize is the size of the data volume for each replica.
	StorageSize resource.Quantity `json:"storageSize"`

	// StorageClass is the name of the StorageClass to use for data volumes.
	// +optional
	StorageClass *string `json:"storageClass,omitempty"`

	// Resources defines resource requests and limits for each PostgreSQL pod.
	// +optional
	Resources corev1.ResourceRequirements `json:"resources,omitempty"`

	// Backup configures automated backups.
	// +optional
	Backup *BackupSpec `json:"backup,omitempty"`
}

// BackupSpec defines backup configuration.
type BackupSpec struct {
	Enabled  bool   `json:"enabled"`
	Schedule string `json:"schedule"`
	S3Bucket string `json:"s3Bucket"`
}

// PostgresClusterStatus defines the observed state of PostgresCluster.
type PostgresClusterStatus struct {
	// Conditions represents the latest available observations of the cluster's state.
	// +patchMergeKey=type
	// +patchStrategy=merge
	// +listType=map
	// +listMapKey=type
	Conditions []metav1.Condition `json:"conditions,omitempty" patchStrategy:"merge" patchMergeKey:"type"`

	// ReadyReplicas is the number of replicas that are ready.
	ReadyReplicas int32 `json:"readyReplicas,omitempty"`

	// CurrentPrimary is the name of the current primary pod.
	CurrentPrimary string `json:"currentPrimary,omitempty"`

	// ObservedGeneration is the generation of the spec that was last reconciled.
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`

	// Phase is a brief string indicating the current state.
	// +kubebuilder:validation:Enum=Pending;Creating;Running;Updating;Degraded;Failed
	Phase string `json:"phase,omitempty"`
}

// Condition type constants.
const (
	ConditionReady      = "Ready"
	ConditionProgressing = "Progressing"
	ConditionDegraded   = "Degraded"
	ConditionAvailable  = "Available"
)

// Phase constants.
const (
	PhasePending  = "Pending"
	PhaseCreating = "Creating"
	PhaseRunning  = "Running"
	PhaseUpdating = "Updating"
	PhaseDegraded = "Degraded"
	PhaseFailed   = "Failed"
)

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="Ready",type=string,JSONPath=`.status.readyReplicas`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`
type PostgresCluster struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   PostgresClusterSpec   `json:"spec,omitempty"`
	Status PostgresClusterStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true
type PostgresClusterList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []PostgresCluster `json:"items"`
}

func init() {
	SchemeBuilder.Register(&PostgresCluster{}, &PostgresClusterList{})
}
```

## Section 3: The Reconciler

```go
// internal/controller/postgrescluster_controller.go
package controller

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
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/log"

	databasev1alpha1 "github.com/example/database-operator/api/v1alpha1"
)

const (
	finalizerName      = "database.example.com/finalizer"
	requeueAfterNormal = 30 * time.Second
	requeueAfterFast   = 5 * time.Second
)

// PostgresClusterReconciler reconciles PostgresCluster objects.
type PostgresClusterReconciler struct {
	client.Client
	Scheme   *runtime.Scheme
	Recorder record.EventRecorder
}

// +kubebuilder:rbac:groups=database.example.com,resources=postgresclusters,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=database.example.com,resources=postgresclusters/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=database.example.com,resources=postgresclusters/finalizers,verbs=update
// +kubebuilder:rbac:groups=apps,resources=statefulsets,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=services;configmaps;secrets,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=events,verbs=create;patch

func (r *PostgresClusterReconciler) Reconcile(
	ctx context.Context,
	req ctrl.Request,
) (ctrl.Result, error) {
	log := log.FromContext(ctx)

	// Fetch the PostgresCluster resource.
	cluster := &databasev1alpha1.PostgresCluster{}
	if err := r.Get(ctx, req.NamespacedName, cluster); err != nil {
		if errors.IsNotFound(err) {
			// The resource was deleted; nothing to do.
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, fmt.Errorf("get PostgresCluster: %w", err)
	}

	log.Info("reconciling PostgresCluster",
		"name", cluster.Name,
		"generation", cluster.Generation,
		"phase", cluster.Status.Phase)

	// Handle deletion via finalizer.
	if !cluster.DeletionTimestamp.IsZero() {
		return r.reconcileDelete(ctx, cluster)
	}

	// Register our finalizer if not present.
	if !controllerutil.ContainsFinalizer(cluster, finalizerName) {
		controllerutil.AddFinalizer(cluster, finalizerName)
		if err := r.Update(ctx, cluster); err != nil {
			return ctrl.Result{}, fmt.Errorf("add finalizer: %w", err)
		}
		// Return early; the update will trigger another reconciliation.
		return ctrl.Result{}, nil
	}

	// Run the main reconciliation logic.
	return r.reconcileNormal(ctx, cluster)
}

// reconcileNormal handles the steady-state reconciliation.
func (r *PostgresClusterReconciler) reconcileNormal(
	ctx context.Context,
	cluster *databasev1alpha1.PostgresCluster,
) (ctrl.Result, error) {
	log := log.FromContext(ctx)

	// Set the Progressing condition immediately.
	r.setCondition(cluster, metav1.Condition{
		Type:               databasev1alpha1.ConditionProgressing,
		Status:             metav1.ConditionTrue,
		Reason:             "Reconciling",
		Message:            "Reconciliation in progress",
		ObservedGeneration: cluster.Generation,
	})

	// Reconcile the StatefulSet.
	sts, err := r.reconcileStatefulSet(ctx, cluster)
	if err != nil {
		r.Recorder.Eventf(cluster, corev1.EventTypeWarning,
			"ReconcileFailed", "Failed to reconcile StatefulSet: %v", err)
		r.setCondition(cluster, metav1.Condition{
			Type:               databasev1alpha1.ConditionReady,
			Status:             metav1.ConditionFalse,
			Reason:             "StatefulSetFailed",
			Message:            err.Error(),
			ObservedGeneration: cluster.Generation,
		})
		_ = r.updateStatus(ctx, cluster, databasev1alpha1.PhaseFailed)
		return ctrl.Result{RequeueAfter: requeueAfterFast}, nil
	}

	// Reconcile the Services.
	if err := r.reconcileServices(ctx, cluster); err != nil {
		r.Recorder.Eventf(cluster, corev1.EventTypeWarning,
			"ReconcileFailed", "Failed to reconcile Services: %v", err)
		return ctrl.Result{RequeueAfter: requeueAfterFast}, nil
	}

	// Check if the StatefulSet is ready.
	readyReplicas := sts.Status.ReadyReplicas
	desiredReplicas := cluster.Spec.Replicas

	cluster.Status.ReadyReplicas = readyReplicas
	cluster.Status.ObservedGeneration = cluster.Generation

	if readyReplicas == desiredReplicas {
		r.setCondition(cluster, metav1.Condition{
			Type:               databasev1alpha1.ConditionReady,
			Status:             metav1.ConditionTrue,
			Reason:             "AllReplicasReady",
			Message:            fmt.Sprintf("%d/%d replicas ready", readyReplicas, desiredReplicas),
			ObservedGeneration: cluster.Generation,
		})
		r.setCondition(cluster, metav1.Condition{
			Type:               databasev1alpha1.ConditionProgressing,
			Status:             metav1.ConditionFalse,
			Reason:             "ReconcileComplete",
			Message:            "All replicas are ready",
			ObservedGeneration: cluster.Generation,
		})
		_ = r.updateStatus(ctx, cluster, databasev1alpha1.PhaseRunning)
		log.Info("reconciliation complete", "readyReplicas", readyReplicas)
		return ctrl.Result{RequeueAfter: requeueAfterNormal}, nil
	}

	// Some replicas are not ready yet.
	phase := databasev1alpha1.PhaseCreating
	if cluster.Status.Phase == databasev1alpha1.PhaseRunning {
		phase = databasev1alpha1.PhaseUpdating
	}

	r.setCondition(cluster, metav1.Condition{
		Type:               databasev1alpha1.ConditionReady,
		Status:             metav1.ConditionFalse,
		Reason:             "ReplicasNotReady",
		Message:            fmt.Sprintf("%d/%d replicas ready", readyReplicas, desiredReplicas),
		ObservedGeneration: cluster.Generation,
	})
	_ = r.updateStatus(ctx, cluster, phase)

	// Recheck more frequently until ready.
	return ctrl.Result{RequeueAfter: requeueAfterFast}, nil
}

// reconcileDelete handles cleanup when the PostgresCluster is being deleted.
func (r *PostgresClusterReconciler) reconcileDelete(
	ctx context.Context,
	cluster *databasev1alpha1.PostgresCluster,
) (ctrl.Result, error) {
	log := log.FromContext(ctx)

	if !controllerutil.ContainsFinalizer(cluster, finalizerName) {
		return ctrl.Result{}, nil
	}

	log.Info("running pre-delete cleanup")
	r.Recorder.Event(cluster, corev1.EventTypeNormal, "Deleting", "Running pre-delete cleanup")

	// Perform any cleanup that must happen before Kubernetes deletes
	// owner-referenced resources. For example: snapshot the database,
	// revoke external access, notify downstream systems.
	if err := r.performCleanup(ctx, cluster); err != nil {
		r.Recorder.Eventf(cluster, corev1.EventTypeWarning,
			"DeleteFailed", "Cleanup failed: %v", err)
		// Do not remove the finalizer; retry.
		return ctrl.Result{RequeueAfter: requeueAfterFast}, nil
	}

	// Remove the finalizer to allow Kubernetes to proceed with deletion.
	controllerutil.RemoveFinalizer(cluster, finalizerName)
	if err := r.Update(ctx, cluster); err != nil {
		return ctrl.Result{}, fmt.Errorf("remove finalizer: %w", err)
	}

	log.Info("cleanup complete, finalizer removed")
	return ctrl.Result{}, nil
}

// performCleanup runs any operations that must happen before deletion.
func (r *PostgresClusterReconciler) performCleanup(
	ctx context.Context,
	cluster *databasev1alpha1.PostgresCluster,
) error {
	// Example: ensure no active connections before deletion.
	// In a real operator, this might trigger a final backup, revoke
	// credentials, or notify external systems.
	log := log.FromContext(ctx)
	log.Info("performing pre-delete cleanup for PostgresCluster",
		"name", cluster.Name)
	return nil
}
```

## Section 4: Owner References and Garbage Collection

Owner references create a parent-child relationship between Kubernetes objects. When the owner is deleted, Kubernetes automatically garbage-collects all objects with that owner reference.

```go
// reconcileStatefulSet creates or updates the StatefulSet for the cluster.
func (r *PostgresClusterReconciler) reconcileStatefulSet(
	ctx context.Context,
	cluster *databasev1alpha1.PostgresCluster,
) (*appsv1.StatefulSet, error) {
	desired := r.buildStatefulSet(cluster)

	// Set owner reference so the StatefulSet is garbage-collected
	// when the PostgresCluster is deleted.
	if err := controllerutil.SetControllerReference(cluster, desired, r.Scheme); err != nil {
		return nil, fmt.Errorf("set owner reference: %w", err)
	}

	// Check if the StatefulSet already exists.
	existing := &appsv1.StatefulSet{}
	err := r.Get(ctx, types.NamespacedName{
		Name:      desired.Name,
		Namespace: desired.Namespace,
	}, existing)

	if errors.IsNotFound(err) {
		// Create the StatefulSet.
		if err := r.Create(ctx, desired); err != nil {
			return nil, fmt.Errorf("create StatefulSet: %w", err)
		}
		r.Recorder.Eventf(cluster, corev1.EventTypeNormal,
			"Created", "StatefulSet %s created", desired.Name)
		return desired, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get StatefulSet: %w", err)
	}

	// Update the existing StatefulSet if needed.
	// Use a strategic merge patch to apply only the changes we care about.
	patch := client.MergeFrom(existing.DeepCopy())
	existing.Spec.Replicas = &cluster.Spec.Replicas
	existing.Spec.Template.Spec.Containers[0].Resources = cluster.Spec.Resources

	if err := r.Patch(ctx, existing, patch); err != nil {
		return nil, fmt.Errorf("patch StatefulSet: %w", err)
	}

	// Fetch the updated StatefulSet to get current status.
	if err := r.Get(ctx, types.NamespacedName{
		Name:      existing.Name,
		Namespace: existing.Namespace,
	}, existing); err != nil {
		return nil, fmt.Errorf("re-get StatefulSet: %w", err)
	}

	return existing, nil
}

func (r *PostgresClusterReconciler) buildStatefulSet(
	cluster *databasev1alpha1.PostgresCluster,
) *appsv1.StatefulSet {
	labels := map[string]string{
		"app.kubernetes.io/name":       "postgres",
		"app.kubernetes.io/instance":   cluster.Name,
		"app.kubernetes.io/managed-by": "database-operator",
	}

	replicas := cluster.Spec.Replicas

	return &appsv1.StatefulSet{
		ObjectMeta: metav1.ObjectMeta{
			Name:      cluster.Name,
			Namespace: cluster.Namespace,
			Labels:    labels,
		},
		Spec: appsv1.StatefulSetSpec{
			Replicas:    &replicas,
			ServiceName: cluster.Name + "-headless",
			Selector: &metav1.LabelSelector{
				MatchLabels: labels,
			},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: labels},
				Spec: corev1.PodSpec{
					Containers: []corev1.Container{
						{
							Name:  "postgres",
							Image: fmt.Sprintf("postgres:%s", cluster.Spec.Version),
							Env: []corev1.EnvVar{
								{
									Name: "POSTGRES_PASSWORD",
									ValueFrom: &corev1.EnvVarSource{
										SecretKeyRef: &corev1.SecretKeySelector{
											LocalObjectReference: corev1.LocalObjectReference{
												Name: cluster.Name + "-credentials",
											},
											Key: "password",
										},
									},
								},
							},
							Resources: cluster.Spec.Resources,
							VolumeMounts: []corev1.VolumeMount{
								{
									Name:      "data",
									MountPath: "/var/lib/postgresql/data",
								},
							},
						},
					},
				},
			},
			VolumeClaimTemplates: []corev1.PersistentVolumeClaim{
				{
					ObjectMeta: metav1.ObjectMeta{Name: "data"},
					Spec: corev1.PersistentVolumeClaimSpec{
						StorageClassName: cluster.Spec.StorageClass,
						AccessModes:      []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce},
						Resources: corev1.VolumeResourceRequirements{
							Requests: corev1.ResourceList{
								corev1.ResourceStorage: cluster.Spec.StorageSize,
							},
						},
					},
				},
			},
		},
	}
}
```

## Section 5: Status Conditions

Status conditions are the standard way to communicate the detailed state of a custom resource. The `metav1.Condition` type provides a structured format that kubectl understands:

```go
// setCondition sets a condition on the cluster, using the standard condition API.
func (r *PostgresClusterReconciler) setCondition(
	cluster *databasev1alpha1.PostgresCluster,
	condition metav1.Condition,
) {
	condition.LastTransitionTime = metav1.NewTime(time.Now())
	meta.SetStatusCondition(&cluster.Status.Conditions, condition)
}

// updateStatus patches the cluster's status subresource.
// Uses status subresource to avoid conflicts with spec updates.
func (r *PostgresClusterReconciler) updateStatus(
	ctx context.Context,
	cluster *databasev1alpha1.PostgresCluster,
	phase string,
) error {
	cluster.Status.Phase = phase
	if err := r.Status().Update(ctx, cluster); err != nil {
		log.FromContext(ctx).Error(err, "failed to update status")
		return err
	}
	return nil
}
```

### Viewing Status Conditions

```bash
# kubectl shows conditions in a readable format.
kubectl describe postgrescluster my-cluster -n production

# Example output:
# Status:
#   Conditions:
#     Last Transition Time:  2028-07-29T10:00:00Z
#     Message:               All replicas are ready
#     Observed Generation:   3
#     Reason:                AllReplicasReady
#     Status:                True
#     Type:                  Ready
#     Last Transition Time:  2028-07-29T10:00:00Z
#     Message:               All replicas are ready
#     Observed Generation:   3
#     Reason:                ReconcileComplete
#     Status:                False
#     Type:                  Progressing
#   Current Primary:         my-cluster-0
#   Observed Generation:     3
#   Phase:                   Running
#   Ready Replicas:          3
```

## Section 6: Error Handling and Retry Strategy

Distinguishing between transient and permanent errors is critical for operational efficiency:

```go
// reconcileWithErrorClassification demonstrates error classification.
func (r *PostgresClusterReconciler) reconcileWithErrorClassification(
	ctx context.Context,
	cluster *databasev1alpha1.PostgresCluster,
) (ctrl.Result, error) {

	// Create a resource with retry for conflicts.
	desired := r.buildStatefulSet(cluster)
	if err := controllerutil.SetControllerReference(cluster, desired, r.Scheme); err != nil {
		// This is a permanent programming error; don't retry.
		return ctrl.Result{}, fmt.Errorf("set owner reference: %w", err)
	}

	err := r.Create(ctx, desired)
	if err != nil {
		switch {
		case errors.IsAlreadyExists(err):
			// Not an error; the resource already exists. This is expected
			// when the reconciler runs multiple times.
			return ctrl.Result{}, nil

		case errors.IsConflict(err):
			// Transient conflict; requeue quickly.
			return ctrl.Result{RequeueAfter: time.Second}, nil

		case errors.IsServiceUnavailable(err) || errors.IsServerTimeout(err):
			// Transient infrastructure issue; requeue with backoff.
			return ctrl.Result{RequeueAfter: 10 * time.Second}, nil

		case errors.IsUnauthorized(err) || errors.IsForbidden(err):
			// Permission error; don't retry (fixing requires code change or RBAC update).
			r.Recorder.Eventf(cluster, corev1.EventTypeWarning,
				"PermissionDenied", "RBAC error creating StatefulSet: %v", err)
			return ctrl.Result{}, fmt.Errorf("permission denied: %w", err)

		default:
			// Unknown error; log and retry.
			return ctrl.Result{}, fmt.Errorf("create StatefulSet: %w", err)
		}
	}

	return ctrl.Result{}, nil
}
```

### Exponential Backoff with Jitter

```go
// RetryConfig defines the retry parameters for an operation.
type RetryConfig struct {
	MaxRetries  int
	BaseDelay   time.Duration
	MaxDelay    time.Duration
	Multiplier  float64
}

// retryWithBackoff retries an operation with exponential backoff and jitter.
func retryWithBackoff(
	ctx context.Context,
	cfg RetryConfig,
	operation func(ctx context.Context) error,
) error {
	var lastErr error
	delay := cfg.BaseDelay

	for attempt := 0; attempt < cfg.MaxRetries; attempt++ {
		if err := operation(ctx); err == nil {
			return nil
		} else {
			lastErr = err
		}

		// Add jitter: delay ± 20%.
		jitter := time.Duration(float64(delay) * (0.8 + rand.Float64()*0.4))
		timer := time.NewTimer(jitter)
		select {
		case <-timer.C:
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		}

		delay = time.Duration(float64(delay) * cfg.Multiplier)
		if delay > cfg.MaxDelay {
			delay = cfg.MaxDelay
		}
	}

	return fmt.Errorf("max retries exceeded: %w", lastErr)
}
```

## Section 7: Watches and Predicates

By default, controller-runtime watches all changes to owned resources and triggers reconciliation. Predicates filter events to reduce unnecessary reconciliations:

```go
// SetupWithManager registers the controller with the manager.
func (r *PostgresClusterReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&databasev1alpha1.PostgresCluster{}).
		// Watch owned StatefulSets.
		Owns(&appsv1.StatefulSet{}).
		// Watch owned Services.
		Owns(&corev1.Service{}).
		// Watch owned ConfigMaps.
		Owns(&corev1.ConfigMap{}).
		// Use predicates to reduce reconciliation noise.
		WithEventFilter(predicate.And(
			// Ignore events where only the resource version changed (no spec change).
			predicate.GenerationChangedPredicate{},
			// Ignore delete events for non-owned resources.
			predicate.Not(predicate.Funcs{
				DeleteFunc: func(e event.DeleteEvent) bool {
					return false
				},
			}),
		)).
		// Set the maximum number of concurrent reconciliations.
		WithOptions(controller.Options{
			MaxConcurrentReconciles: 5,
			// Rate limit to prevent thundering herds.
			RateLimiter: workqueue.NewItemExponentialFailureRateLimiter(
				500*time.Millisecond,
				30*time.Second,
			),
		}).
		Complete(r)
}
```

### Custom Watch: React to Pod Status Changes

```go
// Watch pods not owned directly but associated with the cluster.
// This triggers reconciliation when pods become ready or fail.
func (r *PostgresClusterReconciler) SetupWithManagerAdvanced(mgr ctrl.Manager) error {
	// Map a pod event to the owning PostgresCluster.
	mapPodToCluster := func(ctx context.Context, obj client.Object) []reconcile.Request {
		pod := obj.(*corev1.Pod)
		// Look for the cluster name label set by our StatefulSet.
		clusterName, ok := pod.Labels["app.kubernetes.io/instance"]
		if !ok {
			return nil
		}
		return []reconcile.Request{
			{NamespacedName: types.NamespacedName{
				Namespace: pod.Namespace,
				Name:      clusterName,
			}},
		}
	}

	return ctrl.NewControllerManagedBy(mgr).
		For(&databasev1alpha1.PostgresCluster{}).
		Owns(&appsv1.StatefulSet{}).
		// Also watch pods and enqueue the owning cluster.
		Watches(
			&corev1.Pod{},
			handler.EnqueueRequestsFromMapFunc(mapPodToCluster),
			builder.WithPredicates(predicate.Funcs{
				// Only trigger on pod Ready condition changes.
				UpdateFunc: func(e event.UpdateEvent) bool {
					oldPod := e.ObjectOld.(*corev1.Pod)
					newPod := e.ObjectNew.(*corev1.Pod)
					return podReadinessChanged(oldPod, newPod)
				},
			}),
		).
		Complete(r)
}

func podReadinessChanged(old, new *corev1.Pod) bool {
	for _, nc := range new.Status.Conditions {
		if nc.Type != corev1.PodReady {
			continue
		}
		for _, oc := range old.Status.Conditions {
			if oc.Type != corev1.PodReady {
				continue
			}
			return nc.Status != oc.Status
		}
	}
	return false
}
```

## Section 8: Testing Operators

```go
// internal/controller/postgrescluster_controller_test.go
package controller

import (
	"context"
	"testing"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"

	databasev1alpha1 "github.com/example/database-operator/api/v1alpha1"
)

var _ = Describe("PostgresCluster Controller", func() {
	const (
		clusterName      = "test-cluster"
		clusterNamespace = "default"
		timeout          = time.Second * 10
		interval         = time.Millisecond * 250
	)

	Context("When creating a PostgresCluster", func() {
		It("Should create a StatefulSet with the correct spec", func() {
			ctx := context.Background()

			cluster := &databasev1alpha1.PostgresCluster{
				ObjectMeta: metav1.ObjectMeta{
					Name:      clusterName,
					Namespace: clusterNamespace,
				},
				Spec: databasev1alpha1.PostgresClusterSpec{
					Replicas:    3,
					Version:     "16",
					StorageSize: resource.MustParse("10Gi"),
					Resources: corev1.ResourceRequirements{
						Requests: corev1.ResourceList{
							corev1.ResourceCPU:    resource.MustParse("500m"),
							corev1.ResourceMemory: resource.MustParse("1Gi"),
						},
					},
				},
			}

			Expect(k8sClient.Create(ctx, cluster)).To(Succeed())

			// Verify the StatefulSet is created.
			sts := &appsv1.StatefulSet{}
			Eventually(func() error {
				return k8sClient.Get(ctx,
					types.NamespacedName{Name: clusterName, Namespace: clusterNamespace},
					sts)
			}, timeout, interval).Should(Succeed())

			Expect(*sts.Spec.Replicas).To(Equal(int32(3)))

			// Verify the owner reference is set.
			Expect(sts.OwnerReferences).To(HaveLen(1))
			Expect(sts.OwnerReferences[0].Name).To(Equal(clusterName))
			Expect(*sts.OwnerReferences[0].Controller).To(BeTrue())
		})

		It("Should add a finalizer to the cluster", func() {
			ctx := context.Background()

			cluster := &databasev1alpha1.PostgresCluster{}
			Eventually(func() bool {
				if err := k8sClient.Get(ctx,
					types.NamespacedName{Name: clusterName, Namespace: clusterNamespace},
					cluster); err != nil {
					return false
				}
				return controllerutil.ContainsFinalizer(cluster, finalizerName)
			}, timeout, interval).Should(BeTrue())
		})
	})
})
```

## Section 9: Manager Configuration

```go
// cmd/main.go
package main

import (
	"flag"
	"os"
	"time"

	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/healthz"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"
)

func main() {
	var metricsAddr string
	var probeAddr string
	var leaderElect bool

	flag.StringVar(&metricsAddr, "metrics-bind-address", ":8080", "")
	flag.StringVar(&probeAddr, "health-probe-bind-address", ":8081", "")
	flag.BoolVar(&leaderElect, "leader-elect", true,
		"Enable leader election for controller manager.")
	flag.Parse()

	ctrl.SetLogger(zap.New())
	setupLog := ctrl.Log.WithName("setup")

	mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
		Scheme: scheme,
		Metrics: metricsserver.Options{
			BindAddress: metricsAddr,
		},
		HealthProbeBindAddress: probeAddr,
		LeaderElection:         leaderElect,
		LeaderElectionID:       "database-operator-leader",
		// Sync period: how often to re-reconcile all resources even without events.
		SyncPeriod: durationPointer(10 * time.Minute),
	})
	if err != nil {
		setupLog.Error(err, "create manager")
		os.Exit(1)
	}

	if err := (&controller.PostgresClusterReconciler{
		Client:   mgr.GetClient(),
		Scheme:   mgr.GetScheme(),
		Recorder: mgr.GetEventRecorderFor("database-operator"),
	}).SetupWithManager(mgr); err != nil {
		setupLog.Error(err, "create controller")
		os.Exit(1)
	}

	if err := mgr.AddHealthzCheck("healthz", healthz.Ping); err != nil {
		setupLog.Error(err, "add healthz check")
		os.Exit(1)
	}
	if err := mgr.AddReadyzCheck("readyz", healthz.Ping); err != nil {
		setupLog.Error(err, "add readyz check")
		os.Exit(1)
	}

	setupLog.Info("starting manager")
	if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
		setupLog.Error(err, "manager exited")
		os.Exit(1)
	}
}

func durationPointer(d time.Duration) *time.Duration { return &d }
```

## Section 10: Production Checklist

**Reconciliation Design**
- Every reconciliation must be idempotent
- Use server-side apply or strategic merge patch, not full object replacement
- Always re-fetch objects before patching to avoid conflicts
- Set `ObservedGeneration` in status to allow clients to detect when their changes are processed

**Finalizers**
- Register the finalizer in the first reconciliation; never skip it
- Always check if the finalizer is present before running cleanup logic
- Set a deadline for cleanup: if it takes longer than expected, log a warning and consider proceeding anyway to prevent infinite deletion loops

**Owner References**
- Use `SetControllerReference` (not `SetOwnerReference`) for a single owner
- Only create owner references within the same namespace
- Cross-namespace garbage collection is not supported

**Status Management**
- Use the status subresource (`r.Status().Update()`) to avoid conflicts
- Use `metav1.Condition` for all status conditions
- Always update `ObservedGeneration` and `Phase`
- Record Kubernetes events for all significant state transitions

**Rate Limiting and Concurrency**
- Configure `MaxConcurrentReconciles` to limit parallelism
- Use the exponential failure rate limiter to handle bursts of errors
- Set a sync period to catch drift even when no events are received

## Conclusion

Production-quality Kubernetes operators require careful attention to the edge cases that make the difference between a system that works in demos and one that is reliable under real operational conditions. Idempotent reconciliation prevents data corruption when reconciliations run multiple times. Proper finalizer management ensures clean deletion without resource leaks. Status conditions give operators and humans a clear picture of what is happening. Owner references automate garbage collection. Predicates and rate limiters prevent thundering herds.

The patterns in this guide are drawn from real production operators. They represent the accumulated wisdom of the controller-runtime community and the operators shipped by projects like the CloudNative PG operator, Strimzi, and the Prometheus Operator — all of which have faced and solved these challenges at scale.
