---
title: "Crossplane Infrastructure Provisioning: Compositions, Claims, and Multi-Cloud Patterns"
date: 2027-07-11T00:00:00-05:00
draft: false
tags: ["Crossplane", "Infrastructure as Code", "Kubernetes", "Multi-Cloud", "Platform Engineering"]
categories: ["Platform Engineering", "Kubernetes", "Infrastructure as Code"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Crossplane infrastructure provisioning covering providers, CompositeResourceDefinitions, Compositions with patches, claim-based developer workflows, composition functions, and GitOps integration with ArgoCD."
more_link: "yes"
url: "/crossplane-infrastructure-provisioning-kubernetes-guide/"
---

Crossplane extends Kubernetes with the ability to provision and manage any cloud infrastructure using the same declarative API patterns that govern workloads. By treating infrastructure as Kubernetes resources, Crossplane enables platform teams to define opinionated Compositions that expose developer-friendly claim APIs, while managing the full lifecycle of AWS, GCP, Azure, and Helm-managed resources through the Kubernetes control loop. This guide covers Crossplane's architecture in depth, including providers, CompositeResourceDefinitions, Compositions with complex patching logic, composition functions, and GitOps-driven workflows.

<!--more-->

## Executive Summary

Crossplane's fundamental insight is that the Kubernetes API server — with its reconciliation loops, declarative model, RBAC, audit logging, and controller pattern — is an ideal control plane for infrastructure, not just workloads. By installing providers that speak the APIs of cloud platforms, operators can express infrastructure requirements as Kubernetes custom resources that are automatically reconciled against real cloud state. Compositions wrap these low-level managed resources into developer-facing abstractions, reducing the surface area developers must understand to provision databases, message queues, object storage, and entire application environments.

## Crossplane Architecture

### Control Plane Components

```
crossplane/
├── core                   # Crossplane core controller
├── rbac-manager          # RBAC policy enforcement for claims
└── providers/
    ├── provider-aws       # AWS managed resources
    ├── provider-gcp       # GCP managed resources
    ├── provider-azure     # Azure managed resources
    ├── provider-helm      # Helm releases as resources
    └── provider-kubernetes # Kubernetes objects in remote clusters
```

### Resource Hierarchy

```
XRD (CompositeResourceDefinition)
└── defines the schema for:
    ├── XR (Composite Resource)  ← cluster-scoped, managed by platform
    │   └── instantiated by: Composition
    │       └── creates: Managed Resources (MR)
    │           └── represent: actual cloud resources
    └── Claim ← namespace-scoped, created by developers
        └── references: XR (auto-created from claim)
```

### Reconciliation Flow

```
Developer applies Claim
      ↓
Crossplane creates XR from Claim spec
      ↓
Composition controller selects matching Composition
      ↓
Composition creates/updates Managed Resources
      ↓
Provider controller reconciles MR with cloud API
      ↓
Cloud resource created/updated/deleted
      ↓
Status propagated back up to Claim
```

## Installation

### Crossplane Core Install

```bash
helm repo add crossplane-stable https://charts.crossplane.io/stable
helm repo update

helm upgrade --install crossplane crossplane-stable/crossplane \
  --namespace crossplane-system \
  --create-namespace \
  --set args='{--debug}' \
  --set resourcesCrossplane.limits.cpu=500m \
  --set resourcesCrossplane.limits.memory=512Mi \
  --set resourcesCrossplane.requests.cpu=100m \
  --set resourcesCrossplane.requests.memory=256Mi \
  --wait
```

### Verify Installation

```bash
kubectl get pods -n crossplane-system
# NAME                                       READY   STATUS
# crossplane-7d8d4f9b6c-xvp2q               1/1     Running
# crossplane-rbac-manager-5c8b9f4d8-kzl9m   1/1     Running

kubectl get crds | grep crossplane
# compositeresourcedefinitions.apiextensions.crossplane.io
# compositions.apiextensions.crossplane.io
# providers.pkg.crossplane.io
```

## Provider Configuration

### AWS Provider

```yaml
# providers/provider-aws.yaml
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws-ec2
spec:
  package: xpkg.upbound.io/upbound/provider-aws-ec2:v0.43.0
---
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws-rds
spec:
  package: xpkg.upbound.io/upbound/provider-aws-rds:v0.43.0
---
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws-s3
spec:
  package: xpkg.upbound.io/upbound/provider-aws-s3:v0.43.0
---
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws-elasticache
spec:
  package: xpkg.upbound.io/upbound/provider-aws-elasticache:v0.43.0
```

### AWS ProviderConfig with IRSA

```yaml
# providers/aws-providerconfig.yaml
apiVersion: aws.upbound.io/v1beta1
kind: ProviderConfig
metadata:
  name: default
spec:
  credentials:
    source: InjectedIdentity
---
# IRSA ServiceAccount for Crossplane AWS provider
apiVersion: v1
kind: ServiceAccount
metadata:
  name: upbound-provider-aws
  namespace: crossplane-system
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/crossplane-provider-aws
```

### GCP Provider

```yaml
# providers/provider-gcp.yaml
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-gcp-sql
spec:
  package: xpkg.upbound.io/upbound/provider-gcp-sql:v0.37.0
---
apiVersion: gcp.upbound.io/v1beta1
kind: ProviderConfig
metadata:
  name: default
spec:
  projectID: acme-production-project
  credentials:
    source: InjectedIdentity
```

### Helm Provider

```yaml
# providers/provider-helm.yaml
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-helm
spec:
  package: xpkg.upbound.io/crossplane-contrib/provider-helm:v0.17.0
---
apiVersion: helm.crossplane.io/v1beta1
kind: ProviderConfig
metadata:
  name: default
spec:
  credentials:
    source: InjectedIdentity
```

## CompositeResourceDefinitions (XRDs)

### Application Cache XRD

```yaml
# xrds/xapplicationcache-xrd.yaml
apiVersion: apiextensions.crossplane.io/v1
kind: CompositeResourceDefinition
metadata:
  name: xapplicationcaches.platform.acme.internal
spec:
  group: platform.acme.internal
  names:
    kind: XApplicationCache
    plural: xapplicationcaches
  claimNames:
    kind: ApplicationCache
    plural: applicationcaches
  connectionSecretKeys:
    - host
    - port
    - password
  defaultCompositionRef:
    name: xapplicationcaches-elasticache
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
                  required: [tier, nodeCount]
                  properties:
                    tier:
                      type: string
                      enum: [dev, standard, production]
                      description: Performance tier mapping to instance class
                    nodeCount:
                      type: integer
                      minimum: 1
                      maximum: 6
                      description: Number of cache nodes
                    automaticFailover:
                      type: boolean
                      default: false
                    snapshotRetentionLimit:
                      type: integer
                      default: 1
                      minimum: 0
                      maximum: 35
            status:
              type: object
              properties:
                clusterEndpoint:
                  type: string
                nodeType:
                  type: string
                numCacheClusters:
                  type: integer
```

### Object Storage XRD

```yaml
# xrds/xobjectstorage-xrd.yaml
apiVersion: apiextensions.crossplane.io/v1
kind: CompositeResourceDefinition
metadata:
  name: xobjectstorages.platform.acme.internal
spec:
  group: platform.acme.internal
  names:
    kind: XObjectStorage
    plural: xobjectstorages
  claimNames:
    kind: ObjectStorage
    plural: objectstorages
  connectionSecretKeys:
    - bucketName
    - region
    - endpoint
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
                  required: [region]
                  properties:
                    region:
                      type: string
                      description: AWS region for the bucket
                    versioning:
                      type: boolean
                      default: false
                    lifecycleRules:
                      type: array
                      items:
                        type: object
                        properties:
                          daysToExpire:
                            type: integer
                          storageClass:
                            type: string
                            enum: [STANDARD_IA, GLACIER, DEEP_ARCHIVE]
                    cors:
                      type: boolean
                      default: false
                    public:
                      type: boolean
                      default: false
```

## Compositions with Patches

### RDS PostgreSQL Composition

```yaml
# compositions/composition-rds-postgresql.yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: xapplicationdatabases-rds-postgresql
  labels:
    provider: aws
    engine: postgresql
spec:
  writeConnectionSecretsToNamespace: crossplane-system
  compositeTypeRef:
    apiVersion: platform.acme.internal/v1alpha1
    kind: XApplicationDatabase
  patchSets:
    - name: region-config
      patches:
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.region
          toFieldPath: spec.forProvider.region
          transforms:
            - type: map
              map:
                us: us-east-1
                eu: eu-west-1
                apac: ap-southeast-1

  resources:
    - name: rds-subnet-group
      base:
        apiVersion: rds.aws.upbound.io/v1beta1
        kind: SubnetGroup
        spec:
          forProvider:
            region: us-east-1
            description: Crossplane-managed subnet group
            subnetIdSelector:
              matchLabels:
                purpose: rds
      patches:
        - type: PatchSet
          patchSetName: region-config
        - type: FromCompositeFieldPath
          fromFieldPath: metadata.uid
          toFieldPath: metadata.name
          transforms:
            - type: string
              string:
                fmt: "xp-subnet-%s"

    - name: rds-instance
      base:
        apiVersion: rds.aws.upbound.io/v1beta1
        kind: Instance
        spec:
          forProvider:
            region: us-east-1
            engine: postgres
            engineVersion: "15.4"
            dbName: appdb
            username: appuser
            skipFinalSnapshot: true
            publiclyAccessible: false
            storageType: gp3
            storageEncrypted: true
            deletionProtection: false
            autoMinorVersionUpgrade: true
            dbSubnetGroupNameSelector:
              matchControllerRef: true
          writeConnectionSecretToRef:
            namespace: crossplane-system
      patches:
        - type: PatchSet
          patchSetName: region-config

        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.storageGB
          toFieldPath: spec.forProvider.allocatedStorage

        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.tier
          toFieldPath: spec.forProvider.instanceClass
          transforms:
            - type: map
              map:
                dev: db.t3.micro
                standard: db.t3.medium
                production: db.r6g.xlarge

        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.enableMultiAZ
          toFieldPath: spec.forProvider.multiAZ

        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.backupRetentionDays
          toFieldPath: spec.forProvider.backupRetentionPeriod

        - type: FromCompositeFieldPath
          fromFieldPath: metadata.uid
          toFieldPath: spec.writeConnectionSecretToRef.name
          transforms:
            - type: string
              string:
                fmt: "rds-conn-%s"

        - type: ToCompositeFieldPath
          fromFieldPath: status.atProvider.endpoint
          toFieldPath: status.endpoint

        - type: ToCompositeFieldPath
          fromFieldPath: status.atProvider.address
          toFieldPath: status.connectionDetails.host

      connectionDetails:
        - name: username
          fromFieldPath: spec.forProvider.username
        - name: endpoint
          fromConnectionSecretKey: endpoint
        - name: port
          type: FromValue
          value: "5432"
        - name: password
          fromConnectionSecretKey: password
```

### S3 Bucket Composition with CORS and Lifecycle

```yaml
# compositions/composition-s3-bucket.yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: xobjectstorages-s3
  labels:
    provider: aws
    service: s3
spec:
  compositeTypeRef:
    apiVersion: platform.acme.internal/v1alpha1
    kind: XObjectStorage
  resources:
    - name: s3-bucket
      base:
        apiVersion: s3.aws.upbound.io/v1beta1
        kind: Bucket
        spec:
          forProvider:
            region: us-east-1
            forceDestroy: false
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
                fmt: "acme-%s-bucket"

        - type: ToCompositeFieldPath
          fromFieldPath: metadata.name
          toFieldPath: status.bucketName

    - name: s3-bucket-versioning
      base:
        apiVersion: s3.aws.upbound.io/v1beta1
        kind: BucketVersioning
        spec:
          forProvider:
            region: us-east-1
            bucketSelector:
              matchControllerRef: true
            versioningConfiguration:
              - status: Suspended
      patches:
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.region
          toFieldPath: spec.forProvider.region
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.versioning
          toFieldPath: spec.forProvider.versioningConfiguration[0].status
          transforms:
            - type: map
              map:
                "true": Enabled
                "false": Suspended

    - name: s3-bucket-encryption
      base:
        apiVersion: s3.aws.upbound.io/v1beta1
        kind: BucketServerSideEncryptionConfiguration
        spec:
          forProvider:
            region: us-east-1
            bucketSelector:
              matchControllerRef: true
            rule:
              - applyServerSideEncryptionByDefault:
                  - sseAlgorithm: AES256
      patches:
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.region
          toFieldPath: spec.forProvider.region
```

## Composition Functions

### Function Pipeline Architecture

Composition Functions replace complex patch-and-transform logic with real code:

```yaml
# functions/function-go-templating.yaml
apiVersion: pkg.crossplane.io/v1beta1
kind: Function
metadata:
  name: function-go-templating
spec:
  package: xpkg.upbound.io/crossplane-contrib/function-go-templating:v0.4.0
---
apiVersion: pkg.crossplane.io/v1beta1
kind: Function
metadata:
  name: function-auto-ready
spec:
  package: xpkg.upbound.io/crossplane-contrib/function-auto-ready:v0.2.0
---
apiVersion: pkg.crossplane.io/v1beta1
kind: Function
metadata:
  name: function-patch-and-transform
spec:
  package: xpkg.upbound.io/crossplane-contrib/function-patch-and-transform:v0.4.0
```

### Composition Using Function Pipeline

```yaml
# compositions/composition-application-environment.yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: xapplicationenvironments-standard
spec:
  compositeTypeRef:
    apiVersion: platform.acme.internal/v1alpha1
    kind: XApplicationEnvironment
  mode: Pipeline
  pipeline:
    - step: patch-and-transform
      functionRef:
        name: function-patch-and-transform
      input:
        apiVersion: pt.fn.crossplane.io/v1beta1
        kind: Resources
        resources:
          - name: namespace
            base:
              apiVersion: kubernetes.crossplane.io/v1alpha1
              kind: Object
              spec:
                forProvider:
                  manifest:
                    apiVersion: v1
                    kind: Namespace
                    metadata:
                      labels:
                        managed-by: crossplane
            patches:
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.team
                toFieldPath: spec.forProvider.manifest.metadata.name
                transforms:
                  - type: string
                    string:
                      fmt: "%s-app"

    - step: go-templating
      functionRef:
        name: function-go-templating
      input:
        apiVersion: gotemplating.fn.crossplane.io/v1beta1
        kind: GoTemplate
        source: Inline
        inline:
          template: |
            {{ $team := .observed.composite.resource.spec.parameters.team }}
            {{ $env := .observed.composite.resource.spec.parameters.environment }}
            ---
            apiVersion: kubernetes.crossplane.io/v1alpha1
            kind: Object
            metadata:
              name: {{ $team }}-{{ $env }}-quota
              annotations:
                crossplane.io/composition-resource-name: resource-quota
            spec:
              forProvider:
                manifest:
                  apiVersion: v1
                  kind: ResourceQuota
                  metadata:
                    name: team-quota
                    namespace: {{ $team }}-app
                  spec:
                    hard:
                      {{ if eq $env "production" }}
                      requests.cpu: "16"
                      requests.memory: "32Gi"
                      {{ else if eq $env "staging" }}
                      requests.cpu: "8"
                      requests.memory: "16Gi"
                      {{ else }}
                      requests.cpu: "2"
                      requests.memory: "4Gi"
                      {{ end }}

    - step: automatically-detect-readiness
      functionRef:
        name: function-auto-ready
```

## Claim-Based Developer Workflows

### Full Application Stack Claim

```yaml
# Developer-facing application environment claim
# my-app-environment.yaml
apiVersion: platform.acme.internal/v1alpha1
kind: ApplicationEnvironment
metadata:
  name: payment-service-staging
  namespace: payments
spec:
  parameters:
    team: payments-team
    environment: staging
    region: us
    components:
      database:
        enabled: true
        tier: standard
        storageGB: 50
      cache:
        enabled: true
        tier: standard
        nodeCount: 2
      storage:
        enabled: false
  writeConnectionSecretToRef:
    name: payment-service-staging-credentials
```

### Observing Claim Status

```bash
# Watch claim provisioning
kubectl get applicationenvironment payment-service-staging \
  -n payments -w

# NAME                       SYNCED   READY   CONNECTION-SECRET   AGE
# payment-service-staging    True     False                       30s
# payment-service-staging    True     False                       2m
# payment-service-staging    True     True    payment-creds       5m

# Check composite resource
kubectl get xapplicationenvironment -o wide

# Inspect managed resources
kubectl get managed -o wide | grep payment

# View events for debugging
kubectl describe applicationenvironment payment-service-staging -n payments
```

### Connection Secret Usage in Application

```yaml
# Deployment using Crossplane-provisioned credentials
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-service
  namespace: payments
spec:
  template:
    spec:
      containers:
        - name: payment-service
          image: acme/payment-service:latest
          env:
            - name: DB_HOST
              valueFrom:
                secretKeyRef:
                  name: payment-service-staging-credentials
                  key: endpoint
            - name: DB_USER
              valueFrom:
                secretKeyRef:
                  name: payment-service-staging-credentials
                  key: username
            - name: DB_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: payment-service-staging-credentials
                  key: password
            - name: CACHE_HOST
              valueFrom:
                secretKeyRef:
                  name: payment-service-staging-credentials
                  key: cacheHost
```

## Managed Resource Lifecycle

### Deletion Policy

```yaml
# Protect production resources from accidental deletion
apiVersion: platform.acme.internal/v1alpha1
kind: ApplicationDatabase
metadata:
  name: payments-production-db
  namespace: payments
  annotations:
    crossplane.io/paused: "false"
spec:
  parameters:
    storageGB: 500
    tier: production
    backupRetentionDays: 30
    enableMultiAZ: true
  deletionPolicy: Orphan  # Do not delete cloud resource when claim is deleted
  writeConnectionSecretToRef:
    name: payments-production-db-conn
```

### Resource Pausing

```bash
# Pause reconciliation for maintenance
kubectl annotate xapplicationdatabase payments-production-db \
  crossplane.io/paused=true

# Resume reconciliation
kubectl annotate xapplicationdatabase payments-production-db \
  crossplane.io/paused=false --overwrite
```

### Import Existing Resources

```yaml
# Import an externally-created RDS instance
apiVersion: rds.aws.upbound.io/v1beta1
kind: Instance
metadata:
  name: imported-production-rds
  annotations:
    crossplane.io/external-name: my-existing-rds-identifier
spec:
  deletionPolicy: Orphan
  forProvider:
    region: us-east-1
    engine: postgres
    instanceClass: db.r6g.large
    username: appuser
    dbName: appdb
    skipFinalSnapshot: true
    publiclyAccessible: false
```

## Multi-Cloud Patterns

### Cloud-Agnostic XRD

```yaml
# xrds/xdatabase-multicloud-xrd.yaml
apiVersion: apiextensions.crossplane.io/v1
kind: CompositeResourceDefinition
metadata:
  name: xdatabases.platform.acme.internal
spec:
  group: platform.acme.internal
  names:
    kind: XDatabase
    plural: xdatabases
  claimNames:
    kind: Database
    plural: databases
  connectionSecretKeys:
    - host
    - port
    - username
    - password
    - endpoint
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
                  required: [provider, engine, tier]
                  properties:
                    provider:
                      type: string
                      enum: [aws, gcp, azure]
                    engine:
                      type: string
                      enum: [postgresql, mysql]
                    tier:
                      type: string
                      enum: [dev, standard, production]
                    region:
                      type: string
                    storageGB:
                      type: integer
                      default: 20
```

### Selector-Based Composition Selection

```yaml
# AWS PostgreSQL composition
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: xdatabases-aws-postgresql
  labels:
    provider: aws
    engine: postgresql
spec:
  compositeTypeRef:
    apiVersion: platform.acme.internal/v1alpha1
    kind: XDatabase
  # ... resources ...
---
# GCP CloudSQL composition
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: xdatabases-gcp-postgresql
  labels:
    provider: gcp
    engine: postgresql
spec:
  compositeTypeRef:
    apiVersion: platform.acme.internal/v1alpha1
    kind: XDatabase
  # ... resources ...
```

```yaml
# Developer claim selecting cloud provider
apiVersion: platform.acme.internal/v1alpha1
kind: Database
metadata:
  name: order-db
  namespace: orders
spec:
  compositionSelector:
    matchLabels:
      provider: aws
      engine: postgresql
  parameters:
    provider: aws
    engine: postgresql
    tier: standard
    region: us-east-1
    storageGB: 100
  writeConnectionSecretToRef:
    name: order-db-connection
```

## Dependency Management

### Cross-Resource References

```yaml
# composition with cross-resource dependency
resources:
  - name: vpc
    base:
      apiVersion: ec2.aws.upbound.io/v1beta1
      kind: VPC
      spec:
        forProvider:
          region: us-east-1
          cidrBlock: 10.0.0.0/16

  - name: subnet-a
    base:
      apiVersion: ec2.aws.upbound.io/v1beta1
      kind: Subnet
      spec:
        forProvider:
          region: us-east-1
          availabilityZone: us-east-1a
          cidrBlock: 10.0.1.0/24
          vpcIdSelector:
            matchControllerRef: true

  - name: rds-subnet-group
    base:
      apiVersion: rds.aws.upbound.io/v1beta1
      kind: SubnetGroup
      spec:
        forProvider:
          region: us-east-1
          description: Crossplane RDS subnet group
          subnetIdSelector:
            matchControllerRef: true
```

### Readiness Gates

```yaml
# Ensure RDS is ready before creating parameter group associations
- name: rds-instance
  base:
    apiVersion: rds.aws.upbound.io/v1beta1
    kind: Instance
    spec:
      forProvider:
        region: us-east-1
  readinessChecks:
    - type: MatchTrue
      fieldPath: status.atProvider.dbInstanceStatus
      matchValue: available
    - type: NonEmpty
      fieldPath: status.atProvider.endpoint
```

## GitOps Integration with ArgoCD

### ArgoCD Application for Crossplane XRDs

```yaml
# argocd/applications/crossplane-xrds.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: crossplane-xrds
  namespace: argocd
spec:
  project: platform
  source:
    repoURL: https://github.com/acme/platform-gitops
    targetRevision: main
    path: crossplane/xrds
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
  ignoreDifferences:
    - group: apiextensions.crossplane.io
      kind: CompositeResourceDefinition
      jsonPointers:
        - /spec/conversion
---
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: crossplane-compositions
  namespace: argocd
spec:
  project: platform
  source:
    repoURL: https://github.com/acme/platform-gitops
    targetRevision: main
    path: crossplane/compositions
  destination:
    server: https://kubernetes.default.svc
    namespace: crossplane-system
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

### ApplicationSet for Team Claims

```yaml
# argocd/applicationsets/team-claims.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: team-infrastructure-claims
  namespace: argocd
spec:
  generators:
    - git:
        repoURL: https://github.com/acme/platform-gitops
        revision: main
        directories:
          - path: teams/*/infrastructure
  template:
    metadata:
      name: '{{path.basenameNormalized}}-infrastructure'
    spec:
      project: platform
      source:
        repoURL: https://github.com/acme/platform-gitops
        targetRevision: main
        path: '{{path}}'
      destination:
        server: https://kubernetes.default.svc
        namespace: '{{path.basename}}'
      syncPolicy:
        automated:
          prune: false  # Never auto-prune infrastructure claims
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
```

## Observability and Debugging

### Crossplane Prometheus Metrics

```yaml
# monitoring/servicemonitor-crossplane.yaml
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

### Useful Debugging Commands

```bash
# Check all managed resources and their status
kubectl get managed -o wide

# Find unhealthy resources
kubectl get managed -o jsonpath='{range .items[?(@.status.conditions[0].status!="True")]}{.kind}/{.metadata.name} - {.status.conditions[0].message}{"\n"}{end}'

# Check provider health
kubectl get providers -o wide

# View provider logs
kubectl logs -n crossplane-system \
  -l pkg.crossplane.io/revision=provider-aws-rds \
  --tail=100

# Describe a failing managed resource
kubectl describe instance my-rds-instance

# Check composition events
kubectl describe composition xapplicationdatabases-rds-postgresql

# View XR details with all patches applied
kubectl get xapplicationdatabase -o yaml | \
  yq '.items[0].spec'

# Trace claim to managed resources
CLAIM_UID=$(kubectl get applicationdatabase payment-db -n payments \
  -o jsonpath='{.metadata.uid}')
kubectl get managed -o json | \
  jq ".items[] | select(.metadata.labels[\"crossplane.io/composite\"] == \"$CLAIM_UID\") | .kind + \"/\" + .metadata.name"
```

### Health Check Script

```bash
#!/usr/bin/env bash
# crossplane-health-check.sh
set -euo pipefail

echo "=== Crossplane Health Check ==="

echo ""
echo "--- Provider Status ---"
kubectl get providers -o custom-columns=\
'NAME:.metadata.name,INSTALLED:.status.conditions[?(@.type=="Installed")].status,HEALTHY:.status.conditions[?(@.type=="Healthy")].status'

echo ""
echo "--- Managed Resource Health ---"
TOTAL=$(kubectl get managed --no-headers 2>/dev/null | wc -l)
READY=$(kubectl get managed -o json 2>/dev/null | \
  jq '[.items[] | select(.status.conditions[]? | select(.type=="Ready" and .status=="True"))] | length')
echo "Total: $TOTAL | Ready: $READY | Not Ready: $((TOTAL - READY))"

echo ""
echo "--- Unhealthy Resources ---"
kubectl get managed -o json | \
  jq -r '.items[] | select(.status.conditions[]? | select(.type=="Ready" and .status!="True")) | "\(.kind)/\(.metadata.name): \(.status.conditions[]? | select(.type=="Ready") | .message)"'
```

## Production Considerations

### Provider Resource Limits

```yaml
# Tune provider controller resources for large deployments
apiVersion: pkg.crossplane.io/v1alpha1
kind: ControllerConfig
metadata:
  name: large-provider-config
spec:
  args:
    - --max-reconcile-rate=100
    - --poll-interval=10m
    - --sync-interval=1h
  resources:
    requests:
      cpu: 500m
      memory: 1Gi
    limits:
      cpu: 2000m
      memory: 2Gi
  podSecurityContext:
    runAsUser: 2000
    runAsGroup: 2000
    fsGroup: 2000
```

### Backup and Recovery for Crossplane State

```bash
# Export all XRDs and compositions for backup
kubectl get compositeresourcedefinitions \
  -o yaml > crossplane-xrds-backup.yaml

kubectl get compositions \
  -o yaml > crossplane-compositions-backup.yaml

kubectl get managed \
  -o yaml > crossplane-managed-resources-backup.yaml

# Store in Git
git add crossplane-*-backup.yaml
git commit -m "chore: Crossplane state backup $(date +%Y-%m-%d)"
```

## Summary

Crossplane transforms Kubernetes into a universal control plane for cloud infrastructure by extending it with provider-specific managed resources and platform-defined Compositions. The XRD and Composition model enables platform teams to design developer-friendly claim APIs that hide cloud complexity behind well-defined abstractions, while the reconciliation engine continuously drives actual cloud state toward desired state. Composition Functions unlock arbitrarily complex provisioning logic that goes beyond static patch-and-transform rules. Combined with GitOps workflows via ArgoCD, Crossplane creates an auditable, version-controlled, self-healing infrastructure provisioning system that scales from a single team to a global multi-cloud platform.
