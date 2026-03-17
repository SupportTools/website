---
title: "Kubernetes Operator CRD Versioning: Safe API Evolution and Conversion"
date: 2027-11-13T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Operators", "CRD", "API Versioning", "Webhooks"]
categories:
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to CRD version management, conversion webhooks, hub-spoke pattern, storage version migration, field deprecation, controller-gen annotations, and safe operator upgrades in production."
more_link: "yes"
url: "/kubernetes-operator-crd-versioning-guide/"
---

Custom Resource Definition versioning is one of the most underestimated challenges in Kubernetes operator development. Operators start with a simple v1alpha1 schema, accumulate users, and then face the problem of evolving the API without breaking existing resources. A poorly planned versioning strategy results in operators that cannot be upgraded safely, persistent storage inconsistencies, and broken user workflows.

This guide covers the complete CRD versioning lifecycle from v1alpha1 through v1, including conversion webhook implementation, the hub-spoke pattern for managing multiple versions, storage version migration, safe operator upgrades, and the controller-gen annotations that automate most of the boilerplate.

<!--more-->

# Kubernetes Operator CRD Versioning: Safe API Evolution and Conversion

## CRD Versioning Fundamentals

Kubernetes CRDs support multiple API versions simultaneously. The API server stores all custom resources in a single storage version but serves them in any declared version by converting on the fly.

```
User creates WebApp v1beta1 resource
         │
         ▼
API Server converts v1beta1 → v1 (storage version)
         │
         ▼
etcd stores as v1
         │
         ▼
GET request for v1alpha1
         │
         ▼
API Server converts v1 → v1alpha1 (on read)
         │
         ▼
User receives v1alpha1 response
```

### Version Lifecycle

A typical CRD versioning lifecycle follows:

1. `v1alpha1`: Initial API, may change without notice
2. `v1beta1`: Stable enough for production use, deprecation policy applies
3. `v1`: Production-stable, no breaking changes without major version bump

## Project Structure with controller-gen

### Directory Layout

```
myoperator/
├── api/
│   ├── v1alpha1/
│   │   ├── webapp_types.go
│   │   ├── groupversion_info.go
│   │   └── zz_generated.deepcopy.go
│   ├── v1beta1/
│   │   ├── webapp_types.go
│   │   ├── groupversion_info.go
│   │   ├── conversion.go         # Hub version conversion logic
│   │   └── zz_generated.deepcopy.go
│   └── v1/
│       ├── webapp_types.go
│       ├── groupversion_info.go
│       ├── conversion.go         # Hub version (no conversion needed)
│       └── zz_generated.deepcopy.go
├── internal/
│   └── webhook/
│       └── v1beta1/
│           └── webapp_conversion_webhook.go
└── config/
    └── crd/
        └── bases/
            └── apps.company.com_webapps.yaml
```

## Defining API Versions with controller-gen

### v1alpha1 Type Definition

```go
// api/v1alpha1/webapp_types.go
package v1alpha1

import (
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// WebAppSpec defines the desired state of WebApp
// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:scope=Namespaced,shortName=wa
// +kubebuilder:printcolumn:name="Replicas",type=integer,JSONPath=`.spec.replicas`
// +kubebuilder:printcolumn:name="Ready",type=string,JSONPath=`.status.ready`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`
type WebApp struct {
    metav1.TypeMeta   `json:",inline"`
    metav1.ObjectMeta `json:"metadata,omitempty"`

    Spec   WebAppSpec   `json:"spec,omitempty"`
    Status WebAppStatus `json:"status,omitempty"`
}

type WebAppSpec struct {
    // +kubebuilder:validation:Minimum=1
    // +kubebuilder:validation:Maximum=50
    // +kubebuilder:default=1
    Replicas int32 `json:"replicas,omitempty"`

    // +kubebuilder:validation:Required
    Image string `json:"image"`

    // +optional
    // Deprecated: Use Resources.Requests.Memory instead
    // +kubebuilder:validation:Pattern=`^[0-9]+[MGi]+$`
    MemoryMB string `json:"memoryMB,omitempty"`

    // +optional
    Port int32 `json:"port,omitempty"`
}

type WebAppStatus struct {
    // +optional
    Ready string `json:"ready,omitempty"`
    // +optional
    Conditions []metav1.Condition `json:"conditions,omitempty"`
}
```

### v1beta1 Type Definition (Hub Version)

```go
// api/v1beta1/webapp_types.go
package v1beta1

import (
    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// WebApp is the hub version - all conversions go through v1beta1
// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:storageversion
// +kubebuilder:resource:scope=Namespaced,shortName=wa
// +kubebuilder:printcolumn:name="Replicas",type=integer,JSONPath=`.spec.replicas`
// +kubebuilder:printcolumn:name="Ready",type=string,JSONPath=`.status.ready`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`
type WebApp struct {
    metav1.TypeMeta   `json:",inline"`
    metav1.ObjectMeta `json:"metadata,omitempty"`

    Spec   WebAppSpec   `json:"spec,omitempty"`
    Status WebAppStatus `json:"status,omitempty"`
}

type WebAppSpec struct {
    // +kubebuilder:validation:Minimum=1
    // +kubebuilder:validation:Maximum=100
    // +kubebuilder:default=1
    Replicas int32 `json:"replicas,omitempty"`

    // +kubebuilder:validation:Required
    Image string `json:"image"`

    // Resources replaces the deprecated MemoryMB field from v1alpha1
    // +optional
    Resources corev1.ResourceRequirements `json:"resources,omitempty"`

    // +kubebuilder:default=8080
    Port int32 `json:"port,omitempty"`

    // New in v1beta1: service configuration
    // +optional
    Service *ServiceSpec `json:"service,omitempty"`
}

type ServiceSpec struct {
    // +kubebuilder:validation:Enum=ClusterIP;NodePort;LoadBalancer
    // +kubebuilder:default=ClusterIP
    Type string `json:"type,omitempty"`
    // +optional
    Annotations map[string]string `json:"annotations,omitempty"`
}

type WebAppStatus struct {
    // +optional
    Ready string `json:"ready,omitempty"`
    // +optional
    AvailableReplicas int32 `json:"availableReplicas,omitempty"`
    // +optional
    Conditions []metav1.Condition `json:"conditions,omitempty"`
}
```

### v1alpha1 to v1beta1 Conversion

```go
// api/v1alpha1/conversion.go
package v1alpha1

import (
    "fmt"
    "strconv"
    "strings"

    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/api/resource"
    "sigs.k8s.io/controller-runtime/pkg/conversion"

    v1beta1 "github.com/company/myoperator/api/v1beta1"
)

// ConvertTo converts this WebApp (v1alpha1) to the Hub version (v1beta1)
func (src *WebApp) ConvertTo(dstRaw conversion.Hub) error {
    dst := dstRaw.(*v1beta1.WebApp)

    // Basic metadata
    dst.ObjectMeta = src.ObjectMeta
    dst.Status.Ready = src.Status.Ready
    dst.Status.Conditions = src.Status.Conditions

    // Spec fields
    dst.Spec.Replicas = src.Spec.Replicas
    dst.Spec.Image = src.Spec.Image
    dst.Spec.Port = src.Spec.Port

    // Convert deprecated MemoryMB to Resources.Requests.Memory
    if src.Spec.MemoryMB != "" {
        memStr := src.Spec.MemoryMB
        // Convert MB notation to Kubernetes memory format
        if strings.HasSuffix(memStr, "MB") {
            mb, err := strconv.ParseInt(strings.TrimSuffix(memStr, "MB"), 10, 64)
            if err != nil {
                return fmt.Errorf("invalid memoryMB value %q: %w", memStr, err)
            }
            memQuantity := resource.MustParse(fmt.Sprintf("%dMi", mb))
            if dst.Spec.Resources.Requests == nil {
                dst.Spec.Resources.Requests = corev1.ResourceList{}
            }
            dst.Spec.Resources.Requests[corev1.ResourceMemory] = memQuantity
            // Store original value as annotation for round-trip fidelity
            if dst.Annotations == nil {
                dst.Annotations = map[string]string{}
            }
            dst.Annotations["webapp.company.com/v1alpha1-memory-mb"] = src.Spec.MemoryMB
        }
    }

    return nil
}

// ConvertFrom converts the Hub version (v1beta1) back to this WebApp (v1alpha1)
func (dst *WebApp) ConvertFrom(srcRaw conversion.Hub) error {
    src := srcRaw.(*v1beta1.WebApp)

    // Basic metadata
    dst.ObjectMeta = src.ObjectMeta
    dst.Status.Ready = src.Status.Ready
    dst.Status.Conditions = src.Status.Conditions

    // Spec fields
    dst.Spec.Replicas = src.Spec.Replicas
    dst.Spec.Image = src.Spec.Image
    dst.Spec.Port = src.Spec.Port

    // Restore deprecated MemoryMB from annotation if present
    if originalMem, ok := src.Annotations["webapp.company.com/v1alpha1-memory-mb"]; ok {
        dst.Spec.MemoryMB = originalMem
    } else if memReq, ok := src.Spec.Resources.Requests[corev1.ResourceMemory]; ok {
        // Convert back to MB for v1alpha1 clients
        mb := memReq.Value() / (1024 * 1024)
        dst.Spec.MemoryMB = fmt.Sprintf("%dMB", mb)
    }

    return nil
}

// Hub marks v1beta1 as the hub version (not v1alpha1)
// This function must NOT exist in v1alpha1 (it would make this the hub)
```

### Hub Version (v1beta1)

```go
// api/v1beta1/conversion.go
package v1beta1

// Hub marks this type as a conversion hub.
// All other versions will convert to/from this version.
func (*WebApp) Hub() {}
```

## Conversion Webhook Implementation

### Webhook Server Setup

```go
// internal/webhook/v1beta1/webapp_conversion_webhook.go
package v1beta1

import (
    ctrl "sigs.k8s.io/controller-runtime"

    appsv1beta1 "github.com/company/myoperator/api/v1beta1"
)

func SetupWebhookWithManager(mgr ctrl.Manager) error {
    return ctrl.NewWebhookManagedBy(mgr).
        For(&appsv1beta1.WebApp{}).
        Complete()
}
```

### Registering the Webhook

```go
// cmd/main.go (relevant sections)
package main

import (
    "os"

    ctrl "sigs.k8s.io/controller-runtime"

    appsv1alpha1 "github.com/company/myoperator/api/v1alpha1"
    appsv1beta1 "github.com/company/myoperator/api/v1beta1"
    webhookv1beta1 "github.com/company/myoperator/internal/webhook/v1beta1"
)

func main() {
    mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
        Scheme: scheme,
        WebhookServer: webhook.NewServer(webhook.Options{
            Port:    9443,
            CertDir: "/tmp/k8s-webhook-server/serving-certs",
        }),
    })

    // Register types with scheme
    if err := appsv1alpha1.AddToScheme(mgr.GetScheme()); err != nil {
        os.Exit(1)
    }
    if err := appsv1beta1.AddToScheme(mgr.GetScheme()); err != nil {
        os.Exit(1)
    }

    // Setup conversion webhook
    if err := webhookv1beta1.SetupWebhookWithManager(mgr); err != nil {
        os.Exit(1)
    }
}
```

## CRD Schema with Multiple Versions

```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: webapps.apps.company.com
  annotations:
    controller-gen.kubebuilder.io/version: v0.16.0
spec:
  group: apps.company.com
  names:
    kind: WebApp
    listKind: WebAppList
    plural: webapps
    singular: webapp
    shortNames:
    - wa
  scope: Namespaced
  versions:
  - name: v1alpha1
    served: true
    storage: false
    deprecated: true
    deprecationWarning: "v1alpha1 is deprecated; use v1beta1 or v1"
    schema:
      openAPIV3Schema:
        type: object
        properties:
          spec:
            type: object
            properties:
              replicas:
                type: integer
                minimum: 1
                maximum: 50
                default: 1
              image:
                type: string
              memoryMB:
                type: string
                description: "Deprecated: Use resources.requests.memory"
                pattern: '^[0-9]+MB$'
              port:
                type: integer
    subresources:
      status: {}
    additionalPrinterColumns:
    - name: Replicas
      type: integer
      jsonPath: .spec.replicas
    - name: Age
      type: date
      jsonPath: .metadata.creationTimestamp

  - name: v1beta1
    served: true
    storage: true
    schema:
      openAPIV3Schema:
        type: object
        properties:
          spec:
            type: object
            required:
            - image
            properties:
              replicas:
                type: integer
                minimum: 1
                maximum: 100
                default: 1
              image:
                type: string
              resources:
                type: object
                properties:
                  requests:
                    type: object
                    additionalProperties:
                      type: string
                  limits:
                    type: object
                    additionalProperties:
                      type: string
              port:
                type: integer
                default: 8080
              service:
                type: object
                properties:
                  type:
                    type: string
                    enum:
                    - ClusterIP
                    - NodePort
                    - LoadBalancer
                    default: ClusterIP
                  annotations:
                    type: object
                    additionalProperties:
                      type: string
    subresources:
      status: {}
    additionalPrinterColumns:
    - name: Replicas
      type: integer
      jsonPath: .spec.replicas
    - name: Ready
      type: string
      jsonPath: .status.ready
    - name: Age
      type: date
      jsonPath: .metadata.creationTimestamp

  conversion:
    strategy: Webhook
    webhook:
      conversionReviewVersions: ["v1", "v1beta1"]
      clientConfig:
        service:
          name: myoperator-webhook-service
          namespace: myoperator-system
          path: /convert
```

## Storage Version Migration

When changing the storage version (e.g., from v1alpha1 to v1beta1), existing objects in etcd need to be migrated.

### Using StorageVersionMigrator

```yaml
apiVersion: migration.k8s.io/v1alpha1
kind: StorageVersionMigration
metadata:
  name: migrate-webapps-to-v1beta1
spec:
  resource:
    group: apps.company.com
    resource: webapps
    version: v1beta1
```

### Manual Migration Script

```bash
#!/bin/bash
# migrate-crd-storage-version.sh
# Migrates all CRD instances to the new storage version by read-write cycle

CRD_GROUP="apps.company.com"
CRD_RESOURCE="webapps"
TARGET_VERSION="v1beta1"

echo "Starting storage version migration for $CRD_GROUP/$CRD_RESOURCE"
echo "Target version: $TARGET_VERSION"
echo ""

# Get all instances
NAMESPACES=$(kubectl get namespaces -o jsonpath='{.items[*].metadata.name}')

TOTAL=0
MIGRATED=0
ERRORS=0

for NS in $NAMESPACES; do
  INSTANCES=$(kubectl get $CRD_RESOURCE.$CRD_GROUP \
    -n $NS \
    -o jsonpath='{.items[*].metadata.name}' 2>/dev/null)

  for INSTANCE in $INSTANCES; do
    TOTAL=$((TOTAL + 1))
    echo "Migrating: $NS/$INSTANCE"

    # Read-write cycle triggers conversion and re-storage in storage version
    RESOURCE_VERSION=$(kubectl get $CRD_RESOURCE.$CRD_GROUP \
      -n $NS $INSTANCE \
      -o jsonpath='{.metadata.resourceVersion}')

    # Apply a no-op patch to force a write (triggers conversion)
    if kubectl annotate $CRD_RESOURCE.$CRD_GROUP \
      -n $NS $INSTANCE \
      "migration.company.com/last-migrated=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --overwrite 2>/dev/null; then
      MIGRATED=$((MIGRATED + 1))
    else
      echo "ERROR: Failed to migrate $NS/$INSTANCE"
      ERRORS=$((ERRORS + 1))
    fi
  done
done

echo ""
echo "=== Migration Summary ==="
echo "Total instances: $TOTAL"
echo "Migrated: $MIGRATED"
echo "Errors: $ERRORS"
```

## Field Deprecation Strategy

### Adding Deprecation Markers

```go
// Proper field deprecation in Go types
type WebAppSpec struct {
    // Image is the container image to run
    // +kubebuilder:validation:Required
    Image string `json:"image"`

    // MemoryMB specifies the memory limit in megabytes.
    // Deprecated: Use resources.requests.memory and resources.limits.memory.
    // This field will be removed in v1.
    // +optional
    // +kubebuilder:validation:Pattern=`^[0-9]+MB$`
    // +kubebuilder:deprecation:reason="Use resources.requests.memory instead"
    // +kubebuilder:deprecation:replacement=".spec.resources.requests.memory"
    // +kubebuilder:deprecation:removedIn="v1"
    MemoryMB string `json:"memoryMB,omitempty"`

    // Resources defines compute resource requirements.
    // +optional
    Resources corev1.ResourceRequirements `json:"resources,omitempty"`
}
```

### Admission Webhook for Deprecation Warnings

```go
// internal/webhook/v1beta1/webapp_validating_webhook.go
package v1beta1

import (
    "context"
    "fmt"

    "k8s.io/apimachinery/pkg/runtime"
    "k8s.io/apimachinery/pkg/util/validation/field"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/webhook/admission"

    appsv1beta1 "github.com/company/myoperator/api/v1beta1"
)

type WebAppValidator struct{}

func (v *WebAppValidator) ValidateCreate(ctx context.Context, obj runtime.Object) (admission.Warnings, error) {
    webapp := obj.(*appsv1beta1.WebApp)
    return v.validate(webapp)
}

func (v *WebAppValidator) ValidateUpdate(ctx context.Context, oldObj, newObj runtime.Object) (admission.Warnings, error) {
    webapp := newObj.(*appsv1beta1.WebApp)
    return v.validate(webapp)
}

func (v *WebAppValidator) ValidateDelete(ctx context.Context, obj runtime.Object) (admission.Warnings, error) {
    return nil, nil
}

func (v *WebAppValidator) validate(webapp *appsv1beta1.WebApp) (admission.Warnings, error) {
    var warnings admission.Warnings
    var errs field.ErrorList

    // Validate replicas
    if webapp.Spec.Replicas < 1 {
        errs = append(errs, field.Invalid(
            field.NewPath("spec", "replicas"),
            webapp.Spec.Replicas,
            "replicas must be >= 1",
        ))
    }

    // Warn about deprecated fields
    if _, hasMemMBAnnotation := webapp.Annotations["webapp.company.com/v1alpha1-memory-mb"]; hasMemMBAnnotation {
        warnings = append(warnings,
            "This resource was created with the deprecated v1alpha1 API. "+
            "Please migrate to v1beta1 and use resources.requests.memory instead of memoryMB.")
    }

    // Warn about missing resource requests
    if webapp.Spec.Resources.Requests == nil {
        warnings = append(warnings,
            fmt.Sprintf("No resource requests specified for %s/%s. "+
                "Setting resource requests is strongly recommended for production workloads.",
                webapp.Namespace, webapp.Name))
    }

    if len(errs) > 0 {
        return warnings, errs.ToAggregate()
    }
    return warnings, nil
}

func (v *WebAppValidator) SetupWebhookWithManager(mgr ctrl.Manager) error {
    return ctrl.NewWebhookManagedBy(mgr).
        For(&appsv1beta1.WebApp{}).
        WithValidator(v).
        Complete()
}
```

## Webhook TLS and Deployment

### Webhook Deployment with cert-manager

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: myoperator-webhook-cert
  namespace: myoperator-system
spec:
  dnsNames:
  - myoperator-webhook-service.myoperator-system.svc
  - myoperator-webhook-service.myoperator-system.svc.cluster.local
  issuerRef:
    kind: ClusterIssuer
    name: selfsigned-cluster-issuer
  secretName: myoperator-webhook-cert
---
apiVersion: admissionregistration.k8s.io/v1
kind: MutatingWebhookConfiguration
metadata:
  name: myoperator-mutating-webhook
  annotations:
    cert-manager.io/inject-ca-from: myoperator-system/myoperator-webhook-cert
spec:
  webhooks:
  - name: mutate.webapp.apps.company.com
    admissionReviewVersions: ["v1"]
    clientConfig:
      service:
        name: myoperator-webhook-service
        namespace: myoperator-system
        path: /mutate-apps-company-com-v1beta1-webapp
    rules:
    - apiGroups: ["apps.company.com"]
      apiVersions: ["v1beta1"]
      operations: ["CREATE", "UPDATE"]
      resources: ["webapps"]
    failurePolicy: Fail
    sideEffects: None
---
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingWebhookConfiguration
metadata:
  name: myoperator-validating-webhook
  annotations:
    cert-manager.io/inject-ca-from: myoperator-system/myoperator-webhook-cert
spec:
  webhooks:
  - name: validate.webapp.apps.company.com
    admissionReviewVersions: ["v1"]
    clientConfig:
      service:
        name: myoperator-webhook-service
        namespace: myoperator-system
        path: /validate-apps-company-com-v1beta1-webapp
    rules:
    - apiGroups: ["apps.company.com"]
      apiVersions: ["v1beta1"]
      operations: ["CREATE", "UPDATE", "DELETE"]
      resources: ["webapps"]
    failurePolicy: Fail
    sideEffects: None
```

## Safe Operator Upgrades

### Upgrade Checklist

```bash
#!/bin/bash
# pre-upgrade-check.sh
# Verifies CRD upgrade readiness

echo "=== CRD Upgrade Pre-check ==="
OPERATOR_NS="myoperator-system"

echo ""
echo "--- Current CRD Storage Versions ---"
kubectl get crd webapps.apps.company.com \
  -o jsonpath='{.status.storedVersions}' | \
  python3 -c "import json,sys; print(json.load(sys.stdin))"

echo ""
echo "--- Resources at Non-Storage Versions ---"
# Check if any resources are stored in old versions
kubectl get crd webapps.apps.company.com -o json | \
  python3 -c "
import json, sys
data = json.load(sys.stdin)
stored = data.get('status', {}).get('storedVersions', [])
served = [v['name'] for v in data.get('spec', {}).get('versions', []) if v.get('served')]
print(f'Served versions: {served}')
print(f'Stored versions: {stored}')
if len(stored) > 1:
    print('WARNING: Multiple storage versions detected - migration required before removing old versions')
"

echo ""
echo "--- Webhook Health ---"
kubectl get pods -n $OPERATOR_NS | grep webhook
kubectl exec -n $OPERATOR_NS \
  $(kubectl get pods -n $OPERATOR_NS -l control-plane=controller-manager -o name | head -1) -- \
  curl -sk https://localhost:9443/healthz || echo "Webhook health check failed"

echo ""
echo "--- Total CRD Instances ---"
kubectl get webapps.apps.company.com -A --no-headers | wc -l
```

### Rolling Operator Upgrade

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myoperator-controller-manager
  namespace: myoperator-system
spec:
  replicas: 2
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  template:
    spec:
      containers:
      - name: manager
        image: registry.company.com/myoperator:v2.0.0
        readinessProbe:
          httpGet:
            path: /readyz
            port: 8081
          initialDelaySeconds: 5
          periodSeconds: 10
          failureThreshold: 3
        livenessProbe:
          httpGet:
            path: /healthz
            port: 8081
          initialDelaySeconds: 15
          periodSeconds: 20
```

## Testing CRD Conversions

### Integration Tests with envtest

```go
// api/v1alpha1/conversion_test.go
package v1alpha1_test

import (
    "context"
    "testing"

    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/api/resource"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "sigs.k8s.io/controller-runtime/pkg/client"

    appsv1alpha1 "github.com/company/myoperator/api/v1alpha1"
    appsv1beta1 "github.com/company/myoperator/api/v1beta1"
)

func TestV1Alpha1ToV1Beta1Conversion(t *testing.T) {
    tests := []struct {
        name     string
        input    *appsv1alpha1.WebApp
        expected *appsv1beta1.WebApp
    }{
        {
            name: "converts memoryMB to resources",
            input: &appsv1alpha1.WebApp{
                ObjectMeta: metav1.ObjectMeta{
                    Name:      "test-app",
                    Namespace: "default",
                },
                Spec: appsv1alpha1.WebAppSpec{
                    Image:    "nginx:1.25",
                    Replicas: 2,
                    MemoryMB: "256MB",
                    Port:     8080,
                },
            },
            expected: &appsv1beta1.WebApp{
                Spec: appsv1beta1.WebAppSpec{
                    Image:    "nginx:1.25",
                    Replicas: 2,
                    Port:     8080,
                    Resources: corev1.ResourceRequirements{
                        Requests: corev1.ResourceList{
                            corev1.ResourceMemory: resource.MustParse("256Mi"),
                        },
                    },
                },
            },
        },
        {
            name: "handles zero replicas default",
            input: &appsv1alpha1.WebApp{
                ObjectMeta: metav1.ObjectMeta{
                    Name:      "default-replicas",
                    Namespace: "default",
                },
                Spec: appsv1alpha1.WebAppSpec{
                    Image: "nginx:1.25",
                },
            },
            expected: &appsv1beta1.WebApp{
                Spec: appsv1beta1.WebAppSpec{
                    Image:    "nginx:1.25",
                    Replicas: 0, // Will get default from webhook
                },
            },
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            dst := &appsv1beta1.WebApp{}
            err := tt.input.ConvertTo(dst)
            if err != nil {
                t.Fatalf("ConvertTo failed: %v", err)
            }

            if dst.Spec.Image != tt.expected.Spec.Image {
                t.Errorf("Image mismatch: got %q, want %q",
                    dst.Spec.Image, tt.expected.Spec.Image)
            }

            if tt.expected.Spec.Resources.Requests != nil {
                gotMem := dst.Spec.Resources.Requests[corev1.ResourceMemory]
                wantMem := tt.expected.Spec.Resources.Requests[corev1.ResourceMemory]
                if gotMem.Cmp(wantMem) != 0 {
                    t.Errorf("Memory mismatch: got %v, want %v", gotMem, wantMem)
                }
            }
        })
    }
}
```

### Round-Trip Conversion Test

```go
// Ensures conversion v1alpha1 -> v1beta1 -> v1alpha1 produces identical output
func TestRoundTripConversion(t *testing.T) {
    original := &appsv1alpha1.WebApp{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "round-trip-test",
            Namespace: "default",
        },
        Spec: appsv1alpha1.WebAppSpec{
            Image:    "nginx:1.25",
            Replicas: 3,
            MemoryMB: "512MB",
            Port:     8443,
        },
    }

    // Convert to hub
    hub := &appsv1beta1.WebApp{}
    if err := original.ConvertTo(hub); err != nil {
        t.Fatalf("ConvertTo failed: %v", err)
    }

    // Convert back
    restored := &appsv1alpha1.WebApp{}
    if err := restored.ConvertFrom(hub); err != nil {
        t.Fatalf("ConvertFrom failed: %v", err)
    }

    // Verify round-trip fidelity
    if restored.Spec.MemoryMB != original.Spec.MemoryMB {
        t.Errorf("MemoryMB round-trip failed: got %q, want %q",
            restored.Spec.MemoryMB, original.Spec.MemoryMB)
    }
    if restored.Spec.Replicas != original.Spec.Replicas {
        t.Errorf("Replicas round-trip failed: got %d, want %d",
            restored.Spec.Replicas, original.Spec.Replicas)
    }
}
```

## Version Deprecation and Removal

### Deprecation Timeline

```yaml
# Mark a version as deprecated in the CRD
# This causes the API server to emit deprecation warnings
versions:
- name: v1alpha1
  served: true
  storage: false
  deprecated: true
  deprecationWarning: "v1alpha1 is deprecated and will be removed in operator v3.0.0; migrate to v1beta1"
```

### Safe Version Removal Process

```bash
# Step 1: Verify no resources at old version in storage
kubectl get crd webapps.apps.company.com -o jsonpath='{.status.storedVersions}'
# Should show only ["v1beta1"]

# Step 2: Run migration to ensure all objects at new version
./migrate-crd-storage-version.sh

# Step 3: Update CRD to remove old version's storedVersions entry
kubectl patch crd webapps.apps.company.com \
  --type='json' \
  -p='[{"op":"replace","path":"/status/storedVersions","value":["v1beta1"]}]' \
  --subresource=status

# Step 4: Deploy new operator version with served: false for old version
# (keep in CRD but not served - allows graceful transition)

# Step 5: After all clients have migrated, remove version entirely
# Remove the version entry from the CRD spec
```

## Summary

CRD versioning requires upfront planning to avoid breaking production operators. The key patterns from this guide:

**Hub-spoke pattern**: Designate one version (typically the latest stable) as the hub. All other versions convert to/from the hub version. This simplifies conversion logic by avoiding N^2 conversion implementations.

**Storage version**: Mark exactly one version as `+kubebuilder:storageversion`. Changing the storage version requires a migration job to update all existing objects in etcd.

**Conversion webhooks**: Required when multiple versions are served and schema differences exist. cert-manager handles TLS certificate rotation for webhook servers.

**Round-trip fidelity**: Preserve fields that cannot be represented in older versions as annotations. This enables clients using the old API to modify resources without losing data added by newer API versions.

**Safe upgrade**: Always verify the storage version list before upgrading. Run a migration if multiple versions appear in `status.storedVersions`. Deploy operator with a rolling update strategy to avoid conversion webhook downtime.

**Testing**: Write round-trip conversion tests and integration tests with envtest. Conversion bugs are silent data loss issues that manifest as unexpected controller behavior.

The controller-gen annotations (`+kubebuilder:storageversion`, `+kubebuilder:deprecation`, validation markers) automate the majority of the CRD manifest generation, reducing the risk of manual errors in schema definitions.
