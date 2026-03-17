---
title: "Kubernetes Operator Patterns: Status Conditions and Phase Management"
date: 2029-11-20T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Operators", "Go", "controller-runtime", "Custom Resources"]
categories: ["Kubernetes", "Go"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Kubernetes operator status management: condition types (True/False/Unknown), condition reason and message standards, phase enum design, Ready condition aggregation, and production-ready status patterns."
more_link: "yes"
url: "/kubernetes-operator-patterns-status-conditions-phase-management/"
---

Building a Kubernetes operator involves more than just reconciling resources. One of the most impactful — and most often poorly implemented — aspects of operator quality is the status subresource. Well-designed status conditions tell operators, monitoring systems, and human administrators exactly what state a resource is in, why it reached that state, and what action (if any) is needed. This guide covers the Kubernetes condition model in depth, phase enum design, Ready condition aggregation patterns, and the Go implementation patterns that make status management maintainable at scale.

<!--more-->

# Kubernetes Operator Patterns: Status Conditions and Phase Management

## Why Status Design Matters

Status conditions are the primary communication channel between your operator and the broader Kubernetes ecosystem. kubectl uses them in `kubectl describe`. GitOps tools watch them for deployment progress. Horizontal Pod Autoscaler integrations read custom metrics from them. Poorly designed status leads to operators that are difficult to debug, impossible to monitor, and frustrating to use.

The Kubernetes API machinery has established conventions for status conditions through the API conventions documentation and through the patterns established by core resources (Pod, Node, Deployment). Following these conventions makes your CRD feel native to Kubernetes and integrate seamlessly with existing tooling.

## The Condition Model

### Condition Structure

Every Kubernetes condition follows the same structure, defined in `k8s.io/apimachinery/pkg/apis/meta/v1`:

```go
// From k8s.io/apimachinery/pkg/apis/meta/v1
type Condition struct {
    // Type is the type of the condition.
    // Must be unique within the resource's conditions list.
    Type string `json:"type"`

    // Status is the status of the condition.
    // Can be True, False, or Unknown.
    Status ConditionStatus `json:"status"`

    // ObservedGeneration is the .metadata.generation that the condition was
    // set based on. If this is empty, the condition may be stale.
    ObservedGeneration int64 `json:"observedGeneration,omitempty"`

    // LastTransitionTime is the last time the condition transitioned from
    // one status to another. Updated only when the Status changes.
    LastTransitionTime Time `json:"lastTransitionTime"`

    // Reason contains a programmatic identifier indicating the reason for
    // the condition's last transition.
    // Must be CamelCase, no spaces, max 1024 characters.
    Reason string `json:"reason"`

    // Message is a human readable message indicating details about the
    // transition. Max 32768 characters.
    Message string `json:"message"`
}

type ConditionStatus string

const (
    ConditionTrue    ConditionStatus = "True"
    ConditionFalse   ConditionStatus = "False"
    ConditionUnknown ConditionStatus = "Unknown"
)
```

### The Three Statuses

**True**: The condition is satisfied / the thing described by the condition type is happening or has happened. For `Ready`, `True` means the resource is ready.

**False**: The condition is explicitly not satisfied. For `Ready`, `False` means the resource is definitively not ready, and the `Reason` and `Message` explain why.

**Unknown**: The controller cannot determine the current state. This should be used during initial reconciliation, during transitions, or when the controller has lost contact with an external system. It is not an error state — it means "I don't know yet."

### Negative vs Positive Polarity

Kubernetes conditions can be either positive or negative polarity:

- **Positive polarity (Ready, Available, Healthy)**: `True` is the good state. `False` means something is wrong. `Unknown` means transitioning.
- **Negative polarity (Degraded, Progressing, Stalled)**: `False` is the good state. `True` means something requires attention.

Mixing polarities is confusing. Establish a convention for your operator and stick to it. Many modern operators use exclusively positive polarity (`True` = good) with carefully named condition types.

## Designing Condition Types

### Core Condition Types

Most operators should implement these standard condition types:

```go
// conditions.go
package conditions

const (
    // Ready indicates the resource is fully functional and available for use.
    // This is the most important condition — controllers should set it to True
    // only when ALL other required conditions are True.
    TypeReady = "Ready"

    // Available indicates the resource is available but may not be fully ready.
    // For example, a degraded instance that is still serving traffic.
    TypeAvailable = "Available"

    // Progressing indicates the resource is actively being reconciled.
    // True = currently doing work (deployment rolling out, initialization)
    // False = not progressing (steady state or stuck)
    TypeProgressing = "Progressing"

    // Degraded indicates the resource is in a degraded state.
    // Positive polarity: False is the good state, True means something is wrong.
    // Alternative: use negative polarity and call it "Healthy" (True = healthy).
    TypeDegraded = "Degraded"

    // Reconciling indicates the operator is actively reconciling this resource.
    TypeReconciling = "Reconciling"

    // Stalled indicates the operator cannot make progress.
    TypeStalled = "Stalled"
)
```

### Domain-Specific Conditions

Beyond the core conditions, add domain-specific conditions that provide diagnostic value:

```go
// For a DatabaseCluster operator:
const (
    TypeDatabaseReady        = "DatabaseReady"
    TypeReplicationHealthy   = "ReplicationHealthy"
    TypeBackupAvailable      = "BackupAvailable"
    TypeStorageAvailable     = "StorageAvailable"
    TypeCertificateValid     = "CertificateValid"
)

// For a WebApplication operator:
const (
    TypeDeploymentReady      = "DeploymentReady"
    TypeIngressReady         = "IngressReady"
    TypeTLSReady             = "TLSReady"
    TypeHealthCheckPassing   = "HealthCheckPassing"
    TypeConfigMapSynced      = "ConfigMapSynced"
)
```

## Reason and Message Standards

### Reason Conventions

The `Reason` field is a machine-readable, CamelCase identifier for why the condition has its current status. It should be:
- **Specific enough to be actionable**: "StorageClassNotFound" not "ConfigError"
- **Terminal or transitional**: "Creating" signals progress; "StorageClassNotFound" signals a terminal error
- **Consistent across your operator**: Use the same reason across all resources

```go
// conditions/reasons.go
package conditions

// Ready condition reasons
const (
    ReasonReady                     = "Ready"
    ReasonNotReady                  = "NotReady"
    ReasonInitializing              = "Initializing"
    ReasonReconciling               = "Reconciling"
)

// Error reasons (cause Ready=False)
const (
    ReasonStorageClassNotFound      = "StorageClassNotFound"
    ReasonInsufficientResources     = "InsufficientResources"
    ReasonImagePullFailed           = "ImagePullFailed"
    ReasonCertificateExpired        = "CertificateExpired"
    ReasonDependencyNotReady        = "DependencyNotReady"
    ReasonInvalidConfiguration      = "InvalidConfiguration"
    ReasonQuotaExceeded             = "QuotaExceeded"
    ReasonNetworkPolicyDenied       = "NetworkPolicyDenied"
    ReasonWebhookFailed             = "WebhookFailed"
    ReasonTimeout                   = "Timeout"
    ReasonHealthCheckFailed         = "HealthCheckFailed"
    ReasonConnectionFailed          = "ConnectionFailed"
    ReasonPermissionDenied          = "PermissionDenied"
)

// Progressing reasons (cause Progressing=True)
const (
    ReasonCreatingResources         = "CreatingResources"
    ReasonUpdatingResources         = "UpdatingResources"
    ReasonDeletingResources         = "DeletingResources"
    ReasonWaitingForDependency      = "WaitingForDependency"
    ReasonScalingUp                 = "ScalingUp"
    ReasonScalingDown               = "ScalingDown"
    ReasonRollingUpdate             = "RollingUpdate"
    ReasonMigrating                 = "Migrating"
)
```

### Message Templates

Messages should be human-readable and include specific details that aid debugging:

```go
// Good messages — specific, actionable, include resource identifiers
"StorageClass \"fast-ssd\" not found. Create the StorageClass or update spec.storageClassName."
"Waiting for 3/5 pods to become Ready (current: payment-server-abc123, payment-server-def456 are Running)"
"Certificate \"tls-cert\" expires in 2 days. Please renew via cert-manager or manually."
"Database pod payment-db-0 failed health check: connection refused to 10.0.1.5:5432"

// Bad messages — vague, not actionable
"Error occurred"
"Resource not ready"
"Failed"
"Unknown error"
```

## Phase Enums

Phase provides a single, high-level summary of the resource's lifecycle state. Unlike conditions (which can all be true simultaneously), phase is a single value that represents the current stage.

### Phase Design Principles

1. Phases should be ordered and represent a lifecycle progression
2. Each phase should be a clearly defined, unambiguous state
3. Not every resource needs phases — use only when there is a clear lifecycle

```go
// api/v1alpha1/databasecluster_types.go
package v1alpha1

// DatabaseClusterPhase represents the lifecycle phase of a DatabaseCluster
// +kubebuilder:validation:Enum=Pending;Initializing;Running;Degraded;Scaling;Upgrading;Terminating;Failed
type DatabaseClusterPhase string

const (
    // Pending: Resource created, waiting to start provisioning.
    // Conditions: Ready=Unknown/Initializing
    PhasePending DatabaseClusterPhase = "Pending"

    // Initializing: Provisioning in progress.
    // Conditions: Ready=Unknown/Initializing, Progressing=True/CreatingResources
    PhaseInitializing DatabaseClusterPhase = "Initializing"

    // Running: Fully operational.
    // Conditions: Ready=True/Ready
    PhaseRunning DatabaseClusterPhase = "Running"

    // Degraded: Operational but not at full capacity (e.g., one replica down).
    // Conditions: Ready=False/Degraded, Available=True
    PhaseDegraded DatabaseClusterPhase = "Degraded"

    // Scaling: Scale operation in progress.
    // Conditions: Ready=False/Reconciling, Progressing=True/ScalingUp
    PhaseScaling DatabaseClusterPhase = "Scaling"

    // Upgrading: Version upgrade in progress.
    // Conditions: Ready=False/Reconciling, Progressing=True/RollingUpdate
    PhaseUpgrading DatabaseClusterPhase = "Upgrading"

    // Terminating: Deletion in progress.
    // Conditions: Ready=False/Terminating
    PhaseTerminating DatabaseClusterPhase = "Terminating"

    // Failed: Unrecoverable error, manual intervention required.
    // Conditions: Ready=False/<specific reason>, Stalled=True
    PhaseFailed DatabaseClusterPhase = "Failed"
)
```

### Status Type Definition

```go
// DatabaseClusterStatus defines the observed state of DatabaseCluster
type DatabaseClusterStatus struct {
    // Phase is a single-word summary of the current lifecycle state.
    // +optional
    Phase DatabaseClusterPhase `json:"phase,omitempty"`

    // Conditions represent the latest available observations of the resource's state.
    // +optional
    // +listType=map
    // +listMapKey=type
    // +patchStrategy=merge
    // +patchMergeKey=type
    Conditions []metav1.Condition `json:"conditions,omitempty"`

    // ObservedGeneration is the most recent generation observed by the controller.
    // It corresponds to the metadata.generation of the spec.
    // +optional
    ObservedGeneration int64 `json:"observedGeneration,omitempty"`

    // ReadyReplicas is the number of replicas that are Ready.
    // +optional
    ReadyReplicas int32 `json:"readyReplicas,omitempty"`

    // Replicas is the total number of replicas.
    // +optional
    Replicas int32 `json:"replicas,omitempty"`

    // CurrentVersion is the version currently deployed.
    // +optional
    CurrentVersion string `json:"currentVersion,omitempty"`

    // LastReconcileTime is the timestamp of the most recent reconciliation.
    // +optional
    LastReconcileTime *metav1.Time `json:"lastReconcileTime,omitempty"`
}
```

## Condition Management in Go

### The Condition Helper Library

```go
// internal/conditions/conditions.go
package conditions

import (
    "time"

    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Set sets or updates a condition in the conditions slice.
// It only updates LastTransitionTime when the Status changes.
func Set(conditions *[]metav1.Condition, condition metav1.Condition) {
    if conditions == nil {
        return
    }

    now := metav1.NewTime(time.Now())

    // Find existing condition
    for i, c := range *conditions {
        if c.Type != condition.Type {
            continue
        }

        // Don't update LastTransitionTime if Status hasn't changed
        if c.Status == condition.Status {
            condition.LastTransitionTime = c.LastTransitionTime
        } else {
            condition.LastTransitionTime = now
        }

        (*conditions)[i] = condition
        return
    }

    // Condition not found — append new condition
    if condition.LastTransitionTime.IsZero() {
        condition.LastTransitionTime = now
    }
    *conditions = append(*conditions, condition)
}

// Get returns the condition with the given type, or nil if not found.
func Get(conditions []metav1.Condition, condType string) *metav1.Condition {
    for i := range conditions {
        if conditions[i].Type == condType {
            return &conditions[i]
        }
    }
    return nil
}

// IsTrue returns true if the condition exists and has Status=True.
func IsTrue(conditions []metav1.Condition, condType string) bool {
    c := Get(conditions, condType)
    return c != nil && c.Status == metav1.ConditionTrue
}

// IsFalse returns true if the condition exists and has Status=False.
func IsFalse(conditions []metav1.Condition, condType string) bool {
    c := Get(conditions, condType)
    return c != nil && c.Status == metav1.ConditionFalse
}

// IsUnknown returns true if the condition is Unknown or does not exist.
func IsUnknown(conditions []metav1.Condition, condType string) bool {
    c := Get(conditions, condType)
    return c == nil || c.Status == metav1.ConditionUnknown
}

// Delete removes a condition of the given type.
func Delete(conditions *[]metav1.Condition, condType string) {
    filtered := make([]metav1.Condition, 0, len(*conditions))
    for _, c := range *conditions {
        if c.Type != condType {
            filtered = append(filtered, c)
        }
    }
    *conditions = filtered
}

// SetTrue is a convenience function to set a condition to True.
func SetTrue(conditions *[]metav1.Condition, generation int64,
    condType, reason, message string) {
    Set(conditions, metav1.Condition{
        Type:               condType,
        Status:             metav1.ConditionTrue,
        ObservedGeneration: generation,
        Reason:             reason,
        Message:            message,
    })
}

// SetFalse is a convenience function to set a condition to False.
func SetFalse(conditions *[]metav1.Condition, generation int64,
    condType, reason, message string) {
    Set(conditions, metav1.Condition{
        Type:               condType,
        Status:             metav1.ConditionFalse,
        ObservedGeneration: generation,
        Reason:             reason,
        Message:            message,
    })
}

// SetUnknown is a convenience function to set a condition to Unknown.
func SetUnknown(conditions *[]metav1.Condition, generation int64,
    condType, reason, message string) {
    Set(conditions, metav1.Condition{
        Type:               condType,
        Status:             metav1.ConditionUnknown,
        ObservedGeneration: generation,
        Reason:             reason,
        Message:            message,
    })
}
```

### Ready Condition Aggregation

The `Ready` condition should aggregate all other conditions. A resource is Ready only when all required sub-conditions are satisfied:

```go
// internal/conditions/aggregation.go
package conditions

import (
    "fmt"
    "strings"

    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ReadyAggregator aggregates multiple conditions into a single Ready condition.
type ReadyAggregator struct {
    // RequiredTrue: all these must be True for Ready=True
    RequiredTrue []string
    // RequiredFalse: all these must be False for Ready=True (negative polarity)
    RequiredFalse []string
}

// Aggregate computes the Ready condition from the existing conditions.
func (ra *ReadyAggregator) Aggregate(
    conditions []metav1.Condition,
    generation int64,
) metav1.Condition {
    var falseConditions []string
    var unknownConditions []string

    for _, reqType := range ra.RequiredTrue {
        c := Get(conditions, reqType)
        if c == nil {
            unknownConditions = append(unknownConditions,
                fmt.Sprintf("%s=Unknown (not set)", reqType))
            continue
        }
        switch c.Status {
        case metav1.ConditionFalse:
            falseConditions = append(falseConditions,
                fmt.Sprintf("%s=False (%s: %s)", reqType, c.Reason, c.Message))
        case metav1.ConditionUnknown:
            unknownConditions = append(unknownConditions,
                fmt.Sprintf("%s=Unknown (%s)", reqType, c.Reason))
        }
    }

    for _, reqType := range ra.RequiredFalse {
        c := Get(conditions, reqType)
        if c == nil {
            continue // Absent negative polarity condition = not triggered = good
        }
        if c.Status == metav1.ConditionTrue {
            falseConditions = append(falseConditions,
                fmt.Sprintf("%s=True (%s: %s)", reqType, c.Reason, c.Message))
        }
    }

    // Build the Ready condition
    if len(falseConditions) > 0 {
        return metav1.Condition{
            Type:               TypeReady,
            Status:             metav1.ConditionFalse,
            ObservedGeneration: generation,
            Reason:             deriveReadyReason(conditions, ra),
            Message:            fmt.Sprintf("Not ready: %s", strings.Join(falseConditions, "; ")),
        }
    }

    if len(unknownConditions) > 0 {
        return metav1.Condition{
            Type:               TypeReady,
            Status:             metav1.ConditionUnknown,
            ObservedGeneration: generation,
            Reason:             ReasonReconciling,
            Message:            fmt.Sprintf("Waiting for: %s", strings.Join(unknownConditions, "; ")),
        }
    }

    return metav1.Condition{
        Type:               TypeReady,
        Status:             metav1.ConditionTrue,
        ObservedGeneration: generation,
        Reason:             ReasonReady,
        Message:            "All components are ready",
    }
}

// deriveReadyReason returns the most appropriate reason from failing conditions.
func deriveReadyReason(conditions []metav1.Condition, ra *ReadyAggregator) string {
    // Prefer Stalled > specific error > generic NotReady
    if stalled := Get(conditions, TypeStalled); stalled != nil &&
        stalled.Status == metav1.ConditionTrue {
        return stalled.Reason
    }

    // Return reason from first failing required condition
    for _, reqType := range ra.RequiredTrue {
        c := Get(conditions, reqType)
        if c != nil && c.Status == metav1.ConditionFalse {
            return c.Reason
        }
    }

    return ReasonNotReady
}
```

## Reconciler Implementation

```go
// internal/controller/databasecluster_controller.go
package controller

import (
    "context"
    "fmt"
    "time"

    "k8s.io/apimachinery/pkg/api/errors"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/log"

    dbv1alpha1 "github.com/myorg/db-operator/api/v1alpha1"
    "github.com/myorg/db-operator/internal/conditions"
)

var readyAggregator = &conditions.ReadyAggregator{
    RequiredTrue: []string{
        conditions.TypeStorageAvailable,
        conditions.TypeDatabaseReady,
        conditions.TypeReplicationHealthy,
        conditions.TypeCertificateValid,
    },
    RequiredFalse: []string{
        conditions.TypeDegraded,
        conditions.TypeStalled,
    },
}

type DatabaseClusterReconciler struct {
    client.Client
}

func (r *DatabaseClusterReconciler) Reconcile(
    ctx context.Context,
    req ctrl.Request,
) (ctrl.Result, error) {
    log := log.FromContext(ctx)

    // Fetch the resource
    db := &dbv1alpha1.DatabaseCluster{}
    if err := r.Get(ctx, req.NamespacedName, db); err != nil {
        if errors.IsNotFound(err) {
            return ctrl.Result{}, nil
        }
        return ctrl.Result{}, fmt.Errorf("getting DatabaseCluster: %w", err)
    }

    // Set Reconciling condition at the start of every reconciliation
    conditions.SetTrue(&db.Status.Conditions, db.Generation,
        conditions.TypeReconciling,
        conditions.ReasonReconciling,
        "Reconciliation in progress",
    )

    // Update ObservedGeneration
    db.Status.ObservedGeneration = db.Generation

    // Determine target phase
    if !db.DeletionTimestamp.IsZero() {
        return r.reconcileDelete(ctx, db)
    }

    if db.Status.Phase == "" {
        db.Status.Phase = dbv1alpha1.PhasePending
    }

    result, err := r.reconcileNormal(ctx, db)

    // Clear Reconciling condition when done
    conditions.SetFalse(&db.Status.Conditions, db.Generation,
        conditions.TypeReconciling,
        "ReconciliationComplete",
        "Reconciliation completed successfully",
    )

    // Aggregate Ready condition from all sub-conditions
    readyCond := readyAggregator.Aggregate(db.Status.Conditions, db.Generation)
    conditions.Set(&db.Status.Conditions, readyCond)

    // Update phase based on conditions
    db.Status.Phase = r.derivePhase(db)
    db.Status.LastReconcileTime = &metav1.Time{Time: time.Now()}

    // Patch status (separate from spec patch to avoid conflicts)
    if patchErr := r.Status().Update(ctx, db); patchErr != nil {
        log.Error(patchErr, "Failed to update status")
        return ctrl.Result{}, patchErr
    }

    return result, err
}

func (r *DatabaseClusterReconciler) reconcileNormal(
    ctx context.Context,
    db *dbv1alpha1.DatabaseCluster,
) (ctrl.Result, error) {
    log := log.FromContext(ctx)

    // Step 1: Ensure storage
    if err := r.ensureStorage(ctx, db); err != nil {
        conditions.SetFalse(&db.Status.Conditions, db.Generation,
            conditions.TypeStorageAvailable,
            conditions.ReasonStorageClassNotFound,
            fmt.Sprintf("Storage provisioning failed: %v", err),
        )
        conditions.SetTrue(&db.Status.Conditions, db.Generation,
            conditions.TypeStalled,
            conditions.ReasonStorageClassNotFound,
            "Cannot proceed without storage",
        )
        return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
    }

    conditions.SetTrue(&db.Status.Conditions, db.Generation,
        conditions.TypeStorageAvailable,
        "StorageProvisioned",
        "PVC provisioned and bound",
    )
    conditions.SetFalse(&db.Status.Conditions, db.Generation,
        conditions.TypeStalled,
        "NotStalled",
        "",
    )

    // Step 2: Ensure TLS certificate
    certReady, err := r.ensureCertificate(ctx, db)
    if err != nil {
        log.Error(err, "certificate error")
        conditions.SetFalse(&db.Status.Conditions, db.Generation,
            conditions.TypeCertificateValid,
            conditions.ReasonCertificateExpired,
            fmt.Sprintf("Certificate error: %v", err),
        )
    } else if !certReady {
        conditions.SetUnknown(&db.Status.Conditions, db.Generation,
            conditions.TypeCertificateValid,
            conditions.ReasonWaitingForDependency,
            "Waiting for cert-manager to issue certificate",
        )
        return ctrl.Result{RequeueAfter: 10 * time.Second}, nil
    } else {
        conditions.SetTrue(&db.Status.Conditions, db.Generation,
            conditions.TypeCertificateValid,
            "CertificateIssued",
            "TLS certificate is valid and not expiring soon",
        )
    }

    // Step 3: Ensure StatefulSet
    readyReplicas, err := r.ensureStatefulSet(ctx, db)
    if err != nil {
        conditions.SetFalse(&db.Status.Conditions, db.Generation,
            conditions.TypeDatabaseReady,
            "StatefulSetError",
            fmt.Sprintf("StatefulSet error: %v", err),
        )
        return ctrl.Result{RequeueAfter: 10 * time.Second}, err
    }

    db.Status.ReadyReplicas = readyReplicas
    db.Status.Replicas = db.Spec.Replicas

    if readyReplicas < db.Spec.Replicas {
        conditions.SetFalse(&db.Status.Conditions, db.Generation,
            conditions.TypeDatabaseReady,
            "WaitingForReplicas",
            fmt.Sprintf("%d/%d replicas ready",
                readyReplicas, db.Spec.Replicas),
        )
        return ctrl.Result{RequeueAfter: 5 * time.Second}, nil
    }

    conditions.SetTrue(&db.Status.Conditions, db.Generation,
        conditions.TypeDatabaseReady,
        "AllReplicasReady",
        fmt.Sprintf("All %d replicas are ready", db.Spec.Replicas),
    )

    // Step 4: Verify replication
    replHealthy, err := r.checkReplication(ctx, db)
    if err != nil || !replHealthy {
        reason := conditions.ReasonHealthCheckFailed
        msg := "Replication lag exceeds threshold"
        if err != nil {
            msg = fmt.Sprintf("Replication check failed: %v", err)
        }
        conditions.SetFalse(&db.Status.Conditions, db.Generation,
            conditions.TypeReplicationHealthy, reason, msg)
        conditions.SetTrue(&db.Status.Conditions, db.Generation,
            conditions.TypeDegraded, reason, msg)
        return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
    }

    conditions.SetTrue(&db.Status.Conditions, db.Generation,
        conditions.TypeReplicationHealthy,
        "ReplicationLagAcceptable",
        "Replication lag is within acceptable bounds",
    )
    conditions.SetFalse(&db.Status.Conditions, db.Generation,
        conditions.TypeDegraded,
        "NotDegraded",
        "",
    )

    return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
}

func (r *DatabaseClusterReconciler) derivePhase(
    db *dbv1alpha1.DatabaseCluster,
) dbv1alpha1.DatabaseClusterPhase {
    conds := db.Status.Conditions

    if conditions.IsTrue(conds, conditions.TypeStalled) {
        return dbv1alpha1.PhaseFailed
    }

    if conditions.IsTrue(conds, conditions.TypeReady) {
        return dbv1alpha1.PhaseRunning
    }

    if conditions.IsTrue(conds, conditions.TypeDegraded) {
        return dbv1alpha1.PhaseDegraded
    }

    if conditions.IsTrue(conds, conditions.TypeReconciling) ||
        conditions.IsUnknown(conds, conditions.TypeDatabaseReady) {
        if db.Status.Replicas == 0 {
            return dbv1alpha1.PhaseInitializing
        }
        return dbv1alpha1.PhaseScaling
    }

    return db.Status.Phase // No change
}

func (r *DatabaseClusterReconciler) reconcileDelete(
    ctx context.Context,
    db *dbv1alpha1.DatabaseCluster,
) (ctrl.Result, error) {
    db.Status.Phase = dbv1alpha1.PhaseTerminating

    conditions.SetFalse(&db.Status.Conditions, db.Generation,
        conditions.TypeReady,
        "Terminating",
        "Resource is being deleted",
    )

    // Perform cleanup...
    // Remove finalizer when done

    return ctrl.Result{}, nil
}
```

## CRD Markers for Better Status

```go
// api/v1alpha1/databasecluster_types.go

// DatabaseCluster is the Schema for the databaseclusters API
// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:scope=Namespaced,shortName=db
// +kubebuilder:printcolumn:name="Phase",type="string",JSONPath=".status.phase"
// +kubebuilder:printcolumn:name="Ready",type="string",JSONPath=".status.conditions[?(@.type=='Ready')].status"
// +kubebuilder:printcolumn:name="Replicas",type="integer",JSONPath=".status.readyReplicas"
// +kubebuilder:printcolumn:name="Version",type="string",JSONPath=".status.currentVersion"
// +kubebuilder:printcolumn:name="Age",type="date",JSONPath=".metadata.creationTimestamp"
type DatabaseCluster struct {
    metav1.TypeMeta   `json:",inline"`
    metav1.ObjectMeta `json:"metadata,omitempty"`

    Spec   DatabaseClusterSpec   `json:"spec,omitempty"`
    Status DatabaseClusterStatus `json:"status,omitempty"`
}
```

## Testing Status Conditions

```go
// internal/controller/databasecluster_controller_test.go
package controller_test

import (
    "context"
    "testing"
    "time"

    . "github.com/onsi/ginkgo/v2"
    . "github.com/onsi/gomega"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "sigs.k8s.io/controller-runtime/pkg/client"

    dbv1alpha1 "github.com/myorg/db-operator/api/v1alpha1"
    "github.com/myorg/db-operator/internal/conditions"
)

var _ = Describe("DatabaseCluster Controller", func() {
    Context("When creating a DatabaseCluster", func() {
        It("should progress through phases correctly", func() {
            ctx := context.Background()

            db := &dbv1alpha1.DatabaseCluster{
                ObjectMeta: metav1.ObjectMeta{
                    Name:      "test-db",
                    Namespace: "default",
                },
                Spec: dbv1alpha1.DatabaseClusterSpec{
                    Replicas: 3,
                    Version:  "14.5",
                },
            }

            Expect(k8sClient.Create(ctx, db)).To(Succeed())

            // Should start in Pending or Initializing
            Eventually(func() dbv1alpha1.DatabaseClusterPhase {
                _ = k8sClient.Get(ctx, client.ObjectKeyFromObject(db), db)
                return db.Status.Phase
            }, 30*time.Second, time.Second).Should(
                BeElementOf(dbv1alpha1.PhasePending, dbv1alpha1.PhaseInitializing))

            // Ready condition should not be True yet
            Consistently(func() bool {
                _ = k8sClient.Get(ctx, client.ObjectKeyFromObject(db), db)
                return conditions.IsTrue(db.Status.Conditions, conditions.TypeReady)
            }, 5*time.Second, time.Second).Should(BeFalse())

            // Eventually should reach Running
            Eventually(func() dbv1alpha1.DatabaseClusterPhase {
                _ = k8sClient.Get(ctx, client.ObjectKeyFromObject(db), db)
                return db.Status.Phase
            }, 2*time.Minute, 5*time.Second).Should(Equal(dbv1alpha1.PhaseRunning))

            // Ready condition should be True
            Expect(conditions.IsTrue(db.Status.Conditions, conditions.TypeReady)).To(BeTrue())

            // ObservedGeneration should match
            Expect(db.Status.ObservedGeneration).To(Equal(db.Generation))
        })

        It("should set Stalled when StorageClass does not exist", func() {
            ctx := context.Background()

            db := &dbv1alpha1.DatabaseCluster{
                ObjectMeta: metav1.ObjectMeta{
                    Name:      "broken-db",
                    Namespace: "default",
                },
                Spec: dbv1alpha1.DatabaseClusterSpec{
                    Replicas:         1,
                    StorageClassName: "nonexistent-sc",
                },
            }

            Expect(k8sClient.Create(ctx, db)).To(Succeed())

            Eventually(func() bool {
                _ = k8sClient.Get(ctx, client.ObjectKeyFromObject(db), db)
                return conditions.IsTrue(db.Status.Conditions, conditions.TypeStalled)
            }, 30*time.Second, time.Second).Should(BeTrue())

            stalledCond := conditions.Get(db.Status.Conditions, conditions.TypeStalled)
            Expect(stalledCond).NotTo(BeNil())
            Expect(stalledCond.Reason).To(Equal(conditions.ReasonStorageClassNotFound))
        })
    })
})
```

## kubectl describe Output

Well-designed conditions produce informative `kubectl describe` output:

```bash
kubectl describe databasecluster/production-postgres

# Name:         production-postgres
# Namespace:    database
# ...
# Status:
#   Phase:           Running
#   Ready Replicas:  3
#   Replicas:        3
#   Current Version: 14.5
#   Observed Generation: 12
#   Conditions:
#     Last Transition Time:  2029-11-20T12:00:00Z
#     Message:               All components are ready
#     Observed Generation:   12
#     Reason:                Ready
#     Status:                True
#     Type:                  Ready
#     ---
#     Last Transition Time:  2029-11-20T11:58:00Z
#     Message:               PVC provisioned and bound
#     Observed Generation:   12
#     Reason:                StorageProvisioned
#     Status:                True
#     Type:                  StorageAvailable
#     ---
#     Last Transition Time:  2029-11-20T11:59:30Z
#     Message:               All 3 replicas are ready
#     Observed Generation:   12
#     Reason:                AllReplicasReady
#     Status:                True
#     Type:                  DatabaseReady
```

## Summary

Status conditions and phase management are the difference between an operator that is a joy to work with and one that is a black box. The Kubernetes condition model — with its `True`/`False`/`Unknown` triad, its `Reason` machine-readable identifier, and its `Message` human-readable description — provides everything needed to express any resource state clearly and unambiguously. The `Ready` aggregation pattern ensures that a single condition captures overall health for monitoring and alerting. Combined with meaningful phase enums, proper `ObservedGeneration` tracking, and comprehensive condition testing, these patterns make your operator a first-class citizen of the Kubernetes ecosystem.
