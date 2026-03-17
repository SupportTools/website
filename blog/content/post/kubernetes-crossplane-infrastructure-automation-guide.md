---
title: "Crossplane for Infrastructure Automation: Compositions, XRDs, and Multi-Cloud Managed Resources"
date: 2028-05-24T00:00:00-05:00
draft: false
tags: ["Crossplane", "Kubernetes", "Infrastructure as Code", "AWS", "GCP", "Azure", "Platform Engineering"]
categories: ["Kubernetes", "Infrastructure", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep dive into Crossplane for infrastructure automation covering Compositions, CompositeResourceDefinitions, managed resources for AWS/GCP/Azure, and XRDs for database and network provisioning."
more_link: "yes"
url: "/kubernetes-crossplane-infrastructure-automation-guide/"
---

Crossplane transforms Kubernetes into a universal control plane for cloud infrastructure. Rather than maintaining parallel Terraform state files, Ansible playbooks, or cloud-specific CLI scripts, Crossplane lets platform teams define infrastructure as Kubernetes-native custom resources, enforce organizational policies through Compositions, and give developers self-service access to infrastructure without granting direct cloud permissions.

This guide covers the full operational picture: installing and configuring providers, authoring CompositeResourceDefinitions (XRDs), building Compositions that abstract underlying cloud complexity, and operating managed resources at scale across AWS, GCP, and Azure.

<!--more-->

## Architecture Overview

Crossplane extends the Kubernetes API with three primary abstraction layers:

**Managed Resources (MRs)** are low-level, provider-specific representations of cloud resources. An `RDSInstance` in the AWS provider maps directly to an AWS RDS database. MRs are rarely used by application developers directly.

**Composite Resources (XRs)** are platform-defined custom resources that group related managed resources into coherent units. A `PostgreSQLInstance` XR might create an RDS instance, a security group, a subnet group, and a parameter group.

**Claims** are namespace-scoped references to composite resources, enabling developers to request infrastructure without cluster-admin access.

```
Developer Claim (namespace-scoped)
         ↓
Composite Resource (cluster-scoped)
         ↓
Composition (transforms XR → MRs)
         ↓
Managed Resources (cloud API calls)
```

## Installing Crossplane

### Helm Installation

```bash
helm repo add crossplane-stable https://charts.crossplane.io/stable
helm repo update

helm install crossplane \
  --namespace crossplane-system \
  --create-namespace \
  crossplane-stable/crossplane \
  --version 1.15.0 \
  --set args='{"--enable-composition-functions","--enable-composition-revisions"}' \
  --set resourcesCrossplane.requests.cpu=100m \
  --set resourcesCrossplane.requests.memory=256Mi \
  --set resourcesCrossplane.limits.cpu=500m \
  --set resourcesCrossplane.limits.memory=512Mi
```

### Verify Installation

```bash
kubectl get pods -n crossplane-system
# NAME                                        READY   STATUS    RESTARTS   AGE
# crossplane-7d8f9b4c6-x9k2m                 1/1     Running   0          2m
# crossplane-rbac-manager-5f4d8b9c7-p3n8q    1/1     Running   0          2m

kubectl get crds | grep crossplane.io | wc -l
# 22
```

## Installing and Configuring Providers

### AWS Provider

```yaml
# aws-provider.yaml
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws-ec2
spec:
  package: xpkg.upbound.io/upbound/provider-aws-ec2:v0.46.0
  runtimeConfigRef:
    name: default
---
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws-rds
spec:
  package: xpkg.upbound.io/upbound/provider-aws-rds:v0.46.0
---
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws-iam
spec:
  package: xpkg.upbound.io/upbound/provider-aws-iam:v0.46.0
```

```bash
kubectl apply -f aws-provider.yaml

# Watch provider installation
kubectl get providers -w
# NAME                  INSTALLED   HEALTHY   PACKAGE                                                      AGE
# provider-aws-ec2      True        True      xpkg.upbound.io/upbound/provider-aws-ec2:v0.46.0             3m
# provider-aws-rds      True        True      xpkg.upbound.io/upbound/provider-aws-rds:v0.46.0             3m
# provider-aws-iam      True        True      xpkg.upbound.io/upbound/provider-aws-iam:v0.46.0             3m
```

### AWS Provider Configuration

```bash
# Create AWS credentials secret
kubectl create secret generic aws-creds \
  --namespace crossplane-system \
  --from-file=credentials=$HOME/.aws/credentials
```

```yaml
# aws-providerconfig.yaml
apiVersion: aws.upbound.io/v1beta1
kind: ProviderConfig
metadata:
  name: default
spec:
  credentials:
    source: Secret
    secretRef:
      namespace: crossplane-system
      name: aws-creds
      key: credentials
```

For production, use IRSA (IAM Roles for Service Accounts) instead:

```yaml
# aws-providerconfig-irsa.yaml
apiVersion: aws.upbound.io/v1beta1
kind: ProviderConfig
metadata:
  name: default
spec:
  credentials:
    source: IRSA
  assumeRoleChain:
    - roleARN: arn:aws:iam::123456789012:role/crossplane-provider-role
```

### GCP Provider

```yaml
# gcp-provider.yaml
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-gcp-sql
spec:
  package: xpkg.upbound.io/upbound/provider-gcp-sql:v0.41.0
---
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-gcp-compute
spec:
  package: xpkg.upbound.io/upbound/provider-gcp-compute:v0.41.0
```

```yaml
# gcp-providerconfig.yaml
apiVersion: gcp.upbound.io/v1beta1
kind: ProviderConfig
metadata:
  name: default
spec:
  projectID: my-gcp-project-id
  credentials:
    source: Secret
    secretRef:
      namespace: crossplane-system
      name: gcp-creds
      key: creds
```

### Azure Provider

```yaml
# azure-provider.yaml
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-azure-dbforpostgresql
spec:
  package: xpkg.upbound.io/upbound/provider-azure-dbforpostgresql:v0.39.0
---
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-azure-network
spec:
  package: xpkg.upbound.io/upbound/provider-azure-network:v0.39.0
```

```yaml
# azure-providerconfig.yaml
apiVersion: azure.upbound.io/v1beta1
kind: ProviderConfig
metadata:
  name: default
spec:
  credentials:
    source: Secret
    secretRef:
      namespace: crossplane-system
      name: azure-creds
      key: credentials
```

## Building CompositeResourceDefinitions (XRDs)

XRDs define the schema for your platform's custom resources. They are the contract between platform engineers and application developers.

### PostgreSQL XRD

```yaml
# xrd-postgresql.yaml
apiVersion: apiextensions.crossplane.io/v1
kind: CompositeResourceDefinition
metadata:
  name: xpostgresqlinstances.platform.example.com
spec:
  group: platform.example.com
  names:
    kind: XPostgreSQLInstance
    plural: xpostgresqlinstances
  claimNames:
    kind: PostgreSQLInstance
    plural: postgresqlinstances
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
                  description: PostgreSQL instance configuration parameters
                  required:
                    - storageGB
                    - region
                  properties:
                    storageGB:
                      type: integer
                      description: Storage size in gigabytes
                      minimum: 20
                      maximum: 16384
                    version:
                      type: string
                      description: PostgreSQL version
                      enum:
                        - "14"
                        - "15"
                        - "16"
                      default: "16"
                    tier:
                      type: string
                      description: Performance tier for the instance
                      enum:
                        - small
                        - medium
                        - large
                        - xlarge
                      default: small
                    region:
                      type: string
                      description: Cloud region for deployment
                    multiAZ:
                      type: boolean
                      description: Enable multi-AZ for high availability
                      default: false
                    backupRetentionDays:
                      type: integer
                      description: Number of days to retain backups
                      minimum: 1
                      maximum: 35
                      default: 7
                    maintenanceWindow:
                      type: string
                      description: Preferred maintenance window (e.g., Mon:05:00-Mon:06:00)
                      default: "Sun:04:00-Sun:05:00"
              required:
                - parameters
```

### VPC Network XRD

```yaml
# xrd-vpc.yaml
apiVersion: apiextensions.crossplane.io/v1
kind: CompositeResourceDefinition
metadata:
  name: xvpcs.platform.example.com
spec:
  group: platform.example.com
  names:
    kind: XVPC
    plural: xvpcs
  claimNames:
    kind: VPC
    plural: vpcs
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
                  required:
                    - region
                    - cidrBlock
                  properties:
                    region:
                      type: string
                    cidrBlock:
                      type: string
                      pattern: '^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$'
                    enableDnsHostnames:
                      type: boolean
                      default: true
                    publicSubnetCount:
                      type: integer
                      minimum: 1
                      maximum: 3
                      default: 2
                    privateSubnetCount:
                      type: integer
                      minimum: 1
                      maximum: 3
                      default: 2
              required:
                - parameters
            status:
              type: object
              properties:
                vpcId:
                  type: string
                publicSubnetIds:
                  type: array
                  items:
                    type: string
                privateSubnetIds:
                  type: array
                  items:
                    type: string
```

## Writing Compositions

Compositions define how XRs map to managed resources. They contain the transformation logic that connects developer-facing abstractions to cloud-specific resources.

### AWS RDS Composition

```yaml
# composition-aws-postgresql.yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: xpostgresqlinstances.aws.platform.example.com
  labels:
    provider: aws
    service: postgresql
spec:
  compositeTypeRef:
    apiVersion: platform.example.com/v1alpha1
    kind: XPostgreSQLInstance
  writeConnectionSecretsToNamespace: crossplane-system
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
                  instanceClass: db.t3.micro
                  allocatedStorage: 20
                  dbName: app
                  username: dbadmin
                  passwordSecretRef:
                    namespace: crossplane-system
                    key: password
                  skipFinalSnapshot: false
                  deletionProtection: true
                  storageEncrypted: true
                  backupRetentionPeriod: 7
                  multiAz: false
                  autoMinorVersionUpgrade: true
                  copyTagsToSnapshot: true
                  performanceInsightsEnabled: true
                writeConnectionSecretToRef:
                  namespace: crossplane-system
            patches:
              # Map tier to instance class
              - type: CombineFromComposite
                combine:
                  variables:
                    - fromFieldPath: spec.parameters.tier
                  strategy: string
                  string:
                    fmt: |
                      %s
                toFieldPath: metadata.annotations[crossplane.io/tier]
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.region
                toFieldPath: spec.forProvider.region
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.storageGB
                toFieldPath: spec.forProvider.allocatedStorage
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.version
                toFieldPath: spec.forProvider.engineVersion
                transforms:
                  - type: string
                    string:
                      type: Format
                      fmt: "%s"
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.multiAZ
                toFieldPath: spec.forProvider.multiAz
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.backupRetentionDays
                toFieldPath: spec.forProvider.backupRetentionPeriod
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.maintenanceWindow
                toFieldPath: spec.forProvider.maintenanceWindow
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.tier
                toFieldPath: spec.forProvider.instanceClass
                transforms:
                  - type: map
                    map:
                      small: db.t3.micro
                      medium: db.t3.medium
                      large: db.r6g.large
                      xlarge: db.r6g.xlarge
              # Write connection details to composite secret
              - type: FromCompositeFieldPath
                fromFieldPath: metadata.uid
                toFieldPath: spec.writeConnectionSecretToRef.name
                transforms:
                  - type: string
                    string:
                      type: Format
                      fmt: "%s-postgresql"
            connectionDetails:
              - name: username
                fromConnectionSecretKey: username
              - name: password
                fromConnectionSecretKey: password
              - name: endpoint
                fromConnectionSecretKey: endpoint
              - name: port
                fromConnectionSecretKey: port

          - name: db-subnet-group
            base:
              apiVersion: rds.aws.upbound.io/v1beta1
              kind: SubnetGroup
              spec:
                forProvider:
                  region: us-east-1
                  description: Crossplane-managed subnet group
                  subnetIdSelector:
                    matchLabels:
                      access: private
            patches:
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.region
                toFieldPath: spec.forProvider.region

          - name: security-group
            base:
              apiVersion: ec2.aws.upbound.io/v1beta1
              kind: SecurityGroup
              spec:
                forProvider:
                  region: us-east-1
                  description: Crossplane-managed RDS security group
                  ingress:
                    - fromPort: 5432
                      toPort: 5432
                      protocol: tcp
                      cidrBlocks:
                        - 10.0.0.0/8
            patches:
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.region
                toFieldPath: spec.forProvider.region
```

### GCP Cloud SQL Composition

```yaml
# composition-gcp-postgresql.yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: xpostgresqlinstances.gcp.platform.example.com
  labels:
    provider: gcp
    service: postgresql
spec:
  compositeTypeRef:
    apiVersion: platform.example.com/v1alpha1
    kind: XPostgreSQLInstance
  writeConnectionSecretsToNamespace: crossplane-system
  mode: Pipeline
  pipeline:
    - step: patch-and-transform
      functionRef:
        name: function-patch-and-transform
      input:
        apiVersion: pt.fn.crossplane.io/v1beta1
        kind: Resources
        resources:
          - name: cloudsql-instance
            base:
              apiVersion: sql.gcp.upbound.io/v1beta1
              kind: DatabaseInstance
              spec:
                forProvider:
                  region: us-central1
                  databaseVersion: POSTGRES_16
                  settings:
                    - tier: db-f1-micro
                      diskSize: 20
                      diskType: PD_SSD
                      diskAutoresize: true
                      backupConfiguration:
                        - enabled: true
                          startTime: "04:00"
                          backupRetentionSettings:
                            - retainedBackups: 7
                      maintenanceWindow:
                        - day: 1
                          hour: 4
                      ipConfiguration:
                        - ipv4Enabled: false
                          privateNetworkSelector:
                            matchLabels:
                              crossplane.io/claim-namespace: default
                writeConnectionSecretToRef:
                  namespace: crossplane-system
            patches:
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.region
                toFieldPath: spec.forProvider.region
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.storageGB
                toFieldPath: spec.forProvider.settings[0].diskSize
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.tier
                toFieldPath: spec.forProvider.settings[0].tier
                transforms:
                  - type: map
                    map:
                      small: db-f1-micro
                      medium: db-n1-standard-2
                      large: db-n1-standard-4
                      xlarge: db-n1-standard-8
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.version
                toFieldPath: spec.forProvider.databaseVersion
                transforms:
                  - type: string
                    string:
                      type: Format
                      fmt: "POSTGRES_%s"
              - type: FromCompositeFieldPath
                fromFieldPath: metadata.uid
                toFieldPath: spec.writeConnectionSecretToRef.name
                transforms:
                  - type: string
                    string:
                      type: Format
                      fmt: "%s-postgresql"
            connectionDetails:
              - name: username
                value: postgres
              - name: endpoint
                fromConnectionSecretKey: privateIPAddress
              - name: port
                value: "5432"
```

## Using Composite Resource Selectors

When multiple Compositions serve the same XRD, use labels and selectors to route claims:

```yaml
# composition-selector.yaml — selects based on environment
apiVersion: apiextensions.crossplane.io/v1
kind: CompositionRevisionPolicy
metadata:
  name: postgresql-aws-production
spec:
  compositionRef:
    name: xpostgresqlinstances.aws.platform.example.com
  automatic: true
```

Developer claim selecting cloud provider:

```yaml
# claim-postgresql.yaml
apiVersion: platform.example.com/v1alpha1
kind: PostgreSQLInstance
metadata:
  name: orders-db
  namespace: orders-team
spec:
  compositionSelector:
    matchLabels:
      provider: aws
      service: postgresql
  parameters:
    storageGB: 100
    version: "16"
    tier: medium
    region: us-east-1
    multiAZ: true
    backupRetentionDays: 14
  writeConnectionSecretToRef:
    name: orders-db-conn
```

## Network Infrastructure Compositions

### AWS VPC Composition

```yaml
# composition-aws-vpc.yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: xvpcs.aws.platform.example.com
  labels:
    provider: aws
spec:
  compositeTypeRef:
    apiVersion: platform.example.com/v1alpha1
    kind: XVPC
  mode: Pipeline
  pipeline:
    - step: patch-and-transform
      functionRef:
        name: function-patch-and-transform
      input:
        apiVersion: pt.fn.crossplane.io/v1beta1
        kind: Resources
        resources:
          - name: vpc
            base:
              apiVersion: ec2.aws.upbound.io/v1beta1
              kind: VPC
              spec:
                forProvider:
                  region: us-east-1
                  cidrBlock: 10.0.0.0/16
                  enableDnsHostnames: true
                  enableDnsSupport: true
                  tags:
                    ManagedBy: crossplane
            patches:
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.region
                toFieldPath: spec.forProvider.region
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.cidrBlock
                toFieldPath: spec.forProvider.cidrBlock
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.enableDnsHostnames
                toFieldPath: spec.forProvider.enableDnsHostnames
              - type: ToCompositeFieldPath
                fromFieldPath: status.atProvider.id
                toFieldPath: status.vpcId

          - name: internet-gateway
            base:
              apiVersion: ec2.aws.upbound.io/v1beta1
              kind: InternetGateway
              spec:
                forProvider:
                  region: us-east-1
                  vpcIdSelector:
                    matchControllerRef: true
            patches:
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.region
                toFieldPath: spec.forProvider.region

          - name: public-subnet-1
            base:
              apiVersion: ec2.aws.upbound.io/v1beta1
              kind: Subnet
              metadata:
                labels:
                  access: public
                  zone: "1"
              spec:
                forProvider:
                  region: us-east-1
                  availabilityZone: us-east-1a
                  cidrBlock: 10.0.1.0/24
                  mapPublicIpOnLaunch: true
                  vpcIdSelector:
                    matchControllerRef: true
            patches:
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.region
                toFieldPath: spec.forProvider.region

          - name: private-subnet-1
            base:
              apiVersion: ec2.aws.upbound.io/v1beta1
              kind: Subnet
              metadata:
                labels:
                  access: private
                  zone: "1"
              spec:
                forProvider:
                  region: us-east-1
                  availabilityZone: us-east-1a
                  cidrBlock: 10.0.10.0/24
                  mapPublicIpOnLaunch: false
                  vpcIdSelector:
                    matchControllerRef: true
            patches:
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.region
                toFieldPath: spec.forProvider.region
```

## Composition Functions

Composition Functions enable complex transformation logic using Go, Python, or other languages.

### Installing the Patch and Transform Function

```bash
kubectl apply -f - <<'EOF'
apiVersion: pkg.crossplane.io/v1beta1
kind: Function
metadata:
  name: function-patch-and-transform
spec:
  package: xpkg.upbound.io/crossplane-contrib/function-patch-and-transform:v0.5.0
EOF
```

### Custom Go Composition Function

```go
// main.go — custom composition function
package main

import (
    "context"
    "encoding/json"
    "fmt"

    "github.com/crossplane/crossplane-runtime/pkg/errors"
    fnv1beta1 "github.com/crossplane/function-sdk-go/proto/v1beta1"
    "github.com/crossplane/function-sdk-go/request"
    "github.com/crossplane/function-sdk-go/resource"
    "github.com/crossplane/function-sdk-go/response"
    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
)

type Function struct {
    fnv1beta1.UnimplementedFunctionRunnerServiceServer
}

func (f *Function) RunFunction(ctx context.Context, req *fnv1beta1.RunFunctionRequest) (*fnv1beta1.RunFunctionResponse, error) {
    rsp := response.To(req, response.DefaultTTL)

    oxr, err := request.GetObservedCompositeResource(req)
    if err != nil {
        response.Fatal(rsp, errors.Wrapf(err, "cannot get observed XR"))
        return rsp, nil
    }

    tier, err := oxr.Resource.GetString("spec.parameters.tier")
    if err != nil {
        response.Fatal(rsp, errors.Wrapf(err, "cannot get tier"))
        return rsp, nil
    }

    // Compute instance class based on tier and environment
    env, _ := oxr.Resource.GetString("spec.parameters.environment")
    instanceClass := computeInstanceClass(tier, env)

    desired, err := request.GetDesiredComposedResources(req)
    if err != nil {
        response.Fatal(rsp, errors.Wrapf(err, "cannot get desired resources"))
        return rsp, nil
    }

    // Update the RDS instance class
    rds, ok := desired["rds-instance"]
    if ok {
        if err := rds.Resource.SetString("spec.forProvider.instanceClass", instanceClass); err != nil {
            response.Fatal(rsp, errors.Wrapf(err, "cannot set instance class"))
            return rsp, nil
        }
        desired["rds-instance"] = rds
    }

    if err := response.SetDesiredComposedResources(rsp, desired); err != nil {
        response.Fatal(rsp, errors.Wrapf(err, "cannot set desired resources"))
        return rsp, nil
    }

    response.Normal(rsp, fmt.Sprintf("configured instance class %s for tier %s", instanceClass, tier))
    return rsp, nil
}

func computeInstanceClass(tier, env string) string {
    matrix := map[string]map[string]string{
        "production": {
            "small":  "db.t3.medium",
            "medium": "db.r6g.large",
            "large":  "db.r6g.xlarge",
            "xlarge": "db.r6g.2xlarge",
        },
        "staging": {
            "small":  "db.t3.micro",
            "medium": "db.t3.medium",
            "large":  "db.r6g.large",
            "xlarge": "db.r6g.xlarge",
        },
        "development": {
            "small":  "db.t3.micro",
            "medium": "db.t3.micro",
            "large":  "db.t3.small",
            "xlarge": "db.t3.medium",
        },
    }

    if envMatrix, ok := matrix[env]; ok {
        if class, ok := envMatrix[tier]; ok {
            return class
        }
    }
    return "db.t3.micro"
}
```

## Managing Composite Resource Revisions

Crossplane supports revision-based upgrades for Compositions:

```bash
# List composition revisions
kubectl get compositionrevisions

# Check which revision is active
kubectl get composition xpostgresqlinstances.aws.platform.example.com \
  -o jsonpath='{.spec.compositionRevisionRef}'

# Pin a claim to a specific revision
kubectl patch postgresqlinstance orders-db \
  --namespace orders-team \
  --type merge \
  -p '{"spec":{"compositionRevisionRef":{"name":"xpostgresqlinstances.aws.platform.example.com-abc123"}}}'
```

## Observing Managed Resource Status

```bash
# Check composite resource status
kubectl describe xpostgresqlinstance orders-db-xhf9k

# Check individual managed resources
kubectl get managed -l crossplane.io/composite=orders-db-xhf9k

# Get all managed resources for a claim
kubectl get managed \
  -l "crossplane.io/claim-name=orders-db,crossplane.io/claim-namespace=orders-team"

# Watch provisioning progress
kubectl get managed -w
```

### Understanding Resource Conditions

```bash
kubectl get postgresqlinstance orders-db -n orders-team -o yaml | \
  yq '.status.conditions[]'

# Expected output during provisioning:
# type: Ready
# status: "False"
# reason: Creating
# message: "RDSInstance orders-db-xhf9k-rds-instance is not yet available"

# Expected output when ready:
# type: Ready
# status: "True"
# reason: Available
# message: ""
```

## Environment Configurations

Crossplane's `EnvironmentConfig` provides environment-specific values injectable into Compositions:

```yaml
# environment-config-production.yaml
apiVersion: apiextensions.crossplane.io/v1alpha1
kind: EnvironmentConfig
metadata:
  name: production-aws-us-east-1
  labels:
    environment: production
    provider: aws
    region: us-east-1
data:
  vpcId: vpc-0a1b2c3d4e5f6g7h8
  privateSubnetIds:
    - subnet-0a1b2c3d4e5f6g7h8
    - subnet-1b2c3d4e5f6g7h8i9
  kmsKeyId: arn:aws:kms:us-east-1:123456789012:key/mrk-abc123
  dbParameterGroup: default.postgres16
  dbOptionGroup: default:postgres-16
```

Reference in Composition:

```yaml
# In composition pipeline step
- step: environment-configs
  functionRef:
    name: function-environment-configs
  input:
    apiVersion: environmentconfigs.fn.crossplane.io/v1beta1
    kind: Input
    spec:
      environmentConfigs:
        - type: Selector
          selector:
            matchLabels:
              - key: environment
                type: FromCompositeFieldPath
                valueFromFieldPath: spec.parameters.environment
              - key: provider
                type: Value
                value: aws
```

## RBAC and Multi-Tenancy

### Platform Team Setup

```yaml
# rbac-platform-team.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: crossplane-platform-admin
rules:
  - apiGroups:
      - apiextensions.crossplane.io
      - pkg.crossplane.io
    resources:
      - compositeresourcedefinitions
      - compositions
      - providers
      - configurations
    verbs:
      - '*'
  - apiGroups:
      - platform.example.com
    resources:
      - '*'
    verbs:
      - '*'
```

### Developer Namespace RBAC

```yaml
# rbac-developer.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: crossplane-developer
  namespace: orders-team
rules:
  - apiGroups:
      - platform.example.com
    resources:
      - postgresqlinstances
      - vpcs
    verbs:
      - get
      - list
      - watch
      - create
      - update
      - patch
      - delete
  - apiGroups:
      - ""
    resources:
      - secrets
    resourceNames:
      - orders-db-conn
    verbs:
      - get
```

## Monitoring Crossplane with Prometheus

```yaml
# servicemonitor-crossplane.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: crossplane
  namespace: crossplane-system
spec:
  selector:
    matchLabels:
      app: crossplane
  endpoints:
    - port: metrics
      interval: 30s
      path: /metrics
```

Key metrics to monitor:

```promql
# Managed resource sync errors
increase(crossplane_resource_exists{kind="RDSInstance"}[5m])

# Time to provision resources
histogram_quantile(0.95,
  rate(crossplane_managed_resource_first_time_to_readiness_seconds_bucket[1h])
)

# Provider health
crossplane_provider_installed == 0

# Composition errors
increase(crossplane_composition_error_count[5m]) > 0
```

## Troubleshooting Common Issues

### Managed Resource Stuck in Creating

```bash
# Check provider controller logs
kubectl logs -n crossplane-system \
  -l pkg.crossplane.io/revision=provider-aws-rds-abc123 \
  --tail=100

# Check managed resource events
kubectl describe rdsinstance orders-db-xhf9k-rds-instance

# Common causes:
# 1. Missing IAM permissions — check the provider role
# 2. VPC/subnet not found — verify selector labels
# 3. Secret missing — check passwordSecretRef
```

### Composition Not Selecting Resources

```bash
# Verify composition selector matches
kubectl get composition -l "provider=aws,service=postgresql"

# Check XR composition ref
kubectl get xpostgresqlinstance orders-db-xhf9k \
  -o jsonpath='{.spec.compositionRef}'

# Force re-reconciliation
kubectl annotate xpostgresqlinstance orders-db-xhf9k \
  crossplane.io/paused=false --overwrite
```

### Connection Secret Not Propagating

```bash
# Check composite resource connection secret
kubectl get secret -n crossplane-system orders-db-xhf9k-postgresql

# Verify claim's secret reference
kubectl get postgresqlinstance orders-db -n orders-team \
  -o jsonpath='{.spec.writeConnectionSecretToRef}'

# Check secret exists in claim namespace
kubectl get secret orders-db-conn -n orders-team
```

## Backup and Migration Patterns

### Exporting Managed Resources

```bash
# Export all managed resources for backup
kubectl get managed -o yaml > managed-resources-backup.yaml

# Export specific provider's resources
kubectl get managed \
  -l "crossplane.io/provider=provider-aws-rds" \
  -o yaml > rds-backup.yaml
```

### Cross-Cluster Migration

```bash
# On source cluster: annotate resources to prevent deletion
kubectl annotate managed \
  -l "crossplane.io/claim-name=orders-db" \
  crossplane.io/paused=true --all

# Export claim
kubectl get postgresqlinstance orders-db -n orders-team -o yaml \
  > orders-db-claim.yaml

# On target cluster: apply claim (will import existing resource if ID matches)
kubectl apply -f orders-db-claim.yaml

# Verify adoption
kubectl get postgresqlinstance orders-db -n orders-team
```

## Summary

Crossplane provides a powerful mechanism for platform teams to build self-service infrastructure APIs on top of Kubernetes. The key principles to carry forward:

- XRDs define the developer-facing API surface with strong schema validation
- Compositions encapsulate cloud-specific complexity and organizational policy
- Claims give developers namespace-scoped access without cloud credentials
- Composition Functions enable complex transformation logic beyond simple patches
- EnvironmentConfigs inject environment-specific values cleanly
- The managed resource model provides full Kubernetes-native reconciliation for cloud infrastructure

The investment in Composition authoring pays dividends as the platform scales: developers get consistent, policy-compliant infrastructure through familiar `kubectl` workflows, while platform teams retain full control over what cloud resources can be provisioned and how.
