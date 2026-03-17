---
title: "Kubernetes Operator Hub and OLM: Managing Operator Lifecycle"
date: 2029-06-10T00:00:00-05:00
draft: false
tags: ["Kubernetes", "OLM", "Operators", "OperatorHub", "Operator Framework", "GitOps"]
categories: ["Kubernetes", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to the Operator Lifecycle Manager (OLM): architecture, CatalogSource, Subscription, and InstallPlan resources, operator versioning and upgrade strategies, and managing community versus certified operators in enterprise environments."
more_link: "yes"
url: "/kubernetes-operator-hub-olm-lifecycle-management/"
---

The Operator Framework and Operator Lifecycle Manager (OLM) solve the problem that Kubernetes itself does not address: how do you install, upgrade, and remove operators in a controlled, auditable way? Raw `kubectl apply` of operator manifests works for a single cluster but does not scale to dozens of clusters or handle upgrades safely. This guide covers OLM's architecture, its core resources, and the operational patterns that make operator lifecycle management reliable in enterprise environments.

<!--more-->

# Kubernetes Operator Hub and OLM: Managing Operator Lifecycle

## The Problem OLM Solves

Without OLM, operator deployment looks like:

```bash
# Manual operator installation — no dependency tracking, no upgrade coordination
kubectl apply -f https://github.com/operator-org/my-operator/releases/latest/download/manifests.yaml

# Questions you cannot easily answer:
# - Which version is installed?
# - Does this operator have dependencies on other operators?
# - How do I upgrade without downtime?
# - Is this operator compatible with this Kubernetes version?
# - Who approved this installation?
```

OLM answers all of these questions by introducing a declarative model for operator lifecycle.

## OLM Architecture Overview

OLM consists of three main components running as Kubernetes deployments:

```
┌─────────────────────────────────────────────────────┐
│ cluster-olm-operator namespace                      │
│                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────┐ │
│  │  OLM         │  │  Catalog     │  │  Package  │ │
│  │  Operator    │  │  Operator    │  │  Server   │ │
│  └──────────────┘  └──────────────┘  └───────────┘ │
│                                                     │
│  Watches: Subscription, CSV, InstallPlan            │
│           CatalogSource, OperatorGroup              │
└─────────────────────────────────────────────────────┘

User-facing resources:
  CatalogSource  → defines where to find operator packages
  Subscription   → declares which operator to install (and update channel)
  InstallPlan    → represents a pending installation or upgrade
  CSV            → ClusterServiceVersion — the operator bundle manifest
  OperatorGroup  → defines which namespaces an operator manages
```

### Installing OLM

```bash
# Install OLM using the official install script
curl -sL https://github.com/operator-framework/operator-lifecycle-manager/releases/download/v0.28.0/install.sh | bash -s v0.28.0

# Verify installation
kubectl get pods -n olm
# NAME                                READY   STATUS    RESTARTS
# catalog-operator-xxx                1/1     Running   0
# olm-operator-xxx                    1/1     Running   0
# packageserver-xxx                   1/1     Running   0
# operatorhubio-catalog-xxx           1/1     Running   0

# List available operators
kubectl get packagemanifests -n olm | head -20
```

## Core Resources

### CatalogSource

A `CatalogSource` tells OLM where to find operator packages. It points to a container image that serves an operator catalog via the gRPC `Registry API`.

```yaml
# community-operators-catalog.yaml
apiVersion: operators.coreos.com/v1alpha1
kind: CatalogSource
metadata:
  name: community-operators
  namespace: olm
spec:
  sourceType: grpc
  image: quay.io/operatorhubio/catalog:latest
  displayName: Community Operators
  publisher: OperatorHub.io
  updateStrategy:
    registryPoll:
      interval: 30m  # How often to check for catalog updates
---
# internal-catalog.yaml — enterprise internal catalog
apiVersion: operators.coreos.com/v1alpha1
kind: CatalogSource
metadata:
  name: internal-operators
  namespace: olm
  annotations:
    # Pull from internal registry
    olm.catalogImageTemplate: "registry.internal.example.com/operators/catalog:latest"
spec:
  sourceType: grpc
  image: registry.internal.example.com/operators/catalog:v1.5.0
  displayName: Internal Operators
  publisher: Platform Team
  secrets:
  - internal-registry-secret  # ImagePullSecret for private registry
  grpcPodConfig:
    securityContextConfig: restricted
    nodeSelector:
      node-role.kubernetes.io/control-plane: ""
    tolerations:
    - key: node-role.kubernetes.io/control-plane
      operator: Exists
      effect: NoSchedule
```

### Building a Custom Catalog

```bash
# Install the operator-sdk and opm tools
# https://sdk.operatorframework.io/docs/installation/

# Create a file-based catalog (modern format, replaces SQLite-based catalogs)
mkdir -p my-catalog/my-operator

# Create the package entry
cat > my-catalog/my-operator/package.yaml <<'EOF'
schema: olm.package
name: my-operator
defaultChannel: stable
EOF

# Create the channel entry
cat > my-catalog/my-operator/channel.yaml <<'EOF'
schema: olm.channel
package: my-operator
name: stable
entries:
- name: my-operator.v1.0.0
- name: my-operator.v1.1.0
  replaces: my-operator.v1.0.0
- name: my-operator.v1.2.0
  replaces: my-operator.v1.1.0
  skips:
  - my-operator.v1.0.0  # Allow skip-level upgrades from v1.0.0
EOF

# Build the catalog image
opm generate dockerfile my-catalog
docker build -f my-catalog.Dockerfile -t registry.example.com/my-catalog:v1 .
docker push registry.example.com/my-catalog:v1
```

### OperatorGroup

An `OperatorGroup` scopes which namespaces an operator can manage. It must be created before any Subscriptions in the same namespace.

```yaml
# operator-group-single.yaml — operator manages only the install namespace
apiVersion: operators.coreos.com/v1
kind: OperatorGroup
metadata:
  name: my-operators
  namespace: operators
spec:
  targetNamespaces:
  - operators  # Only manage resources in this namespace

---
# operator-group-all.yaml — operator manages all namespaces (cluster-scoped)
apiVersion: operators.coreos.com/v1
kind: OperatorGroup
metadata:
  name: global-operators
  namespace: operators
spec: {}  # Empty spec = all namespaces
# The operator's CSV must have installModes that support AllNamespaces

---
# operator-group-multi.yaml — operator manages multiple specific namespaces
apiVersion: operators.coreos.com/v1
kind: OperatorGroup
metadata:
  name: team-operators
  namespace: operators
spec:
  targetNamespaces:
  - namespace-a
  - namespace-b
  - namespace-c
```

### Subscription

A `Subscription` is the primary resource you interact with as a cluster operator. It declares which operator you want, from which catalog, on which update channel.

```yaml
# subscription-prometheus.yaml
apiVersion: operators.coreos.com/v1alpha1
kind: Subscription
metadata:
  name: prometheus-operator
  namespace: operators
spec:
  # Which catalog to install from
  source: community-operators
  sourceNamespace: olm

  # The operator package name (from the catalog)
  name: prometheus

  # The update channel (stable, alpha, etc.)
  channel: stable

  # Starting version (optional — omit to install latest)
  startingCSV: prometheusoperator.v0.65.0

  # Upgrade approval strategy
  # Manual = requires human approval for each upgrade via InstallPlan
  # Automatic = OLM upgrades automatically when a new version is available
  installPlanApproval: Manual

  # Configuration for the operator's Subscription
  config:
    resources:
      requests:
        cpu: 100m
        memory: 128Mi
      limits:
        memory: 256Mi
    env:
    - name: GOGC
      value: "30"
    nodeSelector:
      node-role.kubernetes.io/control-plane: ""
    tolerations:
    - key: node-role.kubernetes.io/control-plane
      operator: Exists
```

### InstallPlan

OLM automatically creates an `InstallPlan` when a Subscription needs to install or upgrade an operator. When `installPlanApproval: Manual`, the `InstallPlan` stays in the Pending state until you approve it.

```bash
# List pending install plans
kubectl get installplans -n operators
# NAME            CSV                         APPROVAL   APPROVED
# install-abc12   prometheusoperator.v0.65.0  Manual     false
# install-def34   prometheusoperator.v0.66.0  Manual     false

# Inspect an install plan to see what will be created
kubectl get installplan install-abc12 -n operators -o yaml

# Approve an install plan manually
kubectl patch installplan install-abc12 -n operators \
    --type merge \
    --patch '{"spec":{"approved":true}}'

# Or use a script to approve all pending plans
kubectl get installplans -n operators \
    -o jsonpath='{.items[?(@.spec.approved==false)].metadata.name}' | \
    xargs -r -I{} kubectl patch installplan {} -n operators \
        --type merge \
        --patch '{"spec":{"approved":true}}'
```

## Operator Versioning and Upgrade Channels

### Understanding Channels

Operators define update channels in their catalog. Common patterns:

```
stable    → Well-tested, production-ready releases
alpha     → Unstable, experimental features
candidate → Release candidate for next stable
fast      → Frequent releases for users who want new features sooner

# semver channels (newer convention)
v1        → All v1.x releases
v2        → All v2.x releases (potentially breaking changes from v1)
```

### The Upgrade Graph

OLM uses an upgrade graph to determine valid upgrade paths. Each CSV declares which versions it can replace:

```yaml
# In the operator bundle's CSV:
spec:
  version: 1.2.0
  replaces: my-operator.v1.1.0
  skips:
  - my-operator.v1.0.1   # Skip directly to 1.2.0 if on 1.0.1
```

```bash
# View available versions in a channel
kubectl get packagemanifest prometheus -n olm -o jsonpath=\
'{.status.channels[?(@.name=="stable")].entries[*].name}'

# View the full upgrade graph
kubectl get packagemanifest prometheus -n olm -o json | \
    jq '.status.channels[] | select(.name=="stable") | .entries'
```

### Pinning to Specific Versions

```yaml
# Pin to a specific version by setting startingCSV
# OLM will not upgrade beyond this unless you update the Subscription
apiVersion: operators.coreos.com/v1alpha1
kind: Subscription
metadata:
  name: cert-manager
  namespace: operators
spec:
  source: community-operators
  sourceNamespace: olm
  name: cert-manager
  channel: stable
  startingCSV: cert-manager.v1.14.0
  installPlanApproval: Manual
```

## Enterprise Patterns

### GitOps-Managed Operator Installation

```yaml
# argocd-app-operators.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: cluster-operators
  namespace: argocd
spec:
  project: platform
  source:
    repoURL: https://git.example.com/platform/cluster-config
    targetRevision: main
    path: operators/
  destination:
    server: https://kubernetes.default.svc
    namespace: operators
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
    - CreateNamespace=true
    - ServerSideApply=true
```

```
operators/
├── namespace.yaml
├── operator-group.yaml
├── subscriptions/
│   ├── cert-manager.yaml
│   ├── prometheus-operator.yaml
│   ├── vault-operator.yaml
│   └── postgres-operator.yaml
└── kustomization.yaml
```

### Automated Upgrade Approval with a Controller

For environments where you want automatic upgrades but need to record approvals for compliance:

```go
package main

import (
    "context"
    "fmt"
    "time"

    olmv1alpha1 "github.com/operator-framework/api/pkg/operators/v1alpha1"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/reconcile"
)

// InstallPlanApprover automatically approves InstallPlans after audit
type InstallPlanApprover struct {
    client   client.Client
    auditLog AuditLogger
}

func (a *InstallPlanApprover) Reconcile(ctx context.Context, req reconcile.Request) (reconcile.Result, error) {
    var plan olmv1alpha1.InstallPlan
    if err := a.client.Get(ctx, req.NamespacedName, &plan); err != nil {
        return reconcile.Result{}, client.IgnoreNotFound(err)
    }

    if plan.Spec.Approved || plan.Status.Phase != olmv1alpha1.InstallPlanPhaseRequiresApproval {
        return reconcile.Result{}, nil
    }

    // Audit: record what is about to be installed
    for _, step := range plan.Status.Plan {
        if err := a.auditLog.Record(ctx, AuditEntry{
            Namespace: plan.Namespace,
            CSV:       step.Resolving,
            Resource:  step.Resource.Name,
            Action:    "auto-approve",
            Timestamp: time.Now(),
        }); err != nil {
            return reconcile.Result{}, fmt.Errorf("audit log: %w", err)
        }
    }

    // Approve
    plan.Spec.Approved = true
    if err := a.client.Update(ctx, &plan); err != nil {
        return reconcile.Result{}, fmt.Errorf("approve install plan: %w", err)
    }
    return reconcile.Result{}, nil
}
```

### Restricting Operators in Enterprise Environments

```yaml
# Disable the default community OperatorHub sources
# This forces operators to come from your internal catalog only
apiVersion: config.openshift.io/v1
kind: OperatorHub
metadata:
  name: cluster
spec:
  disableAllDefaultSources: true
---
# On vanilla Kubernetes with OLM, remove default catalog
kubectl delete catalogsource operatorhubio-catalog -n olm
```

```yaml
# RBAC: restrict who can create Subscriptions
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: operator-installer
rules:
- apiGroups: ["operators.coreos.com"]
  resources: ["subscriptions", "operatorgroups"]
  verbs: ["create", "update", "patch", "delete"]
- apiGroups: ["operators.coreos.com"]
  resources: ["installplans"]
  verbs: ["get", "list", "watch", "patch"]  # patch for approval
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: platform-team-operator-installer
subjects:
- kind: Group
  name: platform-engineers
  apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: operator-installer
  apiGroup: rbac.authorization.k8s.io
```

## ClusterServiceVersion (CSV) Deep Dive

The CSV is the heart of an operator bundle. It contains everything OLM needs to install and manage the operator:

```yaml
# Abbreviated CSV structure
apiVersion: operators.coreos.com/v1alpha1
kind: ClusterServiceVersion
metadata:
  name: my-operator.v1.2.0
  namespace: operators
  annotations:
    # Capabilities: Basic Install, Seamless Upgrades, Full Lifecycle,
    #               Deep Insights, Auto Pilot
    capabilities: Seamless Upgrades
    certified: "true"
    repository: https://github.com/example/my-operator
spec:
  displayName: My Operator
  description: Manages MyApp instances in Kubernetes
  version: 1.2.0
  replaces: my-operator.v1.1.0

  # Kubernetes version compatibility
  minKubeVersion: "1.28.0"

  # Operator deployment specification
  install:
    strategy: deployment
    spec:
      deployments:
      - name: my-operator-controller
        spec:
          replicas: 1
          selector:
            matchLabels:
              app: my-operator
          template:
            spec:
              serviceAccountName: my-operator-sa
              containers:
              - name: manager
                image: registry.example.com/my-operator:v1.2.0
                args:
                - --leader-elect
                resources:
                  limits:
                    cpu: 500m
                    memory: 128Mi
                  requests:
                    cpu: 10m
                    memory: 64Mi

  # Permissions requested by the operator
  clusterPermissions:
  - serviceAccountName: my-operator-sa
    rules:
    - apiGroups: ["myapp.example.com"]
      resources: ["myapps", "myapps/status", "myapps/finalizers"]
      verbs: ["*"]
    - apiGroups: ["apps"]
      resources: ["deployments"]
      verbs: ["create", "delete", "get", "list", "patch", "update", "watch"]

  # Custom resource definitions managed by this operator
  customresourcedefinitions:
    owned:
    - name: myapps.myapp.example.com
      version: v1alpha1
      kind: MyApp
      displayName: My Application
      description: Represents a MyApp instance
    required:
    - name: certificates.cert-manager.io
      version: v1
      kind: Certificate
      displayName: Certificate
      description: cert-manager Certificate resource (dependency)

  # Supported install modes
  installModes:
  - type: OwnNamespace
    supported: true
  - type: SingleNamespace
    supported: true
  - type: MultiNamespace
    supported: false
  - type: AllNamespaces
    supported: true
```

## Monitoring OLM Health

### OLM Metrics

```bash
# OLM exposes Prometheus metrics on port 8080 of the OLM operator pod
kubectl port-forward -n olm deployment/olm-operator 8080:8080

# Key metrics:
# csv_count — total number of CSVs
# csv_succeeded_count — CSVs in Succeeded phase
# csv_abnormal_count — CSVs in failed/pending phases

# Check CSV status across all namespaces
kubectl get csv -A
# NAMESPACE   NAME                     DISPLAY              VERSION   REPLACES   PHASE
# operators   prometheusoperator.v65   Prometheus Operator  0.65.0              Succeeded
# operators   cert-manager.v1.14.0    cert-manager         1.14.0              Succeeded
```

### Alerting Rules

```yaml
groups:
- name: olm
  rules:
  - alert: OLMCSVFailed
    expr: csv_abnormal{phase=~"Failed|Unknown"} > 0
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "OLM CSV {{ $labels.name }} is in {{ $labels.phase }} phase"

  - alert: OLMSubscriptionUpgradePending
    expr: |
      subscription_sync_total{installed!="", currentCSV!=installed} > 0
    for: 1h
    labels:
      severity: info
    annotations:
      summary: "Operator upgrade pending: {{ $labels.name }}"
      description: "Installed: {{ $labels.installed }}, Available: {{ $labels.currentCSV }}"

  - alert: OLMCatalogSourceUnhealthy
    expr: |
      catalog_source_ready == 0
    for: 10m
    labels:
      severity: critical
    annotations:
      summary: "CatalogSource {{ $labels.name }} is not ready"
```

## Community vs. Certified Operators

### Understanding the Difference

| Aspect | Community Operators | Certified Operators |
|---|---|---|
| Source | OperatorHub.io community | Red Hat ISV program |
| Review | Community PR review | Red Hat certification |
| Security | Best-effort scan | CVE scanning + validated |
| Support | Community forums | ISV + Red Hat support |
| Stability | Variable | Production-ready commitment |
| License | Various open source | Varies (usually commercial) |

### Selecting an Internal Catalog Strategy

For enterprise environments, build a curated catalog from tested and approved operators:

```bash
# Initialize a file-based catalog from scratch
mkdir enterprise-catalog

# Add an approved subset of community operators
opm render quay.io/operatorhubio/catalog:latest \
    --output yaml | \
    # Filter to only approved operators
    yq 'select(.name == "prometheus" or .name == "cert-manager" or .name == "vault")' \
    > enterprise-catalog/packages.yaml

# Validate the catalog
opm validate enterprise-catalog/

# Build and push the enterprise catalog image
opm generate dockerfile enterprise-catalog/
docker build -f enterprise-catalog.Dockerfile \
    -t registry.internal.example.com/operators/catalog:$(date +%Y%m%d) \
    .
docker push registry.internal.example.com/operators/catalog:$(date +%Y%m%d)
```

### Version Pinning Policy

```yaml
# For production clusters: pin all operators to specific versions
# Use a spreadsheet or config file to track approved versions

# approved-versions.yaml (managed in git, reviewed in PRs)
operators:
  prometheus:
    channel: stable
    version: prometheusoperator.v0.67.0
    approved_by: platform-team
    approved_date: "2029-05-15"
    cve_scan_date: "2029-05-15"
    cve_scan_result: clean

  cert-manager:
    channel: stable
    version: cert-manager.v1.14.2
    approved_by: security-team
    approved_date: "2029-05-20"
```

## Operator Uninstallation

Removing an operator requires care to avoid orphaning custom resources:

```bash
# Step 1: Delete all custom resources managed by the operator
kubectl get myapps -A
kubectl delete myapps --all -A

# Step 2: Wait for finalizers to complete
kubectl wait --for=delete myapps --all -A --timeout=120s

# Step 3: Delete the Subscription (stops future upgrades)
kubectl delete subscription my-operator -n operators

# Step 4: Delete the CSV (removes the operator deployment)
kubectl delete csv my-operator.v1.2.0 -n operators

# Step 5: Optionally delete the CRDs
kubectl delete crd myapps.myapp.example.com

# Verify the operator is fully removed
kubectl get pods -n operators
kubectl get csv -n operators
```

## Multi-Cluster Operator Management

For fleets of clusters, combine OLM with a management layer:

```yaml
# ACM Policy to enforce operator installation across clusters
apiVersion: policy.open-cluster-management.io/v1
kind: Policy
metadata:
  name: policy-prometheus-operator
  namespace: policies
spec:
  remediationAction: enforce
  disabled: false
  policy-templates:
  - objectDefinition:
      apiVersion: policy.open-cluster-management.io/v1
      kind: ConfigurationPolicy
      metadata:
        name: prometheus-operator-subscription
      spec:
        remediationAction: enforce
        severity: medium
        object-templates:
        - complianceType: musthave
          objectDefinition:
            apiVersion: operators.coreos.com/v1alpha1
            kind: Subscription
            metadata:
              name: prometheus-operator
              namespace: operators
            spec:
              source: internal-operators
              sourceNamespace: olm
              name: prometheus
              channel: stable
              installPlanApproval: Automatic
```

## Summary

OLM transforms operator management from a manual `kubectl apply` workflow into a structured, auditable lifecycle. The key abstractions to internalize are:

- **CatalogSource**: where operators come from (your internal catalog in production)
- **Subscription**: what you want and at what quality bar (channel + approval policy)
- **InstallPlan**: the approval gate between wanting an operator and having it
- **CSV**: the operator bundle that contains everything needed to run and manage the operator

For enterprise clusters, the two most important policy decisions are: using `installPlanApproval: Manual` for production clusters (so upgrades require human sign-off) and building a curated internal catalog from audited, CVE-scanned operator bundles rather than pulling directly from the community catalog.
