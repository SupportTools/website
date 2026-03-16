---
title: "Kubernetes Operator Development: controller-runtime, Reconciliation Patterns, and Production Readiness"
date: 2027-07-03T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Operator", "controller-runtime", "Go", "CRD", "Development"]
categories: ["Kubernetes", "Development"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to building production-grade Kubernetes operators using controller-runtime and kubebuilder: CRD API design, reconciliation patterns, event filtering, HA leader election, Prometheus metrics, envtest testing, and OLM packaging."
more_link: "yes"
url: "/kubernetes-operator-development-guide/"
---

Kubernetes operators extend the platform's control plane with domain-specific automation, encoding operational knowledge that would otherwise live in runbooks or bespoke scripts. When an operator is well-designed it transforms complex, stateful workloads into first-class Kubernetes citizens that self-heal, scale, and upgrade with the same declarative model as any built-in resource. This guide covers every layer of the operator development lifecycle: deciding when an operator is the right tool, choosing a framework, designing durable CRD APIs, writing idempotent reconcilers, publishing stable releases, and packaging for the Operator Lifecycle Manager.

<!--more-->

## When to Write an Operator vs. Use Helm

Helm and operators are not mutually exclusive, but they solve different problems. Understanding the boundary avoids building complexity that delivers no operational benefit.

### Helm Is Sufficient When

- The application is stateless or treats state as entirely external (a database hosted outside the cluster).
- Day-2 operations reduce to reapplying a values file: version bumps, replica adjustments, flag changes.
- No conditional reactions to runtime events are required. A deployment crashing does not trigger application-level remediation.
- The release lifecycle matches the Helm lifecycle: install, upgrade, rollback, uninstall.

Helm excels at templating and release management. It falls short the moment the desired state depends on observed runtime state that only the cluster can see.

### An Operator Is Warranted When

- The workload has non-trivial day-2 operations: rolling schema migrations, coordinated leader elections inside the application, or topology-aware placement.
- Self-healing requires cross-resource orchestration beyond what `livenessProbe` and `readinessProbe` handle.
- The API exposed to platform consumers should be higher-level than raw Kubernetes primitives. A `PostgresCluster` object is more ergonomic than seven interrelated resources.
- Upgrade automation must sequence steps: drain replicas, run migration job, promote primary, re-enable traffic.
- Compliance or audit requirements demand a continuous reconciliation loop that detects and corrects drift rather than a one-shot apply.

A practical heuristic: if the runbook for the application contains "check cluster state, then decide which kubectl command to run," that logic belongs in an operator.

### The Spectrum

Many production operators start life as Helm charts. The chart handles initial installation; a lightweight operator handles day-2 operations by watching the custom resource and reacting to cluster events. These two tools compose naturally: the operator can itself be deployed by a Helm chart.

---

## Framework Choice: kubebuilder vs. operator-sdk

Both frameworks wrap `controller-runtime` and generate the same kinds of scaffolding. The choice is largely organizational.

### kubebuilder

Maintained by the Kubernetes SIGs, kubebuilder is the upstream reference implementation for controller-runtime-based operators. It generates:

- `api/` directory with typed Go structs for each CRD version.
- `internal/controller/` with a skeleton `Reconcile` method.
- `config/` with Kustomize-based manifests for CRD installation, RBAC, and controller deployment.
- Makefile targets for `generate`, `manifests`, `test`, and `build`.

kubebuilder is the right default for greenfield operators and teams already comfortable with Kustomize.

### operator-sdk

operator-sdk builds on kubebuilder scaffolding and adds:

- Integration with the Operator Lifecycle Manager (OLM) and OperatorHub.
- Ansible and Helm operator modes for teams that do not want to write Go.
- `operator-sdk scorecard` for validating operator bundles.
- Direct `operator-sdk run bundle` support for local OLM testing.

Choose operator-sdk when OLM packaging or non-Go operator modes are priorities.

### controller-runtime Directly

Large teams sometimes bypass scaffolding and depend on `controller-runtime` directly. This avoids generated boilerplate and gives full control over project layout, but requires manually wiring the Manager, controller, and webhook server. Reasonable for experienced teams; adds friction for contributors unfamiliar with the framework.

### Scaffolding a New Project

```bash
# With kubebuilder
mkdir myoperator && cd myoperator
kubebuilder init --domain example.com --repo github.com/example/myoperator
kubebuilder create api --group apps --version v1alpha1 --kind MyApp

# With operator-sdk
operator-sdk init --domain example.com --repo github.com/example/myoperator
operator-sdk create api --group apps --version v1alpha1 --kind MyApp --resource --controller
```

Both commands produce an equivalent project structure. The Makefile target `make generate && make manifests` regenerates deepcopy functions and CRD YAML after every API change.

---

## controller-runtime Manager Setup

The `Manager` is the top-level object. It owns the shared cache, the scheme, the health endpoints, the metrics server, and the leader election lease. Every controller and webhook registers with it.

### Installing Dependencies

```bash
go get sigs.k8s.io/controller-runtime@v0.18.0
go get k8s.io/apimachinery@v0.31.0
go get k8s.io/client-go@v0.31.0
```

### main.go Wiring

```go
package main

import (
    "flag"
    "os"
    "time"

    appsv1 "k8s.io/api/apps/v1"
    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/runtime"
    utilruntime "k8s.io/apimachinery/pkg/util/runtime"
    clientgoscheme "k8s.io/client-go/kubernetes/scheme"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/healthz"
    "sigs.k8s.io/controller-runtime/pkg/log/zap"
    "sigs.k8s.io/controller-runtime/pkg/metrics/server"

    appsv1alpha1 "github.com/example/myoperator/api/v1alpha1"
    "github.com/example/myoperator/internal/controller"
)

var (
    scheme   = runtime.NewScheme()
    setupLog = ctrl.Log.WithName("setup")
)

func init() {
    utilruntime.Must(clientgoscheme.AddToScheme(scheme))
    utilruntime.Must(appsv1alpha1.AddToScheme(scheme))
    _ = appsv1.AddToScheme(scheme)
    _ = corev1.AddToScheme(scheme)
}

func main() {
    var metricsAddr string
    var probeAddr string
    var enableLeaderElection bool
    var leaderElectionID string

    flag.StringVar(&metricsAddr, "metrics-bind-address", ":8080",
        "The address the metric endpoint binds to.")
    flag.StringVar(&probeAddr, "health-probe-bind-address", ":8081",
        "The address the probe endpoint binds to.")
    flag.BoolVar(&enableLeaderElection, "leader-elect", true,
        "Enable leader election for high availability.")
    flag.StringVar(&leaderElectionID, "leader-election-id", "myoperator.example.com",
        "Leader election lock name.")

    opts := zap.Options{Development: false}
    opts.BindFlags(flag.CommandLine)
    flag.Parse()

    ctrl.SetLogger(zap.New(zap.UseFlagOptions(&opts)))

    leaseDuration := 15 * time.Second
    renewDeadline := 10 * time.Second
    retryPeriod := 2 * time.Second

    mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
        Scheme: scheme,
        Metrics: server.Options{
            BindAddress: metricsAddr,
        },
        HealthProbeBindAddress:        probeAddr,
        LeaderElection:                enableLeaderElection,
        LeaderElectionID:              leaderElectionID,
        LeaderElectionNamespace:       "myoperator-system",
        LeaseDuration:                 &leaseDuration,
        RenewDeadline:                 &renewDeadline,
        RetryPeriod:                   &retryPeriod,
        LeaderElectionReleaseOnCancel: true,
    })
    if err != nil {
        setupLog.Error(err, "unable to start manager")
        os.Exit(1)
    }

    if err = (&controller.MyAppReconciler{
        Client:   mgr.GetClient(),
        Scheme:   mgr.GetScheme(),
        Recorder: mgr.GetEventRecorderFor("myapp-controller"),
    }).SetupWithManager(mgr); err != nil {
        setupLog.Error(err, "unable to create controller", "controller", "MyApp")
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

Key decisions embedded in this setup:

- `LeaderElection: true` enables the Lease-based HA mechanism described in a later section.
- The metrics server runs on `:8080`, separate from the health probe on `:8081`.
- `LeaderElectionReleaseOnCancel: true` allows a gracefully-shutting-down leader to release the lease immediately rather than waiting for `LeaseDuration` to expire.
- The scheme registers both the standard client-go types and the operator's own API group.

---

## CRD API Design

A well-designed API is the hardest part of operator development to get right, because it is the public contract that survives version upgrades. Poor choices here create conversion debt that grows with every release.

### Recommended API Layout

```
api/
  v1alpha1/
    myapp_types.go
    groupversion_info.go
    zz_generated.deepcopy.go
  v1beta1/
    myapp_types.go
    groupversion_info.go
    zz_generated.deepcopy.go
    myapp_conversion.go
```

### Spec/Status Separation

The `Spec` holds the desired state declared by the user. The `Status` holds the observed state written exclusively by the operator. These must never be mixed: a field cannot appear in both, and the operator must never write to `Spec`.

```go
// api/v1alpha1/myapp_types.go
package v1alpha1

import (
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    corev1 "k8s.io/api/core/v1"
)

// MyAppSpec defines the desired state declared by the user.
type MyAppSpec struct {
    // Replicas is the desired number of application pods.
    // +kubebuilder:default=1
    // +kubebuilder:validation:Minimum=0
    // +kubebuilder:validation:Maximum=100
    Replicas int32 `json:"replicas"`

    // Image is the container image reference including tag.
    // +kubebuilder:validation:Pattern=`^[a-z0-9]+([\-\.][a-z0-9]+)*(/[a-z0-9]+([\-\.][a-z0-9]+)*)*:[a-zA-Z0-9_\-\.]+$`
    Image string `json:"image"`

    // Resources defines compute resource requirements for each pod.
    // +optional
    Resources corev1.ResourceRequirements `json:"resources,omitempty"`

    // Config holds application-level key/value configuration pairs.
    // +optional
    Config map[string]string `json:"config,omitempty"`

    // StorageClass is the storage class used for persistent volumes.
    // +optional
    StorageClass *string `json:"storageClass,omitempty"`

    // DatabaseRef is an optional reference to a Database custom resource
    // in the same namespace.
    // +optional
    DatabaseRef *corev1.LocalObjectReference `json:"databaseRef,omitempty"`
}

// MyAppStatus defines the observed state written exclusively by the operator.
type MyAppStatus struct {
    // ObservedGeneration tracks the generation last successfully reconciled.
    // +optional
    ObservedGeneration int64 `json:"observedGeneration,omitempty"`

    // ReadyReplicas is the number of pods currently reporting Ready.
    // +optional
    ReadyReplicas int32 `json:"readyReplicas,omitempty"`

    // Conditions represent the latest available observations of the object's state.
    // +listType=map
    // +listMapKey=type
    // +patchStrategy=merge
    // +patchMergeKey=type
    // +optional
    Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:storageversion
// +kubebuilder:resource:scope=Namespaced,shortName=ma
// +kubebuilder:printcolumn:name="Ready",type="string",JSONPath=".status.readyReplicas"
// +kubebuilder:printcolumn:name="Desired",type="string",JSONPath=".spec.replicas"
// +kubebuilder:printcolumn:name="Age",type="date",JSONPath=".metadata.creationTimestamp"
// +kubebuilder:printcolumn:name="Image",type="string",JSONPath=".spec.image"
type MyApp struct {
    metav1.TypeMeta   `json:",inline"`
    metav1.ObjectMeta `json:"metadata,omitempty"`

    Spec   MyAppSpec   `json:"spec,omitempty"`
    Status MyAppStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true
type MyAppList struct {
    metav1.TypeMeta `json:",inline"`
    metav1.ListMeta `json:"metadata,omitempty"`
    Items           []MyApp `json:"items"`
}

func init() {
    SchemeBuilder.Register(&MyApp{}, &MyAppList{})
}
```

### API Design Guidelines

Several rules prevent future breaking changes:

- **Never remove a field** in the same storage version. Mark it deprecated with a comment and stop setting it.
- **Never change a field's type** without a new version and conversion webhook.
- **All optional fields must use pointer types or `omitempty`** so the zero value is unambiguous.
- **Default values belong in the CRD spec** via `+kubebuilder:default=`, not in the reconciler, so they appear in validation and documentation.
- **Enumerations should be strings** with `+kubebuilder:validation:Enum` markers, not booleans, so new values can be added without breaking changes.

---

## Status Conditions Using metav1.Condition

The `metav1.Condition` type is the canonical way to express health in Kubernetes. Every operator should expose at minimum `Available`, `Progressing`, and `Degraded` conditions, matching the convention established by Deployments and other built-in resources.

```go
// internal/controller/conditions.go
package controller

import (
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    apiv1alpha1 "github.com/example/myoperator/api/v1alpha1"
)

const (
    ConditionAvailable   = "Available"
    ConditionProgressing = "Progressing"
    ConditionDegraded    = "Degraded"

    ReasonReconciling      = "Reconciling"
    ReasonDeploymentReady  = "DeploymentReady"
    ReasonDeploymentFailed = "DeploymentFailed"
    ReasonScaling          = "Scaling"
    ReasonUpgrading        = "Upgrading"
    ReasonInvalidSpec      = "InvalidSpec"
)

func setAvailableCondition(app *apiv1alpha1.MyApp, ready int32, desired int32) {
    status := metav1.ConditionFalse
    reason := ReasonReconciling
    msg := "Waiting for replicas to become ready"

    if ready >= desired && desired > 0 {
        status = metav1.ConditionTrue
        reason = ReasonDeploymentReady
        msg = "All replicas are ready"
    }

    setCondition(app, ConditionAvailable, status, reason, msg)
}

func setProgressingCondition(app *apiv1alpha1.MyApp, progressing bool, reason, msg string) {
    status := metav1.ConditionFalse
    if progressing {
        status = metav1.ConditionTrue
    }
    setCondition(app, ConditionProgressing, status, reason, msg)
}

func setDegradedCondition(app *apiv1alpha1.MyApp, degraded bool, reason, msg string) {
    status := metav1.ConditionFalse
    if degraded {
        status = metav1.ConditionTrue
    }
    setCondition(app, ConditionDegraded, status, reason, msg)
}

func setCondition(
    app *apiv1alpha1.MyApp,
    condType string,
    status metav1.ConditionStatus,
    reason, message string,
) {
    now := metav1.Now()
    for i, c := range app.Status.Conditions {
        if c.Type == condType {
            // Only update LastTransitionTime when status actually changes.
            if c.Status == status && c.Reason == reason && c.Message == message {
                return
            }
            transitionTime := c.LastTransitionTime
            if c.Status != status {
                transitionTime = now
            }
            app.Status.Conditions[i] = metav1.Condition{
                Type:               condType,
                Status:             status,
                Reason:             reason,
                Message:            message,
                LastTransitionTime: transitionTime,
                ObservedGeneration: app.Generation,
            }
            return
        }
    }
    // Condition does not exist yet; append it.
    app.Status.Conditions = append(app.Status.Conditions, metav1.Condition{
        Type:               condType,
        Status:             status,
        Reason:             reason,
        Message:            message,
        LastTransitionTime: now,
        ObservedGeneration: app.Generation,
    })
}
```

The `LastTransitionTime` field must only update when `Status` transitions between `True` and `False`. Updating it on every reconcile makes the condition useless for alert duration calculations.

---

## The Reconcile Loop

The reconciler is a pure function of observed state. It reads the current state from the API server, computes the delta from desired state, and applies changes to converge them. It must be idempotent because it runs multiple times for any given object version.

### Controller Setup with SetupWithManager

```go
// internal/controller/myapp_controller.go
package controller

import (
    "context"
    "fmt"
    "time"

    appsv1 "k8s.io/api/apps/v1"
    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/api/errors"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime"
    "k8s.io/client-go/tools/record"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/builder"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/controller"
    "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
    "sigs.k8s.io/controller-runtime/pkg/log"
    "sigs.k8s.io/controller-runtime/pkg/predicate"

    apiv1alpha1 "github.com/example/myoperator/api/v1alpha1"
    opmetrics "github.com/example/myoperator/internal/metrics"
)

const myAppFinalizer = "myapp.example.com/finalizer"

// MyAppReconciler reconciles MyApp objects.
// +kubebuilder:rbac:groups=apps.example.com,resources=myapps,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=apps.example.com,resources=myapps/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=apps.example.com,resources=myapps/finalizers,verbs=update
// +kubebuilder:rbac:groups=apps,resources=deployments,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=services,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=configmaps,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=events,verbs=create;patch
type MyAppReconciler struct {
    client.Client
    Scheme   *runtime.Scheme
    Recorder record.EventRecorder
}

func (r *MyAppReconciler) SetupWithManager(mgr ctrl.Manager) error {
    return ctrl.NewControllerManagedBy(mgr).
        For(&apiv1alpha1.MyApp{},
            builder.WithPredicates(predicate.GenerationChangedPredicate{}),
        ).
        Owns(&appsv1.Deployment{}).
        Owns(&corev1.Service{}).
        Owns(&corev1.ConfigMap{}).
        WithOptions(controller.Options{
            MaxConcurrentReconciles: 5,
        }).
        Complete(r)
}
```

### Reconcile Method

```go
func (r *MyAppReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    start := time.Now()
    logger := log.FromContext(ctx)

    // Fetch the MyApp instance.
    app := &apiv1alpha1.MyApp{}
    if err := r.Get(ctx, req.NamespacedName, app); err != nil {
        if errors.IsNotFound(err) {
            return ctrl.Result{}, nil
        }
        return ctrl.Result{}, fmt.Errorf("fetching MyApp: %w", err)
    }

    // Handle deletion via finalizer before any other logic.
    if !app.DeletionTimestamp.IsZero() {
        return r.reconcileDelete(ctx, app)
    }

    // Ensure the finalizer is registered.
    if !controllerutil.ContainsFinalizer(app, myAppFinalizer) {
        controllerutil.AddFinalizer(app, myAppFinalizer)
        if err := r.Update(ctx, app); err != nil {
            return ctrl.Result{}, fmt.Errorf("adding finalizer: %w", err)
        }
        // Return here; the Update will trigger a new reconcile.
        return ctrl.Result{}, nil
    }

    // Run the main reconciliation, recording metrics afterward.
    result, err := r.reconcileNormal(ctx, app)

    resultLabel := "success"
    if err != nil {
        resultLabel = "error"
    } else if result.Requeue || result.RequeueAfter > 0 {
        resultLabel = "requeued"
    }
    opmetrics.ReconcileTotal.WithLabelValues("myapp", resultLabel).Inc()
    opmetrics.ReconcileDuration.WithLabelValues("myapp").Observe(time.Since(start).Seconds())

    if err != nil {
        logger.Error(err, "reconciliation failed")
        setDegradedCondition(app, true, ReasonDeploymentFailed, err.Error())
        if statusErr := r.Status().Update(ctx, app); statusErr != nil {
            logger.Error(statusErr, "failed to update degraded status")
        }
        // Classify error to determine whether to requeue with backoff.
        if isPermanentError(err) {
            return ctrl.Result{}, nil
        }
        return ctrl.Result{RequeueAfter: 30 * time.Second}, err
    }

    return result, nil
}

func isPermanentError(err error) bool {
    return errors.IsInvalid(err) || errors.IsBadRequest(err)
}

func (r *MyAppReconciler) reconcileNormal(
    ctx context.Context,
    app *apiv1alpha1.MyApp,
) (ctrl.Result, error) {
    logger := log.FromContext(ctx)

    // Signal in-progress state before doing any work.
    setProgressingCondition(app, true, ReasonReconciling, "Reconciliation in progress")
    if err := r.Status().Update(ctx, app); err != nil {
        // Conflict means another reconcile is already running. Requeue.
        if errors.IsConflict(err) {
            return ctrl.Result{Requeue: true}, nil
        }
        return ctrl.Result{}, fmt.Errorf("updating progressing status: %w", err)
    }

    // Reconcile child resources.
    if err := r.reconcileConfigMap(ctx, app); err != nil {
        return ctrl.Result{}, fmt.Errorf("reconciling ConfigMap: %w", err)
    }

    deploy, err := r.reconcileDeployment(ctx, app)
    if err != nil {
        return ctrl.Result{}, fmt.Errorf("reconciling Deployment: %w", err)
    }

    if err := r.reconcileService(ctx, app); err != nil {
        return ctrl.Result{}, fmt.Errorf("reconciling Service: %w", err)
    }

    // Refresh the object before updating status to avoid conflict errors.
    fresh := &apiv1alpha1.MyApp{}
    if err := r.Get(ctx, client.ObjectKeyFromObject(app), fresh); err != nil {
        return ctrl.Result{}, fmt.Errorf("refreshing MyApp before status update: %w", err)
    }

    fresh.Status.ObservedGeneration = app.Generation
    fresh.Status.ReadyReplicas = deploy.Status.ReadyReplicas
    fresh.Status.Conditions = app.Status.Conditions

    setAvailableCondition(fresh, deploy.Status.ReadyReplicas, app.Spec.Replicas)
    setProgressingCondition(fresh, false, ReasonDeploymentReady, "Reconciliation complete")
    setDegradedCondition(fresh, false, ReasonDeploymentReady, "No issues detected")

    if err := r.Status().Update(ctx, fresh); err != nil {
        if errors.IsConflict(err) {
            logger.V(1).Info("conflict updating final status, requeueing")
            return ctrl.Result{Requeue: true}, nil
        }
        return ctrl.Result{}, fmt.Errorf("updating final status: %w", err)
    }

    r.Recorder.Event(app, corev1.EventTypeNormal, "Reconciled",
        "Successfully reconciled MyApp resources")

    logger.Info("reconciliation complete",
        "readyReplicas", deploy.Status.ReadyReplicas,
        "desiredReplicas", app.Spec.Replicas,
    )

    // Requeue until fully ready so status stays current.
    if deploy.Status.ReadyReplicas < app.Spec.Replicas {
        return ctrl.Result{RequeueAfter: 10 * time.Second}, nil
    }

    return ctrl.Result{}, nil
}

func (r *MyAppReconciler) reconcileDelete(
    ctx context.Context,
    app *apiv1alpha1.MyApp,
) (ctrl.Result, error) {
    logger := log.FromContext(ctx)

    if controllerutil.ContainsFinalizer(app, myAppFinalizer) {
        logger.Info("running finalizer cleanup for MyApp", "name", app.Name)
        // Perform any out-of-cluster cleanup here before deletion proceeds.

        controllerutil.RemoveFinalizer(app, myAppFinalizer)
        if err := r.Update(ctx, app); err != nil {
            return ctrl.Result{}, fmt.Errorf("removing finalizer: %w", err)
        }
    }

    return ctrl.Result{}, nil
}
```

### Reconciling Child Resources with CreateOrUpdate

`controllerutil.CreateOrUpdate` is idempotent: it creates the resource if absent, or updates it if present, using the provided mutate function.

```go
func (r *MyAppReconciler) reconcileDeployment(
    ctx context.Context,
    app *apiv1alpha1.MyApp,
) (*appsv1.Deployment, error) {
    deploy := &appsv1.Deployment{
        ObjectMeta: metav1.ObjectMeta{
            Name:      app.Name,
            Namespace: app.Namespace,
        },
    }

    op, err := controllerutil.CreateOrUpdate(ctx, r.Client, deploy, func() error {
        if err := controllerutil.SetControllerReference(app, deploy, r.Scheme); err != nil {
            return err
        }

        labels := map[string]string{
            "app.kubernetes.io/name":       app.Name,
            "app.kubernetes.io/managed-by": "myoperator",
        }

        replicas := app.Spec.Replicas
        deploy.Spec = appsv1.DeploymentSpec{
            Replicas: &replicas,
            Selector: &metav1.LabelSelector{MatchLabels: labels},
            Template: corev1.PodTemplateSpec{
                ObjectMeta: metav1.ObjectMeta{Labels: labels},
                Spec: corev1.PodSpec{
                    Containers: []corev1.Container{
                        {
                            Name:      "app",
                            Image:     app.Spec.Image,
                            Resources: app.Spec.Resources,
                            EnvFrom: []corev1.EnvFromSource{
                                {
                                    ConfigMapRef: &corev1.ConfigMapEnvSource{
                                        LocalObjectReference: corev1.LocalObjectReference{
                                            Name: app.Name + "-config",
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        }
        return nil
    })

    if err != nil {
        return nil, err
    }

    log.FromContext(ctx).V(1).Info("deployment reconciled", "operation", op)
    return deploy, nil
}

func (r *MyAppReconciler) reconcileConfigMap(
    ctx context.Context,
    app *apiv1alpha1.MyApp,
) error {
    cm := &corev1.ConfigMap{
        ObjectMeta: metav1.ObjectMeta{
            Name:      app.Name + "-config",
            Namespace: app.Namespace,
        },
    }

    _, err := controllerutil.CreateOrUpdate(ctx, r.Client, cm, func() error {
        if err := controllerutil.SetControllerReference(app, cm, r.Scheme); err != nil {
            return err
        }
        cm.Data = app.Spec.Config
        return nil
    })
    return err
}

func (r *MyAppReconciler) reconcileService(
    ctx context.Context,
    app *apiv1alpha1.MyApp,
) error {
    svc := &corev1.Service{
        ObjectMeta: metav1.ObjectMeta{
            Name:      app.Name,
            Namespace: app.Namespace,
        },
    }

    _, err := controllerutil.CreateOrUpdate(ctx, r.Client, svc, func() error {
        if err := controllerutil.SetControllerReference(app, svc, r.Scheme); err != nil {
            return err
        }
        svc.Spec = corev1.ServiceSpec{
            Selector: map[string]string{
                "app.kubernetes.io/name": app.Name,
            },
            Ports: []corev1.ServicePort{
                {Port: 80, Protocol: corev1.ProtocolTCP},
            },
        }
        return nil
    })
    return err
}
```

---

## Idempotency and Requeue Strategies

Every reconciler must handle being called multiple times for the same desired state without producing side effects.

### Requeue Return Values

| Return value | When to use |
|---|---|
| `ctrl.Result{}` | Reconciliation complete; no requeue needed |
| `ctrl.Result{RequeueAfter: 30*time.Second}` | Waiting for an external condition to be met |
| `ctrl.Result{Requeue: true}` | Immediate requeue without error; use sparingly |
| `ctrl.Result{}, err` (non-nil) | Transient error; exponential backoff requeue |

Returning a non-nil error triggers exponential backoff in the controller work queue. For permanent errors (invalid image reference, invalid resource name), set a `Degraded` condition and return `ctrl.Result{}, nil` to prevent noisy infinite retries.

### Conflict Handling

```go
if errors.IsConflict(err) {
    logger.V(1).Info("conflict on update, requeueing")
    return ctrl.Result{Requeue: true}, nil
}
```

The API server uses optimistic locking. When two goroutines update the same object concurrently, one receives a `Conflict` error. Requeue without logging at error level; the reconciler will re-run with fresh state.

### Avoiding Status Update Loops

Always update status via the `/status` subresource (not `r.Update`) so the change does not increment `.metadata.generation`. Combined with `GenerationChangedPredicate`, this prevents the reconciler from triggering on its own status writes.

```go
// Correct: only updates /status subresource; does not increment generation.
r.Status().Update(ctx, app)

// Wrong: updates the whole object; increments generation; triggers another reconcile.
r.Update(ctx, app) // when only status changed
```

---

## Event Filtering with Predicates

Without filtering, every API watch event triggers a reconcile. Predicates reduce noise and improve controller throughput significantly in large clusters.

### GenerationChangedPredicate

`GenerationChangedPredicate` filters Update events to those that increment `.metadata.generation`. Since generation only increments when `spec` changes (not when `status` is updated), this is the most important predicate for any operator that writes to `.status`.

```go
ctrl.NewControllerManagedBy(mgr).
    For(&apiv1alpha1.MyApp{},
        builder.WithPredicates(predicate.GenerationChangedPredicate{}),
    )
```

### LabelChangedPredicate

Triggers on label changes. Useful when the reconciler reacts to label updates that do not touch generation.

```go
ctrl.NewControllerManagedBy(mgr).
    For(&corev1.Node{},
        builder.WithPredicates(predicate.LabelChangedPredicate{}),
    )
```

### ResourceVersionChangedPredicate

Triggers on any mutation. Appropriate for watching external resources where any change is relevant.

### Custom Predicate

When built-in predicates do not cover the use case, implement the `predicate.Predicate` interface:

```go
type annotationChangedPredicate struct {
    predicate.Funcs
    key string
}

func (p annotationChangedPredicate) Update(e event.UpdateEvent) bool {
    oldVal := e.ObjectOld.GetAnnotations()[p.key]
    newVal := e.ObjectNew.GetAnnotations()[p.key]
    return oldVal != newVal
}

// Usage:
builder.WithPredicates(annotationChangedPredicate{
    key: "myoperator.example.com/config-version",
})
```

### Combining Predicates

```go
builder.WithPredicates(
    predicate.And(
        predicate.GenerationChangedPredicate{},
        predicate.Not(predicate.LabelChangedPredicate{}),
    ),
)
```

---

## Owner References and Garbage Collection

When a controller creates child resources, setting an owner reference on each child ensures Kubernetes garbage-collects them when the parent is deleted. This eliminates orphaned ConfigMaps, Services, and Deployments.

### Setting Owner References

`controllerutil.SetControllerReference` is the standard helper. It sets `ownerReferences` with `controller: true` and `blockOwnerDeletion: true`:

```go
if err := controllerutil.SetControllerReference(parent, child, r.Scheme); err != nil {
    return fmt.Errorf("setting owner reference: %w", err)
}
```

When the parent is deleted with default cascading behavior, Kubernetes garbage-collects all children through the ownerReference chain.

### Cross-Namespace Owner References

Kubernetes does not support cross-namespace owner references. When a cluster-scoped resource manages namespace-scoped children, use a finalizer on the parent and perform explicit cleanup:

```go
func (r *ClusterScopeReconciler) reconcileDelete(
    ctx context.Context,
    parent *apiv1alpha1.ClusterApp,
) (ctrl.Result, error) {
    if !controllerutil.ContainsFinalizer(parent, clusterFinalizer) {
        return ctrl.Result{}, nil
    }

    // List all children by label selector instead of ownerReference.
    deployList := &appsv1.DeploymentList{}
    if err := r.List(ctx, deployList,
        client.MatchingLabels{"owner.myoperator/name": parent.Name},
    ); err != nil {
        return ctrl.Result{}, err
    }

    for i := range deployList.Items {
        if err := r.Delete(ctx, &deployList.Items[i]); err != nil {
            if !errors.IsNotFound(err) {
                return ctrl.Result{}, err
            }
        }
    }

    controllerutil.RemoveFinalizer(parent, clusterFinalizer)
    return ctrl.Result{}, r.Update(ctx, parent)
}
```

### Non-Cascading Deletion

For cases where children should outlive the parent, use `SetOwnerReference` (not `SetControllerReference`) with `blockOwnerDeletion: false`:

```go
controllerutil.SetOwnerReference(parent, child, r.Scheme,
    controllerutil.WithBlockOwnerDeletion(false),
)
```

---

## Leader Election for High Availability

Running multiple operator replicas without coordination leads to split-brain: two reconcilers simultaneously mutating the same resources. `controller-runtime` ships with Lease-based leader election that requires only the flags shown in the Manager setup section.

### How Lease-Based Leader Election Works

1. The elected leader acquires a `Lease` object in the operator's namespace.
2. Non-leaders wait and watch the lease. They do not run any reconcilers or serve webhooks.
3. If the leader's pod disappears, the lease expires after `LeaseDuration`. A follower acquires the lease and starts reconciling.
4. `RenewDeadline` governs how long the leader tries to renew before giving up. `RetryPeriod` governs how quickly followers retry acquisition.

### RBAC for the Lease

```yaml
# config/rbac/leader_election_role.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: myoperator-leader-election-role
  namespace: myoperator-system
rules:
- apiGroups: [""]
  resources: ["configmaps"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: ["coordination.k8s.io"]
  resources: ["leases"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: [""]
  resources: ["events"]
  verbs: ["create", "patch"]
```

### Deployment Strategy

Run two or three replicas. One is active; the others are hot standby. Failover typically completes within the `LeaseDuration` window.

```yaml
spec:
  replicas: 2
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  template:
    spec:
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchLabels:
                  app.kubernetes.io/name: myoperator
              topologyKey: kubernetes.io/hostname
```

The `podAntiAffinity` rule distributes replicas across nodes, preventing both standby pods from residing on the same node as the leader.

---

## Operator Metrics with Prometheus

`controller-runtime` registers several metrics automatically: reconcile duration histograms, work queue depth, and controller error counters. Adding domain-specific metrics follows the standard Prometheus Go client pattern.

### Registering Custom Metrics

```go
// internal/metrics/metrics.go
package metrics

import (
    "github.com/prometheus/client_golang/prometheus"
    "sigs.k8s.io/controller-runtime/pkg/metrics"
)

var (
    ReconcileTotal = prometheus.NewCounterVec(
        prometheus.CounterOpts{
            Name: "myoperator_reconcile_total",
            Help: "Total number of reconcile operations by result.",
        },
        []string{"controller", "result"},
    )

    ReconcileDuration = prometheus.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "myoperator_reconcile_duration_seconds",
            Help:    "Duration of reconcile operations in seconds.",
            Buckets: prometheus.DefBuckets,
        },
        []string{"controller"},
    )

    ManagedAppCount = prometheus.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "myoperator_managed_apps_total",
            Help: "Number of MyApp resources managed by the operator.",
        },
        []string{"namespace"},
    )

    ReadyAppCount = prometheus.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "myoperator_ready_apps_total",
            Help: "Number of MyApp resources with all replicas ready.",
        },
        []string{"namespace"},
    )
)

func init() {
    metrics.Registry.MustRegister(
        ReconcileTotal,
        ReconcileDuration,
        ManagedAppCount,
        ReadyAppCount,
    )
}
```

### Updating Gauge Metrics

Update aggregate gauges at the end of each successful reconcile to reflect current cluster state:

```go
func (r *MyAppReconciler) updateGauges(ctx context.Context) {
    appList := &apiv1alpha1.MyAppList{}
    if err := r.List(ctx, appList); err != nil {
        return
    }

    counts := map[string]float64{}
    readyCounts := map[string]float64{}

    for _, app := range appList.Items {
        ns := app.Namespace
        counts[ns]++
        if app.Status.ReadyReplicas >= app.Spec.Replicas && app.Spec.Replicas > 0 {
            readyCounts[ns]++
        }
    }

    opmetrics.ManagedAppCount.Reset()
    opmetrics.ReadyAppCount.Reset()
    for ns, c := range counts {
        opmetrics.ManagedAppCount.WithLabelValues(ns).Set(c)
        opmetrics.ReadyAppCount.WithLabelValues(ns).Set(readyCounts[ns])
    }
}
```

### Prometheus ServiceMonitor

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: myoperator-metrics
  namespace: myoperator-system
  labels:
    app.kubernetes.io/name: myoperator
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: myoperator
  endpoints:
  - port: metrics
    interval: 30s
    path: /metrics
    honorLabels: true
```

### Useful Prometheus Alert Rules

```yaml
groups:
- name: myoperator
  rules:
  - alert: MyOperatorReconcileErrors
    expr: |
      rate(myoperator_reconcile_total{result="error"}[5m]) > 0.1
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "MyOperator is experiencing reconcile errors"
      description: "Error rate {{ $value | humanize }} errors/sec"

  - alert: MyOperatorManagedAppsUnhealthy
    expr: |
      (myoperator_managed_apps_total - myoperator_ready_apps_total) > 0
    for: 15m
    labels:
      severity: critical
    annotations:
      summary: "MyApp instances are not ready"
      description: "{{ $value }} MyApp instances are not fully ready"
```

---

## End-to-End Testing with envtest

`controller-runtime/pkg/envtest` starts a local control plane (etcd + kube-apiserver) without a kubelet, making it ideal for integration-testing reconcilers without a full cluster.

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
    "k8s.io/client-go/rest"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/envtest"
    logf "sigs.k8s.io/controller-runtime/pkg/log"
    "sigs.k8s.io/controller-runtime/pkg/log/zap"
    "sigs.k8s.io/controller-runtime/pkg/metrics/server"

    apiv1alpha1 "github.com/example/myoperator/api/v1alpha1"
    "github.com/example/myoperator/internal/controller"
)

var (
    cfg       *rest.Config
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

    ctx, cancel = context.WithCancel(context.Background())

    testEnv = &envtest.Environment{
        CRDDirectoryPaths: []string{
            filepath.Join("..", "..", "config", "crd", "bases"),
        },
        ErrorIfCRDPathMissing: true,
    }

    var err error
    cfg, err = testEnv.Start()
    Expect(err).NotTo(HaveOccurred())

    scheme := runtime.NewScheme()
    Expect(apiv1alpha1.AddToScheme(scheme)).To(Succeed())
    Expect(clientgoscheme.AddToScheme(scheme)).To(Succeed())

    k8sClient, err = client.New(cfg, client.Options{Scheme: scheme})
    Expect(err).NotTo(HaveOccurred())

    mgr, err := ctrl.NewManager(cfg, ctrl.Options{
        Scheme:  scheme,
        Metrics: server.Options{BindAddress: "0"},
    })
    Expect(err).NotTo(HaveOccurred())

    err = (&controller.MyAppReconciler{
        Client:   mgr.GetClient(),
        Scheme:   mgr.GetScheme(),
        Recorder: mgr.GetEventRecorderFor("myapp-controller"),
    }).SetupWithManager(mgr)
    Expect(err).NotTo(HaveOccurred())

    go func() {
        defer GinkgoRecover()
        Expect(mgr.Start(ctx)).To(Succeed())
    }()
})

var _ = AfterSuite(func() {
    cancel()
    Expect(testEnv.Stop()).To(Succeed())
})
```

### Controller Tests

```go
// internal/controller/myapp_controller_test.go
package controller_test

import (
    "time"

    . "github.com/onsi/ginkgo/v2"
    . "github.com/onsi/gomega"

    appsv1 "k8s.io/api/apps/v1"
    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/api/resource"
    "k8s.io/apimachinery/pkg/api/errors"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/types"
    "sigs.k8s.io/controller-runtime/pkg/client"

    apiv1alpha1 "github.com/example/myoperator/api/v1alpha1"
)

const (
    timeout  = 30 * time.Second
    interval = 500 * time.Millisecond
)

var _ = Describe("MyApp Controller", func() {
    Context("When creating a MyApp", func() {
        var (
            app       *apiv1alpha1.MyApp
            namespace *corev1.Namespace
        )

        BeforeEach(func() {
            namespace = &corev1.Namespace{
                ObjectMeta: metav1.ObjectMeta{GenerateName: "test-"},
            }
            Expect(k8sClient.Create(ctx, namespace)).To(Succeed())

            app = &apiv1alpha1.MyApp{
                ObjectMeta: metav1.ObjectMeta{
                    Name:      "test-app",
                    Namespace: namespace.Name,
                },
                Spec: apiv1alpha1.MyAppSpec{
                    Replicas: 2,
                    Image:    "nginx:1.25",
                    Resources: corev1.ResourceRequirements{
                        Requests: corev1.ResourceList{
                            corev1.ResourceCPU:    resource.MustParse("100m"),
                            corev1.ResourceMemory: resource.MustParse("128Mi"),
                        },
                    },
                    Config: map[string]string{
                        "LOG_LEVEL": "info",
                    },
                },
            }
            Expect(k8sClient.Create(ctx, app)).To(Succeed())
        })

        AfterEach(func() {
            // Delete with foreground to let finalizers run.
            Expect(k8sClient.Delete(ctx, app)).To(Succeed())
            Expect(k8sClient.Delete(ctx, namespace)).To(Succeed())
        })

        It("should create a Deployment owned by the MyApp", func() {
            deploy := &appsv1.Deployment{}
            Eventually(func() error {
                return k8sClient.Get(ctx, types.NamespacedName{
                    Name:      app.Name,
                    Namespace: app.Namespace,
                }, deploy)
            }, timeout, interval).Should(Succeed())

            Expect(*deploy.Spec.Replicas).To(Equal(int32(2)))
            Expect(deploy.Spec.Template.Spec.Containers[0].Image).To(Equal("nginx:1.25"))
            Expect(deploy.OwnerReferences).To(HaveLen(1))
            Expect(deploy.OwnerReferences[0].Name).To(Equal(app.Name))
            Expect(*deploy.OwnerReferences[0].Controller).To(BeTrue())
        })

        It("should create a ConfigMap with the specified config data", func() {
            cm := &corev1.ConfigMap{}
            Eventually(func() error {
                return k8sClient.Get(ctx, types.NamespacedName{
                    Name:      app.Name + "-config",
                    Namespace: app.Namespace,
                }, cm)
            }, timeout, interval).Should(Succeed())

            Expect(cm.Data).To(HaveKeyWithValue("LOG_LEVEL", "info"))
        })

        It("should set a Progressing condition initially", func() {
            Eventually(func(g Gomega) {
                updated := &apiv1alpha1.MyApp{}
                g.Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(app), updated)).To(Succeed())
                cond := findCondition(updated.Status.Conditions, "Progressing")
                g.Expect(cond).NotTo(BeNil())
            }, timeout, interval).Should(Succeed())
        })

        It("should delete child resources when the MyApp is deleted", func() {
            // Wait for deployment to appear.
            deploy := &appsv1.Deployment{}
            Eventually(func() error {
                return k8sClient.Get(ctx, types.NamespacedName{
                    Name: app.Name, Namespace: app.Namespace,
                }, deploy)
            }, timeout, interval).Should(Succeed())

            Expect(k8sClient.Delete(ctx, app)).To(Succeed())

            Eventually(func() bool {
                err := k8sClient.Get(ctx, types.NamespacedName{
                    Name: app.Name, Namespace: app.Namespace,
                }, &appsv1.Deployment{})
                return errors.IsNotFound(err)
            }, timeout, interval).Should(BeTrue(), "Deployment should be garbage collected")
        })

        It("should update Deployment replicas when spec changes", func() {
            Eventually(func() error {
                return k8sClient.Get(ctx, types.NamespacedName{
                    Name: app.Name, Namespace: app.Namespace,
                }, &appsv1.Deployment{})
            }, timeout, interval).Should(Succeed())

            patch := client.MergeFrom(app.DeepCopy())
            app.Spec.Replicas = 5
            Expect(k8sClient.Patch(ctx, app, patch)).To(Succeed())

            Eventually(func(g Gomega) {
                deploy := &appsv1.Deployment{}
                g.Expect(k8sClient.Get(ctx, types.NamespacedName{
                    Name: app.Name, Namespace: app.Namespace,
                }, deploy)).To(Succeed())
                g.Expect(*deploy.Spec.Replicas).To(Equal(int32(5)))
            }, timeout, interval).Should(Succeed())
        })
    })
})

func findCondition(conditions []metav1.Condition, condType string) *metav1.Condition {
    for i := range conditions {
        if conditions[i].Type == condType {
            return &conditions[i]
        }
    }
    return nil
}
```

### Running Tests with Binary Setup

envtest requires the kube-apiserver and etcd binaries. The `setup-envtest` tool downloads the correct version:

```bash
go install sigs.k8s.io/controller-runtime/tools/setup-envtest@latest

# Download binaries for Kubernetes 1.31.
export KUBEBUILDER_ASSETS=$(setup-envtest use 1.31.0 \
    --bin-dir /tmp/envtest-bins -p path)

# Run tests.
go test ./internal/controller/... -v -count=1 -timeout 120s
```

Add to the project Makefile:

```makefile
ENVTEST_K8S_VERSION ?= 1.31.0
ENVTEST_ASSETS_DIR ?= $(shell pwd)/bin/envtest

.PHONY: test
test: envtest
	KUBEBUILDER_ASSETS="$(shell $(ENVTEST) use $(ENVTEST_K8S_VERSION) \
	    --bin-dir $(ENVTEST_ASSETS_DIR) -p path)" \
	go test ./... -coverprofile cover.out

.PHONY: envtest
envtest:
	GOBIN=$(shell pwd)/bin go install \
	    sigs.k8s.io/controller-runtime/tools/setup-envtest@latest
```

---

## API Versioning and Conversion Webhooks

Production operators inevitably evolve their API. The recommended path is `v1alpha1` -> `v1beta1` -> `v1`. Kubernetes stores only one version in etcd (the storage version) and converts between versions at request time using a conversion webhook.

### Hub-and-Spoke Conversion

controller-runtime uses the hub-and-spoke model. One version is designated the hub; all other versions convert to and from it.

```go
// api/v1beta1/myapp_conversion.go
// Hub marks v1beta1 as the conversion hub.
// No methods are required; the interface is satisfied by this marker.
package v1beta1

func (*MyApp) Hub() {}
```

```go
// api/v1alpha1/myapp_conversion.go
package v1alpha1

import (
    "fmt"
    "sigs.k8s.io/controller-runtime/pkg/conversion"
    apiv1beta1 "github.com/example/myoperator/api/v1beta1"
)

// ConvertTo converts v1alpha1 to the hub version (v1beta1).
func (src *MyApp) ConvertTo(dstRaw conversion.Hub) error {
    dst, ok := dstRaw.(*apiv1beta1.MyApp)
    if !ok {
        return fmt.Errorf("unexpected hub type %T", dstRaw)
    }

    dst.ObjectMeta = src.ObjectMeta

    // Direct field mappings.
    dst.Spec.Replicas = src.Spec.Replicas
    dst.Spec.Image = src.Spec.Image
    dst.Spec.Resources = src.Spec.Resources
    dst.Spec.StorageClass = src.Spec.StorageClass
    dst.Spec.DatabaseRef = src.Spec.DatabaseRef

    // v1beta1 renamed Config -> AppConfig.
    dst.Spec.AppConfig = src.Spec.Config

    // Status passthrough.
    dst.Status.ObservedGeneration = src.Status.ObservedGeneration
    dst.Status.ReadyReplicas = src.Status.ReadyReplicas
    dst.Status.Conditions = src.Status.Conditions

    return nil
}

// ConvertFrom converts from the hub version (v1beta1) back to v1alpha1.
func (dst *MyApp) ConvertFrom(srcRaw conversion.Hub) error {
    src, ok := srcRaw.(*apiv1beta1.MyApp)
    if !ok {
        return fmt.Errorf("unexpected hub type %T", srcRaw)
    }

    dst.ObjectMeta = src.ObjectMeta

    dst.Spec.Replicas = src.Spec.Replicas
    dst.Spec.Image = src.Spec.Image
    dst.Spec.Resources = src.Spec.Resources
    dst.Spec.StorageClass = src.Spec.StorageClass
    dst.Spec.DatabaseRef = src.Spec.DatabaseRef

    // v1alpha1 uses Config, not AppConfig.
    dst.Spec.Config = src.Spec.AppConfig

    dst.Status.ObservedGeneration = src.Status.ObservedGeneration
    dst.Status.ReadyReplicas = src.Status.ReadyReplicas
    dst.Status.Conditions = src.Status.Conditions

    return nil
}
```

### Testing Conversion Round-Trips

```go
// api/v1alpha1/myapp_conversion_test.go
package v1alpha1_test

import (
    "testing"

    "github.com/google/go-cmp/cmp"
    apiv1alpha1 "github.com/example/myoperator/api/v1alpha1"
    apiv1beta1 "github.com/example/myoperator/api/v1beta1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestConversionRoundTrip(t *testing.T) {
    original := &apiv1alpha1.MyApp{
        ObjectMeta: metav1.ObjectMeta{Name: "test", Namespace: "default"},
        Spec: apiv1alpha1.MyAppSpec{
            Replicas: 3,
            Image:    "nginx:1.25",
            Config:   map[string]string{"key": "value"},
        },
    }

    hub := &apiv1beta1.MyApp{}
    if err := original.ConvertTo(hub); err != nil {
        t.Fatalf("ConvertTo failed: %v", err)
    }

    restored := &apiv1alpha1.MyApp{}
    if err := restored.ConvertFrom(hub); err != nil {
        t.Fatalf("ConvertFrom failed: %v", err)
    }

    if diff := cmp.Diff(original.Spec, restored.Spec); diff != "" {
        t.Errorf("Spec mismatch after round-trip (-original +restored):\n%s", diff)
    }
}
```

### Webhook Certificate Management

The conversion webhook requires TLS. cert-manager automates certificate provisioning:

```yaml
apiVersion: cert-manager.io/v1
kind: Issuer
metadata:
  name: myoperator-selfsigned-issuer
  namespace: myoperator-system
spec:
  selfSigned: {}
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: myoperator-serving-cert
  namespace: myoperator-system
spec:
  dnsNames:
  - myoperator-webhook-service.myoperator-system.svc
  - myoperator-webhook-service.myoperator-system.svc.cluster.local
  issuerRef:
    kind: Issuer
    name: myoperator-selfsigned-issuer
  secretName: myoperator-webhook-server-cert
---
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingWebhookConfiguration
metadata:
  name: myoperator-validating-webhook
  annotations:
    cert-manager.io/inject-ca-from: myoperator-system/myoperator-serving-cert
spec:
  webhooks:
  - name: vmyapp.kb.io
    clientConfig:
      service:
        name: myoperator-webhook-service
        namespace: myoperator-system
        path: /validate-apps-example-com-v1alpha1-myapp
    rules:
    - apiGroups: ["apps.example.com"]
      apiVersions: ["v1alpha1", "v1beta1"]
      operations: ["CREATE", "UPDATE"]
      resources: ["myapps"]
    admissionReviewVersions: ["v1"]
    sideEffects: None
    failurePolicy: Fail
```

### Validating Webhook

Implement structural validation that CRD markers cannot express:

```go
// api/v1alpha1/myapp_webhook.go
package v1alpha1

import (
    "fmt"
    "k8s.io/apimachinery/pkg/runtime"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/webhook/admission"
)

func (r *MyApp) SetupWebhookWithManager(mgr ctrl.Manager) error {
    return ctrl.NewWebhookManagedBy(mgr).For(r).Complete()
}

func (r *MyApp) ValidateCreate() (admission.Warnings, error) {
    return nil, r.validateMyApp()
}

func (r *MyApp) ValidateUpdate(old runtime.Object) (admission.Warnings, error) {
    return nil, r.validateMyApp()
}

func (r *MyApp) ValidateDelete() (admission.Warnings, error) {
    return nil, nil
}

func (r *MyApp) validateMyApp() error {
    if r.Spec.Replicas > 0 && r.Spec.Image == "" {
        return fmt.Errorf("spec.image is required when spec.replicas > 0")
    }
    if r.Spec.StorageClass != nil && *r.Spec.StorageClass == "" {
        return fmt.Errorf("spec.storageClass must not be empty when provided")
    }
    return nil
}
```

---

## Operator Release Lifecycle and OLM Packaging

The Operator Lifecycle Manager (OLM) manages operator installation, upgrades, and dependency resolution. Publishing to OperatorHub requires a bundle that contains the CRD, CSV, and metadata.

### Bundle Structure

```
bundle/
  manifests/
    myoperator.clusterserviceversion.yaml
    myapp.apps.example.com.crd.yaml
  metadata/
    annotations.yaml
  tests/
    scorecard/
      config.yaml
```

### ClusterServiceVersion

The CSV is the primary OLM artifact. It describes the operator, owned/required CRDs, RBAC, deployment, and upgrade strategy.

```yaml
apiVersion: operators.coreos.com/v1alpha1
kind: ClusterServiceVersion
metadata:
  name: myoperator.v0.2.0
  namespace: myoperator-system
  annotations:
    alm-examples: |
      [
        {
          "apiVersion": "apps.example.com/v1beta1",
          "kind": "MyApp",
          "metadata": {"name": "example"},
          "spec": {"replicas": 1, "image": "nginx:1.25"}
        }
      ]
    capabilities: "Deep Insights"
    categories: "Application Runtime"
    description: "Manages the MyApp workload lifecycle."
spec:
  displayName: MyOperator
  description: |
    MyOperator automates deployment, scaling, and upgrades of MyApp workloads
    on Kubernetes.
  version: 0.2.0
  replaces: myoperator.v0.1.0

  customresourcedefinitions:
    owned:
    - kind: MyApp
      name: myapps.apps.example.com
      version: v1beta1
      displayName: MyApp
      description: Represents a managed application workload.

  install:
    strategy: deployment
    spec:
      clusterPermissions:
      - serviceAccountName: myoperator-controller-manager
        rules:
        - apiGroups: ["apps.example.com"]
          resources: ["myapps", "myapps/status", "myapps/finalizers"]
          verbs: ["*"]
        - apiGroups: ["apps"]
          resources: ["deployments"]
          verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
        - apiGroups: [""]
          resources: ["services", "configmaps", "events"]
          verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
        - apiGroups: ["coordination.k8s.io"]
          resources: ["leases"]
          verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
      deployments:
      - name: myoperator-controller-manager
        spec:
          replicas: 2
          selector:
            matchLabels:
              app.kubernetes.io/name: myoperator
          template:
            metadata:
              labels:
                app.kubernetes.io/name: myoperator
            spec:
              serviceAccountName: myoperator-controller-manager
              containers:
              - name: manager
                image: ghcr.io/example/myoperator:v0.2.0
                args:
                - --leader-elect
                - --metrics-bind-address=:8080
                - --health-probe-bind-address=:8081
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
                  limits:
                    cpu: 500m
                    memory: 128Mi
                  requests:
                    cpu: 10m
                    memory: 64Mi

  installModes:
  - type: OwnNamespace
    supported: true
  - type: SingleNamespace
    supported: true
  - type: MultiNamespace
    supported: false
  - type: AllNamespaces
    supported: true

  upgradeStrategy: Default
```

### Building and Validating the Bundle

```bash
# Generate bundle from CSV and CRDs.
operator-sdk generate bundle \
    --version 0.2.0 \
    --channels stable \
    --default-channel stable \
    --input-dir config/manifests

# Validate bundle structure and basic correctness.
operator-sdk bundle validate bundle/

# Run scorecard tests.
operator-sdk scorecard bundle/ \
    --kubeconfig ~/.kube/config \
    --namespace myoperator-system \
    --wait-time 90s
```

### File-Based Catalog (FBC) Publishing

```bash
# Build and push the bundle image.
docker build -f bundle.Dockerfile -t ghcr.io/example/myoperator-bundle:v0.2.0 .
docker push ghcr.io/example/myoperator-bundle:v0.2.0

# Render the bundle into a file-based catalog.
opm render ghcr.io/example/myoperator-bundle:v0.2.0 \
    --output yaml >> catalog/myoperator/catalog.yaml

# Build and push the catalog image.
opm generate dockerfile catalog/
docker build -f catalog.Dockerfile -t ghcr.io/example/myoperator-catalog:latest .
docker push ghcr.io/example/myoperator-catalog:latest
```

### CatalogSource

```yaml
apiVersion: operators.coreos.com/v1alpha1
kind: CatalogSource
metadata:
  name: myoperator-catalog
  namespace: olm
spec:
  sourceType: grpc
  image: ghcr.io/example/myoperator-catalog:latest
  displayName: MyOperator Catalog
  publisher: Example Inc
  updateStrategy:
    registryPoll:
      interval: 10m
```

---

## Advanced Patterns

### Field Indexers for Efficient Queries

When querying resources by fields other than namespace/name, register a field index to avoid full cache scans:

```go
// Register index in SetupWithManager or main.go before starting the manager.
if err := mgr.GetFieldIndexer().IndexField(
    ctx,
    &appsv1.Deployment{},
    ".spec.template.spec.containers[0].image",
    func(obj client.Object) []string {
        deploy := obj.(*appsv1.Deployment)
        if len(deploy.Spec.Template.Spec.Containers) == 0 {
            return nil
        }
        return []string{deploy.Spec.Template.Spec.Containers[0].Image}
    },
); err != nil {
    return err
}

// Later, query by the indexed field:
deployList := &appsv1.DeploymentList{}
if err := r.List(ctx, deployList,
    client.MatchingFields{
        ".spec.template.spec.containers[0].image": "nginx:1.25",
    },
); err != nil {
    return ctrl.Result{}, err
}
```

### Watching External Resources with Mapper Functions

When the operator needs to react to resources it does not own, use a mapper to translate watch events into reconcile requests:

```go
ctrl.NewControllerManagedBy(mgr).
    For(&apiv1alpha1.MyApp{}).
    Watches(
        &corev1.Secret{},
        handler.EnqueueRequestsFromMapFunc(
            func(ctx context.Context, obj client.Object) []reconcile.Request {
                secret := obj.(*corev1.Secret)
                appList := &apiv1alpha1.MyAppList{}
                if err := mgr.GetClient().List(ctx, appList,
                    client.InNamespace(secret.Namespace),
                    client.MatchingLabels{
                        "myoperator.example.com/secret-ref": secret.Name,
                    },
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
            },
        ),
    ).
    Complete(r)
```

### Rate Limiting

The default work queue uses exponential backoff with jitter. For operators managing large resource counts, configure per-item rate limiting:

```go
import (
    "golang.org/x/time/rate"
    "k8s.io/client-go/util/workqueue"
)

func (r *MyAppReconciler) SetupWithManager(mgr ctrl.Manager) error {
    return ctrl.NewControllerManagedBy(mgr).
        For(&apiv1alpha1.MyApp{}).
        WithOptions(controller.Options{
            RateLimiter: workqueue.NewTypedItemExponentialFailureRateLimiter[reconcile.Request](
                5*time.Millisecond,
                1000*time.Second,
            ),
            MaxConcurrentReconciles: 10,
        }).
        Complete(r)
}
```

---

## Production Readiness Checklist

Before promoting an operator to production, verify the following across four domains.

### API Stability

- All CRD fields carry appropriate validation markers.
- Required fields are non-pointer types without `omitempty`, or carry `+kubebuilder:validation:Required`.
- The storage version is set with `// +kubebuilder:storageversion`.
- Deprecated fields are annotated with `// Deprecated:` and kept for at least one minor version.
- `+kubebuilder:printcolumn` directives provide useful `kubectl get` output.

### Reconciler Correctness

- `GenerationChangedPredicate` prevents reconcile loops triggered by the operator's own status writes.
- Status writes use `r.Status().Update()`, never `r.Update()` when only status changed.
- `ObservedGeneration` is set in status after each successful reconcile.
- Permanent errors (invalid spec) do not trigger backoff retries.
- Conflict errors are handled by requeueing, not logging at error level.
- All owned child resources have owner references set via `SetControllerReference`.

### Operational Readiness

- Leader election is enabled with at least two replicas distributed across nodes.
- Health and readiness probes are configured on the operator pod.
- Prometheus metrics cover reconcile count, duration, error rate, and managed resource count.
- Events are emitted via `record.EventRecorder` for significant state transitions.
- Resource requests and limits are set on the operator container.
- The operator handles SIGTERM gracefully and releases the leader lease on shutdown.

### Testing and Release

- envtest suite covers create, update, delete, and error injection scenarios.
- Conversion functions have round-trip tests for each version pair.
- Webhook validation tests cover both valid and invalid inputs.
- `operator-sdk bundle validate` passes with zero errors.
- The CSV `replaces` field chains upgrade paths without gaps.
- The container image is signed and an SBOM is published with each release.

---

## Summary

Kubernetes operators shift operational complexity from runbooks into code, making workload lifecycle management reproducible and auditable. The patterns covered here — purposeful CRD API design with `metav1.Condition`, idempotent reconcile loops built on `CreateOrUpdate`, event-driven predicates, owner-reference-based garbage collection, HA leader election, and comprehensive envtest coverage — form the foundation of a production-grade operator.

The key engineering discipline is restraint: model only what the platform needs to know in the CRD, write reconcilers that converge toward desired state without side effects, and invest in conversion webhooks early so API evolution does not become a breaking migration. Operators packaged for OLM gain cluster-level lifecycle management, dependency resolution, and structured upgrade paths that make them first-class additions to any Kubernetes platform.

Building these capabilities incrementally, validating each layer with envtest, and publishing clear status conditions gives platform consumers a reliable contract: declare intent, observe status, and trust that the operator will close the gap between the two.
