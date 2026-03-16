---
title: "Google Config Connector: Managing GCP Resources from Kubernetes"
date: 2027-02-08T00:00:00-05:00
draft: false
tags: ["Kubernetes", "GCP", "Config Connector", "Infrastructure as Code", "GitOps"]
categories: ["Cloud Architecture", "Kubernetes", "Infrastructure as Code"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Google Config Connector (KCC) for managing GCP resources from Kubernetes, including Workload Identity setup, namespace-mode configuration, supported resources, GitOps integration, drift detection, and troubleshooting stuck reconciliation."
more_link: "yes"
url: "/google-config-connector-gcp-kubernetes-management-guide/"
---

**Google Config Connector** (KCC) is a Kubernetes add-on that allows managing GCP infrastructure — CloudSQL instances, GCS buckets, Pub/Sub topics, BigQuery datasets, VPC networks, and IAM bindings — using native Kubernetes Custom Resources. The GCP resource lifecycle is driven by Kubernetes reconciliation loops, enabling GitOps workflows, RBAC-based access control, and drift detection entirely within the Kubernetes control plane.

<!--more-->

## Architecture Overview

KCC installs two primary components into the cluster: the **Config Connector manager** (a Deployment) and a **mutating/validating webhook** that intercepts resource creation and updates. The manager runs a controller for each supported GCP resource type and uses Google Cloud APIs to reconcile the desired state expressed in Kubernetes objects against actual GCP infrastructure.

```
kubectl apply -f cloudSQLInstance.yaml
          ↓
  Kubernetes API (custom resource stored in etcd)
          ↓
  Config Connector manager (watches CRs)
          ↓
  Google Cloud API (Cloud SQL Admin API)
          ↓
  GCP Infrastructure (CloudSQL instance)
```

### Workload Identity binding

Config Connector authenticates to GCP using a Kubernetes ServiceAccount bound to a GCP ServiceAccount via **Workload Identity**. This eliminates the need to store GCP credentials as Kubernetes Secrets.

```
KCC Pod ServiceAccount (kube)
  → Workload Identity binding
  → GCP ServiceAccount (project-level)
  → IAM roles on target resources
```

## Installation with Workload Identity

### Prerequisites

- GKE cluster with Workload Identity enabled
- `gcloud` CLI authenticated with project owner or equivalent
- Config Connector operator version 1.113+

```bash
#!/bin/bash
set -euo pipefail

PROJECT_ID="my-production-project"
CLUSTER_NAME="production-gke"
CLUSTER_REGION="us-central1"
KCC_SA_NAME="config-connector"
KCC_NAMESPACE="cnrm-system"

# 1. Enable required APIs
gcloud services enable --project="${PROJECT_ID}" \
  cloudresourcemanager.googleapis.com \
  iam.googleapis.com \
  serviceusage.googleapis.com \
  sqladmin.googleapis.com \
  storage.googleapis.com \
  pubsub.googleapis.com \
  bigquery.googleapis.com

# 2. Create the GCP ServiceAccount for KCC
gcloud iam service-accounts create "${KCC_SA_NAME}" \
  --project="${PROJECT_ID}" \
  --display-name="Config Connector Manager" 2>/dev/null || true

KCC_SA_EMAIL="${KCC_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

# 3. Grant broad project-level roles (narrow per resource type in production)
for ROLE in \
  roles/editor \
  roles/iam.securityAdmin \
  roles/resourcemanager.projectIamAdmin; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${KCC_SA_EMAIL}" \
    --role="${ROLE}"
done

# 4. Bind the KCC Kubernetes ServiceAccount via Workload Identity
gcloud iam service-accounts add-iam-policy-binding "${KCC_SA_EMAIL}" \
  --project="${PROJECT_ID}" \
  --role=roles/iam.workloadIdentityUser \
  --member="serviceAccount:${PROJECT_ID}.svc.id.goog[${KCC_NAMESPACE}/cnrm-controller-manager-0]"

# 5. Install Config Connector operator
gsutil cp gs://configconnector-operator/latest/release-bundle.tar.gz /tmp/kcc-bundle.tar.gz
tar -zxvf /tmp/kcc-bundle.tar.gz -C /tmp/kcc-bundle/
kubectl apply -f /tmp/kcc-bundle/operator-system/configconnector-operator.yaml

# 6. Wait for operator to be ready
kubectl -n configconnector-operator-system \
  rollout status deployment/configconnector-operator --timeout=120s

echo "KCC operator installed. GCP SA: ${KCC_SA_EMAIL}"
```

## Namespace-Mode vs Cluster-Mode

KCC supports two operating modes that control how the controller maps Kubernetes namespaces to GCP projects.

### Cluster-mode configuration

All Config Connector resources in all namespaces are managed by a single GCP ServiceAccount, and all resources land in the project bound to the operator.

```yaml
apiVersion: core.cnrm.cloud.google.com/v1beta1
kind: ConfigConnector
metadata:
  name: configconnector.core.cnrm.cloud.google.com
spec:
  mode: cluster
  googleServiceAccount: "config-connector@my-production-project.iam.gserviceaccount.com"
```

### Namespace-mode configuration (recommended for multi-team)

Each namespace gets its own GCP project mapping, enabling multi-tenancy where team namespaces map directly to GCP projects.

```yaml
# Operator-level config: enable namespace mode
apiVersion: core.cnrm.cloud.google.com/v1beta1
kind: ConfigConnector
metadata:
  name: configconnector.core.cnrm.cloud.google.com
spec:
  mode: namespaced
---
# Per-namespace binding
apiVersion: core.cnrm.cloud.google.com/v1beta1
kind: ConfigConnectorContext
metadata:
  name: configconnectorcontext.core.cnrm.cloud.google.com
  namespace: team-alpha
spec:
  googleServiceAccount: "kcc-team-alpha@team-alpha-project.iam.gserviceaccount.com"
  requestProjectPolicy: SERVICE_ACCOUNT_PROJECT
---
apiVersion: core.cnrm.cloud.google.com/v1beta1
kind: ConfigConnectorContext
metadata:
  name: configconnectorcontext.core.cnrm.cloud.google.com
  namespace: team-beta
spec:
  googleServiceAccount: "kcc-team-beta@team-beta-project.iam.gserviceaccount.com"
  requestProjectPolicy: SERVICE_ACCOUNT_PROJECT
```

Each namespace must also be annotated with the target GCP project:

```bash
kubectl annotate namespace team-alpha \
  cnrm.cloud.google.com/project-id=team-alpha-project

kubectl annotate namespace team-beta \
  cnrm.cloud.google.com/project-id=team-beta-project
```

## Supported Resources

### CloudSQL

```yaml
apiVersion: sql.cnrm.cloud.google.com/v1beta1
kind: SQLInstance
metadata:
  name: production-postgres
  namespace: team-alpha
  annotations:
    cnrm.cloud.google.com/project-id: team-alpha-project
spec:
  databaseVersion: POSTGRES_15
  region: us-central1
  settings:
    tier: db-custom-4-16384
    diskSize: 100
    diskType: PD_SSD
    diskAutoresize: true
    diskAutoresizeLimit: 500
    backupConfiguration:
      enabled: true
      startTime: "03:00"
      pointInTimeRecoveryEnabled: true
      transactionLogRetentionDays: 7
      backupRetentionSettings:
        retainedBackups: 14
        retentionUnit: COUNT
    ipConfiguration:
      ipv4Enabled: false
      requireSsl: true
      privateNetwork:
        external: true
        name: projects/team-alpha-project/global/networks/vpc-production
    databaseFlags:
      - name: max_connections
        value: "200"
      - name: log_checkpoints
        value: "on"
      - name: log_min_duration_statement
        value: "1000"
    maintenanceWindow:
      day: 7
      hour: 3
      updateTrack: stable
    insightsConfig:
      queryInsightsEnabled: true
      queryStringLength: 1024
      recordApplicationTags: true
      recordClientAddress: true
---
# SQLDatabase within the instance
apiVersion: sql.cnrm.cloud.google.com/v1beta1
kind: SQLDatabase
metadata:
  name: app-db
  namespace: team-alpha
spec:
  instanceRef:
    name: production-postgres
  charset: UTF8
  collation: en_US.UTF8
---
# Export SQLUser password to a Kubernetes Secret
apiVersion: sql.cnrm.cloud.google.com/v1beta1
kind: SQLUser
metadata:
  name: app-user
  namespace: team-alpha
spec:
  instanceRef:
    name: production-postgres
  password:
    valueFrom:
      secretKeyRef:
        name: app-db-password
        key: password
  host: "%"
```

### GCS Bucket

```yaml
apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: team-alpha-artifacts
  namespace: team-alpha
  annotations:
    cnrm.cloud.google.com/project-id: team-alpha-project
spec:
  location: US-CENTRAL1
  storageClass: STANDARD
  uniformBucketLevelAccess: true
  versioning:
    enabled: true
  lifecycleRule:
    - action:
        type: Delete
      condition:
        age: 365
        withState: ARCHIVED
    - action:
        type: SetStorageClass
        storageClass: NEARLINE
      condition:
        age: 30
        withState: LIVE
  cors:
    - origin:
        - "https://app.example.com"
      method:
        - GET
        - HEAD
      responseHeader:
        - Content-Type
      maxAgeSeconds: 3600
  retentionPolicy:
    retentionPeriod: 86400
```

### Pub/Sub Topic and Subscription

```yaml
apiVersion: pubsub.cnrm.cloud.google.com/v1beta1
kind: PubSubTopic
metadata:
  name: order-events
  namespace: team-alpha
spec:
  messageRetentionDuration: 86400s
  messageStoragePolicy:
    allowedPersistenceRegions:
      - us-central1
      - us-east1
  schemaSettings:
    schema:
      external: "projects/team-alpha-project/schemas/order-event-schema"
    encoding: JSON
---
apiVersion: pubsub.cnrm.cloud.google.com/v1beta1
kind: PubSubSubscription
metadata:
  name: order-processor-sub
  namespace: team-alpha
spec:
  topicRef:
    name: order-events
  ackDeadlineSeconds: 60
  messageRetentionDuration: 604800s
  retainAckedMessages: false
  expirationPolicy:
    ttl: 2678400s
  retryPolicy:
    minimumBackoff: 10s
    maximumBackoff: 600s
  deadLetterPolicy:
    deadLetterTopicRef:
      name: order-events-dlq
    maxDeliveryAttempts: 5
  filter: 'attributes.eventType = "ORDER_CREATED"'
```

### BigQuery Dataset and Table

```yaml
apiVersion: bigquery.cnrm.cloud.google.com/v1beta1
kind: BigQueryDataset
metadata:
  name: analytics-warehouse
  namespace: team-alpha
spec:
  location: US
  defaultTableExpirationMs: 0
  access:
    - role: OWNER
      specialGroup: projectOwners
    - role: READER
      specialGroup: projectReaders
    - role: WRITER
      iamMember: "serviceAccount:pipeline-sa@team-alpha-project.iam.gserviceaccount.com"
---
apiVersion: bigquery.cnrm.cloud.google.com/v1beta1
kind: BigQueryTable
metadata:
  name: events-raw
  namespace: team-alpha
spec:
  datasetRef:
    name: analytics-warehouse
  description: "Raw event stream from Pub/Sub"
  schema: |
    [
      {"name": "event_id",   "type": "STRING",    "mode": "REQUIRED"},
      {"name": "event_type", "type": "STRING",    "mode": "REQUIRED"},
      {"name": "payload",    "type": "JSON",      "mode": "NULLABLE"},
      {"name": "created_at", "type": "TIMESTAMP", "mode": "REQUIRED"}
    ]
  timePartitioning:
    type: DAY
    field: created_at
    expirationMs: 7776000000
  clustering:
    fields:
      - event_type
```

### VPC Network and Subnet

```yaml
apiVersion: compute.cnrm.cloud.google.com/v1beta1
kind: ComputeNetwork
metadata:
  name: vpc-production
  namespace: team-alpha
spec:
  description: "Production VPC for team-alpha"
  autoCreateSubnetworks: false
  routingConfig:
    routingMode: REGIONAL
---
apiVersion: compute.cnrm.cloud.google.com/v1beta1
kind: ComputeSubnetwork
metadata:
  name: subnet-app-us-central1
  namespace: team-alpha
spec:
  networkRef:
    name: vpc-production
  region: us-central1
  ipCidrRange: "10.10.0.0/24"
  privateIpGoogleAccess: true
  secondaryIpRange:
    - rangeName: pods
      ipCidrRange: "10.20.0.0/16"
    - rangeName: services
      ipCidrRange: "10.30.0.0/20"
  logConfig:
    enable: true
    aggregationInterval: INTERVAL_5_SEC
    flowSampling: 0.5
    metadata: INCLUDE_ALL_METADATA
```

### IAM Bindings

```yaml
# Grant a KSA Workload Identity access to a specific resource
apiVersion: iam.cnrm.cloud.google.com/v1beta1
kind: IAMServiceAccount
metadata:
  name: app-sa
  namespace: team-alpha
spec:
  displayName: "Application Service Account"
---
apiVersion: iam.cnrm.cloud.google.com/v1beta1
kind: IAMPolicyMember
metadata:
  name: app-sa-storage-viewer
  namespace: team-alpha
spec:
  resourceRef:
    apiVersion: storage.cnrm.cloud.google.com/v1beta1
    kind: StorageBucket
    name: team-alpha-artifacts
  role: roles/storage.objectViewer
  member: "serviceAccount:app-sa@team-alpha-project.iam.gserviceaccount.com"
---
# Workload Identity binding for a Kubernetes workload
apiVersion: iam.cnrm.cloud.google.com/v1beta1
kind: IAMPolicyMember
metadata:
  name: app-sa-workload-identity
  namespace: team-alpha
spec:
  resourceRef:
    apiVersion: iam.cnrm.cloud.google.com/v1beta1
    kind: IAMServiceAccount
    name: app-sa
  role: roles/iam.workloadIdentityUser
  member: "serviceAccount:team-alpha-project.svc.id.goog[team-alpha/app-serviceaccount]"
```

## Resource Reference Resolution

KCC resources can reference each other by name within the same namespace. Cross-namespace or cross-project references use the `external` field with the full GCP resource path.

```yaml
apiVersion: sql.cnrm.cloud.google.com/v1beta1
kind: SQLInstance
metadata:
  name: replica-postgres
  namespace: team-alpha
spec:
  databaseVersion: POSTGRES_15
  region: us-east1
  # Reference the master instance by KCC resource name (same namespace)
  masterInstanceRef:
    name: production-postgres
  settings:
    tier: db-custom-2-8192
---
# Cross-project reference using external path
apiVersion: compute.cnrm.cloud.google.com/v1beta1
kind: ComputeSubnetwork
metadata:
  name: shared-subnet
  namespace: team-alpha
spec:
  # Reference a VPC in a different (shared VPC host) project
  networkRef:
    external: "projects/shared-vpc-host-project/global/networks/vpc-shared"
  region: us-central1
  ipCidrRange: "10.50.0.0/24"
```

## Acquiring Unmanaged Resources

Existing GCP resources can be imported into KCC management by applying a resource manifest that matches the existing resource's name and project. KCC detects the existing resource and begins managing it without recreation.

```yaml
# Acquire an existing CloudSQL instance
# The instance already exists in GCP; apply this to bring it under KCC management
apiVersion: sql.cnrm.cloud.google.com/v1beta1
kind: SQLInstance
metadata:
  name: legacy-postgres
  namespace: team-alpha
  annotations:
    cnrm.cloud.google.com/project-id: team-alpha-project
    # Tells KCC to adopt the existing resource rather than fail if it already exists
    cnrm.cloud.google.com/state-into-spec: merge
spec:
  databaseVersion: POSTGRES_14
  region: us-central1
  settings:
    tier: db-custom-4-16384
```

After applying, check the `status.conditions` to confirm acquisition succeeded:

```bash
kubectl -n team-alpha get sqlinstance legacy-postgres \
  -o jsonpath='{.status.conditions}' | jq .
```

## Deletion Policy

By default, deleting a KCC resource also deletes the GCP resource. The `deletion-policy: abandon` annotation changes this to leave the GCP resource in place when the Kubernetes object is deleted.

```yaml
apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: critical-data-bucket
  namespace: team-alpha
  annotations:
    # GCS bucket persists after kubectl delete
    cnrm.cloud.google.com/deletion-policy: abandon
spec:
  location: US-CENTRAL1
  storageClass: STANDARD
  uniformBucketLevelAccess: true
```

## GitOps Workflow with ArgoCD

### Repository structure

```
infrastructure/
├── base/
│   ├── kustomization.yaml
│   ├── namespace-bindings/
│   │   ├── team-alpha-context.yaml
│   │   └── team-beta-context.yaml
│   └── shared/
│       ├── vpc.yaml
│       └── kustomization.yaml
├── overlays/
│   ├── staging/
│   │   ├── kustomization.yaml
│   │   └── patches/
│   │       └── cloudsql-tier-patch.yaml
│   └── production/
│       ├── kustomization.yaml
│       └── patches/
│           └── cloudsql-tier-patch.yaml
└── apps/
    └── team-alpha/
        ├── kustomization.yaml
        ├── cloudsql.yaml
        ├── gcs-buckets.yaml
        ├── pubsub.yaml
        └── iam.yaml
```

### ArgoCD Application for infrastructure

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: gcp-infrastructure-team-alpha
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "0"
spec:
  project: infrastructure
  source:
    repoURL: https://github.com/company/infrastructure-config
    targetRevision: main
    path: infrastructure/apps/team-alpha
    kustomize:
      images: []
  destination:
    server: https://kubernetes.default.svc
    namespace: team-alpha
  syncPolicy:
    automated:
      prune: false        # Never auto-delete GCP resources
      selfHeal: true      # Revert manual GCP changes via drift detection
    syncOptions:
      - CreateNamespace=true
      - RespectIgnoreDifferences=true
    retry:
      limit: 5
      backoff:
        duration: 30s
        factor: 2
        maxDuration: 10m
  ignoreDifferences:
    # KCC writes observed state back to spec; ignore these fields
    - group: sql.cnrm.cloud.google.com
      kind: SQLInstance
      jsonPointers:
        - /spec/settings/ipConfiguration/allocatedIpRange
        - /spec/settings/storageSize
```

### Kustomize overlay for environment differences

```yaml
# infrastructure/overlays/production/patches/cloudsql-tier-patch.yaml
apiVersion: sql.cnrm.cloud.google.com/v1beta1
kind: SQLInstance
metadata:
  name: production-postgres
  namespace: team-alpha
spec:
  settings:
    tier: db-custom-8-32768
    diskSize: 500
    backupConfiguration:
      enabled: true
      pointInTimeRecoveryEnabled: true
      transactionLogRetentionDays: 14
```

## Drift Detection

KCC reconciles every resource on a configurable interval (default 10 minutes). When someone modifies a GCP resource directly (via console or `gcloud`), KCC detects the drift and reverts it on the next reconciliation cycle unless `selfHeal: true` is disabled in the ArgoCD policy or the resource has a `cnrm.cloud.google.com/reconcile-interval-in-seconds: "0"` annotation to pause reconciliation.

```bash
# Trigger immediate reconciliation after a manual GCP change
kubectl -n team-alpha annotate sqlinstance production-postgres \
  cnrm.cloud.google.com/force-reconcile="$(date +%s)" \
  --overwrite

# Watch the reconciliation status
kubectl -n team-alpha get sqlinstance production-postgres \
  --watch -o custom-columns=\
NAME:.metadata.name,\
READY:.status.conditions[0].status,\
REASON:.status.conditions[0].reason,\
MESSAGE:.status.conditions[0].message
```

## Resource Status Monitoring

```bash
#!/bin/bash
# Check health of all KCC resources in a namespace
NAMESPACE=${1:-team-alpha}

echo "=== KCC Resource Health: ${NAMESPACE} ==="

for KIND in \
  sqlinstances \
  storagebuckets \
  pubsubtopics \
  pubsubsubscriptions \
  bigquerydatasets \
  computenetworks \
  iampolicymembers; do
  COUNT=$(kubectl -n "${NAMESPACE}" get "${KIND}" --no-headers 2>/dev/null | wc -l)
  if [[ "${COUNT}" -gt 0 ]]; then
    UNHEALTHY=$(kubectl -n "${NAMESPACE}" get "${KIND}" \
      -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.status.conditions[?(@.type=="Ready")].status}{"\n"}{end}' \
      2>/dev/null | grep -v "True" | wc -l)
    echo "${KIND}: ${COUNT} total, ${UNHEALTHY} not ready"
  fi
done

echo ""
echo "=== Recent Events ==="
kubectl -n "${NAMESPACE}" get events \
  --sort-by=.lastTimestamp \
  --field-selector reason=UpdateFailed \
  | tail -20
```

## Comparison with Crossplane and Terraform

| Aspect | Config Connector | Crossplane | Terraform |
|---|---|---|---|
| Primary language | Kubernetes YAML | Kubernetes YAML (Compositions) | HCL |
| State storage | etcd (Kubernetes) | etcd (Kubernetes) | S3/GCS/local |
| Drift detection | Automatic (controller) | Automatic (controller) | Manual (`terraform plan`) |
| Multi-cloud | GCP only | Multi-cloud via providers | Multi-cloud |
| GitOps native | Yes (ArgoCD/Flux) | Yes (ArgoCD/Flux) | Requires CI/CD pipeline |
| GCP feature coverage | Deep (official Google) | Growing (community) | Full (official provider) |
| Resource composition | Kustomize overlays | XRDs and Compositions | Modules |
| Kubernetes RBAC | Native | Native | Out-of-band |

Config Connector is the right choice when the team is already Kubernetes-native, the infrastructure is GCP-only, and GitOps workflows using ArgoCD or Flux are in place. Crossplane is preferred for multi-cloud environments. Terraform remains viable when central platform teams manage infrastructure separately from application teams.

## Upgrade Procedures

```bash
#!/bin/bash
# Upgrade Config Connector operator to a new version
NEW_VERSION="1.118.0"

# 1. Download new release bundle
gsutil cp "gs://configconnector-operator/${NEW_VERSION}/release-bundle.tar.gz" \
  /tmp/kcc-bundle-${NEW_VERSION}.tar.gz
mkdir -p "/tmp/kcc-bundle-${NEW_VERSION}"
tar -zxvf "/tmp/kcc-bundle-${NEW_VERSION}.tar.gz" \
  -C "/tmp/kcc-bundle-${NEW_VERSION}/"

# 2. Review the CRD changes
diff <(kubectl get crd -l cnrm.cloud.google.com/managed-by-kcc=true \
        -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}') \
     <(find "/tmp/kcc-bundle-${NEW_VERSION}/crds" -name "*.yaml" \
        -exec grep -h "^  name:" {} \; | sed 's/  name: //')

# 3. Apply the new CRDs first
kubectl apply -f "/tmp/kcc-bundle-${NEW_VERSION}/crds/"

# 4. Apply the new operator
kubectl apply -f "/tmp/kcc-bundle-${NEW_VERSION}/operator-system/configconnector-operator.yaml"

# 5. Monitor the rollout
kubectl -n cnrm-system rollout status statefulset/cnrm-controller-manager --timeout=300s
kubectl -n cnrm-system get pods

# 6. Verify no resources went into error state post-upgrade
kubectl get sqlinstances,storagebuckets,pubsubtopics --all-namespaces \
  -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}: {.status.conditions[?(@.type=="Ready")].reason}{"\n"}{end}'
```

## Troubleshooting Stuck Reconciliation

```bash
# 1. Check controller-manager logs for the specific resource
kubectl -n cnrm-system logs statefulset/cnrm-controller-manager \
  --container cnrm-controller-manager \
  | grep "production-postgres" | tail -30

# 2. Describe the resource to see status conditions
kubectl -n team-alpha describe sqlinstance production-postgres

# 3. Common condition types and their meaning
# - Ready=False, reason=UpdateFailed: GCP API returned an error
# - Ready=False, reason=DependencyNotReady: a referenced resource is not ready
# - Ready=False, reason=ManagementConflict: another controller owns this resource
# - Ready=False, reason=Unauthorized: KCC SA lacks required IAM permissions

# 4. Check if the GCP SA has the required permissions
gcloud projects get-iam-policy team-alpha-project \
  --flatten="bindings[].members" \
  --format="table(bindings.role)" \
  --filter="bindings.members:kcc-team-alpha@team-alpha-project.iam.gserviceaccount.com"

# 5. Verify Workload Identity binding
gcloud iam service-accounts get-iam-policy \
  kcc-team-alpha@team-alpha-project.iam.gserviceaccount.com \
  --format=json | jq '.bindings[] | select(.role=="roles/iam.workloadIdentityUser")'

# 6. Force a reconciliation retry by removing the error annotation
kubectl -n team-alpha annotate sqlinstance production-postgres \
  cnrm.cloud.google.com/reconcile-interval-in-seconds- \
  --overwrite

# 7. If the resource is in a terminal error state, check the GCP operation
gcloud sql operations list \
  --instance=production-postgres \
  --project=team-alpha-project \
  | head -10

# 8. Reset the resource status to trigger a fresh reconciliation
kubectl -n team-alpha patch sqlinstance production-postgres \
  --type merge \
  --patch '{"metadata":{"annotations":{"cnrm.cloud.google.com/force-reconcile":"1"}}}'
```

### Management conflict resolution

When a resource shows `ManagementConflict`, another KCC installation or a previous controller version owns the resource. Resolve this by transferring ownership:

```bash
# Remove the ownership annotation from the GCP resource
# This is done by patching the KCC object and allowing the controller to re-acquire
kubectl -n team-alpha annotate sqlinstance production-postgres \
  "cnrm.cloud.google.com/force-controller-name-annotation-update=true" \
  --overwrite
```

## Multi-Project Support

In namespace-mode, each namespace can target a different GCP project. This allows a single KCC installation to manage infrastructure across multiple projects, with RBAC controlling which teams can create resources in which namespaces.

```bash
#!/bin/bash
# Provision per-team GCP service accounts and Workload Identity bindings
CLUSTER_PROJECT="platform-gke-project"
CLUSTER_NAME="platform-cluster"
CLUSTER_REGION="us-central1"

OIDC_POOL="${CLUSTER_PROJECT}.svc.id.goog"

declare -A TEAM_PROJECTS=(
  [team-alpha]="team-alpha-project"
  [team-beta]="team-beta-project"
  [team-gamma]="team-gamma-project"
)

for NAMESPACE in "${!TEAM_PROJECTS[@]}"; do
  PROJECT="${TEAM_PROJECTS[$NAMESPACE]}"
  SA_NAME="kcc-${NAMESPACE}"
  SA_EMAIL="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"

  echo "Configuring KCC for namespace=${NAMESPACE} project=${PROJECT}"

  # Create GCP SA in the team project
  gcloud iam service-accounts create "${SA_NAME}" \
    --project="${PROJECT}" \
    --display-name="KCC for ${NAMESPACE}" 2>/dev/null || true

  # Grant editor + iam admin roles
  for ROLE in roles/editor roles/iam.securityAdmin roles/resourcemanager.projectIamAdmin; do
    gcloud projects add-iam-policy-binding "${PROJECT}" \
      --member="serviceAccount:${SA_EMAIL}" \
      --role="${ROLE}" \
      --condition=None
  done

  # Workload Identity binding for the namespace-specific controller
  gcloud iam service-accounts add-iam-policy-binding "${SA_EMAIL}" \
    --project="${PROJECT}" \
    --role=roles/iam.workloadIdentityUser \
    --member="serviceAccount:${OIDC_POOL}[cnrm-system/cnrm-controller-manager-${NAMESPACE}]"

  # Apply namespace annotation and ConfigConnectorContext
  kubectl annotate namespace "${NAMESPACE}" \
    "cnrm.cloud.google.com/project-id=${PROJECT}" \
    --overwrite

  kubectl apply -f - <<EOF
apiVersion: core.cnrm.cloud.google.com/v1beta1
kind: ConfigConnectorContext
metadata:
  name: configconnectorcontext.core.cnrm.cloud.google.com
  namespace: ${NAMESPACE}
spec:
  googleServiceAccount: "${SA_EMAIL}"
  requestProjectPolicy: SERVICE_ACCOUNT_PROJECT
EOF

  echo "  Done: ${NAMESPACE} -> ${PROJECT}"
done
```

## Pausing Reconciliation

When performing planned maintenance on a GCP resource, pause KCC reconciliation to prevent the controller from reverting manual changes:

```yaml
# Pause reconciliation on a single resource
apiVersion: sql.cnrm.cloud.google.com/v1beta1
kind: SQLInstance
metadata:
  name: production-postgres
  namespace: team-alpha
  annotations:
    # Set to "0" to pause reconciliation entirely
    cnrm.cloud.google.com/reconcile-interval-in-seconds: "0"
spec:
  # ... rest of spec unchanged
```

```bash
# Pause all KCC resources in a namespace during maintenance
kubectl -n team-alpha get sqlinstances,storagebuckets -o name \
  | xargs -I{} kubectl -n team-alpha annotate {} \
    "cnrm.cloud.google.com/reconcile-interval-in-seconds=0" \
    --overwrite

# Resume after maintenance
kubectl -n team-alpha get sqlinstances,storagebuckets -o name \
  | xargs -I{} kubectl -n team-alpha annotate {} \
    "cnrm.cloud.google.com/reconcile-interval-in-seconds-" \
    --overwrite
```

Config Connector bridges the gap between Kubernetes-native workflows and GCP infrastructure management. By expressing infrastructure as Custom Resources in the same clusters that run application workloads, teams gain a unified control plane, consistent RBAC, and automatic drift correction — all observable through standard Kubernetes tooling.
