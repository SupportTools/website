---
title: "Kubernetes Operator Development: controller-runtime, Reconciliation Patterns, and Production Readiness"
date: 2027-06-03T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Operator", "controller-runtime", "Go", "CRD", "Development"]
categories: ["Kubernetes", "Development"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes operator development covering controller-runtime Manager setup, CRD API design, reconciliation patterns, owner references, status conditions, leader election, e2e testing with envtest, and production release lifecycle."
more_link: "yes"
url: "/kubernetes-operator-development-guide/"
---

Kubernetes operators encode operational knowledge as code. When a stateful application requires specialized lifecycle management — ordered startup sequences, custom backup procedures, schema migration orchestration, or failure recovery that the built-in controllers cannot express — an operator is the appropriate solution. This guide covers the complete operator development lifecycle: choosing between kubebuilder and operator-sdk, designing CRD APIs, implementing idempotent reconciliation loops, handling status conditions, testing with envtest, and releasing production-ready operators with conversion webhooks for API versioning.

<!--more-->

## The Operator Pattern

An operator is a Kubernetes controller that watches custom resources (CRDs) and drives the actual state of the cluster toward the desired state declared in those resources. The reconciliation loop is the core abstraction:

```
Desired State (CRD spec)
        │
        ▼
   Reconciler.Reconcile()
        │
        ├── Reads actual state from Kubernetes API
        │
        ├── Compares actual vs desired
        │
        ├── Takes action to converge (create/update/delete resources)
        │
        ├── Updates CRD status to reflect current state
        │
        └── Returns: Done, Requeue after N seconds, or Error (immediate requeue)
```

The reconciler must be **idempotent**: calling Reconcile with the same input any number of times must produce the same final state without side effects. This is required because the reconciler is called repeatedly — on informer cache sync, on resource changes, and after errors.

## kubebuilder vs operator-sdk

Both kubebuilder and operator-sdk are scaffolding tools that generate boilerplate operator code. They are built on the same `controller-runtime` library and produce structurally identical outputs.

| Feature | kubebuilder | operator-sdk |
|---|---|---|
| Backing organization | Kubernetes SIG API Machinery | Red Hat / OpenShift |
| Helm operator support | No | Yes |
| Ansible operator support | No | Yes |
| OLM integration | Manual | Built-in |
| OpenShift certification path | Manual | Streamlined |
| Community activity | High | High |

For pure Go operators targeting upstream Kubernetes, kubebuilder is the natural choice. For operators targeting OpenShift or requiring OLM packaging, operator-sdk adds significant value. This guide uses kubebuilder scaffolding with the `controller-runtime` library directly.

## Project Scaffolding

```bash
# Install kubebuilder
curl -L https://go.kubebuilder.io/dl/latest/$(go env GOOS)/$(go env GOARCH) \
  -o /usr/local/bin/kubebuilder && chmod +x /usr/local/bin/kubebuilder

# Create a new operator project
mkdir database-operator && cd database-operator
go mod init github.com/example-org/database-operator

kubebuilder init \
  --domain example.org \
  --repo github.com/example-org/database-operator

# Scaffold a new API (CRD + controller)
kubebuilder create api \
  --group database \
  --version v1alpha1 \
  --kind DatabaseCluster \
  --resource \
  --controller

# Generated project structure:
# ├── api/
# │   └── v1alpha1/
# │       ├── databasecluster_types.go     # CRD type definitions
# │       ├── groupversion_info.go
# │       └── zz_generated.deepcopy.go
# ├── config/
# │   ├── crd/                             # CRD manifests
# │   ├── rbac/                            # ClusterRole manifests
# │   ├── manager/                         # Operator deployment
# │   └── default/                         # Kustomize base
# ├── controllers/
# │   ├── databasecluster_controller.go    # Reconciler
# │   └── suite_test.go
# ├── main.go                              # Manager entrypoint
# └── Makefile
```

## CRD API Design

The CRD `spec` declares desired state; `status` reflects actual state. This separation is fundamental to Kubernetes API design.

```go
// api/v1alpha1/databasecluster_types.go

package v1alpha1

import (
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    corev1 "k8s.io/api/core/v1"
)

// DatabaseClusterSpec defines the desired state of DatabaseCluster
type DatabaseClusterSpec struct {
    // +kubebuilder:validation:Minimum=1
    // +kubebuilder:validation:Maximum=7
    // +kubebuilder:default=3
    Replicas int32 `json:"replicas,omitempty"`

    // +kubebuilder:validation:Required
    // +kubebuilder:validation:MinLength=1
    Version string `json:"version"`

    // +kubebuilder:validation:Required
    Storage DatabaseStorageSpec `json:"storage"`

    // +optional
    Backup *DatabaseBackupSpec `json:"backup,omitempty"`

    // +optional
    Resources corev1.ResourceRequirements `json:"resources,omitempty"`

    // +optional
    // +kubebuilder:validation:Enum=standalone;replicaset;sharded
    // +kubebuilder:default=replicaset
    Topology string `json:"topology,omitempty"`

    // +optional
    TLS *DatabaseTLSSpec `json:"tls,omitempty"`
}

// DatabaseStorageSpec defines persistent storage configuration
type DatabaseStorageSpec struct {
    // +kubebuilder:validation:Required
    Size string `json:"size"`

    // +optional
    StorageClassName *string `json:"storageClassName,omitempty"`
}

// DatabaseBackupSpec defines backup configuration
type DatabaseBackupSpec struct {
    // +kubebuilder:validation:Required
    Schedule string `json:"schedule"`

    // +kubebuilder:validation:Required
    Destination string `json:"destination"`

    // +optional
    // +kubebuilder:default=7
    RetentionDays int32 `json:"retentionDays,omitempty"`
}

// DatabaseTLSSpec defines TLS configuration
type DatabaseTLSSpec struct {
    // +optional
    Enabled bool `json:"enabled,omitempty"`

    // +optional
    SecretName string `json:"secretName,omitempty"`
}

// DatabaseClusterStatus defines the observed state of DatabaseCluster
type DatabaseClusterStatus struct {
    // ObservedGeneration is the .metadata.generation the reconciler last acted on
    // +optional
    ObservedGeneration int64 `json:"observedGeneration,omitempty"`

    // Conditions represent the latest available observations of the cluster's state
    // +optional
    // +listType=map
    // +listMapKey=type
    Conditions []metav1.Condition `json:"conditions,omitempty"`

    // Phase is the current lifecycle phase of the cluster
    // +optional
    // +kubebuilder:validation:Enum=Pending;Provisioning;Running;Degraded;Terminating
    Phase string `json:"phase,omitempty"`

    // ReadyReplicas is the number of ready database pods
    // +optional
    ReadyReplicas int32 `json:"readyReplicas,omitempty"`

    // CurrentVersion is the version currently running
    // +optional
    CurrentVersion string `json:"currentVersion,omitempty"`

    // PrimaryEndpoint is the connection endpoint for the primary node
    // +optional
    PrimaryEndpoint string `json:"primaryEndpoint,omitempty"`
}

// Standard condition types following the Kubernetes API conventions
const (
    // ConditionAvailable indicates the cluster is available for connections
    ConditionAvailable = "Available"
    // ConditionProgressing indicates the cluster is being configured or upgraded
    ConditionProgressing = "Progressing"
    // ConditionDegraded indicates the cluster is not operating at full capacity
    ConditionDegraded = "Degraded"
    // ConditionReconciling indicates active reconciliation is in progress
    ConditionReconciling = "Reconciling"
)

// Phase constants
const (
    PhasePending      = "Pending"
    PhaseProvisioning = "Provisioning"
    PhaseRunning      = "Running"
    PhaseDegraded     = "Degraded"
    PhaseTerminating  = "Terminating"
)

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="Replicas",type=integer,JSONPath=`.spec.replicas`
// +kubebuilder:printcolumn:name="Ready",type=integer,JSONPath=`.status.readyReplicas`
// +kubebuilder:printcolumn:name="Version",type=string,JSONPath=`.status.currentVersion`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`
// +kubebuilder:resource:shortName=dbc;dbcluster,scope=Namespaced,categories=database
type DatabaseCluster struct {
    metav1.TypeMeta   `json:",inline"`
    metav1.ObjectMeta `json:"metadata,omitempty"`

    Spec   DatabaseClusterSpec   `json:"spec,omitempty"`
    Status DatabaseClusterStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true
type DatabaseClusterList struct {
    metav1.TypeMeta `json:",inline"`
    metav1.ListMeta `json:"metadata,omitempty"`
    Items           []DatabaseCluster `json:"items"`
}

func init() {
    SchemeBuilder.Register(&DatabaseCluster{}, &DatabaseClusterList{})
}
```

## Manager Setup

The Manager bootstraps the controller runtime, sets up caches, health endpoints, and metrics.

```go
// main.go
package main

import (
    "flag"
    "os"
    "time"

    "k8s.io/apimachinery/pkg/runtime"
    clientgoscheme "k8s.io/client-go/kubernetes/scheme"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/healthz"
    "sigs.k8s.io/controller-runtime/pkg/log/zap"
    metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"

    databasev1alpha1 "github.com/example-org/database-operator/api/v1alpha1"
    "github.com/example-org/database-operator/controllers"
)

var (
    scheme   = runtime.NewScheme()
    setupLog = ctrl.Log.WithName("setup")
)

func init() {
    clientgoscheme.AddToScheme(scheme)
    databasev1alpha1.AddToScheme(scheme)
}

func main() {
    var metricsAddr string
    var enableLeaderElection bool
    var probeAddr string
    var leaderElectionNamespace string
    var syncPeriod time.Duration

    flag.StringVar(&metricsAddr, "metrics-bind-address", ":8080", "The address the metric endpoint binds to.")
    flag.StringVar(&probeAddr, "health-probe-bind-address", ":8081", "The address the probe endpoint binds to.")
    flag.BoolVar(&enableLeaderElection, "leader-elect", true, "Enable leader election for controller manager.")
    flag.StringVar(&leaderElectionNamespace, "leader-election-namespace", "database-operator-system",
        "Namespace for leader election lease.")
    flag.DurationVar(&syncPeriod, "sync-period", 10*time.Minute,
        "Period to resync the entire cache with the Kubernetes API.")

    opts := zap.Options{
        Development: os.Getenv("DEVELOPMENT") == "true",
    }
    opts.BindFlags(flag.CommandLine)
    flag.Parse()

    ctrl.SetLogger(zap.New(zap.UseFlagOptions(&opts)))

    mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
        Scheme: scheme,
        Metrics: metricsserver.Options{
            BindAddress: metricsAddr,
        },
        HealthProbeBindAddress:  probeAddr,
        LeaderElection:          enableLeaderElection,
        LeaderElectionID:        "database-operator.example.org",
        LeaderElectionNamespace: leaderElectionNamespace,
        // Cache sync period — reconcile all objects periodically even without changes
        // This catches drift that was not caught by informer watches
        SyncPeriod: &syncPeriod,
    })
    if err != nil {
        setupLog.Error(err, "unable to start manager")
        os.Exit(1)
    }

    if err = (&controllers.DatabaseClusterReconciler{
        Client:   mgr.GetClient(),
        Scheme:   mgr.GetScheme(),
        Recorder: mgr.GetEventRecorderFor("databasecluster-controller"),
    }).SetupWithManager(mgr); err != nil {
        setupLog.Error(err, "unable to create controller", "controller", "DatabaseCluster")
        os.Exit(1)
    }

    if err := mgr.AddHealthzCheck("healthz", healthz.Ping); err != nil {
        setupLog.Error(err, "unable to set up health check")
        os.Exit(1)
    }
    if err := mgr.AddReadyzCheck("readyz", healthz.Ping); err != nil {
        setupLog.Error(err, "unable to set up ready check")
        os.Exit(1)
    }

    setupLog.Info("starting manager")
    if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
        setupLog.Error(err, "problem running manager")
        os.Exit(1)
    }
}
```

## Reconciler Implementation

```go
// controllers/databasecluster_controller.go
package controllers

import (
    "context"
    "fmt"
    "time"

    appsv1 "k8s.io/api/apps/v1"
    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/api/equality"
    apierrors "k8s.io/apimachinery/pkg/api/errors"
    "k8s.io/apimachinery/pkg/api/meta"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime"
    "k8s.io/apimachinery/pkg/types"
    "k8s.io/client-go/tools/record"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/builder"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
    "sigs.k8s.io/controller-runtime/pkg/handler"
    "sigs.k8s.io/controller-runtime/pkg/log"
    "sigs.k8s.io/controller-runtime/pkg/predicate"

    databasev1alpha1 "github.com/example-org/database-operator/api/v1alpha1"
)

const (
    finalizerName       = "database.example.org/finalizer"
    requeueAfterDefault = 30 * time.Second
)

// DatabaseClusterReconciler reconciles DatabaseCluster objects
type DatabaseClusterReconciler struct {
    client.Client
    Scheme   *runtime.Scheme
    Recorder record.EventRecorder
}

// +kubebuilder:rbac:groups=database.example.org,resources=databaseclusters,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=database.example.org,resources=databaseclusters/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=database.example.org,resources=databaseclusters/finalizers,verbs=update
// +kubebuilder:rbac:groups=apps,resources=statefulsets,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=services;configmaps;secrets;persistentvolumeclaims,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=events,verbs=create;patch
// +kubebuilder:rbac:groups="",resources=pods,verbs=get;list;watch

func (r *DatabaseClusterReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    logger := log.FromContext(ctx)
    logger.Info("Reconciling DatabaseCluster", "name", req.NamespacedName)

    // 1. Fetch the DatabaseCluster resource
    cluster := &databasev1alpha1.DatabaseCluster{}
    if err := r.Get(ctx, req.NamespacedName, cluster); err != nil {
        if apierrors.IsNotFound(err) {
            // Object was deleted before we could reconcile; nothing to do
            return ctrl.Result{}, nil
        }
        return ctrl.Result{}, fmt.Errorf("failed to fetch DatabaseCluster: %w", err)
    }

    // 2. Save original status for comparison at the end
    originalStatus := cluster.Status.DeepCopy()

    // 3. Update ObservedGeneration
    cluster.Status.ObservedGeneration = cluster.Generation

    // 4. Handle deletion via finalizer
    if !cluster.DeletionTimestamp.IsZero() {
        return r.reconcileDelete(ctx, cluster)
    }

    // 5. Add finalizer if not present
    if !controllerutil.ContainsFinalizer(cluster, finalizerName) {
        controllerutil.AddFinalizer(cluster, finalizerName)
        if err := r.Update(ctx, cluster); err != nil {
            return ctrl.Result{}, fmt.Errorf("failed to add finalizer: %w", err)
        }
        return ctrl.Result{}, nil
    }

    // 6. Set Progressing condition while reconciling
    r.setCondition(cluster, databasev1alpha1.ConditionReconciling, metav1.ConditionTrue,
        "Reconciling", "Reconciliation in progress")

    // 7. Reconcile child resources
    result, err := r.reconcileNormal(ctx, cluster)

    // 8. Always update status, even on error (to reflect current state)
    if !equality.Semantic.DeepEqual(cluster.Status, *originalStatus) {
        if statusErr := r.Status().Update(ctx, cluster); statusErr != nil {
            logger.Error(statusErr, "Failed to update status")
            if err == nil {
                return ctrl.Result{}, statusErr
            }
        }
    }

    return result, err
}

func (r *DatabaseClusterReconciler) reconcileNormal(
    ctx context.Context,
    cluster *databasev1alpha1.DatabaseCluster,
) (ctrl.Result, error) {
    logger := log.FromContext(ctx)

    // Reconcile ConfigMap
    if err := r.reconcileConfigMap(ctx, cluster); err != nil {
        r.setCondition(cluster, databasev1alpha1.ConditionAvailable, metav1.ConditionFalse,
            "ConfigMapFailed", fmt.Sprintf("Failed to reconcile ConfigMap: %v", err))
        r.Recorder.Eventf(cluster, corev1.EventTypeWarning, "ConfigMapFailed",
            "Failed to reconcile ConfigMap: %v", err)
        return ctrl.Result{}, err
    }

    // Reconcile Service (headless + client)
    if err := r.reconcileServices(ctx, cluster); err != nil {
        r.setCondition(cluster, databasev1alpha1.ConditionAvailable, metav1.ConditionFalse,
            "ServiceFailed", fmt.Sprintf("Failed to reconcile Services: %v", err))
        return ctrl.Result{}, err
    }

    // Reconcile StatefulSet
    sts, err := r.reconcileStatefulSet(ctx, cluster)
    if err != nil {
        r.setCondition(cluster, databasev1alpha1.ConditionAvailable, metav1.ConditionFalse,
            "StatefulSetFailed", fmt.Sprintf("Failed to reconcile StatefulSet: %v", err))
        return ctrl.Result{}, err
    }

    // Update status based on StatefulSet state
    cluster.Status.ReadyReplicas = sts.Status.ReadyReplicas
    cluster.Status.CurrentVersion = cluster.Spec.Version

    if sts.Status.ReadyReplicas == cluster.Spec.Replicas {
        cluster.Status.Phase = databasev1alpha1.PhaseRunning
        cluster.Status.PrimaryEndpoint = fmt.Sprintf("%s-0.%s.%s.svc.cluster.local:5432",
            cluster.Name, cluster.Name, cluster.Namespace)

        r.setCondition(cluster, databasev1alpha1.ConditionAvailable, metav1.ConditionTrue,
            "AllReplicasReady", fmt.Sprintf("%d/%d replicas are ready",
                sts.Status.ReadyReplicas, cluster.Spec.Replicas))
        r.setCondition(cluster, databasev1alpha1.ConditionReconciling, metav1.ConditionFalse,
            "ReconcileComplete", "Reconciliation complete")
        r.setCondition(cluster, databasev1alpha1.ConditionDegraded, metav1.ConditionFalse,
            "NotDegraded", "All replicas are ready")

        r.Recorder.Eventf(cluster, corev1.EventTypeNormal, "ClusterReady",
            "DatabaseCluster %s is ready with %d replicas", cluster.Name, sts.Status.ReadyReplicas)
        return ctrl.Result{RequeueAfter: requeueAfterDefault}, nil
    }

    // Cluster is not yet fully ready — set Degraded if replicas are zero
    if sts.Status.ReadyReplicas == 0 && cluster.Status.Phase == databasev1alpha1.PhaseRunning {
        cluster.Status.Phase = databasev1alpha1.PhaseDegraded
        r.setCondition(cluster, databasev1alpha1.ConditionDegraded, metav1.ConditionTrue,
            "NoReadyReplicas", "No replicas are ready")
        r.Recorder.Eventf(cluster, corev1.EventTypeWarning, "ClusterDegraded",
            "DatabaseCluster %s has no ready replicas", cluster.Name)
    } else if cluster.Status.Phase != databasev1alpha1.PhaseDegraded {
        cluster.Status.Phase = databasev1alpha1.PhaseProvisioning
    }

    logger.Info("Cluster not yet ready, requeueing",
        "readyReplicas", sts.Status.ReadyReplicas,
        "desiredReplicas", cluster.Spec.Replicas)
    return ctrl.Result{RequeueAfter: 10 * time.Second}, nil
}

func (r *DatabaseClusterReconciler) reconcileDelete(
    ctx context.Context,
    cluster *databasev1alpha1.DatabaseCluster,
) (ctrl.Result, error) {
    logger := log.FromContext(ctx)
    logger.Info("Handling deletion", "name", cluster.Name)

    cluster.Status.Phase = databasev1alpha1.PhaseTerminating
    r.setCondition(cluster, databasev1alpha1.ConditionAvailable, metav1.ConditionFalse,
        "Terminating", "DatabaseCluster is being deleted")

    // Perform any pre-deletion cleanup here (e.g., flush data, notify backups)
    // ...

    // Remove finalizer to allow deletion to proceed
    controllerutil.RemoveFinalizer(cluster, finalizerName)
    if err := r.Update(ctx, cluster); err != nil {
        return ctrl.Result{}, fmt.Errorf("failed to remove finalizer: %w", err)
    }

    r.Recorder.Eventf(cluster, corev1.EventTypeNormal, "Deleted",
        "DatabaseCluster %s has been deleted", cluster.Name)
    return ctrl.Result{}, nil
}

// reconcileStatefulSet creates or updates the StatefulSet, returning the current state
func (r *DatabaseClusterReconciler) reconcileStatefulSet(
    ctx context.Context,
    cluster *databasev1alpha1.DatabaseCluster,
) (*appsv1.StatefulSet, error) {
    desired := r.buildStatefulSet(cluster)

    // Set owner reference for garbage collection
    if err := controllerutil.SetControllerReference(cluster, desired, r.Scheme); err != nil {
        return nil, fmt.Errorf("failed to set owner reference: %w", err)
    }

    existing := &appsv1.StatefulSet{}
    err := r.Get(ctx, types.NamespacedName{
        Name:      desired.Name,
        Namespace: desired.Namespace,
    }, existing)

    if apierrors.IsNotFound(err) {
        if err := r.Create(ctx, desired); err != nil {
            return nil, fmt.Errorf("failed to create StatefulSet: %w", err)
        }
        return desired, nil
    }
    if err != nil {
        return nil, fmt.Errorf("failed to get StatefulSet: %w", err)
    }

    // Update if spec differs (use strategic merge patch for safety)
    if !equality.Semantic.DeepEqual(existing.Spec, desired.Spec) {
        existing.Spec = desired.Spec
        if err := r.Update(ctx, existing); err != nil {
            return nil, fmt.Errorf("failed to update StatefulSet: %w", err)
        }
    }

    return existing, nil
}

func (r *DatabaseClusterReconciler) buildStatefulSet(
    cluster *databasev1alpha1.DatabaseCluster,
) *appsv1.StatefulSet {
    labels := map[string]string{
        "app.kubernetes.io/name":       "database-cluster",
        "app.kubernetes.io/instance":   cluster.Name,
        "app.kubernetes.io/managed-by": "database-operator",
        "database.example.org/cluster": cluster.Name,
    }

    storageClassName := cluster.Spec.Storage.StorageClassName
    replicas := cluster.Spec.Replicas

    return &appsv1.StatefulSet{
        ObjectMeta: metav1.ObjectMeta{
            Name:      cluster.Name,
            Namespace: cluster.Namespace,
            Labels:    labels,
        },
        Spec: appsv1.StatefulSetSpec{
            Replicas:            &replicas,
            ServiceName:         cluster.Name + "-headless",
            PodManagementPolicy: appsv1.OrderedReadyPodManagement,
            Selector: &metav1.LabelSelector{
                MatchLabels: labels,
            },
            Template: corev1.PodTemplateSpec{
                ObjectMeta: metav1.ObjectMeta{
                    Labels: labels,
                },
                Spec: corev1.PodSpec{
                    Containers: []corev1.Container{
                        {
                            Name:  "database",
                            Image: fmt.Sprintf("postgres:%s", cluster.Spec.Version),
                            Ports: []corev1.ContainerPort{
                                {Name: "postgresql", ContainerPort: 5432, Protocol: corev1.ProtocolTCP},
                            },
                            Resources: cluster.Spec.Resources,
                            ReadinessProbe: &corev1.Probe{
                                ProbeHandler: corev1.ProbeHandler{
                                    Exec: &corev1.ExecAction{
                                        Command: []string{
                                            "pg_isready", "-U", "postgres", "-d", "postgres",
                                        },
                                    },
                                },
                                InitialDelaySeconds: 10,
                                PeriodSeconds:       5,
                                FailureThreshold:    6,
                            },
                            LivenessProbe: &corev1.Probe{
                                ProbeHandler: corev1.ProbeHandler{
                                    Exec: &corev1.ExecAction{
                                        Command: []string{
                                            "pg_isready", "-U", "postgres", "-d", "postgres",
                                        },
                                    },
                                },
                                InitialDelaySeconds: 30,
                                PeriodSeconds:       10,
                                FailureThreshold:    6,
                            },
                            VolumeMounts: []corev1.VolumeMount{
                                {
                                    Name:      "data",
                                    MountPath: "/var/lib/postgresql/data",
                                    SubPath:   "pgdata",
                                },
                            },
                        },
                    },
                },
            },
            VolumeClaimTemplates: []corev1.PersistentVolumeClaim{
                {
                    ObjectMeta: metav1.ObjectMeta{
                        Name: "data",
                    },
                    Spec: corev1.PersistentVolumeClaimSpec{
                        AccessModes:      []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce},
                        StorageClassName: storageClassName,
                        Resources: corev1.VolumeResourceRequirements{
                            Requests: corev1.ResourceList{
                                corev1.ResourceStorage: mustParseQuantity(cluster.Spec.Storage.Size),
                            },
                        },
                    },
                },
            },
        },
    }
}

// setCondition sets or updates a standard metav1.Condition on the cluster status
func (r *DatabaseClusterReconciler) setCondition(
    cluster *databasev1alpha1.DatabaseCluster,
    conditionType string,
    status metav1.ConditionStatus,
    reason, message string,
) {
    condition := metav1.Condition{
        Type:               conditionType,
        Status:             status,
        ObservedGeneration: cluster.Generation,
        Reason:             reason,
        Message:            message,
    }
    meta.SetStatusCondition(&cluster.Status.Conditions, condition)
}

// SetupWithManager registers the reconciler and configures watches
func (r *DatabaseClusterReconciler) SetupWithManager(mgr ctrl.Manager) error {
    return ctrl.NewControllerManagedBy(mgr).
        // Watch the primary resource
        For(&databasev1alpha1.DatabaseCluster{},
            builder.WithPredicates(predicate.GenerationChangedPredicate{})).
        // Watch owned StatefulSets and requeue the owner
        Owns(&appsv1.StatefulSet{}).
        // Watch owned Services
        Owns(&corev1.Service{}).
        // Watch owned ConfigMaps
        Owns(&corev1.ConfigMap{}).
        // Watch pods created by owned StatefulSets to detect readiness changes
        Watches(
            &corev1.Pod{},
            handler.EnqueueRequestForOwner(
                mgr.GetScheme(),
                mgr.GetRESTMapper(),
                &databasev1alpha1.DatabaseCluster{},
                handler.OnlyControllerOwner(),
            ),
            builder.WithPredicates(predicate.NewPredicateFuncs(func(obj client.Object) bool {
                // Only requeue when pod ready status changes
                _, ok := obj.GetLabels()["database.example.org/cluster"]
                return ok
            })),
        ).
        Complete(r)
}
```

## Event Filtering with Predicates

Predicates reduce unnecessary reconciliations by filtering informer events before they enter the reconcile queue. This improves operator performance significantly in large clusters.

```go
// Only reconcile when the spec actually changes, not on every status update
builder.WithPredicates(predicate.GenerationChangedPredicate{})

// Custom predicate: only reconcile if a specific label is set
builder.WithPredicates(predicate.NewPredicateFuncs(func(obj client.Object) bool {
    _, hasLabel := obj.GetLabels()["database.example.org/managed"]
    return hasLabel
}))

// Compose predicates: reconcile only if the object is not being deleted AND
// the generation has changed
builder.WithPredicates(
    predicate.And(
        predicate.GenerationChangedPredicate{},
        predicate.NewPredicateFuncs(func(obj client.Object) bool {
            return obj.GetDeletionTimestamp().IsZero()
        }),
    ),
)
```

## Operator Metrics

Expose custom metrics to enable SLO-based monitoring of the operator's effectiveness:

```go
// metrics/metrics.go
package metrics

import (
    "github.com/prometheus/client_golang/prometheus"
    "sigs.k8s.io/controller-runtime/pkg/metrics"
)

var (
    // Track total reconciliations
    ReconcileTotal = prometheus.NewCounterVec(
        prometheus.CounterOpts{
            Name: "database_operator_reconcile_total",
            Help: "Total number of reconciliations by outcome",
        },
        []string{"namespace", "name", "outcome"},
    )

    // Track reconciliation duration
    ReconcileDuration = prometheus.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "database_operator_reconcile_duration_seconds",
            Help:    "Duration of reconcile operations",
            Buckets: prometheus.DefBuckets,
        },
        []string{"namespace"},
    )

    // Track cluster health gauge
    ClusterHealthy = prometheus.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "database_operator_cluster_healthy",
            Help: "Whether a DatabaseCluster is healthy (1) or not (0)",
        },
        []string{"namespace", "name"},
    )

    // Track ready replica count
    ClusterReadyReplicas = prometheus.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "database_operator_cluster_ready_replicas",
            Help: "Number of ready replicas for each DatabaseCluster",
        },
        []string{"namespace", "name"},
    )
)

func init() {
    metrics.Registry.MustRegister(
        ReconcileTotal,
        ReconcileDuration,
        ClusterHealthy,
        ClusterReadyReplicas,
    )
}
```

## Testing with envtest

envtest starts a real API server and etcd binary, providing a realistic test environment without requiring a running cluster.

```go
// controllers/suite_test.go
package controllers_test

import (
    "context"
    "path/filepath"
    "testing"
    "time"

    . "github.com/onsi/ginkgo/v2"
    . "github.com/onsi/gomega"
    appsv1 "k8s.io/api/apps/v1"
    "k8s.io/client-go/kubernetes/scheme"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/envtest"
    logf "sigs.k8s.io/controller-runtime/pkg/log"
    "sigs.k8s.io/controller-runtime/pkg/log/zap"

    databasev1alpha1 "github.com/example-org/database-operator/api/v1alpha1"
    "github.com/example-org/database-operator/controllers"
)

var (
    ctx       context.Context
    cancel    context.CancelFunc
    testEnv   *envtest.Environment
    k8sClient client.Client
)

func TestControllers(t *testing.T) {
    RegisterFailHandler(Fail)
    RunSpecs(t, "Controllers Suite")
}

var _ = BeforeSuite(func() {
    logf.SetLogger(zap.New(zap.WriteTo(GinkgoWriter), zap.UseDevMode(true)))
    ctx, cancel = context.WithCancel(context.TODO())

    testEnv = &envtest.Environment{
        CRDDirectoryPaths: []string{
            filepath.Join("..", "config", "crd", "bases"),
        },
        ErrorIfCRDPathMissing: true,
        // Use a specific Kubernetes version for reproducible tests
        BinaryAssetsDirectory: "/usr/local/kubebuilder/bin",
    }

    cfg, err := testEnv.Start()
    Expect(err).NotTo(HaveOccurred())
    Expect(cfg).NotTo(BeNil())

    err = databasev1alpha1.AddToScheme(scheme.Scheme)
    Expect(err).NotTo(HaveOccurred())
    err = appsv1.AddToScheme(scheme.Scheme)
    Expect(err).NotTo(HaveOccurred())

    k8sClient, err = client.New(cfg, client.Options{Scheme: scheme.Scheme})
    Expect(err).NotTo(HaveOccurred())
    Expect(k8sClient).NotTo(BeNil())

    mgr, err := ctrl.NewManager(cfg, ctrl.Options{
        Scheme:             scheme.Scheme,
        LeaderElection:     false,
        MetricsBindAddress: "0",
    })
    Expect(err).NotTo(HaveOccurred())

    err = (&controllers.DatabaseClusterReconciler{
        Client:   mgr.GetClient(),
        Scheme:   mgr.GetScheme(),
        Recorder: mgr.GetEventRecorderFor("test"),
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
    err := testEnv.Stop()
    Expect(err).NotTo(HaveOccurred())
})
```

```go
// controllers/databasecluster_controller_test.go
package controllers_test

import (
    "context"
    "time"

    . "github.com/onsi/ginkgo/v2"
    . "github.com/onsi/gomega"
    appsv1 "k8s.io/api/apps/v1"
    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/api/resource"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/types"

    databasev1alpha1 "github.com/example-org/database-operator/api/v1alpha1"
)

var _ = Describe("DatabaseCluster Controller", func() {
    const (
        clusterName = "test-cluster"
        namespace   = "default"
        timeout     = 30 * time.Second
        interval    = 250 * time.Millisecond
    )

    Context("When creating a DatabaseCluster", func() {
        It("Should create a StatefulSet with correct configuration", func() {
            cluster := &databasev1alpha1.DatabaseCluster{
                ObjectMeta: metav1.ObjectMeta{
                    Name:      clusterName,
                    Namespace: namespace,
                },
                Spec: databasev1alpha1.DatabaseClusterSpec{
                    Replicas: 3,
                    Version:  "16",
                    Storage: databasev1alpha1.DatabaseStorageSpec{
                        Size: "10Gi",
                    },
                    Resources: corev1.ResourceRequirements{
                        Requests: corev1.ResourceList{
                            corev1.ResourceCPU:    resource.MustParse("100m"),
                            corev1.ResourceMemory: resource.MustParse("256Mi"),
                        },
                    },
                },
            }

            Expect(k8sClient.Create(ctx, cluster)).Should(Succeed())

            clusterKey := types.NamespacedName{Name: clusterName, Namespace: namespace}

            // Verify StatefulSet is created
            createdSTS := &appsv1.StatefulSet{}
            Eventually(func() bool {
                err := k8sClient.Get(ctx, clusterKey, createdSTS)
                return err == nil
            }, timeout, interval).Should(BeTrue())

            Expect(*createdSTS.Spec.Replicas).Should(Equal(int32(3)))
            Expect(createdSTS.Spec.Template.Spec.Containers[0].Image).
                Should(Equal("postgres:16"))

            // Verify owner reference is set
            Expect(createdSTS.OwnerReferences).Should(HaveLen(1))
            Expect(createdSTS.OwnerReferences[0].Name).Should(Equal(clusterName))
            Expect(*createdSTS.OwnerReferences[0].Controller).Should(BeTrue())
        })

        It("Should update status.phase to Provisioning", func() {
            clusterKey := types.NamespacedName{Name: clusterName, Namespace: namespace}
            updatedCluster := &databasev1alpha1.DatabaseCluster{}

            Eventually(func() string {
                if err := k8sClient.Get(ctx, clusterKey, updatedCluster); err != nil {
                    return ""
                }
                return updatedCluster.Status.Phase
            }, timeout, interval).Should(Equal(databasev1alpha1.PhaseProvisioning))
        })

        It("Should add a finalizer", func() {
            clusterKey := types.NamespacedName{Name: clusterName, Namespace: namespace}
            cluster := &databasev1alpha1.DatabaseCluster{}
            Expect(k8sClient.Get(ctx, clusterKey, cluster)).Should(Succeed())
            Expect(cluster.Finalizers).Should(ContainElement("database.example.org/finalizer"))
        })

        AfterEach(func() {
            cluster := &databasev1alpha1.DatabaseCluster{}
            Expect(k8sClient.Get(ctx, types.NamespacedName{
                Name: clusterName, Namespace: namespace,
            }, cluster)).Should(Succeed())
            Expect(k8sClient.Delete(ctx, cluster)).Should(Succeed())

            // Wait for deletion to complete
            Eventually(func() bool {
                err := k8sClient.Get(ctx, types.NamespacedName{
                    Name: clusterName, Namespace: namespace,
                }, cluster)
                return err != nil
            }, timeout, interval).Should(BeTrue())
        })
    })
})
```

## Versioning and Conversion Webhooks

When a CRD API evolves across versions (v1alpha1 -> v1beta1 -> v1), a conversion webhook translates between stored versions. The Hub pattern designates one version as the canonical (hub) version that all others convert to and from.

```go
// api/v1beta1/databasecluster_conversion.go
// v1alpha1 is the hub version; v1beta1 converts to/from it

package v1beta1

import (
    "fmt"
    v1alpha1 "github.com/example-org/database-operator/api/v1alpha1"
    "sigs.k8s.io/controller-runtime/pkg/conversion"
)

// ConvertTo converts this v1beta1 to the Hub version (v1alpha1)
func (src *DatabaseCluster) ConvertTo(dstRaw conversion.Hub) error {
    dst := dstRaw.(*v1alpha1.DatabaseCluster)

    dst.ObjectMeta = src.ObjectMeta
    dst.Spec.Replicas = src.Spec.Replicas
    dst.Spec.Version = src.Spec.DatabaseVersion  // Field was renamed
    dst.Spec.Storage = v1alpha1.DatabaseStorageSpec{
        Size: src.Spec.Storage.Capacity,  // Field was renamed
    }
    dst.Status.Phase = src.Status.Phase
    dst.Status.Conditions = src.Status.Conditions

    return nil
}

// ConvertFrom converts from the Hub version (v1alpha1) to this v1beta1
func (dst *DatabaseCluster) ConvertFrom(srcRaw conversion.Hub) error {
    src := srcRaw.(*v1alpha1.DatabaseCluster)

    dst.ObjectMeta = src.ObjectMeta
    dst.Spec.Replicas = src.Spec.Replicas
    dst.Spec.DatabaseVersion = src.Spec.Version
    dst.Spec.Storage.Capacity = src.Spec.Storage.Size
    dst.Status.Phase = src.Status.Phase
    dst.Status.Conditions = src.Status.Conditions

    return nil
}
```

## Operator Deployment Manifest

```yaml
# config/manager/manager.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: database-operator-controller-manager
  namespace: database-operator-system
  labels:
    app: database-operator
    app.kubernetes.io/component: manager
spec:
  replicas: 1  # Single replica with leader election for HA
  selector:
    matchLabels:
      app: database-operator
  template:
    metadata:
      labels:
        app: database-operator
      annotations:
        kubectl.kubernetes.io/default-container: manager
    spec:
      serviceAccountName: database-operator-controller-manager
      securityContext:
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault
      terminationGracePeriodSeconds: 10
      containers:
        - name: manager
          image: registry.example.com/database-operator:v0.1.0
          command:
            - /manager
          args:
            - --leader-elect
            - --leader-election-namespace=database-operator-system
            - --metrics-bind-address=:8080
            - --health-probe-bind-address=:8081
            - --sync-period=10m
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop:
                - ALL
          ports:
            - name: metrics
              containerPort: 8080
              protocol: TCP
            - name: healthz
              containerPort: 8081
              protocol: TCP
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8081
            initialDelaySeconds: 15
            periodSeconds: 20
          readinessProbe:
            httpGet:
              path: /readyz
              port: 8081
            initialDelaySeconds: 5
            periodSeconds: 10
          resources:
            requests:
              cpu: 10m
              memory: 64Mi
            limits:
              cpu: 500m
              memory: 256Mi
          env:
            - name: OPERATOR_NAMESPACE
              valueFrom:
                fieldRef:
                  fieldPath: metadata.namespace
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: database-operator
```

## Operator Release Lifecycle

A mature operator release process includes:

```makefile
# Makefile excerpt for operator release lifecycle

.PHONY: generate manifests docker-build docker-push deploy

# Generate CRD manifests and DeepCopy methods
generate:
	controller-gen object:headerFile="hack/boilerplate.go.txt" paths="./..."
	controller-gen crd rbac:roleName=manager-role webhook paths="./..." output:crd:artifacts:config=config/crd/bases

# Run unit + integration tests
test:
	go test ./... -coverprofile=cover.out -covermode=atomic
	go tool cover -func=cover.out

# Run e2e tests against a real cluster
test-e2e:
	KUBECONFIG=${HOME}/.kube/config go test ./test/e2e/... -v -timeout 30m

# Build and push operator image
docker-build:
	docker build -t $(IMG) .
	docker push $(IMG)

# Deploy to cluster
deploy:
	cd config/manager && kustomize edit set image controller=$(IMG)
	kustomize build config/default | kubectl apply -f -

# Run linters
lint:
	golangci-lint run ./...
	controller-gen crd paths="./..." 2>&1 | grep -v "^$"

# Verify generated files are up to date
verify:
	$(MAKE) generate manifests
	git diff --exit-code
```

Operators are the mechanism by which Kubernetes extends from a container orchestrator to a platform capable of managing arbitrary complex stateful systems. The controller-runtime library provides the scaffolding; the reconciliation pattern provides the mental model; production readiness requires owner references for garbage collection, status conditions for observability, leader election for HA, and envtest-based testing for confidence in correctness across the full resource lifecycle.
