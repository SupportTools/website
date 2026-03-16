---
title: "Crossplane: Cloud Resource Provisioning with Kubernetes-Native APIs"
date: 2027-04-06T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Crossplane", "Infrastructure as Code", "Cloud Native", "Platform Engineering"]
categories: ["Kubernetes", "Platform Engineering", "Cloud Native"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide to Crossplane for Kubernetes-native cloud resource provisioning, covering provider installation (AWS, GCP, Azure), Composite Resource Definitions, Compositions for team self-service, ProviderConfig credential management, and building an Internal Developer Platform with Backstage integration."
more_link: "yes"
url: "/crossplane-cloud-resource-provisioning-guide/"
---

Terraform popularized infrastructure as code, but it introduced a separate state management problem, a separate reconciliation loop, and a workflow that operates outside the Kubernetes control plane where most platform teams already live. Crossplane takes a different approach: it extends the Kubernetes API with new resource types that directly represent cloud infrastructure, and uses the same controller reconciliation loop that manages Pods and Deployments to manage RDS instances, GKE clusters, and S3 buckets.

The result is an infrastructure provisioning system where `kubectl get` shows the health of both application workloads and their backing cloud resources, where the same GitOps tooling (ArgoCD, Flux) that deploys applications also provisions databases, and where application teams request infrastructure through `CompositeResourceClaim` objects without ever writing a Terraform plan.

This guide covers Crossplane's architecture, provider installation, credential management, Composition authoring, composite resource claims, Composition Functions for complex logic, and an Internal Developer Platform workflow with Backstage.

<!--more-->

## Section 1: Crossplane Architecture

### Core Components

- **crossplane-core**: The central controller that watches `CompositeResource`, `CompositeResourceClaim`, and `Composition` objects. Responsible for binding claims to composites and calling Composition functions.
- **Providers**: Each cloud provider is an independent Crossplane package (an OCI image containing CRDs and a controller). `provider-aws`, `provider-gcp`, and `provider-azure` ship thousands of managed resource CRDs — one per cloud API resource.
- **Composition engine**: The subsystem that takes a `CompositeResource` (the abstract API) and maps it to one or more `ManagedResource` objects (the concrete cloud API calls) using patch-and-transform rules or Composition Functions.

### Resource Hierarchy

```
Team Developer
  └─ Creates: CompositeResourceClaim (XRC) — "I want a PostgreSQL database"
        │
        ▼  (Crossplane binds to a Composite Resource)
     CompositeResource (XR) — abstract representation of the database
        │
        ▼  (Composition renders via patch-and-transform or Functions)
     ManagedResource (e.g. RDSInstance) — actual AWS API call
     ManagedResource (e.g. DBSubnetGroup) — VPC network configuration
     ManagedResource (e.g. SecurityGroup) — firewall rules
```

## Section 2: Installing Crossplane

```bash
# Add the Crossplane Helm chart repository
helm repo add crossplane-stable https://charts.crossplane.io/stable
helm repo update

# Install Crossplane core into its own namespace
helm install crossplane crossplane-stable/crossplane \
  --namespace crossplane-system \
  --create-namespace \
  --version 1.16.0 \
  --set args='{--enable-composition-functions,--enable-composition-revisions}' \
  --wait

# Verify Crossplane pods are running
kubectl get pods -n crossplane-system
# Expected:
# crossplane-XXXXX                       Running
# crossplane-rbac-manager-XXXXX          Running

# List installed Crossplane CRDs
kubectl get crd | grep crossplane.io | head -20
```

## Section 3: Provider Installation

### AWS Provider

```yaml
# provider-aws.yaml — install the AWS provider using the Crossplane provider family pattern
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws-ec2
spec:
  package: xpkg.upbound.io/upbound/provider-aws-ec2:v1.7.0
  packagePullPolicy: IfNotPresent
  revisionActivationPolicy: Automatic
  revisionHistoryLimit: 3
---
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws-rds
spec:
  package: xpkg.upbound.io/upbound/provider-aws-rds:v1.7.0
  packagePullPolicy: IfNotPresent
  revisionActivationPolicy: Automatic
  revisionHistoryLimit: 3
---
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws-s3
spec:
  package: xpkg.upbound.io/upbound/provider-aws-s3:v1.7.0
  packagePullPolicy: IfNotPresent
  revisionActivationPolicy: Automatic
  revisionHistoryLimit: 3
---
# provider-aws-iam.yaml — IAM for role and policy management
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws-iam
spec:
  package: xpkg.upbound.io/upbound/provider-aws-iam:v1.7.0
  packagePullPolicy: IfNotPresent
  revisionActivationPolicy: Automatic
```

### GCP Provider

```yaml
# provider-gcp.yaml
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-gcp-container
spec:
  package: xpkg.upbound.io/upbound/provider-gcp-container:v1.4.0
  packagePullPolicy: IfNotPresent
  revisionActivationPolicy: Automatic
---
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-gcp-sql
spec:
  package: xpkg.upbound.io/upbound/provider-gcp-sql:v1.4.0
  packagePullPolicy: IfNotPresent
  revisionActivationPolicy: Automatic
```

### Azure Provider

```yaml
# provider-azure.yaml
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-azure-sql
spec:
  package: xpkg.upbound.io/upbound/provider-azure-sql:v1.3.0
  packagePullPolicy: IfNotPresent
  revisionActivationPolicy: Automatic
---
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-azure-network
spec:
  package: xpkg.upbound.io/upbound/provider-azure-network:v1.3.0
  packagePullPolicy: IfNotPresent
  revisionActivationPolicy: Automatic
```

```bash
# Wait for providers to become healthy
kubectl get providers
# NAME                    INSTALLED   HEALTHY   PACKAGE                                        AGE
# provider-aws-rds        True        True      xpkg.upbound.io/upbound/provider-aws-rds:...   2m
# provider-aws-ec2        True        True      xpkg.upbound.io/upbound/provider-aws-ec2:...   2m

# List all CRDs installed by the AWS RDS provider
kubectl get crd | grep rds.aws.upbound.io
```

## Section 4: ProviderConfig Credential Management

### AWS with IRSA

The recommended credential approach for EKS is IRSA (IAM Roles for Service Accounts), which eliminates static credentials entirely.

```yaml
# providerconfig-aws-irsa.yaml — uses IRSA; no Secret required
apiVersion: aws.upbound.io/v1beta1
kind: ProviderConfig
metadata:
  name: default   # used automatically when ManagedResources don't specify providerConfigRef
spec:
  credentials:
    source: IRSA   # read credentials from the pod's projected service account token
```

```yaml
# patch for the provider ServiceAccount — annotate with IAM role ARN
# Apply after the provider pod is running
apiVersion: v1
kind: ServiceAccount
metadata:
  name: provider-aws-rds
  namespace: crossplane-system
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/crossplane-rds-provisioner
```

### AWS with Static Credentials (Non-EKS)

```yaml
# secret-aws-credentials.yaml — managed by External Secrets Operator
apiVersion: v1
kind: Secret
metadata:
  name: aws-credentials
  namespace: crossplane-system
type: Opaque
stringData:
  credentials: |
    [default]
    aws_access_key_id = EXAMPLE_ACCESS_KEY_REPLACE_ME
    aws_secret_access_key = EXAMPLE_SECRET_KEY_REPLACE_ME
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
```

### GCP with Workload Identity

```yaml
# providerconfig-gcp-wi.yaml
apiVersion: gcp.upbound.io/v1beta1
kind: ProviderConfig
metadata:
  name: default
spec:
  projectID: my-platform-project
  credentials:
    source: InjectedIdentity   # Workload Identity annotation on the provider SA
```

### Multi-Account ProviderConfig

For multi-account architectures, each ProviderConfig maps to a different AWS account.

```yaml
# providerconfig-aws-prod.yaml — production AWS account
apiVersion: aws.upbound.io/v1beta1
kind: ProviderConfig
metadata:
  name: aws-prod-account
spec:
  credentials:
    source: Secret
    secretRef:
      namespace: crossplane-system
      name: aws-prod-credentials
      key: credentials
---
# providerconfig-aws-staging.yaml — staging AWS account
apiVersion: aws.upbound.io/v1beta1
kind: ProviderConfig
metadata:
  name: aws-staging-account
spec:
  credentials:
    source: Secret
    secretRef:
      namespace: crossplane-system
      name: aws-staging-credentials
      key: credentials
```

## Section 5: Managed Resource CRDs

Managed resources are the lowest-level Crossplane objects — they map 1:1 to cloud API resources.

### RDS Instance Managed Resource

```yaml
# rdsinstance-payments-db.yaml — directly manage an RDS instance
apiVersion: rds.aws.upbound.io/v1beta1
kind: Instance
metadata:
  name: payments-db-prod
  annotations:
    crossplane.io/external-name: payments-db-prod   # the actual AWS resource name
spec:
  forProvider:
    region: us-east-1
    dbInstanceClass: db.r6g.xlarge
    engine: postgres
    engineVersion: "16.2"
    allocatedStorage: 100
    storageType: gp3
    iops: 3000
    storageEncrypted: true
    kmsKeyId: arn:aws:kms:us-east-1:123456789012:key/example-kms-key-id-replace-me
    dbName: payments
    username: payments_admin
    # Password from an External Secret
    passwordSecretRef:
      namespace: crossplane-system
      name: rds-master-password
      key: password
    vpcSecurityGroupIds:
      - sg-0a1b2c3d4e5f6a7b8
    dbSubnetGroupName: payments-db-subnet-group
    multiAz: true
    backupRetentionPeriod: 14
    preferredBackupWindow: "02:00-03:00"
    preferredMaintenanceWindow: "sun:04:00-sun:05:00"
    deletionProtection: true
    finalSnapshotIdentifier: payments-db-prod-final-snapshot
    enabledCloudwatchLogsExports:
      - postgresql
      - upgrade
    performanceInsightsEnabled: true
    performanceInsightsRetentionPeriod: 7
    tags:
      Environment: production
      Team: payments
      ManagedBy: crossplane
  providerConfigRef:
    name: aws-prod-account
  # Publish connection details to a Secret for application consumption
  writeConnectionSecretToRef:
    namespace: payments
    name: payments-db-connection
```

### S3 Bucket Managed Resource

```yaml
# s3bucket-artifacts.yaml
apiVersion: s3.aws.upbound.io/v1beta1
kind: Bucket
metadata:
  name: team-payments-artifacts
  annotations:
    crossplane.io/external-name: team-payments-artifacts-20270401
spec:
  forProvider:
    region: us-east-1
    objectLockEnabled: false
    tags:
      Environment: production
      Team: payments
      ManagedBy: crossplane
  providerConfigRef:
    name: aws-prod-account
---
apiVersion: s3.aws.upbound.io/v1beta1
kind: BucketVersioning
metadata:
  name: team-payments-artifacts-versioning
spec:
  forProvider:
    region: us-east-1
    bucketRef:
      name: team-payments-artifacts
    versioningConfiguration:
      - status: Enabled
  providerConfigRef:
    name: aws-prod-account
---
apiVersion: s3.aws.upbound.io/v1beta1
kind: BucketServerSideEncryptionConfiguration
metadata:
  name: team-payments-artifacts-sse
spec:
  forProvider:
    region: us-east-1
    bucketRef:
      name: team-payments-artifacts
    rule:
      - applyServerSideEncryptionByDefault:
          - sseAlgorithm: aws:kms
            kmsMasterKeyIdRef:
              name: payments-kms-key
  providerConfigRef:
    name: aws-prod-account
```

## Section 6: CompositeResourceDefinition (XRD)

The `CompositeResourceDefinition` defines a new Kubernetes API type that application teams interact with — abstracting away the cloud-specific details.

```yaml
# xrd-postgresql.yaml — defines the XPostgreSQLInstance and PostgreSQLInstanceClaim APIs
apiVersion: apiextensions.crossplane.io/v1
kind: CompositeResourceDefinition
metadata:
  name: xpostgresqlinstances.platform.example.com
spec:
  group: platform.example.com
  names:
    kind: XPostgreSQLInstance
    plural: xpostgresqlinstances
  # ClaimNames defines the namespace-scoped claim type
  claimNames:
    kind: PostgreSQLInstanceClaim
    plural: postgresqlinstanceclaims

  # Connection secret keys that Compositions must publish
  connectionSecretKeys:
    - endpoint
    - port
    - username
    - password
    - dbname

  # Versions define the API schema for each version
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
                  description: Database provisioning parameters
                  properties:
                    storageGB:
                      type: integer
                      description: Storage size in gigabytes
                      minimum: 20
                      maximum: 10000
                      default: 50
                    instanceClass:
                      type: string
                      description: AWS RDS instance class
                      enum:
                        - db.t3.medium
                        - db.r6g.large
                        - db.r6g.xlarge
                        - db.r6g.2xlarge
                      default: db.t3.medium
                    engineVersion:
                      type: string
                      description: PostgreSQL engine version
                      enum: ["14", "15", "16"]
                      default: "16"
                    multiAz:
                      type: boolean
                      description: Enable Multi-AZ deployment
                      default: false
                    region:
                      type: string
                      description: AWS region
                      enum: [us-east-1, eu-west-1, ap-southeast-1]
                      default: us-east-1
                    dbName:
                      type: string
                      description: Initial database name
                      pattern: '^[a-z][a-z0-9_]{0,62}$'
                  required:
                    - storageGB
                    - instanceClass
                    - dbName
```

## Section 7: Composition with Patch-and-Transform

A `Composition` maps a `CompositeResource` to one or more `ManagedResource` objects. Patches transfer values from the composite's spec to the managed resources' forProvider fields.

```yaml
# composition-postgresql-aws.yaml — implements the XPostgreSQLInstance for AWS
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: xpostgresqlinstances.aws.platform.example.com
  labels:
    provider: aws
    environment: production
spec:
  # This Composition satisfies XPostgreSQLInstance claims
  compositeTypeRef:
    apiVersion: platform.example.com/v1alpha1
    kind: XPostgreSQLInstance

  # Publish the connection details from the RDS Instance back to the claim
  writeConnectionSecretsToNamespace: crossplane-system

  resources:
    # Resource 1: The RDS subnet group (prerequisite)
    - name: rds-subnet-group
      base:
        apiVersion: rds.aws.upbound.io/v1beta1
        kind: SubnetGroup
        spec:
          forProvider:
            region: us-east-1
            description: "Subnet group for CrossPlane-managed RDS instances"
            subnetIds:
              - subnet-0a1b2c3d4e5f6a7b1
              - subnet-0a1b2c3d4e5f6a7b2
              - subnet-0a1b2c3d4e5f6a7b3
            tags:
              ManagedBy: crossplane
          providerConfigRef:
            name: aws-prod-account

    # Resource 2: The RDS security group
    - name: rds-security-group
      base:
        apiVersion: ec2.aws.upbound.io/v1beta1
        kind: SecurityGroup
        spec:
          forProvider:
            region: us-east-1
            vpcId: vpc-0a1b2c3d4e5f6a7b8
            description: "Security group for CrossPlane-managed RDS instances"
            tags:
              ManagedBy: crossplane
          providerConfigRef:
            name: aws-prod-account

    # Resource 3: The RDS Instance
    - name: rds-instance
      base:
        apiVersion: rds.aws.upbound.io/v1beta1
        kind: Instance
        spec:
          forProvider:
            region: us-east-1              # overridden by patch below
            dbInstanceClass: db.t3.medium  # overridden by patch below
            engine: postgres
            engineVersion: "16"            # overridden by patch below
            allocatedStorage: 50           # overridden by patch below
            storageType: gp3
            storageEncrypted: true
            username: admin
            passwordSecretRef:
              namespace: crossplane-system
              name: rds-default-password
              key: password
            dbSubnetGroupNameSelector:
              matchControllerRef: true     # pick the SubnetGroup from this same Composition
            vpcSecurityGroupIdSelector:
              matchControllerRef: true     # pick the SecurityGroup from this same Composition
            skipFinalSnapshot: false
            backupRetentionPeriod: 7
            tags:
              ManagedBy: crossplane
          providerConfigRef:
            name: aws-prod-account
          writeConnectionSecretToRef:
            namespace: crossplane-system
            name: ""    # populated by patch below
      # Patches copy values from the CompositeResource to this ManagedResource
      patches:
        # Patch: copy the region from XR spec to forProvider.region
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.region
          toFieldPath: spec.forProvider.region
        # Patch: copy the instanceClass
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.instanceClass
          toFieldPath: spec.forProvider.dbInstanceClass
        # Patch: copy the engineVersion
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.engineVersion
          toFieldPath: spec.forProvider.engineVersion
        # Patch: copy the storageGB and convert to integer
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.storageGB
          toFieldPath: spec.forProvider.allocatedStorage
        # Patch: copy the dbName
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.dbName
          toFieldPath: spec.forProvider.dbName
        # Patch: copy the multiAz flag
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.multiAz
          toFieldPath: spec.forProvider.multiAz
        # Patch: derive the connection secret name from the composite name
        - type: FromCompositeFieldPath
          fromFieldPath: metadata.name
          toFieldPath: spec.writeConnectionSecretToRef.name
          transforms:
            - type: string
              string:
                fmt: "%s-connection"
        # Patch: propagate connection details back to the composite status
        - type: ToCompositeFieldPath
          fromFieldPath: status.atProvider.address
          toFieldPath: status.endpoint
          policy:
            fromFieldPath: Optional
      # Specify which connection detail keys this resource publishes
      connectionDetails:
        - type: FromConnectionSecretKey
          name: endpoint
          fromConnectionSecretKey: endpoint
        - type: FromConnectionSecretKey
          name: port
          fromConnectionSecretKey: port
        - type: FromConnectionSecretKey
          name: username
          fromConnectionSecretKey: username
        - type: FromConnectionSecretKey
          name: password
          fromConnectionSecretKey: password
        - type: Value
          name: dbname
          value: ""    # populated by patch
      readinessChecks:
        - type: MatchString
          fieldPath: status.atProvider.dbInstanceStatus
          matchString: available
```

## Section 8: CompositeResourceClaim (Self-Service)

Application teams interact with Crossplane through namespace-scoped `CompositeResourceClaim` objects. The claim references the XRD API and provides the parameters. Crossplane binds the claim to a `CompositeResource` and starts provisioning.

```yaml
# claim-payments-db.yaml — applied by the payments team in their namespace
apiVersion: platform.example.com/v1alpha1
kind: PostgreSQLInstanceClaim
metadata:
  name: payments-primary-db
  namespace: payments     # claim lives in the team's namespace
spec:
  parameters:
    storageGB: 100
    instanceClass: db.r6g.xlarge
    engineVersion: "16"
    multiAz: true
    region: us-east-1
    dbName: payments
  # Connection details are written to this Secret in the payments namespace
  writeConnectionSecretToRef:
    name: payments-db-connection
  # Optional: pin to a specific Composition if multiple exist (e.g. aws vs gcp)
  compositionSelector:
    matchLabels:
      provider: aws
      environment: production
```

```bash
# Check claim status
kubectl get postgresqlinstanceclaim payments-primary-db -n payments

# Check the composite resource it bound to
kubectl get xpostgresqlinstances -l crossplane.io/claim-name=payments-primary-db

# Check the underlying RDS instance
kubectl get instances.rds.aws.upbound.io \
  -l crossplane.io/composite=payments-primary-db-XXXX

# Read the connection secret (base64 encoded)
kubectl get secret payments-db-connection -n payments -o yaml
kubectl get secret payments-db-connection -n payments \
  -o jsonpath='{.data.endpoint}' | base64 -d
```

## Section 9: Composition Revisions for Safe Rollouts

Composition revisions enable rolling out Composition changes without immediately affecting all existing CompositeResources.

```yaml
# Updated Composition — creates a new revision automatically
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: xpostgresqlinstances.aws.platform.example.com
  labels:
    provider: aws
    environment: production
spec:
  compositeTypeRef:
    apiVersion: platform.example.com/v1alpha1
    kind: XPostgreSQLInstance
  # The revision policy for how existing composites get the update
  # Manual: operator must explicitly update each composite's compositionRevisionRef
  # Automatic: all composites automatically use the latest revision
  revisionPolicy: Manual
  resources: []   # ... same as before but with the updated changes
```

```bash
# List all composition revisions
kubectl get compositionrevisions

# Update a specific composite to use the new revision manually
kubectl patch xpostgresqlinstance payments-primary-db-XXXX \
  --type=merge \
  -p '{"spec":{"compositionRevisionRef":{"name":"xpostgresqlinstances.aws.platform.example.com-REVISION-HASH"}}}'

# After validation, update all composites to the new revision
kubectl get xpostgresqlinstances -o name | xargs -I{} kubectl patch {} \
  --type=merge \
  -p '{"spec":{"compositionRevisionRef":{"name":"xpostgresqlinstances.aws.platform.example.com-REVISION-HASH"}}}'
```

## Section 10: Composition Functions for Complex Logic

Composition Functions allow arbitrary logic to be applied during rendering, enabling conditional resource creation, loops, and external data lookups that patch-and-transform cannot express.

### KCL Function

```yaml
# function-kcl.yaml — install the KCL Composition Function
apiVersion: pkg.crossplane.io/v1beta1
kind: Function
metadata:
  name: function-kcl
spec:
  package: xpkg.upbound.io/crossplane-contrib/function-kcl:v0.10.1
  packagePullPolicy: IfNotPresent
  revisionActivationPolicy: Automatic
```

```yaml
# composition-postgresql-kcl.yaml — Composition using KCL for conditional logic
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: xpostgresqlinstances.kcl.aws.platform.example.com
spec:
  compositeTypeRef:
    apiVersion: platform.example.com/v1alpha1
    kind: XPostgreSQLInstance
  mode: Pipeline    # required for Composition Functions
  pipeline:
    - step: create-rds-resources
      functionRef:
        name: function-kcl
      input:
        apiVersion: krm.kcl.dev/v1alpha1
        kind: KCLInput
        spec:
          target: Resources
          source: |
            # KCL program to generate the RDS instance and associated resources
            import regex

            # Read parameters from the composite resource
            params = option("params") or {}
            oxr = params?.oxr or {}
            spec_params = oxr?.spec?.parameters or {}

            region = spec_params?.region or "us-east-1"
            instance_class = spec_params?.instanceClass or "db.t3.medium"
            storage_gb = spec_params?.storageGB or 50
            multi_az = spec_params?.multiAz or False
            db_name = spec_params?.dbName or "app"
            composite_name = oxr?.metadata?.name or "unnamed"

            # Conditional: use larger backup retention for multi-AZ prod instances
            backup_days = 14 if multi_az else 7

            # Generate the RDS instance resource
            rds_instance = {
              apiVersion = "rds.aws.upbound.io/v1beta1"
              kind = "Instance"
              metadata = {
                name = "${composite_name}-rds"
                annotations = {
                  "crossplane.io/external-name" = "${composite_name}-rds"
                }
              }
              spec = {
                forProvider = {
                  region = region
                  dbInstanceClass = instance_class
                  engine = "postgres"
                  engineVersion = "16.2"
                  allocatedStorage = storage_gb
                  storageType = "gp3"
                  storageEncrypted = True
                  dbName = db_name
                  multiAz = multi_az
                  backupRetentionPeriod = backup_days
                  username = "admin"
                  passwordSecretRef = {
                    namespace = "crossplane-system"
                    name = "rds-default-password"
                    key = "password"
                  }
                  tags = {
                    Environment = "production" if multi_az else "non-production"
                    ManagedBy = "crossplane"
                    CompositeResource = composite_name
                  }
                }
                providerConfigRef = {
                  name = "aws-prod-account"
                }
                writeConnectionSecretToRef = {
                  namespace = "crossplane-system"
                  name = "${composite_name}-connection"
                }
              }
            }

            # Return the list of resources to create
            items = [rds_instance]
```

## Section 11: External-Secrets Integration for Provider Credentials

The External Secrets Operator populates the Kubernetes Secrets that ProviderConfigs reference, pulling values from Vault, AWS Secrets Manager, or GCP Secret Manager.

```yaml
# externalsecret-aws-credentials.yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: aws-credentials
  namespace: crossplane-system
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: vault-secret-store
    kind: ClusterSecretStore
  target:
    name: aws-credentials      # the Secret ProviderConfig references
    creationPolicy: Owner
    template:
      type: Opaque
      data:
        credentials: |
          [default]
          aws_access_key_id = {{ .access_key_id }}
          aws_secret_access_key = {{ .secret_access_key }}
  data:
    - secretKey: access_key_id
      remoteRef:
        key: platform/crossplane/aws-credentials
        property: access_key_id
    - secretKey: secret_access_key
      remoteRef:
        key: platform/crossplane/aws-credentials
        property: secret_access_key
```

## Section 12: Backstage Integration for Self-Service IDP

Platform teams expose Crossplane claims as Backstage software templates, enabling developers to provision infrastructure through a web UI without needing to know about CRDs.

### Backstage Template for PostgreSQL Claim

```yaml
# template-postgresql.yaml — Backstage scaffolder template
apiVersion: scaffolder.backstage.io/v1beta3
kind: Template
metadata:
  name: crossplane-postgresql-database
  title: PostgreSQL Database (AWS RDS)
  description: Provision a managed PostgreSQL database via Crossplane
  tags:
    - database
    - postgresql
    - aws
spec:
  owner: platform-team
  type: infrastructure

  parameters:
    - title: Database Configuration
      required:
        - dbName
        - namespace
        - instanceClass
        - storageGB
      properties:
        dbName:
          title: Database Name
          type: string
          description: Initial database name (lowercase, underscores allowed)
          pattern: '^[a-z][a-z0-9_]{0,62}$'
        namespace:
          title: Target Namespace
          type: string
          description: Kubernetes namespace where the connection Secret will be created
          ui:field: OwnedEntityPicker
          ui:options:
            catalogFilter:
              kind: Component
        instanceClass:
          title: Instance Size
          type: string
          description: RDS instance class
          enum:
            - db.t3.medium
            - db.r6g.large
            - db.r6g.xlarge
          enumNames:
            - "Small (2 vCPU, 4 GB)"
            - "Medium (2 vCPU, 16 GB)"
            - "Large (4 vCPU, 32 GB)"
          default: db.t3.medium
        storageGB:
          title: Storage (GB)
          type: integer
          minimum: 20
          maximum: 1000
          default: 50
        multiAz:
          title: Multi-AZ (Production)
          type: boolean
          default: false

  steps:
    - id: fetch-template
      name: Fetch Crossplane claim template
      action: fetch:template
      input:
        url: ./crossplane-claim-template
        values:
          dbName: ${{ parameters.dbName }}
          namespace: ${{ parameters.namespace }}
          instanceClass: ${{ parameters.instanceClass }}
          storageGB: ${{ parameters.storageGB }}
          multiAz: ${{ parameters.multiAz }}

    - id: create-pr
      name: Open pull request with Crossplane claim
      action: publish:github:pull-request
      input:
        repoUrl: github.com?repo=fleet-infra&owner=example-org
        title: "feat: provision PostgreSQL database ${{ parameters.dbName }} in ${{ parameters.namespace }}"
        branchName: "db-provision/${{ parameters.namespace }}-${{ parameters.dbName }}"
        description: |
          This PR provisions a PostgreSQL RDS instance via Crossplane.

          - Namespace: ${{ parameters.namespace }}
          - Database: ${{ parameters.dbName }}
          - Instance Class: ${{ parameters.instanceClass }}
          - Storage: ${{ parameters.storageGB }} GB
          - Multi-AZ: ${{ parameters.multiAz }}

          Merging this PR will trigger ArgoCD to apply the claim and Crossplane
          to begin provisioning (~5-10 minutes for RDS).
        targetPath: clusters/us-east-1-prod/databases
```

## Section 13: ArgoCD Sync for Drift Reconciliation

ArgoCD applies Crossplane claims from Git and detects if they drift from the declared state.

```yaml
# argocd-app-crossplane-claims.yaml — ArgoCD manages team infrastructure claims
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: team-payments-infrastructure
  namespace: argocd
spec:
  project: team-payments
  source:
    repoURL: https://github.com/example-org/fleet-infra.git
    targetRevision: main
    path: clusters/us-east-1-prod/databases
  destination:
    server: https://kubernetes.default.svc
    namespace: crossplane-system
  syncPolicy:
    automated:
      prune: false        # NEVER prune cloud resources automatically
      selfHeal: true
    syncOptions:
      - ServerSideApply=true
  # Ignore Crossplane status fields that change dynamically
  ignoreDifferences:
    - group: platform.example.com
      kind: XPostgreSQLInstance
      jsonPointers:
        - /status
        - /spec/compositionRevisionRef
    - group: rds.aws.upbound.io
      kind: Instance
      jsonPointers:
        - /status
        - /metadata/annotations/crossplane.io~1external-name
```

### Observing Crossplane Resource Health

```bash
# Overall health of all Crossplane managed resources
kubectl get managed

# Drill into a failing resource
kubectl describe rdsinstance.rds.aws.upbound.io payments-primary-db-XXXX-rds

# Check the Crossplane provider controller logs for errors
kubectl logs -n crossplane-system \
  -l pkg.crossplane.io/revision=provider-aws-rds \
  --since=1h | grep -E "(error|fail|warn)" | tail -50

# Check a claim and trace the full resource tree
kubectl get postgresqlinstanceclaim payments-primary-db -n payments -o yaml
kubectl get xpostgresqlinstances -l crossplane.io/claim-name=payments-primary-db
kubectl get instances.rds.aws.upbound.io -l crossplane.io/composite=payments-primary-db-XXXX

# Force reconciliation of a managed resource
kubectl annotate managed payments-primary-db-XXXX-rds \
  crossplane.io/paused="false" \
  --overwrite

# Import an existing cloud resource into Crossplane management
# 1. Create the ManagedResource manifest with the external-name annotation
# 2. The controller will adopt the existing resource instead of creating a new one
kubectl annotate rdsinstance.rds.aws.upbound.io existing-payments-db \
  crossplane.io/external-name="existing-payments-db" \
  --overwrite
```

## Section 14: Operational Reference

### Common Troubleshooting Commands

```bash
# Check all Crossplane objects and their readiness
kubectl get crossplane    # all Crossplane API objects
kubectl get claim         # all CompositeResourceClaims
kubectl get composite     # all CompositeResources
kubectl get managed       # all ManagedResources (cloud API resources)

# Find why a claim is not binding (common: no matching Composition)
kubectl describe postgresqlinstanceclaim payments-primary-db -n payments \
  | grep -A 5 "Events:"

# Check if the XRD is correctly installed
kubectl get xrd
kubectl describe xrd xpostgresqlinstances.platform.example.com

# List all Compositions and which XRD they satisfy
kubectl get composition \
  -o custom-columns="NAME:.metadata.name,XRD:.spec.compositeTypeRef.kind"

# Pause Crossplane reconciliation for a managed resource (maintenance)
kubectl annotate rdsinstance.rds.aws.upbound.io payments-primary-db-XXXX-rds \
  crossplane.io/paused="true"

# Resume reconciliation
kubectl annotate rdsinstance.rds.aws.upbound.io payments-primary-db-XXXX-rds \
  crossplane.io/paused="false" --overwrite

# Check provider controller logs
kubectl logs -n crossplane-system \
  -l pkg.crossplane.io/revision=provider-aws-rds \
  --since=1h

# Check Crossplane core controller logs
kubectl logs -n crossplane-system \
  -l app=crossplane \
  --since=1h
```

### Deletion Protection

Crossplane will delete the underlying cloud resource when the ManagedResource object is deleted, unless deletion policies are configured.

```yaml
# Protect against accidental deletion via annotation on ManagedResource
metadata:
  annotations:
    crossplane.io/paused: "false"    # not paused, just normal reconciliation
spec:
  # deletionPolicy controls what happens when the K8s object is deleted:
  # Orphan: remove the K8s object but leave the cloud resource
  # Delete: delete both the K8s object and the cloud resource (default)
  deletionPolicy: Orphan
  managementPolicies:
    - Observe   # read-only: Crossplane observes but does not manage the resource
    # Full management options: Create, Delete, Observe, Update, LateInitialize
```

## Summary

Crossplane transforms Kubernetes into a universal control plane for cloud infrastructure. The separation between `CompositeResourceDefinition` (the team-facing API), `Composition` (the rendering logic), and `ManagedResource` (the cloud API call) allows platform teams to evolve the implementation independently of the developer-facing interface. Application teams request infrastructure through a simple namespace-scoped claim that looks no different from requesting a PersistentVolumeClaim — they specify what they need, not how to build it.

Composition Functions extend this model to cover complex cases: conditional resource creation, looping over lists of regions, or incorporating external data that patch-and-transform cannot handle. External Secrets integration removes static credentials from the management cluster. ArgoCD provides the Git-based audit trail and drift detection for both the Compositions (platform team changes) and the Claims (application team requests). Backstage templates wrap the Crossplane API in a user-friendly UI that lets developers provision infrastructure through a web form and a pull request, with the actual cloud resource created automatically when the PR is merged.
