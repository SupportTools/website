---
title: "Crossplane: Infrastructure as Code with Kubernetes APIs"
date: 2027-10-31T00:00:00-05:00
draft: false
tags: ["Crossplane", "Infrastructure as Code", "Kubernetes", "AWS", "GCP"]
categories:
- Kubernetes
- Infrastructure
author: "Matthew Mattox - mmattox@support.tools"
description: "Crossplane providers for AWS, GCP, and Azure, composite resource definitions, compositions, managed resources, claims, RBAC, and building internal developer platforms with Crossplane."
more_link: "yes"
url: "/crossplane-infrastructure-as-code-guide/"
---

Crossplane extends Kubernetes with the ability to provision and manage cloud infrastructure using the same declarative API patterns used for application workloads. Rather than managing Terraform state files, CDK constructs, or CloudFormation templates, Crossplane lets platform teams define infrastructure abstractions as Kubernetes custom resources, enabling application teams to request infrastructure the same way they request deployments -- via `kubectl apply`.

<!--more-->

# Crossplane: Infrastructure as Code with Kubernetes APIs

## The Crossplane Mental Model

Traditional infrastructure-as-code tools work outside Kubernetes. Terraform has its own state management, plan/apply lifecycle, and provider ecosystem. While powerful, this creates a separation: application configurations live in Kubernetes, infrastructure configurations live in Terraform, and teams must manage both systems separately.

Crossplane bridges this gap by implementing infrastructure management as a Kubernetes extension. The core concepts map to familiar Kubernetes patterns:

- **Providers** are analogous to kubectl plugins -- they extend Crossplane with support for specific cloud platforms (AWS, GCP, Azure, etc.)
- **Managed Resources** are analogous to Deployments -- they represent a single piece of cloud infrastructure (an RDS instance, an S3 bucket, a GCS bucket)
- **Composite Resource Definitions (XRDs)** are analogous to CRD definitions -- they define the schema of your custom infrastructure abstractions
- **Compositions** are analogous to controller implementations -- they define how a composite resource is fulfilled using managed resources
- **Claims** are analogous to PersistentVolumeClaims -- application teams create claims to request infrastructure without knowing the underlying implementation

## Installation

### Installing Crossplane

```bash
helm repo add crossplane-stable https://charts.crossplane.io/stable
helm repo update

helm install crossplane crossplane-stable/crossplane \
  --namespace crossplane-system \
  --create-namespace \
  --version 1.15.0 \
  --set args='{"--debug"}' \
  --set metrics.enabled=true
```

### Installing AWS Provider

```yaml
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws-s3
spec:
  package: xpkg.upbound.io/upbound/provider-aws-s3:v0.47.0
  controllerConfigRef:
    name: aws-config
---
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws-rds
spec:
  package: xpkg.upbound.io/upbound/provider-aws-rds:v0.47.0
  controllerConfigRef:
    name: aws-config
---
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws-ec2
spec:
  package: xpkg.upbound.io/upbound/provider-aws-ec2:v0.47.0
  controllerConfigRef:
    name: aws-config
---
apiVersion: pkg.crossplane.io/v1alpha1
kind: ControllerConfig
metadata:
  name: aws-config
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/crossplane-provider-aws
spec:
  podSecurityContext:
    fsGroup: 2000
  securityContext:
    allowPrivilegeEscalation: false
    runAsNonRoot: true
    runAsUser: 2000
```

### AWS ProviderConfig with IRSA

```yaml
apiVersion: aws.upbound.io/v1beta1
kind: ProviderConfig
metadata:
  name: default
spec:
  credentials:
    source: IRSA
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: crossplane-provider-aws
  namespace: crossplane-system
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/crossplane-provider-aws
```

The corresponding IAM role trust policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::123456789012:oidc-provider/oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B716D3041E"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B716D3041E:sub": "system:serviceaccount:crossplane-system:crossplane-provider-aws"
        }
      }
    }
  ]
}
```

### Installing GCP Provider

```yaml
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-gcp-storage
spec:
  package: xpkg.upbound.io/upbound/provider-gcp-storage:v0.41.0
---
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-gcp-sql
spec:
  package: xpkg.upbound.io/upbound/provider-gcp-sql:v0.41.0
---
apiVersion: gcp.upbound.io/v1beta1
kind: ProviderConfig
metadata:
  name: default
spec:
  projectID: my-gcp-project-id
  credentials:
    source: InjectedIdentity
```

## Managed Resources

Managed Resources are direct representations of cloud infrastructure. They are lower-level than Composite Resources and are typically created by Compositions rather than directly by application teams.

### S3 Bucket Managed Resource

```yaml
apiVersion: s3.aws.upbound.io/v1beta1
kind: Bucket
metadata:
  name: my-application-assets
  annotations:
    crossplane.io/external-name: my-application-assets-prod-unique-suffix
spec:
  forProvider:
    region: us-east-1
    serverSideEncryptionConfiguration:
      rule:
        applyServerSideEncryptionByDefault:
          sseAlgorithm: AES256
    versioning:
      enabled: true
    lifecycleRule:
    - id: transition-to-ia
      enabled: true
      transition:
        days: 30
        storageClass: STANDARD_IA
      expiration:
        days: 365
  providerConfigRef:
    name: default
  deletionPolicy: Orphan
```

### RDS PostgreSQL Instance

```yaml
apiVersion: rds.aws.upbound.io/v1beta1
kind: Instance
metadata:
  name: production-postgres
spec:
  forProvider:
    region: us-east-1
    instanceClass: db.t3.medium
    engine: postgres
    engineVersion: "16.1"
    allocatedStorage: 100
    maxAllocatedStorage: 500
    storageType: gp3
    storageEncrypted: true
    dbName: appdb
    username: dbadmin
    passwordSecretRef:
      name: rds-master-password
      namespace: crossplane-system
      key: password
    multiAz: true
    backupRetentionPeriod: 7
    preferredBackupWindow: "03:00-04:00"
    preferredMaintenanceWindow: "sun:04:00-sun:05:00"
    vpcSecurityGroupIdSelector:
      matchLabels:
        crossplane.io/claim-name: production-database
    dbSubnetGroupName: production-db-subnet-group
    deletionProtection: true
    skipFinalSnapshot: false
    finalSnapshotIdentifier: production-postgres-final-snapshot
    applyImmediately: false
    tags:
      environment: production
      team: platform
      managed-by: crossplane
  providerConfigRef:
    name: default
  deletionPolicy: Orphan
```

## Composite Resource Definitions (XRDs)

XRDs define the schema of your custom infrastructure abstractions. They are the API contract between the platform team (who writes Compositions) and the application team (who creates Claims).

### XRD for a Database Service

```yaml
apiVersion: apiextensions.crossplane.io/v1
kind: CompositeResourceDefinition
metadata:
  name: xpostgresqldatabases.platform.company.com
spec:
  group: platform.company.com
  names:
    kind: XPostgreSQLDatabase
    plural: xpostgresqldatabases
  # Namespace-scoped claims
  claimNames:
    kind: PostgreSQLDatabase
    plural: postgresqldatabases

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
                  # Size options abstract away instance types
                  size:
                    type: string
                    enum: [small, medium, large, xlarge]
                    description: "Database size tier"
                  region:
                    type: string
                    enum: [us-east-1, us-west-2, eu-west-1]
                    default: us-east-1
                  storageGB:
                    type: integer
                    minimum: 20
                    maximum: 1000
                    default: 100
                  # High availability option
                  highAvailability:
                    type: boolean
                    default: false
                  # PostgreSQL major version
                  version:
                    type: string
                    enum: ["14", "15", "16"]
                    default: "16"
                  # Database name
                  databaseName:
                    type: string
                    pattern: '^[a-z][a-z0-9_]*$'
                  # Team label for cost allocation
                  teamLabel:
                    type: string
                required:
                - size
                - databaseName
                - teamLabel
            required:
            - parameters
          status:
            type: object
            properties:
              # Platform team exposes the connection string via status
              atProvider:
                type: object
                properties:
                  endpoint:
                    type: string
                  port:
                    type: integer
```

### XRD for an S3 Storage Bucket

```yaml
apiVersion: apiextensions.crossplane.io/v1
kind: CompositeResourceDefinition
metadata:
  name: xobjectstorages.platform.company.com
spec:
  group: platform.company.com
  names:
    kind: XObjectStorage
    plural: xobjectstorages
  claimNames:
    kind: ObjectStorage
    plural: objectstorages

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
                  region:
                    type: string
                    default: us-east-1
                  versioning:
                    type: boolean
                    default: false
                  retentionDays:
                    type: integer
                    minimum: 1
                    maximum: 3650
                    default: 365
                  accessPolicy:
                    type: string
                    enum: [private, read-only-public]
                    default: private
                  teamLabel:
                    type: string
                required:
                - teamLabel
```

## Compositions

Compositions define how XRDs are fulfilled. They map the abstract parameters in a Claim to concrete managed resource configurations.

### Database Composition

```yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: postgresql-aws
  labels:
    provider: aws
    database: postgresql
spec:
  compositeTypeRef:
    apiVersion: platform.company.com/v1alpha1
    kind: XPostgreSQLDatabase

  mode: Pipeline
  pipeline:
  - step: patch-and-transform
    functionRef:
      name: function-patch-and-transform
    input:
      apiVersion: pt.fn.crossplane.io/v1beta1
      kind: Resources
      resources:
      # Create the RDS instance
      - name: rds-instance
        base:
          apiVersion: rds.aws.upbound.io/v1beta1
          kind: Instance
          spec:
            forProvider:
              region: us-east-1
              engine: postgres
              dbName: appdb
              username: dbadmin
              passwordSecretRef:
                namespace: crossplane-system
                key: password
              backupRetentionPeriod: 7
              preferredBackupWindow: "03:00-04:00"
              storageEncrypted: true
              applyImmediately: false
            providerConfigRef:
              name: default
            deletionPolicy: Orphan
        patches:
        # Map size to instance class
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.size
          toFieldPath: spec.forProvider.instanceClass
          transforms:
          - type: map
            map:
              small: db.t3.small
              medium: db.t3.medium
              large: db.r7g.large
              xlarge: db.r7g.xlarge
        # Map region
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.region
          toFieldPath: spec.forProvider.region
        # Map storage
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.storageGB
          toFieldPath: spec.forProvider.allocatedStorage
        # Map HA to multi-AZ
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.highAvailability
          toFieldPath: spec.forProvider.multiAz
        # Map version
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.version
          toFieldPath: spec.forProvider.engineVersion
        # Map database name
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.databaseName
          toFieldPath: spec.forProvider.dbName
        # Tag with team label
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.teamLabel
          toFieldPath: spec.forProvider.tags[team]
        # Set secret name for password from claim name
        - type: FromCompositeFieldPath
          fromFieldPath: metadata.name
          toFieldPath: spec.forProvider.passwordSecretRef.name
          transforms:
          - type: string
            string:
              type: Format
              fmt: "%s-master-password"
        # Export endpoint to status
        - type: ToCompositeFieldPath
          fromFieldPath: status.atProvider.address
          toFieldPath: status.atProvider.endpoint
        - type: ToCompositeFieldPath
          fromFieldPath: status.atProvider.port
          toFieldPath: status.atProvider.port

      # Create the parameter group
      - name: parameter-group
        base:
          apiVersion: rds.aws.upbound.io/v1beta1
          kind: ParameterGroup
          spec:
            forProvider:
              region: us-east-1
              family: postgres16
              parameter:
              - name: log_min_duration_statement
                value: "1000"
              - name: shared_preload_libraries
                value: pg_stat_statements
              - name: log_connections
                value: "1"
            providerConfigRef:
              name: default
        patches:
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.region
          toFieldPath: spec.forProvider.region
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.version
          toFieldPath: spec.forProvider.family
          transforms:
          - type: string
            string:
              type: Format
              fmt: "postgres%s"
```

## Claims: The Application Team Interface

Application teams create Claims to request infrastructure. They never interact with Managed Resources or Compositions directly:

```yaml
# Application team creates this in their namespace
apiVersion: platform.company.com/v1alpha1
kind: PostgreSQLDatabase
metadata:
  name: user-service-db
  namespace: user-service
spec:
  parameters:
    size: medium
    region: us-east-1
    storageGB: 200
    highAvailability: true
    version: "16"
    databaseName: users
    teamLabel: user-service-team
  # Where Crossplane should write the connection details
  writeConnectionSecretToRef:
    name: user-service-db-connection
```

After the Composition provisions the infrastructure, the connection secret is available:

```bash
kubectl get secret user-service-db-connection -n user-service -o yaml
# Contains: endpoint, port, username, password
```

## RBAC for Multi-Tenant Access

Restrict which teams can create which claim types:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: crossplane-claim-developer
rules:
# Allow creating and managing Claims (but not Composite Resources or Managed Resources)
- apiGroups: ["platform.company.com"]
  resources: ["postgresqldatabases", "objectstorages"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: crossplane-claim-admin
rules:
- apiGroups: ["platform.company.com"]
  resources: ["xpostgresqldatabases", "xobjectstorages"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: ["apiextensions.crossplane.io"]
  resources: ["compositions", "compositeresourcedefinitions"]
  verbs: ["get", "list", "watch"]
---
# Bind developer role to application teams
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: crossplane-claims-developer
  namespace: user-service
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: crossplane-claim-developer
subjects:
- kind: Group
  name: user-service-team
  apiGroup: rbac.authorization.k8s.io
```

## Observing Infrastructure State

```bash
# List all managed resources and their sync status
kubectl get managed

# Check a specific claim's status
kubectl describe postgresqldatabase user-service-db -n user-service

# Check the composite resource created by the claim
kubectl get xpostgresqldatabase

# Check managed resources created by the composition
kubectl get instances.rds.aws.upbound.io

# Check for errors across all crossplane resources
kubectl get crossplane 2>/dev/null || \
  kubectl get managed -o jsonpath='{range .items[?(@.status.conditions[?(@.type=="Synced")].status=="False")]}{.kind}{"\t"}{.metadata.name}{"\t"}{.status.conditions[?(@.type=="Synced")].message}{"\n"}{end}'
```

## Drift Detection and Remediation

Crossplane continuously reconciles managed resources to match the desired state. If someone changes an RDS instance manually in the AWS console, Crossplane will detect the drift and revert it (unless `managementPolicies` is configured otherwise).

```yaml
apiVersion: rds.aws.upbound.io/v1beta1
kind: Instance
metadata:
  name: production-postgres
spec:
  # Management policies control what Crossplane can do with this resource
  managementPolicies:
  # Observe: Crossplane observes but does not create/update/delete
  # - Observe
  # Create, Observe: Crossplane creates if not exists, then observes
  # - Create
  # - Observe
  # Full management (default): Crossplane manages the full lifecycle
  - Create
  - Update
  - Observe
  - Delete
  forProvider:
    region: us-east-1
    # ...
```

## Conclusion

Crossplane fundamentally changes how platform teams expose infrastructure to application developers. By modeling infrastructure as Kubernetes resources with well-defined schemas, platform teams can build self-service portals where developers provision databases, storage buckets, and message queues the same way they deploy applications -- through Git pull requests and `kubectl apply`.

The key to a successful Crossplane adoption is investing time in good XRD design. Well-designed abstractions hide cloud-specific complexity (instance types, availability zone counts, storage classes) behind simple, meaningful parameters (size tiers, HA flags, storage in gigabytes). Application teams should never need to understand AWS instance pricing to request a database.

As your Crossplane platform matures, consider building a backstage.io integration to provide a graphical catalog of available infrastructure types, making the self-service model accessible to teams that prefer a UI over direct kubectl interaction.

## Advanced Composition Patterns

### Environment-Specific Compositions

Production deployments often need different configurations per environment. Use Composition labels and EnvironmentConfigs to handle this:

```yaml
apiVersion: apiextensions.crossplane.io/v1alpha1
kind: EnvironmentConfig
metadata:
  name: production
data:
  accountID: "123456789012"
  vpcID: vpc-0a1b2c3d4e5f6g7h8
  privateSubnetIDs:
  - subnet-0a1b2c3d4e5f6g7h8
  - subnet-1a2b3c4d5e6f7g8h9
  dbSubnetGroupName: production-db-subnet-group
  securityGroupID: sg-0a1b2c3d4e5f6g7h8
---
apiVersion: apiextensions.crossplane.io/v1alpha1
kind: EnvironmentConfig
metadata:
  name: staging
data:
  accountID: "987654321098"
  vpcID: vpc-staging-id
  privateSubnetIDs:
  - subnet-staging-1
  - subnet-staging-2
  dbSubnetGroupName: staging-db-subnet-group
  securityGroupID: sg-staging-id
```

Reference environment config in a Composition:

```yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: postgresql-aws-with-env
spec:
  compositeTypeRef:
    apiVersion: platform.company.com/v1alpha1
    kind: XPostgreSQLDatabase
  environment:
    environmentConfigs:
    - type: Reference
      ref:
        name: production
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
        patches:
        # Pull subnet group from environment config
        - type: FromEnvironmentFieldPath
          fromFieldPath: dbSubnetGroupName
          toFieldPath: spec.forProvider.dbSubnetGroupName
        # Pull security group from environment config
        - type: FromEnvironmentFieldPath
          fromFieldPath: securityGroupID
          toFieldPath: spec.forProvider.vpcSecurityGroupIds[0]
```

### Composition Functions

For complex logic that patches cannot express, Composition Functions allow arbitrary Go/Python code to run during composition:

```yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: postgresql-with-functions
spec:
  compositeTypeRef:
    apiVersion: platform.company.com/v1alpha1
    kind: XPostgreSQLDatabase
  mode: Pipeline
  pipeline:
  # Step 1: Generate a unique bucket name using a function
  - step: generate-names
    functionRef:
      name: function-go-templating
    input:
      apiVersion: gotemplating.fn.crossplane.io/v1beta1
      kind: GoTemplate
      source: Inline
      inline:
        template: |
          apiVersion: pt.fn.crossplane.io/v1beta1
          kind: Resources
          resources:
          - name: rds-instance
            base:
              apiVersion: rds.aws.upbound.io/v1beta1
              kind: Instance
              metadata:
                annotations:
                  crossplane.io/external-name: {{ .observed.composite.resource.metadata.name }}-{{ .observed.composite.resource.spec.parameters.region }}
              spec:
                forProvider:
                  region: {{ .observed.composite.resource.spec.parameters.region }}
                  engine: postgres
                  engineVersion: {{ .observed.composite.resource.spec.parameters.version | default "16" }}.0

  # Step 2: Standard patching
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
            forProvider: {}
        patches:
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.size
          toFieldPath: spec.forProvider.instanceClass
          transforms:
          - type: map
            map:
              small: db.t3.small
              medium: db.t3.medium
              large: db.r7g.large
              xlarge: db.r7g.xlarge
```

## Upbound Universal Crossplane (UXP)

For enterprise deployments, Upbound offers Universal Crossplane (UXP), which adds:

- Enhanced provider management and version control
- Upbound Console for visual resource management
- Commercial support and SLAs
- Access to Upbound Marketplace for certified providers

```bash
# Install UXP instead of open-source Crossplane
curl -sL "https://cli.upbound.io" | sh
up uxp install
```

## GitOps Integration

Crossplane resources are Kubernetes objects, making them naturally GitOps-compatible. Store your XRDs, Compositions, and Providers in Git and sync with Argo CD:

```yaml
# Argo CD Application for Crossplane configuration
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: crossplane-platform
  namespace: argocd
spec:
  project: infrastructure
  source:
    repoURL: https://github.com/company/platform-config.git
    targetRevision: main
    path: crossplane
    directory:
      recurse: true
  destination:
    server: https://kubernetes.default.svc
    namespace: crossplane-system
  syncPolicy:
    automated:
      prune: false
      selfHeal: true
    syncOptions:
    - CreateNamespace=true
    - ApplyOutOfSyncOnly=true
    retry:
      limit: 5
      backoff:
        duration: 5s
        factor: 2
        maxDuration: 3m
```

Directory structure for a GitOps-managed Crossplane platform:

```
crossplane/
  providers/
    provider-aws-s3.yaml
    provider-aws-rds.yaml
    provider-gcp-storage.yaml
  provider-configs/
    aws-default.yaml
    gcp-default.yaml
  xrds/
    xpostgresqldatabase.yaml
    xobjectstorage.yaml
    xmessagequeue.yaml
  compositions/
    postgresql-aws.yaml
    postgresql-gcp.yaml
    s3-storage.yaml
    gcs-storage.yaml
  environment-configs/
    production.yaml
    staging.yaml
    development.yaml
```

Application team repositories store Claims:

```
app-team-repo/
  infrastructure/
    database.yaml    # PostgreSQLDatabase claim
    storage.yaml     # ObjectStorage claim
  kubernetes/
    deployment.yaml
    service.yaml
```

## Monitoring Crossplane

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: crossplane-alerts
  namespace: monitoring
spec:
  groups:
  - name: crossplane
    rules:
    - alert: CrossplaneResourceNotSynced
      expr: |
        crossplane_managed_resource_ready{ready="False"} > 0
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "Crossplane managed resource {{ $labels.name }} not ready"
        description: "Managed resource {{ $labels.name }} of kind {{ $labels.kind }} has been not ready for 10 minutes."

    - alert: CrossplaneProviderUnhealthy
      expr: |
        crossplane_provider_healthy == 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Crossplane provider {{ $labels.name }} is unhealthy"
        description: "Provider {{ $labels.name }} is not healthy. Cloud resource reconciliation may be impaired."

    - alert: CrossplaneClaimNotBound
      expr: |
        crossplane_claim_ready{ready="False"} > 0
      for: 15m
      labels:
        severity: warning
      annotations:
        summary: "Crossplane claim {{ $labels.name }} not bound"
        description: "Claim {{ $labels.name }} in namespace {{ $labels.namespace }} has not been bound for 15 minutes. Check the composition for errors."
```

## Dealing with Existing Infrastructure (Import)

For teams migrating to Crossplane from manual infrastructure management or Terraform, you can import existing resources by setting the `crossplane.io/external-name` annotation to the existing resource's identifier:

```yaml
apiVersion: s3.aws.upbound.io/v1beta1
kind: Bucket
metadata:
  name: existing-company-bucket
  annotations:
    # Tell Crossplane this already exists - use the actual AWS bucket name
    crossplane.io/external-name: existing-company-bucket-prod
spec:
  forProvider:
    region: us-east-1
    serverSideEncryptionConfiguration:
      rule:
        applyServerSideEncryptionByDefault:
          sseAlgorithm: AES256
  providerConfigRef:
    name: default
  # Orphan prevents deletion if Crossplane resource is deleted
  deletionPolicy: Orphan
```

Crossplane will import the existing resource and begin managing it. Any differences between the desired spec and the actual resource state will trigger an update to bring the resource into compliance.

## Cost Governance with Compositions

Use Compositions to enforce cost governance policies by limiting what resources application teams can create:

```yaml
# XRD that only allows cost-conscious configurations
apiVersion: apiextensions.crossplane.io/v1
kind: CompositeResourceDefinition
metadata:
  name: xdevelopmentdatabases.platform.company.com
spec:
  group: platform.company.com
  names:
    kind: XDevelopmentDatabase
    plural: xdevelopmentdatabases
  claimNames:
    kind: DevelopmentDatabase
    plural: developmentdatabases
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
                  # Intentionally limited options to control costs
                  storageGB:
                    type: integer
                    minimum: 20
                    maximum: 100
                    default: 20
                  teamLabel:
                    type: string
                required:
                - teamLabel
```

The corresponding Composition hard-codes cost-optimized settings:

```yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: development-postgresql-aws
spec:
  compositeTypeRef:
    apiVersion: platform.company.com/v1alpha1
    kind: XDevelopmentDatabase
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
              engineVersion: "16.1"
              # Hard-coded to development-appropriate size
              instanceClass: db.t3.micro
              # No multi-AZ for development
              multiAz: false
              # No deletion protection for development
              deletionProtection: false
              # Short backup retention for development
              backupRetentionPeriod: 1
              tags:
                environment: development
                cost-center: engineering-development
            providerConfigRef:
              name: default
            deletionPolicy: Delete
        patches:
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.storageGB
          toFieldPath: spec.forProvider.allocatedStorage
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.teamLabel
          toFieldPath: spec.forProvider.tags[team]
```

## Conclusion (Extended)

Crossplane represents a maturation of infrastructure management thinking. Rather than treating Kubernetes and cloud infrastructure as separate concerns managed by separate tools, Crossplane unifies them under a single control plane. Platform teams gain a powerful abstraction layer for defining company-standard infrastructure, and application teams gain a self-service model that eliminates infrastructure as a bottleneck.

The path to a mature Crossplane platform requires investment in XRD design, Composition implementation, and governance policies. Start with one well-designed abstraction (a database claim type is often the best starting point), validate it works well for several teams, then expand the abstraction catalog. Resist the temptation to expose every cloud configuration option through your XRDs -- the power of Crossplane comes from hiding complexity, not from mirroring it.
