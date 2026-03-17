---
title: "Kubernetes Custom Resource Validation with CEL: Common Expression Language in CRDs"
date: 2030-06-14T00:00:00-05:00
draft: false
tags: ["Kubernetes", "CRD", "CEL", "Validation", "Custom Resources", "API"]
categories:
- Kubernetes
- Platform Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to CEL-based validation in Kubernetes CRDs: expression syntax, transition rules, field validation, cost estimation, and migrating from webhook-based validation to CEL."
more_link: "yes"
url: "/kubernetes-cel-validation-crd-common-expression-language/"
---

CEL (Common Expression Language) validation in Kubernetes CRDs represents a fundamental shift in how custom resource validation is implemented. Previously, complex validation logic required admission webhook servers — separate HTTP services that had to be maintained, secured, and made highly available. CEL validation moves this logic directly into the CRD specification, evaluated in-process by the API server without any network round-trips. This guide covers CEL expression syntax, transition rules, cost estimation, performance implications, and a production-ready migration path from webhook-based validation.

<!--more-->

## Background: Why CEL Replaces Webhooks for Validation

Admission webhooks for validation introduce several operational challenges:

- **Availability dependency**: If the webhook server is unavailable and `failurePolicy: Fail` is set, all resource creation or updates block. This can create cluster-wide outages during upgrades.
- **Latency**: Every admission request travels over the network to the webhook service, adding latency to every API operation.
- **Complexity**: Webhook servers require TLS certificates, service accounts, webhook registrations, and separate deployment artifacts.
- **Observability**: Debugging webhook rejections requires inspecting webhook server logs, which may be in a different namespace or cluster.

CEL validation (GA in Kubernetes 1.29) solves all of these problems. Validation expressions are stored in the CRD itself, evaluated synchronously by the API server, and return structured error messages without any external dependencies.

## CEL Expression Basics

CEL is a strongly typed, memory-safe expression language. In the context of Kubernetes validation, CEL expressions receive access to `self` (the object being validated) and `oldSelf` (the previous version, for update validation).

### Basic Type Support

CEL supports all JSON-compatible types:

```
string, int, double, bool, bytes, null
list (arrays), map (objects), timestamps, durations
```

### Field Access

```cel
# Access a field
self.spec.replicas

# Access a nested field
self.spec.template.spec.containers[0].name

# Access a map key
self.metadata.labels["app"]

# Safe access with optional operator (avoids null pointer errors)
self.spec.?tolerations.orValue([])
```

### String Operations

```cel
# String matching
self.metadata.name.startsWith("prod-")
self.spec.image.endsWith(":latest") == false

# Regular expression match
self.spec.hostname.matches('^[a-z][a-z0-9-]{1,62}[a-z0-9]$')

# String contains
"admin" in self.spec.groups

# String length
self.spec.description.size() <= 256
```

### Numeric Operations

```cel
# Comparison
self.spec.replicas >= 1 && self.spec.replicas <= 100

# Arithmetic
self.spec.minReplicas <= self.spec.maxReplicas

# Modulo
self.spec.port % 1000 != 0
```

### List Operations

```cel
# Size check
self.spec.containers.size() >= 1

# All elements satisfy a condition
self.spec.containers.all(c, c.image.contains(":"))

# Any element satisfies a condition
self.spec.containers.exists(c, c.name == "main")

# Filter and count
self.spec.ports.filter(p, p.protocol == "TCP").size() > 0

# Map to extract values
self.spec.containers.map(c, c.name)

# Check for unique names
self.spec.containers.map(c, c.name).size() ==
  self.spec.containers.map(c, c.name).toSet().size()
```

### Map Operations

```cel
# Key existence
"app" in self.metadata.labels

# Value access with fallback
self.metadata.labels.?app.orValue("unknown")

# Size check
self.metadata.labels.size() <= 20
```

## Defining Validation Rules in CRDs

CEL validation rules are specified in the `x-kubernetes-validations` field within the CRD schema. Each rule contains an `expression` and a `message`.

### Simple Field Validation

```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: webapplications.apps.example.com
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
                # Replicas must be positive
                - rule: "self.replicas >= 1"
                  message: "replicas must be at least 1"

                # Max replicas must exceed min replicas
                - rule: "self.minReplicas <= self.maxReplicas"
                  message: "minReplicas must be less than or equal to maxReplicas"

                # Port range validation
                - rule: "self.port >= 1 && self.port <= 65535"
                  message: "port must be between 1 and 65535"

              properties:
                replicas:
                  type: integer
                  minimum: 1
                  maximum: 100
                minReplicas:
                  type: integer
                maxReplicas:
                  type: integer
                port:
                  type: integer
```

### Container Name Uniqueness

```yaml
schema:
  openAPIV3Schema:
    type: object
    properties:
      spec:
        type: object
        x-kubernetes-validations:
          - rule: |
              self.containers.map(c, c.name).size() ==
              self.containers.map(c, c.name).toSet().size()
            message: "container names must be unique"

          - rule: |
              self.containers.all(c,
                c.name.matches('^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$') ||
                c.name.matches('^[a-z0-9]$')
              )
            message: "container names must be lowercase alphanumeric with hyphens"

        properties:
          containers:
            type: array
            items:
              type: object
              properties:
                name:
                  type: string
                image:
                  type: string
```

### Cross-Field Validation with Conditional Logic

```yaml
x-kubernetes-validations:
  # If autoscaling is enabled, HPA config must be present
  - rule: |
      !self.autoscaling.enabled ||
      (has(self.autoscaling.minReplicas) && has(self.autoscaling.maxReplicas))
    message: "autoscaling.minReplicas and maxReplicas are required when autoscaling is enabled"

  # If TLS is configured, both cert and key must be provided
  - rule: |
      !has(self.tls) ||
      (has(self.tls.certSecretRef) && has(self.tls.keySecretRef))
    message: "both tls.certSecretRef and tls.keySecretRef must be specified when TLS is configured"

  # Resource requests must not exceed limits when both are set
  - rule: |
      !has(self.resources) ||
      !has(self.resources.requests) ||
      !has(self.resources.limits) ||
      self.resources.requests.cpu <= self.resources.limits.cpu
    message: "CPU request must not exceed CPU limit"
```

## Transition Rules

Transition rules validate changes between the old and new versions of a resource. They are only evaluated during updates, not on initial creation. The `oldSelf` variable is available only in transition rules.

### Immutable Fields

```yaml
x-kubernetes-validations:
  # Region cannot be changed after creation
  - rule: "self.region == oldSelf.region"
    message: "region is immutable after creation"

  # Storage class cannot be changed
  - rule: "self.storageClass == oldSelf.storageClass"
    message: "storageClass is immutable after creation"

  # Database name cannot change once provisioned
  - rule: |
      !has(oldSelf.status) ||
      oldSelf.status.phase != "Provisioned" ||
      self.spec.databaseName == oldSelf.spec.databaseName
    message: "databaseName cannot be changed after the database is provisioned"
```

### Preventing Downscaling Below Minimum

```yaml
x-kubernetes-validations:
  # Prevent reducing replicas by more than 50% in one operation
  - rule: |
      self.replicas >= int(oldSelf.replicas * 0.5)
    message: "replicas cannot be reduced by more than 50% in a single update"

  # Prevent scaling below the current ready replica count
  - rule: |
      !has(oldSelf.status) ||
      !has(oldSelf.status.readyReplicas) ||
      self.replicas >= oldSelf.status.readyReplicas / 2
    message: "replicas cannot be reduced below half of current ready replicas"
```

### State Machine Transitions

```yaml
x-kubernetes-validations:
  # Validate phase transitions
  - rule: |
      !has(oldSelf.spec) || !has(oldSelf.spec.phase) ||
      (oldSelf.spec.phase == "Pending" && self.spec.phase in ["Running", "Cancelled"]) ||
      (oldSelf.spec.phase == "Running" && self.spec.phase in ["Paused", "Completed", "Failed"]) ||
      (oldSelf.spec.phase == "Paused" && self.spec.phase in ["Running", "Cancelled"]) ||
      (oldSelf.spec.phase == self.spec.phase)
    message: |
      Invalid phase transition. Allowed: Pending->Running, Pending->Cancelled,
      Running->Paused, Running->Completed, Running->Failed, Paused->Running, Paused->Cancelled
```

## Field-Level Validation

CEL rules can be applied at any level of the schema hierarchy, including individual fields.

```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: databases.db.example.com
spec:
  group: db.example.com
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
              properties:
                connectionPooling:
                  type: object
                  x-kubernetes-validations:
                    # Min pool must be less than max pool
                    - rule: "self.minConnections <= self.maxConnections"
                      message: "minConnections must be <= maxConnections"

                    # Pool size must be reasonable
                    - rule: "self.maxConnections <= 500"
                      message: "maxConnections cannot exceed 500"

                  properties:
                    minConnections:
                      type: integer
                    maxConnections:
                      type: integer

                backupSchedule:
                  type: string
                  x-kubernetes-validations:
                    # Validate cron expression format (basic check)
                    - rule: |
                        self.matches(
                          '^(@(annually|yearly|monthly|weekly|daily|hourly|reboot))|' +
                          '(@every (\\d+(ns|us|µs|ms|s|m|h))+)|' +
                          '((((\\d+,)+\\d+|(\\d+(\\/|-)\\d+)|\\d+|\\*) ?){5,7})$'
                        )
                      message: "backupSchedule must be a valid cron expression or shorthand"
```

## CEL Cost Estimation and Limits

The Kubernetes API server enforces cost limits on CEL expressions to prevent Denial of Service via expensive validation. Each expression is assigned a cost based on its estimated computational complexity.

### Cost Factors

Operations have different base costs:

```
Field access:     1
String operation: 1 per character in worst case
List operation:   proportional to list size
map/filter/all:   O(n) relative to collection size
Regex match:      high cost (compile + match)
```

### Cost Budget

Each CEL expression has a cost budget. The default budget is 100 for a single rule. The total across all rules in a CRD has a higher budget. Expressions exceeding the budget are rejected at CRD creation time.

### Writing Cost-Efficient Expressions

```yaml
x-kubernetes-validations:
  # EXPENSIVE: regex on potentially large string
  # cost is proportional to string length
  - rule: "self.spec.description.matches('[A-Za-z0-9 .,!?-]+')"
    message: "description contains invalid characters"

  # CHEAPER: bound the string length first with structural schema
  # Then use a simpler check
  # (put maxLength: 256 in the field schema, then use CEL for complex logic)
  - rule: |
      self.spec.description.size() <= 256 &&
      !self.spec.description.contains("<script>")
    message: "description must not contain script tags and must be <= 256 characters"
```

### Estimating Rule Costs

Use `kubectl` with the `--dry-run=server` flag to test if rules are accepted:

```bash
# Test CRD acceptance
kubectl apply --dry-run=server -f my-crd.yaml

# If cost exceeds limit, the error message indicates the problem:
# "spec.validation.openAPIV3Schema...x-kubernetes-validations[0].rule:
#  estimated rule cost exceeds budget by factor of X"
```

To reduce costs:

1. Use `maxItems`, `maxLength`, `maxProperties` in the schema to bound collection sizes
2. Avoid unbounded regex on large strings
3. Split complex rules into multiple targeted rules
4. Use `has()` to short-circuit expensive checks

```yaml
properties:
  containers:
    type: array
    maxItems: 20       # Bounds the cost of operations on this list
    items:
      type: object
      properties:
        name:
          type: string
          maxLength: 63   # Bounds string operation costs
        image:
          type: string
          maxLength: 256
```

## Complete Production CRD Example

```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: microservices.platform.example.com
  annotations:
    platform.example.com/crd-version: "1.2.0"
spec:
  group: platform.example.com
  names:
    plural: microservices
    singular: microservice
    kind: Microservice
    shortNames:
      - ms
  scope: Namespaced
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
              required: ["image", "port", "replicas"]
              # Object-level cross-field validations
              x-kubernetes-validations:
                # Replicas must be within autoscaler bounds if autoscaling enabled
                - rule: |
                    !has(self.autoscaling) ||
                    (self.replicas >= self.autoscaling.minReplicas &&
                     self.replicas <= self.autoscaling.maxReplicas)
                  message: "replicas must be within autoscaling.minReplicas and autoscaling.maxReplicas"

                # Resource requests must be set if limits are set
                - rule: |
                    !has(self.resources) ||
                    !has(self.resources.limits) ||
                    has(self.resources.requests)
                  message: "resources.requests must be set when resources.limits is set"

                # Environment must be valid
                - rule: |
                    !has(self.environment) ||
                    self.environment in ["development", "staging", "production"]
                  message: "environment must be one of: development, staging, production"

                # Production deployments require 2+ replicas
                - rule: |
                    !has(self.environment) ||
                    self.environment != "production" ||
                    self.replicas >= 2
                  message: "production deployments must have at least 2 replicas"

                # Canary weight must be 0-100 when present
                - rule: |
                    !has(self.canary) ||
                    (self.canary.weight >= 0 && self.canary.weight <= 100)
                  message: "canary.weight must be between 0 and 100"

              properties:
                image:
                  type: string
                  maxLength: 256
                  x-kubernetes-validations:
                    # No latest tag in production
                    - rule: "!self.endsWith(':latest')"
                      message: "image tag ':latest' is not allowed; use a specific version"
                    # Must have a tag
                    - rule: "self.contains(':')"
                      message: "image must specify a tag"

                port:
                  type: integer
                  minimum: 1024
                  maximum: 65535
                  x-kubernetes-validations:
                    # Disallow well-known privileged ports
                    - rule: "self >= 1024"
                      message: "port must be >= 1024 (privileged ports not allowed)"

                replicas:
                  type: integer
                  minimum: 1
                  maximum: 100

                environment:
                  type: string
                  enum: ["development", "staging", "production"]

                autoscaling:
                  type: object
                  x-kubernetes-validations:
                    - rule: "self.minReplicas <= self.maxReplicas"
                      message: "minReplicas must be <= maxReplicas"
                    - rule: "self.minReplicas >= 1"
                      message: "minReplicas must be at least 1"
                  properties:
                    enabled:
                      type: boolean
                    minReplicas:
                      type: integer
                      minimum: 1
                    maxReplicas:
                      type: integer
                      maximum: 100

                resources:
                  type: object
                  properties:
                    requests:
                      type: object
                      properties:
                        cpu:
                          type: string
                          pattern: '^[0-9]+m?$'
                        memory:
                          type: string
                          pattern: '^[0-9]+(Ki|Mi|Gi)$'
                    limits:
                      type: object
                      properties:
                        cpu:
                          type: string
                          pattern: '^[0-9]+m?$'
                        memory:
                          type: string
                          pattern: '^[0-9]+(Ki|Mi|Gi)$'

                env:
                  type: array
                  maxItems: 50
                  x-kubernetes-validations:
                    # Environment variable names must be valid
                    - rule: |
                        self.all(e,
                          e.name.matches('^[A-Z_][A-Z0-9_]*$')
                        )
                      message: "env variable names must be uppercase letters, digits, and underscores"
                    # No duplicate env var names
                    - rule: |
                        self.map(e, e.name).size() ==
                        self.map(e, e.name).toSet().size()
                      message: "env variable names must be unique"
                  items:
                    type: object
                    required: ["name"]
                    properties:
                      name:
                        type: string
                        maxLength: 128
                      value:
                        type: string
                        maxLength: 4096

                canary:
                  type: object
                  properties:
                    weight:
                      type: integer
                      minimum: 0
                      maximum: 100
                    stableImage:
                      type: string
                      maxLength: 256

            status:
              type: object
              properties:
                phase:
                  type: string
                  enum: ["Pending", "Running", "Failed", "Succeeded"]
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
                      reason:
                        type: string
                      message:
                        type: string
                      lastTransitionTime:
                        type: string
                        format: date-time
```

## Migration from Webhook-Based Validation

### Assessment Phase

Before migrating, catalog all validations in the existing webhook:

```go
// Typical webhook validation structure
func (v *MicroserviceValidator) ValidateCreate(ctx context.Context, obj runtime.Object) error {
    ms := obj.(*MicroserviceV1)

    // Validation 1: image tag check
    if strings.HasSuffix(ms.Spec.Image, ":latest") {
        return field.Invalid(field.NewPath("spec", "image"), ms.Spec.Image,
            "latest tag not allowed")
    }

    // Validation 2: port range
    if ms.Spec.Port < 1024 || ms.Spec.Port > 65535 {
        return field.Invalid(field.NewPath("spec", "port"), ms.Spec.Port,
            "port must be between 1024 and 65535")
    }

    // Validation 3: production replica count
    if ms.Spec.Environment == "production" && ms.Spec.Replicas < 2 {
        return field.Invalid(field.NewPath("spec", "replicas"), ms.Spec.Replicas,
            "production requires at least 2 replicas")
    }

    return nil
}
```

Map each webhook validation to a CEL expression:

| Webhook Check | CEL Expression |
|---|---|
| `!strings.HasSuffix(image, ":latest")` | `!self.image.endsWith(":latest")` |
| `port >= 1024 && port <= 65535` | `self.port >= 1024 && self.port <= 65535` |
| `env != "production" || replicas >= 2` | `self.environment != "production" || self.replicas >= 2` |

### Parallel Validation Period

During migration, run both CEL validation and the webhook simultaneously. Configure the webhook to run in audit mode (log rejections but don't block):

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingWebhookConfiguration
metadata:
  name: microservice-validation-webhook
webhooks:
  - name: validate-microservice.example.com
    rules:
      - operations: ["CREATE", "UPDATE"]
        apiGroups: ["platform.example.com"]
        apiVersions: ["v1"]
        resources: ["microservices"]
    clientConfig:
      service:
        namespace: platform
        name: validation-webhook
        path: /validate
    # During migration: warn mode lets invalid objects through
    # while logging the rejection reason
    failurePolicy: Ignore
    sideEffects: None
    admissionReviewVersions: ["v1"]
```

### Cutover Procedure

1. Deploy CRD with CEL rules added
2. Run parallel validation for at least one release cycle
3. Compare webhook rejection logs with CEL rejection counts
4. If equivalent, remove webhook registration
5. Archive webhook server deployment

```bash
# Step 1: Apply updated CRD with CEL rules
kubectl apply -f microservice-crd-with-cel.yaml

# Step 2: Verify CRD accepted
kubectl get crd microservices.platform.example.com -o yaml | \
  grep -A5 x-kubernetes-validations

# Step 3: Test validation works
cat <<EOF | kubectl apply -f - --dry-run=server
apiVersion: platform.example.com/v1
kind: Microservice
metadata:
  name: test-validation
  namespace: default
spec:
  image: "myapp:latest"
  port: 8080
  replicas: 1
  environment: production
EOF
# Expected: error about :latest tag and production replica count

# Step 4: Test valid object succeeds
cat <<EOF | kubectl apply -f - --dry-run=server
apiVersion: platform.example.com/v1
kind: Microservice
metadata:
  name: test-valid
  namespace: default
spec:
  image: "myapp:v1.2.3"
  port: 8080
  replicas: 2
  environment: production
EOF
# Expected: dry-run success

# Step 5: Remove webhook after validation period
kubectl delete validatingwebhookconfiguration microservice-validation-webhook
```

## Error Messages and messageExpression

Kubernetes 1.27+ supports `messageExpression` which allows dynamic error messages using CEL:

```yaml
x-kubernetes-validations:
  - rule: "self.replicas >= self.minReplicas"
    messageExpression: |
      "replicas (" + string(self.replicas) + ") must be >= minReplicas (" +
      string(self.minReplicas) + ")"

  - rule: |
      self.containers.all(c, c.image.contains(":"))
    messageExpression: |
      "The following containers are missing image tags: " +
      self.containers.filter(c, !c.image.contains(":")).map(c, c.name).join(", ")
```

## Validation in Controller Reconciliation

CEL validation occurs at admission time, but controllers should also validate at reconciliation time for defensive programming. Use the same expressions in Go code:

```go
package validation

import (
    "context"
    "fmt"
    "strings"

    "github.com/google/cel-go/cel"
    platformv1 "github.com/example/platform/api/v1"
)

// ValidateMicroservice applies the same rules as the CRD CEL expressions
// to catch issues in controller logic without relying on the API server
func ValidateMicroservice(ms *platformv1.Microservice) error {
    // Mirror CEL rule: !self.image.endsWith(":latest")
    if strings.HasSuffix(ms.Spec.Image, ":latest") {
        return fmt.Errorf("spec.image: latest tag is not allowed")
    }

    // Mirror CEL rule: production requires >= 2 replicas
    if ms.Spec.Environment == "production" && ms.Spec.Replicas < 2 {
        return fmt.Errorf("spec.replicas: production deployments require at least 2 replicas (got %d)",
            ms.Spec.Replicas)
    }

    return nil
}
```

## Observing Validation Behavior

### API Server Audit Logs

CEL validation failures appear in audit logs with the rejection reason:

```json
{
  "kind": "Event",
  "apiVersion": "audit.k8s.io/v1",
  "level": "Request",
  "verb": "create",
  "objectRef": {
    "resource": "microservices",
    "namespace": "default",
    "name": "my-service",
    "apiGroup": "platform.example.com",
    "apiVersion": "v1"
  },
  "responseStatus": {
    "code": 422,
    "reason": "Invalid",
    "message": "Microservice.platform.example.com \"my-service\" is invalid: spec: Invalid value: ...: image tag ':latest' is not allowed; use a specific version"
  }
}
```

### Metrics

Track validation rejection rates using API server metrics:

```promql
# CEL validation failures by resource
sum(rate(apiserver_admission_webhook_rejection_count[5m])) by (name, operation, type)

# API request errors by status code
sum(rate(apiserver_request_total{code="422"}[5m])) by (resource, verb)
```

## Summary

CEL validation in CRDs provides a production-grade alternative to admission webhooks for custom resource validation. Key operational considerations:

- Place cross-field validation at the scope where all referenced fields are accessible
- Use `has()` for optional field checks to avoid null-pointer equivalent errors
- Apply `maxItems`, `maxLength`, and `maxProperties` bounds in the schema to control CEL cost
- Use `messageExpression` for dynamic error messages that name the specific invalid value
- Test transition rules separately from creation rules — they require update operations to evaluate
- Migrate from webhooks incrementally using parallel validation and audit mode
- Monitor API server audit logs and `apiserver_request_total{code="422"}` metrics during migration

CEL validation is now the recommended approach for all new Kubernetes CRD validation logic, reserving webhooks for cases that genuinely require mutation or external system lookups.
