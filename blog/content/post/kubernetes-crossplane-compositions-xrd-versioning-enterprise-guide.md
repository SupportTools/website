---
title: "Kubernetes Crossplane Compositions: Composite Resources, Patches, Transforms, XRD Versioning, and Claim Binding"
date: 2031-11-25T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Crossplane", "Infrastructure as Code", "Platform Engineering", "GitOps", "Compositions", "XRD"]
categories:
- Kubernetes
- Platform Engineering
- Infrastructure as Code
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep-dive into Crossplane compositions for platform engineering teams: composite resource definitions, XRD versioning, patch pipelines, transforms, and claim binding patterns for production multi-cloud environments."
more_link: "yes"
url: "/kubernetes-crossplane-compositions-xrd-versioning-enterprise-guide/"
---

Crossplane has matured into the de-facto infrastructure abstraction layer for platform engineering teams running on Kubernetes. Its composition engine lets you build opinionated, self-service APIs over raw cloud provider resources—hiding provider-specific complexity behind stable, versioned CRDs that developers consume through Claims. This guide covers every layer of that stack: from XRD schema design and versioning strategy through patch pipelines, transform functions, and the operational patterns that keep compositions healthy in production.

<!--more-->

# Kubernetes Crossplane Compositions: A Production Engineering Guide

## Why Compositions Matter

Crossplane's managed resources give you a 1:1 mapping between a Kubernetes object and a cloud API call. That directness is useful for operators, but it exposes every provider quirk to developers. Compositions add an indirection layer:

```
Developer Claim (XRC)
        |
        v
Composite Resource (XR)   <-- your API
        |
        v
Composition (pipeline of patches/transforms)
        |
        v
Managed Resources (provider-aws, provider-gcp, …)
        |
        v
Cloud APIs
```

The result is a platform API your developers can consume without knowing which AWS account, which region naming convention, or which IAM role ARN convention your organization uses.

## Section 1: CompositeResourceDefinition Design

### Minimal XRD Skeleton

```yaml
apiVersion: apiextensions.crossplane.io/v1
kind: CompositeResourceDefinition
metadata:
  name: xpostgresinstances.platform.example.com
spec:
  group: platform.example.com
  names:
    kind: XPostgresInstance
    plural: xpostgresinstances
  claimNames:
    kind: PostgresInstance
    plural: postgresinstances
  connectionSecretKeys:
    - username
    - password
    - endpoint
    - port
  versions:
    - name: v1alpha1
      served: true
      referenceable: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              properties:
                parameters:
                  type: object
                  properties:
                    storageGB:
                      type: integer
                      minimum: 20
                      maximum: 16384
                      description: "Allocated storage in gigabytes"
                    instanceClass:
                      type: string
                      enum:
                        - db.t3.micro
                        - db.t3.small
                        - db.m5.large
                        - db.m5.xlarge
                        - db.r5.large
                      description: "RDS instance class"
                    engineVersion:
                      type: string
                      default: "15.4"
                      description: "PostgreSQL engine version"
                    multiAZ:
                      type: boolean
                      default: false
                      description: "Enable Multi-AZ deployment"
                    deletionProtection:
                      type: boolean
                      default: true
                  required:
                    - storageGB
                    - instanceClass
```

### Schema Validation Best Practices

Define `required` fields at the `parameters` level, not at `spec` level. This keeps backward compatibility when you add optional fields in later revisions.

Use `x-kubernetes-validations` (CEL rules) available in Crossplane v1.14+ to enforce cross-field constraints:

```yaml
x-kubernetes-validations:
  - rule: "self.multiAZ == false || self.instanceClass.startsWith('db.m') || self.instanceClass.startsWith('db.r')"
    message: "Multi-AZ requires m5 or r5 instance classes"
```

### Status Schema

Always define a status schema. Downstream tooling and GitOps health checks rely on it:

```yaml
status:
  type: object
  properties:
    instanceEndpoint:
      type: string
    instancePort:
      type: integer
    ready:
      type: boolean
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
```

## Section 2: XRD Versioning Strategy

### Version Lifecycle

Crossplane XRD versioning mirrors Kubernetes API versioning conventions:

| Stage    | Served | Referenceable | Notes |
|----------|--------|---------------|-------|
| v1alpha1 | true   | true          | Initial development, breaking changes allowed |
| v1beta1  | true   | true          | Feature complete, no breaking changes |
| v1       | true   | true          | GA, strict compatibility guarantee |
| v1alpha1 | true   | false         | Deprecation: old version still served but new claims use v1beta1 |

### Multi-Version XRD

```yaml
versions:
  - name: v1alpha1
    served: true
    referenceable: false   # New claims can't reference this version
    deprecated: true
    deprecationWarning: "v1alpha1 is deprecated, migrate to v1beta1"
    schema:
      openAPIV3Schema:
        # ... old schema
  - name: v1beta1
    served: true
    referenceable: true    # This is the stored version
    schema:
      openAPIV3Schema:
        # ... new schema with additionalParameters
```

### Conversion Webhook

For breaking schema changes between versions, you need a conversion webhook. Crossplane delegates this to the standard Kubernetes conversion webhook mechanism. A minimal implementation using controller-runtime:

```go
package main

import (
    "encoding/json"
    "fmt"
    "net/http"

    apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime"
)

type ConversionRequest struct {
    APIVersion string                          `json:"apiVersion"`
    Kind       string                          `json:"kind"`
    Request    apiextensionsv1.ConversionRequest `json:"request"`
}

type ConversionResponse struct {
    APIVersion string                           `json:"apiVersion"`
    Kind       string                           `json:"kind"`
    Response   apiextensionsv1.ConversionResponse `json:"response"`
}

func convertV1alpha1ToV1beta1(obj map[string]interface{}) (map[string]interface{}, error) {
    spec, ok := obj["spec"].(map[string]interface{})
    if !ok {
        return nil, fmt.Errorf("spec not found or wrong type")
    }
    params, ok := spec["parameters"].(map[string]interface{})
    if !ok {
        return nil, fmt.Errorf("parameters not found")
    }
    // v1alpha1 used "size" (small/medium/large), v1beta1 uses explicit instanceClass
    if size, ok := params["size"].(string); ok {
        sizeMap := map[string]string{
            "small":  "db.t3.small",
            "medium": "db.m5.large",
            "large":  "db.r5.large",
        }
        params["instanceClass"] = sizeMap[size]
        delete(params, "size")
    }
    obj["apiVersion"] = "platform.example.com/v1beta1"
    return obj, nil
}

func conversionHandler(w http.ResponseWriter, r *http.Request) {
    var req ConversionRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(w, err.Error(), http.StatusBadRequest)
        return
    }

    response := ConversionResponse{
        APIVersion: "apiextensions.k8s.io/v1",
        Kind:       "ConversionReview",
        Response: apiextensionsv1.ConversionResponse{
            UID: req.Request.UID,
        },
    }

    var converted []runtime.RawExtension
    for _, obj := range req.Request.Objects {
        var raw map[string]interface{}
        if err := json.Unmarshal(obj.Raw, &raw); err != nil {
            response.Response.Result = metav1.Status{Status: metav1.StatusFailure, Message: err.Error()}
            break
        }
        if req.Request.DesiredAPIVersion == "platform.example.com/v1beta1" {
            var err error
            raw, err = convertV1alpha1ToV1beta1(raw)
            if err != nil {
                response.Response.Result = metav1.Status{Status: metav1.StatusFailure, Message: err.Error()}
                break
            }
        }
        b, _ := json.Marshal(raw)
        converted = append(converted, runtime.RawExtension{Raw: b})
    }

    response.Response.ConvertedObjects = converted
    response.Response.Result = metav1.Status{Status: metav1.StatusSuccess}
    json.NewEncoder(w).Encode(response)
}
```

## Section 3: Compositions and Resource Templates

### Composition Structure

```yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: xpostgresinstances.aws.platform.example.com
  labels:
    provider: aws
    environment: production
spec:
  compositeTypeRef:
    apiVersion: platform.example.com/v1beta1
    kind: XPostgresInstance
  mode: Pipeline
  pipeline:
    - step: patch-and-transform
      functionRef:
        name: function-patch-and-transform
      input:
        apiVersion: pt.fn.crossplane.io/v1beta1
        kind: Resources
        resources:
          - name: rds-instance
            base:
              apiVersion: rds.aws.upbound.io/v1beta1
              kind: Instance
              spec:
                forProvider:
                  region: us-east-1
                  engine: postgres
                  dbName: main
                  backupRetentionPeriod: 7
                  copyTagsToSnapshot: true
                  publiclyAccessible: false
                  skipFinalSnapshot: false
                  applyImmediately: false
                publishConnectionDetailsTo:
                  name: ""
                  configRef:
                    name: vault-connection-store
```

### PatchSets for Reuse

```yaml
spec:
  patchSets:
    - name: common-tags
      patches:
        - type: FromCompositeFieldPath
          fromFieldPath: metadata.labels[crossplane.io/claim-namespace]
          toFieldPath: spec.forProvider.tags.namespace
        - type: FromCompositeFieldPath
          fromFieldPath: metadata.labels[crossplane.io/claim-name]
          toFieldPath: spec.forProvider.tags.claim-name
        - type: FromCompositeFieldPath
          fromFieldPath: metadata.annotations[platform.example.com/cost-center]
          toFieldPath: spec.forProvider.tags.cost-center
          transforms:
            - type: string
              string:
                type: Convert
                convert: ToUpper
    - name: provider-config
      patches:
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.awsAccountId
          toFieldPath: spec.providerConfigRef.name
          transforms:
            - type: string
              string:
                type: Format
                fmt: "aws-%s"
```

## Section 4: Patch Types In Depth

### FromCompositeFieldPath

The most common patch: copy a field from the XR to the managed resource.

```yaml
patches:
  - type: FromCompositeFieldPath
    fromFieldPath: spec.parameters.storageGB
    toFieldPath: spec.forProvider.allocatedStorage

  # With policy for optional fields
  - type: FromCompositeFieldPath
    fromFieldPath: spec.parameters.snapshotIdentifier
    toFieldPath: spec.forProvider.snapshotIdentifier
    policy:
      fromFieldPath: Optional   # Don't fail if the source field is missing
```

### ToCompositeFieldPath

Write back from a managed resource into the XR status:

```yaml
patches:
  - type: ToCompositeFieldPath
    fromFieldPath: status.atProvider.address
    toFieldPath: status.instanceEndpoint
  - type: ToCompositeFieldPath
    fromFieldPath: status.atProvider.port
    toFieldPath: status.instancePort
  - type: ToCompositeFieldPath
    fromFieldPath: status.conditions[0].status
    toFieldPath: status.ready
    transforms:
      - type: convert
        convert:
          toType: bool
```

### CombineFromComposite

Build a string from multiple source fields:

```yaml
patches:
  - type: CombineFromComposite
    combine:
      variables:
        - fromFieldPath: metadata.labels[crossplane.io/claim-namespace]
        - fromFieldPath: metadata.labels[crossplane.io/claim-name]
      strategy: string
      string:
        fmt: "%s-%s-postgres"
    toFieldPath: spec.forProvider.dbInstanceIdentifier
```

### FromEnvironmentFieldPath

Read from the Crossplane EnvironmentConfig (cluster-level configuration):

```yaml
# EnvironmentConfig
apiVersion: apiextensions.crossplane.io/v1alpha1
kind: EnvironmentConfig
metadata:
  name: production-us-east-1
data:
  vpcId: vpc-0a1b2c3d4e5f67890
  privateSubnetIds:
    - subnet-0a1b2c3d4e5f67891
    - subnet-0a1b2c3d4e5f67892
    - subnet-0a1b2c3d4e5f67893
  kmsKeyArn: arn:aws:kms:us-east-1:123456789012:key/mrk-FAKEKEYID00000000000000000000

---
# Patch in composition
- type: FromEnvironmentFieldPath
  fromFieldPath: vpcId
  toFieldPath: spec.forProvider.dbSubnetGroupNameRef.name
```

## Section 5: Transforms Reference

### String Transforms

```yaml
transforms:
  # Format with fmt
  - type: string
    string:
      type: Format
      fmt: "rds-%s-cluster"

  # Convert case
  - type: string
    string:
      type: Convert
      convert: ToLower   # ToUpper, ToBase64, FromBase64, ToJson, FromJson, ToSha1, ToSha256, ToSha512, TrimPrefix, TrimSuffix

  # Trim prefix/suffix
  - type: string
    string:
      type: TrimPrefix
      trim: "aws-"

  # Regexp replace
  - type: string
    string:
      type: Regexp
      regexp:
        match: '[^a-z0-9-]'
        group: 0
```

### Math Transforms

```yaml
transforms:
  # Multiply (useful for unit conversion)
  - type: math
    math:
      type: Multiply
      multiply: 1024    # GB to MB

  # ClampMin / ClampMax
  - type: math
    math:
      type: ClampMin
      clampMin: 100
```

### Map Transforms

Translate enum values:

```yaml
transforms:
  - type: map
    map:
      small: db.t3.small
      medium: db.m5.large
      large: db.r5.large
      xlarge: db.r5.2xlarge
```

### Match Transforms

Pattern-based conditional mapping:

```yaml
transforms:
  - type: match
    match:
      patterns:
        - type: regexp
          regexp: "^prod-.*"
          result: "db.r5.large"
        - type: regexp
          regexp: "^dev-.*"
          result: "db.t3.micro"
        - type: literal
          literal: "staging"
          result: "db.t3.small"
      fallbackValue: "db.t3.micro"
```

### Convert Transforms

```yaml
transforms:
  - type: convert
    convert:
      toType: int64    # string, bool, float64, int64, object, array
      format: quantity # none, quantity, convertibleString
```

## Section 6: Composition Functions Pipeline

Crossplane v1.14 introduced the Functions pipeline mode, replacing the old P&T approach with a composable chain of Go functions.

### Function Composition Example

```yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: xpostgresinstances.aws.platform.example.com
spec:
  compositeTypeRef:
    apiVersion: platform.example.com/v1beta1
    kind: XPostgresInstance
  mode: Pipeline
  pipeline:
    - step: validate-input
      functionRef:
        name: function-cel-filter
      input:
        apiVersion: cel.fn.crossplane.io/v1beta1
        kind: Filters
        filters:
          - name: multiaz-requires-production-class
            expression: |
              !request.observed.composite.resource.spec.parameters.multiAZ ||
              request.observed.composite.resource.spec.parameters.instanceClass.startsWith("db.m") ||
              request.observed.composite.resource.spec.parameters.instanceClass.startsWith("db.r")
            message: "Multi-AZ requires m5 or r5 instance classes"

    - step: render-resources
      functionRef:
        name: function-patch-and-transform
      input:
        apiVersion: pt.fn.crossplane.io/v1beta1
        kind: Resources
        resources:
          - name: rds-instance
            base:
              # ... base resource

    - step: auto-ready
      functionRef:
        name: function-auto-ready
```

### Writing a Custom Composition Function in Go

```go
package main

import (
    "context"

    "github.com/crossplane/crossplane-runtime/pkg/logging"
    fnv1beta1 "github.com/crossplane/function-sdk-go/proto/v1beta1"
    "github.com/crossplane/function-sdk-go/request"
    "github.com/crossplane/function-sdk-go/response"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
    "sigs.k8s.io/controller-runtime/pkg/log/zap"
)

type Function struct {
    fnv1beta1.UnimplementedFunctionRunnerServiceServer
    log logging.Logger
}

func (f *Function) RunFunction(ctx context.Context, req *fnv1beta1.RunFunctionRequest) (*fnv1beta1.RunFunctionResponse, error) {
    log := f.log.WithValues("tag", req.GetMeta().GetTag())
    log.Info("Running function")

    rsp := response.To(req, response.DefaultTTL)

    xr, err := request.GetObservedCompositeResource(req)
    if err != nil {
        response.Fatal(rsp, fmt.Errorf("cannot get observed XR: %w", err))
        return rsp, nil
    }

    // Read claim parameters
    storageGB, err := xr.Resource.GetInteger("spec.parameters.storageGB")
    if err != nil {
        response.Fatal(rsp, fmt.Errorf("cannot get storageGB: %w", err))
        return rsp, nil
    }

    // Apply business logic: enforce minimum storage for Multi-AZ
    multiAZ, _ := xr.Resource.GetBool("spec.parameters.multiAZ")
    if multiAZ && storageGB < 100 {
        storageGB = 100
        log.Info("Enforcing minimum 100GB for Multi-AZ deployments")
    }

    // Build desired managed resource
    rdsInstance := &composed.Unstructured{}
    rdsInstance.SetAPIVersion("rds.aws.upbound.io/v1beta1")
    rdsInstance.SetKind("Instance")
    rdsInstance.SetName("rds-instance")

    if err := rdsInstance.SetInteger("spec.forProvider.allocatedStorage", storageGB); err != nil {
        response.Fatal(rsp, fmt.Errorf("cannot set allocatedStorage: %w", err))
        return rsp, nil
    }

    if err := response.SetDesiredComposedResource(rsp, rdsInstance); err != nil {
        response.Fatal(rsp, fmt.Errorf("cannot set desired resource: %w", err))
        return rsp, nil
    }

    return rsp, nil
}

func main() {
    log := logging.NewLogrLogger(zap.New().WithName("function-rds-policy"))

    s := grpc.NewServer(grpc.Creds(insecure.NewCredentials()))
    fnv1beta1.RegisterFunctionRunnerServiceServer(s, &Function{log: log})

    lis, _ := net.Listen("tcp", ":9443")
    s.Serve(lis)
}
```

## Section 7: Claim Binding and Namespace Isolation

### How Claims Work

A Claim (XRC) is a namespace-scoped proxy for a cluster-scoped Composite Resource (XR). When a developer creates a Claim:

1. Crossplane creates a matching XR in the cluster scope.
2. The Claim and XR are bound via `spec.resourceRef` on the Claim and `spec.claimRef` on the XR.
3. Connection secrets are propagated from the XR down to the Claim's namespace.

```yaml
# Developer creates this in their namespace
apiVersion: platform.example.com/v1beta1
kind: PostgresInstance
metadata:
  name: my-app-db
  namespace: team-alpha
  annotations:
    platform.example.com/cost-center: "CC-1234"
spec:
  parameters:
    storageGB: 100
    instanceClass: db.m5.large
    multiAZ: true
    deletionProtection: true
  writeConnectionSecretToRef:
    name: my-app-db-credentials
```

```yaml
# Crossplane creates this cluster-scoped XR automatically
apiVersion: platform.example.com/v1beta1
kind: XPostgresInstance
metadata:
  name: my-app-db-abcde          # generated name
  labels:
    crossplane.io/claim-name: my-app-db
    crossplane.io/claim-namespace: team-alpha
spec:
  claimRef:
    apiVersion: platform.example.com/v1beta1
    kind: PostgresInstance
    name: my-app-db
    namespace: team-alpha
  parameters:
    storageGB: 100
    instanceClass: db.m5.large
    multiAZ: true
    deletionProtection: true
  writeConnectionSecretToRef:
    name: my-app-db-abcde
    namespace: crossplane-system
```

### Pre-Provisioned Claims (Claim Binding)

For long-lived shared resources (VPCs, transit gateways), platform teams pre-provision XRs and allow Claims to bind to them by name:

```yaml
# Pre-provisioned XR
apiVersion: platform.example.com/v1beta1
kind: XVPCNetwork
metadata:
  name: shared-prod-vpc
  labels:
    platform.example.com/shared: "true"
    platform.example.com/environment: production
spec:
  resourceRef:
    apiVersion: ec2.aws.upbound.io/v1beta1
    kind: VPC
    name: prod-vpc-main

---
# Developer Claim that binds to it
apiVersion: platform.example.com/v1beta1
kind: VPCNetwork
metadata:
  name: my-vpc-binding
  namespace: team-alpha
spec:
  resourceRef:
    apiVersion: platform.example.com/v1beta1
    kind: XVPCNetwork
    name: shared-prod-vpc   # Bind to existing XR instead of creating new one
```

### Connection Secret Propagation

Configure External Secret Store (ESS) to route secrets to Vault instead of Kubernetes Secrets:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: vault-connection-store
  namespace: crossplane-system
data:
  apiVersion: kubernetes.crossplane.io/v1alpha1
  kind: StoreConfig

---
apiVersion: secrets.crossplane.io/v1alpha1
kind: StoreConfig
metadata:
  name: vault-connection-store
spec:
  type: Vault
  defaultScope: crossplane
  vault:
    server: https://vault.example.com
    mountPath: secret/
    version: v2
    auth:
      method: Kubernetes
      kubernetes:
        role: crossplane
        serviceAccountTokenSource:
          fs:
            path: /var/run/secrets/kubernetes.io/serviceaccount/token
```

## Section 8: Observability and Debugging

### Crossplane Metrics

Crossplane exposes Prometheus metrics at `:8080/metrics`:

```promql
# Number of managed resources by health
crossplane_managed_resource_exists{gvk="rds.aws.upbound.io/v1beta1/Instance"}

# Reconcile errors
rate(crossplane_managed_resource_reconcile_errors_total[5m])

# Time to ready
histogram_quantile(0.99, rate(crossplane_managed_resource_ready_duration_seconds_bucket[10m]))
```

Alert rules:

```yaml
groups:
  - name: crossplane
    rules:
      - alert: CrossplaneCompositeNotReady
        expr: |
          sum by (crossplane_resource_kind) (
            kube_customresource_status_condition{
              condition="Ready",status="False",
              customresource_group="platform.example.com"
            }
          ) > 0
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "Crossplane composite resource not ready for 15m"

      - alert: CrossplaneProviderReconcileErrors
        expr: |
          rate(crossplane_managed_resource_reconcile_errors_total[5m]) > 0.1
        for: 5m
        labels:
          severity: critical
```

### Debugging Compositions

```bash
# Check XR status
kubectl get xpostgresinstance my-app-db-abcde -o yaml | kubectl neat

# Check events on the XR
kubectl describe xpostgresinstance my-app-db-abcde

# Check the composed resources
kubectl get managed -l crossplane.io/composite=my-app-db-abcde

# Check composition pipeline function logs
kubectl logs -n crossplane-system -l app=function-patch-and-transform -f

# Trace patch evaluation
kubectl get xpostgresinstance my-app-db-abcde \
  -o jsonpath='{.status.conditions}' | jq .

# Check provider logs for API errors
kubectl logs -n crossplane-system -l pkg.crossplane.io/revision=provider-aws-v0.47.0 \
  --since=10m | grep ERROR
```

### Composition Validation

Use `crossplane render` for local testing before applying:

```bash
# Install crossplane CLI
curl -sL https://raw.githubusercontent.com/crossplane/crossplane/master/install.sh | sh

# Render a composition locally
crossplane render \
  --composition composition.yaml \
  --composite xr.yaml \
  --function-credentials credentials.yaml \
  --observed-resources observed/ \
  --output -

# Validate XRD schema
crossplane xrd validate xrd.yaml

# Lint composition
crossplane composition lint composition.yaml
```

## Section 9: Production Patterns

### Environment Selector Pattern

Use Composition labels to route Claims to the right provider and region:

```yaml
# Claim with environment selector
apiVersion: platform.example.com/v1beta1
kind: PostgresInstance
metadata:
  name: my-app-db
  namespace: team-alpha
spec:
  compositionSelector:
    matchLabels:
      provider: aws
      region: us-east-1
      environment: production
  parameters:
    storageGB: 100
    instanceClass: db.m5.large
```

### Cascade Deletion Protection

```yaml
apiVersion: platform.example.com/v1beta1
kind: PostgresInstance
metadata:
  name: my-app-db
  namespace: team-alpha
  annotations:
    crossplane.io/paused: "true"           # Pause reconciliation
spec:
  deletionPolicy: Orphan                   # Don't delete cloud resource when XR deleted
  parameters:
    deletionProtection: true
```

### Multi-Cluster GitOps with ArgoCD

```yaml
# ArgoCD ApplicationSet for multi-cluster composition deployment
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: crossplane-platform-configs
  namespace: argocd
spec:
  generators:
    - clusters:
        selector:
          matchLabels:
            crossplane.io/platform-cluster: "true"
  template:
    metadata:
      name: "crossplane-platform-{{name}}"
    spec:
      project: platform
      source:
        repoURL: https://github.com/example/platform-configs
        targetRevision: HEAD
        path: crossplane/{{metadata.labels.environment}}
      destination:
        server: "{{server}}"
        namespace: crossplane-system
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
          - ServerSideApply=true
```

### Health Check Policy

```yaml
apiVersion: apiextensions.crossplane.io/v1alpha1
kind: Usage
metadata:
  name: protect-production-rds
spec:
  by:
    apiVersion: platform.example.com/v1beta1
    kind: PostgresInstance
    resourceSelector:
      matchLabels:
        environment: production
  of:
    apiVersion: ec2.aws.upbound.io/v1beta1
    kind: VPC
    resourceRef:
      name: prod-vpc
  reason: "Production RDS instances depend on this VPC"
```

## Section 10: Migration and Upgrade Runbooks

### Migrating from Managed Resources to Compositions

```bash
#!/bin/bash
# migrate-rds-to-composition.sh
# Step 1: Annotate existing managed resource to prevent deletion
kubectl annotate rdsinstance legacy-db \
  crossplane.io/external-name=legacy-db-prod \
  crossplane.io/paused=true

# Step 2: Create XRD and Composition
kubectl apply -f xrd-postgres.yaml
kubectl apply -f composition-postgres-aws.yaml

# Step 3: Create Claim pointing to existing resource
kubectl apply -f - <<'EOF'
apiVersion: platform.example.com/v1beta1
kind: PostgresInstance
metadata:
  name: legacy-db
  namespace: production
  annotations:
    crossplane.io/external-name: legacy-db-prod  # Must match Step 1
spec:
  parameters:
    storageGB: 500
    instanceClass: db.r5.large
    multiAZ: true
    deletionProtection: true
  writeConnectionSecretToRef:
    name: legacy-db-credentials
EOF

# Step 4: Verify claim bound correctly
kubectl get postgresinstance legacy-db -n production -w

# Step 5: Unpause the original managed resource
kubectl annotate rdsinstance legacy-db crossplane.io/paused-
```

### XRD Version Migration

```bash
#!/bin/bash
# Migrate all Claims from v1alpha1 to v1beta1
NAMESPACE="team-alpha"

# List all v1alpha1 claims
kubectl get postgresinstances.v1alpha1.platform.example.com -n "$NAMESPACE" -o name | while read claim; do
  name=$(echo "$claim" | cut -d/ -f2)

  # Export current spec
  kubectl get postgresinstance "$name" -n "$NAMESPACE" \
    -o jsonpath='{.spec.parameters}' > "/tmp/${name}-params.json"

  # Apply v1beta1 claim (conversion webhook handles schema translation)
  # The --force flag causes a delete+recreate only if conversion fails
  kubectl annotate postgresinstance "$name" -n "$NAMESPACE" \
    platform.example.com/target-version=v1beta1 --overwrite

  echo "Annotated $name for migration"
done
```

## Conclusion

Crossplane compositions provide a powerful abstraction layer that separates platform concerns from developer concerns. The key architectural decisions covered in this guide:

1. **XRD schema design**: Define comprehensive status schemas, use CEL validation for cross-field constraints, and version carefully.
2. **Patch pipelines**: Use PatchSets for reuse, prefer `FromEnvironmentFieldPath` for cluster-level config, and use Match transforms for conditional routing.
3. **Function pipeline mode**: Enables arbitrary Go logic and composable function chains that the original P&T mode cannot express.
4. **Claim binding**: Pre-provision shared infrastructure XRs and allow namespace-scoped Claims to bind without reprovisioning.
5. **Observability**: Instrument reconcile errors and readiness latency; alert on compositions stuck in non-ready state.

The patterns described here support production deployments with hundreds of composite resources across multiple cloud providers and Kubernetes clusters.
