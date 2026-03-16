---
title: "Pulumi Kubernetes Operator: GitOps with Infrastructure-as-Code"
date: 2027-04-08T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Pulumi", "GitOps", "Operator", "Infrastructure as Code"]
categories: ["Kubernetes", "GitOps", "Infrastructure as Code"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Guide to Pulumi Kubernetes Operator for GitOps-style Kubernetes management, covering Stack CRD configuration, Git repository polling, Pulumi state backends, stack references for multi-stack dependencies, environment variable injection, and integration with external secrets management."
more_link: "yes"
url: "/pulumi-kubernetes-operator-gitops-guide/"
---

The Pulumi Kubernetes Operator brings GitOps-style continuous reconciliation to Pulumi programs. Rather than running `pulumi up` from a CI pipeline and moving on, the operator continuously polls a Git repository and reconciles cluster state whenever the program or its configuration changes. The key advantage over Pulumi CI pipelines is that the operator handles drift: if someone manually modifies a resource, the next reconciliation cycle detects and corrects it without requiring a new commit.

This guide covers the operator's architecture, Stack CRD configuration, secret injection patterns, multi-environment promotion, and observability for production deployments.

<!--more-->

## Operator Architecture

### Components and Reconciliation Model

The Pulumi Kubernetes Operator runs as a standard Kubernetes Deployment and watches for `Stack` custom resources. Each Stack CR points to a Git repository containing a Pulumi program, specifies a stack name (which maps to Pulumi state), and defines how to inject secrets and configuration. The operator reconciles on a polling interval and after any Stack CR update.

```
Git Repository ──► Operator Pod ──► Pulumi Up ──► Cloud / Kubernetes APIs
     │                   │                │
  Stack CR          State Backend    Stack Outputs
  (defines what)   (S3, Pulumi Cloud)  (shared via StackReferences)
```

### Operator Installation

```bash
# Install with Helm (recommended for production)
helm repo add pulumi-operator https://pulumi.github.io/pulumi-kubernetes-operator
helm repo update

helm install pulumi-operator pulumi-operator/pulumi-kubernetes-operator \
  --namespace pulumi-operator \
  --create-namespace \
  --version "1.14.0" \
  --set "resources.requests.cpu=100m" \
  --set "resources.requests.memory=256Mi" \
  --set "resources.limits.cpu=1" \
  --set "resources.limits.memory=1Gi"
```

```yaml
# kubernetes/pulumi-operator/values-override.yaml — Production Helm values

replicaCount: 2  # HA deployment

resources:
  requests:
    cpu: "200m"
    memory: "512Mi"
  limits:
    cpu: "2"
    memory: "2Gi"

# RBAC for the operator to manage cluster resources
rbac:
  create: true
  # Grant cluster-admin if managing cluster-level resources
  # Scope down for namespace-scoped programs
  clusterRole: cluster-admin

serviceAccount:
  create: true
  name: pulumi-operator
  annotations:
    # EKS IRSA — operator needs AWS access for S3 state backend
    eks.amazonaws.com/role-arn: "arn:aws:iam::123456789012:role/pulumi-operator"

metrics:
  enabled: true
  serviceMonitor:
    enabled: true
    # Labels required by your Prometheus operator selector
    additionalLabels:
      release: prometheus

podDisruptionBudget:
  enabled: true
  minAvailable: 1

affinity:
  podAntiAffinity:
    preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 100
        podAffinityTerm:
          labelSelector:
            matchLabels:
              app.kubernetes.io/name: pulumi-kubernetes-operator
          topologyKey: kubernetes.io/hostname
```

## Stack CRD Configuration

### Basic Stack Resource

```yaml
# stacks/platform-infra.yaml — Stack CR for platform infrastructure

apiVersion: pulumi.com/v1
kind: Stack
metadata:
  name: platform-infra-prod
  namespace: pulumi-operator
  labels:
    app.kubernetes.io/managed-by: pulumi-operator
    support.tools/environment: prod
    support.tools/team: platform
spec:
  # Git repository containing the Pulumi program
  projectRepo: "https://github.com/acme-corp/platform-infra.git"

  # Branch to track — use main for production, feature branches for dev
  branch: "refs/heads/main"

  # Stack name in Pulumi state — corresponds to the Pulumi stack
  # Must match: pulumi stack select acme-corp/platform-infra/prod
  stack: "acme-corp/platform-infra/prod"

  # Pulumi state backend configuration
  backend: "s3://acme-pulumi-state-prod/platform-infra?region=us-east-1"

  # Subdirectory within the repo containing the Pulumi project
  repoDir: "platform"

  # Polling interval for Git repository changes
  continueResyncOnCommitMatch: true

  # Destroy resources when the Stack CR is deleted
  destroyOnFinalize: false

  # Environment variables injected into the Pulumi process
  envRefs:
    # Pulumi access token for state backend (if using Pulumi Cloud)
    PULUMI_ACCESS_TOKEN:
      type: Secret
      secret:
        name: pulumi-access-token
        key: access-token
    # AWS credentials via IRSA are injected automatically via the service account
    # Additional configuration values
    PULUMI_CONFIG_PASSPHRASE:
      type: Secret
      secret:
        name: pulumi-passphrase
        key: passphrase

  # Stack configuration values (equivalent to pulumi config set)
  config:
    aws:region: us-east-1
    platform-infra:clusterName: prod-us-east-1
    platform-infra:environment: prod
    platform-infra:vpcId: vpc-0a1b2c3d4e5f67890

  # Commit hash to pin — useful for rollbacks
  # commit: "a1b2c3d4e5f6789012345678901234567890abcd"

  # Git authentication — reference the deploy key secret
  gitAuth:
    sshPrivateKey:
      type: Secret
      secret:
        name: platform-infra-deploy-key
        key: id_rsa
```

### Stack with Detailed Field Configuration

```yaml
# stacks/networking-stack.yaml

apiVersion: pulumi.com/v1
kind: Stack
metadata:
  name: networking-prod
  namespace: pulumi-operator
spec:
  projectRepo: "https://github.com/acme-corp/networking.git"
  branch: "refs/heads/release/prod"
  stack: "acme-corp/networking/prod"

  # Use S3 as the state backend instead of Pulumi Cloud
  backend: "s3://acme-pulumi-state-prod/networking?region=us-east-1"
  repoDir: "."

  # Custom workspace image with additional tools pre-installed
  workspaceTemplate:
    spec:
      image: "acme-corp-registry.example.com/pulumi-workspace:3.109.0-aws"
      imagePullPolicy: Always
      imagePullSecrets:
        - name: registry-credentials
      # Resource limits for the workspace pod
      resources:
        requests:
          cpu: "500m"
          memory: "1Gi"
        limits:
          cpu: "2"
          memory: "4Gi"
      # Service account with necessary cloud permissions
      serviceAccountName: pulumi-workspace-prod
      # Additional environment variables for the workspace
      env:
        - name: PULUMI_SKIP_UPDATE_CHECK
          value: "true"
        - name: PULUMI_EXPERIMENTAL
          value: "true"

  envRefs:
    PULUMI_CONFIG_PASSPHRASE:
      type: Secret
      secret:
        name: pulumi-passphrases
        key: networking-prod

  # Pulumi stack configuration values
  config:
    aws:region: us-east-1
    networking:vpcCidr: "10.0.0.0/16"
    networking:availabilityZones: '["us-east-1a","us-east-1b","us-east-1c"]'
    networking:enableTransitGateway: "true"
    networking:transitGatewayId: "tgw-0a1b2c3d4e5f67890"

  # Secrets config — values are stored encrypted in Pulumi state
  secretsConfig:
    provider: awskms
    state:
      keyId: "arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012"

  # Stack outputs are available as Kubernetes secrets
  # after successful reconciliation
  savingsConfig:
    enabled: true
    secretName: networking-outputs
```

## Git Repository Polling with Deploy Keys

### Deploy Key Setup

```bash
# Generate a dedicated deploy key for each repository
# Use separate keys per repository for isolation
ssh-keygen -t ed25519 -C "pulumi-operator@prod" \
  -f /tmp/platform-infra-deploy-key -N ""

# Add the public key as a deploy key in GitHub
# (read-only access is sufficient for the operator)
cat /tmp/platform-infra-deploy-key.pub

# Create the Kubernetes secret with the private key
kubectl create secret generic platform-infra-deploy-key \
  --namespace pulumi-operator \
  --from-file=id_rsa=/tmp/platform-infra-deploy-key

# Clean up the local key files
rm /tmp/platform-infra-deploy-key /tmp/platform-infra-deploy-key.pub
```

```yaml
# The Stack CR references the deploy key secret
spec:
  gitAuth:
    sshPrivateKey:
      type: Secret
      secret:
        name: platform-infra-deploy-key  # Secret created above
        key: id_rsa

  # For HTTPS repos, use personal access token
  # gitAuth:
  #   accessToken:
  #     type: Secret
  #     secret:
  #       name: github-pat
  #       key: token
```

### Repository Structure for Operator Compatibility

```
platform-infra/          ← Git repository root
├── platform/            ← repoDir points here
│   ├── Pulumi.yaml      ← Pulumi project file
│   ├── Pulumi.prod.yaml ← Stack-specific config (git-committed, non-secret)
│   ├── index.ts         ← Program entry point (TypeScript)
│   ├── package.json
│   └── tsconfig.json
├── networking/
│   ├── Pulumi.yaml
│   └── index.ts
└── .github/
    └── workflows/
        └── validate.yaml  ← PR validation (pulumi preview)
```

```yaml
# platform/Pulumi.yaml

name: platform-infra
runtime:
  name: nodejs
  options:
    typescript: true

description: Platform infrastructure managed by Pulumi Kubernetes Operator

# Plugins pinned for reproducibility
plugins:
  providers:
    - name: aws
      version: 6.28.0
    - name: kubernetes
      version: 4.10.0
```

## Pulumi State Backends

### S3 Backend Configuration

```typescript
// platform/index.ts — Pulumi program using S3 state backend

import * as aws from "@pulumi/aws";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

// Configuration loaded from stack config and environment
const config = new pulumi.Config();
const clusterName = config.require("clusterName");
const environment = config.require("environment");
const vpcId = config.require("vpcId");

// Stack reference to consume outputs from the networking stack
// This is how stacks share data without tight coupling
const networkingStack = new pulumi.StackReference(
  `acme-corp/networking/${environment}`,
  {
    // Optionally pin to a specific version
    // version: 42,
  }
);

// Consume networking stack outputs
const privateSubnetIds = networkingStack.requireOutput("privateSubnetIds");
const securityGroupId = networkingStack.requireOutput("clusterSecurityGroupId");

// Create an S3 bucket — example resource managed by this stack
const logsBucket = new aws.s3.Bucket(`${clusterName}-logs`, {
  bucket: `acme-${clusterName}-application-logs`,
  tags: {
    Environment: environment,
    ManagedBy: "pulumi",
    Stack: pulumi.getStack(),
  },
});

// Configure bucket encryption
new aws.s3.BucketServerSideEncryptionConfigurationV2(
  `${clusterName}-logs-encryption`,
  {
    bucket: logsBucket.id,
    rules: [
      {
        applyServerSideEncryptionByDefault: {
          sseAlgorithm: "aws:kms",
        },
      },
    ],
  }
);

// Export stack outputs — consumed by other stacks via StackReference
export const logsBucketName = logsBucket.bucket;
export const logsBucketArn = logsBucket.arn;
```

### Pulumi Cloud Backend with Organizations

```yaml
# stacks/using-pulumi-cloud.yaml — Using Pulumi Cloud for state

apiVersion: pulumi.com/v1
kind: Stack
metadata:
  name: app-platform-staging
  namespace: pulumi-operator
spec:
  projectRepo: "https://github.com/acme-corp/app-platform.git"
  branch: "refs/heads/main"
  # stack format: org/project/stack
  stack: "acme-corp/app-platform/staging"

  # No backend field = use Pulumi Cloud (the default)
  # The PULUMI_ACCESS_TOKEN envRef authenticates to Pulumi Cloud

  envRefs:
    PULUMI_ACCESS_TOKEN:
      type: Secret
      secret:
        name: pulumi-cloud-token
        key: access-token
```

```bash
# Create the Pulumi Cloud access token secret
# Generate a token at: https://app.pulumi.com/acme-corp/settings/tokens
kubectl create secret generic pulumi-cloud-token \
  --namespace pulumi-operator \
  --from-literal=access-token="EXAMPLE_PULUMI_TOKEN_REPLACE_ME"
```

## Secret Environment Variable Injection

### Kubernetes Secrets as EnvRefs

```yaml
# stacks/app-with-secrets.yaml — comprehensive secret injection

apiVersion: pulumi.com/v1
kind: Stack
metadata:
  name: payments-service-prod
  namespace: pulumi-operator
spec:
  projectRepo: "https://github.com/acme-corp/payments-infra.git"
  branch: "refs/heads/main"
  stack: "acme-corp/payments-infra/prod"
  backend: "s3://acme-pulumi-state-prod/payments?region=us-east-1"

  envRefs:
    # State passphrase — required for encrypted state
    PULUMI_CONFIG_PASSPHRASE:
      type: Secret
      secret:
        name: pulumi-passphrases
        key: payments-prod

    # Database credentials passed to the Pulumi program
    DB_PASSWORD:
      type: Secret
      secret:
        name: payments-db-credentials
        key: password

    # Stripe API key — injected and used by Pulumi to create Stripe resources
    # or configure application secrets
    STRIPE_SECRET_KEY:
      type: Secret
      secret:
        name: payments-api-keys
        key: stripe-secret

    # Literal values (not secrets) can use type: Literal
    DEPLOYMENT_REGION:
      type: Literal
      literal:
        value: "us-east-1"

  # Pulumi config values for the stack
  # Non-sensitive values only — secrets use envRefs
  config:
    payments-infra:environment: prod
    payments-infra:replicaCount: "3"
    payments-infra:dbHost: "postgres-rw.database.svc.cluster.local"
```

### Integration with External Secrets Operator

```yaml
# external-secrets/pulumi-secrets.yaml — Sync secrets from AWS Secrets Manager

apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: payments-db-credentials
  namespace: pulumi-operator
spec:
  refreshInterval: "1h"

  secretStoreRef:
    kind: ClusterSecretStore
    name: aws-secretsmanager

  target:
    name: payments-db-credentials
    creationPolicy: Owner
    template:
      type: Opaque

  data:
    - secretKey: password
      remoteRef:
        key: "prod/postgres/payments"
        property: password

---
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: payments-api-keys
  namespace: pulumi-operator
spec:
  refreshInterval: "1h"

  secretStoreRef:
    kind: ClusterSecretStore
    name: aws-secretsmanager

  target:
    name: payments-api-keys
    creationPolicy: Owner

  data:
    - secretKey: stripe-secret
      remoteRef:
        key: "prod/payments/stripe"
        property: secret_key
```

## Stack References for Output Sharing

### Multi-Stack Architecture

```typescript
// networking/index.ts — Networking stack that exports outputs

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();
const environment = config.require("environment");
const vpcCidr = config.require("vpcCidr");

// Create VPC
const vpc = new aws.ec2.Vpc(`vpc-${environment}`, {
  cidrBlock: vpcCidr,
  enableDnsHostnames: true,
  enableDnsSupport: true,
  tags: {
    Name: `acme-${environment}`,
    Environment: environment,
    ManagedBy: "pulumi",
  },
});

// Create subnets across availability zones
const azs = ["us-east-1a", "us-east-1b", "us-east-1c"];

const privateSubnets = azs.map(
  (az, i) =>
    new aws.ec2.Subnet(`private-${az}`, {
      vpcId: vpc.id,
      cidrBlock: `10.0.${i + 1}.0/24`,
      availabilityZone: az,
      tags: {
        Name: `acme-${environment}-private-${az}`,
        "kubernetes.io/role/internal-elb": "1",
      },
    })
);

// Export outputs for consumption by other stacks
export const vpcId = vpc.id;
export const privateSubnetIds = privateSubnets.map((s) => s.id);
export const vpcCidrBlock = vpc.cidrBlock;
```

```typescript
// eks-cluster/index.ts — EKS stack consuming networking outputs

import * as aws from "@pulumi/aws";
import * as eks from "@pulumi/eks";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();
const environment = config.require("environment");

// Reference the networking stack to get VPC/subnet IDs
// The stack name must match the Stack CR's stack field
const networkingStack = new pulumi.StackReference(
  `acme-corp/networking/${environment}`
);

// These are Pulumi Outputs — they resolve asynchronously
const vpcId = networkingStack.requireOutput("vpcId") as pulumi.Output<string>;
const subnetIds = networkingStack.requireOutput(
  "privateSubnetIds"
) as pulumi.Output<string[]>;

// Create EKS cluster using networking outputs
const cluster = new eks.Cluster(`eks-${environment}`, {
  vpcId: vpcId,
  subnetIds: subnetIds,
  instanceType: "m5.xlarge",
  desiredCapacity: 3,
  minSize: 3,
  maxSize: 10,
  tags: {
    Environment: environment,
    ManagedBy: "pulumi",
  },
});

export const clusterName = cluster.eksCluster.name;
export const clusterEndpoint = cluster.eksCluster.endpoint;
export const kubeconfig = pulumi.secret(cluster.kubeconfig);
```

### Stack Reference CR Dependencies

```yaml
# stacks/eks-cluster.yaml — depends on networking stack

apiVersion: pulumi.com/v1
kind: Stack
metadata:
  name: eks-cluster-prod
  namespace: pulumi-operator
  annotations:
    # Document the dependency — the operator doesn't enforce order
    # but this is useful for documentation
    "pulumi.com/depends-on": "networking-prod"
spec:
  projectRepo: "https://github.com/acme-corp/eks-cluster.git"
  branch: "refs/heads/main"
  stack: "acme-corp/eks-cluster/prod"
  backend: "s3://acme-pulumi-state-prod/eks-cluster?region=us-east-1"

  envRefs:
    PULUMI_CONFIG_PASSPHRASE:
      type: Secret
      secret:
        name: pulumi-passphrases
        key: eks-cluster-prod

  config:
    eks-cluster:environment: prod
    eks-cluster:instanceType: m5.xlarge
    eks-cluster:desiredCapacity: "3"
```

## Multi-Environment Promotion

### Environment-Specific Stack Configuration

```bash
# scripts/promote.sh — Promote a commit from staging to production

set -euo pipefail

SOURCE_ENV="${1:-staging}"
TARGET_ENV="${2:-prod}"
REPO="acme-corp/platform-infra"

# Get the current commit hash deployed in source environment
SOURCE_STACK_NAME="platform-infra-${SOURCE_ENV}"
CURRENT_COMMIT=$(kubectl get stack "${SOURCE_STACK_NAME}" \
  --namespace pulumi-operator \
  -o jsonpath='{.status.lastUpdate.state}')

echo "Promoting commit from ${SOURCE_ENV} to ${TARGET_ENV}"
echo "Last successful state: ${CURRENT_COMMIT}"

# Update the target Stack CR to pin the source branch's HEAD commit
# This ensures exactly the same code runs in prod
SOURCE_BRANCH_COMMIT=$(kubectl get stack "${SOURCE_STACK_NAME}" \
  --namespace pulumi-operator \
  -o jsonpath='{.status.lastUpdate.permalink}')

echo "Source permalink: ${SOURCE_BRANCH_COMMIT}"

# Patch the production stack to use the specific commit
# This prevents unexpected updates from branch HEAD
kubectl patch stack "platform-infra-${TARGET_ENV}" \
  --namespace pulumi-operator \
  --type merge \
  --patch "{\"spec\":{\"commit\":\"${SOURCE_BRANCH_COMMIT}\"}}"

echo "Promotion complete — monitoring production reconciliation"

# Watch the stack status
kubectl get stack "platform-infra-${TARGET_ENV}" \
  --namespace pulumi-operator \
  --watch
```

### Stack CR Templates per Environment

```yaml
# stacks/platform-infra-dev.yaml

apiVersion: pulumi.com/v1
kind: Stack
metadata:
  name: platform-infra-dev
  namespace: pulumi-operator
spec:
  projectRepo: "https://github.com/acme-corp/platform-infra.git"
  branch: "refs/heads/main"
  stack: "acme-corp/platform-infra/dev"
  backend: "s3://acme-pulumi-state-dev/platform?region=us-east-1"
  # Dev refreshes more frequently to catch issues early
  continueResyncOnCommitMatch: true
  config:
    platform-infra:environment: dev
    platform-infra:clusterName: dev-us-east-1
    platform-infra:replicaCount: "1"  # Minimal replicas in dev

---
# stacks/platform-infra-staging.yaml

apiVersion: pulumi.com/v1
kind: Stack
metadata:
  name: platform-infra-staging
  namespace: pulumi-operator
spec:
  projectRepo: "https://github.com/acme-corp/platform-infra.git"
  branch: "refs/heads/main"
  stack: "acme-corp/platform-infra/staging"
  backend: "s3://acme-pulumi-state-staging/platform?region=us-east-1"
  config:
    platform-infra:environment: staging
    platform-infra:clusterName: staging-us-east-1
    platform-infra:replicaCount: "2"

---
# stacks/platform-infra-prod.yaml

apiVersion: pulumi.com/v1
kind: Stack
metadata:
  name: platform-infra-prod
  namespace: pulumi-operator
spec:
  projectRepo: "https://github.com/acme-corp/platform-infra.git"
  # Production tracks the release branch, not main
  branch: "refs/heads/release/prod"
  stack: "acme-corp/platform-infra/prod"
  backend: "s3://acme-pulumi-state-prod/platform?region=us-east-1"
  # destroyOnFinalize prevents accidental production destroy
  destroyOnFinalize: false
  config:
    platform-infra:environment: prod
    platform-infra:clusterName: prod-us-east-1
    platform-infra:replicaCount: "3"
```

## RBAC for Operator Service Account

```yaml
# rbac/operator-rbac.yaml — RBAC for the Pulumi operator

apiVersion: v1
kind: ServiceAccount
metadata:
  name: pulumi-operator
  namespace: pulumi-operator
  annotations:
    # EKS IRSA annotation for AWS API access
    eks.amazonaws.com/role-arn: "arn:aws:iam::123456789012:role/pulumi-operator"

---
# ClusterRole for cluster-wide resource management
# Scope this down based on what your programs actually manage
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: pulumi-operator
rules:
  # Core resources
  - apiGroups: [""]
    resources:
      - namespaces
      - configmaps
      - secrets
      - serviceaccounts
      - services
      - persistentvolumeclaims
    verbs: ["*"]

  # Workload resources
  - apiGroups: ["apps"]
    resources:
      - deployments
      - statefulsets
      - daemonsets
    verbs: ["*"]

  # RBAC management (operator creates roles for managed applications)
  - apiGroups: ["rbac.authorization.k8s.io"]
    resources:
      - roles
      - rolebindings
      - clusterroles
      - clusterrolebindings
    verbs: ["*"]

  # CRDs for managed custom resources
  - apiGroups: ["apiextensions.k8s.io"]
    resources:
      - customresourcedefinitions
    verbs: ["*"]

  # Stack CRDs managed by the operator itself
  - apiGroups: ["pulumi.com"]
    resources:
      - stacks
      - stacks/status
      - stacks/finalizers
      - programs
    verbs: ["*"]

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: pulumi-operator
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: pulumi-operator
subjects:
  - kind: ServiceAccount
    name: pulumi-operator
    namespace: pulumi-operator
```

## Failure Handling and Retry Configuration

### Stack Status and Failure Diagnosis

```bash
# Inspect stack reconciliation status

# Check current state of all stacks
kubectl get stacks --namespace pulumi-operator

# Detailed status for a specific stack
kubectl describe stack platform-infra-prod --namespace pulumi-operator

# View operator logs for reconciliation details
kubectl logs --namespace pulumi-operator \
  --selector app.kubernetes.io/name=pulumi-kubernetes-operator \
  --tail=200 \
  --follow

# View workspace pod logs for the actual pulumi up output
# Workspace pods are created temporarily during reconciliation
kubectl logs --namespace pulumi-operator \
  --selector pulumi.com/stack=platform-infra-prod \
  --container pulumi \
  --previous  # View logs from the last reconciliation
```

```yaml
# Example Stack status after a failure
# kubectl get stack platform-infra-prod -n pulumi-operator -o yaml

status:
  conditions:
    - lastTransitionTime: "2027-04-07T10:23:45Z"
      message: "pulumi up failed: error: resource 'arn:aws:s3:::acme-prod-logs' was not found"
      reason: ReconcileError
      status: "False"
      type: Ready
  lastUpdate:
    state: failed
    time: "2027-04-07T10:23:45Z"
    # Permalink to the Pulumi update that failed
    permalink: "https://app.pulumi.com/acme-corp/platform-infra/prod/updates/42"
  observedGeneration: 5
```

### Retry and Recovery Patterns

```yaml
# stacks/with-retry.yaml — Stack with retry configuration

apiVersion: pulumi.com/v1
kind: Stack
metadata:
  name: platform-infra-prod
  namespace: pulumi-operator
  annotations:
    # Operator retries reconciliation after failure
    # Default backoff: 10s, 20s, 40s... up to max
    "pulumi.com/retry-on-update-conflict": "true"
spec:
  projectRepo: "https://github.com/acme-corp/platform-infra.git"
  branch: "refs/heads/main"
  stack: "acme-corp/platform-infra/prod"
  backend: "s3://acme-pulumi-state-prod/platform?region=us-east-1"

  # Refresh state before applying — detects out-of-band changes
  refresh: true

  # Mark resources that should not be deleted during reconciliation
  # Equivalent to pulumi up --target-dependents
  targets:
    - "urn:pulumi:prod::platform-infra::aws:s3/bucket:Bucket::acme-prod-logs"

  envRefs:
    PULUMI_CONFIG_PASSPHRASE:
      type: Secret
      secret:
        name: pulumi-passphrases
        key: platform-prod
```

```bash
# Recovery commands for stuck reconciliation

# Force a re-reconciliation by updating a label
kubectl patch stack platform-infra-prod \
  --namespace pulumi-operator \
  --type merge \
  --patch '{"metadata":{"labels":{"pulumi.com/force-reconcile":"'$(date +%s)'"}}}'

# Cancel a running reconciliation (delete the workspace pod)
# The operator will restart reconciliation from scratch
WORKSPACE_POD=$(kubectl get pods --namespace pulumi-operator \
  --selector "pulumi.com/stack=platform-infra-prod" \
  -o jsonpath='{.items[0].metadata.name}')
kubectl delete pod "${WORKSPACE_POD}" --namespace pulumi-operator

# Temporarily pause reconciliation
kubectl patch stack platform-infra-prod \
  --namespace pulumi-operator \
  --type merge \
  --patch '{"spec":{"continueResyncOnCommitMatch":false}}'
```

## Prometheus Metrics for Stack Reconciliation

```yaml
# monitoring/stack-alerts.yaml — Alerting on reconciliation failures

apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: pulumi-operator-alerts
  namespace: monitoring
  labels:
    release: prometheus  # Required by Prometheus operator selector
spec:
  groups:
    - name: pulumi-operator
      interval: 60s
      rules:
        # Alert when a stack has been failing for more than 30 minutes
        - alert: PulumiStackReconcileFailing
          expr: |
            pulumi_kubernetes_operator_stack_reconcile_errors_total > 0
          for: 30m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "Pulumi stack reconciliation failing"
            description: "Stack {{ $labels.namespace }}/{{ $labels.stack }} has been failing to reconcile for 30 minutes."
            runbook: "https://runbooks.acme-corp.example.com/pulumi-stack-failure"

        # Alert when reconciliation has not run in over 2 hours
        - alert: PulumiStackNotReconciled
          expr: |
            time() - pulumi_kubernetes_operator_stack_last_reconcile_timestamp > 7200
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Pulumi stack not reconciling"
            description: "Stack {{ $labels.stack }} has not been reconciled in over 2 hours."
```

```yaml
# monitoring/stack-dashboard.yaml — Grafana dashboard via ConfigMap

apiVersion: v1
kind: ConfigMap
metadata:
  name: pulumi-operator-dashboard
  namespace: monitoring
  labels:
    grafana_dashboard: "1"  # Grafana sidecar auto-imports this
data:
  pulumi-operator.json: |
    {
      "title": "Pulumi Kubernetes Operator",
      "panels": [
        {
          "title": "Stack Reconciliation Status",
          "type": "table",
          "targets": [
            {
              "expr": "pulumi_kubernetes_operator_stack_reconcile_success_total",
              "legendFormat": "{{ stack }}"
            }
          ]
        },
        {
          "title": "Reconciliation Errors",
          "type": "timeseries",
          "targets": [
            {
              "expr": "rate(pulumi_kubernetes_operator_stack_reconcile_errors_total[5m])",
              "legendFormat": "{{ stack }}"
            }
          ]
        },
        {
          "title": "Reconciliation Duration",
          "type": "histogram",
          "targets": [
            {
              "expr": "histogram_quantile(0.95, rate(pulumi_kubernetes_operator_stack_reconcile_duration_seconds_bucket[10m]))",
              "legendFormat": "p95 {{ stack }}"
            }
          ]
        }
      ]
    }
```

## Workspace Images with Custom Dependencies

```dockerfile
# workspaces/Dockerfile — Custom workspace image
# Base on the official Pulumi image and add organization-specific tools

FROM pulumi/pulumi-nodejs:3.109.0

# Install AWS CLI for EKS kubeconfig generation
RUN apt-get update && apt-get install -y \
    awscli \
    jq \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install kubectl for Kubernetes resources
RUN curl -fsSL "https://dl.k8s.io/release/v1.29.3/bin/linux/amd64/kubectl" \
    -o /usr/local/bin/kubectl \
    && chmod +x /usr/local/bin/kubectl

# Install organization-internal npm packages
COPY .npmrc /root/.npmrc
RUN npm install -g \
    "@acme-corp/pulumi-components@1.5.0" \
    "typescript@5.4.3"

# Remove npmrc to prevent token exposure in image layers
RUN rm /root/.npmrc

WORKDIR /workspace
```

```yaml
# Stack using the custom workspace image
spec:
  workspaceTemplate:
    spec:
      image: "123456789012.dkr.ecr.us-east-1.amazonaws.com/pulumi-workspace:3.109.0"
      imagePullPolicy: Always
      # Pull secret for private ECR
      imagePullSecrets:
        - name: ecr-registry-credentials
```

The Pulumi Kubernetes Operator transforms Pulumi programs from pipeline-triggered scripts into continuously reconciled infrastructure declarations. Stack references enable clean dependency chains between infrastructure layers, external secrets integration keeps credentials out of the Git repository, and Prometheus metrics provide the observability needed to manage dozens of stacks across multiple environments.
