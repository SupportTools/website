---
title: "Custom Resource Definitions Best Practices: Building Production-Ready Kubernetes Extensions"
date: 2026-08-22T00:00:00-05:00
draft: false
tags: ["Kubernetes", "CRD", "Custom Resources", "API Extension", "Controllers", "Operators"]
categories: ["Kubernetes", "Platform Engineering", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to designing, implementing, and operating Custom Resource Definitions (CRDs) in Kubernetes with production-ready patterns, validation, and versioning strategies."
more_link: "yes"
url: "/kubernetes-custom-resource-definitions-best-practices/"
---

Custom Resource Definitions (CRDs) extend the Kubernetes API to manage application-specific resources with the same rigor as built-in Kubernetes objects. When properly designed, CRDs enable declarative management of complex applications and infrastructure. This comprehensive guide explores enterprise-ready patterns for creating robust, maintainable, and scalable CRDs.

<!--more-->

## Understanding Custom Resource Definitions

CRDs allow you to define custom resources that extend Kubernetes functionality:

- **API Extension**: Add new resource types to your cluster
- **Declarative Management**: Use kubectl and YAML manifests
- **Controller Integration**: Build custom controllers to manage resources
- **Native Kubernetes Experience**: Leverage existing tooling and patterns

## Basic CRD Structure

### Simple CRD Definition

```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  # Name must be in the form: <plural>.<group>
  name: applications.platform.example.com
spec:
  # Group name for the custom resource
  group: platform.example.com
  # Supported versions
  versions:
  - name: v1
    # Served enables/disables this version from API
    served: true
    # Storage version - exactly one version must be marked as storage
    storage: true
    # Schema for validation
    schema:
      openAPIV3Schema:
        type: object
        properties:
          spec:
            type: object
            properties:
              name:
                type: string
                minLength: 1
                maxLength: 253
              replicas:
                type: integer
                minimum: 1
                maximum: 100
                default: 1
              image:
                type: string
                pattern: '^[a-z0-9]+([._-][a-z0-9]+)*(:[a-z0-9]+([._-][a-z0-9]+)*)?(/[a-z0-9]+([._-][a-z0-9]+)*)*$'
              resources:
                type: object
                properties:
                  cpu:
                    type: string
                    pattern: '^[0-9]+(m|[0-9])*$'
                  memory:
                    type: string
                    pattern: '^[0-9]+(Mi|Gi)$'
            required:
            - name
            - image
          status:
            type: object
            properties:
              conditions:
                type: array
                items:
                  type: object
                  properties:
                    type:
                      type: string
                    status:
                      type: string
                      enum: ["True", "False", "Unknown"]
                    lastTransitionTime:
                      type: string
                      format: date-time
                    reason:
                      type: string
                    message:
                      type: string
                  required:
                  - type
                  - status
              observedGeneration:
                type: integer
              phase:
                type: string
                enum: ["Pending", "Running", "Failed", "Succeeded"]
    # Additional printer columns for kubectl get
    additionalPrinterColumns:
    - name: Replicas
      type: integer
      jsonPath: .spec.replicas
    - name: Phase
      type: string
      jsonPath: .status.phase
    - name: Age
      type: date
      jsonPath: .metadata.creationTimestamp
    # Subresources enable status and scale
    subresources:
      status: {}
      scale:
        specReplicasPath: .spec.replicas
        statusReplicasPath: .status.replicas
        labelSelectorPath: .status.labelSelector
  # Scope determines if namespaced or cluster-wide
  scope: Namespaced
  # Plural, singular, and kind names
  names:
    plural: applications
    singular: application
    kind: Application
    shortNames:
    - app
    - apps
```

### Example Custom Resource

```yaml
apiVersion: platform.example.com/v1
kind: Application
metadata:
  name: web-application
  namespace: production
spec:
  name: web-app
  replicas: 3
  image: nginx:1.25
  resources:
    cpu: "500m"
    memory: "512Mi"
status:
  phase: Running
  observedGeneration: 1
  replicas: 3
  labelSelector: app=web-application
  conditions:
  - type: Ready
    status: "True"
    lastTransitionTime: "2025-12-04T10:00:00Z"
    reason: ApplicationReady
    message: Application is running successfully
```

## Advanced CRD Features

### Comprehensive Validation Schema

```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: databases.platform.example.com
spec:
  group: platform.example.com
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
            properties:
              # Database type with enum validation
              type:
                type: string
                enum:
                - postgresql
                - mysql
                - mongodb
                description: "Type of database to provision"
              # Version with pattern matching
              version:
                type: string
                pattern: '^\d+\.\d+(\.\d+)?$'
                description: "Database version (e.g., 15.3)"
              # Storage configuration with validation
              storage:
                type: object
                properties:
                  size:
                    type: string
                    pattern: '^[0-9]+Gi$'
                    description: "Storage size (e.g., 100Gi)"
                  storageClass:
                    type: string
                    minLength: 1
                    description: "StorageClass name"
                  backupEnabled:
                    type: boolean
                    default: true
                  backupSchedule:
                    type: string
                    pattern: '^(@(annually|yearly|monthly|weekly|daily|hourly))|((\*|([0-9]|1[0-9]|2[0-9]|3[0-9]|4[0-9]|5[0-9])|\*\/([0-9]|1[0-9]|2[0-9]|3[0-9]|4[0-9]|5[0-9])) (\*|([0-9]|1[0-9]|2[0-3])|\*\/([0-9]|1[0-9]|2[0-3])) (\*|([1-9]|1[0-9]|2[0-9]|3[0-1])|\*\/([1-9]|1[0-9]|2[0-9]|3[0-1])) (\*|([1-9]|1[0-2])|\*\/([1-9]|1[0-2])) (\*|([0-6])|\*\/([0-6])))$'
                    description: "Backup schedule in cron format"
                required:
                - size
                - storageClass
              # High availability configuration
              highAvailability:
                type: object
                properties:
                  enabled:
                    type: boolean
                    default: false
                  replicas:
                    type: integer
                    minimum: 2
                    maximum: 5
                    default: 2
                  replicationMode:
                    type: string
                    enum:
                    - async
                    - sync
                    - semi-sync
                    default: async
              # Resource limits with structured validation
              resources:
                type: object
                properties:
                  cpu:
                    type: string
                    pattern: '^[0-9]+(m|[0-9])*$'
                  memory:
                    type: string
                    pattern: '^[0-9]+(Mi|Gi)$'
                  maxConnections:
                    type: integer
                    minimum: 10
                    maximum: 10000
                    default: 100
              # Connection configuration
              access:
                type: object
                properties:
                  mode:
                    type: string
                    enum:
                    - internal
                    - external
                    - both
                    default: internal
                  allowedNamespaces:
                    type: array
                    items:
                      type: string
                    minItems: 1
                  tlsEnabled:
                    type: boolean
                    default: true
              # Maintenance windows
              maintenance:
                type: object
                properties:
                  enabled:
                    type: boolean
                    default: true
                  window:
                    type: string
                    pattern: '^(Mon|Tue|Wed|Thu|Fri|Sat|Sun):(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]-(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]$'
                    description: "Maintenance window (e.g., Sun:02:00-06:00)"
            required:
            - type
            - version
            - storage
          status:
            type: object
            properties:
              phase:
                type: string
                enum:
                - Pending
                - Provisioning
                - Ready
                - Degraded
                - Failed
                - Terminating
              conditions:
                type: array
                items:
                  type: object
                  properties:
                    type:
                      type: string
                    status:
                      type: string
                      enum: ["True", "False", "Unknown"]
                    lastTransitionTime:
                      type: string
                      format: date-time
                    lastUpdateTime:
                      type: string
                      format: date-time
                    reason:
                      type: string
                    message:
                      type: string
                  required:
                  - type
                  - status
                  - lastTransitionTime
              connectionString:
                type: string
              endpoints:
                type: object
                properties:
                  primary:
                    type: string
                  replicas:
                    type: array
                    items:
                      type: string
              observedGeneration:
                type: integer
              lastBackup:
                type: string
                format: date-time
    additionalPrinterColumns:
    - name: Type
      type: string
      jsonPath: .spec.type
    - name: Version
      type: string
      jsonPath: .spec.version
    - name: Phase
      type: string
      jsonPath: .status.phase
    - name: Age
      type: date
      jsonPath: .metadata.creationTimestamp
    subresources:
      status: {}
  scope: Namespaced
  names:
    plural: databases
    singular: database
    kind: Database
    shortNames:
    - db
```

### CRD with Multiple Versions

```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: workflows.automation.example.com
spec:
  group: automation.example.com
  versions:
  # v1 - Current stable version
  - name: v1
    served: true
    storage: true
    schema:
      openAPIV3Schema:
        type: object
        properties:
          spec:
            type: object
            properties:
              name:
                type: string
              steps:
                type: array
                items:
                  type: object
                  properties:
                    name:
                      type: string
                    action:
                      type: string
                    timeout:
                      type: string
                      pattern: '^[0-9]+(s|m|h)$'
                    retryPolicy:
                      type: object
                      properties:
                        maxAttempts:
                          type: integer
                          minimum: 1
                          maximum: 10
                        backoff:
                          type: string
                          enum: [linear, exponential]
            required:
            - name
            - steps
    additionalPrinterColumns:
    - name: Steps
      type: integer
      jsonPath: .spec.steps[*].length()
    - name: Age
      type: date
      jsonPath: .metadata.creationTimestamp
  # v1beta1 - Deprecated version
  - name: v1beta1
    served: true
    storage: false
    deprecated: true
    deprecationWarning: "automation.example.com/v1beta1 Workflow is deprecated; use automation.example.com/v1 Workflow"
    schema:
      openAPIV3Schema:
        type: object
        properties:
          spec:
            type: object
            properties:
              workflowName:
                type: string
              tasks:
                type: array
                items:
                  type: object
                  properties:
                    taskName:
                      type: string
                    taskAction:
                      type: string
  # Conversion webhook for version migration
  conversion:
    strategy: Webhook
    webhook:
      conversionReviewVersions: ["v1", "v1beta1"]
      clientConfig:
        service:
          namespace: automation
          name: workflow-conversion-webhook
          path: /convert
          port: 443
        caBundle: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0t...
  scope: Namespaced
  names:
    plural: workflows
    singular: workflow
    kind: Workflow
    shortNames:
    - wf
```

### Conversion Webhook Implementation

```go
// conversion-webhook.go
package main

import (
    "encoding/json"
    "fmt"
    "net/http"

    apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime"
)

type WorkflowV1 struct {
    metav1.TypeMeta   `json:",inline"`
    metav1.ObjectMeta `json:"metadata,omitempty"`
    Spec   WorkflowSpecV1   `json:"spec"`
    Status WorkflowStatusV1 `json:"status,omitempty"`
}

type WorkflowSpecV1 struct {
    Name  string    `json:"name"`
    Steps []StepV1  `json:"steps"`
}

type StepV1 struct {
    Name        string        `json:"name"`
    Action      string        `json:"action"`
    Timeout     string        `json:"timeout"`
    RetryPolicy *RetryPolicy  `json:"retryPolicy,omitempty"`
}

type RetryPolicy struct {
    MaxAttempts int    `json:"maxAttempts"`
    Backoff     string `json:"backoff"`
}

type WorkflowV1Beta1 struct {
    metav1.TypeMeta   `json:",inline"`
    metav1.ObjectMeta `json:"metadata,omitempty"`
    Spec   WorkflowSpecV1Beta1 `json:"spec"`
}

type WorkflowSpecV1Beta1 struct {
    WorkflowName string        `json:"workflowName"`
    Tasks        []TaskV1Beta1 `json:"tasks"`
}

type TaskV1Beta1 struct {
    TaskName   string `json:"taskName"`
    TaskAction string `json:"taskAction"`
}

func convertV1Beta1ToV1(src *WorkflowV1Beta1) (*WorkflowV1, error) {
    dst := &WorkflowV1{
        TypeMeta: metav1.TypeMeta{
            APIVersion: "automation.example.com/v1",
            Kind:       "Workflow",
        },
        ObjectMeta: src.ObjectMeta,
        Spec: WorkflowSpecV1{
            Name:  src.Spec.WorkflowName,
            Steps: make([]StepV1, len(src.Spec.Tasks)),
        },
    }

    for i, task := range src.Spec.Tasks {
        dst.Spec.Steps[i] = StepV1{
            Name:    task.TaskName,
            Action:  task.TaskAction,
            Timeout: "5m", // Default timeout
            RetryPolicy: &RetryPolicy{
                MaxAttempts: 3,
                Backoff:     "linear",
            },
        }
    }

    return dst, nil
}

func convertV1ToV1Beta1(src *WorkflowV1) (*WorkflowV1Beta1, error) {
    dst := &WorkflowV1Beta1{
        TypeMeta: metav1.TypeMeta{
            APIVersion: "automation.example.com/v1beta1",
            Kind:       "Workflow",
        },
        ObjectMeta: src.ObjectMeta,
        Spec: WorkflowSpecV1Beta1{
            WorkflowName: src.Spec.Name,
            Tasks:        make([]TaskV1Beta1, len(src.Spec.Steps)),
        },
    }

    for i, step := range src.Spec.Steps {
        dst.Spec.Tasks[i] = TaskV1Beta1{
            TaskName:   step.Name,
            TaskAction: step.Action,
        }
    }

    return dst, nil
}

func handleConvert(w http.ResponseWriter, r *http.Request) {
    var convertReview apiextensionsv1.ConversionReview
    if err := json.NewDecoder(r.Body).Decode(&convertReview); err != nil {
        http.Error(w, fmt.Sprintf("failed to decode body: %v", err), http.StatusBadRequest)
        return
    }

    convertedObjects := []runtime.RawExtension{}
    for _, obj := range convertReview.Request.Objects {
        var converted runtime.Object
        var err error

        // Determine source and target versions
        if convertReview.Request.DesiredAPIVersion == "automation.example.com/v1" {
            // Convert from v1beta1 to v1
            var src WorkflowV1Beta1
            if err := json.Unmarshal(obj.Raw, &src); err != nil {
                http.Error(w, fmt.Sprintf("failed to unmarshal source: %v", err), http.StatusBadRequest)
                return
            }
            converted, err = convertV1Beta1ToV1(&src)
        } else if convertReview.Request.DesiredAPIVersion == "automation.example.com/v1beta1" {
            // Convert from v1 to v1beta1
            var src WorkflowV1
            if err := json.Unmarshal(obj.Raw, &src); err != nil {
                http.Error(w, fmt.Sprintf("failed to unmarshal source: %v", err), http.StatusBadRequest)
                return
            }
            converted, err = convertV1ToV1Beta1(&src)
        }

        if err != nil {
            http.Error(w, fmt.Sprintf("conversion failed: %v", err), http.StatusInternalServerError)
            return
        }

        convertedObj, err := json.Marshal(converted)
        if err != nil {
            http.Error(w, fmt.Sprintf("failed to marshal converted object: %v", err), http.StatusInternalServerError)
            return
        }

        convertedObjects = append(convertedObjects, runtime.RawExtension{Raw: convertedObj})
    }

    convertReview.Response = &apiextensionsv1.ConversionResponse{
        UID:              convertReview.Request.UID,
        ConvertedObjects: convertedObjects,
        Result: metav1.Status{
            Status: "Success",
        },
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(convertReview)
}

func main() {
    http.HandleFunc("/convert", handleConvert)
    http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
    })

    fmt.Println("Conversion webhook server starting on :8443")
    if err := http.ListenAndServeTLS(":8443", "/certs/tls.crt", "/certs/tls.key", nil); err != nil {
        panic(err)
    }
}
```

## Validation Webhooks

### Validating Admission Webhook

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingWebhookConfiguration
metadata:
  name: database-validator
webhooks:
- name: validate.database.platform.example.com
  admissionReviewVersions: ["v1", "v1beta1"]
  clientConfig:
    service:
      namespace: platform
      name: database-webhook
      path: /validate
      port: 443
    caBundle: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0t...
  rules:
  - operations: ["CREATE", "UPDATE"]
    apiGroups: ["platform.example.com"]
    apiVersions: ["v1alpha1"]
    resources: ["databases"]
    scope: "Namespaced"
  sideEffects: None
  timeoutSeconds: 10
  failurePolicy: Fail
  namespaceSelector:
    matchExpressions:
    - key: environment
      operator: In
      values: ["production", "staging"]
```

### Validation Webhook Implementation

```go
// validation-webhook.go
package main

import (
    "encoding/json"
    "fmt"
    "net/http"
    "regexp"

    admissionv1 "k8s.io/api/admission/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

type Database struct {
    metav1.TypeMeta   `json:",inline"`
    metav1.ObjectMeta `json:"metadata,omitempty"`
    Spec              DatabaseSpec `json:"spec"`
}

type DatabaseSpec struct {
    Type              string              `json:"type"`
    Version           string              `json:"version"`
    Storage           StorageSpec         `json:"storage"`
    HighAvailability  *HASpec             `json:"highAvailability,omitempty"`
    Resources         *ResourceSpec       `json:"resources,omitempty"`
}

type StorageSpec struct {
    Size          string `json:"size"`
    StorageClass  string `json:"storageClass"`
    BackupEnabled bool   `json:"backupEnabled"`
}

type HASpec struct {
    Enabled         bool   `json:"enabled"`
    Replicas        int    `json:"replicas"`
    ReplicationMode string `json:"replicationMode"`
}

type ResourceSpec struct {
    CPU            string `json:"cpu"`
    Memory         string `json:"memory"`
    MaxConnections int    `json:"maxConnections"`
}

func validateDatabase(db *Database) []string {
    var errors []string

    // Validate version format
    versionRegex := regexp.MustCompile(`^\d+\.\d+(\.\d+)?$`)
    if !versionRegex.MatchString(db.Spec.Version) {
        errors = append(errors, "invalid version format, expected X.Y or X.Y.Z")
    }

    // Validate storage size
    sizeRegex := regexp.MustCompile(`^[0-9]+Gi$`)
    if !sizeRegex.MatchString(db.Spec.Storage.Size) {
        errors = append(errors, "invalid storage size format, expected NumberGi")
    }

    // Validate storage class exists (simplified check)
    validStorageClasses := []string{"fast-ssd", "standard", "backup"}
    validClass := false
    for _, class := range validStorageClasses {
        if db.Spec.Storage.StorageClass == class {
            validClass = true
            break
        }
    }
    if !validClass {
        errors = append(errors, fmt.Sprintf("invalid storage class, must be one of: %v", validStorageClasses))
    }

    // Validate HA configuration
    if db.Spec.HighAvailability != nil && db.Spec.HighAvailability.Enabled {
        if db.Spec.HighAvailability.Replicas < 2 {
            errors = append(errors, "high availability requires at least 2 replicas")
        }

        validReplicationModes := []string{"async", "sync", "semi-sync"}
        validMode := false
        for _, mode := range validReplicationModes {
            if db.Spec.HighAvailability.ReplicationMode == mode {
                validMode = true
                break
            }
        }
        if !validMode {
            errors = append(errors, fmt.Sprintf("invalid replication mode, must be one of: %v", validReplicationModes))
        }
    }

    // Validate resource specifications
    if db.Spec.Resources != nil {
        cpuRegex := regexp.MustCompile(`^[0-9]+(m|[0-9])*$`)
        if !cpuRegex.MatchString(db.Spec.Resources.CPU) {
            errors = append(errors, "invalid CPU format")
        }

        memRegex := regexp.MustCompile(`^[0-9]+(Mi|Gi)$`)
        if !memRegex.MatchString(db.Spec.Resources.Memory) {
            errors = append(errors, "invalid memory format")
        }

        if db.Spec.Resources.MaxConnections < 10 || db.Spec.Resources.MaxConnections > 10000 {
            errors = append(errors, "maxConnections must be between 10 and 10000")
        }
    }

    // Business logic validation
    if db.Spec.Type == "postgresql" && db.Spec.Version < "13.0" {
        errors = append(errors, "PostgreSQL version must be 13.0 or higher for production use")
    }

    return errors
}

func handleValidate(w http.ResponseWriter, r *http.Request) {
    var admissionReview admissionv1.AdmissionReview
    if err := json.NewDecoder(r.Body).Decode(&admissionReview); err != nil {
        http.Error(w, fmt.Sprintf("failed to decode body: %v", err), http.StatusBadRequest)
        return
    }

    var db Database
    if err := json.Unmarshal(admissionReview.Request.Object.Raw, &db); err != nil {
        http.Error(w, fmt.Sprintf("failed to unmarshal database: %v", err), http.StatusBadRequest)
        return
    }

    // Perform validation
    errors := validateDatabase(&db)

    admissionResponse := &admissionv1.AdmissionResponse{
        UID: admissionReview.Request.UID,
    }

    if len(errors) > 0 {
        admissionResponse.Allowed = false
        admissionResponse.Result = &metav1.Status{
            Status:  "Failure",
            Message: fmt.Sprintf("Validation failed: %v", errors),
            Reason:  metav1.StatusReasonInvalid,
            Code:    http.StatusUnprocessableEntity,
        }
    } else {
        admissionResponse.Allowed = true
        admissionResponse.Result = &metav1.Status{
            Status: "Success",
        }
    }

    admissionReview.Response = admissionResponse
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(admissionReview)
}

func main() {
    http.HandleFunc("/validate", handleValidate)
    http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
    })

    fmt.Println("Validation webhook server starting on :8443")
    if err := http.ListenAndServeTLS(":8443", "/certs/tls.crt", "/certs/tls.key", nil); err != nil {
        panic(err)
    }
}
```

## Mutating Webhooks

### Mutating Admission Webhook for Default Values

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: MutatingWebhookConfiguration
metadata:
  name: database-defaulter
webhooks:
- name: default.database.platform.example.com
  admissionReviewVersions: ["v1", "v1beta1"]
  clientConfig:
    service:
      namespace: platform
      name: database-webhook
      path: /mutate
      port: 443
    caBundle: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0t...
  rules:
  - operations: ["CREATE"]
    apiGroups: ["platform.example.com"]
    apiVersions: ["v1alpha1"]
    resources: ["databases"]
    scope: "Namespaced"
  sideEffects: None
  timeoutSeconds: 10
  failurePolicy: Fail
```

### Mutating Webhook Implementation

```go
// mutating-webhook.go
package main

import (
    "encoding/json"
    "fmt"
    "net/http"

    admissionv1 "k8s.io/api/admission/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

type PatchOperation struct {
    Op    string      `json:"op"`
    Path  string      `json:"path"`
    Value interface{} `json:"value,omitempty"`
}

func createPatch(db *Database) ([]PatchOperation, error) {
    var patches []PatchOperation

    // Set default backup enabled
    if db.Spec.Storage.BackupEnabled == false {
        patches = append(patches, PatchOperation{
            Op:    "add",
            Path:  "/spec/storage/backupEnabled",
            Value: true,
        })
    }

    // Set default resources if not specified
    if db.Spec.Resources == nil {
        patches = append(patches, PatchOperation{
            Op:   "add",
            Path: "/spec/resources",
            Value: map[string]interface{}{
                "cpu":            "1000m",
                "memory":         "2Gi",
                "maxConnections": 100,
            },
        })
    }

    // Set default HA configuration for production
    if db.ObjectMeta.Namespace == "production" && db.Spec.HighAvailability == nil {
        patches = append(patches, PatchOperation{
            Op:   "add",
            Path: "/spec/highAvailability",
            Value: map[string]interface{}{
                "enabled":         true,
                "replicas":        2,
                "replicationMode": "async",
            },
        })
    }

    // Add labels
    if db.ObjectMeta.Labels == nil {
        patches = append(patches, PatchOperation{
            Op:    "add",
            Path:  "/metadata/labels",
            Value: map[string]string{},
        })
    }

    patches = append(patches, PatchOperation{
        Op:    "add",
        Path:  "/metadata/labels/managed-by",
        Value: "database-operator",
    })

    patches = append(patches, PatchOperation{
        Op:    "add",
        Path:  "/metadata/labels/database-type",
        Value: db.Spec.Type,
    })

    return patches, nil
}

func handleMutate(w http.ResponseWriter, r *http.Request) {
    var admissionReview admissionv1.AdmissionReview
    if err := json.NewDecoder(r.Body).Decode(&admissionReview); err != nil {
        http.Error(w, fmt.Sprintf("failed to decode body: %v", err), http.StatusBadRequest)
        return
    }

    var db Database
    if err := json.Unmarshal(admissionReview.Request.Object.Raw, &db); err != nil {
        http.Error(w, fmt.Sprintf("failed to unmarshal database: %v", err), http.StatusBadRequest)
        return
    }

    // Create patches
    patches, err := createPatch(&db)
    if err != nil {
        http.Error(w, fmt.Sprintf("failed to create patch: %v", err), http.StatusInternalServerError)
        return
    }

    patchBytes, err := json.Marshal(patches)
    if err != nil {
        http.Error(w, fmt.Sprintf("failed to marshal patches: %v", err), http.StatusInternalServerError)
        return
    }

    admissionResponse := &admissionv1.AdmissionResponse{
        UID:     admissionReview.Request.UID,
        Allowed: true,
    }

    if len(patches) > 0 {
        patchType := admissionv1.PatchTypeJSONPatch
        admissionResponse.PatchType = &patchType
        admissionResponse.Patch = patchBytes
    }

    admissionReview.Response = admissionResponse
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(admissionReview)
}

func main() {
    http.HandleFunc("/mutate", handleMutate)
    http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
    })

    fmt.Println("Mutating webhook server starting on :8443")
    if err := http.ListenAndServeTLS(":8443", "/certs/tls.crt", "/certs/tls.key", nil); err != nil {
        panic(err)
    }
}
```

## CRD Testing and Validation

### Kubernetes Testing Framework

```bash
#!/bin/bash
# test-crd.sh

set -euo pipefail

NAMESPACE="test-platform"
CRD_NAME="databases.platform.example.com"

echo "Testing CRD: $CRD_NAME"

# Apply CRD
echo "Applying CRD..."
kubectl apply -f database-crd.yaml

# Wait for CRD to be established
echo "Waiting for CRD to be established..."
kubectl wait --for condition=established --timeout=60s crd/$CRD_NAME

# Test valid resource creation
echo "Testing valid resource creation..."
cat <<EOF | kubectl apply -f -
apiVersion: platform.example.com/v1alpha1
kind: Database
metadata:
  name: test-db
  namespace: $NAMESPACE
spec:
  type: postgresql
  version: "15.3"
  storage:
    size: "100Gi"
    storageClass: "standard"
    backupEnabled: true
  resources:
    cpu: "1000m"
    memory: "2Gi"
    maxConnections: 100
EOF

# Verify resource was created
kubectl get database test-db -n $NAMESPACE

# Test invalid resource (should fail)
echo "Testing invalid resource creation..."
set +e
cat <<EOF | kubectl apply -f - 2>&1 | grep -q "validation"
apiVersion: platform.example.com/v1alpha1
kind: Database
metadata:
  name: invalid-db
  namespace: $NAMESPACE
spec:
  type: postgresql
  version: "invalid-version"
  storage:
    size: "invalid-size"
    storageClass: "nonexistent"
EOF

if [ $? -eq 0 ]; then
  echo "✓ Invalid resource correctly rejected"
else
  echo "✗ Invalid resource was not rejected"
  exit 1
fi
set -e

# Test resource update
echo "Testing resource update..."
kubectl patch database test-db -n $NAMESPACE --type=merge -p '{"spec":{"resources":{"maxConnections":200}}}'

# Verify update
MAX_CONNECTIONS=$(kubectl get database test-db -n $NAMESPACE -o jsonpath='{.spec.resources.maxConnections}')
if [ "$MAX_CONNECTIONS" == "200" ]; then
  echo "✓ Resource update successful"
else
  echo "✗ Resource update failed"
  exit 1
fi

# Test status subresource
echo "Testing status subresource..."
kubectl patch database test-db -n $NAMESPACE --subresource=status --type=merge -p '{"status":{"phase":"Ready"}}'

# Verify status
PHASE=$(kubectl get database test-db -n $NAMESPACE -o jsonpath='{.status.phase}')
if [ "$PHASE" == "Ready" ]; then
  echo "✓ Status subresource working"
else
  echo "✗ Status subresource not working"
  exit 1
fi

# Cleanup
echo "Cleaning up..."
kubectl delete database test-db -n $NAMESPACE
kubectl delete crd $CRD_NAME

echo "All tests passed!"
```

## CRD Management Best Practices

### 1. Version Migration Strategy

```yaml
# migration-job.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: crd-migration-v1beta1-to-v1
  namespace: platform
spec:
  template:
    spec:
      serviceAccountName: crd-migrator
      restartPolicy: OnFailure
      containers:
      - name: migrator
        image: bitnami/kubectl:latest
        command:
        - /bin/bash
        - -c
        - |
          #!/bin/bash
          set -euo pipefail

          echo "Starting CRD migration from v1beta1 to v1..."

          # Get all v1beta1 resources
          kubectl get workflows.v1beta1.automation.example.com --all-namespaces -o json > /tmp/v1beta1-resources.json

          # Convert each resource
          jq -c '.items[]' /tmp/v1beta1-resources.json | while read -r resource; do
            NAME=$(echo "$resource" | jq -r '.metadata.name')
            NAMESPACE=$(echo "$resource" | jq -r '.metadata.namespace')

            echo "Migrating $NAMESPACE/$NAME..."

            # Get v1 version (triggers conversion)
            kubectl get workflow "$NAME" -n "$NAMESPACE" -o yaml > "/tmp/${NAMESPACE}-${NAME}-v1.yaml"

            # Verify conversion
            if kubectl apply --dry-run=server -f "/tmp/${NAMESPACE}-${NAME}-v1.yaml"; then
              echo "✓ $NAMESPACE/$NAME migrated successfully"
            else
              echo "✗ $NAMESPACE/$NAME migration failed"
              exit 1
            fi
          done

          echo "Migration complete!"
```

### 2. CRD Deployment Pipeline

```yaml
# crd-pipeline.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: crd-deployment-script
  namespace: platform
data:
  deploy.sh: |
    #!/bin/bash
    set -euo pipefail

    CRD_FILE=$1
    ENVIRONMENT=$2

    echo "Deploying CRD to $ENVIRONMENT..."

    # Validate CRD
    echo "Validating CRD schema..."
    kubectl apply --dry-run=server --validate=true -f "$CRD_FILE"

    # Apply CRD
    echo "Applying CRD..."
    kubectl apply -f "$CRD_FILE"

    # Wait for CRD to be ready
    CRD_NAME=$(yq eval '.metadata.name' "$CRD_FILE")
    kubectl wait --for condition=established --timeout=60s "crd/$CRD_NAME"

    # Run validation tests
    echo "Running validation tests..."
    /scripts/test-crd.sh "$CRD_NAME"

    # Check for existing resources
    PLURAL=$(yq eval '.spec.names.plural' "$CRD_FILE")
    GROUP=$(yq eval '.spec.group' "$CRD_FILE")

    EXISTING_COUNT=$(kubectl get "$PLURAL.$GROUP" --all-namespaces --no-headers 2>/dev/null | wc -l || echo "0")

    if [ "$EXISTING_COUNT" -gt 0 ]; then
      echo "Found $EXISTING_COUNT existing resources"
      echo "Validating existing resources against new schema..."

      kubectl get "$PLURAL.$GROUP" --all-namespaces -o json | \
        jq -r '.items[] | "\(.metadata.namespace)/\(.metadata.name)"' | \
        while read -r resource; do
          NAMESPACE=$(echo "$resource" | cut -d/ -f1)
          NAME=$(echo "$resource" | cut -d/ -f2)

          if kubectl get "$PLURAL.$GROUP" "$NAME" -n "$NAMESPACE" -o yaml | kubectl apply --dry-run=server -f -; then
            echo "✓ $resource is valid"
          else
            echo "✗ $resource validation failed"
            exit 1
          fi
        done
    fi

    echo "CRD deployment successful!"
```

### 3. CRD Documentation Generation

```go
// generate-crd-docs.go
package main

import (
    "fmt"
    "os"

    apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
    "sigs.k8s.io/yaml"
)

func generateMarkdownDocs(crd *apiextensionsv1.CustomResourceDefinition) string {
    md := fmt.Sprintf("# %s\n\n", crd.Spec.Names.Kind)
    md += fmt.Sprintf("**Group:** %s\n\n", crd.Spec.Group)
    md += fmt.Sprintf("**Scope:** %s\n\n", crd.Spec.Scope)

    md += "## Versions\n\n"
    for _, version := range crd.Spec.Versions {
        md += fmt.Sprintf("### %s\n\n", version.Name)
        md += fmt.Sprintf("- **Served:** %v\n", version.Served)
        md += fmt.Sprintf("- **Storage:** %v\n\n", version.Storage)

        if version.Schema != nil {
            md += "#### Schema\n\n"
            md += "```yaml\n"
            schemaYAML, _ := yaml.Marshal(version.Schema.OpenAPIV3Schema)
            md += string(schemaYAML)
            md += "```\n\n"
        }

        if len(version.AdditionalPrinterColumns) > 0 {
            md += "#### Additional Columns\n\n"
            md += "| Name | Type | JSONPath |\n"
            md += "|------|------|----------|\n"
            for _, col := range version.AdditionalPrinterColumns {
                md += fmt.Sprintf("| %s | %s | %s |\n", col.Name, col.Type, col.JSONPath)
            }
            md += "\n"
        }
    }

    md += "## Example\n\n"
    md += "```yaml\n"
    md += fmt.Sprintf("apiVersion: %s/%s\n", crd.Spec.Group, crd.Spec.Versions[0].Name)
    md += fmt.Sprintf("kind: %s\n", crd.Spec.Names.Kind)
    md += "metadata:\n"
    md += fmt.Sprintf("  name: example-%s\n", crd.Spec.Names.Singular)
    md += "spec:\n"
    md += "  # Add your specification here\n"
    md += "```\n"

    return md
}

func main() {
    if len(os.Args) < 2 {
        fmt.Println("Usage: generate-crd-docs <crd-file>")
        os.Exit(1)
    }

    crdFile := os.Args[1]
    data, err := os.ReadFile(crdFile)
    if err != nil {
        panic(err)
    }

    var crd apiextensionsv1.CustomResourceDefinition
    if err := yaml.Unmarshal(data, &crd); err != nil {
        panic(err)
    }

    docs := generateMarkdownDocs(&crd)
    fmt.Println(docs)
}
```

## Monitoring CRDs

### CRD Metrics Collection

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: crd-metrics-collector
  namespace: monitoring
data:
  collect.sh: |
    #!/bin/bash
    # Collect CRD metrics

    while true; do
      # Get all CRDs
      kubectl get crds -o json | jq -r '.items[] | {
        name: .metadata.name,
        group: .spec.group,
        versions: [.spec.versions[].name],
        scope: .spec.scope,
        established: .status.conditions[] | select(.type=="Established") | .status
      }' | while read -r crd_json; do
        CRD_NAME=$(echo "$crd_json" | jq -r '.name')
        GROUP=$(echo "$crd_json" | jq -r '.group')
        ESTABLISHED=$(echo "$crd_json" | jq -r '.established')

        # Count custom resources
        PLURAL=$(kubectl get crd "$CRD_NAME" -o jsonpath='{.spec.names.plural}')
        RESOURCE_COUNT=$(kubectl get "$PLURAL.$GROUP" --all-namespaces --no-headers 2>/dev/null | wc -l || echo "0")

        cat <<EOF >> /metrics/crd_metrics.prom
crd_established{name="$CRD_NAME",group="$GROUP"} $([ "$ESTABLISHED" == "True" ] && echo 1 || echo 0)
crd_resource_count{name="$CRD_NAME",group="$GROUP"} $RESOURCE_COUNT
EOF
      done

      sleep 30
    done
```

## Conclusion

Custom Resource Definitions are powerful tools for extending Kubernetes. Key takeaways:

- **Design comprehensive schemas** with proper validation
- **Implement version migration strategies** for backwards compatibility
- **Use admission webhooks** for complex validation and defaulting
- **Provide clear documentation** and examples
- **Monitor CRD health and usage** in production
- **Test thoroughly** before deploying to production
- **Follow semantic versioning** for API stability

By following these best practices, you can build robust, maintainable CRDs that integrate seamlessly with the Kubernetes ecosystem.