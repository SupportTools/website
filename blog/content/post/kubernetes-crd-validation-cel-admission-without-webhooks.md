---
title: "Kubernetes CRD Validation with CEL: Admission-Time Validation Without Webhooks"
date: 2031-09-19T00:00:00-05:00
draft: false
tags: ["Kubernetes", "CRD", "CEL", "Validation", "Custom Resources", "Admission Control"]
categories:
- Kubernetes
- Development
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to using Common Expression Language (CEL) for CRD validation in Kubernetes, including schema validation rules, cross-field checks, transition rules, and status subresource validation."
more_link: "yes"
url: "/kubernetes-crd-validation-cel-admission-without-webhooks/"
---

Custom Resource Definitions have long supported JSON Schema validation for basic field type and format checks. But structural validation — ensuring that a field's value is consistent with other fields, that a status transition is valid, that a hostname format matches a specific pattern — required either a validating webhook or accepting that the API would allow logically invalid objects.

Kubernetes 1.25 promoted CRD validation rules using Common Expression Language to stable. CEL allows you to write validation logic directly in the CRD manifest, evaluated in-process by the API server at admission time, with no webhook latency, no webhook availability dependency, and no additional infrastructure to maintain.

This post covers CEL validation rules in full, from simple field constraints to complex cross-field and state transition rules, along with the operational considerations for deploying and iterating on validated CRDs in production.

<!--more-->

# Kubernetes CRD Validation with CEL

## Why CEL Instead of Webhooks?

Validating webhooks work, but they have significant operational overhead:

- The webhook service must be highly available; if it is down, admission fails (or is bypassed if `failurePolicy: Ignore` is set, which defeats the purpose).
- Webhook calls add latency to every admission request.
- Webhook logic is typically in a separate binary that must be deployed, versioned, and maintained.
- Testing webhook logic requires a running cluster or extensive mocking.

CEL validation rules are embedded in the CRD schema itself. They run synchronously in the API server, require no additional services, and are versioned with the CRD. For most validation use cases, CEL is the correct tool.

CEL does have limits: it cannot call external systems, cannot make API calls to the cluster, and has a cost budget per evaluation to prevent denial-of-service. For validation that requires external lookups (checking uniqueness across resources, for example), a webhook is still necessary.

## Basic Structure of CEL Validation Rules

CEL rules are specified in the `x-kubernetes-validations` extension on any schema node in a CRD:

```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: databases.apps.example.com
spec:
  group: apps.example.com
  versions:
    - name: v1
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              x-kubernetes-validations:
                - rule: "self.replicas >= 1 && self.replicas <= 100"
                  message: "replicas must be between 1 and 100"
                - rule: "self.primaryRegion != self.backupRegion"
                  message: "primaryRegion and backupRegion must differ"
              properties:
                replicas:
                  type: integer
                  minimum: 1
                primaryRegion:
                  type: string
                backupRegion:
                  type: string
  scope: Namespaced
  names:
    plural: databases
    singular: database
    kind: Database
```

The `rule` field is a CEL expression that must evaluate to `true` for the object to be accepted. The `message` field is returned to the user when validation fails.

## CEL Variables and the `self` Keyword

Within a validation rule, `self` refers to the schema node where the rule is defined. At the top-level `spec`, `self` is the entire spec object. At a nested field, `self` is the value of that field:

```yaml
properties:
  storage:
    type: object
    x-kubernetes-validations:
      - rule: "self.sizeGB > 0"
        message: "storage.sizeGB must be positive"
      - rule: "self.sizeGB <= self.maxSizeGB"
        message: "sizeGB cannot exceed maxSizeGB"
    properties:
      sizeGB:
        type: integer
      maxSizeGB:
        type: integer
```

The `oldSelf` variable refers to the value before an update, enabling state-transition validation:

```yaml
x-kubernetes-validations:
  - rule: "self.sizeGB >= oldSelf.sizeGB"
    message: "storage size cannot be decreased"
    reason: FieldValueForbidden
```

The `reason` field maps to an HTTP reason phrase returned in the error. Available values:

- `FieldValueRequired`
- `FieldValueDuplicate`
- `FieldValueInvalid`
- `FieldValueForbidden`
- `FieldValueNotFound`
- `FieldValueNotSupported`
- `FieldValueTooLong`
- `FieldValueTooMany`

## Complete CRD Example: Database Cluster

```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: databaseclusters.apps.example.com
spec:
  group: apps.example.com
  versions:
    - name: v1
      served: true
      storage: true
      subresources:
        status: {}
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
      schema:
        openAPIV3Schema:
          type: object
          required: ["spec"]
          properties:
            spec:
              type: object
              required: ["replicas", "engine", "storage"]
              x-kubernetes-validations:
                # Cross-field: backup region differs from primary
                - rule: >
                    !has(self.backup) ||
                    self.backup.region != self.primaryRegion
                  message: "backup.region must differ from primaryRegion"

                # Cross-field: maintenance window makes sense
                - rule: >
                    !has(self.maintenanceWindow) ||
                    self.maintenanceWindow.startHour < self.maintenanceWindow.endHour
                  message: "maintenanceWindow.startHour must be before endHour"

                # Replicas must be odd for quorum-based engines
                - rule: >
                    self.engine.type != "etcd" ||
                    (self.replicas % 2 == 1)
                  message: "etcd clusters must have an odd number of replicas"

              properties:
                replicas:
                  type: integer
                  minimum: 1
                  maximum: 100
                  x-kubernetes-validations:
                    - rule: "self % 2 == 1 || self == 2"
                      message: "replicas must be 2 or an odd number (for quorum)"

                primaryRegion:
                  type: string
                  pattern: '^[a-z]{2}-[a-z]+-[0-9]+$'

                engine:
                  type: object
                  required: ["type", "version"]
                  x-kubernetes-validations:
                    - rule: >
                        self.type != "postgres" ||
                        self.version.matches('^[0-9]{2}$')
                      message: "PostgreSQL version must be a two-digit major version (e.g., '16')"
                    - rule: >
                        self.type != "mysql" ||
                        self.version.matches('^[89]\\.[0-9]+$')
                      message: "MySQL version must be 8.x or 9.x"
                  properties:
                    type:
                      type: string
                      enum: ["postgres", "mysql", "etcd"]
                    version:
                      type: string

                storage:
                  type: object
                  required: ["sizeGB", "storageClass"]
                  x-kubernetes-validations:
                    - rule: "self.sizeGB >= 10"
                      message: "storage.sizeGB must be at least 10"
                    - rule: >
                        !has(self.maxSizeGB) ||
                        self.maxSizeGB >= self.sizeGB
                      message: "storage.maxSizeGB must be >= sizeGB when set"
                  properties:
                    sizeGB:
                      type: integer
                    maxSizeGB:
                      type: integer
                    storageClass:
                      type: string
                      x-kubernetes-validations:
                        - rule: >
                            self in ["standard", "premium", "ultra", "local"]
                          message: "storageClass must be one of: standard, premium, ultra, local"

                backup:
                  type: object
                  x-kubernetes-validations:
                    - rule: >
                        !has(self.retentionDays) ||
                        (self.retentionDays >= 1 && self.retentionDays <= 365)
                      message: "backup.retentionDays must be between 1 and 365"
                  properties:
                    enabled:
                      type: boolean
                    region:
                      type: string
                    retentionDays:
                      type: integer
                    schedule:
                      type: string
                      x-kubernetes-validations:
                        - rule: >
                            self.matches(
                              '^(\\*|[0-9,\\-/]+)\\s+(\\*|[0-9,\\-/]+)\\s+(\\*|[0-9,\\-/]+)\\s+(\\*|[0-9,\\-/]+)\\s+(\\*|[0-9,\\-/]+)$'
                            )
                          message: "backup.schedule must be a valid cron expression"

                maintenanceWindow:
                  type: object
                  required: ["startHour", "endHour", "day"]
                  properties:
                    startHour:
                      type: integer
                      minimum: 0
                      maximum: 23
                    endHour:
                      type: integer
                      minimum: 0
                      maximum: 23
                    day:
                      type: string
                      enum:
                        - Monday
                        - Tuesday
                        - Wednesday
                        - Thursday
                        - Friday
                        - Saturday
                        - Sunday

            status:
              type: object
              x-kubernetes-validations:
                - rule: >
                    !has(self.phase) ||
                    self.phase in ["Pending", "Provisioning", "Running",
                                   "Updating", "Failed", "Deleting"]
                  message: "Invalid phase"
              properties:
                phase:
                  type: string
                readyReplicas:
                  type: integer
                  minimum: 0
                message:
                  type: string
  scope: Namespaced
  names:
    plural: databaseclusters
    singular: databasecluster
    kind: DatabaseCluster
    shortNames: ["dbc"]
```

## State Transition Rules

CEL `oldSelf` enables immutability constraints and valid state machine transitions:

```yaml
# Applied at the spec level
x-kubernetes-validations:
  # Engine type is immutable after creation
  - rule: "self.engine.type == oldSelf.engine.type"
    message: "engine.type is immutable"
    reason: FieldValueForbidden

  # Storage can only be increased
  - rule: "self.storage.sizeGB >= oldSelf.storage.sizeGB"
    message: "storage.sizeGB cannot be reduced"
    reason: FieldValueForbidden

  # Replicas can only change by 1 at a time (safe scaling)
  - rule: >
      int(self.replicas) - int(oldSelf.replicas) <= 1 &&
      int(oldSelf.replicas) - int(self.replicas) <= 1
    message: "replicas can only change by 1 at a time for safe rolling updates"
```

To skip `oldSelf` validation on object creation (when `oldSelf` is the zero value), use `optionalOldSelf`:

```yaml
x-kubernetes-validations:
  - rule: >
      !has(oldSelf.primaryRegion) ||
      self.primaryRegion == oldSelf.primaryRegion
    message: "primaryRegion is immutable after creation"
    optionalOldSelf: true
```

## CEL Functions Reference

CEL provides a rich set of built-in functions for string and list manipulation:

```
# String operations
self.name.startsWith("prod-")
self.name.endsWith("-v2")
self.name.contains("legacy")
self.name.matches("^[a-z][a-z0-9-]{0,62}[a-z0-9]$")
self.name.size() <= 63
self.name.upperAscii() == "PRODUCTION"
self.name.lowerAscii() == "production"
self.name.replace("-", "_")
self.name.split("-").size() == 3
self.name.trim() == self.name  # no leading/trailing whitespace

# List operations
self.tags.all(t, t.matches("^[a-z0-9-]+$"))      # all elements match
self.tags.exists(t, t == "production")             # at least one matches
self.tags.exists_one(t, t.startsWith("env-"))     # exactly one matches
self.tags.filter(t, t.startsWith("k8s-")).size() <= 5
self.tags.map(t, t.lowerAscii()).all(t, t == t)   # already lowercase
self.tags.size() <= 20
"production" in self.tags

# Numeric operations
self.replicas >= 1 && self.replicas <= 100
self.storage.sizeGB % 100 == 0  # must be multiple of 100
math.greatest(self.minCPU, 100) <= self.maxCPU
math.least(self.sizeGB, self.maxSizeGB) == self.sizeGB

# Type checks
has(self.optionalField)         # field is present
type(self.value) == int         # type check
```

## Validating IP Addresses and CIDR Blocks

Common networking validations using CEL:

```yaml
properties:
  networking:
    type: object
    x-kubernetes-validations:
      # Valid CIDR notation
      - rule: >
          !has(self.podCIDR) ||
          self.podCIDR.matches(
            '^([0-9]{1,3}\\.){3}[0-9]{1,3}/[0-9]{1,2}$'
          )
        message: "podCIDR must be a valid CIDR block"

      # Pod and service CIDRs must not overlap (simplified check)
      - rule: >
          !has(self.podCIDR) || !has(self.serviceCIDR) ||
          self.podCIDR.split(".")[0] != self.serviceCIDR.split(".")[0] ||
          self.podCIDR.split(".")[1] != self.serviceCIDR.split(".")[1]
        message: "podCIDR and serviceCIDR must not be in the same /16 range"

      # Valid hostname
      - rule: >
          self.endpoint.matches(
            '^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$'
          )
        message: "endpoint must be a valid hostname"
    properties:
      podCIDR:
        type: string
      serviceCIDR:
        type: string
      endpoint:
        type: string
```

## MessageExpression: Dynamic Error Messages

Kubernetes 1.27+ supports `messageExpression` for dynamic error messages:

```yaml
x-kubernetes-validations:
  - rule: "self.replicas >= self.minReplicas"
    messageExpression: >
      'replicas (' + string(self.replicas) +
      ') must be >= minReplicas (' +
      string(self.minReplicas) + ')'

  - rule: "self.storage.sizeGB <= self.storage.maxSizeGB"
    messageExpression: >
      'storage.sizeGB (' + string(self.storage.sizeGB) +
      ' GB) exceeds storage.maxSizeGB (' +
      string(self.storage.maxSizeGB) + ' GB)'
```

## CEL Cost Budget

The API server enforces a cost budget on CEL evaluation to prevent expensive rules from impacting API server performance. Each CEL operation has an assigned cost:

| Operation | Cost |
|-----------|------|
| Field access | 1 |
| String length | size(string) |
| Regex match | size(string) × 10 |
| List iteration | size(list) × cost_per_item |
| `all()` on list | size(list) × rule_cost |

Rules that exceed the cost budget are rejected at CRD creation time, not at runtime. You can check estimated cost:

```bash
# Dry-run CRD application to see cost validation errors
kubectl apply --dry-run=server -f my-crd.yaml
```

To reduce cost, rewrite expensive patterns:

```yaml
# Expensive: regex on each list element
- rule: "self.tags.all(t, t.matches('^[a-z0-9-]+$'))"

# Less expensive: check tags size first, then validate each
- rule: >
    self.tags.size() <= 50 &&
    self.tags.all(t, t.size() <= 63 && t.matches('^[a-z][a-z0-9-]*$'))
```

## Testing CEL Rules

CEL rules can be tested before deploying to a cluster using the `cel-go` library:

```go
// cmd/validate-crd/main.go
package main

import (
    "fmt"
    "log"

    "github.com/google/cel-go/cel"
    "github.com/google/cel-go/checker/decls"
)

func main() {
    env, err := cel.NewEnv(
        cel.Declarations(
            decls.NewVar("self", decls.NewObjectType("map")),
        ),
    )
    if err != nil {
        log.Fatal(err)
    }

    rules := []struct {
        expression string
        testData   map[string]interface{}
        expectPass bool
    }{
        {
            expression: "self.replicas >= 1 && self.replicas <= 100",
            testData:   map[string]interface{}{"replicas": int64(3)},
            expectPass: true,
        },
        {
            expression: "self.replicas >= 1 && self.replicas <= 100",
            testData:   map[string]interface{}{"replicas": int64(150)},
            expectPass: false,
        },
        {
            expression: "self.engine.type != 'etcd' || self.replicas % 2 == 1",
            testData: map[string]interface{}{
                "engine":   map[string]interface{}{"type": "etcd"},
                "replicas": int64(3),
            },
            expectPass: true,
        },
    }

    for _, rule := range rules {
        ast, issues := env.Parse(rule.expression)
        if issues.Err() != nil {
            log.Printf("Parse error: %v", issues.Err())
            continue
        }
        prg, err := env.Program(ast)
        if err != nil {
            log.Printf("Program error: %v", err)
            continue
        }

        out, _, err := prg.Eval(map[string]interface{}{"self": rule.testData})
        if err != nil {
            log.Printf("Eval error: %v", err)
            continue
        }

        passed := out.Value().(bool)
        status := "PASS"
        if passed != rule.expectPass {
            status = "FAIL"
        }
        fmt.Printf("[%s] %s\n", status, rule.expression)
    }
}
```

## Integration with controller-gen

When using `controller-gen` for CRD generation from Go types, embed CEL rules using struct tags:

```go
// api/v1/databasecluster_types.go
package v1

import metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

// DatabaseClusterSpec defines the desired state
// +kubebuilder:validation:XValidation:rule="self.replicas % 2 == 1 || self.replicas == 2",message="replicas must be 2 or odd"
// +kubebuilder:validation:XValidation:rule="self.engine.type != 'etcd' || self.replicas >= 3",message="etcd requires at least 3 replicas"
type DatabaseClusterSpec struct {
    // +kubebuilder:validation:Minimum=1
    // +kubebuilder:validation:Maximum=100
    Replicas int32 `json:"replicas"`

    Engine EngineSpec `json:"engine"`

    // +kubebuilder:validation:XValidation:rule="self.sizeGB >= 10",message="sizeGB must be >= 10"
    // +kubebuilder:validation:XValidation:rule="!has(self.maxSizeGB) || self.maxSizeGB >= self.sizeGB",message="maxSizeGB must be >= sizeGB"
    Storage StorageSpec `json:"storage"`
}

// +kubebuilder:validation:XValidation:rule="self.type != 'postgres' || self.version.matches('^[0-9]{2}$')",message="PostgreSQL version must be two digits"
type EngineSpec struct {
    // +kubebuilder:validation:Enum=postgres;mysql;etcd
    Type    string `json:"type"`
    Version string `json:"version"`
}

type StorageSpec struct {
    // +kubebuilder:validation:Minimum=10
    SizeGB int32 `json:"sizeGB"`
    // +kubebuilder:validation:Optional
    MaxSizeGB *int32 `json:"maxSizeGB,omitempty"`
    // +kubebuilder:validation:Enum=standard;premium;ultra;local
    StorageClass string `json:"storageClass"`
}
```

Generate the CRD:

```bash
controller-gen crd:crdVersions=v1 rbac:roleName=database-operator \
  webhook paths="./..." output:crd:artifacts:config=config/crd/bases
```

## ValidatingAdmissionPolicy: CEL Beyond CRDs

Kubernetes 1.30 stabilized `ValidatingAdmissionPolicy`, which uses CEL to validate any resource — not just CRDs — without webhooks:

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: require-labels
spec:
  failurePolicy: Fail
  matchConstraints:
    resourceRules:
      - apiGroups: ["apps"]
        apiVersions: ["v1"]
        operations: ["CREATE", "UPDATE"]
        resources: ["deployments"]
  variables:
    - name: labels
      expression: "object.metadata.labels"
  validations:
    - expression: "'app' in variables.labels"
      message: "Deployments must have an 'app' label"
    - expression: "'team' in variables.labels"
      message: "Deployments must have a 'team' label"
    - expression: >
        !('env' in variables.labels) ||
        variables.labels['env'] in ['dev', 'staging', 'prod']
      message: "env label must be one of: dev, staging, prod"
---
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicyBinding
metadata:
  name: require-labels-binding
spec:
  policyName: require-labels
  validationActions: [Deny]
  matchResources:
    namespaceSelector:
      matchLabels:
        enforce-labels: "true"
```

## Summary

CEL validation rules in CRDs represent a major quality-of-life improvement for platform teams building Kubernetes-native applications. By embedding validation logic in the CRD manifest — supporting cross-field checks, state transition guards, string pattern matching, and list operations — you eliminate the operational overhead of validating webhooks for the majority of validation use cases. The key is understanding the `self`/`oldSelf` model, the cost budget constraints, and the interplay with JSON Schema validation for a layered, comprehensive validation strategy.
