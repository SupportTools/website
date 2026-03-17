---
title: "Kubernetes Crossplane Functions: Composing Infrastructure with Pipeline Functions"
date: 2031-05-18T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Crossplane", "Infrastructure as Code", "Platform Engineering", "Go", "DevOps"]
categories:
- Kubernetes
- Platform Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Crossplane v1.14+ Composition Functions covering function-patch-and-transform, function-go-templating, function-auto-ready, FunctionRevision lifecycle, local testing, and building custom composition functions in Go."
more_link: "yes"
url: "/kubernetes-crossplane-functions-composition-pipeline/"
---

Crossplane Composition Functions represent the maturation of Crossplane's infrastructure composition model. The original `patches` and `transforms` approach worked for simple compositions but collapsed under complexity: no loops, no conditionals, no external data lookup. Functions introduced a pipeline model where each step is an independent container that can perform arbitrary transformations on the composition request.

This guide covers the complete function ecosystem: the built-in functions for patch-and-transform and Go templating, the auto-ready function for derived ready status, the FunctionRevision lifecycle for safe upgrades, local testing workflows, and building production-quality custom functions in Go.

<!--more-->

# Kubernetes Crossplane Functions: Composing Infrastructure with Pipeline Functions

## Section 1: Crossplane Functions Architecture

### 1.1 The Composition Pipeline Model

A Composition Function receives a `RunFunctionRequest` and returns a `RunFunctionResponse`. The request contains the composite resource, all observed managed resources, and any state passed from previous pipeline steps. The response contains the desired state of composed resources and any results (warnings, errors) to surface to the claim.

```
Composite Resource Claim
        │
        ▼
Crossplane Composite Reconciler
        │
        ▼
Composition Pipeline (ordered function list)
  ├── Step 1: function-patch-and-transform
  │     input: CompositeResource + Observed
  │     output: Desired ManagedResources
  │
  ├── Step 2: function-go-templating
  │     input: Desired from step 1 + extra logic
  │     output: Additional Desired ManagedResources
  │
  └── Step 3: function-auto-ready
        input: All Desired ManagedResources
        output: Composite ready condition
```

### 1.2 Installing Crossplane with Functions Support

```bash
# Install Crossplane v1.15+ (Functions are stable in v1.14+)
helm repo add crossplane-stable https://charts.crossplane.io/stable
helm repo update

helm install crossplane crossplane-stable/crossplane \
  --namespace crossplane-system \
  --create-namespace \
  --version 1.17.0 \
  --set args='{"--enable-composition-functions"}' \
  --wait

# Verify installation
kubectl get pods -n crossplane-system
kubectl get crds | grep crossplane.io | wc -l
# Should show 40+ CRDs

# Verify Functions support
kubectl get crds functions.pkg.crossplane.io
kubectl get crds functionrevisions.pkg.crossplane.io
```

## Section 2: function-patch-and-transform

The `function-patch-and-transform` function is the direct replacement for the old `patches` field in compositions. It supports all patch types, transforms, and ready conditions.

### 2.1 Installing the Function

```yaml
# function-patch-and-transform.yaml
apiVersion: pkg.crossplane.io/v1beta1
kind: Function
metadata:
  name: function-patch-and-transform
spec:
  package: xpkg.upbound.io/crossplane-contrib/function-patch-and-transform:v0.7.0
  packagePullPolicy: IfNotPresent
  revisionActivationPolicy: Automatic
  revisionHistoryLimit: 3
```

### 2.2 Composition Using Pipeline Mode

```yaml
# composition-rds-instance.yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: rds-postgres-standard
  labels:
    provider: aws
    engine: postgresql
    tier: standard
spec:
  compositeTypeRef:
    apiVersion: database.example.com/v1alpha1
    kind: XPostgresInstance

  # Use pipeline mode (v1.14+ style)
  mode: Pipeline
  pipeline:
    - step: patch-and-transform
      functionRef:
        name: function-patch-and-transform
      input:
        apiVersion: pt.fn.crossplane.io/v1beta1
        kind: Resources
        resources:
          # RDS DB Subnet Group
          - name: subnet-group
            base:
              apiVersion: rds.aws.upbound.io/v1beta1
              kind: SubnetGroup
              metadata:
                labels:
                  crossplane.io/composition-resource-name: subnet-group
              spec:
                forProvider:
                  description: "Managed by Crossplane"
                  region: us-east-1
                  subnetIdSelector:
                    matchLabels:
                      networks.example.com/tier: private
                providerConfigRef:
                  name: aws-provider
            patches:
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.region
                toFieldPath: spec.forProvider.region
              - type: FromCompositeFieldPath
                fromFieldPath: metadata.name
                toFieldPath: metadata.name
                transforms:
                  - type: string
                    string:
                      fmt: "%s-subnet-group"

          # RDS Instance
          - name: rds-instance
            base:
              apiVersion: rds.aws.upbound.io/v1beta1
              kind: Instance
              spec:
                forProvider:
                  region: us-east-1
                  engine: postgres
                  engineVersion: "16.2"
                  instanceClass: db.t3.medium
                  multiAz: false
                  skipFinalSnapshot: false
                  storageType: gp3
                  allocatedStorage: 20
                  maxAllocatedStorage: 100
                  storageEncrypted: true
                  deletionProtection: true
                  backupRetentionPeriod: 7
                  maintenanceWindow: "sun:05:00-sun:06:00"
                  backupWindow: "03:00-04:00"
                  autoMinorVersionUpgrade: true
                  performanceInsightsEnabled: true
                  performanceInsightsRetentionPeriod: 7
                  monitoringInterval: 60
                  # DB subnet group reference
                  dbSubnetGroupNameSelector:
                    matchControllerRef: true
                providerConfigRef:
                  name: aws-provider
            patches:
              # From composite fields
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.region
                toFieldPath: spec.forProvider.region
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.instanceClass
                toFieldPath: spec.forProvider.instanceClass
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.storageGb
                toFieldPath: spec.forProvider.allocatedStorage
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.multiAz
                toFieldPath: spec.forProvider.multiAz
                transforms:
                  - type: convert
                    convert:
                      toType: bool

              # Name from composite metadata
              - type: FromCompositeFieldPath
                fromFieldPath: metadata.name
                toFieldPath: metadata.name
                transforms:
                  - type: string
                    string:
                      fmt: "%s-rds"

              # Conditional: enable deletion protection based on environment
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.environment
                toFieldPath: spec.forProvider.deletionProtection
                transforms:
                  - type: map
                    map:
                      production: "true"
                      staging: "false"
                      development: "false"
                  - type: convert
                    convert:
                      toType: bool

              # Tag the resource with composite info
              - type: FromCompositeFieldPath
                fromFieldPath: metadata.name
                toFieldPath: spec.forProvider.tags[Name]
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.environment
                toFieldPath: spec.forProvider.tags[Environment]

              # Write status back to composite
              - type: ToCompositeFieldPath
                fromFieldPath: status.atProvider.endpoint
                toFieldPath: status.endpoint

              - type: ToCompositeFieldPath
                fromFieldPath: status.atProvider.port
                toFieldPath: status.port

            # Ready when the instance is available
            readinessChecks:
              - type: MatchString
                fieldPath: status.atProvider.dbInstanceStatus
                matchString: available

          # Parameter group for performance tuning
          - name: parameter-group
            base:
              apiVersion: rds.aws.upbound.io/v1beta1
              kind: ParameterGroup
              spec:
                forProvider:
                  region: us-east-1
                  family: postgres16
                  description: "Crossplane managed parameter group"
                  parameter:
                    - name: max_connections
                      value: "100"
                      applyMethod: pending-reboot
                    - name: shared_buffers
                      value: "{DBInstanceClassMemory/32768}"
                      applyMethod: pending-reboot
                    - name: work_mem
                      value: "4096"
                      applyMethod: immediate
                    - name: log_min_duration_statement
                      value: "1000"
                      applyMethod: immediate
                    - name: log_connections
                      value: "1"
                      applyMethod: immediate
                    - name: log_disconnections
                      value: "1"
                      applyMethod: immediate
                providerConfigRef:
                  name: aws-provider
            patches:
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.region
                toFieldPath: spec.forProvider.region

    # Step 2: Auto-ready function
    - step: automatically-detect-ready
      functionRef:
        name: function-auto-ready
```

## Section 3: function-go-templating

For complex logic requiring loops, conditionals, and data manipulation:

### 3.1 Installing function-go-templating

```yaml
# function-go-templating.yaml
apiVersion: pkg.crossplane.io/v1beta1
kind: Function
metadata:
  name: function-go-templating
spec:
  package: xpkg.upbound.io/crossplane-contrib/function-go-templating:v0.7.0
  packagePullPolicy: IfNotPresent
  revisionActivationPolicy: Automatic
```

### 3.2 Dynamic Resource Generation with Templates

```yaml
# composition-vpc-with-subnets.yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: vpc-with-subnets
spec:
  compositeTypeRef:
    apiVersion: network.example.com/v1alpha1
    kind: XVPC

  mode: Pipeline
  pipeline:
    - step: create-vpc-and-subnets
      functionRef:
        name: function-go-templating
      input:
        apiVersion: gotemplating.fn.crossplane.io/v1beta1
        kind: GoTemplate
        source: Inline
        inline:
          template: |
            {{- $xr := .observed.composite.resource }}
            {{- $region := $xr.spec.parameters.region | default "us-east-1" }}
            {{- $vpcCidr := $xr.spec.parameters.vpcCidr | default "10.0.0.0/16" }}
            {{- $name := $xr.metadata.name }}
            {{- $azs := list "a" "b" "c" }}
            {{- if $xr.spec.parameters.availabilityZones }}
              {{- $azs = $xr.spec.parameters.availabilityZones }}
            {{- end }}

            ---
            # VPC
            apiVersion: ec2.aws.upbound.io/v1beta1
            kind: VPC
            metadata:
              annotations:
                gotemplating.fn.crossplane.io/composition-resource-name: vpc
                crossplane.io/external-name: {{ $name }}-vpc
              labels:
                crossplane.io/composition-resource-name: vpc
            spec:
              forProvider:
                region: {{ $region }}
                cidrBlock: {{ $vpcCidr }}
                enableDnsHostnames: true
                enableDnsSupport: true
                tags:
                  Name: {{ $name }}-vpc
                  ManagedBy: crossplane
              providerConfigRef:
                name: aws-provider

            ---
            # Internet Gateway
            apiVersion: ec2.aws.upbound.io/v1beta1
            kind: InternetGateway
            metadata:
              annotations:
                gotemplating.fn.crossplane.io/composition-resource-name: igw
            spec:
              forProvider:
                region: {{ $region }}
                vpcIdSelector:
                  matchControllerRef: true
                tags:
                  Name: {{ $name }}-igw
              providerConfigRef:
                name: aws-provider

            {{- range $i, $az := $azs }}
            {{- $azFull := printf "%s%s" $region $az }}
            {{- $publicCidr := printf "10.%d.0.0/24" (add $i 0) }}
            {{- $privateCidr := printf "10.%d.1.0/24" (add $i 0) }}

            ---
            # Public Subnet in AZ {{ $az }}
            apiVersion: ec2.aws.upbound.io/v1beta1
            kind: Subnet
            metadata:
              annotations:
                gotemplating.fn.crossplane.io/composition-resource-name: public-subnet-{{ $az }}
              labels:
                crossplane.io/composition-resource-name: public-subnet-{{ $az }}
                networks.example.com/tier: public
                networks.example.com/az: {{ $az }}
            spec:
              forProvider:
                region: {{ $region }}
                availabilityZone: {{ $azFull }}
                cidrBlock: {{ $publicCidr }}
                mapPublicIpOnLaunch: true
                vpcIdSelector:
                  matchControllerRef: true
                tags:
                  Name: {{ $name }}-public-{{ $az }}
                  networks.example.com/tier: public
                  kubernetes.io/role/elb: "1"
              providerConfigRef:
                name: aws-provider

            ---
            # Private Subnet in AZ {{ $az }}
            apiVersion: ec2.aws.upbound.io/v1beta1
            kind: Subnet
            metadata:
              annotations:
                gotemplating.fn.crossplane.io/composition-resource-name: private-subnet-{{ $az }}
              labels:
                networks.example.com/tier: private
                networks.example.com/az: {{ $az }}
            spec:
              forProvider:
                region: {{ $region }}
                availabilityZone: {{ $azFull }}
                cidrBlock: {{ $privateCidr }}
                mapPublicIpOnLaunch: false
                vpcIdSelector:
                  matchControllerRef: true
                tags:
                  Name: {{ $name }}-private-{{ $az }}
                  networks.example.com/tier: private
                  kubernetes.io/role/internal-elb: "1"
              providerConfigRef:
                name: aws-provider

            {{- end }}

            ---
            # Update composite status
            apiVersion: network.example.com/v1alpha1
            kind: XVPC
            status:
              region: {{ $region }}
              subnetCount: {{ mul (len $azs) 2 }}

    - step: auto-ready
      functionRef:
        name: function-auto-ready
```

### 3.3 Accessing Observed State in Templates

```yaml
# Access observed (existing) state in templates
template: |
  {{- $xr := .observed.composite.resource }}
  {{- $observed := .observed.resources }}

  {{- /* Check if a resource already exists */ -}}
  {{- $vpcExists := false }}
  {{- if index $observed "vpc" }}
    {{- $vpcExists = true }}
    {{- $existingVpcId := (index $observed "vpc").resource.status.atProvider.id }}
  {{- end }}

  {{- /* Use desired state from previous pipeline steps */ -}}
  {{- $desired := .desired.resources }}

  {{- /* Access context (e.g., from EnvironmentConfig) */ -}}
  {{- $env := .context | default dict }}
  {{- $environmentTag := "" }}
  {{- if $env }}
    {{- $environmentTag = ($env | dig "apiextensions.crossplane.io/environment" dict | dig "tag" "") }}
  {{- end }}
```

## Section 4: function-auto-ready

`function-auto-ready` computes the ready condition for the composite resource based on the observed state of all composed resources:

```yaml
# function-auto-ready.yaml
apiVersion: pkg.crossplane.io/v1beta1
kind: Function
metadata:
  name: function-auto-ready
spec:
  package: xpkg.upbound.io/crossplane-contrib/function-auto-ready:v0.3.0
```

When this function runs as the last step, it:
1. Looks at all managed resources in the desired state
2. Checks if each one has `status.conditions[type=Ready].status=True`
3. Sets the composite's `status.conditions[type=Ready].status=True` only when ALL composed resources are ready

No input is required — just include it as the final pipeline step.

## Section 5: FunctionRevision Lifecycle

Functions use a revision-based deployment model similar to Provider packages:

### 5.1 Understanding Revisions

```bash
# After installing a Function, revisions are created
kubectl get functionrevisions
# NAME                                             HEALTHY   REVISION   IMAGE                                                          STATE    DEP-FOUND   DEP-INSTALLED   AGE
# function-patch-and-transform-d6e2234f9cd0        True      1          xpkg.upbound.io/crossplane-contrib/function-patch-and-transform:v0.6.0   Active   1           1               5d
# function-patch-and-transform-b7a1234f1abc        True      2          xpkg.upbound.io/crossplane-contrib/function-patch-and-transform:v0.7.0   Active   1           1               1d

# The current revision is the one in "Active" state
kubectl get functionrevision function-patch-and-transform-b7a1234f1abc -o yaml | grep state
# state: Active

# Check the function health
kubectl get function function-patch-and-transform
# NAME                            INSTALLED   HEALTHY   PACKAGE                                                                 AGE
# function-patch-and-transform    True        True      xpkg.upbound.io/crossplane-contrib/function-patch-and-transform:v0.7.0   5d
```

### 5.2 Safe Function Upgrades

```bash
# Upgrade a function by updating the package reference
kubectl patch function function-patch-and-transform \
  --type merge \
  -p '{"spec":{"package":"xpkg.upbound.io/crossplane-contrib/function-patch-and-transform:v0.8.0"}}'

# Watch the upgrade process
kubectl get functionrevision -w
# A new revision is created and tested
# Old revision remains "Inactive" for revision history

# Check revision history (for rollback if needed)
kubectl get functionrevision --sort-by='.metadata.creationTimestamp'

# Rollback to previous revision (manual process)
OLD_REV_IMAGE=$(kubectl get functionrevision <old-revision-name> \
  -o jsonpath='{.spec.image}')
kubectl patch function function-patch-and-transform \
  --type merge \
  -p "{\"spec\":{\"package\":\"$OLD_REV_IMAGE\"}}"
```

### 5.3 Controlling Revision History

```yaml
apiVersion: pkg.crossplane.io/v1beta1
kind: Function
metadata:
  name: function-patch-and-transform
spec:
  package: xpkg.upbound.io/crossplane-contrib/function-patch-and-transform:v0.7.0
  revisionActivationPolicy: Automatic   # or Manual
  revisionHistoryLimit: 5               # Keep last 5 revisions (default: 1)
  packagePullPolicy: IfNotPresent
  # For manual activation:
  # revisionActivationPolicy: Manual
  # Then activate with:
  # kubectl patch functionrevision <name> --type merge -p '{"spec":{"desiredState":"Active"}}'
```

## Section 6: Local Testing with crossplane beta render

Testing compositions locally without a running cluster is critical for development velocity:

### 6.1 Setting Up Local Testing

```bash
# Install crossplane CLI
curl -sL https://raw.githubusercontent.com/crossplane/crossplane/main/install.sh | sh

# Verify render command
crossplane beta render --help
```

### 6.2 Local Render Workflow

Create the test files:

```yaml
# xr.yaml - The composite resource to render
apiVersion: database.example.com/v1alpha1
kind: XPostgresInstance
metadata:
  name: my-database
spec:
  parameters:
    region: us-east-1
    instanceClass: db.t3.medium
    storageGb: 20
    multiAz: false
    environment: production
  compositeDeletePolicy: Foreground
  claimRef:
    apiVersion: database.example.com/v1alpha1
    kind: PostgresInstance
    name: my-database
    namespace: production
```

```yaml
# observed.yaml - Existing observed state (simulate second reconcile)
apiVersion: database.example.com/v1alpha1
kind: XPostgresInstance
metadata:
  name: my-database
  annotations:
    crossplane.io/composition-resource-name: ""
---
apiVersion: rds.aws.upbound.io/v1beta1
kind: Instance
metadata:
  name: my-database-rds
  annotations:
    crossplane.io/composition-resource-name: rds-instance
status:
  atProvider:
    dbInstanceStatus: available
    endpoint: my-database.cluster-xyz.us-east-1.rds.amazonaws.com
    port: 5432
  conditions:
    - type: Ready
      status: "True"
```

```bash
# Run local render
crossplane beta render \
  xr.yaml \
  composition-rds-instance.yaml \
  functions.yaml \  # List of Function objects
  --observed observed.yaml \
  --verbose

# Output: generated YAML for all composed resources
# This shows exactly what resources would be created/updated

# Test with different parameters
cat > xr-production.yaml << 'EOF'
apiVersion: database.example.com/v1alpha1
kind: XPostgresInstance
metadata:
  name: prod-db
spec:
  parameters:
    region: us-east-1
    instanceClass: db.r6g.xlarge
    storageGb: 100
    multiAz: true
    environment: production
EOF

crossplane beta render xr-production.yaml composition-rds-instance.yaml functions.yaml
```

### 6.3 Testing Composition Functions with Unit Tests

Crossplane provides a testing SDK for function authors:

```go
// test/e2e/composition_test.go
package test

import (
    "testing"

    "github.com/google/go-cmp/cmp"
    "github.com/google/go-cmp/cmp/cmpopts"
    "github.com/crossplane/crossplane-runtime/pkg/resource/fake"
    fnv1beta1 "github.com/crossplane/function-sdk-go/proto/v1beta1"
    "github.com/crossplane/function-sdk-go/resource"
    "github.com/crossplane/function-sdk-go/response"
    "google.golang.org/protobuf/types/known/structpb"
)

func TestRDSComposition(t *testing.T) {
    cases := map[string]struct {
        reason  string
        request *fnv1beta1.RunFunctionRequest
        want    *fnv1beta1.RunFunctionResponse
        wantErr bool
    }{
        "BasicPostgresInstance": {
            reason: "Should create RDS instance with correct configuration",
            request: &fnv1beta1.RunFunctionRequest{
                Observed: &fnv1beta1.State{
                    Composite: &fnv1beta1.Resource{
                        Resource: mustMarshal(t, map[string]interface{}{
                            "apiVersion": "database.example.com/v1alpha1",
                            "kind":       "XPostgresInstance",
                            "metadata":   map[string]interface{}{"name": "test-db"},
                            "spec": map[string]interface{}{
                                "parameters": map[string]interface{}{
                                    "region":        "us-east-1",
                                    "instanceClass": "db.t3.medium",
                                    "storageGb":     20,
                                    "environment":   "production",
                                },
                            },
                        }),
                    },
                },
            },
            want: &fnv1beta1.RunFunctionResponse{
                Desired: &fnv1beta1.State{
                    Resources: map[string]*fnv1beta1.Resource{
                        "rds-instance": {
                            Resource: mustContain(t, "spec.forProvider.instanceClass", "db.t3.medium"),
                        },
                    },
                },
            },
        },
    }

    for name, tc := range cases {
        t.Run(name, func(t *testing.T) {
            f := &Function{} // Your function under test
            rsp, err := f.RunFunction(context.Background(), tc.request)

            if tc.wantErr && err == nil {
                t.Fatalf("%s: want error, got none", tc.reason)
            }
            if !tc.wantErr && err != nil {
                t.Fatalf("%s: unexpected error: %v", tc.reason, err)
            }

            // Verify desired resources
            if diff := cmp.Diff(tc.want, rsp, cmpopts.IgnoreUnexported(
                fnv1beta1.RunFunctionResponse{},
                fnv1beta1.State{},
                fnv1beta1.Resource{},
            )); diff != "" {
                t.Errorf("%s: -want +got:\n%s", tc.reason, diff)
            }
        })
    }
}
```

## Section 7: Building Custom Composition Functions in Go

### 7.1 Scaffolding a New Function

```bash
# Install function template tool
go install github.com/crossplane/function-template-go/cmd/crossplane-function-template@latest

# Or use the GitHub template
# https://github.com/crossplane/function-template-go

# Project structure after scaffolding:
my-function/
├── fn.go              # Function implementation
├── fn_test.go         # Tests
├── input/
│   └── v1beta1/
│       └── input.go   # Input type definition
├── main.go            # gRPC server entrypoint
├── Dockerfile
├── go.mod
└── package/
    └── crossplane.yaml # Package metadata
```

### 7.2 Function Implementation

```go
// fn.go
package main

import (
    "context"

    "github.com/crossplane/crossplane-runtime/pkg/errors"
    "github.com/crossplane/crossplane-runtime/pkg/logging"
    fnv1beta1 "github.com/crossplane/function-sdk-go/proto/v1beta1"
    "github.com/crossplane/function-sdk-go/request"
    "github.com/crossplane/function-sdk-go/resource"
    "github.com/crossplane/function-sdk-go/response"
    "google.golang.org/protobuf/types/known/structpb"

    "myorg/function-database-defaults/input/v1beta1"
)

// Function that adds database security defaults to RDS instances
type Function struct {
    fnv1beta1.UnimplementedFunctionRunnerServiceServer
    log logging.Logger
}

func (f *Function) RunFunction(ctx context.Context, req *fnv1beta1.RunFunctionRequest) (*fnv1beta1.RunFunctionResponse, error) {
    f.log.Info("Running function", "tag", req.GetMeta().GetTag())

    rsp := response.To(req, response.DefaultTTL)

    // Get input configuration
    in := &v1beta1.Input{}
    if err := request.GetInput(req, in); err != nil {
        response.Fatal(rsp, errors.Wrapf(err, "cannot get Function input from %T", req))
        return rsp, nil
    }

    // Get the observed composite resource
    oxr, err := request.GetObservedCompositeResource(req)
    if err != nil {
        response.Fatal(rsp, errors.Wrap(err, "cannot get observed composite resource"))
        return rsp, nil
    }

    // Get the desired composite resource (may have been modified by earlier steps)
    dxr, err := request.GetDesiredCompositeResource(req)
    if err != nil {
        response.Fatal(rsp, errors.Wrap(err, "cannot get desired composite resource"))
        return rsp, nil
    }
    dxr.Resource.SetLabels(oxr.Resource.GetLabels())

    // Get all desired resources from previous steps
    desired, err := request.GetDesiredComposedResources(req)
    if err != nil {
        response.Fatal(rsp, errors.Wrap(err, "cannot get desired composed resources"))
        return rsp, nil
    }

    // Find RDS instances in desired state and add security defaults
    for name, dr := range desired {
        if dr.Resource.GetAPIVersion() != "rds.aws.upbound.io/v1beta1" ||
           dr.Resource.GetKind() != "Instance" {
            continue
        }

        f.log.Debug("Applying security defaults to RDS instance", "name", name)

        // Ensure encryption is enabled
        if err := dr.Resource.SetNestedField(true,
            "spec", "forProvider", "storageEncrypted"); err != nil {
            response.Fatal(rsp, errors.Wrapf(err, "cannot enable storage encryption for %s", name))
            return rsp, nil
        }

        // Ensure deletion protection based on environment
        env, _, err := oxr.Resource.NestedString("spec", "parameters", "environment")
        if err != nil {
            env = "development"
        }

        deletionProtection := env == "production" || env == "staging"
        if err := dr.Resource.SetNestedField(deletionProtection,
            "spec", "forProvider", "deletionProtection"); err != nil {
            response.Fatal(rsp, errors.Wrapf(err, "cannot set deletion protection for %s", name))
            return rsp, nil
        }

        // Apply custom parameter group if configured
        if in.ParameterGroupFamily != "" {
            paramGroupName := fmt.Sprintf("%s-%s", dr.Resource.GetName(), "params")
            if err := dr.Resource.SetNestedField(paramGroupName,
                "spec", "forProvider", "parameterGroupName"); err != nil {
                f.log.Info("Could not set parameter group name", "error", err)
            }
        }

        // Ensure audit logging
        if err := dr.Resource.SetNestedField([]interface{}{
            map[string]interface{}{
                "cloudwatchLogsExportConfiguration": map[string]interface{}{
                    "enableLogTypes": []interface{}{"postgresql", "upgrade"},
                },
            },
        }, "spec", "forProvider", "enabledCloudwatchLogsExports"); err != nil {
            f.log.Info("Could not enable CloudWatch logs", "error", err)
        }

        f.log.Info("Applied security defaults", "resource", name,
            "environment", env,
            "deletionProtection", deletionProtection)
    }

    // Pass all desired resources through
    if err := response.SetDesiredComposedResources(rsp, desired); err != nil {
        response.Fatal(rsp, errors.Wrap(err, "cannot set desired composed resources"))
        return rsp, nil
    }

    if err := response.SetDesiredCompositeResource(rsp, dxr); err != nil {
        response.Fatal(rsp, errors.Wrap(err, "cannot set desired composite resource"))
        return rsp, nil
    }

    response.Normal(rsp, "Applied database security defaults")
    return rsp, nil
}
```

### 7.3 Input Type Definition

```go
// input/v1beta1/input.go
package v1beta1

import metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

// Input parameters for the database-defaults function
type Input struct {
    metav1.TypeMeta `json:",inline"`

    // ParameterGroupFamily for RDS parameter groups
    // e.g., "postgres16", "mysql8.0"
    // +optional
    ParameterGroupFamily string `json:"parameterGroupFamily,omitempty"`

    // EnforceEncryption requires storage encryption
    // +kubebuilder:default=true
    EnforceEncryption bool `json:"enforceEncryption"`

    // AuditLogging enables CloudWatch audit log export
    // +kubebuilder:default=true
    AuditLogging bool `json:"auditLogging"`

    // AllowedEnvironments lists environments where deletion protection is not required
    // +optional
    AllowedUnprotectedEnvironments []string `json:"allowedUnprotectedEnvironments,omitempty"`
}
```

### 7.4 Building and Publishing the Function

```bash
# Build the function
go build ./...

# Build OCI image
docker build -t registry.corp.example.com/crossplane/function-database-defaults:v1.0.0 .
docker push registry.corp.example.com/crossplane/function-database-defaults:v1.0.0

# Build xpkg package
crossplane xpkg build \
  --package-root=package/ \
  --embed-runtime-image=registry.corp.example.com/crossplane/function-database-defaults:v1.0.0 \
  -o function-database-defaults-v1.0.0.xpkg

# Push to Upbound Marketplace (or private registry)
crossplane xpkg push \
  --package=function-database-defaults-v1.0.0.xpkg \
  registry.corp.example.com/crossplane-packages/function-database-defaults:v1.0.0

# Install in cluster
cat > function-database-defaults.yaml << 'EOF'
apiVersion: pkg.crossplane.io/v1beta1
kind: Function
metadata:
  name: function-database-defaults
spec:
  package: registry.corp.example.com/crossplane-packages/function-database-defaults:v1.0.0
  packagePullPolicy: IfNotPresent
  revisionActivationPolicy: Automatic
EOF
kubectl apply -f function-database-defaults.yaml
```

### 7.5 Using the Custom Function in a Composition

```yaml
# Updated composition pipeline with custom function
  pipeline:
    - step: patch-and-transform
      functionRef:
        name: function-patch-and-transform
      input:
        # ... (previous configuration)

    - step: apply-database-defaults
      functionRef:
        name: function-database-defaults
      input:
        apiVersion: database-defaults.fn.example.com/v1beta1
        kind: Input
        parameterGroupFamily: postgres16
        enforceEncryption: true
        auditLogging: true
        allowedUnprotectedEnvironments:
          - development

    - step: auto-ready
      functionRef:
        name: function-auto-ready
```

Crossplane Composition Functions transform infrastructure composition from a rigid patch-and-transform model into a composable, testable pipeline architecture. The ability to write custom functions in Go — with full access to observed state, arbitrary logic, and structured input/output — enables platform engineering teams to encode organizational policies as reusable infrastructure primitives that development teams can consume through simple, high-level Kubernetes resources.
