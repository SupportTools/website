---
title: "Crossplane Infrastructure Composition: Building Cloud-Agnostic Control Planes"
date: 2026-05-30T00:00:00-05:00
draft: false
tags: ["Crossplane", "Kubernetes", "Infrastructure as Code", "Platform Engineering", "Multi-Cloud", "GitOps"]
categories: ["Platform Engineering", "Cloud Infrastructure"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to implementing Crossplane for infrastructure composition, creating reusable abstractions, and building cloud-agnostic control planes for enterprise platforms."
more_link: "yes"
url: "/crossplane-infrastructure-composition-enterprise-guide/"
---

Crossplane transforms Kubernetes into a universal control plane for managing infrastructure across multiple cloud providers. By defining infrastructure as Kubernetes custom resources and using composition to create higher-level abstractions, platform teams can provide self-service capabilities while maintaining governance and best practices. This guide demonstrates enterprise-grade Crossplane implementations.

<!--more-->

# Crossplane Infrastructure Composition: Building Cloud-Agnostic Control Planes

## Understanding Crossplane Architecture

Crossplane extends Kubernetes with:

- **Managed Resources**: Direct representations of cloud provider resources
- **Composite Resources**: Higher-level abstractions composed of managed resources
- **Compositions**: Templates defining how composite resources are constructed
- **Claims**: Namespace-scoped requests for composite resources
- **Providers**: Plugins that enable management of specific cloud services

```
┌─────────────────────────────────────────────────────────┐
│              Application Namespace                       │
│  ┌──────────────────────────────────────────────────┐  │
│  │  PostgreSQLInstance Claim                        │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────┐
│         Crossplane System (Cluster-Scoped)              │
│  ┌──────────────────────────────────────────────────┐  │
│  │  CompositePostgreSQLInstance                     │  │
│  └──────────────────────────────────────────────────┘  │
│                      │                                   │
│         ┌────────────┴────────────┐                     │
│         ▼                          ▼                     │
│  ┌─────────────┐          ┌──────────────┐             │
│  │ RDS Instance│          │Security Group│             │
│  └─────────────┘          └──────────────┘             │
│         │                          │                     │
└─────────┼──────────────────────────┼─────────────────────┘
          │                          │
          ▼                          ▼
┌─────────────────────────────────────────────────────────┐
│                    AWS Cloud                            │
└─────────────────────────────────────────────────────────┘
```

## Initial Crossplane Setup

### Installing Crossplane

```bash
# Add Crossplane Helm repository
helm repo add crossplane-stable https://charts.crossplane.io/stable
helm repo update

# Create namespace
kubectl create namespace crossplane-system

# Install Crossplane
helm install crossplane \
  --namespace crossplane-system \
  crossplane-stable/crossplane \
  --version 1.14.5 \
  --set args='{--enable-composition-functions,--enable-composition-webhook-schema-validation}' \
  --set metrics.enabled=true \
  --set webhooks.enabled=true
```

### Provider Configuration

```yaml
# providers/aws-provider.yaml
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws-ec2
spec:
  package: xpkg.upbound.io/upbound/provider-aws-ec2:v0.47.0
  packagePullPolicy: IfNotPresent
  revisionActivationPolicy: Automatic
  revisionHistoryLimit: 3

---
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws-rds
spec:
  package: xpkg.upbound.io/upbound/provider-aws-rds:v0.47.0

---
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws-s3
spec:
  package: xpkg.upbound.io/upbound/provider-aws-s3:v0.47.0

---
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws-elasticache
spec:
  package: xpkg.upbound.io/upbound/provider-aws-elasticache:v0.47.0

---
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-kubernetes
spec:
  package: xpkg.upbound.io/crossplane-contrib/provider-kubernetes:v0.11.0

---
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-helm
spec:
  package: xpkg.upbound.io/crossplane-contrib/provider-helm:v0.15.0
```

### Provider Credentials Configuration

```yaml
# providers/aws-credentials.yaml
apiVersion: v1
kind: Secret
metadata:
  name: aws-credentials
  namespace: crossplane-system
type: Opaque
stringData:
  credentials: |
    [default]
    aws_access_key_id = ${AWS_ACCESS_KEY_ID}
    aws_secret_access_key = ${AWS_SECRET_ACCESS_KEY}

---
apiVersion: aws.upbound.io/v1beta1
kind: ProviderConfig
metadata:
  name: default
spec:
  credentials:
    source: Secret
    secretRef:
      namespace: crossplane-system
      name: aws-credentials
      key: credentials
  assumeRoleARN: arn:aws:iam::123456789012:role/CrossplaneManagement

---
apiVersion: aws.upbound.io/v1beta1
kind: ProviderConfig
metadata:
  name: production
spec:
  credentials:
    source: Secret
    secretRef:
      namespace: crossplane-system
      name: aws-credentials
      key: credentials
  assumeRoleARN: arn:aws:iam::123456789012:role/CrossplaneProduction

---
apiVersion: aws.upbound.io/v1beta1
kind: ProviderConfig
metadata:
  name: development
spec:
  credentials:
    source: Secret
    secretRef:
      namespace: crossplane-system
      name: aws-credentials
      key: credentials
  assumeRoleARN: arn:aws:iam::123456789012:role/CrossplaneDevelopment
```

## Composite Resource Definitions (XRDs)

### Database XRD

```yaml
# apis/database/definition.yaml
apiVersion: apiextensions.crossplane.io/v1
kind: CompositeResourceDefinition
metadata:
  name: xpostgresqlinstances.database.company.com
spec:
  group: database.company.com
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
    - database
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
                    size:
                      type: string
                      description: "Size of the database instance (small, medium, large, xlarge)"
                      enum:
                        - small
                        - medium
                        - large
                        - xlarge
                      default: small

                    version:
                      type: string
                      description: "PostgreSQL version"
                      enum:
                        - "14"
                        - "15"
                        - "16"
                      default: "15"

                    storageGB:
                      type: integer
                      description: "Storage size in GB"
                      minimum: 20
                      maximum: 16384
                      default: 100

                    highAvailability:
                      type: boolean
                      description: "Enable multi-AZ deployment"
                      default: false

                    backupRetentionDays:
                      type: integer
                      description: "Number of days to retain backups"
                      minimum: 1
                      maximum: 35
                      default: 7

                    performanceInsights:
                      type: boolean
                      description: "Enable Performance Insights"
                      default: true

                    deletionProtection:
                      type: boolean
                      description: "Enable deletion protection"
                      default: true

                    allowedCIDRBlocks:
                      type: array
                      description: "CIDR blocks allowed to connect"
                      items:
                        type: string
                      default:
                        - "10.0.0.0/8"

                    tags:
                      type: object
                      description: "Additional tags"
                      additionalProperties:
                        type: string

                  required:
                    - size
                    - version

              required:
                - parameters

            status:
              type: object
              properties:
                instanceStatus:
                  type: string
                endpoint:
                  type: string
                port:
                  type: integer
                observedGeneration:
                  type: integer
      additionalPrinterColumns:
        - name: Size
          type: string
          jsonPath: .spec.parameters.size
        - name: Version
          type: string
          jsonPath: .spec.parameters.version
        - name: Status
          type: string
          jsonPath: .status.instanceStatus
        - name: Endpoint
          type: string
          jsonPath: .status.endpoint
        - name: Age
          type: date
          jsonPath: .metadata.creationTimestamp
```

### Application Stack XRD

```yaml
# apis/application/definition.yaml
apiVersion: apiextensions.crossplane.io/v1
kind: CompositeResourceDefinition
metadata:
  name: xapplicationstacks.platform.company.com
spec:
  group: platform.company.com
  names:
    kind: XApplicationStack
    plural: xapplicationstacks
  claimNames:
    kind: ApplicationStack
    plural: applicationstacks
  connectionSecretKeys:
    - database-endpoint
    - database-username
    - database-password
    - cache-endpoint
    - storage-bucket
    - kubeconfig
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
                    environment:
                      type: string
                      enum:
                        - development
                        - staging
                        - production
                      default: development

                    region:
                      type: string
                      enum:
                        - us-east-1
                        - us-west-2
                        - eu-west-1
                        - ap-southeast-1
                      default: us-east-1

                    applicationName:
                      type: string
                      pattern: "^[a-z0-9-]+$"

                    namespace:
                      type: string
                      pattern: "^[a-z0-9-]+$"

                    database:
                      type: object
                      properties:
                        enabled:
                          type: boolean
                          default: true
                        engine:
                          type: string
                          enum:
                            - postgresql
                            - mysql
                          default: postgresql
                        size:
                          type: string
                          enum:
                            - small
                            - medium
                            - large
                          default: small
                        version:
                          type: string

                    cache:
                      type: object
                      properties:
                        enabled:
                          type: boolean
                          default: true
                        engine:
                          type: string
                          enum:
                            - redis
                            - memcached
                          default: redis
                        nodeType:
                          type: string
                          default: cache.t3.micro

                    storage:
                      type: object
                      properties:
                        enabled:
                          type: boolean
                          default: true
                        sizeGB:
                          type: integer
                          minimum: 10
                          maximum: 10000
                          default: 100
                        versioning:
                          type: boolean
                          default: true

                    monitoring:
                      type: object
                      properties:
                        enabled:
                          type: boolean
                          default: true
                        alertEmail:
                          type: string
                          format: email

                  required:
                    - environment
                    - applicationName
                    - namespace
```

## Compositions

### PostgreSQL Composition for AWS

```yaml
# compositions/aws-postgresql.yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: xpostgresqlinstances.aws.database.company.com
  labels:
    provider: aws
    database: postgresql
spec:
  writeConnectionSecretsToNamespace: crossplane-system

  compositeTypeRef:
    apiVersion: database.company.com/v1alpha1
    kind: XPostgreSQLInstance

  patchSets:
    - name: common-parameters
      patches:
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.tags
          toFieldPath: spec.forProvider.tags
          policy:
            mergeOptions:
              appendSlice: true

        - type: FromCompositeFieldPath
          fromFieldPath: metadata.labels[crossplane.io/claim-namespace]
          toFieldPath: spec.forProvider.tags.namespace

        - type: FromCompositeFieldPath
          fromFieldPath: metadata.labels[crossplane.io/claim-name]
          toFieldPath: spec.forProvider.tags.claim-name

  resources:
    # DB Subnet Group
    - name: db-subnet-group
      base:
        apiVersion: rds.aws.upbound.io/v1beta1
        kind: SubnetGroup
        spec:
          forProvider:
            region: us-east-1
            description: "Subnet group for PostgreSQL instance"
            subnetIdSelector:
              matchLabels:
                type: private
      patches:
        - type: PatchSet
          patchSetName: common-parameters

        - type: FromCompositeFieldPath
          fromFieldPath: metadata.uid
          toFieldPath: spec.forProvider.name
          transforms:
            - type: string
              string:
                fmt: "db-subnet-%s"

    # Security Group
    - name: security-group
      base:
        apiVersion: ec2.aws.upbound.io/v1beta1
        kind: SecurityGroup
        spec:
          forProvider:
            region: us-east-1
            description: "Security group for PostgreSQL instance"
            vpcIdSelector:
              matchLabels:
                network: main
      patches:
        - type: PatchSet
          patchSetName: common-parameters

        - type: FromCompositeFieldPath
          fromFieldPath: metadata.uid
          toFieldPath: spec.forProvider.name
          transforms:
            - type: string
              string:
                fmt: "db-sg-%s"

    # Security Group Rules
    - name: security-group-rule-ingress
      base:
        apiVersion: ec2.aws.upbound.io/v1beta1
        kind: SecurityGroupRule
        spec:
          forProvider:
            region: us-east-1
            type: ingress
            fromPort: 5432
            toPort: 5432
            protocol: tcp
            description: "PostgreSQL access"
            securityGroupIdSelector:
              matchControllerRef: true
      patches:
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.allowedCIDRBlocks
          toFieldPath: spec.forProvider.cidrBlocks

    # Parameter Group
    - name: parameter-group
      base:
        apiVersion: rds.aws.upbound.io/v1beta1
        kind: ParameterGroup
        spec:
          forProvider:
            region: us-east-1
            description: "PostgreSQL parameter group"
            parameter:
              - name: max_connections
                value: "200"
              - name: shared_buffers
                value: "{DBInstanceClassMemory/32768}"
              - name: effective_cache_size
                value: "{DBInstanceClassMemory/16384}"
              - name: maintenance_work_mem
                value: "2097152"
              - name: checkpoint_completion_target
                value: "0.9"
              - name: wal_buffers
                value: "16384"
              - name: default_statistics_target
                value: "100"
              - name: random_page_cost
                value: "1.1"
              - name: effective_io_concurrency
                value: "200"
              - name: work_mem
                value: "10485760"
              - name: min_wal_size
                value: "1024"
              - name: max_wal_size
                value: "4096"
              - name: log_statement
                value: "all"
              - name: log_duration
                value: "on"
      patches:
        - type: PatchSet
          patchSetName: common-parameters

        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.version
          toFieldPath: spec.forProvider.family
          transforms:
            - type: string
              string:
                fmt: "postgres%s"

        - type: CombineFromComposite
          combine:
            variables:
              - fromFieldPath: metadata.uid
              - fromFieldPath: spec.parameters.version
            strategy: string
            string:
              fmt: "pg-%s-v%s"
          toFieldPath: spec.forProvider.name

    # RDS Instance
    - name: rds-instance
      base:
        apiVersion: rds.aws.upbound.io/v1beta1
        kind: Instance
        spec:
          forProvider:
            region: us-east-1
            engine: postgres
            autoMinorVersionUpgrade: true
            publiclyAccessible: false
            skipFinalSnapshot: false
            copyTagsToSnapshot: true
            enabledCloudwatchLogsExports:
              - postgresql
              - upgrade
            dbSubnetGroupNameSelector:
              matchControllerRef: true
            vpcSecurityGroupIdSelector:
              matchControllerRef: true
            dbParameterGroupNameSelector:
              matchControllerRef: true
          writeConnectionSecretToRef:
            namespace: crossplane-system
      patches:
        - type: PatchSet
          patchSetName: common-parameters

        - type: FromCompositeFieldPath
          fromFieldPath: metadata.uid
          toFieldPath: spec.writeConnectionSecretToRef.name
          transforms:
            - type: string
              string:
                fmt: "%s-postgresql"

        - type: FromCompositeFieldPath
          fromFieldPath: spec.writeConnectionSecretToRef.namespace
          toFieldPath: spec.writeConnectionSecretToRef.namespace

        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.version
          toFieldPath: spec.forProvider.engineVersion

        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.storageGB
          toFieldPath: spec.forProvider.allocatedStorage

        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.highAvailability
          toFieldPath: spec.forProvider.multiAz

        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.backupRetentionDays
          toFieldPath: spec.forProvider.backupRetentionPeriod

        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.performanceInsights
          toFieldPath: spec.forProvider.enablePerformanceInsights

        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.deletionProtection
          toFieldPath: spec.forProvider.deletionProtection

        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.size
          toFieldPath: spec.forProvider.instanceClass
          transforms:
            - type: map
              map:
                small: db.t3.small
                medium: db.t3.medium
                large: db.m5.large
                xlarge: db.m5.xlarge

        - type: FromCompositeFieldPath
          fromFieldPath: metadata.uid
          toFieldPath: spec.forProvider.identifier
          transforms:
            - type: string
              string:
                fmt: "postgresql-%s"
                type: Convert
                convert: ToLower

        - type: ToCompositeFieldPath
          fromFieldPath: status.atProvider.endpoint
          toFieldPath: status.endpoint

        - type: ToCompositeFieldPath
          fromFieldPath: status.atProvider.status
          toFieldPath: status.instanceStatus

        - type: ToCompositeFieldPath
          fromFieldPath: status.atProvider.port
          toFieldPath: status.port

      connectionDetails:
        - name: username
          fromConnectionSecretKey: username
        - name: password
          fromConnectionSecretKey: password
        - name: endpoint
          fromConnectionSecretKey: endpoint
        - name: port
          fromConnectionSecretKey: port
        - name: database
          value: postgres
```

### Application Stack Composition

```yaml
# compositions/application-stack.yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: xapplicationstacks.aws.platform.company.com
  labels:
    provider: aws
    type: application-stack
spec:
  writeConnectionSecretsToNamespace: crossplane-system

  compositeTypeRef:
    apiVersion: platform.company.com/v1alpha1
    kind: XApplicationStack

  patchSets:
    - name: common-metadata
      patches:
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.applicationName
          toFieldPath: metadata.labels[app]

        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.environment
          toFieldPath: metadata.labels[environment]

        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.region
          toFieldPath: spec.forProvider.region

  resources:
    # VPC
    - name: vpc
      base:
        apiVersion: ec2.aws.upbound.io/v1beta1
        kind: VPC
        spec:
          forProvider:
            cidrBlock: 10.0.0.0/16
            enableDnsHostnames: true
            enableDnsSupport: true
      patches:
        - type: PatchSet
          patchSetName: common-metadata

        - type: CombineFromComposite
          combine:
            variables:
              - fromFieldPath: spec.parameters.applicationName
              - fromFieldPath: spec.parameters.environment
            strategy: string
            string:
              fmt: "%s-%s-vpc"
          toFieldPath: spec.forProvider.tags.Name

    # Database (Conditional)
    - name: postgresql-database
      base:
        apiVersion: database.company.com/v1alpha1
        kind: XPostgreSQLInstance
        spec:
          parameters:
            size: small
            version: "15"
            storageGB: 100
          compositionSelector:
            matchLabels:
              provider: aws
      patches:
        - type: PatchSet
          patchSetName: common-metadata

        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.database.size
          toFieldPath: spec.parameters.size

        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.database.version
          toFieldPath: spec.parameters.version

        - type: CombineFromComposite
          combine:
            variables:
              - fromFieldPath: spec.parameters.applicationName
              - fromFieldPath: spec.parameters.environment
            strategy: string
            string:
              fmt: "%s-%s-db-secret"
          toFieldPath: spec.writeConnectionSecretToRef.name

        - type: FromCompositeFieldPath
          fromFieldPath: spec.writeConnectionSecretToRef.namespace
          toFieldPath: spec.writeConnectionSecretToRef.namespace

        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.database.enabled
          toFieldPath: spec.forProvider.enabled
          transforms:
            - type: convert
              convert:
                toType: bool

      readinessChecks:
        - type: MatchString
          fieldPath: status.instanceStatus
          matchString: available

    # ElastiCache Redis (Conditional)
    - name: redis-cache
      base:
        apiVersion: elasticache.aws.upbound.io/v1beta1
        kind: ReplicationGroup
        spec:
          forProvider:
            replicationGroupDescription: "Redis cache for application"
            engine: redis
            engineVersion: "7.0"
            numCacheClusters: 2
            automaticFailoverEnabled: true
            multiAzEnabled: true
            atRestEncryptionEnabled: true
            transitEncryptionEnabled: true
            snapshotRetentionLimit: 5
            snapshotWindow: "03:00-05:00"
            maintenanceWindow: "sun:05:00-sun:07:00"
      patches:
        - type: PatchSet
          patchSetName: common-metadata

        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.cache.nodeType
          toFieldPath: spec.forProvider.nodeType

        - type: CombineFromComposite
          combine:
            variables:
              - fromFieldPath: spec.parameters.applicationName
              - fromFieldPath: spec.parameters.environment
            strategy: string
            string:
              fmt: "%s-%s-redis"
          toFieldPath: spec.forProvider.replicationGroupId

    # S3 Bucket
    - name: storage-bucket
      base:
        apiVersion: s3.aws.upbound.io/v1beta1
        kind: Bucket
        spec:
          forProvider:
            forceDestroy: false
      patches:
        - type: PatchSet
          patchSetName: common-metadata

        - type: CombineFromComposite
          combine:
            variables:
              - fromFieldPath: spec.parameters.applicationName
              - fromFieldPath: spec.parameters.environment
              - fromFieldPath: metadata.uid
            strategy: string
            string:
              fmt: "%s-%s-storage-%s"
          toFieldPath: metadata.name

    # S3 Bucket Versioning
    - name: storage-bucket-versioning
      base:
        apiVersion: s3.aws.upbound.io/v1beta1
        kind: BucketVersioning
        spec:
          forProvider:
            bucketSelector:
              matchControllerRef: true
            versioningConfiguration:
              - status: Enabled
      patches:
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.storage.versioning
          toFieldPath: spec.forProvider.versioningConfiguration[0].status
          transforms:
            - type: map
              map:
                "true": Enabled
                "false": Suspended

    # Kubernetes Namespace
    - name: kubernetes-namespace
      base:
        apiVersion: kubernetes.crossplane.io/v1alpha1
        kind: Object
        spec:
          forProvider:
            manifest:
              apiVersion: v1
              kind: Namespace
              metadata:
                name: placeholder
      patches:
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.namespace
          toFieldPath: spec.forProvider.manifest.metadata.name

        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.applicationName
          toFieldPath: spec.forProvider.manifest.metadata.labels.app

        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.environment
          toFieldPath: spec.forProvider.manifest.metadata.labels.environment

    # Helm Release (Optional Monitoring)
    - name: prometheus-servicemonitor
      base:
        apiVersion: helm.crossplane.io/v1beta1
        kind: Release
        spec:
          forProvider:
            chart:
              name: prometheus-servicemonitor
              repository: https://prometheus-community.github.io/helm-charts
              version: "1.0.0"
            namespace: monitoring
      patches:
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.monitoring.enabled
          toFieldPath: spec.forProvider.enabled

        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.applicationName
          toFieldPath: spec.forProvider.values.serviceName
```

## Composition Functions

### Advanced Transformation Function

```yaml
# composition-functions/transform-function.yaml
apiVersion: apiextensions.crossplane.io/v1
kind: CompositionFunction
metadata:
  name: function-patch-and-transform
spec:
  package: xpkg.upbound.io/crossplane-contrib/function-patch-and-transform:v0.2.0
```

### Using Functions in Compositions

```yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: xpostgresqlinstances.advanced.database.company.com
spec:
  compositeTypeRef:
    apiVersion: database.company.com/v1alpha1
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
            patches:
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.size
                toFieldPath: spec.forProvider.instanceClass
                transforms:
                  - type: map
                    map:
                      small: db.t3.small
                      medium: db.t3.medium
                      large: db.m5.large

    - step: auto-ready
      functionRef:
        name: function-auto-ready
```

## Policy and Governance

### Composition Validation Policy

```yaml
# policies/composition-validation.yaml
apiVersion: pkg.crossplane.io/v1beta1
kind: Configuration
metadata:
  name: platform-compositions
spec:
  package: company.com/platform-compositions:v1.0.0
  dependsOn:
    - provider: xpkg.upbound.io/upbound/provider-aws-rds
      version: ">=v0.47.0"
    - provider: xpkg.upbound.io/upbound/provider-aws-ec2
      version: ">=v0.47.0"

---
apiVersion: meta.pkg.crossplane.io/v1
kind: Configuration
metadata:
  name: platform-compositions
  annotations:
    meta.crossplane.io/maintainer: Platform Team <platform@company.com>
    meta.crossplane.io/source: github.com/company/platform-compositions
    meta.crossplane.io/license: Apache-2.0
    meta.crossplane.io/description: |
      Standard compositions for company infrastructure
    meta.crossplane.io/readme: |
      This configuration provides standard compositions for:
      - PostgreSQL databases
      - MySQL databases
      - Redis caches
      - Application stacks
spec:
  crossplane:
    version: ">=v1.14.0"
```

### Resource Quotas with Crossplane

```yaml
# policies/resource-quotas.yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: crossplane-resource-quota
  namespace: crossplane-system
spec:
  hard:
    count/providers.pkg.crossplane.io: "20"
    count/providerrevisions.pkg.crossplane.io: "100"
    count/compositeresourcedefinitions.apiextensions.crossplane.io: "50"
    count/compositions.apiextensions.crossplane.io: "200"

---
apiVersion: v1
kind: LimitRange
metadata:
  name: crossplane-limit-range
  namespace: crossplane-system
spec:
  limits:
    - max:
        cpu: "2"
        memory: "4Gi"
      min:
        cpu: "100m"
        memory: "128Mi"
      type: Container
```

## GitOps Integration

### ArgoCD Application for Crossplane

```yaml
# argocd/crossplane-application.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: crossplane-providers
  namespace: argocd
spec:
  project: platform
  source:
    repoURL: https://github.com/company/platform-infrastructure
    targetRevision: main
    path: crossplane/providers
  destination:
    server: https://kubernetes.default.svc
    namespace: crossplane-system
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
      - ServerSideApply=true
    retry:
      limit: 5
      backoff:
        duration: 5s
        factor: 2
        maxDuration: 3m

---
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: crossplane-compositions
  namespace: argocd
spec:
  project: platform
  source:
    repoURL: https://github.com/company/platform-infrastructure
    targetRevision: main
    path: crossplane/compositions
  destination:
    server: https://kubernetes.default.svc
    namespace: crossplane-system
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - ServerSideApply=true

---
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: application-stacks
  namespace: argocd
spec:
  generators:
    - git:
        repoURL: https://github.com/company/applications
        revision: main
        directories:
          - path: apps/*
  template:
    metadata:
      name: '{{path.basename}}-stack'
    spec:
      project: applications
      source:
        repoURL: https://github.com/company/applications
        targetRevision: main
        path: '{{path}}'
      destination:
        server: https://kubernetes.default.svc
        namespace: '{{path.basename}}'
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
```

## Monitoring and Observability

### Prometheus ServiceMonitor

```yaml
# monitoring/servicemonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: crossplane
  namespace: crossplane-system
  labels:
    app: crossplane
spec:
  selector:
    matchLabels:
      app: crossplane
  endpoints:
    - port: metrics
      interval: 30s
      path: /metrics

---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: crossplane-alerts
  namespace: crossplane-system
spec:
  groups:
    - name: crossplane
      interval: 30s
      rules:
        - alert: CrossplaneProviderUnhealthy
          expr: crossplane_provider_pkg_ready{condition="False"} == 1
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Crossplane provider {{ $labels.name }} is unhealthy"
            description: "Provider {{ $labels.name }} has been unhealthy for more than 5 minutes"

        - alert: CrossplaneCompositeResourceFailed
          expr: increase(crossplane_composite_resource_reconcile_errors_total[5m]) > 5
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High error rate for composite resource {{ $labels.name }}"
            description: "Composite resource {{ $labels.name }} has {{ $value }} errors in the last 5 minutes"

        - alert: CrossplaneManagedResourceSyncFailure
          expr: crossplane_managed_resource_synced{condition="False"} == 1
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Managed resource {{ $labels.name }} sync failing"
            description: "Managed resource {{ $labels.name }} has failed to sync for 10 minutes"
```

### Grafana Dashboard

```json
{
  "dashboard": {
    "title": "Crossplane Overview",
    "panels": [
      {
        "title": "Composite Resources by Status",
        "targets": [
          {
            "expr": "sum by (status) (crossplane_composite_resource_status)"
          }
        ],
        "type": "piechart"
      },
      {
        "title": "Reconciliation Rate",
        "targets": [
          {
            "expr": "rate(crossplane_composite_resource_reconcile_total[5m])",
            "legendFormat": "{{kind}}"
          }
        ],
        "type": "graph"
      },
      {
        "title": "Error Rate",
        "targets": [
          {
            "expr": "rate(crossplane_composite_resource_reconcile_errors_total[5m])",
            "legendFormat": "{{kind}}"
          }
        ],
        "type": "graph"
      },
      {
        "title": "Provider Package Health",
        "targets": [
          {
            "expr": "crossplane_provider_pkg_ready",
            "legendFormat": "{{name}}"
          }
        ],
        "type": "stat"
      }
    ]
  }
}
```

## Usage Examples

### Creating a Database Instance

```yaml
# examples/postgresql-claim.yaml
apiVersion: database.company.com/v1alpha1
kind: PostgreSQLInstance
metadata:
  name: my-app-db
  namespace: my-app
spec:
  parameters:
    size: medium
    version: "15"
    storageGB: 200
    highAvailability: true
    backupRetentionDays: 14
    performanceInsights: true
    deletionProtection: true
    allowedCIDRBlocks:
      - "10.0.0.0/8"
    tags:
      team: backend
      cost-center: engineering
  writeConnectionSecretToRef:
    name: my-app-db-credentials
```

### Deploying Complete Application Stack

```yaml
# examples/application-stack-claim.yaml
apiVersion: platform.company.com/v1alpha1
kind: ApplicationStack
metadata:
  name: payment-service
  namespace: payments
spec:
  parameters:
    environment: production
    region: us-east-1
    applicationName: payment-service
    namespace: payments-prod
    database:
      enabled: true
      engine: postgresql
      size: large
      version: "15"
    cache:
      enabled: true
      engine: redis
      nodeType: cache.r6g.large
    storage:
      enabled: true
      sizeGB: 1000
      versioning: true
    monitoring:
      enabled: true
      alertEmail: payments-team@company.com
  writeConnectionSecretToRef:
    name: payment-service-credentials
```

## Best Practices

### Composition Design Principles

1. **Use Patch Sets**: Reduce duplication with reusable patch sets
2. **Connection Secrets**: Always propagate credentials securely
3. **Readiness Checks**: Define appropriate readiness checks
4. **Default Values**: Provide sensible defaults for all parameters
5. **Validation**: Use OpenAPI schema validation extensively
6. **Documentation**: Annotate XRDs with clear descriptions
7. **Versioning**: Version XRDs and compositions independently
8. **Testing**: Test compositions in non-production environments first

### Security Considerations

```yaml
# Security best practices configuration
apiVersion: pkg.crossplane.io/v1
kind: ControllerConfig
metadata:
  name: secure-controller-config
spec:
  podSecurityContext:
    runAsNonRoot: true
    runAsUser: 2000
    fsGroup: 2000
    seccompProfile:
      type: RuntimeDefault
  securityContext:
    allowPrivilegeEscalation: false
    readOnlyRootFilesystem: true
    capabilities:
      drop:
        - ALL
  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 512Mi
```

## Conclusion

Crossplane transforms Kubernetes into a universal control plane for infrastructure management. Key advantages include:

- **Cloud Agnostic**: Single API for multiple cloud providers
- **Kubernetes Native**: Leverage existing Kubernetes tooling and patterns
- **Self-Service**: Enable developers with guardrails
- **GitOps Compatible**: Declarative infrastructure in version control
- **Extensible**: Custom compositions for organization-specific needs

Success with Crossplane requires careful design of abstractions, comprehensive testing, and strong operational practices for managing the control plane itself.