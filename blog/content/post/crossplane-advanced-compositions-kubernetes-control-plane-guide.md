---
title: "Crossplane Advanced Compositions: Building an Internal Cloud Platform"
date: 2027-01-04T00:00:00-05:00
draft: false
tags: ["Crossplane", "Kubernetes", "Platform Engineering", "Infrastructure as Code"]
categories:
- Kubernetes
- Platform Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Crossplane Compositions, CompositeResourceDefinitions, Functions (including Go and Python), and Patch&Transform for building self-service cloud infrastructure platforms."
more_link: "yes"
url: "/crossplane-advanced-compositions-kubernetes-control-plane-guide/"
---

Platform engineering teams face a recurring challenge: infrastructure teams want Terraform's declarative model while application teams want Kubernetes-native APIs with RBAC, GitOps compatibility, and self-service. **Crossplane** resolves this tension by extending the Kubernetes API server with custom resource types that represent cloud infrastructure. Developers submit a `PostgreSQLInstance` or `MessageQueue` claim using `kubectl apply`, and Crossplane orchestrates the actual cloud resources through provider controllers — the same reconciliation loop that manages Pods manages RDS instances.

The real power of Crossplane is not individual resource management (that can be done with Terraform) but **Compositions**: reusable templates that encode your organization's infrastructure standards. A `DatabaseClaim` of type "production" might automatically provision an RDS Multi-AZ instance, a read replica, automated backups with 30-day retention, CloudWatch alarms, and a Secrets Manager entry — all from a four-line YAML submitted by an application team with no AWS knowledge required.

This guide covers advanced Composition patterns including Functions (the new pipeline-based composition model), EnvironmentConfigs for environment-specific configuration, the database-as-a-service abstraction pattern, and observability for troubleshooting complex compositions in production.

<!--more-->

## Crossplane as a Universal Control Plane

Crossplane extends Kubernetes with three layers of abstraction:

1. **Managed Resources (MR)**: Direct 1:1 mappings to cloud provider APIs. An `RDSInstance` managed resource maps directly to an AWS RDS instance. These are created and managed by provider controllers (provider-aws, provider-gcp, provider-azure).

2. **Composite Resources (XR)**: Multi-resource abstractions created from a `CompositeResourceDefinition` (XRD). An `XDatabase` might compose an `RDSInstance`, a `SubnetGroup`, a `SecurityGroup`, and a `Secret` into a single logical resource.

3. **Claims**: Namespace-scoped references to composite resources. Application teams create a `Database` claim in their namespace; Crossplane binds it to an `XDatabase` composite resource in the provider namespace.

This three-layer model provides critical separation of concerns:

```
Application Team                 Platform Team
─────────────────────────────────────────────────────
kubectl apply -f database-claim.yaml
       │
       ▼
Database (Claim)               XRD defines the schema
[namespace: my-app]            [cluster-scoped]
       │
       ▼ binds to
XDatabase (Composite Resource)  Composition defines the template
[cluster-scoped]               [cluster-scoped]
       │ composes
       ├─► RDSInstance          Managed by provider-aws
       ├─► SubnetGroup          Managed by provider-aws
       ├─► SecurityGroup        Managed by provider-aws
       └─► Secret               Kubernetes native
```

Install Crossplane:

```bash
helm repo add crossplane-stable https://charts.crossplane.io/stable
helm repo update

helm upgrade --install crossplane crossplane-stable/crossplane \
  --namespace crossplane-system \
  --create-namespace \
  --version 1.17.0 \
  --set args='{--enable-composition-functions,--enable-environment-configs}' \
  --wait
```

Install the AWS provider:

```bash
cat <<'EOF' | kubectl apply -f -
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws-rds
spec:
  package: xpkg.upbound.io/upbound/provider-aws-rds:v1.7.0
  runtimeConfigRef:
    name: provider-aws-rds-config
EOF
```

## XRD (CompositeResourceDefinition) Design

A well-designed XRD exposes a clean API that hides cloud-specific complexity. The schema should reflect what the application team needs to express, not what the cloud provider API accepts.

Design principles for XRDs:

- Expose **intent** (size: small/medium/large), not implementation (instanceClass: db.r6g.4xlarge)
- Make **safe defaults** automatic (backupRetentionDays defaults to 7)
- Expose **overrides** for teams that need them via optional fields
- Use **validation** (enums, patterns, min/max) to prevent misconfiguration

```yaml
# xrd-database.yaml
apiVersion: apiextensions.crossplane.io/v1
kind: CompositeResourceDefinition
metadata:
  name: xdatabases.platform.example.com
spec:
  group: platform.example.com
  names:
    kind: XDatabase
    plural: xdatabases
  claimNames:
    kind: Database
    plural: databases

  # Connection details that Crossplane will write to a Secret
  connectionSecretKeys:
    - endpoint
    - port
    - username
    - password
    - dbname

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
                  required: [engine, size, dbName]
                  properties:
                    engine:
                      type: string
                      enum: [postgres, mysql]
                      description: "Database engine type"
                    engineVersion:
                      type: string
                      default: "16.1"
                      description: "Engine version. Defaults to latest stable."
                    size:
                      type: string
                      enum: [small, medium, large, xlarge]
                      description: "Instance size tier"
                    dbName:
                      type: string
                      pattern: "^[a-z][a-z0-9_]{1,62}$"
                      description: "Database name"
                    highAvailability:
                      type: boolean
                      default: false
                      description: "Enable Multi-AZ deployment"
                    backupRetentionDays:
                      type: integer
                      minimum: 1
                      maximum: 35
                      default: 7
                    storageGB:
                      type: integer
                      minimum: 20
                      maximum: 65536
                      default: 100
                    allowedCIDRs:
                      type: array
                      items:
                        type: string
                        pattern: "^([0-9]{1,3}\\.){3}[0-9]{1,3}/[0-9]{1,2}$"
                      default: []
                      description: "Additional CIDR blocks allowed to connect"
                    deletionPolicy:
                      type: string
                      enum: [Delete, Orphan]
                      default: Delete
                      description: "What happens to the cloud resource when the claim is deleted"
```

## Composition with Patch and Transform

The traditional Crossplane composition model uses `Patch&Transform` to map claim fields to managed resource fields. While Functions (covered in the next section) are the recommended approach for complex compositions, `Patch&Transform` remains valuable for straightforward mappings.

```yaml
# composition-database-pt.yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: xdatabases-aws-postgres-pt
  labels:
    provider: aws
    engine: postgres
    mode: patch-transform
spec:
  compositeTypeRef:
    apiVersion: platform.example.com/v1alpha1
    kind: XDatabase

  # Patch&Transform mode — will be superseded by pipeline mode
  mode: Resources

  resources:
    - name: rds-instance
      base:
        apiVersion: rds.aws.upbound.io/v1beta1
        kind: Instance
        spec:
          forProvider:
            region: us-east-1
            dbName: placeholder
            engine: postgres
            instanceClass: db.t3.medium
            username: dbadmin
            skipFinalSnapshot: false
            autoMinorVersionUpgrade: true
            applyImmediately: false
            tags:
              ManagedBy: crossplane
          writeConnectionSecretToRef:
            namespace: crossplane-system
            name: placeholder

      patches:
        # Map size tier to instance class
        - type: CombineFromComposite
          combine:
            variables:
              - fromFieldPath: spec.parameters.size
            strategy: string
            string:
              fmt: |
                {{- if eq . "small" }}db.t3.micro{{- end -}}
                {{- if eq . "medium" }}db.r6g.large{{- end -}}
                {{- if eq . "large" }}db.r6g.4xlarge{{- end -}}
                {{- if eq . "xlarge" }}db.r6g.16xlarge{{- end -}}
          toFieldPath: spec.forProvider.instanceClass

        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.dbName
          toFieldPath: spec.forProvider.dbName

        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.engineVersion
          toFieldPath: spec.forProvider.engineVersion

        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.backupRetentionDays
          toFieldPath: spec.forProvider.backupRetentionPeriod

        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.storageGB
          toFieldPath: spec.forProvider.allocatedStorage

        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.highAvailability
          toFieldPath: spec.forProvider.multiAz

        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.deletionPolicy
          toFieldPath: spec.deletionPolicy

        # Construct the connection secret name from the composite resource name
        - type: FromCompositeFieldPath
          fromFieldPath: metadata.name
          toFieldPath: spec.writeConnectionSecretToRef.name
          transforms:
            - type: string
              string:
                fmt: "%s-connection"

      connectionDetails:
        - name: endpoint
          fromConnectionSecretKey: endpoint
        - name: port
          fromConnectionSecretKey: port
        - name: username
          fromConnectionSecretKey: username
        - name: password
          fromConnectionSecretKey: password
```

## Composition Functions (Go-based)

**Composition Functions** are the modern Crossplane composition model. A Function is a gRPC server deployed as a Kubernetes Pod that receives the composite resource state and returns the desired managed resource state. Functions replace the limited `Patch&Transform` language with full programming logic.

The two most important built-in functions are:

- `function-patch-and-transform`: Runs traditional P&T patches inside a pipeline
- `function-go-templating`: Renders Go templates to generate managed resource manifests

For complex logic, write a custom Function in Go:

```go
// main.go — Crossplane Function that implements database sizing logic
package main

import (
	"context"
	"fmt"

	"github.com/crossplane/crossplane-runtime/pkg/logging"
	fnv1beta1 "github.com/crossplane/function-sdk-go/proto/v1beta1"
	"github.com/crossplane/function-sdk-go/request"
	"github.com/crossplane/function-sdk-go/resource"
	"github.com/crossplane/function-sdk-go/resource/composed"
	"github.com/crossplane/function-sdk-go/response"
	"google.golang.org/protobuf/types/known/structpb"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

// Function implements the Crossplane Function RunFunctionRequest handler.
type Function struct {
	fnv1beta1.UnimplementedFunctionRunnerServiceServer
	log logging.Logger
}

// sizeConfig maps human-readable size tiers to AWS RDS instance classes and storage.
var sizeConfig = map[string]struct {
	InstanceClass string
	StorageType   string
	IOPS          int
}{
	"small":  {InstanceClass: "db.t3.micro", StorageType: "gp3", IOPS: 3000},
	"medium": {InstanceClass: "db.r6g.large", StorageType: "gp3", IOPS: 12000},
	"large":  {InstanceClass: "db.r6g.4xlarge", StorageType: "io1", IOPS: 64000},
	"xlarge": {InstanceClass: "db.r6g.16xlarge", StorageType: "io1", IOPS: 256000},
}

func (f *Function) RunFunction(ctx context.Context, req *fnv1beta1.RunFunctionRequest) (*fnv1beta1.RunFunctionResponse, error) {
	log := f.log.WithValues("tag", req.GetMeta().GetTag())

	rsp := response.To(req, response.DefaultTTL)

	// Get the observed composite resource
	xr, err := request.GetObservedCompositeResource(req)
	if err != nil {
		response.Fatal(rsp, fmt.Errorf("getting observed composite resource: %w", err))
		return rsp, nil
	}

	// Extract parameters from the composite resource spec
	size, err := xr.Resource.GetString("spec.parameters.size")
	if err != nil {
		response.Fatal(rsp, fmt.Errorf("getting size parameter: %w", err))
		return rsp, nil
	}

	dbName, err := xr.Resource.GetString("spec.parameters.dbName")
	if err != nil {
		response.Fatal(rsp, fmt.Errorf("getting dbName parameter: %w", err))
		return rsp, nil
	}

	engineVersion, _ := xr.Resource.GetString("spec.parameters.engineVersion")
	if engineVersion == "" {
		engineVersion = "16.1"
	}

	highAvailability, _ := xr.Resource.GetBool("spec.parameters.highAvailability")
	backupRetentionDays, _ := xr.Resource.GetNumber("spec.parameters.backupRetentionDays")
	storageGB, _ := xr.Resource.GetNumber("spec.parameters.storageGB")

	cfg, ok := sizeConfig[size]
	if !ok {
		response.Fatal(rsp, fmt.Errorf("unknown size tier: %s", size))
		return rsp, nil
	}

	// Build the desired RDS instance managed resource
	rdsInstance := composed.New(composed.FromFieldPathPatchedResource(
		map[string]interface{}{
			"apiVersion": "rds.aws.upbound.io/v1beta1",
			"kind":       "Instance",
			"metadata": map[string]interface{}{
				"name": xr.Resource.GetName() + "-rds",
				"annotations": map[string]interface{}{
					"crossplane.io/external-name": xr.Resource.GetName(),
				},
			},
			"spec": map[string]interface{}{
				"forProvider": map[string]interface{}{
					"region":                  "us-east-1",
					"dbName":                  dbName,
					"engine":                  "postgres",
					"engineVersion":           engineVersion,
					"instanceClass":           cfg.InstanceClass,
					"allocatedStorage":        int(storageGB),
					"storageType":             cfg.StorageType,
					"iops":                    cfg.IOPS,
					"multiAz":                 highAvailability,
					"backupRetentionPeriod":   int(backupRetentionDays),
					"skipFinalSnapshot":       false,
					"deletionProtection":      highAvailability, // Prevent accidental deletion of HA instances
					"autoMinorVersionUpgrade": true,
					"username":                "dbadmin",
					"tags": map[string]interface{}{
						"ManagedBy":      "crossplane",
						"CompositeOwner": xr.Resource.GetName(),
						"Size":           size,
					},
				},
				"writeConnectionSecretToRef": map[string]interface{}{
					"namespace": "crossplane-system",
					"name":      xr.Resource.GetName() + "-connection",
				},
			},
		},
	))

	// Set the desired composed resource
	desired, err := request.GetDesiredComposedResources(req)
	if err != nil {
		response.Fatal(rsp, fmt.Errorf("getting desired composed resources: %w", err))
		return rsp, nil
	}

	desired["rds-instance"] = &resource.DesiredComposed{Resource: rdsInstance}

	if err := response.SetDesiredComposedResources(rsp, desired); err != nil {
		response.Fatal(rsp, fmt.Errorf("setting desired composed resources: %w", err))
		return rsp, nil
	}

	log.Info("Composed RDS instance", "instanceClass", cfg.InstanceClass, "multiAz", highAvailability)
	return rsp, nil
}
```

Build and deploy the Function:

```bash
# Build the function image
docker build -t 123456789012.dkr.ecr.us-east-1.amazonaws.com/crossplane-fn-database:1.0.0 .
docker push 123456789012.dkr.ecr.us-east-1.amazonaws.com/crossplane-fn-database:1.0.0

# Register the function with Crossplane
cat <<'EOF' | kubectl apply -f -
apiVersion: pkg.crossplane.io/v1beta1
kind: Function
metadata:
  name: fn-database-composition
spec:
  package: 123456789012.dkr.ecr.us-east-1.amazonaws.com/crossplane-fn-database:1.0.0
EOF
```

## Pipeline Mode vs Resources Mode

Crossplane v1.14+ introduced **pipeline mode** as the replacement for the legacy `Resources` mode. In pipeline mode, a Composition defines an ordered list of functions that are called sequentially, with each function receiving and potentially modifying the accumulated desired state.

```yaml
# composition-database-pipeline.yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: xdatabases-aws-postgres
  labels:
    provider: aws
    engine: postgres
spec:
  compositeTypeRef:
    apiVersion: platform.example.com/v1alpha1
    kind: XDatabase

  mode: Pipeline

  pipeline:
    # Step 1: Custom Go function that implements sizing logic
    - step: compute-rds-config
      functionRef:
        name: fn-database-composition

    # Step 2: Apply patches using the built-in patch-and-transform function
    - step: apply-common-patches
      functionRef:
        name: function-patch-and-transform
      input:
        apiVersion: pt.fn.crossplane.io/v1beta1
        kind: Resources
        resources:
          - name: rds-instance
            patches:
              - type: FromCompositeFieldPath
                fromFieldPath: metadata.labels
                toFieldPath: spec.forProvider.tags
                policy:
                  mergeOptions:
                    appendSlice: true
                    keepMapValues: true

    # Step 3: Automatically ready-check using built-in readiness function
    - step: automatically-detect-readiness
      functionRef:
        name: function-auto-ready
```

## EnvironmentConfigs for Cross-Cutting Concerns

**EnvironmentConfigs** provide a cluster-scoped key-value store that Compositions can read from. This solves the problem of environment-specific configuration (VPC IDs, subnet IDs, KMS key ARNs) that must be injected into resources without requiring each team to know these values.

```yaml
# environment-config-production.yaml
apiVersion: apiextensions.crossplane.io/v1alpha1
kind: EnvironmentConfig
metadata:
  name: production-aws
  labels:
    environment: production
    region: us-east-1
data:
  # AWS networking configuration
  vpcId: vpc-0abc123def456789
  privateSubnetIds:
    - subnet-0111222333444555
    - subnet-0666777888999000
    - subnet-0aabbccddeeff112
  dbSubnetGroupName: prod-rds-subnet-group

  # Security
  kmsKeyArn: arn:aws:kms:us-east-1:123456789012:key/mrk-abc123
  defaultSecurityGroupId: sg-0abc123def456789

  # Monitoring
  enhancedMonitoringRoleArn: arn:aws:iam::123456789012:role/rds-enhanced-monitoring
  cloudwatchLogGroupRetentionDays: "30"

  # Tagging policy
  costCenter: platform-engineering
  owner: platform-team@example.com
```

Reference EnvironmentConfig values in a Composition:

```yaml
# In the Composition spec, add an environment section
spec:
  environment:
    environmentConfigs:
      - type: Selector
        selector:
          matchLabels:
            environment: production
            region: us-east-1

  pipeline:
    - step: apply-environment-patches
      functionRef:
        name: function-patch-and-transform
      input:
        apiVersion: pt.fn.crossplane.io/v1beta1
        kind: Resources
        resources:
          - name: rds-instance
            patches:
              - type: FromEnvironmentFieldPath
                fromFieldPath: dbSubnetGroupName
                toFieldPath: spec.forProvider.dbSubnetGroupNameRef.name

              - type: FromEnvironmentFieldPath
                fromFieldPath: kmsKeyArn
                toFieldPath: spec.forProvider.kmsKeyId

              - type: FromEnvironmentFieldPath
                fromFieldPath: costCenter
                toFieldPath: spec.forProvider.tags.CostCenter

              - type: FromEnvironmentFieldPath
                fromFieldPath: enhancedMonitoringRoleArn
                toFieldPath: spec.forProvider.monitoringRoleArn
```

## Provider Management and ProviderConfigs

A **ProviderConfig** specifies the credentials a provider uses to authenticate with the cloud API. In AWS, use IRSA for keyless authentication:

```yaml
# provider-config-aws.yaml
apiVersion: aws.upbound.io/v1beta1
kind: ProviderConfig
metadata:
  name: production
spec:
  credentials:
    source: IRSA
  assumeRoleWithWebIdentity:
    roleARN: arn:aws:iam::123456789012:role/crossplane-provider-aws
    sessionName: crossplane-provider
    tags:
      - key: ClaimedBy
        value: crossplane
```

The Crossplane provider service account needs IRSA annotation:

```bash
kubectl annotate serviceaccount \
  -n crossplane-system \
  provider-aws-rds \
  eks.amazonaws.com/role-arn=arn:aws:iam::123456789012:role/crossplane-provider-aws
```

For multi-account deployments, use a separate ProviderConfig per account with cross-account role assumption:

```yaml
apiVersion: aws.upbound.io/v1beta1
kind: ProviderConfig
metadata:
  name: account-production-eu
spec:
  credentials:
    source: IRSA
  assumeRoleWithWebIdentity:
    roleARN: arn:aws:iam::123456789012:role/crossplane-provider-aws
    sessionName: crossplane-provider
  assumeRoleChain:
    - roleARN: arn:aws:iam::987654321098:role/crossplane-cross-account
      sessionName: crossplane-eu
      tags:
        - key: Region
          value: eu-west-1
```

## Automated Testing with Crossplane CLI

The Crossplane CLI's `render` command validates compositions locally without connecting to a cluster. This enables CI/CD validation of composition changes:

```bash
# Install Crossplane CLI
curl -Lo crossplane "https://releases.crossplane.io/stable/v1.17.0/bin/linux_amd64/crossplane"
chmod +x crossplane
sudo mv crossplane /usr/local/bin/

# Render a composition locally to validate output
crossplane render \
  --composition composition-database-pipeline.yaml \
  --composite-resource database-claim.yaml \
  --function-credentials credentials.yaml \
  --observed observed-resources.yaml
```

Write a test harness as a shell script:

```bash
#!/usr/bin/env bash
# test-composition.sh — validate Crossplane composition output

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSITION="${SCRIPT_DIR}/../compositions/database-pipeline.yaml"
PASS=0
FAIL=0

run_test() {
  local test_name="$1"
  local claim_file="$2"
  local expected_instance_class="$3"
  local expected_multi_az="$4"

  echo "Testing: $test_name"

  output=$(crossplane render \
    --composition "$COMPOSITION" \
    --composite-resource "$claim_file" \
    2>&1)

  actual_class=$(echo "$output" | grep -o '"instanceClass":"[^"]*"' | cut -d'"' -f4)
  actual_multiaz=$(echo "$output" | grep -o '"multiAz":[a-z]*' | cut -d':' -f2)

  if [[ "$actual_class" == "$expected_instance_class" ]] && \
     [[ "$actual_multiaz" == "$expected_multi_az" ]]; then
    echo "  PASS: instanceClass=$actual_class, multiAz=$actual_multiaz"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: expected instanceClass=$expected_instance_class multiAz=$expected_multi_az"
    echo "        got instanceClass=$actual_class multiAz=$actual_multiaz"
    FAIL=$((FAIL + 1))
  fi
}

# Run test cases
run_test "small-ha"    "${SCRIPT_DIR}/testdata/claim-small-ha.yaml"    "db.t3.micro"       "true"
run_test "large-no-ha" "${SCRIPT_DIR}/testdata/claim-large-no-ha.yaml" "db.r6g.4xlarge"    "false"
run_test "xlarge-ha"   "${SCRIPT_DIR}/testdata/claim-xlarge-ha.yaml"   "db.r6g.16xlarge"   "true"

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
exit $FAIL
```

## Building a Database-as-a-Service Abstraction

The full database-as-a-service abstraction combines all the above patterns. An application team creates a claim:

```yaml
# my-app/database-claim.yaml
apiVersion: platform.example.com/v1alpha1
kind: Database
metadata:
  name: orders-db
  namespace: order-service
spec:
  parameters:
    engine: postgres
    engineVersion: "16.1"
    size: medium
    dbName: orders
    highAvailability: true
    backupRetentionDays: 14
    storageGB: 200
    deletionPolicy: Orphan   # Protect production data
  writeConnectionSecretToRef:
    name: orders-db-connection
```

The application reads the connection details from the secret Crossplane creates:

```yaml
# deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-service
  namespace: order-service
spec:
  template:
    spec:
      containers:
        - name: order-service
          image: 123456789012.dkr.ecr.us-east-1.amazonaws.com/order-service:2.4.1
          envFrom:
            - secretRef:
                name: orders-db-connection
```

The connection secret Crossplane creates contains:

```yaml
# Created automatically by Crossplane
apiVersion: v1
kind: Secret
metadata:
  name: orders-db-connection
  namespace: order-service
type: connection.crossplane.io/v1alpha1
data:
  endpoint: b3JkZXJzLWRiLmNsdXN0ZXIudXMtZWFzdC0xLnJkcy5hbWF6b25hd3MuY29t  # base64
  port: NTQzMg==
  username: ZGJhZG1pbg==
  password: eEsyIy4u...
  dbname: b3JkZXJz
```

## Observability and Debugging

Crossplane emits Kubernetes events and Prometheus metrics for composition debugging.

Check composition status:

```bash
# Check the claim status
kubectl describe database orders-db -n order-service

# Check the composite resource
kubectl describe xdatabase orders-db-xxxxx

# Check individual managed resources
kubectl describe instance orders-db-xxxxx-rds

# View all Crossplane managed resources across all providers
kubectl get managed --all-namespaces

# Check function pod logs for Function-mode compositions
kubectl logs -n crossplane-system \
  -l pkg.crossplane.io/function=fn-database-composition \
  --tail=100
```

A PrometheusRule for Crossplane health alerting:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: crossplane-composition-alerts
  namespace: crossplane-system
spec:
  groups:
    - name: crossplane.composition
      interval: 30s
      rules:
        - alert: CrossplaneResourceNotReady
          expr: |
            crossplane_managed_resource_ready{ready="False"} > 0
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "Crossplane managed resource has been unready for 15 minutes"
            description: "Resource {{ $labels.name }} of kind {{ $labels.kind }} is not ready."

        - alert: CrossplaneCompositeResourceUnhealthy
          expr: |
            crossplane_composite_resource_ready{ready="False"} > 0
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Crossplane composite resource is unhealthy"
            description: "Composite {{ $labels.name }} of kind {{ $labels.kind }} is not ready."

        - alert: CrossplaneProviderUnhealthy
          expr: |
            crossplane_provider_installed{installed="True"} == 0
            or crossplane_provider_healthy{healthy="True"} == 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Crossplane provider is not healthy"
            description: "Provider {{ $labels.name }} is not installed or healthy."
```

## Conclusion

Crossplane Compositions provide a Kubernetes-native path to building internal developer platforms where infrastructure is versioned, reviewed, and deployed with the same GitOps workflows as application code. Key takeaways from this guide:

- Design XRDs around developer intent (size: medium) rather than cloud API parameters (instanceClass: db.r6g.large); the Composition handles the translation and encodes your organization's standards
- Prefer Pipeline mode with Functions over the legacy Resources/Patch&Transform mode for new compositions; Functions unlock full programming logic and are composable
- EnvironmentConfigs solve the cross-cutting configuration injection problem without requiring each XRD to expose provider-specific fields like VPC IDs or KMS key ARNs
- Test compositions locally with `crossplane render` before deploying; catching composition errors in CI is far cheaper than debugging broken managed resources in production
- The database-as-a-service pattern demonstrates the full value proposition: application teams get a four-line YAML claim, the platform team encodes all operational requirements (HA, backups, monitoring, tagging) in the Composition, and neither team needs to know what the other is doing
