---
title: "Kubernetes Crossplane: Infrastructure as Code with Kubernetes APIs"
date: 2029-06-13T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Crossplane", "Infrastructure as Code", "AWS", "GCP", "Azure", "GitOps"]
categories: ["Kubernetes", "Infrastructure"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Crossplane: providers for AWS, GCP, and Azure, Composite Resource Definitions (XRDs), Compositions, and claim-based workflows for enabling developer self-service infrastructure through Kubernetes APIs."
more_link: "yes"
url: "/kubernetes-crossplane-infrastructure-as-code-apis/"
---

Crossplane transforms Kubernetes into a universal control plane for infrastructure. Instead of managing Terraform state files, running Ansible playbooks, or clicking through cloud consoles, platform teams define cloud resources as Kubernetes custom resources. Developers get self-service infrastructure through familiar `kubectl` workflows. This guide covers Crossplane's architecture, the provider ecosystem, and the Composition model that makes it practical for enterprise platform teams.

<!--more-->

# Kubernetes Crossplane: Infrastructure as Code with Kubernetes APIs

## Why Crossplane

Terraform, Pulumi, and Ansible solve infrastructure management but introduce operational complexity: state file management, drift detection, manual apply workflows, and separate RBAC systems. Crossplane integrates cloud resource management directly into Kubernetes, using the same control loop, RBAC, and GitOps workflows you already operate.

The core insight: a Kubernetes controller that watches a custom resource and reconciles it with a cloud API is functionally identical to a Kubernetes controller that manages a Pod — the cloud resource becomes a first-class Kubernetes object.

```
Traditional IaC:
  Developer → PR → CI → terraform apply → Cloud

Crossplane:
  Developer → kubectl apply → Kubernetes → Cloud
                               (reconcile
                                loop)
```

## Installation

```bash
# Install Crossplane via Helm
helm repo add crossplane-stable https://charts.crossplane.io/stable
helm repo update

helm install crossplane \
    crossplane-stable/crossplane \
    --namespace crossplane-system \
    --create-namespace \
    --version 1.16.0 \
    --set args='{"--enable-composition-revisions","--enable-composition-functions"}'

# Verify installation
kubectl get pods -n crossplane-system
# NAME                                       READY   STATUS
# crossplane-xxx                             1/1     Running
# crossplane-rbac-manager-xxx                1/1     Running

# Install the crossplane CLI
curl -sL https://raw.githubusercontent.com/crossplane/crossplane/main/install.sh | sh
sudo mv crossplane /usr/local/bin/
```

## Providers

Providers are the bridge between Crossplane and cloud APIs. Each provider installs a set of CRDs representing cloud resources and a controller that manages them.

### Installing the AWS Provider

```yaml
# aws-provider.yaml
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws-ec2
spec:
  package: xpkg.upbound.io/upbound/provider-aws-ec2:v1.14.0
  # Provider packages are OCI images containing CRDs + controller
  runtimeConfigRef:
    name: provider-aws-config
---
apiVersion: pkg.crossplane.io/v1beta1
kind: DeploymentRuntimeConfig
metadata:
  name: provider-aws-config
spec:
  deploymentTemplate:
    spec:
      selector: {}
      template:
        spec:
          containers:
          - name: package-runtime
            resources:
              requests:
                cpu: 100m
                memory: 256Mi
              limits:
                memory: 512Mi
```

```bash
kubectl apply -f aws-provider.yaml

# Wait for the provider to be healthy
kubectl wait --for=condition=healthy provider/provider-aws-ec2 --timeout=300s

# See what CRDs the provider installed
kubectl get crds | grep ec2.aws.upbound.io | head -20
```

### Configuring AWS Authentication

```yaml
# method 1: Static credentials (development only)
apiVersion: v1
kind: Secret
metadata:
  name: aws-credentials
  namespace: crossplane-system
type: Opaque
stringData:
  credentials: |
    [default]
    aws_access_key_id = REPLACE_WITH_ACCESS_KEY
    aws_secret_access_key = REPLACE_WITH_SECRET_KEY
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

```yaml
# Method 2: IRSA (IAM Roles for Service Accounts) — recommended for EKS
apiVersion: aws.upbound.io/v1beta1
kind: ProviderConfig
metadata:
  name: default
spec:
  credentials:
    source: IRSA  # Automatically uses the pod's service account token
  # The provider's ServiceAccount must be annotated with the IAM role ARN
  # This is configured via the DeploymentRuntimeConfig
```

### Installing Multiple Provider Families

```yaml
# For Upbound Official Providers (family bundles)
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: upbound-provider-family-aws
spec:
  package: xpkg.upbound.io/upbound/provider-family-aws:v1.14.0
---
# Individual service providers installed by the family
# provider-aws-ec2, provider-aws-rds, provider-aws-s3, provider-aws-iam, etc.
```

## Managed Resources

Managed Resources (MRs) are the direct representation of cloud resources. They map 1:1 to cloud API objects.

### Creating an S3 Bucket

```yaml
apiVersion: s3.aws.upbound.io/v1beta1
kind: Bucket
metadata:
  name: my-app-data-bucket
  annotations:
    crossplane.io/external-name: my-app-data-bucket-prod-abc123  # Actual bucket name
spec:
  forProvider:
    region: us-east-1
    tags:
      Environment: production
      Team: platform
      ManagedBy: crossplane

  # What happens to the cloud resource when this CR is deleted
  deletionPolicy: Delete  # or: Orphan (leave cloud resource, delete CR only)

  providerConfigRef:
    name: default

---
# S3 Bucket versioning as a separate resource
apiVersion: s3.aws.upbound.io/v1beta1
kind: BucketVersioning
metadata:
  name: my-app-data-bucket-versioning
spec:
  forProvider:
    region: us-east-1
    bucketRef:
      name: my-app-data-bucket
    versioningConfiguration:
    - status: Enabled
  providerConfigRef:
    name: default
```

```bash
# Check the status of a managed resource
kubectl describe bucket my-app-data-bucket

# Synced=True means Crossplane successfully reconciled with AWS
# Ready=True means the resource is available

kubectl get bucket my-app-data-bucket -o jsonpath='{.status.conditions}'
```

### Creating an RDS Instance

```yaml
apiVersion: rds.aws.upbound.io/v1beta1
kind: Instance
metadata:
  name: app-database
spec:
  forProvider:
    region: us-east-1
    instanceClass: db.t3.medium
    engine: postgres
    engineVersion: "15.4"
    dbName: appdb
    allocatedStorage: 20
    autoMinorVersionUpgrade: true
    backupRetentionPeriod: 7
    skipFinalSnapshot: false
    finalSnapshotIdentifier: app-database-final-snapshot
    multiAz: true
    storageEncrypted: true
    vpcSecurityGroupIdRefs:
    - name: rds-security-group
    dbSubnetGroupNameRef:
      name: rds-subnet-group

    # Password managed by a Kubernetes Secret
    passwordSecretRef:
      namespace: default
      name: rds-password
      key: password

  writeConnectionSecretToRef:
    namespace: default
    name: app-database-conn  # Connection details written here after provisioning

  providerConfigRef:
    name: default
```

## Composite Resources and Compositions

The real power of Crossplane comes from Compositions — templates that create multiple managed resources from a single higher-level claim. Platform teams define Compositions; developers use Claims.

### Composite Resource Definition (XRD)

An XRD defines a new API type — the interface developers use:

```yaml
# xrd-postgresql.yaml
apiVersion: apiextensions.crossplane.io/v1
kind: CompositeResourceDefinition
metadata:
  name: xpostgresqlinstances.database.platform.io
spec:
  group: database.platform.io
  names:
    kind: XPostgreSQLInstance
    plural: xpostgresqlinstances

  # Claims are namespace-scoped resources that developers create
  claimNames:
    kind: PostgreSQLInstance
    plural: postgresqlinstances

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
            required: [parameters]
            properties:
              parameters:
                type: object
                required: [storageGB, size]
                properties:
                  storageGB:
                    type: integer
                    minimum: 10
                    maximum: 1000
                    description: "Storage size in GB"
                  size:
                    type: string
                    enum: [small, medium, large, xlarge]
                    description: "Database instance size class"
                  version:
                    type: string
                    default: "15"
                    enum: ["14", "15", "16"]
                  multiAZ:
                    type: boolean
                    default: false
          status:
            type: object
            properties:
              endpoint:
                type: string
                description: "Database connection endpoint"
              port:
                type: integer
```

### Composition

The Composition defines how to fulfill an XRD request by creating managed resources:

```yaml
# composition-postgresql-aws.yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: xpostgresqlinstances.aws.database.platform.io
  labels:
    provider: aws
    environment: production
spec:
  compositeTypeRef:
    apiVersion: database.platform.io/v1alpha1
    kind: XPostgreSQLInstance

  # Which fields to publish back to the XR status
  writeConnectionSecretsToNamespace: crossplane-system

  resources:
  # Resource 1: The RDS subnet group
  - name: rds-subnet-group
    base:
      apiVersion: rds.aws.upbound.io/v1beta1
      kind: SubnetGroup
      spec:
        forProvider:
          region: us-east-1
          description: "Managed by Crossplane"
          subnetIdRefs:
          - name: private-subnet-a
          - name: private-subnet-b
        providerConfigRef:
          name: default

  # Resource 2: The RDS instance
  - name: rds-instance
    base:
      apiVersion: rds.aws.upbound.io/v1beta1
      kind: Instance
      spec:
        forProvider:
          region: us-east-1
          engine: postgres
          autoMinorVersionUpgrade: true
          backupRetentionPeriod: 7
          storageEncrypted: true
          publiclyAccessible: false
          dbSubnetGroupNameSelector:
            matchControllerRef: true  # Use the subnet group from this composition
        writeConnectionSecretToRef:
          namespace: crossplane-system
        providerConfigRef:
          name: default

    # Patches transform values from the XR into the managed resource
    patches:
    # Map the 'size' parameter to an instance class
    - type: CombineFromComposite
      combine:
        variables:
        - fromFieldPath: spec.parameters.size
        strategy: string
        string:
          fmt: |
            %s
      toFieldPath: spec.forProvider.instanceClass
      transforms:
      - type: map
        map:
          small:  db.t3.micro
          medium: db.t3.medium
          large:  db.r6g.large
          xlarge: db.r6g.xlarge

    # Map storageGB directly
    - type: FromCompositeFieldPath
      fromFieldPath: spec.parameters.storageGB
      toFieldPath: spec.forProvider.allocatedStorage

    # Map PostgreSQL version
    - type: FromCompositeFieldPath
      fromFieldPath: spec.parameters.version
      toFieldPath: spec.forProvider.engineVersion

    # Map multiAZ
    - type: FromCompositeFieldPath
      fromFieldPath: spec.parameters.multiAZ
      toFieldPath: spec.forProvider.multiAz

    # Write the endpoint back to XR status
    - type: ToCompositeFieldPath
      fromFieldPath: status.atProvider.endpoint
      toFieldPath: status.endpoint

    connectionDetails:
    - type: FromConnectionSecretKey
      fromConnectionSecretKey: username
      name: username
    - type: FromConnectionSecretKey
      fromConnectionSecretKey: password
      name: password
    - type: FromConnectionSecretKey
      fromConnectionSecretKey: endpoint
      name: endpoint
    - type: FromConnectionSecretKey
      fromConnectionSecretKey: port
      name: port
```

### Using Claims

Developers create Claims — they never interact with the Composition or managed resources directly:

```yaml
# Developer creates this in their namespace:
apiVersion: database.platform.io/v1alpha1
kind: PostgreSQLInstance
metadata:
  name: my-app-db
  namespace: my-team-namespace
spec:
  parameters:
    storageGB: 100
    size: medium
    version: "15"
    multiAZ: true
  writeConnectionSecretToRef:
    name: my-app-db-credentials  # Connection details appear here
  compositionSelector:
    matchLabels:
      provider: aws
      environment: production
```

```bash
# Developer workflow
kubectl apply -f my-app-db.yaml

# Watch provisioning progress
kubectl get postgresqlinstance my-app-db -n my-team-namespace -w
# NAME        READY   SYNCED   CONNECTION-SECRET       AGE
# my-app-db   False   True     my-app-db-credentials   30s
# my-app-db   True    True     my-app-db-credentials   4m

# Get the connection secret
kubectl get secret my-app-db-credentials -n my-team-namespace -o jsonpath='{.data.endpoint}' | base64 -d

# Platform team: see all claims across the cluster
kubectl get postgresqlinstances -A
```

## Composition Functions

Composition Functions (Crossplane 1.14+) replace patch-and-transform with Turing-complete composition logic using Go, Python, or any language compiled to a container:

```yaml
# composition-with-functions.yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: xpostgresqlinstances.aws.database.platform.io
spec:
  compositeTypeRef:
    apiVersion: database.platform.io/v1alpha1
    kind: XPostgreSQLInstance

  mode: Pipeline  # Use function pipeline instead of patch-and-transform
  pipeline:
  - step: create-rds-resources
    functionRef:
      name: function-go-templating
    input:
      apiVersion: gotemplating.fn.crossplane.io/v1beta1
      kind: GoTemplate
      source: Inline
      inline:
        template: |
          apiVersion: rds.aws.upbound.io/v1beta1
          kind: Instance
          metadata:
            annotations:
              gotemplating.fn.crossplane.io/composition-resource-name: rds-instance
          spec:
            forProvider:
              region: us-east-1
              engine: postgres
              engineVersion: "{{ .observed.composite.resource.spec.parameters.version }}"
              instanceClass: {{ index (dict "small" "db.t3.micro" "medium" "db.t3.medium" "large" "db.r6g.large") .observed.composite.resource.spec.parameters.size }}
              allocatedStorage: {{ .observed.composite.resource.spec.parameters.storageGB }}
              multiAz: {{ .observed.composite.resource.spec.parameters.multiAZ }}
              storageEncrypted: true
            providerConfigRef:
              name: default

  - step: automatically-detect-ready
    functionRef:
      name: function-auto-ready
```

## Environments and Multi-Cloud

### Environment Configurations

```yaml
# environment-config.yaml — inject environment-specific values into compositions
apiVersion: apiextensions.crossplane.io/v1alpha1
kind: EnvironmentConfig
metadata:
  name: production-aws
data:
  region: us-east-1
  vpcId: vpc-abc12345
  privateSubnetIds:
  - subnet-111aaa
  - subnet-222bbb
  securityGroupId: sg-xxxxxxxxxxx
  kmsKeyArn: arn:aws:kms:us-east-1:123456789012:key/mrk-xxx
```

```yaml
# In the Composition, reference the EnvironmentConfig
spec:
  environment:
    environmentConfigs:
    - type: Selector
      selector:
        matchLabels:
          environment: production
          cloud: aws
  resources:
  - name: rds-instance
    patches:
    # Use the VPC ID from the environment config
    - type: FromEnvironmentFieldPath
      fromFieldPath: vpcId
      toFieldPath: spec.forProvider.vpcId
```

### Multi-Cloud Composition Selection

```yaml
# AWS claim
apiVersion: database.platform.io/v1alpha1
kind: PostgreSQLInstance
metadata:
  name: my-app-db
spec:
  parameters:
    storageGB: 100
    size: medium
  compositionSelector:
    matchLabels:
      provider: aws     # Selects the AWS composition
      environment: prod
---
# GCP claim — same XRD, different composition
apiVersion: database.platform.io/v1alpha1
kind: PostgreSQLInstance
metadata:
  name: my-app-db-gcp
spec:
  parameters:
    storageGB: 100
    size: medium
  compositionSelector:
    matchLabels:
      provider: gcp     # Selects the GCP composition
      environment: prod
```

## GitOps Integration

### ArgoCD with Crossplane

```yaml
# argocd-crossplane-app.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: platform-infrastructure
  namespace: argocd
spec:
  project: platform
  source:
    repoURL: https://git.example.com/platform/infrastructure
    targetRevision: main
    path: crossplane/claims/
  destination:
    server: https://kubernetes.default.svc
  syncPolicy:
    automated:
      prune: false  # CRITICAL: Never auto-delete infrastructure
      selfHeal: true
    syncOptions:
    - CreateNamespace=true
    - ServerSideApply=true
    # Skip deletion of certain resource types
    - PrunePropagationPolicy=foreground
    retry:
      limit: 5
      backoff:
        duration: 30s
        maxDuration: 5m
        factor: 2
```

### Preventing Accidental Deletion

```bash
# Add a finalizer to prevent accidental deletion
kubectl annotate postgresqlinstance my-app-db \
    "argocd.argoproj.io/sync-options=Prune=false"

# Or use Crossplane's deletion policy
# In the Composition's resource definitions:
spec:
  deletionPolicy: Orphan  # Cloud resource survives CR deletion
```

## Observability and Debugging

```bash
# Check composition status
kubectl get composite -A
kubectl get xpostgresqlinstances -A

# Describe a composite resource to see all managed resources
kubectl describe xpostgresqlinstance my-app-db-xxxxx -n crossplane-system

# Check Crossplane logs
kubectl logs -n crossplane-system deployment/crossplane --follow

# Check provider logs
kubectl logs -n crossplane-system \
    -l pkg.crossplane.io/revision=provider-aws-ec2-xxx \
    --follow

# Events on a managed resource
kubectl get events --field-selector reason=CannotObserveExternalResource
kubectl get events --field-selector reason=ReconcileError

# Pause reconciliation (useful for debugging or emergency)
kubectl annotate postgresqlinstance my-app-db \
    crossplane.io/paused=true
```

### Prometheus Metrics

```yaml
# Crossplane exposes metrics on :8080/metrics
# Key metrics:
# crossplane_managed_resource_ready_total{group, version, kind}
# crossplane_managed_resource_synced_total{group, version, kind}
# crossplane_managed_resource_exists_total{group, version, kind}

groups:
- name: crossplane
  rules:
  - alert: CrossplaneResourceNotSynced
    expr: |
      crossplane_managed_resource_synced_total{synced="False"} > 0
    for: 10m
    labels:
      severity: warning
    annotations:
      summary: "Crossplane managed resource not syncing"

  - alert: CrossplaneCompositeNotReady
    expr: |
      crossplane_managed_resource_ready_total{ready="False",kind=~"X.*"} > 0
    for: 15m
    labels:
      severity: warning
```

## Summary

Crossplane unifies infrastructure management under Kubernetes control loops, enabling GitOps workflows, Kubernetes RBAC, and self-service developer platforms without separate IaC toolchains. The XRD and Composition model is the key abstraction: platform teams define the API that developers use (XRD) and implement how to fulfill it (Composition), creating a clean separation between developer experience and infrastructure implementation.

The operational benefits — single audit trail, drift detection via reconciliation, and developer self-service through familiar kubectl workflows — justify the initial investment in defining your Compositions. Start with the resources that developers request most frequently (databases, storage buckets, queues) and build the Composition library incrementally.
