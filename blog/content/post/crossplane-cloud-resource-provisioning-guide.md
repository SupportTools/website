---
title: "Crossplane: Cloud Resource Provisioning and Infrastructure Composition on Kubernetes"
date: 2027-04-19T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Crossplane", "Infrastructure as Code", "AWS", "GitOps", "Platform Engineering"]
categories: ["Kubernetes", "Platform Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide to using Crossplane for declarative cloud infrastructure provisioning, building platform abstractions with Compositions and CompositeResources, and integrating with GitOps workflows."
more_link: "yes"
url: "/crossplane-cloud-resource-provisioning-guide/"
---

Crossplane extends Kubernetes with the ability to provision and manage cloud infrastructure resources — AWS RDS databases, GCP Cloud SQL instances, Azure Key Vaults, S3 buckets, VPCs, IAM roles, and hundreds of other resource types — using the same declarative YAML workflow used for application deployments. The result is a single control plane where developers request infrastructure through Custom Resources, platform teams define the allowed shapes of that infrastructure through Compositions, and GitOps pipelines synchronize desired state without any separate Terraform or CloudFormation tooling.

This guide covers Crossplane from installation through enterprise production patterns: provider installation and configuration, managed resources, Composite Resource Definitions (XRDs), Compositions, CompositeResourceClaims for self-service developer workflows, GitOps integration, and troubleshooting.

<!--more-->

## Section 1: Crossplane Architecture

### Control Plane Model

```
┌─────────────────────────────────────────────────────────────────┐
│  Developer                                                       │
│    kubectl apply -f database-claim.yaml                         │
│                │                                                 │
│                ▼                                                 │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  Kubernetes API Server (with Crossplane CRDs)           │    │
│  │                                                         │    │
│  │  CompositeResourceClaim (developer-facing)              │    │
│  │    ↓ fulfills                                           │    │
│  │  CompositeResource (XR) — platform-managed              │    │
│  │    ↓ composed of                                        │    │
│  │  Managed Resources (provider-specific)                  │    │
│  │    ↓ reconciled by                                      │    │
│  │  Provider Controller                                    │    │
│  └─────────────────────────────────────────────────────────┘    │
│                │                                                 │
│                ▼                                                 │
│  Cloud Provider APIs                                            │
│  (AWS / GCP / Azure / etc.)                                     │
└─────────────────────────────────────────────────────────────────┘
```

### Key Concepts

- **Provider**: A Crossplane package that contains controllers for a specific cloud. `provider-aws` manages AWS resources; `provider-gcp` manages GCP resources.
- **Managed Resource (MR)**: A Kubernetes Custom Resource that directly represents a cloud resource (e.g., `RDSInstance`, `S3Bucket`, `VPC`).
- **Composite Resource Definition (XRD)**: Defines the schema of a custom, platform-specific abstraction (e.g., `PostgreSQLInstance` that hides the complexity of an RDS instance, its subnet group, security group, and parameter group).
- **Composition**: Defines how a CompositeResource maps to one or more Managed Resources. Multiple Compositions can implement the same XRD (e.g., a `prod` Composition creates a Multi-AZ RDS instance while a `dev` Composition creates a single-AZ instance).
- **CompositeResourceClaim (XRC)**: A namespace-scoped resource that developers use to request a CompositeResource. The claim provides isolation and access control.

---

## Section 2: Installing Crossplane

### Install Crossplane via Helm

```bash
helm repo add crossplane-stable https://charts.crossplane.io/stable
helm repo update

helm upgrade --install crossplane crossplane-stable/crossplane \
  --namespace crossplane-system \
  --create-namespace \
  --version 1.17.1 \
  --set args='{--debug}' \
  --set resourcesCrossplane.requests.cpu=100m \
  --set resourcesCrossplane.requests.memory=256Mi \
  --set resourcesCrossplane.limits.cpu=500m \
  --set resourcesCrossplane.limits.memory=512Mi \
  --set resourcesRBACManager.requests.cpu=100m \
  --set resourcesRBACManager.requests.memory=128Mi \
  --wait
```

### Verify Installation

```bash
# Core pods should be Running
kubectl get pods -n crossplane-system

# Core CRDs
kubectl get crd | grep crossplane.io
# Expected:
# compositeresourcedefinitions.apiextensions.crossplane.io
# compositions.apiextensions.crossplane.io
# compositeresourceclaims.apiextensions.crossplane.io (generated per XRD)
# providers.pkg.crossplane.io
# configurations.pkg.crossplane.io

# Install the Crossplane CLI
curl -fsSLo /usr/local/bin/crossplane \
  "https://releases.crossplane.io/stable/v1.17.1/bin/linux_amd64/crossplane"
chmod +x /usr/local/bin/crossplane
crossplane --version
```

---

## Section 3: Installing and Configuring Providers

### Install the AWS Provider

```yaml
# provider-aws-s3.yaml
# Install only the S3 family provider (monorepo pattern — install only what you need)
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws-s3
spec:
  package: xpkg.upbound.io/upbound/provider-aws-s3:v1.14.0
  installationPolicy: Automatic
  revisionActivationPolicy: Automatic
```

```yaml
# provider-aws-rds.yaml
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws-rds
spec:
  package: xpkg.upbound.io/upbound/provider-aws-rds:v1.14.0
  installationPolicy: Automatic
  revisionActivationPolicy: Automatic
```

```bash
kubectl apply -f provider-aws-s3.yaml
kubectl apply -f provider-aws-rds.yaml

# Wait for providers to be installed and healthy
kubectl get providers
# NAME                 INSTALLED   HEALTHY   PACKAGE                               AGE
# provider-aws-s3      True        True      xpkg.upbound.io/upbound/...           5m
# provider-aws-rds     True        True      xpkg.upbound.io/upbound/...           5m
```

### Configure AWS Authentication (IRSA)

```yaml
# providerconfig-aws.yaml
apiVersion: aws.upbound.io/v1beta1
kind: ProviderConfig
metadata:
  name: default
spec:
  credentials:
    source: InjectedIdentity   # Use IRSA — no static credentials required
```

```bash
# Create IAM role for Crossplane with appropriate permissions
# The service account is: crossplane-system/provider-aws-*

# Get the service account name for the provider
kubectl get sa -n crossplane-system | grep provider-aws

# Annotate the service account with the IAM role ARN
kubectl annotate serviceaccount \
  -n crossplane-system \
  provider-aws-s3-PROVIDER_REVISION_HASH \
  eks.amazonaws.com/role-arn=arn:aws:iam::123456789012:role/CrossplaneAWSRole

kubectl apply -f providerconfig-aws.yaml
```

### Install the GCP Provider

```yaml
# provider-gcp-sql.yaml
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-gcp-sql
spec:
  package: xpkg.upbound.io/upbound/provider-gcp-sql:v0.46.0
  installationPolicy: Automatic
```

```yaml
# providerconfig-gcp.yaml
apiVersion: gcp.upbound.io/v1beta1
kind: ProviderConfig
metadata:
  name: default
spec:
  projectID: "my-gcp-project"
  credentials:
    source: InjectedIdentity   # GKE Workload Identity
```

---

## Section 4: Managed Resources (Direct Cloud Resource Management)

Managed Resources provide a 1-to-1 mapping to cloud resources. They are used directly for simple cases or composed by Compositions for more complex abstractions.

### AWS S3 Bucket

```yaml
# s3-bucket.yaml
apiVersion: s3.aws.upbound.io/v1beta1
kind: Bucket
metadata:
  name: company-app-assets
  annotations:
    crossplane.io/external-name: company-app-assets-prod-20270419
spec:
  forProvider:
    region: us-east-1
    objectLockEnabled: false
    tags:
      Environment: production
      Team: platform
      ManagedBy: crossplane
  providerConfigRef:
    name: default
  # Deletion policy: Delete or Orphan the cloud resource when the MR is deleted
  deletionPolicy: Delete
  # Write connection details to a Secret
  writeConnectionSecretToRef:
    name: s3-bucket-connection
    namespace: platform
```

```yaml
# s3-bucket-versioning.yaml
apiVersion: s3.aws.upbound.io/v1beta1
kind: BucketVersioning
metadata:
  name: company-app-assets-versioning
spec:
  forProvider:
    region: us-east-1
    bucketRef:
      name: company-app-assets
    versioningConfiguration:
      - status: Enabled
  providerConfigRef:
    name: default
```

```yaml
# s3-bucket-encryption.yaml
apiVersion: s3.aws.upbound.io/v1beta1
kind: BucketServerSideEncryptionConfiguration
metadata:
  name: company-app-assets-sse
spec:
  forProvider:
    region: us-east-1
    bucketRef:
      name: company-app-assets
    rule:
      - applyServerSideEncryptionByDefault:
          - sseAlgorithm: aws:kms
            kmsMasterKeyId: arn:aws:kms:us-east-1:123456789012:alias/app-assets-key
        bucketKeyEnabled: true
  providerConfigRef:
    name: default
```

### AWS RDS Instance

```yaml
# rds-subnet-group.yaml
apiVersion: rds.aws.upbound.io/v1beta1
kind: SubnetGroup
metadata:
  name: app-db-subnet-group
spec:
  forProvider:
    region: us-east-1
    description: "Subnet group for application database"
    subnetIds:
      - subnet-0abc123456789def0
      - subnet-0def123456789abc0
      - subnet-0fed123456789cba0
    tags:
      ManagedBy: crossplane
  providerConfigRef:
    name: default
---
apiVersion: rds.aws.upbound.io/v1beta1
kind: Instance
metadata:
  name: app-postgres-production
spec:
  forProvider:
    region: us-east-1
    dbSubnetGroupNameRef:
      name: app-db-subnet-group
    engine: postgres
    engineVersion: "16.3"
    instanceClass: db.t4g.large
    allocatedStorage: 100
    maxAllocatedStorage: 500
    storageType: gp3
    storageEncrypted: true
    kmsKeyId: arn:aws:kms:us-east-1:123456789012:alias/rds-key
    multiAz: true
    autoMinorVersionUpgrade: true
    deletionProtection: true
    backupRetentionPeriod: 14
    preferredBackupWindow: "03:00-04:00"
    preferredMaintenanceWindow: "sun:04:00-sun:05:00"
    publiclyAccessible: false
    skipFinalSnapshot: false
    finalSnapshotIdentifier: app-postgres-production-final
    username: dbadmin
    passwordSecretRef:
      name: rds-master-password
      namespace: platform
      key: password
    vpcSecurityGroupIds:
      - sg-0abc123456789def0
    tags:
      Environment: production
      ManagedBy: crossplane
  writeConnectionSecretToRef:
    name: rds-connection-details
    namespace: platform
  providerConfigRef:
    name: default
```

---

## Section 5: Composite Resource Definitions (XRDs)

XRDs allow platform teams to create higher-level abstractions that hide provider-specific details from developers. A developer requests a `PostgreSQLInstance`; the platform team defines what AWS/GCP/Azure resources that entails.

### Defining an XRD

```yaml
# xrd-postgresql.yaml
apiVersion: apiextensions.crossplane.io/v1
kind: CompositeResourceDefinition
metadata:
  name: xpostgresqlinstances.platform.company.io
spec:
  group: platform.company.io
  names:
    kind: XPostgreSQLInstance
    plural: xpostgresqlinstances

  # Allow claims (namespace-scoped) with this schema
  claimNames:
    kind: PostgreSQLInstance
    plural: postgresqlinstances

  # Define the schema for the composite resource
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
                    - storageGB
                    - region
                    - version
                  properties:
                    storageGB:
                      type: integer
                      minimum: 20
                      maximum: 16384
                      description: "Storage size in gigabytes"
                    region:
                      type: string
                      enum: ["us-east-1", "us-west-2", "eu-west-1"]
                      description: "AWS region to deploy into"
                    version:
                      type: string
                      enum: ["14", "15", "16"]
                      description: "PostgreSQL major version"
                    instanceSize:
                      type: string
                      enum: ["small", "medium", "large", "xlarge"]
                      default: "small"
                      description: "Instance size tier"
                    multiAZ:
                      type: boolean
                      default: false
                      description: "Enable Multi-AZ deployment"
                    databaseName:
                      type: string
                      default: "app"
                      description: "Initial database name"
            status:
              type: object
              properties:
                endpoint:
                  type: string
                  description: "Database endpoint hostname"
                port:
                  type: integer
                  description: "Database port"
                subresourceRef:
                  type: object
                  x-kubernetes-preserve-unknown-fields: true
```

```bash
kubectl apply -f xrd-postgresql.yaml

# Verify the XRD and its generated CRDs
kubectl get xrd xpostgresqlinstances.platform.company.io
kubectl get crd postgresqlinstances.platform.company.io
kubectl get crd xpostgresqlinstances.platform.company.io
```

---

## Section 6: Compositions

A Composition defines how to fulfill a CompositeResource by mapping its parameters to one or more Managed Resources. Multiple Compositions can implement the same XRD for different environments or providers.

### AWS Production Composition

```yaml
# composition-postgresql-aws-prod.yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: postgresql-aws-production
  labels:
    provider: aws
    environment: production
spec:
  # This Composition implements the XPostgreSQLInstance XRD
  compositeTypeRef:
    apiVersion: platform.company.io/v1alpha1
    kind: XPostgreSQLInstance

  # Composition mode: Pipeline (newer, Crossplane 1.14+)
  mode: Pipeline

  pipeline:
    # Step 1: Render composed resources from templates
    - step: patch-and-transform
      functionRef:
        name: function-patch-and-transform
      input:
        apiVersion: pt.fn.crossplane.io/v1beta1
        kind: Resources
        resources:
          # Managed Resource 1: RDS Instance
          - name: rds-instance
            base:
              apiVersion: rds.aws.upbound.io/v1beta1
              kind: Instance
              spec:
                forProvider:
                  engine: postgres
                  multiAz: true           # Production always multi-AZ
                  storageEncrypted: true
                  autoMinorVersionUpgrade: true
                  deletionProtection: true
                  backupRetentionPeriod: 14
                  skipFinalSnapshot: false
                  publiclyAccessible: false
                  username: dbadmin
                  dbSubnetGroupNameRef:
                    name: ""   # Patched below
                providerConfigRef:
                  name: default
                writeConnectionSecretToRef:
                  name: ""    # Patched to composite resource name
                  namespace: crossplane-system

            patches:
              # Set region from XR parameter
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.region
                toFieldPath: spec.forProvider.region

              # Set storage from XR parameter
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.storageGB
                toFieldPath: spec.forProvider.allocatedStorage

              # Map instanceSize to actual RDS instance class
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.instanceSize
                toFieldPath: spec.forProvider.instanceClass
                transforms:
                  - type: map
                    map:
                      small:  db.t4g.small
                      medium: db.t4g.large
                      large:  db.r6g.xlarge
                      xlarge: db.r6g.2xlarge

              # Map PostgreSQL version string to engine version
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.version
                toFieldPath: spec.forProvider.engineVersion
                transforms:
                  - type: map
                    map:
                      "14": "14.12"
                      "15": "15.7"
                      "16": "16.3"

              # Set multiAZ from XR parameter
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.multiAZ
                toFieldPath: spec.forProvider.multiAz

              # Name the connection secret after the composite resource
              - type: FromCompositeFieldPath
                fromFieldPath: metadata.uid
                toFieldPath: spec.writeConnectionSecretToRef.name
                transforms:
                  - type: string
                    string:
                      fmt: "rds-%s"

              # Patch the subnet group ref from composite name
              - type: FromCompositeFieldPath
                fromFieldPath: metadata.name
                toFieldPath: spec.forProvider.dbSubnetGroupNameRef.name

            # Connection details to propagate to the composite resource
            connectionDetails:
              - name: endpoint
                fromConnectionSecretKey: endpoint
              - name: port
                fromConnectionSecretKey: port
              - name: username
                fromConnectionSecretKey: username
              - name: password
                fromConnectionSecretKey: password

          # Managed Resource 2: RDS Subnet Group
          - name: rds-subnet-group
            base:
              apiVersion: rds.aws.upbound.io/v1beta1
              kind: SubnetGroup
              spec:
                forProvider:
                  description: "Subnet group managed by Crossplane"
                  subnetIds:
                    - subnet-0abc123456789def0
                    - subnet-0def123456789abc0
                    - subnet-0fed123456789cba0
                providerConfigRef:
                  name: default
            patches:
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.region
                toFieldPath: spec.forProvider.region
              # Name the subnet group to match the composite resource
              - type: FromCompositeFieldPath
                fromFieldPath: metadata.name
                toFieldPath: metadata.name

    # Step 2: Auto-ready — mark XR as ready when all composed resources are ready
    - step: automatically-detect-readiness
      functionRef:
        name: function-auto-ready
```

### AWS Development Composition (Minimal Cost)

```yaml
# composition-postgresql-aws-dev.yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: postgresql-aws-development
  labels:
    provider: aws
    environment: development
spec:
  compositeTypeRef:
    apiVersion: platform.company.io/v1alpha1
    kind: XPostgreSQLInstance
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
                  engine: postgres
                  multiAz: false          # Dev: single AZ
                  storageEncrypted: true
                  autoMinorVersionUpgrade: true
                  deletionProtection: false
                  backupRetentionPeriod: 1
                  skipFinalSnapshot: true
                  publiclyAccessible: false
                  username: dbadmin
                providerConfigRef:
                  name: default
            patches:
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.region
                toFieldPath: spec.forProvider.region
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.storageGB
                toFieldPath: spec.forProvider.allocatedStorage
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.instanceSize
                toFieldPath: spec.forProvider.instanceClass
                transforms:
                  - type: map
                    map:
                      small:  db.t4g.micro
                      medium: db.t4g.small
                      large:  db.t4g.medium
                      xlarge: db.t4g.large
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.version
                toFieldPath: spec.forProvider.engineVersion
                transforms:
                  - type: map
                    map:
                      "14": "14.12"
                      "15": "15.7"
                      "16": "16.3"
    - step: automatically-detect-readiness
      functionRef:
        name: function-auto-ready
```

### Installing Required Composition Functions

```bash
# function-patch-and-transform
kubectl apply -f - << 'EOF'
apiVersion: pkg.crossplane.io/v1beta1
kind: Function
metadata:
  name: function-patch-and-transform
spec:
  package: xpkg.upbound.io/crossplane-contrib/function-patch-and-transform:v0.6.0
EOF

# function-auto-ready
kubectl apply -f - << 'EOF'
apiVersion: pkg.crossplane.io/v1beta1
kind: Function
metadata:
  name: function-auto-ready
spec:
  package: xpkg.upbound.io/crossplane-contrib/function-auto-ready:v0.2.1
EOF

# Wait for functions to be installed
kubectl get functions
```

---

## Section 7: CompositeResourceClaims (Developer Self-Service)

Claims are namespace-scoped resources that developers use to request infrastructure without needing cluster-level access. The platform team controls which Composition is used via a label selector or `compositionRef`.

### Creating a PostgreSQL Database Claim

```yaml
# database-claim-production.yaml
# This file is committed to the application's Git repository
apiVersion: platform.company.io/v1alpha1
kind: PostgreSQLInstance
metadata:
  name: user-service-db
  namespace: production
spec:
  parameters:
    storageGB: 100
    region: us-east-1
    version: "16"
    instanceSize: medium
    multiAZ: true
    databaseName: userservice
  # Select the production Composition
  compositionSelector:
    matchLabels:
      provider: aws
      environment: production
  # Write connection details to a Secret in this namespace
  writeConnectionSecretToRef:
    name: user-service-db-connection
```

```bash
kubectl apply -f database-claim-production.yaml

# Watch the claim and its composite resource being provisioned
kubectl get postgresqlinstance user-service-db -n production

# Composite resource (cluster-scoped) is created automatically
kubectl get xpostgresqlinstances

# Watch underlying managed resources being provisioned
kubectl get rds -A

# Check claim status — READY=True when provisioning is complete
kubectl describe postgresqlinstance user-service-db -n production
```

### Consuming the Connection Secret in the Application

```yaml
# deployment-user-service.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: user-service
  namespace: production
spec:
  template:
    spec:
      containers:
        - name: user-service
          image: registry.company.internal/user-service:2.1.0
          env:
            - name: DB_HOST
              valueFrom:
                secretKeyRef:
                  name: user-service-db-connection
                  key: endpoint
            - name: DB_PORT
              valueFrom:
                secretKeyRef:
                  name: user-service-db-connection
                  key: port
            - name: DB_USER
              valueFrom:
                secretKeyRef:
                  name: user-service-db-connection
                  key: username
            - name: DB_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: user-service-db-connection
                  key: password
```

### Developer Claim for Development Environment

```yaml
# database-claim-development.yaml
apiVersion: platform.company.io/v1alpha1
kind: PostgreSQLInstance
metadata:
  name: user-service-db
  namespace: development
spec:
  parameters:
    storageGB: 20
    region: us-east-1
    version: "16"
    instanceSize: small
    multiAZ: false
    databaseName: userservice
  compositionSelector:
    matchLabels:
      provider: aws
      environment: development
  writeConnectionSecretToRef:
    name: user-service-db-connection
```

---

## Section 8: Configurations (Packaging Compositions)

Crossplane Configurations are OCI packages that bundle XRDs, Compositions, and their dependencies, enabling distribution and versioning of platform abstractions.

### Configuration Package Structure

```
platform-config/
├── crossplane.yaml           # Package metadata
├── apis/
│   ├── postgresql/
│   │   ├── xrd.yaml
│   │   ├── composition-aws-prod.yaml
│   │   └── composition-aws-dev.yaml
│   └── objectstorage/
│       ├── xrd.yaml
│       └── composition-aws.yaml
└── providers/
    ├── provider-aws-rds.yaml
    └── provider-aws-s3.yaml
```

```yaml
# crossplane.yaml
apiVersion: meta.pkg.crossplane.io/v1
kind: Configuration
metadata:
  name: platform-config
  annotations:
    meta.crossplane.io/maintainer: "Platform Team <platform@company.io>"
    meta.crossplane.io/source: "https://git.company.internal/platform/crossplane-config"
    meta.crossplane.io/description: "Company platform infrastructure compositions"
spec:
  crossplane:
    version: ">=v1.14.0"
  dependsOn:
    - provider: xpkg.upbound.io/upbound/provider-aws-rds
      version: ">=v1.14.0"
    - provider: xpkg.upbound.io/upbound/provider-aws-s3
      version: ">=v1.14.0"
    - function: xpkg.upbound.io/crossplane-contrib/function-patch-and-transform
      version: ">=v0.6.0"
    - function: xpkg.upbound.io/crossplane-contrib/function-auto-ready
      version: ">=v0.2.0"
```

```bash
# Build and push the Configuration package
crossplane xpkg build \
  --package-root=platform-config/ \
  --output=platform-config-v1.0.0.xpkg

crossplane xpkg push \
  platform-config-v1.0.0.xpkg \
  --package=registry.company.internal/crossplane/platform-config:v1.0.0

# Install the Configuration on a cluster
kubectl apply -f - << 'EOF'
apiVersion: pkg.crossplane.io/v1
kind: Configuration
metadata:
  name: platform-config
spec:
  package: registry.company.internal/crossplane/platform-config:v1.0.0
  installationPolicy: Automatic
EOF
```

---

## Section 9: GitOps Integration

### ArgoCD Application for Infrastructure Claims

```yaml
# argocd-app-infrastructure.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: production-infrastructure
  namespace: argocd
spec:
  project: production
  source:
    repoURL: "https://git.company.internal/teams/user-service"
    targetRevision: main
    path: infrastructure/production
  destination:
    server: "https://kubernetes.default.svc"
    namespace: production
  syncPolicy:
    automated:
      prune: true
      selfHeal: false    # Infrastructure changes should be manual
    syncOptions:
      - CreateNamespace=true
      - ServerSideApply=true
  # Ignore status fields and connection secret references
  ignoreDifferences:
    - group: "platform.company.io"
      kind: PostgreSQLInstance
      jsonPointers:
        - /status
        - /spec/resourceRef
```

### ArgoCD Application for Platform Compositions

```yaml
# argocd-app-platform-compositions.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: crossplane-compositions
  namespace: argocd
spec:
  project: platform
  source:
    repoURL: "https://git.company.internal/platform/crossplane-config"
    targetRevision: main
    path: apis
  destination:
    server: "https://kubernetes.default.svc"
    namespace: crossplane-system
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
  ignoreDifferences:
    - group: "apiextensions.crossplane.io"
      kind: CompositeResourceDefinition
      jsonPointers:
        - /status
    - group: "apiextensions.crossplane.io"
      kind: Composition
      jsonPointers:
        - /status
```

---

## Section 10: Debugging and Troubleshooting

### Checking Resource Status

```bash
# Check all managed resources and their sync state
kubectl get managed

# Check composite resources
kubectl get composite

# Check claims in a namespace
kubectl get claim -n production

# Detailed status for a specific claim
kubectl describe postgresqlinstance user-service-db -n production
# Look for:
# - Status.Conditions[0] (Ready)
# - Status.Conditions[1] (Synced)
# - Events section for recent reconciliation activity
```

### Crossplane Composite Resource Status

```bash
# Get the XR linked to a claim
kubectl get postgresqlinstance user-service-db -n production \
  -o jsonpath='{.spec.resourceRef.name}'

# Get the XR status and events
XR_NAME=$(kubectl get postgresqlinstance user-service-db -n production \
  -o jsonpath='{.spec.resourceRef.name}')
kubectl describe xpostgresqlinstances "${XR_NAME}"
```

### Finding and Fixing Stuck Resources

```bash
# Managed resources that are not synced
kubectl get managed -o json | jq '
  .items[] | select(
    .status.conditions[]? |
    (.type == "Synced" and .status == "False")
  ) | {
    kind: .kind,
    name: .metadata.name,
    message: (.status.conditions[] | select(.type == "Synced") | .message)
  }'

# Common failure reasons
kubectl get rds -o json | jq '
  .items[] | select(.status.conditions[]?.type == "Ready") |
  {
    name: .metadata.name,
    ready: (.status.conditions[] | select(.type == "Ready") | .status),
    reason: (.status.conditions[] | select(.type == "Ready") | .reason),
    message: (.status.conditions[] | select(.type == "Ready") | .message)
  }'

# Trigger a manual reconciliation
kubectl annotate managed app-postgres-production \
  crossplane.io/paused=true
sleep 5
kubectl annotate managed app-postgres-production \
  crossplane.io/paused-

# Delete a managed resource without deleting the cloud resource (orphan)
kubectl patch rds app-postgres-production \
  --type merge \
  --patch '{"spec":{"deletionPolicy":"Orphan"}}'
kubectl delete rds app-postgres-production
```

### Checking Provider Health

```bash
# Provider health status
kubectl describe provider provider-aws-rds | grep -A 20 Status:

# Provider pod logs
kubectl logs -n crossplane-system \
  -l pkg.crossplane.io/revision=provider-aws-rds-HASH \
  --tail=50 | grep -E "error|Error|reconcil"

# List all active ProviderConfigs
kubectl get providerconfigs.aws.upbound.io
```

### Composition Debugging

```bash
# Check if a Composition is valid and selectable
kubectl get compositions -o json | jq '
  .items[] | {
    name: .metadata.name,
    xrd: .spec.compositeTypeRef.kind,
    ready: (.status.conditions[]? | select(.type == "Healthy") | .status)
  }'

# Validate the composition renders correctly for a given XR
# Use the crossplane CLI render command
crossplane render \
  xr.yaml \
  composition.yaml \
  functions.yaml \
  --include-full-xr | kubectl apply --dry-run=server -f -
```

---

## Section 11: Multi-Cluster and Multi-Environment Patterns

### Using Compositions for Environment Parity

The recommended pattern is a single XRD with multiple Compositions selected by environment labels:

```bash
# List available compositions for the PostgreSQLInstance XRD
kubectl get compositions -l crossplane.io/xrd=xpostgresqlinstances.platform.company.io

# NAME                          XR-KIND                  AGE
# postgresql-aws-production     XPostgreSQLInstance      10d
# postgresql-aws-development    XPostgreSQLInstance      10d
# postgresql-gcp-production     XPostgreSQLInstance      5d
```

### Claim Namespace Isolation

```yaml
# RBAC: Allow developers to manage claims in their namespace
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: crossplane-claim-editor
  namespace: production
rules:
  - apiGroups: ["platform.company.io"]
    resources:
      - postgresqlinstances
      - objectstorageinstances
    verbs: ["get", "list", "watch", "create", "update", "patch"]
  # Explicitly deny deletion
  # (deletion must go through platform team)
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: crossplane-claim-editor
  namespace: production
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: crossplane-claim-editor
subjects:
  - kind: Group
    name: "team-user-service"
    apiGroup: rbac.authorization.k8s.io
```

---

## Section 12: Observability and Cost Management

### Prometheus Metrics from Crossplane

```bash
# Crossplane exposes Prometheus metrics at :8080/metrics
# Key metrics to monitor:

# Managed resource reconciliation errors
crossplane_managed_resource_exists                    # 0 or 1 per resource
crossplane_managed_resource_ready                     # 0 or 1 per resource
crossplane_managed_resource_synced                    # 0 or 1 per resource

# Composite resource readiness
crossplane_composite_resource_exists
crossplane_composite_resource_ready

# Reconcile queue depth (backlog)
crossplane_reconciler_queue_depth
```

```yaml
# PrometheusRule for Crossplane
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: crossplane-alerts
  namespace: crossplane-system
  labels:
    release: kube-prometheus-stack
spec:
  groups:
    - name: crossplane
      rules:
        - alert: CrossplaneResourceNotSynced
          expr: |
            crossplane_managed_resource_synced == 0
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Crossplane managed resource is not synced"
            description: >
              Managed resource {{ $labels.name }} of kind {{ $labels.kind }}
              has not been synced for 10 minutes. Check provider logs.

        - alert: CrossplaneResourceNotReady
          expr: |
            crossplane_managed_resource_ready == 0
          for: 30m
          labels:
            severity: warning
          annotations:
            summary: "Crossplane managed resource has not become ready"
            description: >
              Managed resource {{ $labels.name }} of kind {{ $labels.kind }}
              has not become ready in 30 minutes.

        - alert: CrossplaneHighReconcileQueueDepth
          expr: |
            crossplane_reconciler_queue_depth > 100
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Crossplane reconciler queue is backed up"
            description: >
              The Crossplane reconciler queue has {{ $value }} items.
              Provider pods may be resource-constrained.
```

### Tagging All Resources for Cost Allocation

Enforce consistent tagging by including tags in all Composition base templates:

```yaml
# In every Composition that creates AWS resources, include these patches
patches:
  # Propagate team label from the claim to cloud resource tags
  - type: FromCompositeFieldPath
    fromFieldPath: metadata.labels.team
    toFieldPath: spec.forProvider.tags.Team

  # Hard-code managed-by tag
  - type: FromCompositeFieldPath
    fromFieldPath: metadata.name
    toFieldPath: spec.forProvider.tags.CrossplaneResource
    transforms:
      - type: string
        string:
          fmt: "xr-%s"

  # Include environment from namespace label
  - type: FromEnvironmentFieldPath
    fromFieldPath: data.environment
    toFieldPath: spec.forProvider.tags.Environment
```

---

Crossplane represents the next evolution of Infrastructure as Code: instead of running a separate Terraform or Pulumi process, all infrastructure state flows through the Kubernetes control plane with the same reconciliation model, RBAC, audit logging, and GitOps tooling already in place. The separation between Compositions (platform team) and Claims (developer teams) creates a clean platform contract where developers request infrastructure in their own terms while platform engineers control the underlying implementation and enforce organizational standards through the composition layer.
