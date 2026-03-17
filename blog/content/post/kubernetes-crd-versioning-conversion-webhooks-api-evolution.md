---
title: "Kubernetes CRD Versioning: Conversion Webhooks, Hub Versions, and API Evolution"
date: 2030-04-18T00:00:00-05:00
draft: false
tags: ["Kubernetes", "CRD", "API Versioning", "Conversion Webhooks", "CEL", "Operators", "Go"]
categories: ["Kubernetes", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Kubernetes CRD version conversion webhooks, the hub-and-spoke conversion model, storage version migration, deprecated field handling, and validation rules with CEL expressions."
more_link: "yes"
url: "/kubernetes-crd-versioning-conversion-webhooks-api-evolution/"
---

Every API evolves. When you ship a Kubernetes operator, you make a promise to users: their custom resources will continue to work across upgrades. Breaking that promise corrupts stored objects, blocks cluster upgrades, and erodes trust in your operator. The Kubernetes CRD versioning system provides the mechanism to fulfill that promise — but it requires careful design. This guide covers the complete lifecycle of CRD API evolution: defining multiple versions, implementing conversion webhooks, using the hub-and-spoke model to avoid combinatorial conversion complexity, migrating stored objects to a new storage version, and expressing complex validation logic with CEL.

<!--more-->

## Why CRD Versioning Matters

Consider an operator managing `DatabaseCluster` resources. Version v1alpha1 has a flat configuration structure. After feedback, v1beta1 introduces nested configuration groups. After stabilization, v1 removes deprecated fields. Without proper versioning:

- Users running `kubectl get databasecluster` see errors when the stored object's version differs from what they expect
- The API server cannot store v1 objects if the conversion logic is missing
- An upgrade that changes the storage version without migrating existing objects corrupts the CRD

The Kubernetes CRD versioning system solves this through:

1. **Multiple served versions** — multiple versions co-exist in the API
2. **A single storage version** — exactly one version is stored in etcd
3. **Conversion webhooks** — convert between versions on read/write
4. **Storage migration** — migrate existing objects to the new storage version

## CRD with Multiple Versions

### Defining Multiple Versions

```yaml
# databasecluster-crd.yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: databaseclusters.db.example.com
spec:
  group: db.example.com
  names:
    kind: DatabaseCluster
    plural: databaseclusters
    singular: databasecluster
    shortNames: ["dbc"]
  scope: Namespaced
  
  # Conversion webhook - required when multiple versions exist
  conversion:
    strategy: Webhook
    webhook:
      clientConfig:
        service:
          name: db-operator-webhook
          namespace: db-operator-system
          path: /convert
          port: 443
        caBundle: <base64-encoded-ca-cert>
      conversionReviewVersions: ["v1"]
  
  versions:
  
  # v1alpha1 - initial version (deprecated)
  - name: v1alpha1
    served: true       # still served for backward compat
    storage: false     # not the storage version
    deprecated: true   # kubectl shows deprecation warning
    deprecationWarning: "v1alpha1 is deprecated, use v1beta1 or v1"
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
                maximum: 10
              # Flat structure - deprecated
              dbEngine:
                type: string
                enum: ["postgres", "mysql"]
              dbVersion:
                type: string
              storageSize:
                type: string
                pattern: '^[0-9]+(Gi|Mi|Ti)$'
  
  # v1beta1 - nested configuration structure
  - name: v1beta1
    served: true
    storage: false
    schema:
      openAPIV3Schema:
        type: object
        properties:
          spec:
            type: object
            required: ["replicas", "engine"]
            properties:
              replicas:
                type: integer
                minimum: 1
                maximum: 20
              engine:
                type: object
                required: ["type", "version"]
                properties:
                  type:
                    type: string
                    enum: ["postgres", "mysql", "mariadb"]
                  version:
                    type: string
                  parameters:
                    type: object
                    x-kubernetes-preserve-unknown-fields: true
              storage:
                type: object
                properties:
                  size:
                    type: string
                    pattern: '^[0-9]+(Gi|Mi|Ti)$'
                  storageClass:
                    type: string
          status:
            type: object
            x-kubernetes-preserve-unknown-fields: true
  
  # v1 - stable version
  - name: v1
    served: true
    storage: true      # THIS is the storage version
    schema:
      openAPIV3Schema:
        type: object
        properties:
          spec:
            type: object
            required: ["replicas", "engine", "storage"]
            properties:
              replicas:
                type: integer
                minimum: 1
                maximum: 100
                default: 1
              engine:
                type: object
                required: ["type", "version"]
                properties:
                  type:
                    type: string
                    enum: ["postgres", "mysql", "mariadb"]
                  version:
                    type: string
                    # CEL validation: version must be semver-like
                    x-kubernetes-validations:
                    - rule: "self.matches('^[0-9]+\\\\.[0-9]+(\\\\.[0-9]+)?$')"
                      message: "version must be in X.Y or X.Y.Z format"
                  parameters:
                    type: object
                    x-kubernetes-preserve-unknown-fields: true
              storage:
                type: object
                required: ["size"]
                properties:
                  size:
                    type: string
                    pattern: '^[0-9]+(Gi|Mi|Ti)$'
                  storageClass:
                    type: string
                    default: "standard"
                  backupEnabled:
                    type: boolean
                    default: false
              # CEL cross-field validation
              x-kubernetes-validations:
              - rule: "!(self.engine.type == 'mysql' && int(self.replicas) > 5)"
                message: "MySQL clusters are limited to 5 replicas"
          status:
            type: object
            properties:
              phase:
                type: string
                enum: ["Pending", "Running", "Degraded", "Failed"]
              readyReplicas:
                type: integer
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
    additionalPrinterColumns:
    - name: Phase
      type: string
      jsonPath: .status.phase
    - name: Replicas
      type: integer
      jsonPath: .spec.replicas
    - name: Engine
      type: string
      jsonPath: .spec.engine.type
    - name: Age
      type: date
      jsonPath: .metadata.creationTimestamp
    subresources:
      status: {}
      scale:
        specReplicasPath: .spec.replicas
        statusReplicasPath: .status.readyReplicas
```

## Conversion Webhook Implementation

### The Hub-and-Spoke Model

When you have N versions, implementing N*(N-1) bidirectional conversions is combinatorially expensive. The hub-and-spoke model designates one version (usually the latest stable version) as the "hub". All other versions convert to/from the hub. This reduces the number of conversion functions from O(N^2) to O(N).

```
v1alpha1 <----> v1 (hub) <----> v1beta1
                  ^
                  |
               v1beta2 (future)
```

The hub version should be your internal representation — the version your controller logic uses. Other versions are "spokes" that translate to and from the hub.

### Go Type Definitions

```go
// api/v1alpha1/databasecluster_types.go
package v1alpha1

import metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

type DatabaseClusterSpec struct {
    Replicas    int    `json:"replicas"`
    DBEngine    string `json:"dbEngine"`         // flat field (deprecated)
    DBVersion   string `json:"dbVersion"`         // flat field (deprecated)
    StorageSize string `json:"storageSize"`        // flat field (deprecated)
}

type DatabaseClusterStatus struct {
    Phase         string `json:"phase,omitempty"`
    ReadyReplicas int    `json:"readyReplicas,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
type DatabaseCluster struct {
    metav1.TypeMeta   `json:",inline"`
    metav1.ObjectMeta `json:"metadata,omitempty"`
    Spec              DatabaseClusterSpec   `json:"spec,omitempty"`
    Status            DatabaseClusterStatus `json:"status,omitempty"`
}
```

```go
// api/v1/databasecluster_types.go - THE HUB VERSION
package v1

import metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

type EngineSpec struct {
    Type       string            `json:"type"`
    Version    string            `json:"version"`
    Parameters map[string]string `json:"parameters,omitempty"`
}

type StorageSpec struct {
    Size         string `json:"size"`
    StorageClass string `json:"storageClass,omitempty"`
    BackupEnabled bool  `json:"backupEnabled,omitempty"`
}

type DatabaseClusterSpec struct {
    Replicas int         `json:"replicas"`
    Engine   EngineSpec  `json:"engine"`
    Storage  StorageSpec `json:"storage"`
}

type DatabaseClusterStatus struct {
    Phase         string             `json:"phase,omitempty"`
    ReadyReplicas int                `json:"readyReplicas,omitempty"`
    Conditions    []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:storageversion
type DatabaseCluster struct {
    metav1.TypeMeta   `json:",inline"`
    metav1.ObjectMeta `json:"metadata,omitempty"`
    Spec              DatabaseClusterSpec   `json:"spec,omitempty"`
    Status            DatabaseClusterStatus `json:"status,omitempty"`
}
```

### Conversion Functions (Hub-and-Spoke)

```go
// api/v1alpha1/databasecluster_conversion.go
package v1alpha1

import (
    "fmt"
    v1 "github.com/example/db-operator/api/v1"
    "sigs.k8s.io/controller-runtime/pkg/conversion"
)

// ConvertTo converts v1alpha1 -> v1 (the hub)
func (src *DatabaseCluster) ConvertTo(dstRaw conversion.Hub) error {
    dst := dstRaw.(*v1.DatabaseCluster)

    // Copy metadata
    dst.ObjectMeta = src.ObjectMeta

    // Convert flat spec to nested spec
    dst.Spec.Replicas = src.Spec.Replicas
    dst.Spec.Engine = v1.EngineSpec{
        Type:    src.Spec.DBEngine,
        Version: src.Spec.DBVersion,
    }
    dst.Spec.Storage = v1.StorageSpec{
        Size: src.Spec.StorageSize,
    }

    // Convert status
    dst.Status.Phase         = src.Status.Phase
    dst.Status.ReadyReplicas = src.Status.ReadyReplicas

    return nil
}

// ConvertFrom converts v1 (the hub) -> v1alpha1
func (dst *DatabaseCluster) ConvertFrom(srcRaw conversion.Hub) error {
    src := srcRaw.(*v1.DatabaseCluster)

    // Copy metadata
    dst.ObjectMeta = src.ObjectMeta

    // Convert nested spec to flat spec
    dst.Spec.Replicas    = src.Spec.Replicas
    dst.Spec.DBEngine    = src.Spec.Engine.Type
    dst.Spec.DBVersion   = src.Spec.Engine.Version
    dst.Spec.StorageSize = src.Spec.Storage.Size

    // Warn about information loss: parameters field has no v1alpha1 equivalent
    if len(src.Spec.Engine.Parameters) > 0 {
        if dst.Annotations == nil {
            dst.Annotations = make(map[string]string)
        }
        // Store as annotation to preserve round-trip fidelity
        dst.Annotations["db.example.com/v1-engine-parameters"] =
            fmt.Sprintf("%v", src.Spec.Engine.Parameters)
    }

    // Convert status
    dst.Status.Phase         = src.Status.Phase
    dst.Status.ReadyReplicas = src.Status.ReadyReplicas

    return nil
}

// Hub marks v1 as the hub version - only needed on the spoke types
// The Hub() method is on v1.DatabaseCluster (auto-generated by controller-gen)
```

### Webhook HTTP Handler

```go
// internal/webhook/conversion_handler.go
package webhook

import (
    "encoding/json"
    "fmt"
    "io"
    "net/http"

    apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime"
    "k8s.io/apimachinery/pkg/runtime/serializer"

    dbv1      "github.com/example/db-operator/api/v1"
    dbv1alpha1 "github.com/example/db-operator/api/v1alpha1"
    dbv1beta1  "github.com/example/db-operator/api/v1beta1"
)

var (
    scheme = runtime.NewScheme()
    codecs serializer.CodecFactory
)

func init() {
    dbv1.AddToScheme(scheme)
    dbv1alpha1.AddToScheme(scheme)
    dbv1beta1.AddToScheme(scheme)
    codecs = serializer.NewCodecFactory(scheme)
}

// ConversionHandler handles /convert requests from the API server
func ConversionHandler(w http.ResponseWriter, r *http.Request) {
    body, err := io.ReadAll(r.Body)
    if err != nil {
        http.Error(w, "failed to read body", http.StatusBadRequest)
        return
    }

    var review apiextensionsv1.ConversionReview
    if err := json.Unmarshal(body, &review); err != nil {
        http.Error(w, "failed to unmarshal", http.StatusBadRequest)
        return
    }

    review.Response = convert(review.Request)
    review.Response.UID = review.Request.UID

    responseBody, err := json.Marshal(&review)
    if err != nil {
        http.Error(w, "failed to marshal response", http.StatusInternalServerError)
        return
    }

    w.Header().Set("Content-Type", "application/json")
    w.Write(responseBody)
}

func convert(req *apiextensionsv1.ConversionRequest) *apiextensionsv1.ConversionResponse {
    response := &apiextensionsv1.ConversionResponse{}
    desiredAPIVersion := req.DesiredAPIVersion

    for _, rawObj := range req.Objects {
        // Deserialize the incoming object
        obj, _, err := codecs.UniversalDeserializer().Decode(rawObj.Raw, nil, nil)
        if err != nil {
            response.Result = metav1.Status{
                Status:  metav1.StatusFailure,
                Message: fmt.Sprintf("failed to decode: %v", err),
            }
            return response
        }

        // Convert to desired version using the hub-and-spoke mechanism
        converted, err := convertToVersion(obj, desiredAPIVersion)
        if err != nil {
            response.Result = metav1.Status{
                Status:  metav1.StatusFailure,
                Message: fmt.Sprintf("conversion failed: %v", err),
            }
            return response
        }

        // Serialize the converted object
        convertedRaw, err := json.Marshal(converted)
        if err != nil {
            response.Result = metav1.Status{
                Status:  metav1.StatusFailure,
                Message: fmt.Sprintf("failed to marshal converted: %v", err),
            }
            return response
        }

        response.ConvertedObjects = append(response.ConvertedObjects,
            runtime.RawExtension{Raw: convertedRaw})
    }

    response.Result = metav1.Status{Status: metav1.StatusSuccess}
    return response
}

func convertToVersion(obj runtime.Object, toVersion string) (runtime.Object, error) {
    // Step 1: Convert to hub (v1) regardless of source version
    var hub *dbv1.DatabaseCluster

    switch src := obj.(type) {
    case *dbv1.DatabaseCluster:
        hub = src // already hub version
    case *dbv1alpha1.DatabaseCluster:
        hub = &dbv1.DatabaseCluster{}
        if err := src.ConvertTo(hub); err != nil {
            return nil, fmt.Errorf("v1alpha1->v1: %w", err)
        }
    case *dbv1beta1.DatabaseCluster:
        hub = &dbv1.DatabaseCluster{}
        if err := src.ConvertTo(hub); err != nil {
            return nil, fmt.Errorf("v1beta1->v1: %w", err)
        }
    default:
        return nil, fmt.Errorf("unsupported source version: %T", obj)
    }

    // Step 2: Convert hub to desired version
    switch toVersion {
    case "db.example.com/v1":
        return hub, nil
    case "db.example.com/v1alpha1":
        dst := &dbv1alpha1.DatabaseCluster{}
        if err := dst.ConvertFrom(hub); err != nil {
            return nil, fmt.Errorf("v1->v1alpha1: %w", err)
        }
        return dst, nil
    case "db.example.com/v1beta1":
        dst := &dbv1beta1.DatabaseCluster{}
        if err := dst.ConvertFrom(hub); err != nil {
            return nil, fmt.Errorf("v1->v1beta1: %w", err)
        }
        return dst, nil
    default:
        return nil, fmt.Errorf("unsupported target version: %s", toVersion)
    }
}
```

## Storage Version Migration

When you change the storage version (e.g., from v1beta1 to v1), existing objects in etcd are still stored in the old version. The `StorageVersionMigrator` API handles migrating them.

### Using the StorageVersionMigrator

```bash
# Check what versions objects are stored as
kubectl get databaseclusters -A -o custom-columns=\
NAME:.metadata.name,\
NAMESPACE:.metadata.namespace,\
STORED-VERSION:.metadata.annotations."kubectl.kubernetes.io/last-applied-configuration"

# Check the CRD storage version status
kubectl get crd databaseclusters.db.example.com \
    -o jsonpath='{.status.storedVersions}'
# ["v1beta1","v1"]  <-- both versions present until migration completes
```

```yaml
# storage-version-migration.yaml
# Requires: StorageVersionMigrator feature gate (alpha in 1.30, beta in 1.32)
apiVersion: storagemigration.k8s.io/v1alpha1
kind: StorageVersionMigration
metadata:
  name: databaseclusters-to-v1
spec:
  resource:
    group: db.example.com
    resource: databaseclusters
    version: v1  # target version
```

```bash
kubectl apply -f storage-version-migration.yaml

# Monitor migration progress
kubectl describe storageversionmigration databaseclusters-to-v1

# After migration completes, remove old version from storedVersions
# (this happens automatically via the migration controller)

# Verify all objects are now stored as v1
kubectl get crd databaseclusters.db.example.com \
    -o jsonpath='{.status.storedVersions}'
# ["v1"]
```

### Manual Migration Script

For clusters without StorageVersionMigrator:

```bash
#!/usr/bin/env bash
# migrate-crd-storage-version.sh
# Triggers re-storage of all CRD instances to the current storage version
# by applying a no-op patch to each object

set -euo pipefail

GROUP="db.example.com"
RESOURCE="databaseclusters"

echo "Migrating ${RESOURCE} to current storage version..."

NAMESPACES=$(kubectl get namespace -o jsonpath='{.items[*].metadata.name}')

TOTAL=0
MIGRATED=0
FAILED=0

for ns in ${NAMESPACES}; do
    OBJECTS=$(kubectl get "${RESOURCE}.${GROUP}" -n "${ns}" \
        -o jsonpath='{.items[*].metadata.name}' 2>/dev/null || true)
    
    for obj in ${OBJECTS}; do
        TOTAL=$((TOTAL + 1))
        
        # Apply a no-op patch - forces the API server to re-store the object
        # in the current storage version
        if kubectl patch "${RESOURCE}.${GROUP}" "${obj}" -n "${ns}" \
            --type=merge \
            -p '{"metadata":{"annotations":{"db.example.com/storage-migrated":"true"}}}' \
            >/dev/null 2>&1; then
            MIGRATED=$((MIGRATED + 1))
        else
            echo "FAILED: ${ns}/${obj}"
            FAILED=$((FAILED + 1))
        fi
    done
done

echo "Migration complete: ${MIGRATED}/${TOTAL} succeeded, ${FAILED} failed"
```

## CEL Validation Rules

Common Expression Language (CEL) validation rules replace admission webhooks for simple validation logic. They run inside the API server, are faster than webhook calls, and support complex cross-field validation.

### Basic CEL Rules

```yaml
# CEL rules in CRD schema
x-kubernetes-validations:

# Simple type check
- rule: "self.replicas >= 1"
  message: "replicas must be at least 1"

# Pattern matching
- rule: "self.engine.version.matches('^[0-9]+\\.[0-9]+(\\.[0-9]+)?$')"
  message: "version must be semver format (X.Y or X.Y.Z)"

# Cross-field validation
- rule: "!(self.engine.type == 'mysql' && self.replicas > 5)"
  message: "MySQL clusters are limited to 5 replicas"

# Conditional requirement
- rule: "!self.storage.backupEnabled || self.storage.storageClass != ''"
  message: "storageClass must be set when backupEnabled is true"

# Immutability after creation
- rule: "self.engine.type == oldSelf.engine.type"
  message: "engine type is immutable after creation"

# Future date validation
- rule: "self.maintenanceWindow.start < self.maintenanceWindow.end"
  message: "maintenanceWindow start must be before end"

# Array length
- rule: "size(self.allowedCIDRs) <= 50"
  message: "maximum 50 allowed CIDRs"

# Map key validation
- rule: "self.labels.all(k, k.matches('^[a-z][a-z0-9-]*$'))"
  message: "label keys must be lowercase alphanumeric with hyphens"
```

### Advanced CEL Patterns

```yaml
# Transition rules: validate state machine transitions
x-kubernetes-validations:
# Only allow valid phase transitions
- rule: >
    !(oldSelf.status.phase == 'Running' &&
      self.status.phase == 'Pending')
  message: "Cannot transition from Running back to Pending"

# Immutable fields: prevent changes after creation
- rule: >
    self.creationTimestamp != null ||
    self.spec.engine.type == oldSelf.spec.engine.type
  message: "engine.type is immutable once set"

# Quota enforcement at admission time
- rule: >
    !(self.spec.storage.size.endsWith('Ti') &&
      int(self.spec.storage.size.replace('Ti','')) > 100)
  message: "storage size cannot exceed 100Ti"

# Dependent field validation
- rule: >
    !(has(self.spec.tls) && self.spec.tls.enabled) ||
    (has(self.spec.tls.certSecretName) &&
     self.spec.tls.certSecretName != "")
  message: "tls.certSecretName required when tls.enabled is true"
```

### CEL in ValidatingAdmissionPolicy (VAP)

For cluster-wide policies that span multiple CRD types, use ValidatingAdmissionPolicy:

```yaml
# cluster-database-policy.yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: database-cluster-policy
spec:
  failurePolicy: Fail
  matchConstraints:
    resourceRules:
    - apiGroups: ["db.example.com"]
      apiVersions: ["v1"]
      operations: ["CREATE", "UPDATE"]
      resources: ["databaseclusters"]
  validations:
  - expression: >
      object.spec.replicas <= 20 ||
      object.metadata.annotations.has("db.example.com/approved-for-large-cluster")
    message: "Clusters with more than 20 replicas require the approved-for-large-cluster annotation"
    reason: Forbidden
  
  - expression: >
      !object.metadata.namespace.startsWith("prod") ||
      object.spec.storage.backupEnabled == true
    message: "Databases in production namespaces must have backup enabled"
  
  - expression: >
      !object.spec.engine.type.contains("postgres") ||
      object.spec.engine.version.matches("^1[4-9]\\.")
    message: "Only PostgreSQL 14+ is supported in new clusters"

---
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicyBinding
metadata:
  name: database-cluster-policy-binding
spec:
  policyName: database-cluster-policy
  validationActions: [Deny]
  matchResources:
    namespaceSelector:
      matchExpressions:
      - key: environment
        operator: In
        values: ["staging", "production"]
```

## Deprecating Fields Gracefully

```go
// Handling deprecated fields in the conversion layer
// Keep deprecated fields readable but warn on write

// api/v1alpha1/databasecluster_types.go
type DatabaseClusterSpec struct {
    Replicas    int    `json:"replicas"`

    // Deprecated: use Engine.Type instead
    // +deprecated
    DBEngine    string `json:"dbEngine,omitempty"`

    // Deprecated: use Engine.Version instead
    // +deprecated
    DBVersion   string `json:"dbVersion,omitempty"`

    // Deprecated: use Storage.Size instead
    // +deprecated
    StorageSize string `json:"storageSize,omitempty"`
}
```

```go
// Conversion with deprecation warning preserved in annotations
func (src *DatabaseCluster) ConvertTo(dstRaw conversion.Hub) error {
    dst := dstRaw.(*v1.DatabaseCluster)
    dst.ObjectMeta = src.ObjectMeta

    if dst.Annotations == nil {
        dst.Annotations = make(map[string]string)
    }

    // Track which deprecated fields were used
    var deprecated []string
    if src.Spec.DBEngine != "" {
        deprecated = append(deprecated, "spec.dbEngine")
        dst.Spec.Engine.Type = src.Spec.DBEngine
    }
    if src.Spec.DBVersion != "" {
        deprecated = append(deprecated, "spec.dbVersion")
        dst.Spec.Engine.Version = src.Spec.DBVersion
    }
    if src.Spec.StorageSize != "" {
        deprecated = append(deprecated, "spec.storageSize")
        dst.Spec.Storage.Size = src.Spec.StorageSize
    }

    if len(deprecated) > 0 {
        dst.Annotations["db.example.com/deprecated-fields-used"] =
            strings.Join(deprecated, ",")
    }

    dst.Spec.Replicas = src.Spec.Replicas
    return nil
}
```

## Testing Conversion Webhooks

```go
// internal/webhook/conversion_test.go
package webhook_test

import (
    "encoding/json"
    "testing"

    dbv1      "github.com/example/db-operator/api/v1"
    dbv1alpha1 "github.com/example/db-operator/api/v1alpha1"
)

func TestV1Alpha1ToV1Conversion(t *testing.T) {
    src := &dbv1alpha1.DatabaseCluster{}
    src.Name = "test-cluster"
    src.Namespace = "default"
    src.Spec = dbv1alpha1.DatabaseClusterSpec{
        Replicas:    3,
        DBEngine:    "postgres",
        DBVersion:   "14.5",
        StorageSize: "10Gi",
    }

    dst := &dbv1.DatabaseCluster{}
    if err := src.ConvertTo(dst); err != nil {
        t.Fatalf("ConvertTo failed: %v", err)
    }

    if dst.Spec.Replicas != 3 {
        t.Errorf("replicas: got %d, want 3", dst.Spec.Replicas)
    }
    if dst.Spec.Engine.Type != "postgres" {
        t.Errorf("engine.type: got %q, want postgres", dst.Spec.Engine.Type)
    }
    if dst.Spec.Engine.Version != "14.5" {
        t.Errorf("engine.version: got %q, want 14.5", dst.Spec.Engine.Version)
    }
    if dst.Spec.Storage.Size != "10Gi" {
        t.Errorf("storage.size: got %q, want 10Gi", dst.Spec.Storage.Size)
    }
}

func TestRoundTripConversion(t *testing.T) {
    // Start with a v1alpha1 object
    original := &dbv1alpha1.DatabaseCluster{}
    original.Name = "round-trip-test"
    original.Namespace = "default"
    original.Spec = dbv1alpha1.DatabaseClusterSpec{
        Replicas:    5,
        DBEngine:    "mysql",
        DBVersion:   "8.0",
        StorageSize: "50Gi",
    }

    // Convert to v1 (hub)
    hub := &dbv1.DatabaseCluster{}
    if err := original.ConvertTo(hub); err != nil {
        t.Fatalf("ConvertTo hub: %v", err)
    }

    // Convert back from v1 to v1alpha1
    roundTripped := &dbv1alpha1.DatabaseCluster{}
    if err := roundTripped.ConvertFrom(hub); err != nil {
        t.Fatalf("ConvertFrom hub: %v", err)
    }

    // Verify key fields survived the round trip
    if roundTripped.Spec.Replicas != original.Spec.Replicas {
        t.Errorf("replicas: got %d, want %d",
            roundTripped.Spec.Replicas, original.Spec.Replicas)
    }
    if roundTripped.Spec.DBEngine != original.Spec.DBEngine {
        t.Errorf("dbEngine: got %q, want %q",
            roundTripped.Spec.DBEngine, original.Spec.DBEngine)
    }
    if roundTripped.Spec.StorageSize != original.Spec.StorageSize {
        t.Errorf("storageSize: got %q, want %q",
            roundTripped.Spec.StorageSize, original.Spec.StorageSize)
    }
}

func TestWebhookConversionHandler(t *testing.T) {
    // Build a ConversionReview request
    srcObj := &dbv1alpha1.DatabaseCluster{}
    srcObj.Name = "webhook-test"
    srcObj.Namespace = "default"
    srcObj.APIVersion = "db.example.com/v1alpha1"
    srcObj.Kind = "DatabaseCluster"
    srcObj.Spec = dbv1alpha1.DatabaseClusterSpec{
        Replicas: 2,
        DBEngine: "postgres",
        DBVersion: "15.0",
        StorageSize: "20Gi",
    }

    rawSrc, _ := json.Marshal(srcObj)

    // Verify the convertToVersion function directly
    converted, err := convertToVersion(srcObj, "db.example.com/v1")
    if err != nil {
        t.Fatalf("convertToVersion: %v", err)
    }

    v1obj, ok := converted.(*dbv1.DatabaseCluster)
    if !ok {
        t.Fatalf("expected *v1.DatabaseCluster, got %T", converted)
    }
    _ = rawSrc

    if v1obj.Spec.Engine.Type != "postgres" {
        t.Errorf("engine.type: got %q, want postgres", v1obj.Spec.Engine.Type)
    }
}
```

## Webhook Deployment

```yaml
# webhook-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: db-operator-webhook
  namespace: db-operator-system
spec:
  replicas: 2
  selector:
    matchLabels:
      app: db-operator-webhook
  template:
    metadata:
      labels:
        app: db-operator-webhook
    spec:
      containers:
      - name: webhook
        image: example/db-operator:latest
        command: ["/manager", "webhook"]
        ports:
        - containerPort: 9443
          name: webhook
          protocol: TCP
        readinessProbe:
          httpGet:
            path: /healthz
            port: 8081
          initialDelaySeconds: 5
          periodSeconds: 10
        livenessProbe:
          httpGet:
            path: /healthz
            port: 8081
          initialDelaySeconds: 15
          periodSeconds: 20
        volumeMounts:
        - name: webhook-certs
          mountPath: /tmp/k8s-webhook-server/serving-certs
          readOnly: true
        resources:
          requests:
            memory: "64Mi"
            cpu: "50m"
          limits:
            memory: "128Mi"
            cpu: "200m"
      volumes:
      - name: webhook-certs
        secret:
          secretName: db-operator-webhook-cert
---
apiVersion: v1
kind: Service
metadata:
  name: db-operator-webhook
  namespace: db-operator-system
spec:
  selector:
    app: db-operator-webhook
  ports:
  - port: 443
    targetPort: 9443
    protocol: TCP
```

## Key Takeaways

CRD versioning is a long-term commitment, not an afterthought. The design decisions you make when you release your first version — field names, nesting structure, validation rules — constrain every future version.

**Hub-and-spoke model**: Designate your current stable version as the hub and implement all conversions to/from it. This keeps conversion logic at O(N) functions rather than O(N^2). The hub should be your internal representation — the version your controller logic works with.

**Immutability annotations**: Use the `oldSelf` CEL variable to enforce field immutability at admission time rather than in controller reconciliation logic. This fails fast and gives users clear error messages.

**Storage version migration**: Changing the storage version without migrating existing objects results in a CRD with multiple `storedVersions`. Always run the StorageVersionMigrator (or the manual script) after changing the storage version. Leaving multiple stored versions blocks CRD cleanup during upgrades.

**CEL over webhooks**: For validation logic that is expressible as a CEL rule, prefer CEL. It runs in-process in the API server with sub-millisecond latency and does not require maintaining a webhook deployment. Use webhooks only for logic that genuinely requires external data (e.g., checking a quota service).

**Test conversions bidirectionally**: Every `ConvertTo` must be paired with a round-trip test: `ConvertTo -> ConvertFrom` must produce an object equal to the original. Lossless round-trips are required for the Kubernetes API machinery to correctly handle `apply` operations.
