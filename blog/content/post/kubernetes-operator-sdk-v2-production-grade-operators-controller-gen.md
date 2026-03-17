---
title: "Kubernetes Operator SDK v2: Building Production-Grade Operators with controller-gen"
date: 2030-08-02T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Operator SDK", "controller-gen", "Go", "Operators", "OLM", "envtest"]
categories:
- Kubernetes
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep dive into building production-grade Kubernetes operators using Operator SDK v2 and controller-gen: markers, status conditions, reconciler testing with envtest, leader election, OLM integration, and production deployment patterns."
more_link: "yes"
url: "/kubernetes-operator-sdk-v2-production-grade-operators-controller-gen/"
---

Building Kubernetes operators that survive production environments requires more than a working reconcile loop. Operator SDK v2, combined with the `controller-gen` code generation toolchain, provides the scaffolding and patterns needed to deliver operators that handle edge cases gracefully, test reliably, and deploy safely across clusters of any size.

<!--more-->

## Overview

Kubernetes operators encode operational knowledge into software. The gap between a demo operator and a production operator is substantial: production operators must handle partial failures, concurrent reconciliations, leader election, upgrade safety, and observability requirements that simply do not appear in tutorials.

This guide covers Operator SDK v2 from project initialization through production deployment, focusing on the patterns that matter most in enterprise environments.

## Project Setup and SDK v2 Scaffolding

### Prerequisites

Install the required toolchain before initializing any project.

```bash
# Install operator-sdk v2
curl -L https://github.com/operator-framework/operator-sdk/releases/download/v1.37.0/operator-sdk_linux_amd64 \
  -o /usr/local/bin/operator-sdk
chmod +x /usr/local/bin/operator-sdk

# Install controller-gen
go install sigs.k8s.io/controller-tools/cmd/controller-gen@v0.16.0

# Install kustomize
curl -s "https://raw.githubusercontent.com/kubernetes-sigs/kustomize/master/hack/install_kustomize.sh" | bash
mv kustomize /usr/local/bin/

# Verify versions
operator-sdk version
controller-gen --version
```

### Initializing the Project

```bash
mkdir webapp-operator && cd webapp-operator

operator-sdk init \
  --domain support.tools \
  --repo github.com/supporttools/webapp-operator \
  --plugins go/v4

# Create the primary API
operator-sdk create api \
  --group apps \
  --version v1alpha1 \
  --kind WebApp \
  --resource \
  --controller
```

This produces a project layout compatible with kubebuilder v4 conventions:

```
webapp-operator/
├── api/
│   └── v1alpha1/
│       ├── groupversion_info.go
│       ├── webapp_types.go
│       └── zz_generated.deepcopy.go
├── cmd/
│   └── main.go
├── config/
│   ├── crd/
│   ├── default/
│   ├── manager/
│   ├── prometheus/
│   └── rbac/
├── internal/
│   └── controller/
│       ├── suite_test.go
│       └── webapp_controller.go
├── Dockerfile
├── Makefile
└── PROJECT
```

## Designing the API with controller-gen Markers

### Type Definitions with Validation Markers

The `webapp_types.go` file defines the CRD schema. controller-gen reads Go struct tags and comments to generate the OpenAPI v3 validation schema embedded in the CRD manifest.

```go
// api/v1alpha1/webapp_types.go
package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// WebAppSpec defines the desired state of WebApp
type WebAppSpec struct {
	// Replicas is the desired number of pod replicas.
	// +kubebuilder:validation:Minimum=0
	// +kubebuilder:validation:Maximum=100
	// +kubebuilder:default=1
	Replicas int32 `json:"replicas"`

	// Image is the container image to deploy.
	// +kubebuilder:validation:Pattern=`^[a-z0-9]+([._/-][a-z0-9]+)*:[a-zA-Z0-9._-]+$`
	Image string `json:"image"`

	// Port is the container port to expose.
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=65535
	// +kubebuilder:default=8080
	// +optional
	Port int32 `json:"port,omitempty"`

	// Resources specifies the compute resource requirements.
	// +optional
	Resources *ResourceRequirements `json:"resources,omitempty"`

	// IngressEnabled controls whether an Ingress is created.
	// +kubebuilder:default=false
	// +optional
	IngressEnabled bool `json:"ingressEnabled,omitempty"`

	// Hostname is required when IngressEnabled is true.
	// +optional
	Hostname string `json:"hostname,omitempty"`

	// UpdateStrategy controls rolling update behavior.
	// +kubebuilder:validation:Enum=RollingUpdate;Recreate
	// +kubebuilder:default=RollingUpdate
	// +optional
	UpdateStrategy string `json:"updateStrategy,omitempty"`
}

// ResourceRequirements mirrors core/v1 but with kubebuilder validation.
type ResourceRequirements struct {
	// +optional
	CPURequest string `json:"cpuRequest,omitempty"`
	// +optional
	MemoryRequest string `json:"memoryRequest,omitempty"`
	// +optional
	CPULimit string `json:"cpuLimit,omitempty"`
	// +optional
	MemoryLimit string `json:"memoryLimit,omitempty"`
}

// WebAppStatus defines the observed state of WebApp
type WebAppStatus struct {
	// Conditions represent the latest available observations of the WebApp's state.
	// +listType=map
	// +listMapKey=type
	// +patchStrategy=merge
	// +patchMergeKey=type
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty" patchStrategy:"merge" patchMergeKey:"type"`

	// ReadyReplicas is the number of pods in the Ready state.
	// +optional
	ReadyReplicas int32 `json:"readyReplicas,omitempty"`

	// AvailableReplicas is the number of pods available to serve traffic.
	// +optional
	AvailableReplicas int32 `json:"availableReplicas,omitempty"`

	// ObservedGeneration is the most recent generation the controller has reconciled.
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`

	// Phase summarizes the overall state.
	// +kubebuilder:validation:Enum=Pending;Progressing;Available;Degraded;Failed
	// +optional
	Phase string `json:"phase,omitempty"`

	// IngressHostname is the assigned hostname when IngressEnabled is true.
	// +optional
	IngressHostname string `json:"ingressHostname,omitempty"`
}

// Condition type constants
const (
	ConditionTypeAvailable   = "Available"
	ConditionTypeProgressing = "Progressing"
	ConditionTypeDegraded    = "Degraded"

	ReasonDeploymentAvailable   = "DeploymentAvailable"
	ReasonDeploymentProgressing = "DeploymentProgressing"
	ReasonDeploymentFailed      = "DeploymentFailed"
	ReasonReconciling           = "Reconciling"
)

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:subresource:scale:specpath=.spec.replicas,statuspath=.status.readyReplicas
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="Ready",type=string,JSONPath=`.status.readyReplicas`
// +kubebuilder:printcolumn:name="Available",type=string,JSONPath=`.status.availableReplicas`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`
// +kubebuilder:resource:shortName=wa;webapps,scope=Namespaced,categories=apps

// WebApp is the Schema for the webapps API
type WebApp struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   WebAppSpec   `json:"spec,omitempty"`
	Status WebAppStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true
// WebAppList contains a list of WebApp
type WebAppList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []WebApp `json:"items"`
}

func init() {
	SchemeBuilder.Register(&WebApp{}, &WebAppList{})
}
```

### Generating CRD Manifests and RBAC

```bash
# Generate CRD manifests from type markers
make generate manifests

# This runs:
# controller-gen object:headerFile="hack/boilerplate.go.txt" paths="./..."
# controller-gen crd rbac:roleName=manager-role webhook paths="./..." output:crd:artifacts:config=config/crd/bases
```

The generated CRD includes the full OpenAPI validation schema:

```yaml
# config/crd/bases/apps.support.tools_webapps.yaml (excerpt)
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: webapps.apps.support.tools
spec:
  group: apps.support.tools
  names:
    categories:
    - apps
    kind: WebApp
    listKind: WebAppList
    plural: webapps
    shortNames:
    - wa
    - webapps
    singular: webapp
  scope: Namespaced
  versions:
  - additionalPrinterColumns:
    - jsonPath: .status.phase
      name: Phase
      type: string
    - jsonPath: .status.readyReplicas
      name: Ready
      type: string
    name: v1alpha1
    schema:
      openAPIV3Schema:
        properties:
          spec:
            properties:
              image:
                pattern: ^[a-z0-9]+([._/-][a-z0-9]+)*:[a-zA-Z0-9._-]+$
                type: string
              replicas:
                default: 1
                format: int32
                maximum: 100
                minimum: 0
                type: integer
            required:
            - image
            - replicas
            type: object
    served: true
    storage: true
    subresources:
      scale:
        specReplicasPath: .spec.replicas
        statusReplicasPath: .status.readyReplicas
      status: {}
```

## Writing the Reconciler

### Core Reconciler Structure

```go
// internal/controller/webapp_controller.go
package controller

import (
	"context"
	"fmt"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	"k8s.io/apimachinery/pkg/api/equality"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/intstr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/builder"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/predicate"

	appsv1alpha1 "github.com/supporttools/webapp-operator/api/v1alpha1"
)

const (
	webAppFinalizer       = "apps.support.tools/finalizer"
	requeueAfterNormal    = 30 * time.Second
	requeueAfterDegraded  = 10 * time.Second
)

// WebAppReconciler reconciles a WebApp object
// +kubebuilder:rbac:groups=apps.support.tools,resources=webapps,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=apps.support.tools,resources=webapps/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=apps.support.tools,resources=webapps/finalizers,verbs=update
// +kubebuilder:rbac:groups=apps,resources=deployments,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=services,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=networking.k8s.io,resources=ingresses,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=events,verbs=create;patch

type WebAppReconciler struct {
	client.Client
	Scheme   *runtime.Scheme
	Recorder record.EventRecorder
}

func (r *WebAppReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := log.FromContext(ctx)

	// Fetch the WebApp instance
	webapp := &appsv1alpha1.WebApp{}
	if err := r.Get(ctx, req.NamespacedName, webapp); err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, fmt.Errorf("failed to get WebApp: %w", err)
	}

	// Handle deletion
	if !webapp.DeletionTimestamp.IsZero() {
		return r.handleDeletion(ctx, webapp)
	}

	// Ensure finalizer is registered
	if !controllerutil.ContainsFinalizer(webapp, webAppFinalizer) {
		controllerutil.AddFinalizer(webapp, webAppFinalizer)
		if err := r.Update(ctx, webapp); err != nil {
			return ctrl.Result{}, fmt.Errorf("failed to add finalizer: %w", err)
		}
		return ctrl.Result{Requeue: true}, nil
	}

	// Set initial progressing condition
	if err := r.setProgressingCondition(ctx, webapp, "ReconcileStarted", "Reconciliation has started"); err != nil {
		return ctrl.Result{}, err
	}

	// Reconcile child resources
	if err := r.reconcileDeployment(ctx, webapp); err != nil {
		r.setDegradedCondition(ctx, webapp, appsv1alpha1.ReasonDeploymentFailed, err.Error())
		return ctrl.Result{RequeueAfter: requeueAfterDegraded}, err
	}

	if err := r.reconcileService(ctx, webapp); err != nil {
		r.setDegradedCondition(ctx, webapp, "ServiceFailed", err.Error())
		return ctrl.Result{RequeueAfter: requeueAfterDegraded}, err
	}

	if webapp.Spec.IngressEnabled {
		if err := r.reconcileIngress(ctx, webapp); err != nil {
			r.setDegradedCondition(ctx, webapp, "IngressFailed", err.Error())
			return ctrl.Result{RequeueAfter: requeueAfterDegraded}, err
		}
	}

	// Update status from child resource state
	if err := r.updateStatus(ctx, webapp); err != nil {
		return ctrl.Result{}, err
	}

	log.Info("Reconciliation complete", "phase", webapp.Status.Phase)
	return ctrl.Result{RequeueAfter: requeueAfterNormal}, nil
}
```

### Status Conditions Pattern

Condition management using `apimachinery/pkg/api/meta` is the recommended pattern for operator status:

```go
func (r *WebAppReconciler) setProgressingCondition(
	ctx context.Context,
	webapp *appsv1alpha1.WebApp,
	reason, message string,
) error {
	meta.SetStatusCondition(&webapp.Status.Conditions, metav1.Condition{
		Type:               appsv1alpha1.ConditionTypeProgressing,
		Status:             metav1.ConditionTrue,
		ObservedGeneration: webapp.Generation,
		Reason:             reason,
		Message:            message,
	})
	meta.SetStatusCondition(&webapp.Status.Conditions, metav1.Condition{
		Type:               appsv1alpha1.ConditionTypeAvailable,
		Status:             metav1.ConditionFalse,
		ObservedGeneration: webapp.Generation,
		Reason:             appsv1alpha1.ReasonReconciling,
		Message:            "Reconciliation in progress",
	})
	return r.Status().Update(ctx, webapp)
}

func (r *WebAppReconciler) setDegradedCondition(
	ctx context.Context,
	webapp *appsv1alpha1.WebApp,
	reason, message string,
) {
	meta.SetStatusCondition(&webapp.Status.Conditions, metav1.Condition{
		Type:               appsv1alpha1.ConditionTypeDegraded,
		Status:             metav1.ConditionTrue,
		ObservedGeneration: webapp.Generation,
		Reason:             reason,
		Message:            message,
	})
	webapp.Status.Phase = "Degraded"
	if err := r.Status().Update(ctx, webapp); err != nil {
		log.FromContext(ctx).Error(err, "Failed to update degraded status")
	}
	r.Recorder.Eventf(webapp, corev1.EventTypeWarning, reason, message)
}

func (r *WebAppReconciler) updateStatus(ctx context.Context, webapp *appsv1alpha1.WebApp) error {
	deploy := &appsv1.Deployment{}
	err := r.Get(ctx, types.NamespacedName{
		Name:      webapp.Name,
		Namespace: webapp.Namespace,
	}, deploy)
	if err != nil {
		return fmt.Errorf("failed to get deployment for status: %w", err)
	}

	webapp.Status.ReadyReplicas = deploy.Status.ReadyReplicas
	webapp.Status.AvailableReplicas = deploy.Status.AvailableReplicas
	webapp.Status.ObservedGeneration = webapp.Generation

	switch {
	case deploy.Status.AvailableReplicas == webapp.Spec.Replicas:
		webapp.Status.Phase = "Available"
		meta.SetStatusCondition(&webapp.Status.Conditions, metav1.Condition{
			Type:               appsv1alpha1.ConditionTypeAvailable,
			Status:             metav1.ConditionTrue,
			ObservedGeneration: webapp.Generation,
			Reason:             appsv1alpha1.ReasonDeploymentAvailable,
			Message:            fmt.Sprintf("%d/%d replicas available", deploy.Status.AvailableReplicas, webapp.Spec.Replicas),
		})
		meta.SetStatusCondition(&webapp.Status.Conditions, metav1.Condition{
			Type:               appsv1alpha1.ConditionTypeProgressing,
			Status:             metav1.ConditionFalse,
			ObservedGeneration: webapp.Generation,
			Reason:             appsv1alpha1.ReasonDeploymentAvailable,
			Message:            "Rollout complete",
		})
	case deploy.Status.ReadyReplicas > 0:
		webapp.Status.Phase = "Progressing"
		meta.SetStatusCondition(&webapp.Status.Conditions, metav1.Condition{
			Type:               appsv1alpha1.ConditionTypeProgressing,
			Status:             metav1.ConditionTrue,
			ObservedGeneration: webapp.Generation,
			Reason:             appsv1alpha1.ReasonDeploymentProgressing,
			Message:            fmt.Sprintf("%d/%d replicas ready", deploy.Status.ReadyReplicas, webapp.Spec.Replicas),
		})
	default:
		webapp.Status.Phase = "Pending"
	}

	return r.Status().Update(ctx, webapp)
}
```

### Deployment Reconciliation with CreateOrUpdate

```go
func (r *WebAppReconciler) reconcileDeployment(ctx context.Context, webapp *appsv1alpha1.WebApp) error {
	deploy := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{
			Name:      webapp.Name,
			Namespace: webapp.Namespace,
		},
	}

	result, err := controllerutil.CreateOrUpdate(ctx, r.Client, deploy, func() error {
		r.buildDeploymentSpec(webapp, deploy)
		return controllerutil.SetControllerReference(webapp, deploy, r.Scheme)
	})
	if err != nil {
		return fmt.Errorf("failed to reconcile Deployment: %w", err)
	}

	if result != controllerutil.OperationResultNone {
		log.FromContext(ctx).Info("Deployment reconciled", "operation", result)
		r.Recorder.Eventf(webapp, corev1.EventTypeNormal, "DeploymentReconciled",
			"Deployment %s/%s %s", deploy.Namespace, deploy.Name, result)
	}
	return nil
}

func (r *WebAppReconciler) buildDeploymentSpec(webapp *appsv1alpha1.WebApp, deploy *appsv1.Deployment) {
	labels := map[string]string{
		"app.kubernetes.io/name":       webapp.Name,
		"app.kubernetes.io/managed-by": "webapp-operator",
		"app.kubernetes.io/version":    webapp.ResourceVersion,
	}

	deploy.Labels = labels
	deploy.Spec.Replicas = &webapp.Spec.Replicas
	deploy.Spec.Selector = &metav1.LabelSelector{
		MatchLabels: map[string]string{"app.kubernetes.io/name": webapp.Name},
	}

	// Preserve existing strategy if set (avoid triggering unnecessary rollouts)
	if deploy.Spec.Strategy.Type == "" {
		if webapp.Spec.UpdateStrategy == "Recreate" {
			deploy.Spec.Strategy = appsv1.DeploymentStrategy{Type: appsv1.RecreateDeploymentStrategyType}
		} else {
			maxSurge := intstr.FromInt(1)
			maxUnavailable := intstr.FromInt(0)
			deploy.Spec.Strategy = appsv1.DeploymentStrategy{
				Type: appsv1.RollingUpdateDeploymentStrategyType,
				RollingUpdate: &appsv1.RollingUpdateDeployment{
					MaxSurge:       &maxSurge,
					MaxUnavailable: &maxUnavailable,
				},
			}
		}
	}

	port := webapp.Spec.Port
	if port == 0 {
		port = 8080
	}

	container := corev1.Container{
		Name:  "webapp",
		Image: webapp.Spec.Image,
		Ports: []corev1.ContainerPort{{ContainerPort: port, Protocol: corev1.ProtocolTCP}},
		ReadinessProbe: &corev1.Probe{
			ProbeHandler: corev1.ProbeHandler{
				HTTPGet: &corev1.HTTPGetAction{
					Path: "/healthz",
					Port: intstr.FromInt32(port),
				},
			},
			InitialDelaySeconds: 5,
			PeriodSeconds:       10,
			FailureThreshold:    3,
		},
		LivenessProbe: &corev1.Probe{
			ProbeHandler: corev1.ProbeHandler{
				HTTPGet: &corev1.HTTPGetAction{
					Path: "/livez",
					Port: intstr.FromInt32(port),
				},
			},
			InitialDelaySeconds: 15,
			PeriodSeconds:       20,
			FailureThreshold:    3,
		},
	}

	if webapp.Spec.Resources != nil {
		res := webapp.Spec.Resources
		container.Resources = corev1.ResourceRequirements{}
		if res.CPURequest != "" || res.MemoryRequest != "" {
			container.Resources.Requests = corev1.ResourceList{}
			if res.CPURequest != "" {
				container.Resources.Requests[corev1.ResourceCPU] = resource.MustParse(res.CPURequest)
			}
			if res.MemoryRequest != "" {
				container.Resources.Requests[corev1.ResourceMemory] = resource.MustParse(res.MemoryRequest)
			}
		}
		if res.CPULimit != "" || res.MemoryLimit != "" {
			container.Resources.Limits = corev1.ResourceList{}
			if res.CPULimit != "" {
				container.Resources.Limits[corev1.ResourceCPU] = resource.MustParse(res.CPULimit)
			}
			if res.MemoryLimit != "" {
				container.Resources.Limits[corev1.ResourceMemory] = resource.MustParse(res.MemoryLimit)
			}
		}
	}

	deploy.Spec.Template = corev1.PodTemplateSpec{
		ObjectMeta: metav1.ObjectMeta{Labels: labels},
		Spec: corev1.PodSpec{
			SecurityContext: &corev1.PodSecurityContext{
				RunAsNonRoot: boolPtr(true),
				SeccompProfile: &corev1.SeccompProfile{
					Type: corev1.SeccompProfileTypeRuntimeDefault,
				},
			},
			Containers: []corev1.Container{container},
		},
	}
}

func boolPtr(b bool) *bool { return &b }
```

## Testing with envtest

### Suite Setup

envtest spins up a real API server and etcd process, giving integration-level confidence without a full cluster:

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
	appsv1 "k8s.io/api/apps/v1"
	"k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/envtest"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"

	appsv1alpha1 "github.com/supporttools/webapp-operator/api/v1alpha1"
	"github.com/supporttools/webapp-operator/internal/controller"
	//+kubebuilder:scaffold:imports
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
		CRDDirectoryPaths:     []string{filepath.Join("..", "..", "config", "crd", "bases")},
		ErrorIfCRDPathMissing: true,
		BinaryAssetsDirectory: filepath.Join("..", "..", "bin", "k8s"),
	}

	cfg, err := testEnv.Start()
	Expect(err).NotTo(HaveOccurred())
	Expect(cfg).NotTo(BeNil())

	err = appsv1alpha1.AddToScheme(scheme.Scheme)
	Expect(err).NotTo(HaveOccurred())
	err = appsv1.AddToScheme(scheme.Scheme)
	Expect(err).NotTo(HaveOccurred())

	k8sManager, err := ctrl.NewManager(cfg, ctrl.Options{
		Scheme: scheme.Scheme,
	})
	Expect(err).NotTo(HaveOccurred())

	err = (&controller.WebAppReconciler{
		Client:   k8sManager.GetClient(),
		Scheme:   k8sManager.GetScheme(),
		Recorder: k8sManager.GetEventRecorderFor("webapp-controller"),
	}).SetupWithManager(k8sManager)
	Expect(err).NotTo(HaveOccurred())

	var ctx context.Context
	ctx, cancelFunc = context.WithCancel(context.Background())
	go func() {
		defer GinkgoRecover()
		err = k8sManager.Start(ctx)
		Expect(err).NotTo(HaveOccurred(), "failed to run manager")
	}()

	k8sClient = k8sManager.GetClient()
})

var _ = AfterSuite(func() {
	cancelFunc()
	Expect(testEnv.Stop()).To(Succeed())
})
```

### Controller Tests

```go
// internal/controller/webapp_controller_test.go
package controller_test

import (
	"context"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"

	appsv1alpha1 "github.com/supporttools/webapp-operator/api/v1alpha1"
)

const (
	timeout  = 30 * time.Second
	interval = 500 * time.Millisecond
)

var _ = Describe("WebApp Controller", func() {
	Context("When creating a WebApp", func() {
		It("Should create a Deployment and Service", func() {
			ctx := context.Background()

			webapp := &appsv1alpha1.WebApp{
				ObjectMeta: metav1.ObjectMeta{
					Name:      "test-webapp",
					Namespace: "default",
				},
				Spec: appsv1alpha1.WebAppSpec{
					Replicas: 2,
					Image:    "nginx:1.27",
					Port:     80,
					Resources: &appsv1alpha1.ResourceRequirements{
						CPURequest:    "100m",
						MemoryRequest: "128Mi",
						CPULimit:      "500m",
						MemoryLimit:   "256Mi",
					},
				},
			}
			Expect(k8sClient.Create(ctx, webapp)).To(Succeed())

			deployLookup := types.NamespacedName{Name: "test-webapp", Namespace: "default"}
			deploy := &appsv1.Deployment{}
			Eventually(func() error {
				return k8sClient.Get(ctx, deployLookup, deploy)
			}, timeout, interval).Should(Succeed())

			Expect(*deploy.Spec.Replicas).To(Equal(int32(2)))
			Expect(deploy.Spec.Template.Spec.Containers[0].Image).To(Equal("nginx:1.27"))

			svc := &corev1.Service{}
			Eventually(func() error {
				return k8sClient.Get(ctx, deployLookup, svc)
			}, timeout, interval).Should(Succeed())

			// Verify owner references
			Expect(svc.OwnerReferences).To(HaveLen(1))
			Expect(svc.OwnerReferences[0].Name).To(Equal("test-webapp"))

			// Verify status eventually becomes Available
			Eventually(func() string {
				wa := &appsv1alpha1.WebApp{}
				if err := k8sClient.Get(ctx, deployLookup, wa); err != nil {
					return ""
				}
				cond := meta.FindStatusCondition(wa.Status.Conditions, appsv1alpha1.ConditionTypeAvailable)
				if cond == nil {
					return ""
				}
				return string(cond.Status)
			}, timeout, interval).Should(Equal("True"))
		})
	})
})
```

## Leader Election Configuration

Leader election prevents split-brain reconciliation when running multiple operator replicas:

```go
// cmd/main.go
func main() {
	var metricsAddr string
	var enableLeaderElection bool
	var probeAddr string
	var leaderElectionID string
	var leaderElectionNamespace string

	flag.StringVar(&metricsAddr, "metrics-bind-address", ":8080", "The address the metric endpoint binds to.")
	flag.StringVar(&probeAddr, "health-probe-bind-address", ":8081", "The address the probe endpoint binds to.")
	flag.BoolVar(&enableLeaderElection, "leader-elect", true, "Enable leader election for high availability.")
	flag.StringVar(&leaderElectionID, "leader-election-id", "webapp-operator.support.tools", "ID for leader election lease.")
	flag.StringVar(&leaderElectionNamespace, "leader-election-namespace", "", "Namespace for leader election objects (defaults to operator namespace).")
	opts := zap.Options{Development: false}
	opts.BindFlags(flag.CommandLine)
	flag.Parse()

	ctrl.SetLogger(zap.New(zap.UseFlagOptions(&opts)))

	mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
		Scheme:                 scheme,
		MetricsBindAddress:     metricsAddr,
		Port:                   9443,
		HealthProbeBindAddress: probeAddr,
		LeaderElection:         enableLeaderElection,
		LeaderElectionID:       leaderElectionID,
		// LeaseDuration is the duration a client should wait before
		// assuming the leader has failed.
		LeaseDuration: durationPtr(15 * time.Second),
		// RenewDeadline is the duration the leader will retry refreshing
		// before giving up.
		RenewDeadline: durationPtr(10 * time.Second),
		// RetryPeriod is the duration non-leader clients should wait
		// before attempting to acquire leadership.
		RetryPeriod: durationPtr(2 * time.Second),
	})
	if err != nil {
		setupLog.Error(err, "unable to start manager")
		os.Exit(1)
	}

	if err = (&controller.WebAppReconciler{
		Client:   mgr.GetClient(),
		Scheme:   mgr.GetScheme(),
		Recorder: mgr.GetEventRecorderFor("webapp-controller"),
	}).SetupWithManager(mgr, controller.Options{
		MaxConcurrentReconciles: 5,
		RateLimiter: workqueue.NewMaxOfRateLimiter(
			workqueue.NewItemExponentialFailureRateLimiter(5*time.Millisecond, 1000*time.Second),
			&workqueue.BucketRateLimiter{Limiter: rate.NewLimiter(rate.Limit(10), 100)},
		),
	}); err != nil {
		setupLog.Error(err, "unable to create controller")
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

	if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
		setupLog.Error(err, "problem running manager")
		os.Exit(1)
	}
}

func durationPtr(d time.Duration) *time.Duration { return &d }
```

## Operator Lifecycle Manager (OLM) Integration

### ClusterServiceVersion Generation

The Operator SDK generates OLM manifests from the operator bundle:

```bash
# Generate the bundle
operator-sdk generate bundle \
  --package webapp-operator \
  --version 0.1.0 \
  --channels stable \
  --default-channel stable \
  --use-image-digests

# Build and push the bundle image
docker build -f bundle.Dockerfile -t registry.support.tools/webapp-operator-bundle:v0.1.0 .
docker push registry.support.tools/webapp-operator-bundle:v0.1.0

# Validate the bundle
operator-sdk bundle validate ./bundle --select-optional name=operatorhub

# Build the catalog image
opm index add \
  --bundles registry.support.tools/webapp-operator-bundle:v0.1.0 \
  --tag registry.support.tools/webapp-operator-catalog:latest \
  --mode semver
```

### OLM Subscription Manifest

```yaml
# config/olm/subscription.yaml
apiVersion: operators.coreos.com/v1alpha1
kind: Subscription
metadata:
  name: webapp-operator
  namespace: operators
spec:
  channel: stable
  name: webapp-operator
  source: webapp-operator-catalog
  sourceNamespace: operators
  installPlanApproval: Automatic
  config:
    resources:
      requests:
        cpu: 100m
        memory: 128Mi
      limits:
        cpu: 500m
        memory: 256Mi
    env:
    - name: WATCH_NAMESPACE
      value: ""
    - name: OPERATOR_NAME
      value: webapp-operator
---
apiVersion: operators.coreos.com/v1
kind: OperatorGroup
metadata:
  name: webapp-operator-group
  namespace: operators
spec:
  targetNamespaces: []  # cluster-wide
```

## Production Deployment

### Operator Deployment Manifest

```yaml
# config/manager/manager.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: webapp-operator-controller-manager
  namespace: webapp-operator-system
  labels:
    control-plane: controller-manager
    app.kubernetes.io/name: webapp-operator
    app.kubernetes.io/component: manager
spec:
  replicas: 2
  selector:
    matchLabels:
      control-plane: controller-manager
  template:
    metadata:
      labels:
        control-plane: controller-manager
      annotations:
        kubectl.kubernetes.io/default-container: manager
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchLabels:
                control-plane: controller-manager
            topologyKey: kubernetes.io/hostname
      securityContext:
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault
      serviceAccountName: webapp-operator-controller-manager
      terminationGracePeriodSeconds: 10
      priorityClassName: system-cluster-critical
      containers:
      - name: manager
        image: registry.support.tools/webapp-operator:v0.1.0
        args:
        - --leader-elect
        - --leader-election-id=webapp-operator.support.tools
        - --metrics-bind-address=:8080
        - --health-probe-bind-address=:8081
        - --zap-log-level=info
        - --zap-encoder=json
        command:
        - /manager
        securityContext:
          allowPrivilegeEscalation: false
          capabilities:
            drop:
            - ALL
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
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 256Mi
        ports:
        - containerPort: 8080
          name: metrics
          protocol: TCP
        - containerPort: 8081
          name: health
          protocol: TCP
```

### PodDisruptionBudget and RBAC

```yaml
# config/rbac/leader_election_role.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: webapp-operator-leader-election-role
  namespace: webapp-operator-system
rules:
- apiGroups: [""]
  resources: [configmaps]
  verbs: [get, list, watch, create, update, patch, delete]
- apiGroups: [coordination.k8s.io]
  resources: [leases]
  verbs: [get, list, watch, create, update, patch, delete]
- apiGroups: [""]
  resources: [events]
  verbs: [create, patch]
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: webapp-operator-pdb
  namespace: webapp-operator-system
spec:
  minAvailable: 1
  selector:
    matchLabels:
      control-plane: controller-manager
```

## Watching Child Resources and Predicates

Efficient watch configuration reduces reconciler invocations:

```go
func (r *WebAppReconciler) SetupWithManager(mgr ctrl.Manager, opts controller.Options) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&appsv1alpha1.WebApp{},
			builder.WithPredicates(predicate.GenerationChangedPredicate{}),
		).
		Owns(&appsv1.Deployment{},
			builder.WithPredicates(predicate.ResourceVersionChangedPredicate{}),
		).
		Owns(&corev1.Service{}).
		Owns(&networkingv1.Ingress{}).
		WithOptions(opts).
		Complete(r)
}
```

`GenerationChangedPredicate` prevents reconciling on status-only updates, which would otherwise cause infinite reconcile loops when the controller writes status updates.

## Upgrade Safety and Version Conversion

For operators with multiple API versions, implement a conversion webhook:

```bash
# Create a new API version
operator-sdk create api \
  --group apps \
  --version v1beta1 \
  --kind WebApp \
  --resource=false \
  --controller=false

# Create the conversion webhook
operator-sdk create webhook \
  --group apps \
  --version v1alpha1 \
  --kind WebApp \
  --conversion
```

The hub version (storage version) must implement the `conversion.Hub` marker:

```go
// api/v1beta1/webapp_conversion.go
package v1beta1

// Hub marks this type as a conversion hub.
func (*WebApp) Hub() {}
```

## Monitoring and Observability

Register custom metrics in the reconciler:

```go
var (
	reconcileTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "webapp_operator_reconcile_total",
			Help: "Total number of reconciliations per WebApp.",
		},
		[]string{"namespace", "name", "result"},
	)
	reconcileDuration = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "webapp_operator_reconcile_duration_seconds",
			Help:    "Duration of reconciliation in seconds.",
			Buckets: prometheus.DefBuckets,
		},
		[]string{"namespace", "name"},
	)
)

func init() {
	metrics.Registry.MustRegister(reconcileTotal, reconcileDuration)
}
```

## Troubleshooting Common Issues

### Reconcile Loop Storms

Symptom: controller CPU spikes and reconcile counts grow rapidly.

Root cause: status updates trigger watches, which trigger reconciles.

Fix: use `GenerationChangedPredicate` for `For()` and ensure status updates only happen when values change:

```go
// Compare before updating
if !equality.Semantic.DeepEqual(webapp.Status, previousStatus) {
    if err := r.Status().Update(ctx, webapp); err != nil {
        return ctrl.Result{}, err
    }
}
```

### Stale Cache Reads

After creating a child resource, the informer cache may not have the new object yet. Use `r.Get()` with retry logic or rely on the watch to trigger a subsequent reconcile rather than re-reading immediately.

### Finalizer Deadlock

If the operator crashes with a finalizer registered but before cleanup logic completes, the object will be stuck in deletion. Always implement idempotent cleanup logic and handle already-deleted resources gracefully:

```go
func (r *WebAppReconciler) handleDeletion(ctx context.Context, webapp *appsv1alpha1.WebApp) (ctrl.Result, error) {
	if !controllerutil.ContainsFinalizer(webapp, webAppFinalizer) {
		return ctrl.Result{}, nil
	}
	// External cleanup (e.g., DNS records, cloud load balancers)
	if err := r.performCleanup(ctx, webapp); err != nil {
		return ctrl.Result{RequeueAfter: 5 * time.Second}, err
	}
	controllerutil.RemoveFinalizer(webapp, webAppFinalizer)
	return ctrl.Result{}, r.Update(ctx, webapp)
}
```

## Summary

Building production-grade Kubernetes operators with Operator SDK v2 requires thoughtful design across several dimensions: correct use of controller-gen markers for validation and RBAC generation, status conditions that accurately reflect operator intent versus observed state, comprehensive envtest coverage, leader election for HA deployments, and OLM packaging for enterprise distribution. The patterns covered here form the foundation of operators that scale reliably in multi-tenant cluster environments.
