---
title: "Kubernetes Operator SDK Development Guide: Building Production-Ready Custom Controllers"
date: 2026-09-04T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Operator SDK", "Custom Controllers", "CRD", "Go", "Kubebuilder", "Operators"]
categories: ["Kubernetes", "DevOps", "Development"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to developing production-ready Kubernetes operators using Operator SDK, including CRD design, controller patterns, testing strategies, and deployment best practices."
more_link: "yes"
url: "/kubernetes-operator-sdk-development-guide/"
---

Kubernetes Operators extend the platform's capabilities by encoding operational knowledge into software. This comprehensive guide covers building production-ready operators using the Operator SDK, from initial design through deployment and lifecycle management.

<!--more-->

## Executive Summary

Kubernetes Operators automate the deployment, configuration, and management of complex applications. The Operator SDK provides frameworks and tools for building operators efficiently, supporting multiple languages and patterns. This guide demonstrates how to build robust, production-ready operators that follow Kubernetes best practices and handle real-world operational challenges.

## Understanding Kubernetes Operators

### Operator Pattern Fundamentals

Operators extend Kubernetes by combining custom resources with custom controllers that understand how to manage application-specific operational logic.

**Core Components:**

```yaml
# Custom Resource Definition (CRD)
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: databases.app.example.com
spec:
  group: app.example.com
  names:
    kind: Database
    listKind: DatabaseList
    plural: databases
    singular: database
    shortNames:
    - db
  scope: Namespaced
  versions:
  - name: v1alpha1
    served: true
    storage: true
    schema:
      openAPIV3Schema:
        type: object
        properties:
          spec:
            type: object
            required:
            - version
            - storageSize
            properties:
              version:
                type: string
                pattern: '^[0-9]+\.[0-9]+$'
              storageSize:
                type: string
                pattern: '^[0-9]+Gi$'
              replicas:
                type: integer
                minimum: 1
                maximum: 9
                default: 3
              backup:
                type: object
                properties:
                  enabled:
                    type: boolean
                    default: false
                  schedule:
                    type: string
                  retention:
                    type: integer
                    default: 7
          status:
            type: object
            properties:
              phase:
                type: string
                enum:
                - Pending
                - Creating
                - Running
                - Updating
                - Failed
              conditions:
                type: array
                items:
                  type: object
                  properties:
                    type:
                      type: string
                    status:
                      type: string
                    lastTransitionTime:
                      type: string
                      format: date-time
                    reason:
                      type: string
                    message:
                      type: string
              members:
                type: array
                items:
                  type: object
                  properties:
                    name:
                      type: string
                    ready:
                      type: boolean
                    role:
                      type: string
    subresources:
      status: {}
      scale:
        specReplicasPath: .spec.replicas
        statusReplicasPath: .status.replicas
    additionalPrinterColumns:
    - name: Version
      type: string
      jsonPath: .spec.version
    - name: Replicas
      type: integer
      jsonPath: .spec.replicas
    - name: Phase
      type: string
      jsonPath: .status.phase
    - name: Age
      type: date
      jsonPath: .metadata.creationTimestamp
```

### Operator Capability Levels

Understanding operator maturity helps in planning development phases:

1. **Level 1 - Basic Install**: Automated application provisioning
2. **Level 2 - Seamless Upgrades**: Automated upgrade handling
3. **Level 3 - Full Lifecycle**: Backup, restore, and failure recovery
4. **Level 4 - Deep Insights**: Metrics, alerts, and analytics
5. **Level 5 - Auto Pilot**: Horizontal and vertical scaling, self-healing

## Setting Up Operator SDK

### Installation and Project Initialization

**Install Operator SDK:**

```bash
#!/bin/bash
# Install Operator SDK
export OPERATOR_SDK_VERSION=v1.34.0
curl -LO "https://github.com/operator-framework/operator-sdk/releases/download/${OPERATOR_SDK_VERSION}/operator-sdk_linux_amd64"
chmod +x operator-sdk_linux_amd64
sudo mv operator-sdk_linux_amd64 /usr/local/bin/operator-sdk

# Verify installation
operator-sdk version

# Install additional dependencies
go install sigs.k8s.io/controller-runtime/tools/setup-envtest@latest
go install sigs.k8s.io/controller-tools/cmd/controller-gen@latest
```

**Initialize New Operator Project:**

```bash
#!/bin/bash
# Create new operator project
mkdir database-operator && cd database-operator
operator-sdk init \
  --domain=example.com \
  --repo=github.com/example/database-operator \
  --owner="Your Organization" \
  --project-name=database-operator

# Create API and controller
operator-sdk create api \
  --group=app \
  --version=v1alpha1 \
  --kind=Database \
  --resource=true \
  --controller=true

# Project structure created:
# ├── api/
# │   └── v1alpha1/
# │       ├── database_types.go
# │       └── zz_generated.deepcopy.go
# ├── config/
# │   ├── crd/
# │   ├── manager/
# │   ├── rbac/
# │   └── samples/
# ├── controllers/
# │   ├── database_controller.go
# │   └── suite_test.go
# ├── Dockerfile
# ├── Makefile
# └── main.go
```

## Designing Custom Resource Definitions

### API Type Definition

**Complete CRD Implementation (api/v1alpha1/database_types.go):**

```go
package v1alpha1

import (
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// DatabaseSpec defines the desired state of Database
type DatabaseSpec struct {
    // Version specifies the database version
    // +kubebuilder:validation:Pattern=`^[0-9]+\.[0-9]+$`
    // +kubebuilder:validation:Required
    Version string `json:"version"`

    // StorageSize defines the persistent storage size
    // +kubebuilder:validation:Pattern=`^[0-9]+Gi$`
    // +kubebuilder:validation:Required
    StorageSize string `json:"storageSize"`

    // Replicas defines the number of database instances
    // +kubebuilder:validation:Minimum=1
    // +kubebuilder:validation:Maximum=9
    // +kubebuilder:default=3
    // +optional
    Replicas *int32 `json:"replicas,omitempty"`

    // StorageClassName specifies the storage class for PVCs
    // +optional
    StorageClassName *string `json:"storageClassName,omitempty"`

    // Resources defines compute resources
    // +optional
    Resources *ResourceRequirements `json:"resources,omitempty"`

    // Backup configuration
    // +optional
    Backup *BackupSpec `json:"backup,omitempty"`

    // Monitoring configuration
    // +optional
    Monitoring *MonitoringSpec `json:"monitoring,omitempty"`

    // TLS configuration
    // +optional
    TLS *TLSSpec `json:"tls,omitempty"`
}

type ResourceRequirements struct {
    // CPU request
    // +optional
    CPURequest string `json:"cpuRequest,omitempty"`

    // CPU limit
    // +optional
    CPULimit string `json:"cpuLimit,omitempty"`

    // Memory request
    // +optional
    MemoryRequest string `json:"memoryRequest,omitempty"`

    // Memory limit
    // +optional
    MemoryLimit string `json:"memoryLimit,omitempty"`
}

type BackupSpec struct {
    // Enabled controls whether backups are enabled
    // +kubebuilder:default=false
    Enabled bool `json:"enabled"`

    // Schedule in cron format
    // +kubebuilder:validation:Pattern=`^(@(annually|yearly|monthly|weekly|daily|hourly|reboot))|(@every (\d+(ns|us|µs|ms|s|m|h))+)|((((\d+,)+\d+|(\d+(\/|-)\d+)|\d+|\*) ?){5,7})$`
    // +optional
    Schedule string `json:"schedule,omitempty"`

    // Retention days
    // +kubebuilder:validation:Minimum=1
    // +kubebuilder:default=7
    // +optional
    Retention int32 `json:"retention,omitempty"`

    // S3 storage configuration
    // +optional
    S3 *S3BackupSpec `json:"s3,omitempty"`
}

type S3BackupSpec struct {
    // Bucket name
    Bucket string `json:"bucket"`

    // Region
    Region string `json:"region"`

    // Endpoint for S3-compatible storage
    // +optional
    Endpoint string `json:"endpoint,omitempty"`

    // Secret containing credentials
    CredentialsSecret string `json:"credentialsSecret"`
}

type MonitoringSpec struct {
    // Enabled controls monitoring
    // +kubebuilder:default=true
    Enabled bool `json:"enabled"`

    // ServiceMonitor labels
    // +optional
    ServiceMonitorLabels map[string]string `json:"serviceMonitorLabels,omitempty"`
}

type TLSSpec struct {
    // Enabled controls TLS
    // +kubebuilder:default=false
    Enabled bool `json:"enabled"`

    // Certificate secret name
    // +optional
    CertificateSecret string `json:"certificateSecret,omitempty"`

    // CA secret name
    // +optional
    CASecret string `json:"caSecret,omitempty"`
}

// DatabaseStatus defines the observed state of Database
type DatabaseStatus struct {
    // Phase represents the current phase
    // +optional
    Phase DatabasePhase `json:"phase,omitempty"`

    // Conditions represent the latest available observations
    // +optional
    Conditions []metav1.Condition `json:"conditions,omitempty"`

    // Members list with status
    // +optional
    Members []MemberStatus `json:"members,omitempty"`

    // Replicas is the actual number of replicas
    // +optional
    Replicas int32 `json:"replicas,omitempty"`

    // ReadyReplicas is the number of ready replicas
    // +optional
    ReadyReplicas int32 `json:"readyReplicas,omitempty"`

    // LastBackupTime
    // +optional
    LastBackupTime *metav1.Time `json:"lastBackupTime,omitempty"`

    // ObservedGeneration reflects the generation observed
    // +optional
    ObservedGeneration int64 `json:"observedGeneration,omitempty"`
}

type DatabasePhase string

const (
    DatabasePhasePending  DatabasePhase = "Pending"
    DatabasePhaseCreating DatabasePhase = "Creating"
    DatabasePhaseRunning  DatabasePhase = "Running"
    DatabasePhaseUpdating DatabasePhase = "Updating"
    DatabasePhaseFailed   DatabasePhase = "Failed"
)

type MemberStatus struct {
    // Name of the member
    Name string `json:"name"`

    // Ready status
    Ready bool `json:"ready"`

    // Role (primary/replica)
    Role string `json:"role"`

    // Version running
    // +optional
    Version string `json:"version,omitempty"`
}

// Condition types
const (
    ConditionTypeReady            = "Ready"
    ConditionTypeBackupConfigured = "BackupConfigured"
    ConditionTypeTLSConfigured    = "TLSConfigured"
    ConditionTypeUpgrading        = "Upgrading"
)

//+kubebuilder:object:root=true
//+kubebuilder:subresource:status
//+kubebuilder:subresource:scale:specpath=.spec.replicas,statuspath=.status.replicas
//+kubebuilder:resource:shortName=db
//+kubebuilder:printcolumn:name="Version",type=string,JSONPath=`.spec.version`
//+kubebuilder:printcolumn:name="Replicas",type=integer,JSONPath=`.spec.replicas`
//+kubebuilder:printcolumn:name="Ready",type=integer,JSONPath=`.status.readyReplicas`
//+kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
//+kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`

// Database is the Schema for the databases API
type Database struct {
    metav1.TypeMeta   `json:",inline"`
    metav1.ObjectMeta `json:"metadata,omitempty"`

    Spec   DatabaseSpec   `json:"spec,omitempty"`
    Status DatabaseStatus `json:"status,omitempty"`
}

//+kubebuilder:object:root=true

// DatabaseList contains a list of Database
type DatabaseList struct {
    metav1.TypeMeta `json:",inline"`
    metav1.ListMeta `json:"metadata,omitempty"`
    Items           []Database `json:"items"`
}

func init() {
    SchemeBuilder.Register(&Database{}, &DatabaseList{})
}
```

## Controller Implementation

### Reconciliation Logic

**Complete Controller Implementation (controllers/database_controller.go):**

```go
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
    "k8s.io/apimachinery/pkg/types"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
    "sigs.k8s.io/controller-runtime/pkg/log"
    "sigs.k8s.io/controller-runtime/pkg/predicate"

    appv1alpha1 "github.com/example/database-operator/api/v1alpha1"
)

const (
    databaseFinalizer = "app.example.com/finalizer"
    requeueDelay      = 30 * time.Second
)

// DatabaseReconciler reconciles a Database object
type DatabaseReconciler struct {
    client.Client
    Scheme *runtime.Scheme
}

//+kubebuilder:rbac:groups=app.example.com,resources=databases,verbs=get;list;watch;create;update;patch;delete
//+kubebuilder:rbac:groups=app.example.com,resources=databases/status,verbs=get;update;patch
//+kubebuilder:rbac:groups=app.example.com,resources=databases/finalizers,verbs=update
//+kubebuilder:rbac:groups=apps,resources=statefulsets,verbs=get;list;watch;create;update;patch;delete
//+kubebuilder:rbac:groups=core,resources=services,verbs=get;list;watch;create;update;patch;delete
//+kubebuilder:rbac:groups=core,resources=configmaps,verbs=get;list;watch;create;update;patch;delete
//+kubebuilder:rbac:groups=core,resources=secrets,verbs=get;list;watch
//+kubebuilder:rbac:groups=core,resources=persistentvolumeclaims,verbs=get;list;watch;create;update;patch;delete
//+kubebuilder:rbac:groups=batch,resources=cronjobs,verbs=get;list;watch;create;update;patch;delete
//+kubebuilder:rbac:groups=monitoring.coreos.com,resources=servicemonitors,verbs=get;list;watch;create;update;patch;delete

// Reconcile is the main reconciliation loop
func (r *DatabaseReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    logger := log.FromContext(ctx)

    // Fetch the Database instance
    database := &appv1alpha1.Database{}
    err := r.Get(ctx, req.NamespacedName, database)
    if err != nil {
        if errors.IsNotFound(err) {
            logger.Info("Database resource not found, ignoring")
            return ctrl.Result{}, nil
        }
        logger.Error(err, "Failed to get Database")
        return ctrl.Result{}, err
    }

    // Check if marked for deletion
    if database.ObjectMeta.DeletionTimestamp.IsZero() {
        // Add finalizer if not present
        if !controllerutil.ContainsFinalizer(database, databaseFinalizer) {
            controllerutil.AddFinalizer(database, databaseFinalizer)
            if err := r.Update(ctx, database); err != nil {
                return ctrl.Result{}, err
            }
        }
    } else {
        // Resource being deleted
        if controllerutil.ContainsFinalizer(database, databaseFinalizer) {
            if err := r.finalizeDatabaseCleanup(ctx, database); err != nil {
                return ctrl.Result{}, err
            }

            controllerutil.RemoveFinalizer(database, databaseFinalizer)
            if err := r.Update(ctx, database); err != nil {
                return ctrl.Result{}, err
            }
        }
        return ctrl.Result{}, nil
    }

    // Set default values
    r.setDefaults(database)

    // Reconcile ConfigMap
    if err := r.reconcileConfigMap(ctx, database); err != nil {
        logger.Error(err, "Failed to reconcile ConfigMap")
        return r.updateStatus(ctx, database, appv1alpha1.DatabasePhaseFailed, err)
    }

    // Reconcile Service
    if err := r.reconcileService(ctx, database); err != nil {
        logger.Error(err, "Failed to reconcile Service")
        return r.updateStatus(ctx, database, appv1alpha1.DatabasePhaseFailed, err)
    }

    // Reconcile StatefulSet
    if err := r.reconcileStatefulSet(ctx, database); err != nil {
        logger.Error(err, "Failed to reconcile StatefulSet")
        return r.updateStatus(ctx, database, appv1alpha1.DatabasePhaseFailed, err)
    }

    // Reconcile Backup CronJob if enabled
    if database.Spec.Backup != nil && database.Spec.Backup.Enabled {
        if err := r.reconcileBackupCronJob(ctx, database); err != nil {
            logger.Error(err, "Failed to reconcile Backup CronJob")
            meta.SetStatusCondition(&database.Status.Conditions, metav1.Condition{
                Type:               appv1alpha1.ConditionTypeBackupConfigured,
                Status:             metav1.ConditionFalse,
                Reason:             "BackupFailed",
                Message:            err.Error(),
                ObservedGeneration: database.Generation,
            })
        } else {
            meta.SetStatusCondition(&database.Status.Conditions, metav1.Condition{
                Type:               appv1alpha1.ConditionTypeBackupConfigured,
                Status:             metav1.ConditionTrue,
                Reason:             "BackupConfigured",
                Message:            "Backup CronJob configured successfully",
                ObservedGeneration: database.Generation,
            })
        }
    }

    // Reconcile ServiceMonitor if monitoring enabled
    if database.Spec.Monitoring != nil && database.Spec.Monitoring.Enabled {
        if err := r.reconcileServiceMonitor(ctx, database); err != nil {
            logger.Error(err, "Failed to reconcile ServiceMonitor")
        }
    }

    // Update status based on StatefulSet status
    return r.updateStatusFromStatefulSet(ctx, database)
}

func (r *DatabaseReconciler) setDefaults(database *appv1alpha1.Database) {
    if database.Spec.Replicas == nil {
        replicas := int32(3)
        database.Spec.Replicas = &replicas
    }
}

func (r *DatabaseReconciler) reconcileConfigMap(ctx context.Context, database *appv1alpha1.Database) error {
    configMap := &corev1.ConfigMap{
        ObjectMeta: metav1.ObjectMeta{
            Name:      database.Name + "-config",
            Namespace: database.Namespace,
        },
        Data: r.buildConfigMapData(database),
    }

    if err := controllerutil.SetControllerReference(database, configMap, r.Scheme); err != nil {
        return err
    }

    found := &corev1.ConfigMap{}
    err := r.Get(ctx, types.NamespacedName{Name: configMap.Name, Namespace: configMap.Namespace}, found)
    if err != nil && errors.IsNotFound(err) {
        return r.Create(ctx, configMap)
    } else if err != nil {
        return err
    }

    // Update if different
    if !equality.Semantic.DeepEqual(found.Data, configMap.Data) {
        found.Data = configMap.Data
        return r.Update(ctx, found)
    }

    return nil
}

func (r *DatabaseReconciler) buildConfigMapData(database *appv1alpha1.Database) map[string]string {
    return map[string]string{
        "database.conf": fmt.Sprintf(`
version: %s
replicas: %d
storage_size: %s
backup_enabled: %t
`, database.Spec.Version, *database.Spec.Replicas, database.Spec.StorageSize,
            database.Spec.Backup != nil && database.Spec.Backup.Enabled),
    }
}

func (r *DatabaseReconciler) reconcileService(ctx context.Context, database *appv1alpha1.Database) error {
    // Headless service for StatefulSet
    service := &corev1.Service{
        ObjectMeta: metav1.ObjectMeta{
            Name:      database.Name,
            Namespace: database.Namespace,
            Labels:    r.buildLabels(database),
        },
        Spec: corev1.ServiceSpec{
            ClusterIP: "None",
            Selector:  r.buildLabels(database),
            Ports: []corev1.ServicePort{
                {
                    Name:     "db",
                    Port:     5432,
                    Protocol: corev1.ProtocolTCP,
                },
                {
                    Name:     "metrics",
                    Port:     9187,
                    Protocol: corev1.ProtocolTCP,
                },
            },
        },
    }

    if err := controllerutil.SetControllerReference(database, service, r.Scheme); err != nil {
        return err
    }

    found := &corev1.Service{}
    err := r.Get(ctx, types.NamespacedName{Name: service.Name, Namespace: service.Namespace}, found)
    if err != nil && errors.IsNotFound(err) {
        return r.Create(ctx, service)
    }

    return err
}

func (r *DatabaseReconciler) reconcileStatefulSet(ctx context.Context, database *appv1alpha1.Database) error {
    statefulSet := r.buildStatefulSet(database)

    if err := controllerutil.SetControllerReference(database, statefulSet, r.Scheme); err != nil {
        return err
    }

    found := &appsv1.StatefulSet{}
    err := r.Get(ctx, types.NamespacedName{Name: statefulSet.Name, Namespace: statefulSet.Namespace}, found)
    if err != nil && errors.IsNotFound(err) {
        return r.Create(ctx, statefulSet)
    } else if err != nil {
        return err
    }

    // Update strategy: only update replicas and image
    if found.Spec.Replicas == nil || *found.Spec.Replicas != *database.Spec.Replicas {
        found.Spec.Replicas = database.Spec.Replicas
        return r.Update(ctx, found)
    }

    return nil
}

func (r *DatabaseReconciler) buildStatefulSet(database *appv1alpha1.Database) *appsv1.StatefulSet {
    labels := r.buildLabels(database)
    replicas := database.Spec.Replicas

    return &appsv1.StatefulSet{
        ObjectMeta: metav1.ObjectMeta{
            Name:      database.Name,
            Namespace: database.Namespace,
            Labels:    labels,
        },
        Spec: appsv1.StatefulSetSpec{
            Replicas:    replicas,
            ServiceName: database.Name,
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
                            Image: fmt.Sprintf("postgres:%s", database.Spec.Version),
                            Ports: []corev1.ContainerPort{
                                {
                                    Name:          "db",
                                    ContainerPort: 5432,
                                },
                            },
                            Env: []corev1.EnvVar{
                                {
                                    Name:  "POSTGRES_DB",
                                    Value: "app",
                                },
                                {
                                    Name: "POSTGRES_PASSWORD",
                                    ValueFrom: &corev1.EnvVarSource{
                                        SecretKeyRef: &corev1.SecretKeySelector{
                                            LocalObjectReference: corev1.LocalObjectReference{
                                                Name: database.Name + "-secret",
                                            },
                                            Key: "password",
                                        },
                                    },
                                },
                            },
                            VolumeMounts: []corev1.VolumeMount{
                                {
                                    Name:      "data",
                                    MountPath: "/var/lib/postgresql/data",
                                },
                                {
                                    Name:      "config",
                                    MountPath: "/etc/database",
                                },
                            },
                            Resources: r.buildResourceRequirements(database),
                        },
                    },
                    Volumes: []corev1.Volume{
                        {
                            Name: "config",
                            VolumeSource: corev1.VolumeSource{
                                ConfigMap: &corev1.ConfigMapVolumeSource{
                                    LocalObjectReference: corev1.LocalObjectReference{
                                        Name: database.Name + "-config",
                                    },
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
                        AccessModes: []corev1.PersistentVolumeAccessMode{
                            corev1.ReadWriteOnce,
                        },
                        StorageClassName: database.Spec.StorageClassName,
                        Resources: corev1.ResourceRequirements{
                            Requests: corev1.ResourceList{
                                corev1.ResourceStorage: resource.MustParse(database.Spec.StorageSize),
                            },
                        },
                    },
                },
            },
        },
    }
}

func (r *DatabaseReconciler) buildLabels(database *appv1alpha1.Database) map[string]string {
    return map[string]string{
        "app.kubernetes.io/name":       "database",
        "app.kubernetes.io/instance":   database.Name,
        "app.kubernetes.io/version":    database.Spec.Version,
        "app.kubernetes.io/managed-by": "database-operator",
    }
}

func (r *DatabaseReconciler) buildResourceRequirements(database *appv1alpha1.Database) corev1.ResourceRequirements {
    if database.Spec.Resources == nil {
        return corev1.ResourceRequirements{}
    }

    requirements := corev1.ResourceRequirements{
        Requests: corev1.ResourceList{},
        Limits:   corev1.ResourceList{},
    }

    if database.Spec.Resources.CPURequest != "" {
        requirements.Requests[corev1.ResourceCPU] = resource.MustParse(database.Spec.Resources.CPURequest)
    }
    if database.Spec.Resources.MemoryRequest != "" {
        requirements.Requests[corev1.ResourceMemory] = resource.MustParse(database.Spec.Resources.MemoryRequest)
    }
    if database.Spec.Resources.CPULimit != "" {
        requirements.Limits[corev1.ResourceCPU] = resource.MustParse(database.Spec.Resources.CPULimit)
    }
    if database.Spec.Resources.MemoryLimit != "" {
        requirements.Limits[corev1.ResourceMemory] = resource.MustParse(database.Spec.Resources.MemoryLimit)
    }

    return requirements
}

func (r *DatabaseReconciler) reconcileBackupCronJob(ctx context.Context, database *appv1alpha1.Database) error {
    // Implementation for backup CronJob
    // This would create a CronJob resource for scheduled backups
    return nil
}

func (r *DatabaseReconciler) reconcileServiceMonitor(ctx context.Context, database *appv1alpha1.Database) error {
    // Implementation for ServiceMonitor
    // This would create a Prometheus ServiceMonitor resource
    return nil
}

func (r *DatabaseReconciler) updateStatusFromStatefulSet(ctx context.Context, database *appv1alpha1.Database) (ctrl.Result, error) {
    sts := &appsv1.StatefulSet{}
    err := r.Get(ctx, types.NamespacedName{Name: database.Name, Namespace: database.Namespace}, sts)
    if err != nil {
        return ctrl.Result{}, err
    }

    database.Status.Replicas = sts.Status.Replicas
    database.Status.ReadyReplicas = sts.Status.ReadyReplicas
    database.Status.ObservedGeneration = database.Generation

    // Determine phase
    phase := appv1alpha1.DatabasePhaseRunning
    if sts.Status.ReadyReplicas == 0 {
        phase = appv1alpha1.DatabasePhaseCreating
    } else if sts.Status.ReadyReplicas < *database.Spec.Replicas {
        phase = appv1alpha1.DatabasePhaseUpdating
    }

    database.Status.Phase = phase

    // Set Ready condition
    if sts.Status.ReadyReplicas == *database.Spec.Replicas {
        meta.SetStatusCondition(&database.Status.Conditions, metav1.Condition{
            Type:               appv1alpha1.ConditionTypeReady,
            Status:             metav1.ConditionTrue,
            Reason:             "AllReplicasReady",
            Message:            "All replicas are ready",
            ObservedGeneration: database.Generation,
        })
    } else {
        meta.SetStatusCondition(&database.Status.Conditions, metav1.Condition{
            Type:               appv1alpha1.ConditionTypeReady,
            Status:             metav1.ConditionFalse,
            Reason:             "NotAllReplicasReady",
            Message:            fmt.Sprintf("%d/%d replicas ready", sts.Status.ReadyReplicas, *database.Spec.Replicas),
            ObservedGeneration: database.Generation,
        })
    }

    if err := r.Status().Update(ctx, database); err != nil {
        return ctrl.Result{}, err
    }

    // Requeue if not all replicas ready
    if sts.Status.ReadyReplicas < *database.Spec.Replicas {
        return ctrl.Result{RequeueAfter: requeueDelay}, nil
    }

    return ctrl.Result{}, nil
}

func (r *DatabaseReconciler) updateStatus(ctx context.Context, database *appv1alpha1.Database,
    phase appv1alpha1.DatabasePhase, err error) (ctrl.Result, error) {

    database.Status.Phase = phase
    database.Status.ObservedGeneration = database.Generation

    if err != nil {
        meta.SetStatusCondition(&database.Status.Conditions, metav1.Condition{
            Type:               appv1alpha1.ConditionTypeReady,
            Status:             metav1.ConditionFalse,
            Reason:             "ReconciliationFailed",
            Message:            err.Error(),
            ObservedGeneration: database.Generation,
        })
    }

    if updateErr := r.Status().Update(ctx, database); updateErr != nil {
        return ctrl.Result{}, updateErr
    }

    return ctrl.Result{RequeueAfter: requeueDelay}, err
}

func (r *DatabaseReconciler) finalizeDatabaseCleanup(ctx context.Context, database *appv1alpha1.Database) error {
    logger := log.FromContext(ctx)
    logger.Info("Performing finalizer cleanup", "database", database.Name)

    // Cleanup logic here (e.g., delete external resources)
    // For example, delete backups from S3, revoke database users, etc.

    return nil
}

// SetupWithManager sets up the controller with the Manager.
func (r *DatabaseReconciler) SetupWithManager(mgr ctrl.Manager) error {
    return ctrl.NewControllerManagedBy(mgr).
        For(&appv1alpha1.Database{}).
        Owns(&appsv1.StatefulSet{}).
        Owns(&corev1.Service{}).
        Owns(&corev1.ConfigMap{}).
        WithEventFilter(predicate.GenerationChangedPredicate{}).
        Complete(r)
}
```

## Testing Strategies

### Unit Testing

**Controller Unit Test Example:**

```go
package controllers

import (
    "context"
    "testing"
    "time"

    . "github.com/onsi/ginkgo/v2"
    . "github.com/onsi/gomega"
    appsv1 "k8s.io/api/apps/v1"
    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/types"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/reconcile"

    appv1alpha1 "github.com/example/database-operator/api/v1alpha1"
)

var _ = Describe("Database Controller", func() {
    const (
        DatabaseName      = "test-database"
        DatabaseNamespace = "default"
        timeout           = time.Second * 10
        interval          = time.Millisecond * 250
    )

    Context("When creating a Database resource", func() {
        It("Should create StatefulSet successfully", func() {
            ctx := context.Background()

            replicas := int32(3)
            database := &appv1alpha1.Database{
                ObjectMeta: metav1.ObjectMeta{
                    Name:      DatabaseName,
                    Namespace: DatabaseNamespace,
                },
                Spec: appv1alpha1.DatabaseSpec{
                    Version:     "14.0",
                    StorageSize: "10Gi",
                    Replicas:    &replicas,
                },
            }

            Expect(k8sClient.Create(ctx, database)).Should(Succeed())

            databaseLookupKey := types.NamespacedName{
                Name:      DatabaseName,
                Namespace: DatabaseNamespace,
            }

            createdDatabase := &appv1alpha1.Database{}

            // Verify Database was created
            Eventually(func() bool {
                err := k8sClient.Get(ctx, databaseLookupKey, createdDatabase)
                return err == nil
            }, timeout, interval).Should(BeTrue())

            // Verify StatefulSet was created
            statefulSetLookupKey := types.NamespacedName{
                Name:      DatabaseName,
                Namespace: DatabaseNamespace,
            }
            createdStatefulSet := &appsv1.StatefulSet{}

            Eventually(func() bool {
                err := k8sClient.Get(ctx, statefulSetLookupKey, createdStatefulSet)
                return err == nil
            }, timeout, interval).Should(BeTrue())

            Expect(*createdStatefulSet.Spec.Replicas).Should(Equal(replicas))
            Expect(createdStatefulSet.Spec.Template.Spec.Containers[0].Image).Should(Equal("postgres:14.0"))

            // Verify Service was created
            serviceLookupKey := types.NamespacedName{
                Name:      DatabaseName,
                Namespace: DatabaseNamespace,
            }
            createdService := &corev1.Service{}

            Eventually(func() bool {
                err := k8sClient.Get(ctx, serviceLookupKey, createdService)
                return err == nil
            }, timeout, interval).Should(BeTrue())

            Expect(createdService.Spec.ClusterIP).Should(Equal("None"))
        })

        It("Should update StatefulSet when replicas change", func() {
            ctx := context.Background()

            databaseLookupKey := types.NamespacedName{
                Name:      DatabaseName,
                Namespace: DatabaseNamespace,
            }

            database := &appv1alpha1.Database{}
            Expect(k8sClient.Get(ctx, databaseLookupKey, database)).Should(Succeed())

            newReplicas := int32(5)
            database.Spec.Replicas = &newReplicas
            Expect(k8sClient.Update(ctx, database)).Should(Succeed())

            statefulSetLookupKey := types.NamespacedName{
                Name:      DatabaseName,
                Namespace: DatabaseNamespace,
            }
            statefulSet := &appsv1.StatefulSet{}

            Eventually(func() int32 {
                k8sClient.Get(ctx, statefulSetLookupKey, statefulSet)
                if statefulSet.Spec.Replicas == nil {
                    return 0
                }
                return *statefulSet.Spec.Replicas
            }, timeout, interval).Should(Equal(newReplicas))
        })
    })

    Context("When deleting a Database resource", func() {
        It("Should run finalizer cleanup", func() {
            ctx := context.Background()

            databaseLookupKey := types.NamespacedName{
                Name:      DatabaseName,
                Namespace: DatabaseNamespace,
            }

            database := &appv1alpha1.Database{}
            Expect(k8sClient.Get(ctx, databaseLookupKey, database)).Should(Succeed())

            Expect(k8sClient.Delete(ctx, database)).Should(Succeed())

            Eventually(func() bool {
                err := k8sClient.Get(ctx, databaseLookupKey, database)
                return errors.IsNotFound(err)
            }, timeout, interval).Should(BeTrue())
        })
    })
})
```

### Integration Testing

**End-to-End Test Script:**

```bash
#!/bin/bash
set -e

NAMESPACE="operator-test"
DATABASE_NAME="test-db"

echo "Creating test namespace..."
kubectl create namespace ${NAMESPACE} || true

echo "Installing CRD..."
make install

echo "Deploying operator..."
make deploy IMG=database-operator:test

echo "Waiting for operator to be ready..."
kubectl wait --for=condition=available --timeout=300s \
  deployment/database-operator-controller-manager \
  -n database-operator-system

echo "Creating test Database instance..."
cat <<EOF | kubectl apply -f -
apiVersion: app.example.com/v1alpha1
kind: Database
metadata:
  name: ${DATABASE_NAME}
  namespace: ${NAMESPACE}
spec:
  version: "14.0"
  storageSize: "5Gi"
  replicas: 3
  resources:
    cpuRequest: "500m"
    memoryRequest: "1Gi"
  backup:
    enabled: true
    schedule: "0 2 * * *"
    retention: 7
EOF

echo "Waiting for Database to be ready..."
kubectl wait --for=condition=Ready --timeout=600s \
  database/${DATABASE_NAME} -n ${NAMESPACE}

echo "Verifying StatefulSet..."
kubectl get statefulset ${DATABASE_NAME} -n ${NAMESPACE}

echo "Verifying pods..."
kubectl get pods -n ${NAMESPACE} -l app.kubernetes.io/instance=${DATABASE_NAME}

echo "Testing scale up..."
kubectl patch database ${DATABASE_NAME} -n ${NAMESPACE} \
  --type=merge -p '{"spec":{"replicas":5}}'

sleep 30

echo "Verifying scaled StatefulSet..."
REPLICAS=$(kubectl get statefulset ${DATABASE_NAME} -n ${NAMESPACE} \
  -o jsonpath='{.spec.replicas}')

if [ "$REPLICAS" != "5" ]; then
  echo "ERROR: Expected 5 replicas, got $REPLICAS"
  exit 1
fi

echo "Testing database connectivity..."
kubectl run -n ${NAMESPACE} test-client --rm -it --restart=Never \
  --image=postgres:14.0 -- psql -h ${DATABASE_NAME}-0.${DATABASE_NAME} -U postgres -c "SELECT 1"

echo "Cleanup..."
kubectl delete database ${DATABASE_NAME} -n ${NAMESPACE}
kubectl delete namespace ${NAMESPACE}

echo "All tests passed!"
```

## Building and Deployment

### Building Operator Image

**Dockerfile (generated by Operator SDK):**

```dockerfile
# Build the manager binary
FROM golang:1.21 as builder
ARG TARGETOS
ARG TARGETARCH

WORKDIR /workspace
# Copy Go modules manifests
COPY go.mod go.mod
COPY go.sum go.sum
# Cache deps before building and copying source
RUN go mod download

# Copy source code
COPY cmd/main.go cmd/main.go
COPY api/ api/
COPY internal/ internal/
COPY controllers/ controllers/

# Build
RUN CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH} \
    go build -a -o manager cmd/main.go

# Production image
FROM gcr.io/distroless/static:nonroot
WORKDIR /
COPY --from=builder /workspace/manager .
USER 65532:65532

ENTRYPOINT ["/manager"]
```

**Build and Push Script:**

```bash
#!/bin/bash
set -e

VERSION=${1:-v0.1.0}
REGISTRY=${REGISTRY:-docker.io/yourorg}
IMAGE=${REGISTRY}/database-operator:${VERSION}

echo "Building operator image ${IMAGE}..."
docker build -t ${IMAGE} .

echo "Pushing image..."
docker push ${IMAGE}

echo "Updating kustomization..."
cd config/manager
kustomize edit set image controller=${IMAGE}
cd ../..

echo "Build complete: ${IMAGE}"
```

### Helm Chart for Deployment

**Helm Chart Structure:**

```yaml
# helm/database-operator/Chart.yaml
apiVersion: v2
name: database-operator
description: A Helm chart for Database Operator
type: application
version: 0.1.0
appVersion: "0.1.0"

---
# helm/database-operator/values.yaml
replicaCount: 1

image:
  repository: docker.io/yourorg/database-operator
  pullPolicy: IfNotPresent
  tag: "v0.1.0"

imagePullSecrets: []
nameOverride: ""
fullnameOverride: ""

serviceAccount:
  create: true
  annotations: {}
  name: ""

podAnnotations:
  prometheus.io/scrape: "true"
  prometheus.io/port: "8080"

podSecurityContext:
  runAsNonRoot: true

securityContext:
  allowPrivilegeEscalation: false
  capabilities:
    drop:
    - ALL

resources:
  limits:
    cpu: 500m
    memory: 512Mi
  requests:
    cpu: 100m
    memory: 128Mi

nodeSelector: {}
tolerations: []
affinity: {}

metrics:
  enabled: true
  port: 8080

webhook:
  enabled: true
  port: 9443
  certManager:
    enabled: true

---
# helm/database-operator/templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "database-operator.fullname" . }}
  labels:
    {{- include "database-operator.labels" . | nindent 4 }}
spec:
  replicas: {{ .Values.replicaCount }}
  selector:
    matchLabels:
      {{- include "database-operator.selectorLabels" . | nindent 6 }}
  template:
    metadata:
      annotations:
        {{- toYaml .Values.podAnnotations | nindent 8 }}
      labels:
        {{- include "database-operator.selectorLabels" . | nindent 8 }}
    spec:
      {{- with .Values.imagePullSecrets }}
      imagePullSecrets:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      serviceAccountName: {{ include "database-operator.serviceAccountName" . }}
      securityContext:
        {{- toYaml .Values.podSecurityContext | nindent 8 }}
      containers:
      - name: manager
        securityContext:
          {{- toYaml .Values.securityContext | nindent 12 }}
        image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
        imagePullPolicy: {{ .Values.image.pullPolicy }}
        command:
        - /manager
        args:
        - --leader-elect
        {{- if .Values.metrics.enabled }}
        - --metrics-bind-address=:{{ .Values.metrics.port }}
        {{- end }}
        {{- if .Values.webhook.enabled }}
        - --webhook-port={{ .Values.webhook.port }}
        {{- end }}
        ports:
        - containerPort: {{ .Values.metrics.port }}
          name: metrics
          protocol: TCP
        {{- if .Values.webhook.enabled }}
        - containerPort: {{ .Values.webhook.port }}
          name: webhook
          protocol: TCP
        {{- end }}
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
          {{- toYaml .Values.resources | nindent 12 }}
      {{- with .Values.nodeSelector }}
      nodeSelector:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with .Values.affinity }}
      affinity:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with .Values.tolerations }}
      tolerations:
        {{- toYaml . | nindent 8 }}
      {{- end }}
```

## Monitoring and Observability

### Metrics Implementation

**Metrics Collection:**

```go
package metrics

import (
    "github.com/prometheus/client_golang/prometheus"
    "sigs.k8s.io/controller-runtime/pkg/metrics"
)

var (
    DatabasesTotal = prometheus.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "database_operator_databases_total",
            Help: "Total number of Database resources",
        },
        []string{"namespace", "phase"},
    )

    ReconcileCount = prometheus.NewCounterVec(
        prometheus.CounterOpts{
            Name: "database_operator_reconcile_total",
            Help: "Total number of reconciliations",
        },
        []string{"namespace", "result"},
    )

    ReconcileDuration = prometheus.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "database_operator_reconcile_duration_seconds",
            Help:    "Duration of reconcile operations",
            Buckets: prometheus.DefBuckets,
        },
        []string{"namespace"},
    )
)

func init() {
    metrics.Registry.MustRegister(
        DatabasesTotal,
        ReconcileCount,
        ReconcileDuration,
    )
}
```

## Best Practices and Production Considerations

### Security Hardening

**RBAC Configuration:**

```yaml
# config/rbac/role.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: database-operator-manager-role
rules:
# Database resources
- apiGroups:
  - app.example.com
  resources:
  - databases
  verbs:
  - create
  - delete
  - get
  - list
  - patch
  - update
  - watch
- apiGroups:
  - app.example.com
  resources:
  - databases/status
  verbs:
  - get
  - patch
  - update
- apiGroups:
  - app.example.com
  resources:
  - databases/finalizers
  verbs:
  - update
# Managed resources
- apiGroups:
  - apps
  resources:
  - statefulsets
  verbs:
  - create
  - delete
  - get
  - list
  - patch
  - update
  - watch
- apiGroups:
  - ""
  resources:
  - services
  - configmaps
  - persistentvolumeclaims
  verbs:
  - create
  - delete
  - get
  - list
  - patch
  - update
  - watch
# Read-only for secrets
- apiGroups:
  - ""
  resources:
  - secrets
  verbs:
  - get
  - list
  - watch
# Events
- apiGroups:
  - ""
  resources:
  - events
  verbs:
  - create
  - patch
```

### Error Handling and Retry Logic

**Robust Error Handling:**

```go
func (r *DatabaseReconciler) reconcileWithRetry(ctx context.Context,
    database *appv1alpha1.Database, fn func() error) error {

    backoff := wait.Backoff{
        Steps:    5,
        Duration: 10 * time.Millisecond,
        Factor:   2.0,
        Jitter:   0.1,
    }

    return retry.OnError(backoff, func(err error) bool {
        // Retry on transient errors
        return errors.IsConflict(err) || errors.IsServerTimeout(err)
    }, fn)
}
```

## Conclusion

Building production-ready Kubernetes operators requires careful design of CRDs, robust controller logic, comprehensive testing, and operational considerations. The Operator SDK accelerates development while enforcing best practices. Key success factors include:

- Well-designed APIs with proper validation
- Idempotent reconciliation logic
- Comprehensive error handling
- Thorough testing at all levels
- Observability and monitoring
- Security-first approach
- Clear upgrade paths

Operators enable self-service infrastructure while encoding operational expertise, making them essential for modern Kubernetes deployments at scale.