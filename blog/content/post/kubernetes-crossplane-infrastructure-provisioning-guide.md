---
title: "Crossplane: Kubernetes-Native Infrastructure Provisioning and Composition"
date: 2028-10-12T00:00:00-05:00
draft: false
tags: ["Crossplane", "Kubernetes", "Infrastructure as Code", "AWS", "Platform Engineering"]
categories:
- Crossplane
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete guide to Crossplane for Kubernetes-native infrastructure provisioning, covering Provider setup, Managed Resources, Composite Resources, Compositions, and self-service platform patterns."
more_link: "yes"
url: "/kubernetes-crossplane-infrastructure-provisioning-guide/"
---

Platform engineering teams face a recurring challenge: developers need databases, object storage buckets, and message queues on demand, but provisioning these resources through Terraform or console clicks creates bottlenecks. Crossplane solves this by bringing infrastructure into the Kubernetes API — developers request resources the same way they request Deployments, and the platform team controls what they get through Compositions that abstract away cloud specifics.

This guide walks through a complete Crossplane setup from installation through production-grade compositions that provision AWS RDS instances and S3 buckets on demand.

<!--more-->

# Crossplane: Kubernetes-Native Infrastructure Provisioning and Composition

## The Platform Engineering Problem

Infrastructure provisioning workflows typically look like this:

1. Developer opens a Jira ticket requesting a database
2. Platform team provisions it via Terraform or console
3. Developer receives connection details 2-3 days later

Crossplane inverts this model. Platform teams define *Compositions* — parameterized templates that encode their standards (encryption, backup schedules, VPC placement, tagging). Developers submit *Claims* using only the parameters they care about (instance size, database name). Crossplane reconciles the claim against the composition and provisions the real cloud resource.

## Installation

```bash
# Install Crossplane into a dedicated namespace
helm repo add crossplane-stable https://charts.crossplane.io/stable
helm repo update

helm install crossplane crossplane-stable/crossplane \
  --namespace crossplane-system \
  --create-namespace \
  --set args='{--enable-usages}' \
  --version 1.17.1 \
  --wait

# Verify Crossplane pods are running
kubectl get pods -n crossplane-system
# NAME                                       READY   STATUS    RESTARTS   AGE
# crossplane-7d8f9b4c6d-xk2pq                1/1     Running   0          2m
# crossplane-rbac-manager-5b6d4f9c7d-h8j4n   1/1     Running   0          2m
```

## Provider Setup: AWS

Providers are Crossplane's extension mechanism — each Provider installs CRDs for a specific cloud and runs a controller that reconciles those CRDs against the cloud API.

```yaml
# provider-aws.yaml
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws-s3
spec:
  package: xpkg.upbound.io/upbound/provider-aws-s3:v1.14.0
  runtimeConfigRef:
    name: provider-aws
---
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws-rds
spec:
  package: xpkg.upbound.io/upbound/provider-aws-rds:v1.14.0
  runtimeConfigRef:
    name: provider-aws
---
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws-ec2
spec:
  package: xpkg.upbound.io/upbound/provider-aws-ec2:v1.14.0
  runtimeConfigRef:
    name: provider-aws
---
# Shared runtime config — sets resource requests for provider pods
apiVersion: pkg.crossplane.io/v1beta1
kind: DeploymentRuntimeConfig
metadata:
  name: provider-aws
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
                  memory: 256Mi
                  cpu: 100m
                limits:
                  memory: 512Mi
                  cpu: 500m
```

```bash
kubectl apply -f provider-aws.yaml

# Wait for providers to become healthy
kubectl get providers
# NAME                  INSTALLED   HEALTHY   PACKAGE                                             AGE
# provider-aws-ec2      True        True      xpkg.upbound.io/upbound/provider-aws-ec2:v1.14.0   3m
# provider-aws-rds      True        True      xpkg.upbound.io/upbound/provider-aws-rds:v1.14.0   3m
# provider-aws-s3       True        True      xpkg.upbound.io/upbound/provider-aws-s3:v1.14.0    3m
```

## Authenticating Providers to AWS

Production deployments should use IRSA (IAM Roles for Service Accounts) rather than long-lived access keys.

```yaml
# provider-config-aws.yaml — IRSA approach
apiVersion: aws.upbound.io/v1beta1
kind: ProviderConfig
metadata:
  name: default
spec:
  credentials:
    source: IRSA
  # Optional: assume a cross-account role
  assumeRoleChain:
    - roleARN: arn:aws:iam::123456789012:role/CrossplaneProviderRole
```

The IRSA setup requires annotating the provider service accounts:

```bash
# Get the provider service account names
kubectl get sa -n crossplane-system | grep provider-aws

# Annotate each with the IAM role ARN
kubectl annotate sa -n crossplane-system \
  provider-aws-s3-xxxxxxxxx \
  eks.amazonaws.com/role-arn=arn:aws:iam::123456789012:role/CrossplaneProviderRole

kubectl annotate sa -n crossplane-system \
  provider-aws-rds-xxxxxxxxx \
  eks.amazonaws.com/role-arn=arn:aws:iam::123456789012:role/CrossplaneProviderRole
```

The required IAM policy for the provider role:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "rds:*",
        "s3:*",
        "ec2:DescribeVpcs",
        "ec2:DescribeSubnets",
        "ec2:DescribeSecurityGroups",
        "secretsmanager:CreateSecret",
        "secretsmanager:GetSecretValue",
        "secretsmanager:UpdateSecret",
        "secretsmanager:DeleteSecret"
      ],
      "Resource": "*"
    }
  ]
}
```

## Managed Resources: Direct Cloud Resource Control

Managed Resources (MRs) are one-to-one mappings to cloud resources. Use them directly when you need fine-grained control without abstraction.

```yaml
# managed-rds.yaml — Direct RDS instance management
apiVersion: rds.aws.upbound.io/v1beta1
kind: Instance
metadata:
  name: prod-postgres-01
  annotations:
    crossplane.io/external-name: prod-postgres-01
spec:
  forProvider:
    region: us-east-1
    dbInstanceClass: db.t3.medium
    engine: postgres
    engineVersion: "16.3"
    allocatedStorage: 100
    storageType: gp3
    storageEncrypted: true
    multiAz: true
    backupRetentionPeriod: 14
    deleteAutomatedBackups: false
    deletionProtection: true
    dbSubnetGroupName: production-db-subnet-group
    vpcSecurityGroupIdRefs:
      - name: rds-security-group
    username: dbadmin
    # Password stored in a Kubernetes Secret, referenced here
    passwordSecretRef:
      name: rds-master-password
      namespace: crossplane-system
      key: password
    parameterGroupName: custom-postgres16
    tags:
      Environment: production
      ManagedBy: crossplane
      Team: platform
  # Where Crossplane writes connection details for consumers
  writeConnectionSecretToRef:
    name: prod-postgres-01-conn
    namespace: database-credentials
  providerConfigRef:
    name: default
```

```bash
kubectl apply -f managed-rds.yaml

# Watch provisioning status
kubectl describe instance.rds.aws.upbound.io prod-postgres-01
# Status.Conditions shows SYNCED=True when provisioning is complete

# Connection details are written to the specified Secret
kubectl get secret -n database-credentials prod-postgres-01-conn -o jsonpath='{.data}' | \
  jq 'to_entries[] | {key: .key, value: (.value | @base64d)}'
```

## Composite Resources and Compositions

Compositions are the powerful abstraction layer. A `CompositeResourceDefinition` (XRD) defines the developer-facing API. A `Composition` defines how that API maps to cloud resources.

### Step 1: Define the XRD (the developer-facing schema)

```yaml
# xrd-postgresqlinstance.yaml
apiVersion: apiextensions.crossplane.io/v1
kind: CompositeResourceDefinition
metadata:
  name: xpostgresqlinstances.platform.yourorg.com
spec:
  group: platform.yourorg.com
  names:
    kind: XPostgreSQLInstance
    plural: xpostgresqlinstances
  # claimNames allows namespace-scoped Claims to reference this composite
  claimNames:
    kind: PostgreSQLInstance
    plural: postgresqlinstances
  defaultCompositionRef:
    name: postgresql-aws-standard
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
                    - storageGB
                    - instanceSize
                  properties:
                    storageGB:
                      type: integer
                      minimum: 20
                      maximum: 10000
                      description: "Storage size in GiB"
                    instanceSize:
                      type: string
                      enum: ["small", "medium", "large", "xlarge"]
                      description: "T-shirt size for the instance"
                    engineVersion:
                      type: string
                      default: "16"
                    region:
                      type: string
                      default: "us-east-1"
                      enum: ["us-east-1", "us-west-2", "eu-west-1"]
                    multiAZ:
                      type: boolean
                      default: false
                    backupRetentionDays:
                      type: integer
                      minimum: 1
                      maximum: 35
                      default: 7
            status:
              type: object
              properties:
                address:
                  type: string
                  description: "RDS endpoint address"
                port:
                  type: integer
                  description: "RDS port"
                atProvider:
                  type: object
                  x-kubernetes-preserve-unknown-fields: true
```

### Step 2: Create the Composition (the platform team's implementation)

```yaml
# composition-postgresql-aws.yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: postgresql-aws-standard
  labels:
    provider: aws
    tier: standard
spec:
  compositeTypeRef:
    apiVersion: platform.yourorg.com/v1alpha1
    kind: XPostgreSQLInstance
  # Write connection details from composed resources to the composite
  writeConnectionSecretsToNamespace: crossplane-system
  mode: Pipeline
  pipeline:
    - step: render-rds-instance
      functionRef:
        name: function-go-templating
      input:
        apiVersion: gotemplating.fn.crossplane.io/v1beta1
        kind: GoTemplate
        source: Inline
        inline:
          template: |
            {{- $instanceClassMap := dict
              "small"  "db.t3.small"
              "medium" "db.t3.medium"
              "large"  "db.r6g.large"
              "xlarge" "db.r6g.xlarge"
            -}}
            {{- $instanceClass := index $instanceClassMap .observed.composite.resource.spec.parameters.instanceSize -}}
            ---
            apiVersion: rds.aws.upbound.io/v1beta1
            kind: Instance
            metadata:
              annotations:
                gotemplating.fn.crossplane.io/composition-resource-name: rds-instance
                crossplane.io/external-name: {{ .observed.composite.resource.metadata.name }}
            spec:
              forProvider:
                region: {{ .observed.composite.resource.spec.parameters.region }}
                dbInstanceClass: {{ $instanceClass }}
                engine: postgres
                engineVersion: "{{ .observed.composite.resource.spec.parameters.engineVersion }}"
                allocatedStorage: {{ .observed.composite.resource.spec.parameters.storageGB }}
                storageType: gp3
                storageEncrypted: true
                multiAz: {{ .observed.composite.resource.spec.parameters.multiAZ }}
                backupRetentionPeriod: {{ .observed.composite.resource.spec.parameters.backupRetentionDays }}
                deletionProtection: true
                dbSubnetGroupNameSelector:
                  matchLabels:
                    environment: production
                    region: {{ .observed.composite.resource.spec.parameters.region }}
                vpcSecurityGroupIdSelector:
                  matchLabels:
                    purpose: rds
                username: appuser
                autoGeneratePassword: true
                tags:
                  ManagedBy: crossplane
                  CompositeResource: {{ .observed.composite.resource.metadata.name }}
              writeConnectionSecretToRef:
                name: {{ .observed.composite.resource.metadata.name }}-rds-conn
                namespace: crossplane-system
              providerConfigRef:
                name: default
    - step: automatically-detect-ready-composed-resources
      functionRef:
        name: function-auto-ready
```

Install the required Crossplane Functions:

```bash
# Install function-go-templating for Composition Pipeline mode
cat <<EOF | kubectl apply -f -
apiVersion: pkg.crossplane.io/v1beta1
kind: Function
metadata:
  name: function-go-templating
spec:
  package: xpkg.upbound.io/crossplane-contrib/function-go-templating:v0.7.0
---
apiVersion: pkg.crossplane.io/v1beta1
kind: Function
metadata:
  name: function-auto-ready
spec:
  package: xpkg.upbound.io/crossplane-contrib/function-auto-ready:v0.3.0
EOF

kubectl apply -f xrd-postgresqlinstance.yaml
kubectl apply -f composition-postgresql-aws.yaml
```

### Step 3: Developer Claims

```yaml
# claim-dev-database.yaml — what developers submit
apiVersion: platform.yourorg.com/v1alpha1
kind: PostgreSQLInstance
metadata:
  name: payments-db
  namespace: payments-team
spec:
  parameters:
    storageGB: 100
    instanceSize: medium
    engineVersion: "16"
    region: us-east-1
    multiAZ: true
    backupRetentionDays: 14
  # Connection details will be written to this Secret in the same namespace
  writeConnectionSecretToRef:
    name: payments-db-connection
```

```bash
kubectl apply -f claim-dev-database.yaml

# Watch the claim status
kubectl get postgresqlinstance -n payments-team payments-db
# NAME          SYNCED   READY   CONNECTION-SECRET          AGE
# payments-db   True     True    payments-db-connection     8m

# Check the connection secret
kubectl get secret -n payments-team payments-db-connection -o jsonpath='{.data.endpoint}' | base64 -d
```

## Advanced Composition: Multi-Resource with Patches

Production compositions often create multiple cloud resources. Here is a composition that creates both an RDS instance and an S3 bucket for the application, demonstrating the patch/transform system.

```yaml
# composition-app-infrastructure.yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: app-infrastructure-aws
spec:
  compositeTypeRef:
    apiVersion: platform.yourorg.com/v1alpha1
    kind: XAppInfrastructure
  mode: Resources
  resources:
    # Resource 1: RDS Instance
    - name: rds-instance
      base:
        apiVersion: rds.aws.upbound.io/v1beta1
        kind: Instance
        spec:
          forProvider:
            engine: postgres
            engineVersion: "16"
            storageEncrypted: true
            deletionProtection: true
            multiAz: false
            username: appuser
            autoGeneratePassword: true
          writeConnectionSecretToRef:
            namespace: crossplane-system
          providerConfigRef:
            name: default
      patches:
        # Copy region from claim to forProvider.region
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.region
          toFieldPath: spec.forProvider.region

        # Map t-shirt sizes to instance classes
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.instanceSize
          toFieldPath: spec.forProvider.dbInstanceClass
          transforms:
            - type: map
              map:
                small:  db.t3.small
                medium: db.t3.medium
                large:  db.r6g.large
                xlarge: db.r6g.xlarge

        # Set storage from claim
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.storageGB
          toFieldPath: spec.forProvider.allocatedStorage

        # Generate unique Secret name from composite name
        - type: FromCompositeFieldPath
          fromFieldPath: metadata.name
          toFieldPath: spec.writeConnectionSecretToRef.name
          transforms:
            - type: string
              string:
                type: Format
                fmt: "%s-rds-conn"

        # Patch multiAZ from spec
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.highAvailability
          toFieldPath: spec.forProvider.multiAz

        # Expose the RDS endpoint back to the composite status
        - type: ToCompositeFieldPath
          fromFieldPath: status.atProvider.endpoint
          toFieldPath: status.rdsEndpoint
          policy:
            fromFieldPath: Optional

      connectionDetails:
        - fromConnectionSecretKey: username
          name: db_user
        - fromConnectionSecretKey: password
          name: db_password
        - fromConnectionSecretKey: endpoint
          name: db_host
        - fromConnectionSecretKey: port
          name: db_port

    # Resource 2: S3 Bucket
    - name: app-bucket
      base:
        apiVersion: s3.aws.upbound.io/v1beta1
        kind: Bucket
        spec:
          forProvider:
            serverSideEncryptionConfiguration:
              - rule:
                  - applyServerSideEncryptionByDefault:
                      - sseAlgorithm: aws:kms
          providerConfigRef:
            name: default
      patches:
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.region
          toFieldPath: spec.forProvider.region

        - type: FromCompositeFieldPath
          fromFieldPath: metadata.name
          toFieldPath: metadata.annotations[crossplane.io/external-name]
          transforms:
            - type: string
              string:
                type: Format
                fmt: "%s-app-bucket"

        - type: ToCompositeFieldPath
          fromFieldPath: status.atProvider.id
          toFieldPath: status.bucketName
          policy:
            fromFieldPath: Optional
```

## Crossplane vs Terraform: When to Use Each

| Concern | Crossplane | Terraform |
|---------|-----------|-----------|
| **Drift detection** | Continuous (controller loop) | On-demand (`terraform plan`) |
| **State storage** | Kubernetes etcd | Separate backend (S3, Vault) |
| **Developer self-service** | Native via Kubernetes RBAC | Requires wrapper (Atlantis, Spacelift) |
| **Multi-cloud** | Via providers | Native HCL |
| **Secret management** | External Secrets Operator integration | Vault provider |
| **Destroy protection** | `deletionPolicy: Orphan` | `prevent_destroy` lifecycle |
| **Learning curve** | Higher (Kubernetes-native) | Lower (HCL) |
| **Module ecosystem** | Growing (Compositions) | Mature (Terraform Registry) |

**Use Crossplane when** your team is already deeply invested in Kubernetes, you need self-service infrastructure for developers, or you want continuous reconciliation rather than one-shot applies.

**Use Terraform when** you have existing Terraform modules, need broad ecosystem support, or your team prefers a dedicated IaC tool separate from your cluster.

**Hybrid approach**: Many teams use Crossplane for application-level cloud resources (databases, buckets, queues) while keeping network topology (VPCs, subnets, peering) in Terraform.

## Namespace-Based RBAC for Self-Service

```yaml
# rbac-developer.yaml
# Developers can only create Claims in their namespace, not raw MRs or Compositions
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: crossplane-developer
  namespace: payments-team
rules:
  - apiGroups: ["platform.yourorg.com"]
    resources: ["postgresqlinstances", "appinfrastructures"]
    verbs: ["get", "list", "watch", "create", "update", "patch"]
  - apiGroups: ["platform.yourorg.com"]
    resources: ["postgresqlinstances/status", "appinfrastructures/status"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: payments-team-crossplane
  namespace: payments-team
subjects:
  - kind: Group
    name: payments-engineers
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: Role
  name: crossplane-developer
  apiGroup: rbac.authorization.k8s.io
```

## Monitoring Crossplane

```yaml
# prometheus-servicemonitor.yaml
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
```

Key metrics to alert on:

```promql
# Managed resources not in sync (should be 0)
crossplane_managed_resource_ready{ready="False"} > 0

# Claims not ready after 10 minutes
(time() - crossplane_composite_resource_ready_transition_seconds) > 600
  and crossplane_composite_resource_ready{ready="False"} == 1

# Provider health
crossplane_pkg_revision_healthy{healthy="False"} > 0
```

## Troubleshooting

```bash
# Check why a claim is not ready
kubectl describe postgresqlinstance -n payments-team payments-db

# Check the underlying composite resource
kubectl get xpostgresqlinstance
kubectl describe xpostgresqlinstance payments-team-payments-db-xxxxx

# Check the managed resource
kubectl get instance.rds.aws.upbound.io
kubectl describe instance.rds.aws.upbound.io payments-team-payments-db-xxxxx

# Check provider logs
kubectl logs -n crossplane-system \
  -l pkg.crossplane.io/revision=provider-aws-rds-xxxx \
  --tail=100 | grep -E "ERROR|WARN|error"

# List all composition revisions
kubectl get compositionrevisions

# Force re-sync a stuck managed resource
kubectl annotate managed payments-team-payments-db-xxxxx \
  crossplane.io/paused=true --overwrite
kubectl annotate managed payments-team-payments-db-xxxxx \
  crossplane.io/paused- --overwrite
```

## Deletion Policies

Control what happens when a claim is deleted:

```yaml
spec:
  # Default: Delete — deletes the cloud resource when the MR is deleted
  # Orphan — removes Crossplane management but leaves the cloud resource
  deletionPolicy: Orphan
```

Set `Orphan` on production databases before any cluster migration or disaster recovery scenario:

```bash
# Protect a production database before cluster teardown
kubectl patch instance.rds.aws.upbound.io prod-db \
  --type=merge -p '{"spec":{"deletionPolicy":"Orphan"}}'
```

Crossplane brings the Kubernetes control loop model to infrastructure provisioning. The combination of XRDs for developer-facing APIs, Compositions for platform team implementations, and continuous reconciliation for drift detection creates a self-service platform that maintains the operational standards your team requires without manual intervention.
