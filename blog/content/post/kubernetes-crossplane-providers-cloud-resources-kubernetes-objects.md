---
title: "Kubernetes Crossplane Providers: Managing Cloud Resources as Kubernetes Objects"
date: 2031-01-20T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Crossplane", "Infrastructure as Code", "AWS", "GCP", "Azure", "GitOps", "Terraform"]
categories:
- Kubernetes
- Infrastructure as Code
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to Crossplane provider ecosystem, Composition and CompositeResourceDefinition design, claim-based self-service infrastructure, and replacing Terraform with Crossplane for cloud-native IaC."
more_link: "yes"
url: "/kubernetes-crossplane-providers-cloud-resources-kubernetes-objects/"
---

Crossplane extends Kubernetes into a universal control plane for cloud infrastructure, letting platform teams define, compose, and expose cloud resources using the same API machinery that manages workloads. This guide covers the full operational lifecycle: installing and configuring providers for AWS, GCP, and Azure; designing Compositions and CompositeResourceDefinitions that encode organizational standards; building claim-based self-service catalogs for development teams; securing provider credentials at scale; and migrating existing Terraform-managed infrastructure to Crossplane without downtime.

<!--more-->

# Kubernetes Crossplane Providers: Managing Cloud Resources as Kubernetes Objects

## Why Crossplane Over Traditional IaC

Terraform and similar tools treat infrastructure as a separate concern from application deployment, requiring separate pipelines, state management backends, and credential stores. Crossplane collapses this separation. When infrastructure is expressed as Kubernetes objects, it participates in the same reconciliation loops, RBAC policies, audit trails, and GitOps workflows that govern every other Kubernetes resource.

The key advantages in enterprise environments:

- **Unified API surface**: developers interact with cloud infrastructure using `kubectl` and familiar YAML, without learning HCL or managing Terraform state files
- **Continuous reconciliation**: Crossplane constantly drifts-corrects cloud resources, not just at apply time
- **Composable abstractions**: platform teams expose simple "Database" or "AppEnvironment" claims that internally provision dozens of cloud resources
- **RBAC integration**: native Kubernetes RBAC controls who can request which infrastructure, scoped to namespace or cluster
- **GitOps native**: infrastructure state lives in Git repositories, reconciled by Flux or ArgoCD exactly like application manifests

## Architecture Overview

Crossplane's architecture consists of four layers:

```
┌─────────────────────────────────────────────────────────┐
│                    Developer Claims                      │
│          PostgreSQLInstance, AppEnvironment, etc.        │
├─────────────────────────────────────────────────────────┤
│                 Composite Resources (XR)                  │
│           XPostgreSQLInstance, XAppEnvironment           │
├─────────────────────────────────────────────────────────┤
│                    Compositions                          │
│       Map XR fields → provider-specific Managed Resources│
├─────────────────────────────────────────────────────────┤
│              Provider Managed Resources                  │
│      RDSInstance, VPC, SecurityGroup, GKECluster...      │
└─────────────────────────────────────────────────────────┘
```

Each layer can be owned by different teams. The platform team owns Compositions and provider configs; developers interact only with Claims.

## Installing Crossplane

### Prerequisites

```bash
# Kubernetes 1.24+ required
kubectl version --short

# Install Crossplane via Helm
helm repo add crossplane-stable https://charts.crossplane.io/stable
helm repo update

helm install crossplane \
  crossplane-stable/crossplane \
  --namespace crossplane-system \
  --create-namespace \
  --version 1.15.0 \
  --set args='{"--enable-usages"}' \
  --set resourcesCrossplane.limits.cpu=500m \
  --set resourcesCrossplane.limits.memory=512Mi \
  --set resourcesCrossplane.requests.cpu=100m \
  --set resourcesCrossplane.requests.memory=256Mi \
  --wait
```

Verify installation:

```bash
kubectl get pods -n crossplane-system
# NAME                                       READY   STATUS    RESTARTS   AGE
# crossplane-7d8d9b8c5-xk2qr                1/1     Running   0          2m
# crossplane-rbac-manager-6b9f7f7b9-9pqvt   1/1     Running   0          2m

kubectl get crds | grep crossplane
# compositeresourcedefinitions.apiextensions.crossplane.io
# compositions.apiextensions.crossplane.io
# providers.pkg.crossplane.io
# ...
```

## Installing and Configuring Providers

### AWS Provider

```yaml
# provider-aws.yaml
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws-s3
spec:
  package: xpkg.upbound.io/upbound/provider-aws-s3:v1.1.0
  controllerConfigRef:
    name: provider-aws-controller-config
---
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws-rds
spec:
  package: xpkg.upbound.io/upbound/provider-aws-rds:v1.1.0
  controllerConfigRef:
    name: provider-aws-controller-config
---
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws-ec2
spec:
  package: xpkg.upbound.io/upbound/provider-aws-ec2:v1.1.0
  controllerConfigRef:
    name: provider-aws-controller-config
---
# Controller config sets resource limits and pod annotations
apiVersion: pkg.crossplane.io/v1alpha1
kind: ControllerConfig
metadata:
  name: provider-aws-controller-config
spec:
  podSecurityContext:
    runAsNonRoot: true
    runAsUser: 2000
    fsGroup: 2000
  resources:
    limits:
      cpu: 500m
      memory: 512Mi
    requests:
      cpu: 100m
      memory: 256Mi
  tolerations:
  - key: platform-tools
    operator: Exists
    effect: NoSchedule
```

### Credential Management: IRSA (Recommended for EKS)

The most secure approach on EKS uses IAM Roles for Service Accounts, eliminating static credentials:

```bash
# Create IAM policy for Crossplane AWS provider
cat > crossplane-aws-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:*",
        "rds:*",
        "ec2:*",
        "elasticache:*",
        "iam:PassRole",
        "iam:GetRole",
        "iam:CreateRole",
        "iam:AttachRolePolicy"
      ],
      "Resource": "*"
    }
  ]
}
EOF

aws iam create-policy \
  --policy-name CrossplaneProviderPolicy \
  --policy-document file://crossplane-aws-policy.json

# Get EKS OIDC provider URL
OIDC_PROVIDER=$(aws eks describe-cluster \
  --name my-cluster \
  --query "cluster.identity.oidc.issuer" \
  --output text | sed 's|https://||')

# Create trust policy
cat > trust-policy.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::123456789012:oidc-provider/${OIDC_PROVIDER}"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "${OIDC_PROVIDER}:sub": "system:serviceaccount:crossplane-system:provider-aws-s3",
          "${OIDC_PROVIDER}:aud": "sts.amazonaws.com"
        }
      }
    }
  ]
}
EOF

aws iam create-role \
  --role-name CrossplaneProviderRole \
  --assume-role-policy-document file://trust-policy.json

aws iam attach-role-policy \
  --role-name CrossplaneProviderRole \
  --policy-arn arn:aws:iam::123456789012:policy/CrossplaneProviderPolicy
```

Configure the ProviderConfig to use IRSA:

```yaml
# provider-config-aws-irsa.yaml
apiVersion: aws.upbound.io/v1beta1
kind: ProviderConfig
metadata:
  name: default
spec:
  credentials:
    source: IRSA
  assumeRoleChain:
  - roleARN: "arn:aws:iam::123456789012:role/CrossplaneProviderRole"
  region: us-east-1
```

### Credential Management: Static Credentials (Non-EKS)

For non-EKS environments, use Kubernetes secrets (ideally populated by Vault or External Secrets):

```bash
# Create credentials file
cat > aws-credentials.txt << 'EOF'
[default]
aws_access_key_id = <aws-access-key-id>
aws_secret_access_key = <aws-secret-access-key>
EOF

kubectl create secret generic aws-credentials \
  --namespace crossplane-system \
  --from-file=credentials=aws-credentials.txt
```

```yaml
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
  region: us-east-1
```

### GCP Provider

```yaml
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-gcp-storage
spec:
  package: xpkg.upbound.io/upbound/provider-gcp-storage:v1.0.0
---
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-gcp-sql
spec:
  package: xpkg.upbound.io/upbound/provider-gcp-sql:v1.0.0
```

GCP credential configuration using Workload Identity:

```yaml
apiVersion: gcp.upbound.io/v1beta1
kind: ProviderConfig
metadata:
  name: default
spec:
  credentials:
    source: InjectedIdentity
  projectID: my-gcp-project-id
```

For static credentials:

```bash
# Create GCP service account and download key
gcloud iam service-accounts create crossplane-provider \
  --display-name="Crossplane Provider"

gcloud projects add-iam-policy-binding my-gcp-project \
  --member="serviceAccount:crossplane-provider@my-gcp-project.iam.gserviceaccount.com" \
  --role="roles/owner"

gcloud iam service-accounts keys create gcp-credentials.json \
  --iam-account=crossplane-provider@my-gcp-project.iam.gserviceaccount.com

kubectl create secret generic gcp-credentials \
  --namespace crossplane-system \
  --from-file=credentials=gcp-credentials.json
```

### Azure Provider

```yaml
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-azure-storage
spec:
  package: xpkg.upbound.io/upbound/provider-azure-storage:v1.1.0
---
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-azure-dbforpostgresql
spec:
  package: xpkg.upbound.io/upbound/provider-azure-dbforpostgresql:v1.1.0
```

Azure credential configuration using Managed Identity:

```yaml
apiVersion: azure.upbound.io/v1beta1
kind: ProviderConfig
metadata:
  name: default
spec:
  credentials:
    source: SystemAssignedManagedIdentity
  subscriptionID: "00000000-0000-0000-0000-000000000000"
  tenantID: "00000000-0000-0000-0000-000000000001"
```

## Designing CompositeResourceDefinitions (XRDs)

XRDs define the schema for composite resources. They are the API contract between platform teams and consumers.

### PostgreSQL Database XRD

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
  # Claim allows namespace-scoped access to the composite resource
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
                description: "PostgreSQL instance configuration parameters"
                properties:
                  version:
                    type: string
                    description: "PostgreSQL version"
                    enum: ["13", "14", "15", "16"]
                    default: "15"
                  storageGB:
                    type: integer
                    description: "Storage size in GB"
                    minimum: 20
                    maximum: 16384
                    default: 20
                  instanceClass:
                    type: string
                    description: "Instance size class"
                    enum:
                    - small    # db.t3.medium
                    - medium   # db.m5.large
                    - large    # db.m5.xlarge
                    - xlarge   # db.m5.2xlarge
                    default: small
                  multiAZ:
                    type: boolean
                    description: "Enable Multi-AZ deployment"
                    default: false
                  backupRetentionDays:
                    type: integer
                    description: "Days to retain automated backups"
                    minimum: 1
                    maximum: 35
                    default: 7
                  networkRef:
                    type: object
                    description: "Reference to the network configuration"
                    properties:
                      id:
                        type: string
                        description: "XNetwork composite resource ID"
                    required:
                    - id
                required:
                - version
                - storageGB
                - instanceClass
                - networkRef
            required:
            - parameters
```

### Composition for AWS RDS

```yaml
# composition-postgresql-aws.yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: xpostgresqlinstances.aws.platform.example.com
  labels:
    provider: aws
    database: postgresql
spec:
  # Match XPostgreSQLInstance resources targeting AWS
  compositeTypeRef:
    apiVersion: platform.example.com/v1alpha1
    kind: XPostgreSQLInstance
  # Write connection details to a secret
  writeConnectionSecretsToNamespace: crossplane-system
  # Pipeline mode for complex transformations
  mode: Pipeline
  pipeline:
  - step: patch-and-transform
    functionRef:
      name: function-patch-and-transform
    input:
      apiVersion: pt.fn.crossplane.io/v1beta1
      kind: Resources
      resources:
      # DB Subnet Group
      - name: rds-subnetgroup
        base:
          apiVersion: rds.aws.upbound.io/v1beta1
          kind: SubnetGroup
          spec:
            forProvider:
              region: us-east-1
              description: "Managed by Crossplane"
            providerConfigRef:
              name: default
        patches:
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.networkRef.id
          toFieldPath: spec.forProvider.subnetIdSelector.matchLabels.network-id
        - type: ToCompositeFieldPath
          fromFieldPath: status.atProvider.id
          toFieldPath: status.subnetGroupId

      # RDS Parameter Group
      - name: rds-parameter-group
        base:
          apiVersion: rds.aws.upbound.io/v1beta1
          kind: ParameterGroup
          spec:
            forProvider:
              region: us-east-1
              description: "Managed by Crossplane"
            providerConfigRef:
              name: default
        patches:
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.version
          toFieldPath: spec.forProvider.family
          transforms:
          - type: string
            string:
              type: Format
              fmt: "postgres%s"

      # RDS Instance
      - name: rds-instance
        base:
          apiVersion: rds.aws.upbound.io/v1beta1
          kind: Instance
          spec:
            forProvider:
              region: us-east-1
              engine: postgres
              engineVersion: "15"
              storageType: gp3
              skipFinalSnapshot: false
              deletionProtection: true
              storageEncrypted: true
              publiclyAccessible: false
              autoMinorVersionUpgrade: true
              copyTagsToSnapshot: true
              applyImmediately: false
              username: pgadmin
              generatePassword: true
              passwordSecretRef:
                namespace: crossplane-system
            providerConfigRef:
              name: default
            writeConnectionSecretToRef:
              namespace: crossplane-system
        patches:
        # Map instance class
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.instanceClass
          toFieldPath: spec.forProvider.instanceClass
          transforms:
          - type: map
            map:
              small: db.t3.medium
              medium: db.m5.large
              large: db.m5.xlarge
              xlarge: db.m5.2xlarge
        # Map storage size
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.storageGB
          toFieldPath: spec.forProvider.allocatedStorage
        # Map version
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.version
          toFieldPath: spec.forProvider.engineVersion
        # Map multi-AZ
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.multiAZ
          toFieldPath: spec.forProvider.multiAz
        # Map backup retention
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.backupRetentionDays
          toFieldPath: spec.forProvider.backupRetentionPeriod
        # Set connection secret name from composite name
        - type: FromCompositeFieldPath
          fromFieldPath: metadata.name
          toFieldPath: spec.forProvider.passwordSecretRef.name
          transforms:
          - type: string
            string:
              type: Format
              fmt: "%s-postgres-password"
        - type: FromCompositeFieldPath
          fromFieldPath: metadata.name
          toFieldPath: spec.writeConnectionSecretToRef.name
          transforms:
          - type: string
            string:
              type: Format
              fmt: "%s-postgres-connection"
        # Propagate connection details to composite resource
        connectionDetails:
        - name: username
          fromConnectionSecretKey: username
        - name: password
          fromConnectionSecretKey: password
        - name: endpoint
          fromConnectionSecretKey: endpoint
        - name: port
          fromConnectionSecretKey: port
```

### App Environment Composition (Multi-Resource)

This example shows a Composition that provisions a complete application environment with VPC, RDS, ElastiCache, and S3:

```yaml
# xrd-app-environment.yaml
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
                  appName:
                    type: string
                    description: "Application name (used for resource naming)"
                    maxLength: 20
                    pattern: "^[a-z][a-z0-9-]*$"
                  environment:
                    type: string
                    enum: [dev, staging, production]
                  region:
                    type: string
                    default: us-east-1
                  databaseSize:
                    type: string
                    enum: [small, medium, large]
                    default: small
                  cacheSize:
                    type: string
                    enum: [cache.t3.micro, cache.t3.small, cache.m5.large]
                    default: cache.t3.micro
                required:
                - appName
                - environment
            required:
            - parameters
```

## Claim-Based Self-Service Patterns

Claims are namespace-scoped resources that reference a Composite Resource. This enables developers to request infrastructure without cluster-admin access.

### Developer Workflow

```yaml
# In namespace: team-alpha
# claim-postgres.yaml
apiVersion: platform.example.com/v1alpha1
kind: PostgreSQLInstance
metadata:
  name: my-app-db
  namespace: team-alpha
spec:
  parameters:
    version: "15"
    storageGB: 100
    instanceClass: medium
    multiAZ: true
    backupRetentionDays: 14
    networkRef:
      id: prod-network
  # Where to write connection details for the app to consume
  writeConnectionSecretToRef:
    name: my-app-db-connection
```

Developers apply this and wait for readiness:

```bash
kubectl apply -f claim-postgres.yaml -n team-alpha

# Watch the claim status
kubectl get postgresqlinstances -n team-alpha -w
# NAME         READY   CONNECTION-SECRET       AGE
# my-app-db    False                           30s
# my-app-db    False   my-app-db-connection    2m
# my-app-db    True    my-app-db-connection    8m

# Check the connection secret
kubectl get secret my-app-db-connection -n team-alpha -o jsonpath='{.data.endpoint}' | base64 -d
```

### RBAC for Self-Service

```yaml
# rbac-claim-creator.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: crossplane-claim-creator
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
  name: team-alpha-crossplane-claims
  namespace: team-alpha
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: crossplane-claim-creator
subjects:
- kind: Group
  name: team-alpha-developers
  apiGroup: rbac.authorization.k8s.io
```

### Usage Policies with OPA/Gatekeeper

Enforce that production claims require specific parameters:

```yaml
# opa-policy-production-rds.yaml
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: CrossplanePostgreSQLPolicy
metadata:
  name: production-rds-requirements
spec:
  match:
    kinds:
    - apiGroups: ["platform.example.com"]
      kinds: ["PostgreSQLInstance"]
    namespaceSelector:
      matchLabels:
        environment: production
  parameters:
    requireMultiAZ: true
    minBackupRetentionDays: 7
    allowedInstanceClasses:
    - medium
    - large
    - xlarge
```

## Helm Provider: Managing Kubernetes Resources

The Helm provider allows Crossplane to manage Helm releases as managed resources, useful for platform-level tooling:

```yaml
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-helm
spec:
  package: xpkg.upbound.io/crossplane-contrib/provider-helm:v0.19.0
---
apiVersion: helm.crossplane.io/v1beta1
kind: ProviderConfig
metadata:
  name: default
spec:
  credentials:
    source: InjectedIdentity
```

Deploy an application via Helm as part of a Composition:

```yaml
# In a Composition resource list:
- name: monitoring-stack
  base:
    apiVersion: helm.crossplane.io/v1beta1
    kind: Release
    spec:
      forProvider:
        chart:
          name: kube-prometheus-stack
          repository: https://prometheus-community.github.io/helm-charts
          version: "55.0.0"
        namespace: monitoring
        values:
          prometheus:
            prometheusSpec:
              retention: 15d
          grafana:
            adminPassword: changeme
      providerConfigRef:
        name: default
```

## Migrating from Terraform to Crossplane

### Strategy: Import Existing Resources

For existing Terraform-managed resources, use the `crossplane-contrib/provider-aws` import capability:

```bash
# Step 1: Create the managed resource manifest matching the existing resource
cat > import-rds.yaml << 'EOF'
apiVersion: rds.aws.upbound.io/v1beta1
kind: Instance
metadata:
  name: existing-production-db
  annotations:
    # Tell Crossplane this resource already exists - don't create it
    crossplane.io/external-name: "my-existing-rds-identifier"
spec:
  forProvider:
    region: us-east-1
    engine: postgres
    # Fill in all required fields matching current state
    engineVersion: "15.4"
    instanceClass: db.m5.large
    allocatedStorage: 500
    storageType: gp3
    username: pgadmin
    skipFinalSnapshot: false
  providerConfigRef:
    name: default
EOF

# Step 2: Apply - Crossplane will OBSERVE the existing resource instead of creating
kubectl apply -f import-rds.yaml

# Step 3: Verify Crossplane acquired management
kubectl get instance.rds.aws.upbound.io existing-production-db -o jsonpath='{.status.conditions}' | jq .
```

### Terraform State Migration Script

```python
#!/usr/bin/env python3
"""
terraform_to_crossplane.py
Converts Terraform state file entries to Crossplane managed resource manifests.
"""

import json
import sys
import yaml
from typing import Dict, Any

def rds_instance_to_crossplane(tf_resource: Dict[str, Any]) -> Dict[str, Any]:
    """Convert a Terraform aws_db_instance resource to a Crossplane manifest."""
    attrs = tf_resource.get("instances", [{}])[0].get("attributes", {})

    return {
        "apiVersion": "rds.aws.upbound.io/v1beta1",
        "kind": "Instance",
        "metadata": {
            "name": tf_resource["name"].replace("_", "-"),
            "annotations": {
                "crossplane.io/external-name": attrs.get("id", ""),
            }
        },
        "spec": {
            "forProvider": {
                "region": attrs.get("availability_zone", "us-east-1a")[:-1],
                "engine": attrs.get("engine", ""),
                "engineVersion": attrs.get("engine_version_actual", ""),
                "instanceClass": attrs.get("instance_class", ""),
                "allocatedStorage": attrs.get("allocated_storage", 20),
                "storageType": attrs.get("storage_type", "gp2"),
                "storageEncrypted": attrs.get("storage_encrypted", False),
                "multiAz": attrs.get("multi_az", False),
                "backupRetentionPeriod": attrs.get("backup_retention_period", 7),
                "deletionProtection": attrs.get("deletion_protection", False),
                "publiclyAccessible": attrs.get("publicly_accessible", False),
                "username": attrs.get("username", ""),
                "skipFinalSnapshot": attrs.get("skip_final_snapshot", False),
            },
            "providerConfigRef": {
                "name": "default"
            }
        }
    }

def main():
    if len(sys.argv) < 2:
        print("Usage: terraform_to_crossplane.py terraform.tfstate")
        sys.exit(1)

    with open(sys.argv[1]) as f:
        state = json.load(f)

    converters = {
        "aws_db_instance": rds_instance_to_crossplane,
    }

    resources = []
    for resource in state.get("resources", []):
        resource_type = resource.get("type", "")
        if resource_type in converters:
            manifest = converters[resource_type](resource)
            resources.append(manifest)
            print(f"Converted: {resource_type}.{resource['name']}")
        else:
            print(f"Skipping unsupported type: {resource_type}", file=sys.stderr)

    output_file = "crossplane-manifests.yaml"
    with open(output_file, "w") as f:
        yaml.dump_all(resources, f, default_flow_style=False)

    print(f"\nWrote {len(resources)} manifests to {output_file}")

if __name__ == "__main__":
    main()
```

## Observability and Troubleshooting

### Monitoring Crossplane Health

```yaml
# prometheus-rules-crossplane.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: crossplane-alerts
  namespace: monitoring
spec:
  groups:
  - name: crossplane.managed_resources
    interval: 30s
    rules:
    - alert: CrossplaneManagedResourceNotReady
      expr: |
        crossplane_managed_resource_ready{ready="False"} == 1
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Crossplane managed resource not ready"
        description: "Resource {{ $labels.name }} of kind {{ $labels.kind }} has been unready for 5 minutes"

    - alert: CrossplaneManagedResourceSyncing
      expr: |
        crossplane_managed_resource_synced{synced="False"} == 1
      for: 10m
      labels:
        severity: critical
      annotations:
        summary: "Crossplane managed resource sync failing"
        description: "Resource {{ $labels.name }} of kind {{ $labels.kind }} has not synced for 10 minutes"

    - alert: CrossplaneProviderUnhealthy
      expr: |
        crossplane_pkg_revision_healthy{healthy="False"} == 1
      for: 2m
      labels:
        severity: critical
      annotations:
        summary: "Crossplane provider unhealthy"
        description: "Provider {{ $labels.name }} is unhealthy"
```

### Common Troubleshooting Commands

```bash
# Check provider health
kubectl get providers
# NAME                     INSTALLED   HEALTHY   PACKAGE                                         AGE
# provider-aws-s3          True        True      xpkg.upbound.io/upbound/provider-aws-s3:v1.1.0  2d
# provider-aws-rds         True        False     xpkg.upbound.io/upbound/provider-aws-rds:v1.1.0 2d

# Provider unhealthy - check events
kubectl describe provider provider-aws-rds

# Check a failing managed resource
kubectl get instance.rds.aws.upbound.io my-app-db -o yaml | yq .status

# View reconciliation events
kubectl get events --field-selector involvedObject.name=my-app-db --sort-by='.lastTimestamp'

# Check composition errors
kubectl get composite xpostgresqlinstance-abc123 -o yaml | yq .status.conditions

# Debug provider controller logs
kubectl logs -n crossplane-system \
  -l pkg.crossplane.io/revision=provider-aws-rds-abc123 \
  --tail=100 | grep -E 'error|Error|WARN|warn'

# List all managed resources with their sync status
kubectl get managed -o custom-columns=\
'NAME:.metadata.name,KIND:.kind,SYNCED:.status.conditions[?(@.type=="Synced")].status,READY:.status.conditions[?(@.type=="Ready")].status'
```

### Drift Detection and Correction

Crossplane continuously reconciles. To observe drift correction:

```bash
# Manually modify an RDS instance parameter in AWS Console (e.g., change backup retention)
# Crossplane will detect and correct this within the reconcile interval

# Watch for correction events
kubectl get events -w --field-selector reason=ReconcileSuccess

# Check the last sync time
kubectl get instance.rds.aws.upbound.io my-app-db \
  -o jsonpath='{.status.conditions[?(@.type=="Synced")].lastTransitionTime}'
```

## Production Best Practices

### Resource Lifecycle Management

```yaml
# Usage resource prevents accidental deletion of shared infrastructure
apiVersion: apiextensions.crossplane.io/v1alpha1
kind: Usage
metadata:
  name: protect-prod-vpc
spec:
  of:
    apiVersion: ec2.aws.upbound.io/v1beta1
    kind: VPC
    resourceRef:
      name: production-vpc
  by:
    apiVersion: platform.example.com/v1alpha1
    kind: XAppEnvironment
    resourceSelector:
      matchLabels:
        environment: production
```

### Environment-Specific Composition Selection

Use labels to select the correct Composition per environment:

```yaml
# In the XRD, specify which label selects the composition
apiVersion: apiextensions.crossplane.io/v1
kind: CompositeResourceDefinition
metadata:
  name: xpostgresqlinstances.platform.example.com
spec:
  # ...
  defaultCompositionRef:
    name: xpostgresqlinstances.aws.platform.example.com
  # Or let claims specify via label:
  # compositionSelector:
  #   matchLabels:
  #     provider: aws
```

Claims can request a specific composition:

```yaml
apiVersion: platform.example.com/v1alpha1
kind: PostgreSQLInstance
metadata:
  name: my-app-db
  namespace: team-alpha
spec:
  compositionSelector:
    matchLabels:
      provider: gcp  # Override to use GCP
  parameters:
    version: "15"
    storageGB: 100
    instanceClass: medium
    networkRef:
      id: prod-network
```

### GitOps Integration with ArgoCD

```yaml
# argocd-app-infrastructure.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: platform-infrastructure
  namespace: argocd
spec:
  project: platform
  source:
    repoURL: https://github.com/example/platform-infra
    targetRevision: main
    path: crossplane/compositions
  destination:
    server: https://kubernetes.default.svc
    namespace: crossplane-system
  syncPolicy:
    automated:
      prune: false   # Never auto-delete infrastructure
      selfHeal: true
    syncOptions:
    - CreateNamespace=true
    - ServerSideApply=true
---
# Separate app for team claims - reviewed and approved separately
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: team-alpha-claims
  namespace: argocd
spec:
  project: team-alpha
  source:
    repoURL: https://github.com/example/team-alpha-infra
    targetRevision: main
    path: claims
  destination:
    server: https://kubernetes.default.svc
    namespace: team-alpha
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

## Conclusion

Crossplane transforms Kubernetes into a complete infrastructure control plane. The key operational patterns are:

1. **Provider selection**: Use IRSA/Workload Identity for zero-credential-rotation authentication; fall back to Secret-based credentials with External Secrets rotation for non-cloud-native clusters
2. **XRD design**: Expose minimal, opinionated parameters to claims; encode organizational standards in Compositions
3. **Claim RBAC**: Namespace-scope claims with team-specific RoleBindings; use OPA policies for environment-specific guardrails
4. **Terraform migration**: Import existing resources using `crossplane.io/external-name` annotations before switching management
5. **Observability**: Monitor managed resource sync status with Prometheus; set alerts for resources stuck in non-ready states for more than 5 minutes

The operational investment in Crossplane pays off at scale: development teams get infrastructure on demand through familiar `kubectl` workflows, while platform teams maintain governance through Compositions and RBAC rather than manual approvals.
