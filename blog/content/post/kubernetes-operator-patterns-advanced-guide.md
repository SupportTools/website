---
title: "Advanced Kubernetes Operator Patterns: Controller-Runtime Deep Dive"
date: 2027-10-16T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Operators", "controller-runtime", "Go", "CRD"]
categories:
- Kubernetes
- Go
author: "Matthew Mattox - mmattox@support.tools"
description: "Advanced controller-runtime patterns for production Kubernetes operators. Covers reconciler design with finalizers, owner references, status conditions, event filtering, leader election, webhook servers, field indexers, controller-gen markers, and envtest testing."
more_link: "yes"
url: "/kubernetes-operator-patterns-advanced-guide/"
---

Building production-grade Kubernetes operators requires mastery of controller-runtime patterns that go far beyond the basic reconcile loop. Finalizers ensure cleanup of external resources, owner references enable garbage collection, status conditions provide structured health reporting, and webhook servers enforce admission control — all of which require careful design to avoid common pitfalls like reconciliation storms, split-brain conditions, and resource leaks. This guide covers the advanced patterns used in production operators at scale.

<!--more-->

# Advanced Kubernetes Operator Patterns: Controller-Runtime Deep Dive

## Section 1: Project Setup and Structure

### Operator SDK Scaffold

```bash
# Install operator-sdk
curl -LO https://github.com/operator-framework/operator-sdk/releases/download/v1.38.0/operator-sdk_linux_amd64
chmod +x operator-sdk_linux_amd64
sudo mv operator-sdk_linux_amd64 /usr/local/bin/operator-sdk

# Initialize project
mkdir database-operator && cd database-operator
operator-sdk init \
  --domain support.tools \
  --repo github.com/support-tools/database-operator

# Create API and controller scaffold
operator-sdk create api \
  --group databases \
  --version v1alpha1 \
  --kind ManagedDatabase \
  --resource \
  --controller
```

### Project Structure

```
database-operator/
├── api/
│   └── v1alpha1/
│       ├── manageddatabase_types.go     # CRD types
│       ├── manageddatabase_webhook.go   # Webhook implementation
│       └── groupversion_info.go
├── cmd/
│   └── main.go                          # Entry point
├── internal/
│   └── controller/
│       ├── manageddatabase_controller.go
│       └── suite_test.go
├── config/
│   ├── crd/                             # Generated CRD manifests
│   ├── rbac/                            # Generated RBAC manifests
│   └── webhook/                         # Webhook configuration
└── Makefile
```

## Section 2: CRD Type Design with controller-gen Markers

Controller-gen markers in Go comments generate CRD schemas, RBAC rules, and webhook configurations.

### ManagedDatabase CRD Types

```go
// api/v1alpha1/manageddatabase_types.go
package v1alpha1

import (
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ManagedDatabaseSpec defines the desired state of ManagedDatabase.
type ManagedDatabaseSpec struct {
	// Engine specifies the database engine (postgres, mysql, redis).
	// +kubebuilder:validation:Enum=postgres;mysql;redis
	// +kubebuilder:validation:Required
	Engine string `json:"engine"`

	// Version specifies the database engine version.
	// +kubebuilder:validation:MinLength=3
	// +kubebuilder:validation:MaxLength=20
	// +kubebuilder:validation:Required
	Version string `json:"version"`

	// Replicas specifies the number of replicas.
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=9
	// +kubebuilder:default=1
	Replicas int32 `json:"replicas,omitempty"`

	// Storage configures persistent storage.
	// +kubebuilder:validation:Required
	Storage StorageSpec `json:"storage"`

	// Resources configures compute resources.
	// +optional
	Resources corev1.ResourceRequirements `json:"resources,omitempty"`

	// BackupSchedule is a cron expression for automated backups.
	// +kubebuilder:validation:Pattern=`^(@(annually|yearly|monthly|weekly|daily|hourly|reboot))|(@every (\d+(ns|us|µs|ms|s|m|h))+)|((((\d+,)+\d+|(\d+(\/|-)\d+)|\d+|\*) ?){5,7})$`
	// +optional
	BackupSchedule string `json:"backupSchedule,omitempty"`

	// MaintenanceWindow specifies when maintenance operations can occur.
	// +optional
	MaintenanceWindow *MaintenanceWindowSpec `json:"maintenanceWindow,omitempty"`
}

// StorageSpec defines storage configuration.
type StorageSpec struct {
	// Size is the storage capacity.
	// +kubebuilder:validation:Required
	Size string `json:"size"`

	// StorageClass is the Kubernetes StorageClass name.
	// +optional
	StorageClass string `json:"storageClass,omitempty"`
}

// MaintenanceWindowSpec defines a maintenance window.
type MaintenanceWindowSpec struct {
	// DayOfWeek is the day for maintenance (0=Sunday through 6=Saturday).
	// +kubebuilder:validation:Minimum=0
	// +kubebuilder:validation:Maximum=6
	DayOfWeek int `json:"dayOfWeek"`

	// StartHour is the UTC hour to start maintenance.
	// +kubebuilder:validation:Minimum=0
	// +kubebuilder:validation:Maximum=23
	StartHour int `json:"startHour"`
}

// ManagedDatabaseStatus defines the observed state of ManagedDatabase.
type ManagedDatabaseStatus struct {
	// Phase represents the current lifecycle phase.
	// +kubebuilder:validation:Enum=Pending;Provisioning;Running;Updating;Failed;Terminating
	Phase string `json:"phase,omitempty"`

	// Conditions represent the latest available observations of the database's state.
	// +listType=map
	// +listMapKey=type
	// +patchStrategy=merge
	// +patchMergeKey=type
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`

	// ReadyReplicas is the number of ready replicas.
	// +optional
	ReadyReplicas int32 `json:"readyReplicas,omitempty"`

	// ConnectionSecret is the name of the Secret containing connection details.
	// +optional
	ConnectionSecret string `json:"connectionSecret,omitempty"`

	// LastBackupTime is when the last successful backup completed.
	// +optional
	LastBackupTime *metav1.Time `json:"lastBackupTime,omitempty"`

	// ObservedGeneration is the most recently observed generation.
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`
}

// Condition type constants
const (
	ConditionReady        = "Ready"
	ConditionProvisioning = "Provisioning"
	ConditionDegraded     = "Degraded"
	ConditionBackingUp    = "BackingUp"
)

// Phase constants
const (
	PhasePending      = "Pending"
	PhaseProvisioning = "Provisioning"
	PhaseRunning      = "Running"
	PhaseUpdating     = "Updating"
	PhaseFailed       = "Failed"
	PhaseTerminating  = "Terminating"
)

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Engine",type=string,JSONPath=`.spec.engine`
// +kubebuilder:printcolumn:name="Version",type=string,JSONPath=`.spec.version`
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="Ready",type=string,JSONPath=`.status.readyReplicas`
// +kubebuilder:printcolumn:name="Age",type="date",JSONPath=".metadata.creationTimestamp"
// +kubebuilder:resource:scope=Namespaced,shortName=mdb,categories=databases

// ManagedDatabase is the Schema for the manageddatabases API.
type ManagedDatabase struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   ManagedDatabaseSpec   `json:"spec,omitempty"`
	Status ManagedDatabaseStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// ManagedDatabaseList contains a list of ManagedDatabase.
type ManagedDatabaseList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []ManagedDatabase `json:"items"`
}

func init() {
	SchemeBuilder.Register(&ManagedDatabase{}, &ManagedDatabaseList{})
}
```

Generate CRDs and RBAC:

```bash
make generate   # Runs controller-gen to generate DeepCopy methods
make manifests  # Generates CRD YAML and RBAC rules
```

## Section 3: Reconciler Design with Finalizers

Finalizers ensure external resources are cleaned up when a Kubernetes object is deleted.

### Controller with Finalizers

```go
// internal/controller/manageddatabase_controller.go
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
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/log"

	databasesv1alpha1 "github.com/support-tools/database-operator/api/v1alpha1"
)

const (
	databaseFinalizer = "databases.support.tools/finalizer"
	requeueAfterShort = 10 * time.Second
	requeueAfterLong  = 5 * time.Minute
)

// ManagedDatabaseReconciler reconciles a ManagedDatabase object.
type ManagedDatabaseReconciler struct {
	client.Client
	Scheme   *runtime.Scheme
	Recorder record.EventRecorder
}

// +kubebuilder:rbac:groups=databases.support.tools,resources=manageddatabases,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=databases.support.tools,resources=manageddatabases/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=databases.support.tools,resources=manageddatabases/finalizers,verbs=update
// +kubebuilder:rbac:groups=apps,resources=statefulsets,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=services;configmaps;secrets;persistentvolumeclaims,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=events,verbs=create;patch

func (r *ManagedDatabaseReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := log.FromContext(ctx)

	// Fetch the ManagedDatabase instance
	db := &databasesv1alpha1.ManagedDatabase{}
	if err := r.Get(ctx, req.NamespacedName, db); err != nil {
		if errors.IsNotFound(err) {
			// Object deleted, nothing to do
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, fmt.Errorf("fetching ManagedDatabase: %w", err)
	}

	// Update ObservedGeneration to track spec changes
	if db.Status.ObservedGeneration != db.Generation {
		db.Status.ObservedGeneration = db.Generation
		// Status update is deferred to end of reconcile
	}

	// Handle deletion with finalizer
	if !db.DeletionTimestamp.IsZero() {
		return r.reconcileDelete(ctx, db)
	}

	// Add finalizer if not present
	if !controllerutil.ContainsFinalizer(db, databaseFinalizer) {
		controllerutil.AddFinalizer(db, databaseFinalizer)
		if err := r.Update(ctx, db); err != nil {
			return ctrl.Result{}, fmt.Errorf("adding finalizer: %w", err)
		}
		// Requeue after adding finalizer
		return ctrl.Result{Requeue: true}, nil
	}

	// Main reconciliation
	result, err := r.reconcileNormal(ctx, db)
	if err != nil {
		r.Recorder.Event(db, corev1.EventTypeWarning, "ReconcileError", err.Error())
		logger.Error(err, "Reconciliation failed")
		_ = r.setConditionFailed(ctx, db, err.Error())
		return ctrl.Result{}, err
	}

	return result, nil
}

func (r *ManagedDatabaseReconciler) reconcileNormal(
	ctx context.Context,
	db *databasesv1alpha1.ManagedDatabase,
) (ctrl.Result, error) {
	logger := log.FromContext(ctx)

	// Set provisioning condition if first time
	if db.Status.Phase == "" {
		db.Status.Phase = databasesv1alpha1.PhaseProvisioning
		if err := r.setCondition(ctx, db, databasesv1alpha1.ConditionProvisioning,
			metav1.ConditionTrue, "Provisioning", "Database provisioning started"); err != nil {
			return ctrl.Result{}, err
		}
	}

	// Reconcile StatefulSet
	sts, err := r.reconcileStatefulSet(ctx, db)
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("reconciling StatefulSet: %w", err)
	}

	// Check if StatefulSet is ready
	if sts.Status.ReadyReplicas < db.Spec.Replicas {
		logger.Info("StatefulSet not yet ready",
			"readyReplicas", sts.Status.ReadyReplicas,
			"desiredReplicas", db.Spec.Replicas)

		db.Status.ReadyReplicas = sts.Status.ReadyReplicas
		_ = r.updateStatus(ctx, db)

		return ctrl.Result{RequeueAfter: requeueAfterShort}, nil
	}

	// Reconcile connection Secret
	if err := r.reconcileConnectionSecret(ctx, db); err != nil {
		return ctrl.Result{}, fmt.Errorf("reconciling connection secret: %w", err)
	}

	// Update status to Running
	if db.Status.Phase != databasesv1alpha1.PhaseRunning {
		db.Status.Phase = databasesv1alpha1.PhaseRunning
		db.Status.ReadyReplicas = sts.Status.ReadyReplicas
		if err := r.setCondition(ctx, db, databasesv1alpha1.ConditionReady,
			metav1.ConditionTrue, "Ready", "Database is ready"); err != nil {
			return ctrl.Result{}, err
		}
		r.Recorder.Event(db, corev1.EventTypeNormal, "Ready", "Database is ready")
	}

	return ctrl.Result{RequeueAfter: requeueAfterLong}, nil
}

func (r *ManagedDatabaseReconciler) reconcileDelete(
	ctx context.Context,
	db *databasesv1alpha1.ManagedDatabase,
) (ctrl.Result, error) {
	logger := log.FromContext(ctx)

	if !controllerutil.ContainsFinalizer(db, databaseFinalizer) {
		return ctrl.Result{}, nil
	}

	logger.Info("Running cleanup for ManagedDatabase deletion")

	// Update phase to Terminating
	db.Status.Phase = databasesv1alpha1.PhaseTerminating
	_ = r.updateStatus(ctx, db)

	// Perform external resource cleanup (e.g., delete cloud RDS instance)
	if err := r.deleteExternalResources(ctx, db); err != nil {
		return ctrl.Result{}, fmt.Errorf("deleting external resources: %w", err)
	}

	// Remove finalizer to allow Kubernetes to delete the object
	controllerutil.RemoveFinalizer(db, databaseFinalizer)
	if err := r.Update(ctx, db); err != nil {
		return ctrl.Result{}, fmt.Errorf("removing finalizer: %w", err)
	}

	logger.Info("Cleanup complete, finalizer removed")
	return ctrl.Result{}, nil
}

func (r *ManagedDatabaseReconciler) deleteExternalResources(
	ctx context.Context,
	db *databasesv1alpha1.ManagedDatabase,
) error {
	// Implement external resource deletion here
	// e.g., delete AWS RDS cluster, revoke DNS records, etc.
	logger := log.FromContext(ctx)
	logger.Info("Deleting external resources for database",
		"name", db.Name, "namespace", db.Namespace)
	return nil
}
```

## Section 4: Owner References for Garbage Collection

Owner references enable automatic garbage collection — when a parent resource is deleted, all owned child resources are deleted automatically.

```go
func (r *ManagedDatabaseReconciler) reconcileStatefulSet(
	ctx context.Context,
	db *databasesv1alpha1.ManagedDatabase,
) (*appsv1.StatefulSet, error) {
	sts := &appsv1.StatefulSet{}
	stsName := types.NamespacedName{
		Name:      db.Name,
		Namespace: db.Namespace,
	}

	err := r.Get(ctx, stsName, sts)
	if errors.IsNotFound(err) {
		// Create new StatefulSet
		desired := r.buildStatefulSet(db)

		// Set owner reference — StatefulSet is owned by ManagedDatabase
		// When ManagedDatabase is deleted, StatefulSet is garbage collected
		if err := controllerutil.SetControllerReference(db, desired, r.Scheme); err != nil {
			return nil, fmt.Errorf("setting controller reference: %w", err)
		}

		if err := r.Create(ctx, desired); err != nil {
			return nil, fmt.Errorf("creating StatefulSet: %w", err)
		}

		return desired, nil
	}
	if err != nil {
		return nil, fmt.Errorf("getting StatefulSet: %w", err)
	}

	// Update existing StatefulSet if spec changed
	desired := r.buildStatefulSet(db)
	if !statefulSetEqual(sts, desired) {
		sts.Spec = desired.Spec
		if err := r.Update(ctx, sts); err != nil {
			return nil, fmt.Errorf("updating StatefulSet: %w", err)
		}
	}

	return sts, nil
}

func (r *ManagedDatabaseReconciler) buildStatefulSet(
	db *databasesv1alpha1.ManagedDatabase,
) *appsv1.StatefulSet {
	labels := map[string]string{
		"app":                          db.Name,
		"app.kubernetes.io/name":       db.Name,
		"app.kubernetes.io/managed-by": "database-operator",
		"databases.support.tools/name": db.Name,
	}

	return &appsv1.StatefulSet{
		ObjectMeta: metav1.ObjectMeta{
			Name:      db.Name,
			Namespace: db.Namespace,
			Labels:    labels,
		},
		Spec: appsv1.StatefulSetSpec{
			Replicas:    &db.Spec.Replicas,
			ServiceName: db.Name + "-headless",
			Selector: &metav1.LabelSelector{
				MatchLabels: labels,
			},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: labels},
				Spec: corev1.PodSpec{
					Containers: []corev1.Container{
						{
							Name:      db.Spec.Engine,
							Image:     fmt.Sprintf("%s:%s", db.Spec.Engine, db.Spec.Version),
							Resources: db.Spec.Resources,
						},
					},
				},
			},
			VolumeClaimTemplates: []corev1.PersistentVolumeClaim{
				{
					ObjectMeta: metav1.ObjectMeta{Name: "data"},
					Spec: corev1.PersistentVolumeClaimSpec{
						StorageClassName: strPtr(db.Spec.Storage.StorageClass),
						AccessModes:      []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce},
						Resources: corev1.VolumeResourceRequirements{
							Requests: corev1.ResourceList{
								corev1.ResourceStorage: resource.MustParse(db.Spec.Storage.Size),
							},
						},
					},
				},
			},
		},
	}
}

func strPtr(s string) *string { return &s }
```

## Section 5: Status Condition Management

Status conditions follow the KEP-1623 standard for structured condition reporting.

```go
func (r *ManagedDatabaseReconciler) setCondition(
	ctx context.Context,
	db *databasesv1alpha1.ManagedDatabase,
	condType string,
	status metav1.ConditionStatus,
	reason string,
	message string,
) error {
	meta.SetStatusCondition(&db.Status.Conditions, metav1.Condition{
		Type:               condType,
		Status:             status,
		Reason:             reason,
		Message:            message,
		ObservedGeneration: db.Generation,
	})
	return r.updateStatus(ctx, db)
}

func (r *ManagedDatabaseReconciler) setConditionFailed(
	ctx context.Context,
	db *databasesv1alpha1.ManagedDatabase,
	message string,
) error {
	db.Status.Phase = databasesv1alpha1.PhaseFailed
	return r.setCondition(ctx, db, databasesv1alpha1.ConditionReady,
		metav1.ConditionFalse, "ReconcileError", message)
}

func (r *ManagedDatabaseReconciler) updateStatus(
	ctx context.Context,
	db *databasesv1alpha1.ManagedDatabase,
) error {
	// Use Status().Update() to update only the status subresource
	// This prevents conflicts with spec updates
	if err := r.Status().Update(ctx, db); err != nil {
		if errors.IsConflict(err) {
			// Re-fetch and retry on conflict
			latest := &databasesv1alpha1.ManagedDatabase{}
			if fetchErr := r.Get(ctx, types.NamespacedName{
				Name:      db.Name,
				Namespace: db.Namespace,
			}, latest); fetchErr != nil {
				return fetchErr
			}
			latest.Status = db.Status
			return r.Status().Update(ctx, latest)
		}
		return fmt.Errorf("updating status: %w", err)
	}
	return nil
}
```

## Section 6: Event Recording and Filtering

### Event Recorder Setup

```go
// cmd/main.go
func main() {
	// ...
	mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
		Scheme:             scheme,
		Metrics:            server.Options{BindAddress: metricsAddr},
		HealthProbeBindAddress: probeAddr,
		LeaderElection:     enableLeaderElection,
		LeaderElectionID:   "database-operator.support.tools",
	})

	if err = (&controller.ManagedDatabaseReconciler{
		Client:   mgr.GetClient(),
		Scheme:   mgr.GetScheme(),
		// Create event recorder for the controller
		Recorder: mgr.GetEventRecorderFor("manageddatabase-controller"),
	}).SetupWithManager(mgr); err != nil {
		setupLog.Error(err, "unable to create controller", "controller", "ManagedDatabase")
		os.Exit(1)
	}
}
```

### Event Filtering to Prevent Reconciliation Storms

```go
func (r *ManagedDatabaseReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&databasesv1alpha1.ManagedDatabase{},
			// Only reconcile when spec changes, not status updates
			builder.WithPredicates(predicate.Or(
				predicate.GenerationChangedPredicate{},
				predicate.LabelChangedPredicate{},
				predicate.AnnotationChangedPredicate{},
			)),
		).
		// Watch owned StatefulSets and enqueue parent ManagedDatabase
		Owns(&appsv1.StatefulSet{},
			builder.WithPredicates(predicate.ResourceVersionChangedPredicate{}),
		).
		// Watch owned Services
		Owns(&corev1.Service{}).
		// Watch owned Secrets
		Owns(&corev1.Secret{}).
		// Configure reconciliation options
		WithOptions(
			controller.Options{
				MaxConcurrentReconciles: 10,
				RateLimiter: workqueue.NewTypedItemExponentialFailureRateLimiter[reconcile.Request](
					5*time.Millisecond,
					1000*time.Second,
				),
			},
		).
		Complete(r)
}
```

### Custom Predicate for Maintenance Window

```go
// Only allow reconciliation during maintenance windows
type MaintenanceWindowPredicate struct {
	predicate.Funcs
}

func (MaintenanceWindowPredicate) Update(e event.UpdateEvent) bool {
	db, ok := e.ObjectNew.(*databasesv1alpha1.ManagedDatabase)
	if !ok {
		return true
	}

	// If no maintenance window is set, always reconcile
	if db.Spec.MaintenanceWindow == nil {
		return true
	}

	now := time.Now().UTC()
	// Check if current time is within the maintenance window (1-hour window)
	if int(now.Weekday()) == db.Spec.MaintenanceWindow.DayOfWeek &&
		now.Hour() == db.Spec.MaintenanceWindow.StartHour {
		return true
	}

	// Outside maintenance window: suppress update events for version changes
	// but allow other changes (spec.replicas, etc.)
	oldDB, ok := e.ObjectOld.(*databasesv1alpha1.ManagedDatabase)
	if !ok {
		return true
	}
	return oldDB.Spec.Version == db.Spec.Version
}
```

## Section 7: Leader Election Configuration

```go
// cmd/main.go
mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
	Scheme:  scheme,
	Metrics: server.Options{BindAddress: ":8080"},
	Cache: cache.Options{
		// Restrict cache to specific namespaces (reduces memory)
		DefaultNamespaces: map[string]cache.Config{
			"production": {},
			"staging":    {},
		},
	},
	// Leader election prevents split-brain reconciliation
	LeaderElection:   true,
	LeaderElectionID: "database-operator.support.tools",
	// Release the lock quickly on shutdown for fast failover
	LeaderElectionReleaseOnCancel: true,
	// Retry interval for acquiring leadership
	LeaseDuration: durationPtr(15 * time.Second),
	RenewDeadline: durationPtr(10 * time.Second),
	RetryPeriod:   durationPtr(2 * time.Second),
})
```

## Section 8: Webhook Server Setup — Validating and Mutating

### Webhook Types

```go
// api/v1alpha1/manageddatabase_webhook.go
package v1alpha1

import (
	"context"
	"fmt"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/util/validation/field"
	ctrl "sigs.k8s.io/controller-runtime"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/webhook"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"
)

var webhookLog = logf.Log.WithName("manageddatabase-webhook")

// SetupWebhookWithManager registers the webhook with the manager.
func (r *ManagedDatabase) SetupWebhookWithManager(mgr ctrl.Manager) error {
	return ctrl.NewWebhookManagedBy(mgr).
		For(r).
		WithDefaulter(r).
		WithValidator(r).
		Complete()
}

// +kubebuilder:webhook:path=/mutate-databases-support-tools-v1alpha1-manageddatabase,mutating=true,failurePolicy=fail,sideEffects=None,groups=databases.support.tools,resources=manageddatabases,verbs=create;update,versions=v1alpha1,name=mmanagedatabase.kb.io,admissionReviewVersions=v1

var _ webhook.CustomDefaulter = &ManagedDatabase{}

// Default implements webhook.CustomDefaulter for defaulting fields.
func (r *ManagedDatabase) Default(ctx context.Context, obj runtime.Object) error {
	db, ok := obj.(*ManagedDatabase)
	if !ok {
		return fmt.Errorf("expected a ManagedDatabase, got %T", obj)
	}

	webhookLog.Info("Applying defaults", "name", db.Name)

	// Default replicas to 1
	if db.Spec.Replicas == 0 {
		db.Spec.Replicas = 1
	}

	// Default storage class
	if db.Spec.Storage.StorageClass == "" {
		db.Spec.Storage.StorageClass = "standard"
	}

	// Default backup schedule for production databases
	if db.Spec.BackupSchedule == "" && db.Namespace == "production" {
		db.Spec.BackupSchedule = "0 3 * * *"
	}

	return nil
}

// +kubebuilder:webhook:path=/validate-databases-support-tools-v1alpha1-manageddatabase,mutating=false,failurePolicy=fail,sideEffects=None,groups=databases.support.tools,resources=manageddatabases,verbs=create;update;delete,versions=v1alpha1,name=vmanagedatabase.kb.io,admissionReviewVersions=v1

var _ webhook.CustomValidator = &ManagedDatabase{}

// ValidateCreate implements webhook.CustomValidator for creation validation.
func (r *ManagedDatabase) ValidateCreate(ctx context.Context, obj runtime.Object) (admission.Warnings, error) {
	db, ok := obj.(*ManagedDatabase)
	if !ok {
		return nil, fmt.Errorf("expected a ManagedDatabase")
	}

	webhookLog.Info("Validating create", "name", db.Name)
	return nil, r.validateManagedDatabase(db)
}

// ValidateUpdate implements webhook.CustomValidator for update validation.
func (r *ManagedDatabase) ValidateUpdate(ctx context.Context, oldObj, newObj runtime.Object) (admission.Warnings, error) {
	oldDB, ok := oldObj.(*ManagedDatabase)
	if !ok {
		return nil, fmt.Errorf("expected a ManagedDatabase for old object")
	}
	newDB, ok := newObj.(*ManagedDatabase)
	if !ok {
		return nil, fmt.Errorf("expected a ManagedDatabase for new object")
	}

	webhookLog.Info("Validating update", "name", newDB.Name)

	var allErrs field.ErrorList

	// Prevent engine changes after creation (immutable field)
	if oldDB.Spec.Engine != newDB.Spec.Engine {
		allErrs = append(allErrs, field.Forbidden(
			field.NewPath("spec", "engine"),
			"engine is immutable after creation",
		))
	}

	if len(allErrs) > 0 {
		return nil, apierrors.NewInvalid(
			GroupVersion.WithKind("ManagedDatabase").GroupKind(),
			newDB.Name, allErrs,
		)
	}

	return nil, r.validateManagedDatabase(newDB)
}

// ValidateDelete implements webhook.CustomValidator for deletion validation.
func (r *ManagedDatabase) ValidateDelete(ctx context.Context, obj runtime.Object) (admission.Warnings, error) {
	db, ok := obj.(*ManagedDatabase)
	if !ok {
		return nil, fmt.Errorf("expected a ManagedDatabase")
	}

	// Prevent deletion if the database has active connections annotation
	if val, exists := db.Annotations["databases.support.tools/has-active-connections"]; exists && val == "true" {
		return nil, apierrors.NewForbidden(
			GroupVersion.WithKind("ManagedDatabase").GroupKind(),
			db.Name,
			fmt.Errorf("database has active connections; set annotation to 'false' before deletion"),
		)
	}

	return nil, nil
}

func (r *ManagedDatabase) validateManagedDatabase(db *ManagedDatabase) error {
	var allErrs field.ErrorList

	// Validate storage size format
	if db.Spec.Storage.Size == "" {
		allErrs = append(allErrs, field.Required(
			field.NewPath("spec", "storage", "size"),
			"storage size is required",
		))
	}

	// Validate replica count for production
	if db.Namespace == "production" && db.Spec.Replicas < 3 {
		allErrs = append(allErrs, field.Invalid(
			field.NewPath("spec", "replicas"),
			db.Spec.Replicas,
			"production databases must have at least 3 replicas",
		))
	}

	if len(allErrs) > 0 {
		return apierrors.NewInvalid(
			GroupVersion.WithKind("ManagedDatabase").GroupKind(),
			db.Name, allErrs,
		)
	}
	return nil
}
```

## Section 9: Field Indexers for Efficient Queries

Field indexers enable efficient filtering of resources in the cache without listing all objects.

```go
// cmd/main.go — register field indexers at startup

const engineIndexField = ".spec.engine"
const phaseIndexField  = ".status.phase"

func main() {
	mgr, _ := ctrl.NewManager(...)

	// Index ManagedDatabases by engine type
	if err := mgr.GetFieldIndexer().IndexField(
		context.Background(),
		&databasesv1alpha1.ManagedDatabase{},
		engineIndexField,
		func(rawObj client.Object) []string {
			db := rawObj.(*databasesv1alpha1.ManagedDatabase)
			return []string{db.Spec.Engine}
		},
	); err != nil {
		setupLog.Error(err, "unable to create engine field index")
		os.Exit(1)
	}

	// Index ManagedDatabases by phase for fast status queries
	if err := mgr.GetFieldIndexer().IndexField(
		context.Background(),
		&databasesv1alpha1.ManagedDatabase{},
		phaseIndexField,
		func(rawObj client.Object) []string {
			db := rawObj.(*databasesv1alpha1.ManagedDatabase)
			if db.Status.Phase == "" {
				return []string{"Unknown"}
			}
			return []string{db.Status.Phase}
		},
	); err != nil {
		setupLog.Error(err, "unable to create phase field index")
		os.Exit(1)
	}
}

// Using the index in a reconciler
func (r *ManagedDatabaseReconciler) listDatabasesByEngine(
	ctx context.Context,
	engine string,
) ([]databasesv1alpha1.ManagedDatabase, error) {
	dbList := &databasesv1alpha1.ManagedDatabaseList{}
	if err := r.List(ctx, dbList,
		client.MatchingFields{engineIndexField: engine},
	); err != nil {
		return nil, err
	}
	return dbList.Items, nil
}

// List all failed databases
func (r *ManagedDatabaseReconciler) listFailedDatabases(
	ctx context.Context,
	namespace string,
) ([]databasesv1alpha1.ManagedDatabase, error) {
	dbList := &databasesv1alpha1.ManagedDatabaseList{}
	if err := r.List(ctx, dbList,
		client.InNamespace(namespace),
		client.MatchingFields{phaseIndexField: databasesv1alpha1.PhaseFailed},
	); err != nil {
		return nil, err
	}
	return dbList.Items, nil
}
```

## Section 10: Testing Operators with envtest

Envtest spins up a real API server and etcd for integration testing without requiring a full Kubernetes cluster.

### Test Suite Setup

```go
// internal/controller/suite_test.go
package controller_test

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/envtest"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"

	databasesv1alpha1 "github.com/support-tools/database-operator/api/v1alpha1"
	"github.com/support-tools/database-operator/internal/controller"
)

var (
	k8sClient client.Client
	testEnv   *envtest.Environment
	ctx       context.Context
	cancel    context.CancelFunc
)

func TestControllers(t *testing.T) {
	RegisterFailHandler(Fail)
	RunSpecs(t, "Controller Suite")
}

var _ = BeforeSuite(func() {
	logf.SetLogger(zap.New(zap.WriteTo(GinkgoWriter), zap.UseDevMode(true)))

	ctx, cancel = context.WithCancel(context.TODO())

	testEnv = &envtest.Environment{
		CRDDirectoryPaths: []string{
			filepath.Join("..", "..", "config", "crd", "bases"),
		},
		ErrorIfCRDPathMissing: true,
		// BinaryAssetsDirectory specifies the envtest binary path
		// Set KUBEBUILDER_ASSETS env var or use setup-envtest
		BinaryAssetsDirectory: filepath.Join("..", "..", "bin", "k8s",
			"1.31.0-linux-amd64"),
	}

	cfg, err := testEnv.Start()
	Expect(err).NotTo(HaveOccurred())

	err = databasesv1alpha1.AddToScheme(scheme.Scheme)
	Expect(err).NotTo(HaveOccurred())

	k8sClient, err = client.New(cfg, client.Options{Scheme: scheme.Scheme})
	Expect(err).NotTo(HaveOccurred())

	// Start the controller manager
	mgr, err := ctrl.NewManager(cfg, ctrl.Options{
		Scheme: scheme.Scheme,
	})
	Expect(err).NotTo(HaveOccurred())

	err = (&controller.ManagedDatabaseReconciler{
		Client:   mgr.GetClient(),
		Scheme:   mgr.GetScheme(),
		Recorder: mgr.GetEventRecorderFor("test-controller"),
	}).SetupWithManager(mgr)
	Expect(err).NotTo(HaveOccurred())

	go func() {
		defer GinkgoRecover()
		err = mgr.Start(ctx)
		Expect(err).NotTo(HaveOccurred())
	}()
})

var _ = AfterSuite(func() {
	cancel()
	Expect(testEnv.Stop()).To(Succeed())
})
```

### Controller Integration Tests

```go
// internal/controller/manageddatabase_controller_test.go
package controller_test

import (
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"

	databasesv1alpha1 "github.com/support-tools/database-operator/api/v1alpha1"
)

var _ = Describe("ManagedDatabase Controller", func() {
	const (
		dbName      = "test-postgres"
		dbNamespace = "default"
		timeout     = 10 * time.Second
		interval    = 250 * time.Millisecond
	)

	Context("Creating a ManagedDatabase", func() {
		It("should create a StatefulSet", func() {
			db := &databasesv1alpha1.ManagedDatabase{
				ObjectMeta: metav1.ObjectMeta{
					Name:      dbName,
					Namespace: dbNamespace,
				},
				Spec: databasesv1alpha1.ManagedDatabaseSpec{
					Engine:   "postgres",
					Version:  "16.2",
					Replicas: 1,
					Storage: databasesv1alpha1.StorageSpec{
						Size:         "10Gi",
						StorageClass: "standard",
					},
					Resources: corev1.ResourceRequirements{
						Requests: corev1.ResourceList{
							corev1.ResourceCPU:    resource.MustParse("200m"),
							corev1.ResourceMemory: resource.MustParse("256Mi"),
						},
					},
				},
			}

			Expect(k8sClient.Create(ctx, db)).To(Succeed())

			// Verify StatefulSet is created
			Eventually(func() bool {
				sts := &appsv1.StatefulSet{}
				err := k8sClient.Get(ctx, types.NamespacedName{
					Name:      dbName,
					Namespace: dbNamespace,
				}, sts)
				return err == nil
			}, timeout, interval).Should(BeTrue())

			// Verify finalizer is added
			Eventually(func() []string {
				latest := &databasesv1alpha1.ManagedDatabase{}
				k8sClient.Get(ctx, types.NamespacedName{
					Name:      dbName,
					Namespace: dbNamespace,
				}, latest)
				return latest.Finalizers
			}, timeout, interval).Should(ContainElement("databases.support.tools/finalizer"))

			// Verify status phase transitions
			Eventually(func() string {
				latest := &databasesv1alpha1.ManagedDatabase{}
				k8sClient.Get(ctx, types.NamespacedName{
					Name:      dbName,
					Namespace: dbNamespace,
				}, latest)
				return latest.Status.Phase
			}, timeout, interval).Should(Equal(databasesv1alpha1.PhaseProvisioning))
		})

		It("should prevent engine changes after creation", func() {
			existing := &databasesv1alpha1.ManagedDatabase{}
			Expect(k8sClient.Get(ctx, types.NamespacedName{
				Name:      dbName,
				Namespace: dbNamespace,
			}, existing)).To(Succeed())

			existing.Spec.Engine = "mysql"
			err := k8sClient.Update(ctx, existing)

			Expect(errors.IsForbidden(err)).To(BeTrue())
		})

		It("should garbage collect StatefulSet when ManagedDatabase is deleted", func() {
			existing := &databasesv1alpha1.ManagedDatabase{}
			Expect(k8sClient.Get(ctx, types.NamespacedName{
				Name:      dbName,
				Namespace: dbNamespace,
			}, existing)).To(Succeed())

			Expect(k8sClient.Delete(ctx, existing)).To(Succeed())

			// StatefulSet should be deleted via garbage collection
			Eventually(func() bool {
				sts := &appsv1.StatefulSet{}
				err := k8sClient.Get(ctx, types.NamespacedName{
					Name:      dbName,
					Namespace: dbNamespace,
				}, sts)
				return errors.IsNotFound(err)
			}, timeout, interval).Should(BeTrue())
		})
	})
})
```

Run tests:

```bash
# Download envtest binaries
go install sigs.k8s.io/controller-runtime/tools/setup-envtest@latest
setup-envtest use 1.31.0 --bin-dir ./bin/k8s

# Run tests
export KUBEBUILDER_ASSETS="$(setup-envtest use 1.31.0 -p path)"
go test ./... -v -count=1 -timeout=120s

# Run with coverage
go test ./... -v -coverprofile=coverage.out
go tool cover -html=coverage.out -o coverage.html
```

## Section 11: Deploying the Operator

### Build and Push

```bash
# Build Docker image
docker build -t support-tools/database-operator:v1.0.0 .

# Generate manifests
make manifests

# Install CRDs
make install

# Deploy operator
make deploy IMG=support-tools/database-operator:v1.0.0
```

### Verify Operator Health

```bash
# Check operator deployment
kubectl -n database-operator-system get deployment

# Check RBAC is correct
kubectl auth can-i create manageddatabases \
  --as=system:serviceaccount:database-operator-system:database-operator-controller-manager

# Create a test ManagedDatabase
kubectl apply -f - <<'EOF'
apiVersion: databases.support.tools/v1alpha1
kind: ManagedDatabase
metadata:
  name: test-db
  namespace: default
spec:
  engine: postgres
  version: "16.2"
  replicas: 1
  storage:
    size: 10Gi
    storageClass: standard
  resources:
    requests:
      cpu: 200m
      memory: 256Mi
    limits:
      cpu: 1000m
      memory: 1Gi
EOF

# Watch reconciliation
kubectl get manageddatabases -w
kubectl describe manageddatabase test-db
```

The patterns covered in this guide — finalizers, owner references, status conditions, event filtering, webhook validation, field indexers, and envtest integration testing — form the complete toolkit for building production-grade Kubernetes operators. Each pattern addresses a specific failure mode: finalizers prevent resource leaks, owner references enable safe garbage collection, status conditions provide structured observability, and envtest enables confident testing without a full cluster.
