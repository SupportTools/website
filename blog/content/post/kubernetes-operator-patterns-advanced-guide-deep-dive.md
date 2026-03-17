---
title: "Kubernetes Operator Patterns: Reconciliation Loops, Status Subresources, and Finalizers"
date: 2028-04-04T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Operators", "controller-runtime", "Go", "CRD"]
categories: ["Kubernetes", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive deep dive into Kubernetes Operator patterns covering reconciliation loops, status subresources, finalizers, and production-grade controller design with controller-runtime."
more_link: "yes"
url: "/kubernetes-operator-patterns-advanced-guide-deep-dive/"
---

Building production-grade Kubernetes Operators requires mastering several foundational patterns: the reconciliation loop, status subresources, finalizers for cleanup, and error handling strategies that keep controllers healthy under real cluster conditions. This guide covers the full operator development lifecycle with concrete Go examples using controller-runtime.

<!--more-->

# Kubernetes Operator Patterns: Reconciliation Loops, Status Subresources, and Finalizers

## Why Operators Matter in Production

Kubernetes Operators encode operational knowledge directly into the cluster. Rather than relying on runbooks and human intervention, operators automate complex stateful application lifecycle management. The Operator pattern extends the Kubernetes API through Custom Resource Definitions (CRDs) paired with custom controllers that implement domain-specific logic.

The core challenge is building operators that are **idempotent**, **level-triggered**, and **robust against partial failures**. This guide examines each pattern in depth with production-tested approaches.

## Project Setup with controller-runtime

The controller-runtime library, used by kubebuilder and operator-sdk, provides the scaffolding for operator development.

```bash
# Initialize a new operator project
mkdir myapp-operator && cd myapp-operator
go mod init github.com/example/myapp-operator

# Install controller-runtime
go get sigs.k8s.io/controller-runtime@v0.17.0

# Install code generation tools
go install sigs.k8s.io/controller-tools/cmd/controller-gen@latest
```

### Project Structure

```
myapp-operator/
├── api/
│   └── v1alpha1/
│       ├── groupversion_info.go
│       ├── myapp_types.go
│       └── zz_generated.deepcopy.go
├── config/
│   ├── crd/
│   ├── rbac/
│   └── manager/
├── controllers/
│   ├── myapp_controller.go
│   └── suite_test.go
├── main.go
└── go.mod
```

## Defining the Custom Resource

Start with a well-designed CRD that separates spec (desired state) from status (observed state).

```go
// api/v1alpha1/myapp_types.go
package v1alpha1

import (
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// MyAppSpec defines the desired state of MyApp
type MyAppSpec struct {
    // Replicas is the desired number of application instances
    // +kubebuilder:validation:Minimum=0
    // +kubebuilder:validation:Maximum=100
    Replicas int32 `json:"replicas"`

    // Image is the container image to run
    // +kubebuilder:validation:MinLength=1
    Image string `json:"image"`

    // Version is the application version to deploy
    Version string `json:"version"`

    // Resources defines the compute resource requirements
    // +optional
    Resources *ResourceRequirements `json:"resources,omitempty"`

    // Config holds application-specific configuration
    // +optional
    Config map[string]string `json:"config,omitempty"`

    // MaintenanceWindow defines when automated maintenance may occur
    // +optional
    MaintenanceWindow *MaintenanceWindow `json:"maintenanceWindow,omitempty"`
}

// ResourceRequirements defines CPU and memory constraints
type ResourceRequirements struct {
    // +optional
    CPURequest string `json:"cpuRequest,omitempty"`
    // +optional
    CPULimit string `json:"cpuLimit,omitempty"`
    // +optional
    MemoryRequest string `json:"memoryRequest,omitempty"`
    // +optional
    MemoryLimit string `json:"memoryLimit,omitempty"`
}

// MaintenanceWindow specifies a recurring time window
type MaintenanceWindow struct {
    // DayOfWeek in cron format (0=Sunday through 6=Saturday)
    DayOfWeek int `json:"dayOfWeek"`
    // StartHour in UTC (0-23)
    StartHour int `json:"startHour"`
    // DurationHours is the length of the window
    DurationHours int `json:"durationHours"`
}

// MyAppStatus defines the observed state of MyApp
type MyAppStatus struct {
    // Phase represents the current lifecycle phase
    // +kubebuilder:validation:Enum=Pending;Running;Degraded;Failed;Terminating
    Phase string `json:"phase,omitempty"`

    // ReadyReplicas is the number of ready instances
    ReadyReplicas int32 `json:"readyReplicas,omitempty"`

    // ObservedGeneration is the most recent generation observed
    ObservedGeneration int64 `json:"observedGeneration,omitempty"`

    // Conditions contains the current service state conditions
    // +optional
    // +listType=map
    // +listMapKey=type
    Conditions []metav1.Condition `json:"conditions,omitempty"`

    // LastReconcileTime is when the controller last processed this resource
    // +optional
    LastReconcileTime *metav1.Time `json:"lastReconcileTime,omitempty"`

    // CurrentVersion is the version currently deployed
    // +optional
    CurrentVersion string `json:"currentVersion,omitempty"`

    // Message provides human-readable information about the current state
    // +optional
    Message string `json:"message,omitempty"`
}

// Condition type constants
const (
    ConditionAvailable   = "Available"
    ConditionProgressing = "Progressing"
    ConditionDegraded    = "Degraded"
)

// Phase constants
const (
    PhasePending     = "Pending"
    PhaseRunning     = "Running"
    PhaseDegraded    = "Degraded"
    PhaseFailed      = "Failed"
    PhaseTerminating = "Terminating"
)

//+kubebuilder:object:root=true
//+kubebuilder:subresource:status
//+kubebuilder:printcolumn:name="Phase",type="string",JSONPath=".status.phase"
//+kubebuilder:printcolumn:name="Ready",type="integer",JSONPath=".status.readyReplicas"
//+kubebuilder:printcolumn:name="Version",type="string",JSONPath=".status.currentVersion"
//+kubebuilder:printcolumn:name="Age",type="date",JSONPath=".metadata.creationTimestamp"

// MyApp is the Schema for the myapps API
type MyApp struct {
    metav1.TypeMeta   `json:",inline"`
    metav1.ObjectMeta `json:"metadata,omitempty"`

    Spec   MyAppSpec   `json:"spec,omitempty"`
    Status MyAppStatus `json:"status,omitempty"`
}

//+kubebuilder:object:root=true

// MyAppList contains a list of MyApp
type MyAppList struct {
    metav1.TypeMeta `json:",inline"`
    metav1.ListMeta `json:"metadata,omitempty"`
    Items           []MyApp `json:"items"`
}

func init() {
    SchemeBuilder.Register(&MyApp{}, &MyAppList{})
}
```

## The Reconciliation Loop

The reconciliation loop is the heart of every operator. It runs whenever the desired state (spec) or observed state changes, and ensures the actual cluster state matches the desired state.

```go
// controllers/myapp_controller.go
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
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
    "sigs.k8s.io/controller-runtime/pkg/log"

    myappv1alpha1 "github.com/example/myapp-operator/api/v1alpha1"
)

const (
    finalizerName   = "myapp.example.com/finalizer"
    requeueAfter    = 30 * time.Second
    requeueOnError  = 10 * time.Second
)

// MyAppReconciler reconciles a MyApp object
type MyAppReconciler struct {
    client.Client
    Scheme *runtime.Scheme
}

//+kubebuilder:rbac:groups=apps.example.com,resources=myapps,verbs=get;list;watch;create;update;patch;delete
//+kubebuilder:rbac:groups=apps.example.com,resources=myapps/status,verbs=get;update;patch
//+kubebuilder:rbac:groups=apps.example.com,resources=myapps/finalizers,verbs=update
//+kubebuilder:rbac:groups=apps,resources=deployments,verbs=get;list;watch;create;update;patch;delete
//+kubebuilder:rbac:groups=core,resources=services,verbs=get;list;watch;create;update;patch;delete
//+kubebuilder:rbac:groups=core,resources=configmaps,verbs=get;list;watch;create;update;patch;delete
//+kubebuilder:rbac:groups=core,resources=events,verbs=create;patch

func (r *MyAppReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    logger := log.FromContext(ctx)
    logger.Info("Starting reconciliation", "resource", req.NamespacedName)

    // Fetch the MyApp instance
    myapp := &myappv1alpha1.MyApp{}
    if err := r.Get(ctx, req.NamespacedName, myapp); err != nil {
        if apierrors.IsNotFound(err) {
            // Object was deleted before we could reconcile — nothing to do
            logger.Info("MyApp not found, likely deleted")
            return ctrl.Result{}, nil
        }
        logger.Error(err, "Failed to fetch MyApp")
        return ctrl.Result{}, err
    }

    // Make a deep copy to avoid mutating the cache
    original := myapp.DeepCopy()

    // Handle deletion
    if !myapp.DeletionTimestamp.IsZero() {
        return r.reconcileDelete(ctx, myapp)
    }

    // Add finalizer if not present
    if !controllerutil.ContainsFinalizer(myapp, finalizerName) {
        controllerutil.AddFinalizer(myapp, finalizerName)
        if err := r.Update(ctx, myapp); err != nil {
            logger.Error(err, "Failed to add finalizer")
            return ctrl.Result{}, err
        }
        // Requeue to continue reconciliation with finalizer set
        return ctrl.Result{Requeue: true}, nil
    }

    // Perform the actual reconciliation
    result, err := r.reconcileNormal(ctx, myapp)

    // Update status if it changed
    if !equality.Semantic.DeepEqual(original.Status, myapp.Status) {
        myapp.Status.LastReconcileTime = &metav1.Time{Time: time.Now()}
        myapp.Status.ObservedGeneration = myapp.Generation
        if statusErr := r.Status().Update(ctx, myapp); statusErr != nil {
            logger.Error(statusErr, "Failed to update status")
            if err == nil {
                return ctrl.Result{}, statusErr
            }
        }
    }

    return result, err
}

// reconcileNormal handles the main reconciliation path
func (r *MyAppReconciler) reconcileNormal(ctx context.Context, myapp *myappv1alpha1.MyApp) (ctrl.Result, error) {
    logger := log.FromContext(ctx)

    // Step 1: Reconcile ConfigMap
    if err := r.reconcileConfigMap(ctx, myapp); err != nil {
        logger.Error(err, "Failed to reconcile ConfigMap")
        r.setCondition(myapp, myappv1alpha1.ConditionProgressing, metav1.ConditionFalse,
            "ConfigMapFailed", fmt.Sprintf("Failed to reconcile ConfigMap: %v", err))
        myapp.Status.Phase = myappv1alpha1.PhaseFailed
        return ctrl.Result{RequeueAfter: requeueOnError}, err
    }

    // Step 2: Reconcile Deployment
    deployment, err := r.reconcileDeployment(ctx, myapp)
    if err != nil {
        logger.Error(err, "Failed to reconcile Deployment")
        r.setCondition(myapp, myappv1alpha1.ConditionProgressing, metav1.ConditionFalse,
            "DeploymentFailed", fmt.Sprintf("Failed to reconcile Deployment: %v", err))
        myapp.Status.Phase = myappv1alpha1.PhaseFailed
        return ctrl.Result{RequeueAfter: requeueOnError}, err
    }

    // Step 3: Reconcile Service
    if err := r.reconcileService(ctx, myapp); err != nil {
        logger.Error(err, "Failed to reconcile Service")
        myapp.Status.Phase = myappv1alpha1.PhaseFailed
        return ctrl.Result{RequeueAfter: requeueOnError}, err
    }

    // Step 4: Update status based on deployment state
    r.updateStatusFromDeployment(myapp, deployment)

    // Requeue periodically for health checks
    return ctrl.Result{RequeueAfter: requeueAfter}, nil
}

// reconcileConfigMap ensures the ConfigMap exists with the correct data
func (r *MyAppReconciler) reconcileConfigMap(ctx context.Context, myapp *myappv1alpha1.MyApp) error {
    logger := log.FromContext(ctx)

    desired := r.buildConfigMap(myapp)

    // Set ownership so the ConfigMap is garbage collected with the MyApp
    if err := controllerutil.SetControllerReference(myapp, desired, r.Scheme); err != nil {
        return fmt.Errorf("setting controller reference: %w", err)
    }

    existing := &corev1.ConfigMap{}
    err := r.Get(ctx, types.NamespacedName{
        Name:      desired.Name,
        Namespace: desired.Namespace,
    }, existing)

    if apierrors.IsNotFound(err) {
        logger.Info("Creating ConfigMap", "name", desired.Name)
        return r.Create(ctx, desired)
    }
    if err != nil {
        return fmt.Errorf("getting ConfigMap: %w", err)
    }

    // Update if data differs
    if !equality.Semantic.DeepEqual(existing.Data, desired.Data) {
        existing.Data = desired.Data
        logger.Info("Updating ConfigMap", "name", existing.Name)
        return r.Update(ctx, existing)
    }

    return nil
}

// reconcileDeployment ensures the Deployment matches the desired state
func (r *MyAppReconciler) reconcileDeployment(ctx context.Context, myapp *myappv1alpha1.MyApp) (*appsv1.Deployment, error) {
    logger := log.FromContext(ctx)

    desired := r.buildDeployment(myapp)

    if err := controllerutil.SetControllerReference(myapp, desired, r.Scheme); err != nil {
        return nil, fmt.Errorf("setting controller reference: %w", err)
    }

    existing := &appsv1.Deployment{}
    err := r.Get(ctx, types.NamespacedName{
        Name:      desired.Name,
        Namespace: desired.Namespace,
    }, existing)

    if apierrors.IsNotFound(err) {
        logger.Info("Creating Deployment", "name", desired.Name)
        if err := r.Create(ctx, desired); err != nil {
            return nil, fmt.Errorf("creating Deployment: %w", err)
        }
        return desired, nil
    }
    if err != nil {
        return nil, fmt.Errorf("getting Deployment: %w", err)
    }

    // Patch only the fields we manage to avoid conflicts
    patch := client.MergeFrom(existing.DeepCopy())
    existing.Spec.Replicas = desired.Spec.Replicas
    existing.Spec.Template.Spec.Containers = desired.Spec.Template.Spec.Containers

    if err := r.Patch(ctx, existing, patch); err != nil {
        return nil, fmt.Errorf("patching Deployment: %w", err)
    }

    return existing, nil
}

// reconcileService ensures the Service exists with correct configuration
func (r *MyAppReconciler) reconcileService(ctx context.Context, myapp *myappv1alpha1.MyApp) error {
    logger := log.FromContext(ctx)

    desired := r.buildService(myapp)
    if err := controllerutil.SetControllerReference(myapp, desired, r.Scheme); err != nil {
        return fmt.Errorf("setting controller reference: %w", err)
    }

    existing := &corev1.Service{}
    err := r.Get(ctx, types.NamespacedName{
        Name:      desired.Name,
        Namespace: desired.Namespace,
    }, existing)

    if apierrors.IsNotFound(err) {
        logger.Info("Creating Service", "name", desired.Name)
        return r.Create(ctx, desired)
    }
    return err
}
```

## Finalizers: Controlled Cleanup

Finalizers prevent object deletion until cleanup logic completes. This is critical for operators managing external resources.

```go
// reconcileDelete handles cleanup when a MyApp is being deleted
func (r *MyAppReconciler) reconcileDelete(ctx context.Context, myapp *myappv1alpha1.MyApp) (ctrl.Result, error) {
    logger := log.FromContext(ctx)
    logger.Info("Handling deletion", "name", myapp.Name)

    if !controllerutil.ContainsFinalizer(myapp, finalizerName) {
        // Finalizer already removed, nothing to do
        return ctrl.Result{}, nil
    }

    // Update phase to indicate termination
    myapp.Status.Phase = myappv1alpha1.PhaseTerminating
    if err := r.Status().Update(ctx, myapp); err != nil {
        logger.Error(err, "Failed to update terminating status")
        // Continue anyway — don't block deletion
    }

    // Perform cleanup operations
    if err := r.performCleanup(ctx, myapp); err != nil {
        logger.Error(err, "Cleanup failed, will retry")
        // Return error to requeue — do NOT remove finalizer
        return ctrl.Result{RequeueAfter: requeueOnError}, err
    }

    // Cleanup succeeded — remove finalizer to allow deletion to proceed
    controllerutil.RemoveFinalizer(myapp, finalizerName)
    if err := r.Update(ctx, myapp); err != nil {
        logger.Error(err, "Failed to remove finalizer")
        return ctrl.Result{}, err
    }

    logger.Info("Finalizer removed, deletion will proceed")
    return ctrl.Result{}, nil
}

// performCleanup executes all pre-deletion cleanup tasks
func (r *MyAppReconciler) performCleanup(ctx context.Context, myapp *myappv1alpha1.MyApp) error {
    logger := log.FromContext(ctx)

    // Example: drain connections from a load balancer
    if err := r.drainLoadBalancer(ctx, myapp); err != nil {
        return fmt.Errorf("draining load balancer: %w", err)
    }

    // Example: archive data before deletion
    if err := r.archiveData(ctx, myapp); err != nil {
        return fmt.Errorf("archiving data: %w", err)
    }

    // Example: revoke external API credentials
    if err := r.revokeExternalCredentials(ctx, myapp); err != nil {
        logger.Error(err, "Failed to revoke credentials (non-fatal)")
        // Log but don't block deletion for non-critical cleanup
    }

    logger.Info("Cleanup completed successfully")
    return nil
}

func (r *MyAppReconciler) drainLoadBalancer(ctx context.Context, myapp *myappv1alpha1.MyApp) error {
    // Implementation would integrate with external LB API
    log.FromContext(ctx).Info("Draining load balancer connections", "app", myapp.Name)
    return nil
}

func (r *MyAppReconciler) archiveData(ctx context.Context, myapp *myappv1alpha1.MyApp) error {
    log.FromContext(ctx).Info("Archiving application data", "app", myapp.Name)
    return nil
}

func (r *MyAppReconciler) revokeExternalCredentials(ctx context.Context, myapp *myappv1alpha1.MyApp) error {
    log.FromContext(ctx).Info("Revoking external credentials", "app", myapp.Name)
    return nil
}
```

## Status Subresources and Conditions

The status subresource separates spec updates from status updates, preventing write conflicts and allowing fine-grained RBAC.

```go
// updateStatusFromDeployment syncs status with the underlying Deployment
func (r *MyAppReconciler) updateStatusFromDeployment(myapp *myappv1alpha1.MyApp, deployment *appsv1.Deployment) {
    myapp.Status.ReadyReplicas = deployment.Status.ReadyReplicas

    desired := myapp.Spec.Replicas
    ready := deployment.Status.ReadyReplicas
    available := deployment.Status.AvailableReplicas

    switch {
    case ready == 0 && desired > 0:
        myapp.Status.Phase = myappv1alpha1.PhasePending
        r.setCondition(myapp, myappv1alpha1.ConditionAvailable, metav1.ConditionFalse,
            "NoReadyReplicas", "No replicas are ready")
        r.setCondition(myapp, myappv1alpha1.ConditionProgressing, metav1.ConditionTrue,
            "ReplicasStarting", fmt.Sprintf("0/%d replicas ready", desired))

    case ready < desired:
        myapp.Status.Phase = myappv1alpha1.PhaseDegraded
        r.setCondition(myapp, myappv1alpha1.ConditionAvailable, metav1.ConditionTrue,
            "PartiallyAvailable", fmt.Sprintf("%d/%d replicas ready", ready, desired))
        r.setCondition(myapp, myappv1alpha1.ConditionDegraded, metav1.ConditionTrue,
            "InsufficientReplicas", fmt.Sprintf("Only %d of %d desired replicas available", available, desired))

    case ready == desired:
        myapp.Status.Phase = myappv1alpha1.PhaseRunning
        myapp.Status.CurrentVersion = myapp.Spec.Version
        r.setCondition(myapp, myappv1alpha1.ConditionAvailable, metav1.ConditionTrue,
            "AllReplicasReady", fmt.Sprintf("All %d replicas are ready", ready))
        r.setCondition(myapp, myappv1alpha1.ConditionProgressing, metav1.ConditionFalse,
            "ReconcileComplete", "All resources are in sync")
        r.setCondition(myapp, myappv1alpha1.ConditionDegraded, metav1.ConditionFalse,
            "Healthy", "Application is operating normally")
    }
}

// setCondition sets a condition on the MyApp status using metav1.Condition
func (r *MyAppReconciler) setCondition(
    myapp *myappv1alpha1.MyApp,
    conditionType string,
    status metav1.ConditionStatus,
    reason string,
    message string,
) {
    meta.SetStatusCondition(&myapp.Status.Conditions, metav1.Condition{
        Type:               conditionType,
        Status:             status,
        Reason:             reason,
        Message:            message,
        ObservedGeneration: myapp.Generation,
    })
}
```

## Resource Builders

Keep your reconciler clean by separating resource construction into builder functions.

```go
// buildDeployment constructs the desired Deployment for a MyApp
func (r *MyAppReconciler) buildDeployment(myapp *myappv1alpha1.MyApp) *appsv1.Deployment {
    labels := labelsForMyApp(myapp)
    replicas := myapp.Spec.Replicas

    resources := corev1.ResourceRequirements{}
    if myapp.Spec.Resources != nil {
        res := myapp.Spec.Resources
        if res.CPURequest != "" {
            // Parse and set resource values (simplified for brevity)
        }
    }

    deployment := &appsv1.Deployment{
        ObjectMeta: metav1.ObjectMeta{
            Name:      deploymentName(myapp),
            Namespace: myapp.Namespace,
            Labels:    labels,
        },
        Spec: appsv1.DeploymentSpec{
            Replicas: &replicas,
            Selector: &metav1.LabelSelector{
                MatchLabels: labels,
            },
            Strategy: appsv1.DeploymentStrategy{
                Type: appsv1.RollingUpdateDeploymentStrategyType,
                RollingUpdate: &appsv1.RollingUpdateDeployment{
                    MaxUnavailable: intOrStringPtr(0),
                    MaxSurge:       intOrStringPtr(1),
                },
            },
            Template: corev1.PodTemplateSpec{
                ObjectMeta: metav1.ObjectMeta{
                    Labels: labels,
                    Annotations: map[string]string{
                        "myapp.example.com/config-hash": configHash(myapp.Spec.Config),
                    },
                },
                Spec: corev1.PodSpec{
                    TerminationGracePeriodSeconds: int64Ptr(60),
                    Containers: []corev1.Container{
                        {
                            Name:            "myapp",
                            Image:           fmt.Sprintf("%s:%s", myapp.Spec.Image, myapp.Spec.Version),
                            ImagePullPolicy: corev1.PullIfNotPresent,
                            Resources:       resources,
                            Ports: []corev1.ContainerPort{
                                {Name: "http", ContainerPort: 8080},
                                {Name: "metrics", ContainerPort: 9090},
                            },
                            LivenessProbe: &corev1.Probe{
                                ProbeHandler: corev1.ProbeHandler{
                                    HTTPGet: &corev1.HTTPGetAction{
                                        Path: "/healthz",
                                        Port: intOrStringNamed("http"),
                                    },
                                },
                                InitialDelaySeconds: 15,
                                PeriodSeconds:       10,
                                FailureThreshold:    3,
                            },
                            ReadinessProbe: &corev1.Probe{
                                ProbeHandler: corev1.ProbeHandler{
                                    HTTPGet: &corev1.HTTPGetAction{
                                        Path: "/ready",
                                        Port: intOrStringNamed("http"),
                                    },
                                },
                                InitialDelaySeconds: 5,
                                PeriodSeconds:       5,
                                FailureThreshold:    3,
                            },
                            EnvFrom: []corev1.EnvFromSource{
                                {
                                    ConfigMapRef: &corev1.ConfigMapEnvSource{
                                        LocalObjectReference: corev1.LocalObjectReference{
                                            Name: configMapName(myapp),
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
    }

    return deployment
}

// buildConfigMap constructs the ConfigMap from MyApp config values
func (r *MyAppReconciler) buildConfigMap(myapp *myappv1alpha1.MyApp) *corev1.ConfigMap {
    data := make(map[string]string)
    for k, v := range myapp.Spec.Config {
        data[k] = v
    }
    data["APP_VERSION"] = myapp.Spec.Version
    data["APP_NAME"] = myapp.Name

    return &corev1.ConfigMap{
        ObjectMeta: metav1.ObjectMeta{
            Name:      configMapName(myapp),
            Namespace: myapp.Namespace,
            Labels:    labelsForMyApp(myapp),
        },
        Data: data,
    }
}

// buildService constructs a ClusterIP Service for the MyApp
func (r *MyAppReconciler) buildService(myapp *myappv1alpha1.MyApp) *corev1.Service {
    return &corev1.Service{
        ObjectMeta: metav1.ObjectMeta{
            Name:      serviceName(myapp),
            Namespace: myapp.Namespace,
            Labels:    labelsForMyApp(myapp),
        },
        Spec: corev1.ServiceSpec{
            Selector: labelsForMyApp(myapp),
            Ports: []corev1.ServicePort{
                {Name: "http", Port: 80, Protocol: corev1.ProtocolTCP},
                {Name: "metrics", Port: 9090, Protocol: corev1.ProtocolTCP},
            },
            Type: corev1.ServiceTypeClusterIP,
        },
    }
}
```

## Controller Setup and Manager Configuration

```go
// main.go
package main

import (
    "flag"
    "os"
    "time"

    "k8s.io/apimachinery/pkg/runtime"
    utilruntime "k8s.io/apimachinery/pkg/util/runtime"
    clientgoscheme "k8s.io/client-go/kubernetes/scheme"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/cache"
    "sigs.k8s.io/controller-runtime/pkg/healthz"
    "sigs.k8s.io/controller-runtime/pkg/log/zap"
    metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"

    myappv1alpha1 "github.com/example/myapp-operator/api/v1alpha1"
    "github.com/example/myapp-operator/controllers"
)

var scheme = runtime.NewScheme()

func init() {
    utilruntime.Must(clientgoscheme.AddToScheme(scheme))
    utilruntime.Must(myappv1alpha1.AddToScheme(scheme))
}

func main() {
    var metricsAddr string
    var enableLeaderElection bool
    var probeAddr string
    var syncPeriod time.Duration

    flag.StringVar(&metricsAddr, "metrics-bind-address", ":8080", "The address for metrics endpoint")
    flag.StringVar(&probeAddr, "health-probe-bind-address", ":8081", "The address for health probes")
    flag.BoolVar(&enableLeaderElection, "leader-elect", false, "Enable leader election")
    flag.DurationVar(&syncPeriod, "sync-period", 10*time.Minute, "Resync period for the controller cache")
    flag.Parse()

    ctrl.SetLogger(zap.New(zap.UseFlagOptions(&zap.Options{Development: false})))

    mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
        Scheme: scheme,
        Metrics: metricsserver.Options{
            BindAddress: metricsAddr,
        },
        HealthProbeBindAddress: probeAddr,
        LeaderElection:         enableLeaderElection,
        LeaderElectionID:       "myapp-operator.example.com",
        // Resync ensures we catch any drift even without watch events
        Cache: cache.Options{
            SyncPeriod: &syncPeriod,
        },
    })
    if err != nil {
        ctrl.Log.Error(err, "Unable to start manager")
        os.Exit(1)
    }

    if err = (&controllers.MyAppReconciler{
        Client: mgr.GetClient(),
        Scheme: mgr.GetScheme(),
    }).SetupWithManager(mgr); err != nil {
        ctrl.Log.Error(err, "Unable to create controller")
        os.Exit(1)
    }

    if err := mgr.AddHealthzCheck("healthz", healthz.Ping); err != nil {
        ctrl.Log.Error(err, "Unable to set up health check")
        os.Exit(1)
    }
    if err := mgr.AddReadyzCheck("readyz", healthz.Ping); err != nil {
        ctrl.Log.Error(err, "Unable to set up ready check")
        os.Exit(1)
    }

    ctrl.Log.Info("Starting manager")
    if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
        ctrl.Log.Error(err, "Problem running manager")
        os.Exit(1)
    }
}
```

## SetupWithManager: Configuring Watch Predicates

```go
// SetupWithManager configures the controller watches and predicates
func (r *MyAppReconciler) SetupWithManager(mgr ctrl.Manager) error {
    // Predicate to filter generation changes (ignore status-only updates)
    generationChangedPredicate := predicate.GenerationChangedPredicate{}

    // Watch owned Deployments and trigger reconciliation on their changes
    deploymentHandler := handler.EnqueueRequestForOwner(
        mgr.GetScheme(),
        mgr.GetRESTMapper(),
        &myappv1alpha1.MyApp{},
        handler.OnlyControllerOwner(),
    )

    return ctrl.NewControllerManagedBy(mgr).
        For(&myappv1alpha1.MyApp{},
            builder.WithPredicates(generationChangedPredicate),
        ).
        Owns(&appsv1.Deployment{},
            builder.WithPredicates(predicate.ResourceVersionChangedPredicate{}),
        ).
        Owns(&corev1.Service{}).
        Owns(&corev1.ConfigMap{}).
        // Watch Deployments not owned by us (e.g., for cross-namespace monitoring)
        Watches(
            &appsv1.Deployment{},
            deploymentHandler,
        ).
        // Configure concurrency — be careful with high values
        WithOptions(controller.Options{
            MaxConcurrentReconciles: 5,
            RateLimiter: workqueue.NewTypedItemExponentialFailureRateLimiter[reconcile.Request](
                500*time.Millisecond,
                60*time.Second,
            ),
        }).
        Complete(r)
}
```

## Error Handling and Retry Strategies

```go
// RetryableError wraps an error indicating a transient condition
type RetryableError struct {
    Err   error
    After time.Duration
}

func (e *RetryableError) Error() string {
    return fmt.Sprintf("retryable error (retry after %s): %v", e.After, e.Err)
}

func (e *RetryableError) Unwrap() error { return e.Err }

// handleReconcileError interprets errors and returns appropriate results
func handleReconcileError(err error) (ctrl.Result, error) {
    if err == nil {
        return ctrl.Result{}, nil
    }

    var retryable *RetryableError
    if errors.As(err, &retryable) {
        return ctrl.Result{RequeueAfter: retryable.After}, nil
    }

    if apierrors.IsConflict(err) {
        // Optimistic locking conflict — requeue quickly
        return ctrl.Result{RequeueAfter: time.Second}, nil
    }

    if apierrors.IsServiceUnavailable(err) || apierrors.IsTimeout(err) {
        return ctrl.Result{RequeueAfter: 5 * time.Second}, nil
    }

    // Unknown error — let the rate limiter handle backoff
    return ctrl.Result{}, err
}
```

## Testing Operators with envtest

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

    "k8s.io/client-go/kubernetes/scheme"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/envtest"
    logf "sigs.k8s.io/controller-runtime/pkg/log"
    "sigs.k8s.io/controller-runtime/pkg/log/zap"

    myappv1alpha1 "github.com/example/myapp-operator/api/v1alpha1"
    "github.com/example/myapp-operator/controllers"
)

var (
    k8sClient  client.Client
    testEnv    *envtest.Environment
    cancelFunc context.CancelFunc
)

func TestControllers(t *testing.T) {
    RegisterFailHandler(Fail)
    RunSpecs(t, "Controller Suite")
}

var _ = BeforeSuite(func() {
    logf.SetLogger(zap.New(zap.WriteTo(GinkgoWriter), zap.UseDevMode(true)))

    testEnv = &envtest.Environment{
        CRDDirectoryPaths: []string{
            filepath.Join("..", "config", "crd", "bases"),
        },
        ErrorIfCRDPathMissing: true,
    }

    cfg, err := testEnv.Start()
    Expect(err).NotTo(HaveOccurred())
    Expect(cfg).NotTo(BeNil())

    err = myappv1alpha1.AddToScheme(scheme.Scheme)
    Expect(err).NotTo(HaveOccurred())

    k8sClient, err = client.New(cfg, client.Options{Scheme: scheme.Scheme})
    Expect(err).NotTo(HaveOccurred())

    mgr, err := ctrl.NewManager(cfg, ctrl.Options{Scheme: scheme.Scheme})
    Expect(err).NotTo(HaveOccurred())

    err = (&controllers.MyAppReconciler{
        Client: mgr.GetClient(),
        Scheme: mgr.GetScheme(),
    }).SetupWithManager(mgr)
    Expect(err).NotTo(HaveOccurred())

    ctx, cancel := context.WithCancel(context.Background())
    cancelFunc = cancel
    go func() {
        err = mgr.Start(ctx)
        Expect(err).NotTo(HaveOccurred())
    }()
})

var _ = AfterSuite(func() {
    cancelFunc()
    err := testEnv.Stop()
    Expect(err).NotTo(HaveOccurred())
})

var _ = Describe("MyApp Controller", func() {
    const timeout = time.Second * 30
    const interval = time.Millisecond * 250

    Context("When creating a MyApp", func() {
        It("should create a Deployment", func() {
            ctx := context.Background()
            myapp := &myappv1alpha1.MyApp{
                ObjectMeta: metav1.ObjectMeta{
                    Name:      "test-app",
                    Namespace: "default",
                },
                Spec: myappv1alpha1.MyAppSpec{
                    Replicas: 2,
                    Image:    "nginx",
                    Version:  "1.25",
                },
            }

            Expect(k8sClient.Create(ctx, myapp)).To(Succeed())

            deploymentLookupKey := types.NamespacedName{
                Name:      "myapp-test-app",
                Namespace: "default",
            }
            deployment := &appsv1.Deployment{}

            Eventually(func() bool {
                err := k8sClient.Get(ctx, deploymentLookupKey, deployment)
                return err == nil
            }, timeout, interval).Should(BeTrue())

            Expect(*deployment.Spec.Replicas).To(Equal(int32(2)))
        })

        It("should transition to Running phase", func() {
            ctx := context.Background()
            lookupKey := types.NamespacedName{Name: "test-app", Namespace: "default"}
            myapp := &myappv1alpha1.MyApp{}

            Eventually(func() string {
                if err := k8sClient.Get(ctx, lookupKey, myapp); err != nil {
                    return ""
                }
                return myapp.Status.Phase
            }, timeout, interval).Should(Equal(myappv1alpha1.PhaseRunning))
        })
    })
})
```

## Production Deployment

```yaml
# config/manager/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp-operator-controller-manager
  namespace: myapp-operator-system
spec:
  replicas: 1
  selector:
    matchLabels:
      control-plane: controller-manager
  template:
    metadata:
      labels:
        control-plane: controller-manager
    spec:
      serviceAccountName: myapp-operator-controller-manager
      terminationGracePeriodSeconds: 10
      securityContext:
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault
      containers:
      - name: manager
        image: myapp-operator:latest
        imagePullPolicy: IfNotPresent
        args:
        - --leader-elect
        - --metrics-bind-address=:8080
        - --health-probe-bind-address=:8081
        - --sync-period=10m
        securityContext:
          allowPrivilegeEscalation: false
          capabilities:
            drop: ["ALL"]
          readOnlyRootFilesystem: true
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
            cpu: 100m
            memory: 64Mi
          limits:
            cpu: 500m
            memory: 256Mi
```

## Utility Helpers

```go
// helpers.go
package controllers

import (
    "crypto/sha256"
    "fmt"
    "sort"

    "k8s.io/apimachinery/pkg/util/intstr"

    myappv1alpha1 "github.com/example/myapp-operator/api/v1alpha1"
)

func labelsForMyApp(myapp *myappv1alpha1.MyApp) map[string]string {
    return map[string]string{
        "app.kubernetes.io/name":       "myapp",
        "app.kubernetes.io/instance":   myapp.Name,
        "app.kubernetes.io/version":    myapp.Spec.Version,
        "app.kubernetes.io/managed-by": "myapp-operator",
    }
}

func deploymentName(myapp *myappv1alpha1.MyApp) string {
    return fmt.Sprintf("myapp-%s", myapp.Name)
}

func configMapName(myapp *myappv1alpha1.MyApp) string {
    return fmt.Sprintf("myapp-%s-config", myapp.Name)
}

func serviceName(myapp *myappv1alpha1.MyApp) string {
    return fmt.Sprintf("myapp-%s", myapp.Name)
}

func int64Ptr(i int64) *int64 { return &i }

func intOrStringPtr(i int) *intstr.IntOrString {
    v := intstr.FromInt(i)
    return &v
}

func intOrStringNamed(s string) intstr.IntOrString {
    return intstr.FromString(s)
}

// configHash computes a stable hash of config values for annotation-based rolling updates
func configHash(config map[string]string) string {
    if len(config) == 0 {
        return "empty"
    }
    keys := make([]string, 0, len(config))
    for k := range config {
        keys = append(keys, k)
    }
    sort.Strings(keys)

    h := sha256.New()
    for _, k := range keys {
        fmt.Fprintf(h, "%s=%s\n", k, config[k])
    }
    return fmt.Sprintf("%x", h.Sum(nil))[:16]
}
```

## Common Pitfalls and Best Practices

### Avoid Spec Mutation During Reconciliation

Never modify the spec during reconciliation. The spec is the source of truth set by users. Only update the status subresource from the controller.

### Use Server-Side Apply for Complex Resources

For resources with many fields managed by multiple actors, prefer server-side apply over full updates:

```go
// Server-side apply patch
patch := &appsv1.Deployment{
    // Only include fields you own
}
patch.ManagedFields = nil

if err := r.Patch(ctx, patch, client.Apply,
    client.FieldOwner("myapp-operator"),
    client.ForceOwnership,
); err != nil {
    return fmt.Errorf("applying Deployment: %w", err)
}
```

### Generation vs ResourceVersion

Use `ObservedGeneration` to track which spec generation you've reconciled. Do not use `ResourceVersion` for this purpose — it changes on every update including status updates.

### Rate Limiting

Configure the work queue rate limiter appropriately. The default exponential backoff is usually correct, but tune it for your use case:

```go
workqueue.NewTypedItemExponentialFailureRateLimiter[reconcile.Request](
    baseDelay,  // 500ms is a good starting point
    maxDelay,   // 60s prevents excessive retries
)
```

## Conclusion

Building production-grade Kubernetes operators requires careful attention to the reconciliation loop design, proper status management through the status subresource, and robust finalizer implementation for cleanup. The patterns covered here — level-triggered reconciliation, idempotent resource management, condition tracking, and controlled deletion — form the foundation of reliable operator development. Pair these patterns with comprehensive envtest-based testing to ensure your operator handles edge cases gracefully in production clusters.
