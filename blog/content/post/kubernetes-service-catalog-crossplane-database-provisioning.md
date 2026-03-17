---
title: "Kubernetes Service Catalog and Crossplane: Database Provisioning and Cloud Resource Composition"
date: 2030-03-06T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Crossplane", "GitOps", "AWS", "RDS", "Infrastructure as Code", "Platform Engineering"]
categories: ["Kubernetes", "Cloud Infrastructure"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to Crossplane compositions for on-demand cloud resources, composite resource definitions, managed resources for RDS and Cloud SQL, and GitOps-driven infrastructure provisioning."
more_link: "yes"
url: "/kubernetes-service-catalog-crossplane-database-provisioning/"
---

Crossplane transforms Kubernetes into a universal control plane for cloud infrastructure, allowing platform teams to expose self-service database and resource provisioning through Kubernetes-native APIs. Rather than maintaining separate Terraform modules or CloudFormation templates, Crossplane compositions let you define opinionated infrastructure abstractions that developers claim with simple YAML — and which GitOps pipelines manage like any other Kubernetes resource. This guide covers the architecture, composition authoring, and production operational patterns for enterprise database provisioning.

<!--more-->

## Crossplane Architecture Overview

Crossplane extends Kubernetes with three key concepts:

- **Managed Resources (MRs)**: Low-level 1:1 representations of cloud provider APIs (e.g., `RDSInstance`, `CloudSQLInstance`)
- **Composite Resources (XRs)**: Higher-level abstractions that bundle multiple managed resources
- **Composite Resource Definitions (XRDs)**: CRDs that define the schema for composite resources

The relationship between these layers allows platform teams to hide infrastructure complexity behind opinionated APIs while still retaining full control over the underlying cloud resources.

```
Developer Claim (PostgreSQLInstance)
        |
        v
Composite Resource (XPostgreSQLInstance)
        |
        +---> MR: RDSInstance (AWS)
        +---> MR: DBSubnetGroup
        +---> MR: SecurityGroup
        +---> MR: IAMRole (for monitoring)
        +---> MR: SecretsManagerSecret
```

### Installation

```bash
# Install Crossplane via Helm
helm repo add crossplane-stable https://charts.crossplane.io/stable
helm repo update

helm install crossplane \
    crossplane-stable/crossplane \
    --namespace crossplane-system \
    --create-namespace \
    --version 1.15.0 \
    --set args='{"--enable-composition-functions","--enable-composition-webhook-schema-validation"}' \
    --wait

# Verify installation
kubectl get pods -n crossplane-system
# NAME                                        READY   STATUS    RESTARTS
# crossplane-xxxxx                            1/1     Running   0
# crossplane-rbac-manager-xxxxx              1/1     Running   0

# Install the AWS provider
cat <<EOF | kubectl apply -f -
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws-rds
spec:
  package: xpkg.upbound.io/upbound/provider-aws-rds:v1.2.0
  packagePullPolicy: IfNotPresent
  revisionActivationPolicy: Automatic
  revisionHistoryLimit: 3
EOF

# Wait for provider to become healthy
kubectl wait provider/provider-aws-rds \
    --for=condition=Healthy \
    --timeout=300s
```

### Provider Configuration with IRSA

For AWS, use IRSA (IAM Roles for Service Accounts) rather than static credentials:

```yaml
# ProviderConfig using IRSA
apiVersion: aws.upbound.io/v1beta1
kind: ProviderConfig
metadata:
  name: aws-provider-config
spec:
  credentials:
    source: IRSA
  assumeRoleChain:
    - roleARN: "arn:aws:iam::123456789012:role/CrossplaneProviderRole"
---
# IAM trust policy for the Crossplane service account
# {
#   "Version": "2012-10-17",
#   "Statement": [
#     {
#       "Effect": "Allow",
#       "Principal": {
#         "Federated": "arn:aws:iam::123456789012:oidc-provider/oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B716D3041E"
#       },
#       "Action": "sts:AssumeRoleWithWebIdentity",
#       "Condition": {
#         "StringEquals": {
#           "oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B716D3041E:sub":
#             "system:serviceaccount:crossplane-system:provider-aws-rds-*"
#         }
#       }
#     }
#   ]
# }
```

## Composite Resource Definitions (XRDs)

XRDs define the schema that developers use when claiming infrastructure. A well-designed XRD hides operational complexity while exposing only the parameters that developers legitimately need to vary.

### Designing the XRD for PostgreSQL

```yaml
apiVersion: apiextensions.crossplane.io/v1
kind: CompositeResourceDefinition
metadata:
  name: xpostgresqlinstances.database.platform.example.com
spec:
  group: database.platform.example.com
  names:
    kind: XPostgreSQLInstance
    plural: xpostgresqlinstances
  claimNames:
    kind: PostgreSQLInstance
    plural: postgresqlinstances

  # Versions allow schema evolution
  versions:
    - name: v1alpha1
      served: true
      referenceable: true

      # The schema defines what developers can configure
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              properties:
                parameters:
                  type: object
                  description: "Configuration parameters for the PostgreSQL instance"
                  properties:
                    # Tiered sizing hides instance type complexity
                    size:
                      type: string
                      enum: ["small", "medium", "large", "xlarge"]
                      description: "Size tier for the database instance"
                      default: "small"

                    storageGB:
                      type: integer
                      minimum: 20
                      maximum: 16384
                      description: "Storage size in GB"
                      default: 20

                    postgresVersion:
                      type: string
                      enum: ["14", "15", "16"]
                      description: "PostgreSQL major version"
                      default: "16"

                    region:
                      type: string
                      description: "AWS region for the RDS instance"
                      default: "us-east-1"

                    multiAZ:
                      type: boolean
                      description: "Enable Multi-AZ for high availability"
                      default: false

                    backupRetentionDays:
                      type: integer
                      minimum: 1
                      maximum: 35
                      default: 7

                    maintenanceWindow:
                      type: string
                      description: "Weekly maintenance window"
                      default: "sun:05:00-sun:06:00"

                    allowedCIDRs:
                      type: array
                      items:
                        type: string
                      description: "CIDR blocks allowed to connect"
                      default: []

                    deletionProtection:
                      type: boolean
                      default: true

                  required:
                    - size
                    - postgresVersion

              required:
                - parameters

            # Status fields populated by compositions
            status:
              type: object
              properties:
                atProvider:
                  type: object
                  properties:
                    endpoint:
                      type: string
                      description: "Database connection endpoint"
                    port:
                      type: integer
                    readReplicaEndpoints:
                      type: array
                      items:
                        type: string
                    status:
                      type: string
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

  # Connection details written to a secret
  connectionSecretKeys:
    - username
    - password
    - endpoint
    - port
    - dbname
```

## Composition: Implementing the AWS RDS Backend

The Composition is where the actual infrastructure resources are declared and how claim parameters map to those resources.

```yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: xpostgresqlinstances-aws
  labels:
    provider: aws
    engine: postgresql
spec:
  compositeTypeRef:
    apiVersion: database.platform.example.com/v1alpha1
    kind: XPostgreSQLInstance

  # Where to write connection details
  writeConnectionSecretsToNamespace: crossplane-system

  # Composition mode: Resources or Pipeline (for functions)
  mode: Pipeline

  pipeline:
    # Step 1: Transform parameters
    - step: transform-parameters
      functionRef:
        name: function-go-templating
      input:
        apiVersion: gotemplating.fn.crossplane.io/v1beta1
        kind: GoTemplate
        source: Inline
        inline:
          template: |
            {{- $params := .observed.composite.resource.spec.parameters }}
            {{- $instanceClassMap := dict
                "small"  "db.t3.micro"
                "medium" "db.t3.medium"
                "large"  "db.r6g.large"
                "xlarge" "db.r6g.xlarge"
            }}
            {{- $instanceClass := get $instanceClassMap $params.size | default "db.t3.micro" }}
            ---
            apiVersion: rds.aws.upbound.io/v1beta1
            kind: Instance
            metadata:
              annotations:
                gotemplating.fn.crossplane.io/composition-resource-name: rds-instance
                crossplane.io/external-name: {{ .observed.composite.resource.metadata.name }}
            spec:
              forProvider:
                region: {{ $params.region | default "us-east-1" }}
                instanceClass: {{ $instanceClass }}
                engine: postgres
                engineVersion: "{{ $params.postgresVersion }}.0"
                allocatedStorage: {{ $params.storageGB | default 20 }}
                storageType: gp3
                storageEncrypted: true
                multiAz: {{ $params.multiAZ | default false }}
                autoMinorVersionUpgrade: true
                backupRetentionPeriod: {{ $params.backupRetentionDays | default 7 }}
                maintenanceWindow: {{ $params.maintenanceWindow | default "sun:05:00-sun:06:00" }}
                deletionProtection: {{ $params.deletionProtection | default true }}
                skipFinalSnapshot: false
                finalSnapshotIdentifier: {{ .observed.composite.resource.metadata.name }}-final
                dbSubnetGroupNameSelector:
                  matchControllerRef: true
                vpcSecurityGroupIdSelector:
                  matchControllerRef: true
                username: dbadmin
                passwordSecretRef:
                  name: {{ .observed.composite.resource.metadata.name }}-master-password
                  namespace: crossplane-system
                  key: password
                parameterGroupNameSelector:
                  matchControllerRef: true
                monitoringInterval: 60
                monitoringRoleArnSelector:
                  matchControllerRef: true
                enabledCloudwatchLogsExports:
                  - postgresql
                  - upgrade
                tags:
                  managed-by: crossplane
                  environment: {{ index .observed.composite.resource.metadata.labels "environment" | default "unknown" }}
                  team: {{ index .observed.composite.resource.metadata.labels "team" | default "unknown" }}
                  cost-center: {{ index .observed.composite.resource.metadata.labels "cost-center" | default "unknown" }}
              writeConnectionSecretToRef:
                name: {{ .observed.composite.resource.metadata.name }}-rds-conn
                namespace: crossplane-system

    # Step 2: Create supporting resources
    - step: create-supporting-resources
      functionRef:
        name: function-patch-and-transform
      input:
        apiVersion: pt.fn.crossplane.io/v1beta1
        kind: Resources
        resources:
          # DB Subnet Group
          - name: db-subnet-group
            base:
              apiVersion: rds.aws.upbound.io/v1beta1
              kind: SubnetGroup
              spec:
                forProvider:
                  description: "Subnet group for Crossplane-managed PostgreSQL"
                  subnetIdSelector:
                    matchLabels:
                      access: private
                  tags:
                    managed-by: crossplane
            patches:
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.region
                toFieldPath: spec.forProvider.region

          # Security Group
          - name: security-group
            base:
              apiVersion: ec2.aws.upbound.io/v1beta1
              kind: SecurityGroup
              spec:
                forProvider:
                  description: "Security group for Crossplane-managed PostgreSQL"
                  vpcIdSelector:
                    matchLabels:
                      network: main
            patches:
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.region
                toFieldPath: spec.forProvider.region
              - type: FromCompositeFieldPath
                fromFieldPath: metadata.name
                toFieldPath: spec.forProvider.tags.Name
                transforms:
                  - type: string
                    string:
                      type: Format
                      fmt: "%s-postgres-sg"

          # Security Group Ingress Rule
          - name: sg-ingress-postgres
            base:
              apiVersion: ec2.aws.upbound.io/v1beta1
              kind: SecurityGroupRule
              spec:
                forProvider:
                  type: ingress
                  fromPort: 5432
                  toPort: 5432
                  protocol: tcp
                  securityGroupIdSelector:
                    matchControllerRef: true
                  cidrBlocks:
                    - "10.0.0.0/8"
            patches:
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.region
                toFieldPath: spec.forProvider.region

          # RDS Parameter Group
          - name: parameter-group
            base:
              apiVersion: rds.aws.upbound.io/v1beta1
              kind: ParameterGroup
              spec:
                forProvider:
                  description: "Parameter group for Crossplane-managed PostgreSQL"
                  parameter:
                    - name: "log_connections"
                      value: "1"
                    - name: "log_disconnections"
                      value: "1"
                    - name: "log_duration"
                      value: "1"
                    - name: "log_lock_waits"
                      value: "1"
                    - name: "log_min_duration_statement"
                      value: "1000"
                    - name: "shared_preload_libraries"
                      value: "pg_stat_statements"
                    - name: "pg_stat_statements.track"
                      value: "ALL"
            patches:
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.region
                toFieldPath: spec.forProvider.region
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.postgresVersion
                toFieldPath: spec.forProvider.family
                transforms:
                  - type: string
                    string:
                      type: Format
                      fmt: "postgres%s"

          # IAM Role for Enhanced Monitoring
          - name: monitoring-role
            base:
              apiVersion: iam.aws.upbound.io/v1beta1
              kind: Role
              spec:
                forProvider:
                  assumeRolePolicy: |
                    {
                      "Version": "2012-10-17",
                      "Statement": [
                        {
                          "Effect": "Allow",
                          "Principal": {
                            "Service": "monitoring.rds.amazonaws.com"
                          },
                          "Action": "sts:AssumeRole"
                        }
                      ]
                    }
            patches:
              - type: FromCompositeFieldPath
                fromFieldPath: metadata.name
                toFieldPath: metadata.name
                transforms:
                  - type: string
                    string:
                      type: Format
                      fmt: "%s-rds-monitoring"

          # RolePolicyAttachment for monitoring
          - name: monitoring-role-attachment
            base:
              apiVersion: iam.aws.upbound.io/v1beta1
              kind: RolePolicyAttachment
              spec:
                forProvider:
                  policyArn: "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
                  roleSelector:
                    matchControllerRef: true

    # Step 3: Generate master password and write status
    - step: auto-ready
      functionRef:
        name: function-auto-ready

  # Connection details to surface from the RDS instance
  writeConnectionSecretsToNamespace: crossplane-system
```

## Composition Functions for Advanced Logic

Crossplane v1.14+ supports Composition Functions (written in Go or as containers) for logic that cannot be expressed in patch-and-transform.

### Writing a Custom Composition Function

```go
// main.go - Custom Composition Function for PostgreSQL provisioning
package main

import (
    "context"
    "crypto/rand"
    "encoding/base64"
    "math/big"

    "github.com/crossplane/crossplane-runtime/pkg/errors"
    fnv1beta1 "github.com/crossplane/function-sdk-go/proto/v1beta1"
    "github.com/crossplane/function-sdk-go/request"
    "github.com/crossplane/function-sdk-go/resource"
    "github.com/crossplane/function-sdk-go/response"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
)

type Function struct {
    fnv1beta1.UnimplementedFunctionRunnerServiceServer
}

func (f *Function) RunFunction(
    ctx context.Context,
    req *fnv1beta1.RunFunctionRequest,
) (*fnv1beta1.RunFunctionResponse, error) {
    rsp := response.To(req, response.DefaultTTL)

    // Get the composite resource
    xr, err := request.GetObservedCompositeResource(req)
    if err != nil {
        response.Fatal(rsp, errors.Wrap(err, "cannot get observed composite resource"))
        return rsp, nil
    }

    // Generate a random password if this is a new instance
    desired, err := request.GetDesiredComposedResources(req)
    if err != nil {
        response.Fatal(rsp, errors.Wrap(err, "cannot get desired composed resources"))
        return rsp, nil
    }

    // Check if master password secret already exists in observed state
    observed, err := request.GetObservedComposedResources(req)
    if err != nil {
        response.Fatal(rsp, errors.Wrap(err, "cannot get observed composed resources"))
        return rsp, nil
    }

    name := xr.Resource.GetName()
    secretName := name + "-master-password"

    if _, exists := observed[resource.Name(secretName)]; !exists {
        // Generate a secure random password
        password, genErr := generatePassword(32)
        if genErr != nil {
            response.Fatal(rsp, errors.Wrap(genErr, "cannot generate password"))
            return rsp, nil
        }

        // Create the secret as a composed resource
        secret := &resource.DesiredComposed{Resource: composed.New()}
        secret.Resource.SetAPIVersion("v1")
        secret.Resource.SetKind("Secret")
        secret.Resource.SetName(secretName)
        secret.Resource.SetNamespace("crossplane-system")

        if err := secret.Resource.SetStringObject("data", map[string]interface{}{
            "password": base64.StdEncoding.EncodeToString([]byte(password)),
        }); err != nil {
            response.Fatal(rsp, errors.Wrap(err, "cannot set secret data"))
            return rsp, nil
        }

        desired[resource.Name(secretName)] = secret
    }

    if err := response.SetDesiredComposedResources(rsp, desired); err != nil {
        return rsp, status.Errorf(codes.Internal, "cannot set desired composed resources: %s", err)
    }

    response.Normalf(rsp, "Successfully processed PostgreSQL instance %s", name)
    return rsp, nil
}

func generatePassword(length int) (string, error) {
    const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*"
    password := make([]byte, length)
    for i := range password {
        n, err := rand.Int(rand.Reader, big.NewInt(int64(len(charset))))
        if err != nil {
            return "", err
        }
        password[i] = charset[n.Int64()]
    }
    return string(password), nil
}
```

### Packaging and Deploying the Function

```bash
# Build the function container
docker build -t my-registry/function-postgres-password:latest .
docker push my-registry/function-postgres-password:latest

# Create the Function object in Kubernetes
cat <<EOF | kubectl apply -f -
apiVersion: pkg.crossplane.io/v1beta1
kind: Function
metadata:
  name: function-postgres-password
spec:
  package: my-registry/function-postgres-password:latest
  packagePullPolicy: Always
EOF

# Reference in composition pipeline
# - step: generate-password
#   functionRef:
#     name: function-postgres-password
```

## Developer Experience: Claiming Database Resources

With XRDs and Compositions in place, developers create Claims — namespace-scoped resources that trigger composite resource creation.

```yaml
# Developer creates this in their namespace
# kubectl apply -f - -n my-application
apiVersion: database.platform.example.com/v1alpha1
kind: PostgreSQLInstance
metadata:
  name: my-app-db
  namespace: my-application
  labels:
    environment: production
    team: payments
    cost-center: CC-4412
spec:
  parameters:
    size: medium
    storageGB: 100
    postgresVersion: "16"
    region: us-east-1
    multiAZ: true
    backupRetentionDays: 14
    deletionProtection: true
  # Where to write the connection secret
  writeConnectionSecretToRef:
    name: my-app-db-credentials
```

```bash
# Monitor the provisioning
kubectl get postgresqlinstance my-app-db -n my-application -w
# NAME         READY   SYNCED   CONNECTION-SECRET          AGE
# my-app-db    False   True     my-app-db-credentials      30s
# my-app-db    True    True     my-app-db-credentials      8m

# Check the connection secret
kubectl get secret my-app-db-credentials -n my-application \
    -o jsonpath='{.data.endpoint}' | base64 -d
# my-app-db.xxxxxx.us-east-1.rds.amazonaws.com

# See all managed resources created
kubectl get managed | grep my-app-db
# NAME                                         READY   SYNCED   EXTERNAL-NAME
# instance.rds.aws.upbound.io/my-app-db        True    True     my-app-db
# subnetgroup.rds.../my-app-db-xxxxx           True    True     my-app-db-xxxxx
# securitygroup.ec2.../my-app-db-xxxxx         True    True     sg-0123456789
# parametergroup.rds.../my-app-db-xxxxx        True    True     my-app-db-xxxxx

# Describe composite resource for full status
kubectl describe xpostgresqlinstance -l crossplane.io/claim-name=my-app-db
```

## GitOps-Driven Infrastructure Provisioning with ArgoCD

Crossplane claims work naturally with GitOps workflows because they are just Kubernetes manifests.

```yaml
# ArgoCD Application for environment database claims
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: production-databases
  namespace: argocd
spec:
  project: infrastructure
  source:
    repoURL: https://git.example.com/platform/infrastructure.git
    targetRevision: HEAD
    path: environments/production/databases
  destination:
    server: https://kubernetes.default.svc
    namespace: databases-production

  syncPolicy:
    automated:
      prune: false   # Never auto-delete databases
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
      - PruneLast=true
    retry:
      limit: 5
      backoff:
        duration: 30s
        factor: 2
        maxDuration: 5m
```

```
# Repository structure for GitOps database management
environments/
├── production/
│   └── databases/
│       ├── payments-db.yaml       # PostgreSQLInstance claim
│       ├── analytics-db.yaml
│       └── user-service-db.yaml
├── staging/
│   └── databases/
│       ├── payments-db.yaml
│       └── analytics-db.yaml
└── development/
    └── databases/
        └── all-services-db.yaml  # Shared small dev DB
```

### Environment-Specific Compositions

Use Kustomize overlays to apply environment-specific defaults:

```yaml
# environments/production/databases/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - payments-db.yaml
  - analytics-db.yaml
patches:
  - patch: |
      - op: replace
        path: /spec/parameters/multiAZ
        value: true
      - op: replace
        path: /spec/parameters/backupRetentionDays
        value: 35
      - op: replace
        path: /spec/parameters/deletionProtection
        value: true
    target:
      kind: PostgreSQLInstance
```

## Google Cloud SQL Composition

Crossplane compositions are provider-agnostic. Here is a parallel GCP composition:

```yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: xpostgresqlinstances-gcp
  labels:
    provider: gcp
    engine: postgresql
spec:
  compositeTypeRef:
    apiVersion: database.platform.example.com/v1alpha1
    kind: XPostgreSQLInstance

  mode: Resources
  resources:
    - name: cloudsql-instance
      base:
        apiVersion: sql.gcp.upbound.io/v1beta1
        kind: DatabaseInstance
        spec:
          forProvider:
            databaseVersion: POSTGRES_16
            deletionProtection: true
            settings:
              - tier: db-custom-2-7680
                availabilityType: REGIONAL
                diskType: PD_SSD
                diskAutoresize: true
                backupConfiguration:
                  - enabled: true
                    pointInTimeRecoveryEnabled: true
                    transactionLogRetentionDays: 7
                    backupRetentionSettings:
                      - retainedBackups: 7
                        retentionUnit: COUNT
                insightsConfig:
                  - queryInsightsEnabled: true
                    queryStringLength: 1024
                    recordApplicationTags: true
                    recordClientAddress: true
                maintenanceWindow:
                  - day: 7
                    hour: 5
                    updateTrack: STABLE
                databaseFlags:
                  - name: log_min_duration_statement
                    value: "1000"
                  - name: log_connections
                    value: "on"
                  - name: log_disconnections
                    value: "on"
      patches:
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.region
          toFieldPath: spec.forProvider.region
          transforms:
            - type: map
              map:
                us-east-1: us-east1
                us-west-2: us-west2
                eu-west-1: europe-west1
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.postgresVersion
          toFieldPath: spec.forProvider.databaseVersion
          transforms:
            - type: string
              string:
                type: Format
                fmt: "POSTGRES_%s"
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.size
          toFieldPath: spec.forProvider.settings[0].tier
          transforms:
            - type: map
              map:
                small: db-custom-1-3840
                medium: db-custom-2-7680
                large: db-custom-4-15360
                xlarge: db-custom-8-30720
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.multiAZ
          toFieldPath: spec.forProvider.settings[0].availabilityType
          transforms:
            - type: map
              map:
                "true": REGIONAL
                "false": ZONAL
```

## Observability and Operational Management

### Monitoring Crossplane Resources

```bash
# Check overall health
kubectl get crossplane
# NAME                                   INSTALLED   HEALTHY   PACKAGE
# provider.pkg.crossplane.io/provider-aws-rds  True    True    xpkg.upbound.io/...

# Check for unhealthy managed resources
kubectl get managed -A | grep -v "True.*True"

# Watch provisioning events
kubectl get events --field-selector reason=BindCompositeToComposite -A

# Crossplane Prometheus metrics
# crossplane_managed_resource_exists
# crossplane_managed_resource_ready
# crossplane_managed_resource_synced
# crossplane_composite_resource_exists

# Alert on stuck resources
# ALERT CrossplaneResourceNotSynced
# IF crossplane_managed_resource_synced == 0
# FOR 10m
# LABELS { severity = "warning" }
```

### Validation and Policy with OPA/Gatekeeper

```yaml
# Gatekeeper constraint to enforce production DB settings
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: postgresqlproductionrequirements
spec:
  crd:
    spec:
      names:
        kind: PostgreSQLProductionRequirements
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package postgresqlproductionrequirements

        violation[{"msg": msg}] {
            input.review.object.kind == "PostgreSQLInstance"
            input.review.object.metadata.labels.environment == "production"
            not input.review.object.spec.parameters.multiAZ == true
            msg := "Production PostgreSQL instances must have multiAZ enabled"
        }

        violation[{"msg": msg}] {
            input.review.object.kind == "PostgreSQLInstance"
            input.review.object.metadata.labels.environment == "production"
            input.review.object.spec.parameters.backupRetentionDays < 14
            msg := "Production PostgreSQL instances must retain backups for at least 14 days"
        }

        violation[{"msg": msg}] {
            input.review.object.kind == "PostgreSQLInstance"
            input.review.object.metadata.labels.environment == "production"
            not input.review.object.spec.parameters.deletionProtection == true
            msg := "Production PostgreSQL instances must have deletion protection enabled"
        }
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: PostgreSQLProductionRequirements
metadata:
  name: enforce-production-postgresql-settings
spec:
  match:
    kinds:
      - apiGroups: ["database.platform.example.com"]
        kinds: ["PostgreSQLInstance"]
    namespaceSelector:
      matchLabels:
        environment: production
```

## Troubleshooting Crossplane Compositions

```bash
# Debug a stuck composite resource
kubectl describe xpostgresqlinstance my-app-db

# Look for composition events
kubectl get events --field-selector \
    involvedObject.name=my-app-db,involvedObject.kind=XPostgreSQLInstance

# Check provider pod logs for API errors
kubectl logs -n crossplane-system \
    $(kubectl get pods -n crossplane-system -l pkg.crossplane.io/revision=provider-aws-rds -o name) \
    --tail=100

# Check if managed resources have reconciliation errors
kubectl get rdsinstance my-app-db \
    -o jsonpath='{.status.conditions}' | jq .

# Force reconciliation
kubectl annotate xpostgresqlinstance my-app-db \
    crossplane.io/paused="true" --overwrite
kubectl annotate xpostgresqlinstance my-app-db \
    crossplane.io/paused- --overwrite

# View all resource references from a composite
kubectl get xpostgresqlinstance my-app-db \
    -o jsonpath='{.spec.resourceRefs}' | jq .
```

## Key Takeaways

Crossplane with well-designed compositions transforms Kubernetes into a cloud resource control plane that platform teams can version-control, GitOps-manage, and developers can consume through simple YAML claims. The critical success factors for production deployments are:

1. XRD schema design matters most — expose only what developers need to vary, hide operational complexity behind sensible defaults and tiered sizing
2. Use IRSA or Workload Identity rather than static credentials to give Crossplane's provider pods cloud permissions
3. Set `deletionProtection: true` in compositions and use Gatekeeper constraints to enforce production safety settings that cannot be overridden by developers
4. Composition Functions (pipeline mode) should be used for any logic that requires conditional resource creation, loops, or password generation that patch-and-transform cannot express
5. The GitOps pattern of having `prune: false` in ArgoCD for database namespaces prevents accidental database deletion from a bad pull request
6. Monitor `crossplane_managed_resource_synced` in Prometheus and alert on resources that fail to sync for more than 10 minutes
7. Use Kustomize overlays on top of base claims to apply environment-specific settings without duplicating the core claim definitions
