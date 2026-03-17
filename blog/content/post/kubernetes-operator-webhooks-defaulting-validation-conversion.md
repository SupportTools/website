---
title: "Kubernetes Operator Webhooks: Defaulting, Validation, and Conversion Webhooks"
date: 2030-07-19T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Operators", "Webhooks", "CRD", "Admission Control", "Go", "controller-runtime"]
categories:
- Kubernetes
- Operators
- Development
author: "Matthew Mattox - mmattox@support.tools"
description: "Production operator webhook guide covering defaulting webhooks for CRD fields, validation webhook logic, conversion webhooks for API version migration, webhook server TLS management, and end-to-end testing strategies."
more_link: "yes"
url: "/kubernetes-operator-webhooks-defaulting-validation-conversion/"
---

Kubernetes admission webhooks extend the API server's request handling pipeline with custom logic executed before resources are persisted. For Kubernetes operators, webhooks serve three critical purposes: defaulting ensures CRD instances have complete specifications by filling in optional fields, validating webhooks enforce business rules that cannot be expressed in OpenAPI schema, and conversion webhooks enable operators to evolve CRD APIs across multiple versions while preserving backward compatibility. Implementing these correctly requires understanding the webhook invocation lifecycle, TLS certificate management, and how to test webhooks both in isolation and against a real cluster.

<!--more-->

## Webhook Architecture

The Kubernetes API server calls webhooks synchronously during resource admission. The flow for a `CREATE` request:

1. Request arrives at the API server
2. Authentication and authorization (RBAC) evaluation
3. **Mutating admission webhooks** are called (including defaulting webhooks)
4. Object schema validation
5. **Validating admission webhooks** are called
6. Resource is persisted to etcd

For CRD version conversion, the conversion webhook is called separately when a stored object is served at a different API version than it was stored.

## Webhook Server Setup with controller-runtime

### Project Structure

```
myoperator/
├── api/
│   ├── v1alpha1/
│   │   ├── types.go
│   │   ├── webhook_defaulter.go
│   │   ├── webhook_validator.go
│   │   └── zz_generated.deepcopy.go
│   └── v1beta1/
│       ├── types.go
│       ├── webhook_defaulter.go
│       ├── webhook_validator.go
│       └── conversion.go
├── cmd/
│   └── main.go
└── config/
    └── webhook/
        ├── manifests.yaml
        └── service.yaml
```

### Main Entrypoint with Webhook Registration

```go
package main

import (
    "os"

    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/log/zap"
    "sigs.k8s.io/controller-runtime/pkg/metrics/server"
    "sigs.k8s.io/controller-runtime/pkg/webhook"

    myoperatorv1alpha1 "github.com/example/myoperator/api/v1alpha1"
    myoperatorv1beta1 "github.com/example/myoperator/api/v1beta1"
    "github.com/example/myoperator/internal/controller"
)

func main() {
    opts := zap.Options{Development: false}
    ctrl.SetLogger(zap.New(zap.UseFlagOptions(&opts)))

    mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
        Scheme: scheme,
        Metrics: server.Options{
            BindAddress: ":8080",
        },
        WebhookServer: webhook.NewServer(webhook.Options{
            Port:    9443,
            CertDir: "/tmp/k8s-webhook-server/serving-certs",
        }),
        LeaderElection:          true,
        LeaderElectionID:        "myoperator-leader.example.com",
        LeaderElectionNamespace: "myoperator-system",
    })
    if err != nil {
        ctrl.Log.Error(err, "unable to start manager")
        os.Exit(1)
    }

    // Register defaulting and validating webhooks for v1alpha1
    if err := (&myoperatorv1alpha1.MyResource{}).SetupWebhookWithManager(mgr); err != nil {
        ctrl.Log.Error(err, "unable to set up webhook for MyResource v1alpha1")
        os.Exit(1)
    }

    // Register defaulting and validating webhooks for v1beta1
    if err := (&myoperatorv1beta1.MyResource{}).SetupWebhookWithManager(mgr); err != nil {
        ctrl.Log.Error(err, "unable to set up webhook for MyResource v1beta1")
        os.Exit(1)
    }

    // Register controllers
    if err := (&controller.MyResourceReconciler{
        Client: mgr.GetClient(),
        Scheme: mgr.GetScheme(),
    }).SetupWithManager(mgr); err != nil {
        ctrl.Log.Error(err, "unable to create controller", "controller", "MyResource")
        os.Exit(1)
    }

    if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
        ctrl.Log.Error(err, "problem running manager")
        os.Exit(1)
    }
}
```

## CRD Type Definition

```go
// api/v1alpha1/types.go
package v1alpha1

import (
    "k8s.io/apimachinery/pkg/api/resource"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// MyResourceSpec defines the desired state of MyResource
type MyResourceSpec struct {
    // Replicas is the desired number of instances. Defaults to 1.
    // +optional
    // +kubebuilder:default=1
    // +kubebuilder:validation:Minimum=0
    // +kubebuilder:validation:Maximum=100
    Replicas *int32 `json:"replicas,omitempty"`

    // Image is the container image to use.
    // +kubebuilder:validation:Required
    // +kubebuilder:validation:Pattern=`^[a-zA-Z0-9][a-zA-Z0-9._/-]*:[a-zA-Z0-9._-]+$`
    Image string `json:"image"`

    // Resources defines the compute resource requirements.
    // +optional
    Resources ResourceRequirements `json:"resources,omitempty"`

    // StorageSize defines the persistent volume size.
    // +optional
    StorageSize *resource.Quantity `json:"storageSize,omitempty"`

    // ServiceAccount is the name of the service account to use.
    // +optional
    ServiceAccount string `json:"serviceAccount,omitempty"`

    // Config holds arbitrary configuration.
    // +optional
    Config map[string]string `json:"config,omitempty"`

    // HighAvailability enables HA mode with multiple replicas and anti-affinity.
    // +optional
    HighAvailability *HighAvailabilityConfig `json:"highAvailability,omitempty"`
}

type ResourceRequirements struct {
    // +optional
    CPU    string `json:"cpu,omitempty"`
    // +optional
    Memory string `json:"memory,omitempty"`
}

type HighAvailabilityConfig struct {
    // Enabled turns on HA mode.
    Enabled bool `json:"enabled"`
    // MinReplicas is the minimum number of replicas in HA mode. Defaults to 3.
    // +optional
    MinReplicas *int32 `json:"minReplicas,omitempty"`
}

// MyResourceStatus defines the observed state of MyResource
type MyResourceStatus struct {
    // +optional
    Ready bool `json:"ready,omitempty"`
    // +optional
    ReadyReplicas int32 `json:"readyReplicas,omitempty"`
    // +optional
    Conditions []metav1.Condition `json:"conditions,omitempty"`
    // +optional
    ObservedGeneration int64 `json:"observedGeneration,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:scope=Namespaced,shortName=mr
// +kubebuilder:printcolumn:name="Replicas",type="integer",JSONPath=".spec.replicas"
// +kubebuilder:printcolumn:name="Ready",type="boolean",JSONPath=".status.ready"
// +kubebuilder:printcolumn:name="Age",type="date",JSONPath=".metadata.creationTimestamp"

// MyResource is the Schema for the myresources API
type MyResource struct {
    metav1.TypeMeta   `json:",inline"`
    metav1.ObjectMeta `json:"metadata,omitempty"`

    Spec   MyResourceSpec   `json:"spec,omitempty"`
    Status MyResourceStatus `json:"status,omitempty"`
}
```

## Defaulting Webhook

### Implementation

```go
// api/v1alpha1/webhook_defaulter.go
package v1alpha1

import (
    "context"

    "k8s.io/apimachinery/pkg/api/resource"
    "k8s.io/utils/ptr"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/webhook"
    "sigs.k8s.io/controller-runtime/pkg/webhook/admission"
)

var _ webhook.CustomDefaulter = &MyResource{}

// SetupWebhookWithManager registers the webhooks with the manager
func (r *MyResource) SetupWebhookWithManager(mgr ctrl.Manager) error {
    return ctrl.NewWebhookManagedBy(mgr).
        For(r).
        WithDefaulter(r).
        WithValidator(r).
        Complete()
}

// Default implements webhook.CustomDefaulter
func (r *MyResource) Default(ctx context.Context, obj runtime.Object) error {
    mr, ok := obj.(*MyResource)
    if !ok {
        return fmt.Errorf("expected a MyResource but got %T", obj)
    }

    log := ctrl.LoggerFrom(ctx).WithValues("name", mr.Name, "namespace", mr.Namespace)
    log.Info("Applying defaults to MyResource")

    // Default replicas to 1
    if mr.Spec.Replicas == nil {
        mr.Spec.Replicas = ptr.To[int32](1)
        log.V(1).Info("Defaulted replicas to 1")
    }

    // Default service account name
    if mr.Spec.ServiceAccount == "" {
        mr.Spec.ServiceAccount = "default"
        log.V(1).Info("Defaulted serviceAccount to 'default'")
    }

    // Default storage size if not specified
    if mr.Spec.StorageSize == nil {
        defaultSize := resource.MustParse("10Gi")
        mr.Spec.StorageSize = &defaultSize
        log.V(1).Info("Defaulted storageSize to 10Gi")
    }

    // Default resource requests
    if mr.Spec.Resources.CPU == "" {
        mr.Spec.Resources.CPU = "100m"
    }
    if mr.Spec.Resources.Memory == "" {
        mr.Spec.Resources.Memory = "128Mi"
    }

    // Default HA config when HA is enabled
    if mr.Spec.HighAvailability != nil && mr.Spec.HighAvailability.Enabled {
        if mr.Spec.HighAvailability.MinReplicas == nil {
            mr.Spec.HighAvailability.MinReplicas = ptr.To[int32](3)
            log.V(1).Info("Defaulted HA minReplicas to 3")
        }
        // Ensure replicas meets HA minimum
        minReplicas := *mr.Spec.HighAvailability.MinReplicas
        if mr.Spec.Replicas != nil && *mr.Spec.Replicas < minReplicas {
            log.Info("Increasing replicas to meet HA minimum",
                "current", *mr.Spec.Replicas, "minimum", minReplicas)
            mr.Spec.Replicas = ptr.To[int32](minReplicas)
        }
    }

    // Initialize config map if nil
    if mr.Spec.Config == nil {
        mr.Spec.Config = make(map[string]string)
    }

    return nil
}
```

## Validating Webhook

### Implementation with Business Logic

```go
// api/v1alpha1/webhook_validator.go
package v1alpha1

import (
    "context"
    "fmt"
    "regexp"

    "k8s.io/apimachinery/pkg/api/resource"
    "k8s.io/apimachinery/pkg/runtime"
    "k8s.io/apimachinery/pkg/util/validation/field"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/webhook/admission"
)

var _ webhook.CustomValidator = &MyResource{}

// validImagePattern allows image:tag format
var validImagePattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._\-/:@]+$`)

// ValidateCreate implements webhook.CustomValidator for CREATE operations
func (r *MyResource) ValidateCreate(ctx context.Context, obj runtime.Object) (admission.Warnings, error) {
    mr, ok := obj.(*MyResource)
    if !ok {
        return nil, fmt.Errorf("expected MyResource, got %T", obj)
    }

    ctrl.LoggerFrom(ctx).Info("Validating MyResource create", "name", mr.Name)

    var allErrs field.ErrorList
    allErrs = append(allErrs, r.validateSpec(ctx, mr)...)

    if len(allErrs) > 0 {
        return nil, allErrs.ToAggregate()
    }

    return nil, nil
}

// ValidateUpdate implements webhook.CustomValidator for UPDATE operations
func (r *MyResource) ValidateUpdate(ctx context.Context, oldObj, newObj runtime.Object) (admission.Warnings, error) {
    oldMR, ok := oldObj.(*MyResource)
    if !ok {
        return nil, fmt.Errorf("expected MyResource for old object, got %T", oldObj)
    }
    newMR, ok := newObj.(*MyResource)
    if !ok {
        return nil, fmt.Errorf("expected MyResource for new object, got %T", newObj)
    }

    ctrl.LoggerFrom(ctx).Info("Validating MyResource update", "name", newMR.Name)

    var allErrs field.ErrorList
    allErrs = append(allErrs, r.validateSpec(ctx, newMR)...)
    allErrs = append(allErrs, r.validateImmutableFields(oldMR, newMR)...)
    allErrs = append(allErrs, r.validateScaleDown(oldMR, newMR)...)

    if len(allErrs) > 0 {
        return nil, allErrs.ToAggregate()
    }

    return nil, nil
}

// ValidateDelete implements webhook.CustomValidator for DELETE operations
func (r *MyResource) ValidateDelete(ctx context.Context, obj runtime.Object) (admission.Warnings, error) {
    mr, ok := obj.(*MyResource)
    if !ok {
        return nil, fmt.Errorf("expected MyResource, got %T", obj)
    }

    // Check for deletion protection annotation
    if val, ok := mr.Annotations["myoperator.example.com/deletion-protected"]; ok && val == "true" {
        return nil, field.Forbidden(
            field.NewPath("metadata", "annotations"),
            "resource has deletion protection enabled; remove the annotation first",
        )
    }

    return nil, nil
}

func (r *MyResource) validateSpec(ctx context.Context, mr *MyResource) field.ErrorList {
    var allErrs field.ErrorList
    specPath := field.NewPath("spec")

    // Validate image format
    if mr.Spec.Image == "" {
        allErrs = append(allErrs, field.Required(specPath.Child("image"), "image is required"))
    } else if !validImagePattern.MatchString(mr.Spec.Image) {
        allErrs = append(allErrs, field.Invalid(
            specPath.Child("image"),
            mr.Spec.Image,
            "image must be a valid container image reference",
        ))
    }

    // Validate replicas
    if mr.Spec.Replicas != nil {
        replicas := *mr.Spec.Replicas
        if replicas < 0 {
            allErrs = append(allErrs, field.Invalid(
                specPath.Child("replicas"),
                replicas,
                "replicas must be non-negative",
            ))
        }
        if replicas > 100 {
            allErrs = append(allErrs, field.Invalid(
                specPath.Child("replicas"),
                replicas,
                "replicas must not exceed 100",
            ))
        }
    }

    // Validate storage size
    if mr.Spec.StorageSize != nil {
        minSize := resource.MustParse("1Gi")
        maxSize := resource.MustParse("10Ti")
        if mr.Spec.StorageSize.Cmp(minSize) < 0 {
            allErrs = append(allErrs, field.Invalid(
                specPath.Child("storageSize"),
                mr.Spec.StorageSize.String(),
                "storageSize must be at least 1Gi",
            ))
        }
        if mr.Spec.StorageSize.Cmp(maxSize) > 0 {
            allErrs = append(allErrs, field.Invalid(
                specPath.Child("storageSize"),
                mr.Spec.StorageSize.String(),
                "storageSize must not exceed 10Ti",
            ))
        }
    }

    // Validate HA config consistency
    if mr.Spec.HighAvailability != nil && mr.Spec.HighAvailability.Enabled {
        haPath := specPath.Child("highAvailability")
        if mr.Spec.HighAvailability.MinReplicas != nil {
            min := *mr.Spec.HighAvailability.MinReplicas
            if min < 2 {
                allErrs = append(allErrs, field.Invalid(
                    haPath.Child("minReplicas"),
                    min,
                    "HA mode requires at least 2 replicas",
                ))
            }
        }
        if mr.Spec.Replicas != nil && mr.Spec.HighAvailability.MinReplicas != nil {
            if *mr.Spec.Replicas < *mr.Spec.HighAvailability.MinReplicas {
                allErrs = append(allErrs, field.Invalid(
                    specPath.Child("replicas"),
                    *mr.Spec.Replicas,
                    fmt.Sprintf("replicas must be >= highAvailability.minReplicas (%d) when HA is enabled",
                        *mr.Spec.HighAvailability.MinReplicas),
                ))
            }
        }
    }

    // Validate resource requests
    if mr.Spec.Resources.CPU != "" {
        if _, err := resource.ParseQuantity(mr.Spec.Resources.CPU); err != nil {
            allErrs = append(allErrs, field.Invalid(
                specPath.Child("resources", "cpu"),
                mr.Spec.Resources.CPU,
                fmt.Sprintf("invalid CPU quantity: %v", err),
            ))
        }
    }
    if mr.Spec.Resources.Memory != "" {
        if _, err := resource.ParseQuantity(mr.Spec.Resources.Memory); err != nil {
            allErrs = append(allErrs, field.Invalid(
                specPath.Child("resources", "memory"),
                mr.Spec.Resources.Memory,
                fmt.Sprintf("invalid memory quantity: %v", err),
            ))
        }
    }

    return allErrs
}

func (r *MyResource) validateImmutableFields(old, new *MyResource) field.ErrorList {
    var allErrs field.ErrorList

    // StorageSize is immutable (cannot shrink PVCs)
    if old.Spec.StorageSize != nil && new.Spec.StorageSize != nil {
        if new.Spec.StorageSize.Cmp(*old.Spec.StorageSize) < 0 {
            allErrs = append(allErrs, field.Forbidden(
                field.NewPath("spec", "storageSize"),
                "storageSize cannot be decreased",
            ))
        }
    }

    return allErrs
}

func (r *MyResource) validateScaleDown(old, new *MyResource) field.ErrorList {
    var allErrs field.ErrorList
    var warnings admission.Warnings

    if old.Spec.Replicas != nil && new.Spec.Replicas != nil {
        oldReplicas := *old.Spec.Replicas
        newReplicas := *new.Spec.Replicas
        if newReplicas < oldReplicas && newReplicas == 0 {
            allErrs = append(allErrs, field.Forbidden(
                field.NewPath("spec", "replicas"),
                "scaling to 0 replicas is not allowed; use a pause annotation instead",
            ))
        }
    }

    return allErrs
}
```

## Conversion Webhook

Conversion webhooks enable serving a CRD at multiple API versions while storing objects in a single hub version.

### Hub Version Designation

```go
// api/v1beta1/conversion.go
package v1beta1

// Hub marks v1beta1 as the hub version for conversion
// All other versions convert to/from this version
func (*MyResource) Hub() {}
```

### Spoke Version Conversion

```go
// api/v1alpha1/conversion.go
package v1alpha1

import (
    "fmt"

    "sigs.k8s.io/controller-runtime/pkg/conversion"

    myoperatorv1beta1 "github.com/example/myoperator/api/v1beta1"
)

var _ conversion.Convertible = &MyResource{}

// ConvertTo converts this v1alpha1 MyResource to the hub version (v1beta1)
func (src *MyResource) ConvertTo(dstRaw conversion.Hub) error {
    dst, ok := dstRaw.(*myoperatorv1beta1.MyResource)
    if !ok {
        return fmt.Errorf("ConvertTo: expected *v1beta1.MyResource, got %T", dstRaw)
    }

    // Copy ObjectMeta
    dst.ObjectMeta = src.ObjectMeta

    // Convert spec fields
    dst.Spec.Image = src.Spec.Image

    if src.Spec.Replicas != nil {
        dst.Spec.Replicas = src.Spec.Replicas
    }

    // v1alpha1 Resources (CPU/Memory strings) -> v1beta1 corev1.ResourceRequirements
    if src.Spec.Resources.CPU != "" || src.Spec.Resources.Memory != "" {
        dst.Spec.Resources = convertResources(src.Spec.Resources)
    }

    dst.Spec.StorageSize = src.Spec.StorageSize
    dst.Spec.ServiceAccount = src.Spec.ServiceAccount
    dst.Spec.Config = src.Spec.Config

    // v1alpha1 HighAvailability -> v1beta1 equivalent
    if src.Spec.HighAvailability != nil {
        dst.Spec.HighAvailability = &myoperatorv1beta1.HighAvailabilityConfig{
            Enabled:     src.Spec.HighAvailability.Enabled,
            MinReplicas: src.Spec.HighAvailability.MinReplicas,
        }
    }

    // Convert status
    dst.Status.Ready = src.Status.Ready
    dst.Status.ReadyReplicas = src.Status.ReadyReplicas
    dst.Status.Conditions = src.Status.Conditions
    dst.Status.ObservedGeneration = src.Status.ObservedGeneration

    // Preserve annotations used for conversion metadata
    if dst.Annotations == nil {
        dst.Annotations = make(map[string]string)
    }
    dst.Annotations["myoperator.example.com/converted-from"] = "v1alpha1"

    return nil
}

// ConvertFrom converts from the hub version (v1beta1) to this v1alpha1
func (dst *MyResource) ConvertFrom(srcRaw conversion.Hub) error {
    src, ok := srcRaw.(*myoperatorv1beta1.MyResource)
    if !ok {
        return fmt.Errorf("ConvertFrom: expected *v1beta1.MyResource, got %T", srcRaw)
    }

    dst.ObjectMeta = src.ObjectMeta
    dst.Spec.Image = src.Spec.Image
    dst.Spec.Replicas = src.Spec.Replicas
    dst.Spec.StorageSize = src.Spec.StorageSize
    dst.Spec.ServiceAccount = src.Spec.ServiceAccount
    dst.Spec.Config = src.Spec.Config

    // v1beta1 corev1.ResourceRequirements -> v1alpha1 strings
    dst.Spec.Resources = convertResourcesFromV1beta1(src.Spec.Resources)

    if src.Spec.HighAvailability != nil {
        dst.Spec.HighAvailability = &HighAvailabilityConfig{
            Enabled:     src.Spec.HighAvailability.Enabled,
            MinReplicas: src.Spec.HighAvailability.MinReplicas,
        }
    }

    dst.Status.Ready = src.Status.Ready
    dst.Status.ReadyReplicas = src.Status.ReadyReplicas
    dst.Status.Conditions = src.Status.Conditions
    dst.Status.ObservedGeneration = src.Status.ObservedGeneration

    return nil
}
```

## Webhook TLS Certificate Management

### Using cert-manager for Webhook TLS

```yaml
# config/webhook/certificate.yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: myoperator-webhook-cert
  namespace: myoperator-system
spec:
  secretName: myoperator-webhook-tls
  duration: 8760h
  renewBefore: 720h
  subject:
    organizations:
      - example-corp
  commonName: myoperator-webhook-service.myoperator-system.svc
  dnsNames:
    - myoperator-webhook-service.myoperator-system.svc
    - myoperator-webhook-service.myoperator-system.svc.cluster.local
  issuerRef:
    name: selfsigned-issuer
    kind: ClusterIssuer
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: selfsigned-issuer
spec:
  selfSigned: {}
```

### MutatingWebhookConfiguration

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: MutatingWebhookConfiguration
metadata:
  name: myoperator-mutating-webhook
  annotations:
    # cert-manager injects the CA bundle automatically
    cert-manager.io/inject-ca-from: myoperator-system/myoperator-webhook-cert
spec:
  webhooks:
    - name: defaulting.myresource.myoperator.example.com
      admissionReviewVersions: ["v1"]
      clientConfig:
        service:
          name: myoperator-webhook-service
          namespace: myoperator-system
          path: /mutate-myoperator-example-com-v1alpha1-myresource
          port: 9443
      rules:
        - apiGroups: ["myoperator.example.com"]
          apiVersions: ["v1alpha1", "v1beta1"]
          operations: ["CREATE", "UPDATE"]
          resources: ["myresources"]
      failurePolicy: Fail
      sideEffects: None
      # Only call webhook for resources in namespaces with this label
      namespaceSelector:
        matchExpressions:
          - key: myoperator.example.com/webhooks
            operator: NotIn
            values: ["disabled"]
      timeoutSeconds: 10
```

### ValidatingWebhookConfiguration

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingWebhookConfiguration
metadata:
  name: myoperator-validating-webhook
  annotations:
    cert-manager.io/inject-ca-from: myoperator-system/myoperator-webhook-cert
spec:
  webhooks:
    - name: validating.myresource.myoperator.example.com
      admissionReviewVersions: ["v1"]
      clientConfig:
        service:
          name: myoperator-webhook-service
          namespace: myoperator-system
          path: /validate-myoperator-example-com-v1alpha1-myresource
          port: 9443
      rules:
        - apiGroups: ["myoperator.example.com"]
          apiVersions: ["v1alpha1", "v1beta1"]
          operations: ["CREATE", "UPDATE", "DELETE"]
          resources: ["myresources"]
      failurePolicy: Fail
      sideEffects: None
      timeoutSeconds: 10
```

### CRD with Conversion Webhook Reference

```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: myresources.myoperator.example.com
  annotations:
    cert-manager.io/inject-ca-from: myoperator-system/myoperator-webhook-cert
spec:
  group: myoperator.example.com
  names:
    kind: MyResource
    listKind: MyResourceList
    plural: myresources
    singular: myresource
    shortNames:
      - mr
  scope: Namespaced
  conversion:
    strategy: Webhook
    webhook:
      conversionReviewVersions: ["v1"]
      clientConfig:
        service:
          name: myoperator-webhook-service
          namespace: myoperator-system
          path: /convert
          port: 9443
  versions:
    - name: v1beta1
      served: true
      storage: true  # Hub version is stored
      schema:
        openAPIV3Schema:
          # ... schema ...
    - name: v1alpha1
      served: true
      storage: false
      schema:
        openAPIV3Schema:
          # ... schema ...
```

## Testing Webhooks

### Unit Tests for Defaulting

```go
package v1alpha1_test

import (
    "context"
    "testing"

    "k8s.io/utils/ptr"
    "sigs.k8s.io/controller-runtime/pkg/client/fake"

    myoperatorv1alpha1 "github.com/example/myoperator/api/v1alpha1"
)

func TestMyResourceDefault(t *testing.T) {
    tests := []struct {
        name     string
        input    *myoperatorv1alpha1.MyResource
        validate func(t *testing.T, obj *myoperatorv1alpha1.MyResource)
    }{
        {
            name: "defaults replicas to 1",
            input: &myoperatorv1alpha1.MyResource{
                Spec: myoperatorv1alpha1.MyResourceSpec{
                    Image: "nginx:1.25",
                },
            },
            validate: func(t *testing.T, obj *myoperatorv1alpha1.MyResource) {
                if obj.Spec.Replicas == nil {
                    t.Fatal("replicas should not be nil")
                }
                if *obj.Spec.Replicas != 1 {
                    t.Errorf("expected replicas=1, got %d", *obj.Spec.Replicas)
                }
            },
        },
        {
            name: "does not override explicit replicas",
            input: &myoperatorv1alpha1.MyResource{
                Spec: myoperatorv1alpha1.MyResourceSpec{
                    Image:    "nginx:1.25",
                    Replicas: ptr.To[int32](5),
                },
            },
            validate: func(t *testing.T, obj *myoperatorv1alpha1.MyResource) {
                if *obj.Spec.Replicas != 5 {
                    t.Errorf("expected replicas=5, got %d", *obj.Spec.Replicas)
                }
            },
        },
        {
            name: "sets HA minReplicas when HA enabled",
            input: &myoperatorv1alpha1.MyResource{
                Spec: myoperatorv1alpha1.MyResourceSpec{
                    Image: "nginx:1.25",
                    HighAvailability: &myoperatorv1alpha1.HighAvailabilityConfig{
                        Enabled: true,
                    },
                },
            },
            validate: func(t *testing.T, obj *myoperatorv1alpha1.MyResource) {
                if obj.Spec.HighAvailability.MinReplicas == nil {
                    t.Fatal("HA minReplicas should not be nil")
                }
                if *obj.Spec.HighAvailability.MinReplicas != 3 {
                    t.Errorf("expected HA minReplicas=3, got %d", *obj.Spec.HighAvailability.MinReplicas)
                }
                if *obj.Spec.Replicas < 3 {
                    t.Errorf("replicas should be >= 3 for HA mode, got %d", *obj.Spec.Replicas)
                }
            },
        },
    }

    for _, tc := range tests {
        t.Run(tc.name, func(t *testing.T) {
            obj := tc.input.DeepCopy()
            if err := obj.Default(context.Background(), obj); err != nil {
                t.Fatalf("Default() failed: %v", err)
            }
            tc.validate(t, obj)
        })
    }
}
```

### Unit Tests for Validation

```go
func TestMyResourceValidateCreate(t *testing.T) {
    tests := []struct {
        name        string
        input       *myoperatorv1alpha1.MyResource
        expectError bool
        errorField  string
    }{
        {
            name: "valid resource passes validation",
            input: &myoperatorv1alpha1.MyResource{
                Spec: myoperatorv1alpha1.MyResourceSpec{
                    Image:    "nginx:1.25",
                    Replicas: ptr.To[int32](3),
                },
            },
            expectError: false,
        },
        {
            name: "missing image fails validation",
            input: &myoperatorv1alpha1.MyResource{
                Spec: myoperatorv1alpha1.MyResourceSpec{
                    Replicas: ptr.To[int32](1),
                },
            },
            expectError: true,
            errorField:  "spec.image",
        },
        {
            name: "replicas exceeding max fails",
            input: &myoperatorv1alpha1.MyResource{
                Spec: myoperatorv1alpha1.MyResourceSpec{
                    Image:    "nginx:1.25",
                    Replicas: ptr.To[int32](200),
                },
            },
            expectError: true,
            errorField:  "spec.replicas",
        },
        {
            name: "HA with insufficient replicas fails",
            input: &myoperatorv1alpha1.MyResource{
                Spec: myoperatorv1alpha1.MyResourceSpec{
                    Image:    "nginx:1.25",
                    Replicas: ptr.To[int32](2),
                    HighAvailability: &myoperatorv1alpha1.HighAvailabilityConfig{
                        Enabled:     true,
                        MinReplicas: ptr.To[int32](3),
                    },
                },
            },
            expectError: true,
            errorField:  "spec.replicas",
        },
    }

    for _, tc := range tests {
        t.Run(tc.name, func(t *testing.T) {
            obj := tc.input.DeepCopy()
            _, err := obj.ValidateCreate(context.Background(), obj)
            if tc.expectError && err == nil {
                t.Error("expected validation error, got nil")
            }
            if !tc.expectError && err != nil {
                t.Errorf("expected no error, got: %v", err)
            }
        })
    }
}
```

### Integration Testing with envtest

```go
package integration_test

import (
    "context"
    "path/filepath"
    "testing"

    . "github.com/onsi/ginkgo/v2"
    . "github.com/onsi/gomega"
    "k8s.io/client-go/kubernetes/scheme"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/envtest"

    myoperatorv1alpha1 "github.com/example/myoperator/api/v1alpha1"
)

var (
    testEnv   *envtest.Environment
    k8sClient client.Client
    ctx       context.Context
    cancel    context.CancelFunc
)

func TestWebhooks(t *testing.T) {
    RegisterFailHandler(Fail)
    RunSpecs(t, "Webhook Integration Suite")
}

var _ = BeforeSuite(func() {
    ctx, cancel = context.WithCancel(context.TODO())

    testEnv = &envtest.Environment{
        CRDDirectoryPaths: []string{
            filepath.Join("..", "..", "config", "crd", "bases"),
        },
        WebhookInstallOptions: envtest.WebhookInstallOptions{
            Paths: []string{filepath.Join("..", "..", "config", "webhook")},
        },
        ErrorIfCRDPathMissing: true,
    }

    cfg, err := testEnv.Start()
    Expect(err).NotTo(HaveOccurred())
    Expect(cfg).NotTo(BeNil())

    Expect(myoperatorv1alpha1.AddToScheme(scheme.Scheme)).To(Succeed())

    k8sClient, err = client.New(cfg, client.Options{Scheme: scheme.Scheme})
    Expect(err).NotTo(HaveOccurred())

    mgr, err := ctrl.NewManager(cfg, ctrl.Options{
        Scheme: scheme.Scheme,
        WebhookServer: &webhookInstallOptions,
    })
    Expect(err).NotTo(HaveOccurred())

    Expect((&myoperatorv1alpha1.MyResource{}).SetupWebhookWithManager(mgr)).To(Succeed())

    go func() {
        defer GinkgoRecover()
        Expect(mgr.Start(ctx)).To(Succeed())
    }()
})

var _ = AfterSuite(func() {
    cancel()
    Expect(testEnv.Stop()).To(Succeed())
})

var _ = Describe("MyResource Webhook", func() {
    Context("Defaulting", func() {
        It("should set default replicas", func() {
            mr := &myoperatorv1alpha1.MyResource{
                Spec: myoperatorv1alpha1.MyResourceSpec{
                    Image: "nginx:1.25",
                },
            }
            Expect(k8sClient.Create(ctx, mr)).To(Succeed())
            defer k8sClient.Delete(ctx, mr)
            Expect(*mr.Spec.Replicas).To(Equal(int32(1)))
        })
    })

    Context("Validation", func() {
        It("should reject missing image", func() {
            mr := &myoperatorv1alpha1.MyResource{
                Spec: myoperatorv1alpha1.MyResourceSpec{
                    Replicas: ptr.To[int32](1),
                },
            }
            err := k8sClient.Create(ctx, mr)
            Expect(err).To(HaveOccurred())
            Expect(err.Error()).To(ContainSubstring("spec.image"))
        })
    })
})
```

## Summary

Kubernetes operator webhooks complete the operator pattern by enforcing data quality throughout the resource lifecycle. Defaulting webhooks reduce the cognitive burden on API consumers by providing sensible defaults while keeping the schema minimal. Validating webhooks enforce business rules beyond what JSON Schema can express, including cross-field validation and update constraints like immutable fields and minimum scale requirements. Conversion webhooks enable safe CRD API evolution by maintaining a hub version as the authoritative storage format while serving deprecated spoke versions to clients that have not yet upgraded. cert-manager integration automates TLS certificate lifecycle for webhook servers, eliminating a common operational failure mode in production operators.
