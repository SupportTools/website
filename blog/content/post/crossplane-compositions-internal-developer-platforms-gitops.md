---
title: "Crossplane Compositions: Building Internal Developer Platforms with GitOps"
date: 2030-07-16T00:00:00-05:00
draft: false
tags: ["Crossplane", "Kubernetes", "GitOps", "IDP", "AWS", "GCP", "Azure", "Infrastructure as Code"]
categories:
- Kubernetes
- DevOps
- Infrastructure
author: "Matthew Mattox - mmattox@support.tools"
description: "Production Crossplane guide covering Composition and CompositeResourceDefinition design, managed resources for AWS/GCP/Azure, XR claim workflows, composition functions, and building self-service infrastructure portals."
more_link: "yes"
url: "/crossplane-compositions-internal-developer-platforms-gitops/"
---

Crossplane extends Kubernetes into a universal control plane for infrastructure provisioning. By expressing cloud resources as Kubernetes objects, infrastructure teams can build Internal Developer Platforms (IDPs) where application teams request databases, message queues, and networking resources through familiar Kubernetes APIs without needing cloud provider credentials or deep infrastructure knowledge. Compositions provide the abstraction layer that translates high-level developer requests into the specific managed resources required by each cloud provider.

<!--more-->

## Architecture Overview

Crossplane introduces four key concepts:

- **Managed Resources (MRs)**: Kubernetes CRDs that map 1:1 to cloud provider resources (e.g., `RDSInstance`, `GKECluster`, `StorageAccount`)
- **Composite Resource Definitions (XRDs)**: Define custom API schemas that application teams use to request infrastructure
- **Compositions**: Map XRDs to one or more managed resources, implementing the infrastructure abstraction
- **Claims**: Namespace-scoped objects that application teams create to request infrastructure defined by an XRD

This separation allows platform teams to evolve the underlying implementation (e.g., switch from one RDS configuration to another) without changing the API surface exposed to developers.

## Installation

### Installing Crossplane

```bash
helm repo add crossplane-stable https://charts.crossplane.io/stable
helm repo update

helm install crossplane crossplane-stable/crossplane \
  --namespace crossplane-system \
  --create-namespace \
  --version 1.16.0 \
  --set args='{"--enable-composition-functions","--enable-composition-function-runtime-docker"}' \
  --set resourcesCrossplane.limits.cpu=2000m \
  --set resourcesCrossplane.limits.memory=2Gi \
  --set resourcesCrossplane.requests.cpu=500m \
  --set resourcesCrossplane.requests.memory=512Mi

kubectl rollout status deploy/crossplane -n crossplane-system
```

### Installing Cloud Providers

```bash
# Install AWS provider family
cat <<EOF | kubectl apply -f -
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws-s3
spec:
  package: xpkg.upbound.io/upbound/provider-aws-s3:v1.2.0
  runtimeConfigRef:
    name: provider-aws-config
---
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws-rds
spec:
  package: xpkg.upbound.io/upbound/provider-aws-rds:v1.2.0
  runtimeConfigRef:
    name: provider-aws-config
---
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws-ec2
spec:
  package: xpkg.upbound.io/upbound/provider-aws-ec2:v1.2.0
  runtimeConfigRef:
    name: provider-aws-config
EOF

# Verify provider installation
kubectl get providers
kubectl get crds | grep aws | wc -l
```

### AWS Provider Authentication with IRSA

```yaml
# Provider configuration using IAM Roles for Service Accounts
apiVersion: aws.upbound.io/v1beta1
kind: ProviderConfig
metadata:
  name: aws-us-east-1
spec:
  credentials:
    source: IRSA
  region: us-east-1
---
# Runtime config for the provider pods
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
          serviceAccountName: crossplane-aws-provider
          containers:
            - name: package-runtime
              resources:
                requests:
                  cpu: 500m
                  memory: 512Mi
                limits:
                  cpu: 1000m
                  memory: 1Gi
```

```bash
# Create IRSA service account
eksctl create iamserviceaccount \
  --name crossplane-aws-provider \
  --namespace crossplane-system \
  --cluster prod-us-east-1 \
  --attach-policy-arn arn:aws:iam::aws:policy/AdministratorAccess \
  --approve \
  --region us-east-1
```

## Designing Composite Resource Definitions

### A Database XRD for Application Teams

The XRD defines the schema that developers interact with. It should expose only the parameters relevant to the developer's decision-making:

```yaml
apiVersion: apiextensions.crossplane.io/v1
kind: CompositeResourceDefinition
metadata:
  name: xpostgresqlinstances.platform.example.com
spec:
  group: platform.example.com
  names:
    kind: XPostgresqlInstance
    plural: xpostgresqlinstances
  claimNames:
    kind: PostgresqlInstance
    plural: postgresqlinstances
  connectionSecretKeys:
    - username
    - password
    - endpoint
    - port
    - dbname
  defaultCompositionRef:
    name: xpostgresqlinstances-aws
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
                    - instanceSize
                  properties:
                    storageGB:
                      type: integer
                      minimum: 20
                      maximum: 16384
                      description: "Storage size in GiB"
                    instanceSize:
                      type: string
                      enum: ["small", "medium", "large", "xlarge"]
                      description: "Instance size tier"
                    engineVersion:
                      type: string
                      default: "15.4"
                      enum: ["14.10", "15.4", "16.1"]
                    multiAZ:
                      type: boolean
                      default: false
                      description: "Enable Multi-AZ deployment"
                    backupRetentionDays:
                      type: integer
                      default: 7
                      minimum: 1
                      maximum: 35
                    databases:
                      type: array
                      items:
                        type: string
                      description: "List of databases to create"
                    maintenanceWindow:
                      type: string
                      default: "Mon:03:00-Mon:04:00"
                      description: "Maintenance window in AWS format"
              required:
                - parameters
```

### Applying the XRD and Verifying

```bash
kubectl apply -f xpostgresqlinstances-xrd.yaml

# Wait for XRD to become established
kubectl wait xrd xpostgresqlinstances.platform.example.com \
  --for=condition=Established \
  --timeout=60s

# Verify CRDs were created
kubectl get crd | grep platform.example.com
# xpostgresqlinstances.platform.example.com
# postgresqlinstances.platform.example.com
```

## Building Compositions

### AWS RDS Composition

```yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: xpostgresqlinstances-aws
  labels:
    provider: aws
    environment: production
spec:
  compositeTypeRef:
    apiVersion: platform.example.com/v1alpha1
    kind: XPostgresqlInstance
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
          # RDS Subnet Group
          - name: rds-subnet-group
            base:
              apiVersion: rds.aws.upbound.io/v1beta1
              kind: SubnetGroup
              spec:
                forProvider:
                  region: us-east-1
                  description: "Crossplane-managed subnet group"
                  subnetIds:
                    - subnet-0123456789abcdef0
                    - subnet-0fedcba9876543210
                providerConfigRef:
                  name: aws-us-east-1
            patches:
              - type: FromCompositeFieldPath
                fromFieldPath: metadata.name
                toFieldPath: metadata.name
                transforms:
                  - type: string
                    string:
                      type: Format
                      fmt: "%s-subnet-group"

          # RDS Parameter Group
          - name: rds-parameter-group
            base:
              apiVersion: rds.aws.upbound.io/v1beta1
              kind: ParameterGroup
              spec:
                forProvider:
                  region: us-east-1
                  description: "Crossplane-managed parameter group"
                  parameter:
                    - name: log_connections
                      value: "1"
                    - name: log_min_duration_statement
                      value: "1000"
                    - name: shared_preload_libraries
                      value: pg_stat_statements,auto_explain
                    - name: max_connections
                      value: "200"
                providerConfigRef:
                  name: aws-us-east-1
            patches:
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.engineVersion
                toFieldPath: spec.forProvider.family
                transforms:
                  - type: string
                    string:
                      type: Format
                      fmt: "postgres%s"
                  - type: string
                    string:
                      type: TrimSuffix
                      trim: ".4"
                  - type: string
                    string:
                      type: TrimSuffix
                      trim: ".10"
                  - type: string
                    string:
                      type: TrimSuffix
                      trim: ".1"

          # RDS Instance
          - name: rds-instance
            base:
              apiVersion: rds.aws.upbound.io/v1beta1
              kind: Instance
              spec:
                forProvider:
                  region: us-east-1
                  engine: postgres
                  autoGeneratePassword: true
                  username: pgadmin
                  skipFinalSnapshot: false
                  applyImmediately: false
                  deletionProtection: true
                  storageType: gp3
                  storageEncrypted: true
                  publiclyAccessible: false
                  copyTagsToSnapshot: true
                  enabledCloudwatchLogsExports:
                    - postgresql
                    - upgrade
                  performanceInsightsEnabled: true
                  performanceInsightsRetentionPeriod: 7
                  tags:
                    ManagedBy: crossplane
                    Environment: production
                writeConnectionSecretToRef:
                  namespace: crossplane-system
                providerConfigRef:
                  name: aws-us-east-1
            patches:
              # Map instanceSize to AWS instance class
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.instanceSize
                toFieldPath: spec.forProvider.instanceClass
                transforms:
                  - type: map
                    map:
                      small: db.t3.medium
                      medium: db.r7g.large
                      large: db.r7g.2xlarge
                      xlarge: db.r7g.4xlarge

              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.storageGB
                toFieldPath: spec.forProvider.allocatedStorage

              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.engineVersion
                toFieldPath: spec.forProvider.engineVersion

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
                fromFieldPath: metadata.name
                toFieldPath: spec.forProvider.dbSubnetGroupNameRef.name
                transforms:
                  - type: string
                    string:
                      type: Format
                      fmt: "%s-subnet-group"

              - type: FromCompositeFieldPath
                fromFieldPath: metadata.name
                toFieldPath: spec.forProvider.parameterGroupNameRef.name

              # Generate connection secret name from XR name
              - type: FromCompositeFieldPath
                fromFieldPath: metadata.name
                toFieldPath: spec.writeConnectionSecretToRef.name
                transforms:
                  - type: string
                    string:
                      type: Format
                      fmt: "%s-connection"

              # Propagate connection details to XR
              - type: ToCompositeFieldPath
                fromFieldPath: status.atProvider.address
                toFieldPath: status.endpoint

              - type: ToCompositeFieldPath
                fromFieldPath: status.atProvider.port
                toFieldPath: status.port

            connectionDetails:
              - name: username
                fromConnectionSecretKey: username
              - name: password
                fromConnectionSecretKey: password
              - name: endpoint
                fromFieldPath: status.atProvider.address
              - name: port
                type: Value
                value: "5432"
              - name: dbname
                type: Value
                value: postgres

          # CloudWatch Alarm for high CPU
          - name: cpu-alarm
            base:
              apiVersion: cloudwatch.aws.upbound.io/v1beta1
              kind: MetricAlarm
              spec:
                forProvider:
                  region: us-east-1
                  metricName: CPUUtilization
                  namespace: AWS/RDS
                  statistic: Average
                  period: 300
                  evaluationPeriods: 2
                  threshold: 80
                  comparisonOperator: GreaterThanThreshold
                  alarmActions:
                    - "arn:aws:sns:us-east-1:123456789012:platform-alerts"
                providerConfigRef:
                  name: aws-us-east-1
            patches:
              - type: FromCompositeFieldPath
                fromFieldPath: metadata.name
                toFieldPath: spec.forProvider.dimensions[0].value
              - type: FromCompositeFieldPath
                fromFieldPath: metadata.name
                toFieldPath: metadata.name
                transforms:
                  - type: string
                    string:
                      type: Format
                      fmt: "%s-cpu-alarm"
```

## Developer Claims Workflow

### Creating an Infrastructure Claim

Application teams interact with Crossplane via namespace-scoped Claims:

```yaml
# payments-service/infrastructure/database.yaml
apiVersion: platform.example.com/v1alpha1
kind: PostgresqlInstance
metadata:
  name: payments-db
  namespace: payments
  annotations:
    owner: payments-team
    cost-center: "CC-1042"
spec:
  parameters:
    storageGB: 100
    instanceSize: medium
    engineVersion: "15.4"
    multiAZ: true
    backupRetentionDays: 14
    databases:
      - payments
      - payments_test
    maintenanceWindow: "Sun:04:00-Sun:05:00"
  # Consume the connection secret in the payments namespace
  writeConnectionSecretToRef:
    name: payments-db-connection
```

```bash
# Apply the claim
kubectl apply -f database.yaml -n payments

# Watch provisioning status
kubectl get postgresqlinstance payments-db -n payments -w

# Check composite resource created by the claim
kubectl get xpostgresqlinstances

# Check individual managed resources
kubectl get instances.rds.aws.upbound.io
kubectl get subnetgroups.rds.aws.upbound.io

# Check provisioning progress
kubectl describe postgresqlinstance payments-db -n payments

# Verify connection secret was created
kubectl get secret payments-db-connection -n payments
kubectl get secret payments-db-connection -n payments \
  -o jsonpath='{.data.endpoint}' | base64 -d
```

## Composition Functions

Composition Functions enable complex transformation logic that pure patch-and-transform cannot express. They run as containers in the Crossplane pod.

### Installing the Python Composition Function

```bash
cat <<EOF | kubectl apply -f -
apiVersion: pkg.crossplane.io/v1beta1
kind: Function
metadata:
  name: function-python
spec:
  package: xpkg.upbound.io/crossplane-contrib/function-python:v0.2.0
EOF
```

### Advanced Database Sizing Function

```python
# sizing_function/main.py
import json
import sys
from crossplane.function import response

def calculate_instance_spec(size: str, storage_gb: int, multi_az: bool) -> dict:
    """Calculate RDS instance parameters from abstract size tiers."""
    SIZE_MAPPINGS = {
        "small": {
            "instance_class": "db.t3.medium",
            "iops": None,
            "max_allocated_storage": min(storage_gb * 3, 500),
        },
        "medium": {
            "instance_class": "db.r7g.large",
            "iops": 3000 if storage_gb > 100 else None,
            "max_allocated_storage": min(storage_gb * 3, 2000),
        },
        "large": {
            "instance_class": "db.r7g.2xlarge",
            "iops": 6000,
            "max_allocated_storage": min(storage_gb * 3, 8000),
        },
        "xlarge": {
            "instance_class": "db.r7g.4xlarge",
            "iops": 12000,
            "max_allocated_storage": min(storage_gb * 3, 16000),
        },
    }
    spec = SIZE_MAPPINGS.get(size, SIZE_MAPPINGS["small"])
    spec["monitoring_interval"] = 60 if multi_az else 0
    return spec

def run(req):
    xr = req.observed.composite.resource
    params = xr.get("spec", {}).get("parameters", {})
    size = params.get("instanceSize", "small")
    storage = params.get("storageGB", 20)
    multi_az = params.get("multiAZ", False)
    instance_spec = calculate_instance_spec(size, storage, multi_az)
    # Patch the desired composite resource
    desired = req.desired.composite.resource.copy()
    desired.setdefault("status", {})
    desired["status"]["instanceClass"] = instance_spec["instance_class"]
    desired["status"]["calculatedMaxStorage"] = instance_spec["max_allocated_storage"]
    rsp = response.to(req)
    rsp.desired.composite.resource.update(desired)
    return rsp
```

### Using the Function in a Composition Pipeline

```yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: xpostgresqlinstances-aws-v2
spec:
  compositeTypeRef:
    apiVersion: platform.example.com/v1alpha1
    kind: XPostgresqlInstance
  mode: Pipeline
  pipeline:
    # Step 1: Calculate instance sizing
    - step: calculate-sizing
      functionRef:
        name: function-python
      input:
        apiVersion: python.fn.crossplane.io/v1
        kind: Input
        script: |
          from sizing_function.main import run
          return run(req)

    # Step 2: Patch managed resources using calculated values
    - step: patch-resources
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
              - type: FromCompositeFieldPath
                fromFieldPath: status.instanceClass
                toFieldPath: spec.forProvider.instanceClass
              - type: FromCompositeFieldPath
                fromFieldPath: status.calculatedMaxStorage
                toFieldPath: spec.forProvider.maxAllocatedStorage
```

## Multi-Cloud Composition

### Abstract Application Environment Claim

Build higher-level abstractions that span multiple resources across providers:

```yaml
apiVersion: apiextensions.crossplane.io/v1
kind: CompositeResourceDefinition
metadata:
  name: xappenvironments.platform.example.com
spec:
  group: platform.example.com
  names:
    kind: XAppEnvironment
    plural: xappenvironments
  claimNames:
    kind: AppEnvironment
    plural: appenvironments
  connectionSecretKeys:
    - db-endpoint
    - db-password
    - cache-endpoint
    - storage-bucket
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
              required:
                - parameters
              properties:
                parameters:
                  type: object
                  required:
                    - appName
                    - tier
                  properties:
                    appName:
                      type: string
                      pattern: "^[a-z][a-z0-9-]{1,20}$"
                    tier:
                      type: string
                      enum: ["dev", "staging", "production"]
                    region:
                      type: string
                      default: "us-east-1"
---
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: xappenvironments-aws
spec:
  compositeTypeRef:
    apiVersion: platform.example.com/v1alpha1
    kind: XAppEnvironment
  mode: Pipeline
  pipeline:
    - step: provision-infrastructure
      functionRef:
        name: function-patch-and-transform
      input:
        apiVersion: pt.fn.crossplane.io/v1beta1
        kind: Resources
        resources:
          # Postgres database
          - name: database
            base:
              apiVersion: platform.example.com/v1alpha1
              kind: XPostgresqlInstance
              spec:
                parameters:
                  storageGB: 20
                  instanceSize: small
            patches:
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.tier
                toFieldPath: spec.parameters.instanceSize
                transforms:
                  - type: map
                    map:
                      dev: small
                      staging: medium
                      production: large
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.tier
                toFieldPath: spec.parameters.multiAZ
                transforms:
                  - type: map
                    map:
                      dev: "false"
                      staging: "false"
                      production: "true"

          # S3 bucket for object storage
          - name: object-storage
            base:
              apiVersion: s3.aws.upbound.io/v1beta1
              kind: Bucket
              spec:
                forProvider:
                  region: us-east-1
                  serverSideEncryptionConfiguration:
                    rule:
                      - applyServerSideEncryptionByDefault:
                          - sseAlgorithm: AES256
                  versioningConfiguration:
                    status: Enabled
                providerConfigRef:
                  name: aws-us-east-1
            patches:
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.appName
                toFieldPath: metadata.name
                transforms:
                  - type: string
                    string:
                      type: Format
                      fmt: "app-%s-assets"

          # ElastiCache Redis cluster
          - name: cache
            base:
              apiVersion: elasticache.aws.upbound.io/v1beta1
              kind: ReplicationGroup
              spec:
                forProvider:
                  region: us-east-1
                  engine: redis
                  engineVersion: "7.1"
                  nodeType: cache.t3.micro
                  numCacheClusters: 1
                  automaticFailoverEnabled: false
                  atRestEncryptionEnabled: true
                  transitEncryptionEnabled: true
                providerConfigRef:
                  name: aws-us-east-1
            patches:
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.tier
                toFieldPath: spec.forProvider.nodeType
                transforms:
                  - type: map
                    map:
                      dev: cache.t3.micro
                      staging: cache.t3.small
                      production: cache.r7g.large
              - type: FromCompositeFieldPath
                fromFieldPath: spec.parameters.tier
                toFieldPath: spec.forProvider.numCacheClusters
                transforms:
                  - type: map
                    map:
                      dev: "1"
                      staging: "1"
                      production: "3"
```

## GitOps Integration

### Repository Structure for Platform Teams

```
infrastructure-platform/
├── apis/
│   ├── database/
│   │   ├── xrd.yaml
│   │   ├── composition-aws.yaml
│   │   └── composition-gcp.yaml
│   └── app-environment/
│       ├── xrd.yaml
│       └── composition-aws.yaml
├── providers/
│   ├── aws/
│   │   ├── provider.yaml
│   │   └── providerconfig.yaml
│   └── gcp/
│       ├── provider.yaml
│       └── providerconfig.yaml
└── functions/
    └── function-patch-and-transform.yaml

# Application team repository
my-app/
├── infrastructure/
│   ├── database.yaml       # PostgresqlInstance claim
│   ├── environment.yaml    # AppEnvironment claim
│   └── kustomization.yaml
└── kubernetes/
    └── deployment.yaml
```

### ArgoCD Application for Platform APIs

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: crossplane-platform-apis
  namespace: argocd
spec:
  project: platform
  source:
    repoURL: https://github.com/example-corp/infrastructure-platform
    targetRevision: HEAD
    path: apis
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
  # Ignore fields managed by the operator
  ignoreDifferences:
    - group: apiextensions.crossplane.io
      kind: CompositeResourceDefinition
      jsonPointers:
        - /status
    - group: apiextensions.crossplane.io
      kind: Composition
      jsonPointers:
        - /status
```

### Application Team Workflow

```bash
# Application team creates their infrastructure claim via GitOps
cat <<EOF > infrastructure/database.yaml
apiVersion: platform.example.com/v1alpha1
kind: PostgresqlInstance
metadata:
  name: orders-db
  namespace: orders-service
spec:
  parameters:
    storageGB: 200
    instanceSize: large
    engineVersion: "15.4"
    multiAZ: true
    backupRetentionDays: 30
  writeConnectionSecretToRef:
    name: orders-db-connection
EOF

git add infrastructure/database.yaml
git commit -m "feat: provision PostgreSQL database for orders service"
git push origin main

# ArgoCD syncs the claim, Crossplane provisions AWS resources
# Monitor from anywhere with kubectl
kubectl get postgresqlinstance orders-db -n orders-service -w
```

## RBAC for Multi-Tenant Environments

```yaml
# Platform team ClusterRole - can manage XRDs and Compositions
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: platform-admin
rules:
  - apiGroups: ["apiextensions.crossplane.io"]
    resources: ["*"]
    verbs: ["*"]
  - apiGroups: ["pkg.crossplane.io"]
    resources: ["*"]
    verbs: ["*"]
  - apiGroups: ["platform.example.com"]
    resources: ["*"]
    verbs: ["*"]
---
# Application team Role - can only create Claims in their namespace
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: claim-creator
  namespace: orders-service
rules:
  - apiGroups: ["platform.example.com"]
    resources:
      - postgresqlinstances
      - appenvironments
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: orders-team-claims
  namespace: orders-service
subjects:
  - kind: Group
    name: orders-team
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: Role
  name: claim-creator
  apiGroup: rbac.authorization.k8s.io
```

## Observability and Debugging

```bash
# Check Composition health
kubectl get compositions
kubectl describe composition xpostgresqlinstances-aws

# Debug a failing claim
kubectl describe postgresqlinstance payments-db -n payments

# Check all managed resources created by a composite resource
kubectl get managed -l crossplane.io/composite=payments-db-xyz

# View the actual managed resource status
kubectl describe instance.rds.aws.upbound.io \
  $(kubectl get instance.rds.aws.upbound.io \
    -l crossplane.io/composite=payments-db-xyz \
    -o jsonpath='{.items[0].metadata.name}')

# Watch managed resource events
kubectl get events --field-selector \
  involvedObject.kind=Instance \
  -n crossplane-system

# Check Crossplane controller logs
kubectl logs -n crossplane-system \
  -l app=crossplane --tail=100 -f

# Check provider pod logs for AWS API errors
kubectl logs -n crossplane-system \
  -l pkg.crossplane.io/revision=provider-aws-rds \
  --tail=100 -f
```

### Cost and Resource Tracking

```yaml
# Label all managed resources with cost allocation tags
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: xpostgresqlinstances-aws
spec:
  # ...
  resources:
    - name: rds-instance
      base:
        # ...
      patches:
        # Propagate claim namespace as cost center tag
        - type: FromCompositeFieldPath
          fromFieldPath: metadata.labels[crossplane.io/claim-namespace]
          toFieldPath: spec.forProvider.tags.team
        - type: FromCompositeFieldPath
          fromFieldPath: metadata.labels[crossplane.io/claim-name]
          toFieldPath: spec.forProvider.tags.service
```

## Summary

Crossplane Compositions provide the foundation for building Internal Developer Platforms where application teams provision cloud infrastructure through Kubernetes-native APIs. The XRD/Composition pattern decouples the developer-facing API from the implementation details, allowing platform teams to change underlying cloud resources without impacting developer workflows. Composition Functions extend the transformation capabilities beyond what patch-and-transform allows, enabling complex business logic like size tier calculations and multi-cloud routing. When combined with GitOps tooling like ArgoCD, the complete infrastructure lifecycle becomes version-controlled, auditable, and self-healing.
