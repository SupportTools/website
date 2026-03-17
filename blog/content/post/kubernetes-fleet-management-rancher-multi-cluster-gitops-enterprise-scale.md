---
title: "Kubernetes Fleet Management with Rancher: Multi-Cluster GitOps at Enterprise Scale"
date: 2031-02-08T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Rancher", "Fleet", "GitOps", "Multi-Cluster", "Enterprise", "Helm", "ArgoCD"]
categories:
- Kubernetes
- GitOps
- Enterprise
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to Rancher Fleet for multi-cluster GitOps: Fleet architecture, Bundle and BundleDeployment resources, cluster selectors and targets, Helm chart deployment, rollout strategies, and troubleshooting Fleet sync failures."
more_link: "yes"
url: "/kubernetes-fleet-management-rancher-multi-cluster-gitops-enterprise-scale/"
---

Managing dozens or hundreds of Kubernetes clusters from a single control plane is one of the defining challenges of enterprise platform engineering. Rancher Fleet solves this by providing a GitOps engine that continuously reconciles a Git repository against a fleet of registered clusters, applying the right configurations to the right clusters based on label selectors. This guide covers the Fleet architecture from fundamentals through production-grade rollout strategies and incident troubleshooting.

<!--more-->

# Kubernetes Fleet Management with Rancher: Multi-Cluster GitOps at Enterprise Scale

## Section 1: Fleet Architecture Overview

Fleet consists of two components:

1. **Fleet Manager** — runs in the Rancher management cluster; watches Git repositories and creates Bundle resources
2. **Fleet Agent** — runs in each managed cluster; watches for BundleDeployment resources and reconciles them locally

```
Git Repository
    │
    │ (GitRepo CR polling every 15s)
    ▼
Fleet Manager (Rancher Cluster)
    │
    │ Creates Bundle resources
    ▼
┌─────────────────────────────────────────────────┐
│              Fleet Workspace                    │
│                                                 │
│  Bundle: my-app                                 │
│  ├── BundleDeployment: my-app-cluster-prod-1    │
│  ├── BundleDeployment: my-app-cluster-prod-2    │
│  ├── BundleDeployment: my-app-cluster-staging   │
│  └── BundleDeployment: my-app-cluster-dev       │
└─────────────────────────────────────────────────┘
    │                    │
    ▼                    ▼
Fleet Agent          Fleet Agent
(prod-cluster-1)    (staging-cluster)
    │                    │
    ▼                    ▼
Deploys manifests    Deploys manifests
```

### Fleet Components in the Management Cluster

```bash
# Verify Fleet components
kubectl get pods -n cattle-fleet-system
# NAME                                   READY   STATUS
# fleet-controller-xxx                   1/1     Running
# gitjob-xxx                             1/1     Running

kubectl get pods -n cattle-fleet-local-system
# NAME               READY   STATUS
# fleet-agent-xxx    1/1     Running

# Check registered clusters
kubectl get clusters -n fleet-default
kubectl get clusters -n fleet-local

# Check Fleet workspaces
kubectl get clustergroups -A
```

## Section 2: Registering Clusters with Fleet

### Cluster Registration Tokens

```bash
# Create a cluster registration token
cat <<EOF | kubectl apply -f -
apiVersion: "fleet.cattle.io/v1alpha1"
kind: ClusterRegistrationToken
metadata:
  name: production-token
  namespace: fleet-default
spec:
  ttl: 240h   # Token valid for 10 days
EOF

# Get the registration token value
kubectl get clusterregistrationtoken production-token \
  -n fleet-default \
  -o jsonpath='{.status.secretName}'

kubectl get secret $(kubectl get clusterregistrationtoken production-token \
  -n fleet-default \
  -o jsonpath='{.status.secretName}') \
  -n fleet-default \
  -o jsonpath='{.data.values}' | base64 -d
```

### Registering a New Cluster

```bash
# On the cluster to be registered:
# 1. Create the fleet-system namespace
kubectl create namespace cattle-fleet-system

# 2. Apply the registration values (from the token above)
kubectl apply -f - <<EOF
apiVersion: v1
kind: Secret
metadata:
  name: fleet-agent-bootstrap
  namespace: cattle-fleet-system
type: Opaque
data:
  values: <base64-values-from-token>
EOF

# 3. Deploy the Fleet agent
helm install fleet-agent fleet/fleet-agent \
  --namespace cattle-fleet-system \
  --create-namespace \
  --version 0.10.3 \
  --values values.yaml
```

### Labeling Clusters for Targeting

Labels on Cluster objects drive what Bundles are deployed where:

```bash
# Label clusters with environment, region, and tier
kubectl label cluster prod-us-east-1 \
  -n fleet-default \
  env=production \
  region=us-east-1 \
  tier=critical \
  cloud=aws

kubectl label cluster prod-eu-west-1 \
  -n fleet-default \
  env=production \
  region=eu-west-1 \
  tier=critical \
  cloud=aws

kubectl label cluster staging \
  -n fleet-default \
  env=staging \
  region=us-east-1 \
  tier=non-critical

kubectl label cluster dev \
  -n fleet-default \
  env=development \
  tier=non-critical
```

### ClusterGroups for Logical Groupings

```yaml
# clustergroup-production.yaml
apiVersion: fleet.cattle.io/v1alpha1
kind: ClusterGroup
metadata:
  name: production
  namespace: fleet-default
spec:
  selector:
    matchLabels:
      env: production
---
apiVersion: fleet.cattle.io/v1alpha1
kind: ClusterGroup
metadata:
  name: us-east-production
  namespace: fleet-default
spec:
  selector:
    matchExpressions:
      - key: env
        operator: In
        values: [production]
      - key: region
        operator: In
        values: [us-east-1, us-east-2]
```

## Section 3: GitRepo Resources

GitRepo defines which Git repository to watch and how to deploy its contents:

```yaml
# gitrepo-platform-config.yaml
apiVersion: fleet.cattle.io/v1alpha1
kind: GitRepo
metadata:
  name: platform-config
  namespace: fleet-default
spec:
  # Repository URL (HTTPS or SSH)
  repo: https://github.com/company/platform-config

  # Branch to track
  branch: main

  # Optional: specific revision/tag
  # revision: v2.1.0

  # Repository credentials
  clientSecretName: github-credentials

  # Paths within the repo to process
  paths:
    - /infrastructure/base
    - /infrastructure/fleet-bundles

  # Polling interval (default: 15 seconds)
  pollingInterval: 30s

  # Target clusters — all production clusters
  targets:
    - name: production
      clusterSelector:
        matchLabels:
          env: production

    - name: staging
      clusterSelector:
        matchLabels:
          env: staging

    - name: development
      clusterSelector:
        matchLabels:
          env: development

  # Rollout strategy
  rolloutStrategy:
    maxUnavailable: 10%
    maxUnavailablePartitions: 1
    autoPartitionSize: 25%

  # Correct drift (re-apply if resources are manually changed)
  correctDrift:
    enabled: true
    force: false      # Use server-side apply, not replace
    keepFailHistory: true
```

### Git Repository Credentials

```bash
# SSH key authentication
kubectl create secret generic github-credentials \
  --from-file=ssh-privatekey=/path/to/id_rsa \
  --from-literal=known_hosts="github.com ecdsa-sha2-nistp256 AAAA..." \
  -n fleet-default

# HTTPS token authentication
kubectl create secret generic github-credentials \
  --from-literal=username=git \
  --from-literal=password=<github-personal-access-token> \
  -n fleet-default
```

## Section 4: Bundle Structure and Configuration

Fleet Bundles can deploy Kubernetes manifests, Helm charts, Kustomize overlays, or combinations thereof. The repository structure drives the Bundle type:

### Repository Structure Examples

```
platform-config/
├── infrastructure/
│   └── fleet-bundles/
│       ├── monitoring/
│       │   ├── fleet.yaml          # Fleet configuration
│       │   ├── Chart.yaml          # Helm chart reference
│       │   └── values.yaml         # Base values
│       ├── cert-manager/
│       │   ├── fleet.yaml
│       │   └── kustomization.yaml  # Kustomize configuration
│       └── namespaces/
│           ├── fleet.yaml
│           ├── base/               # Base kustomize
│           └── overlays/           # Per-environment overlays
```

### fleet.yaml — The Bundle Configuration File

```yaml
# infrastructure/fleet-bundles/monitoring/fleet.yaml
namespace: monitoring

helm:
  repo: https://prometheus-community.github.io/helm-charts
  chart: kube-prometheus-stack
  version: "67.3.0"
  releaseName: prometheus-stack

  # Base values applied to all clusters
  values:
    grafana:
      enabled: true
      replicas: 1
      persistence:
        enabled: true
        size: 10Gi
    alertmanager:
      enabled: true
    prometheus:
      prometheusSpec:
        retention: 15d
        retentionSize: "40GB"
        resources:
          requests:
            cpu: 500m
            memory: 2Gi
          limits:
            cpu: 2000m
            memory: 8Gi

  # Values files to overlay (must exist in the same repo directory)
  valuesFiles:
    - values.yaml

# Per-cluster-group value overrides
targetCustomizations:
  - name: production
    clusterSelector:
      matchLabels:
        env: production

    helm:
      values:
        grafana:
          replicas: 2
          persistence:
            size: 50Gi
        prometheus:
          prometheusSpec:
            retention: 30d
            retentionSize: "150GB"
            replicas: 2
            resources:
              requests:
                cpu: 2000m
                memory: 8Gi
              limits:
                cpu: 4000m
                memory: 16Gi
        alertmanager:
          alertmanagerSpec:
            replicas: 3

  - name: staging
    clusterSelector:
      matchLabels:
        env: staging

    helm:
      values:
        grafana:
          replicas: 1
          persistence:
            size: 20Gi
        prometheus:
          prometheusSpec:
            retention: 7d

  - name: development
    clusterSelector:
      matchLabels:
        env: development

    helm:
      values:
        grafana:
          enabled: false    # No Grafana in dev
        alertmanager:
          enabled: false    # No alerting in dev
        prometheus:
          prometheusSpec:
            retention: 2d
            resources:
              requests:
                cpu: 100m
                memory: 256Mi
              limits:
                cpu: 500m
                memory: 1Gi
```

### Kustomize Bundle

```yaml
# infrastructure/fleet-bundles/namespaces/fleet.yaml
# Deploys Kustomize-managed namespace configurations

kustomize:
  # Use a specific overlay based on the cluster's environment label
  dir: overlays/{{cluster.labels.env}}

# Dynamic path based on cluster labels
targetCustomizations:
  - name: all-clusters
    clusterSelector:
      matchExpressions:
        - key: env
          operator: Exists
    kustomize:
      dir: overlays/{{cluster.labels.env}}
```

```yaml
# infrastructure/fleet-bundles/namespaces/base/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
  - namespaces.yaml
  - resourcequotas.yaml
  - limitranges.yaml
  - networkpolicies.yaml
```

```yaml
# infrastructure/fleet-bundles/namespaces/overlays/production/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

bases:
  - ../../base

patches:
  - patch: |-
      - op: replace
        path: /spec/hard/requests.memory
        value: "50Gi"
    target:
      kind: ResourceQuota
      name: default-quota
```

### Multi-Manifest Bundle

```yaml
# infrastructure/fleet-bundles/cert-manager/fleet.yaml
# Deploys multiple resources with dependencies

namespace: cert-manager

# Install cert-manager CRDs first
helm:
  repo: https://charts.jetstack.io
  chart: cert-manager
  version: "v1.17.0"
  releaseName: cert-manager
  values:
    installCRDs: true
    replicaCount: 2
    resources:
      requests:
        cpu: 100m
        memory: 128Mi
      limits:
        cpu: 500m
        memory: 512Mi

# Additional resources applied after the Helm chart
# (place these in a subdirectory that fleet.yaml references)
diff:
  comparePatches:
    - apiVersion: cert-manager.io/v1
      kind: ClusterIssuer
      name: letsencrypt-prod
      namespace: cert-manager
      jsonPointers:
        - /status
```

## Section 5: Cluster Selectors and Targets

Fleet's targeting system allows precise control over which clusters receive which configurations.

### Target Expressions

```yaml
# Complex selector: production clusters in critical tier, not in maintenance
targets:
  - name: production-active
    clusterSelector:
      matchLabels:
        env: production
        tier: critical
      matchExpressions:
        - key: maintenance-mode
          operator: DoesNotExist
        - key: region
          operator: In
          values: [us-east-1, eu-west-1, ap-southeast-1]

  - name: production-all
    clusterSelector:
      matchLabels:
        env: production

  # Default target: if no other target matches
  - name: default
    clusterSelector: {}    # Empty selector matches all clusters
```

### Per-Cluster Customizations via Annotations

```bash
# Annotate a cluster with specific overrides
kubectl annotate cluster prod-us-east-1 \
  -n fleet-default \
  "fleet.cattle.io/override-values=region=us-east-1,replicas=3"
```

```yaml
# fleet.yaml with cluster-annotation-based customization
targetCustomizations:
  - name: prod-high-replica
    clusterSelector:
      matchLabels:
        env: production
    helm:
      values:
        replicaCount: "{{cluster.annotations[\"desired-replicas\"] | default \"2\"}}"
```

## Section 6: Rollout Strategies

Fleet supports progressive rollout across clusters to limit blast radius:

```yaml
# gitrepo with phased rollout
apiVersion: fleet.cattle.io/v1alpha1
kind: GitRepo
metadata:
  name: application-rollout
  namespace: fleet-default
spec:
  repo: https://github.com/company/applications
  branch: main
  paths:
    - /apps/myapp

  targets:
    - name: canary
      clusterSelector:
        matchLabels:
          rollout-group: canary
          env: production

    - name: production
      clusterSelector:
        matchLabels:
          env: production

  rolloutStrategy:
    # Deploy to a maximum of 1 partition at a time
    maxUnavailablePartitions: 1

    # Auto-partition: each partition covers ~25% of clusters
    autoPartitionSize: 25%

    # Or define explicit partitions:
    partitions:
      - name: canary
        clusterSelector:
          matchLabels:
            rollout-group: canary
        maxUnavailable: 1

      - name: us-east
        clusterSelector:
          matchLabels:
            region: us-east-1
        maxUnavailable: 10%
        clusterGroup: us-east-production
        clusterGroupSelector:
          matchLabels:
            region: us-east-1

      - name: eu-west
        clusterSelector:
          matchLabels:
            region: eu-west-1
        maxUnavailable: 10%

      - name: ap-southeast
        clusterSelector:
          matchLabels:
            region: ap-southeast-1
        maxUnavailable: 10%
```

### Label Canary Clusters

```bash
# Designate specific clusters as canary recipients
kubectl label cluster prod-us-east-1a \
  -n fleet-default \
  rollout-group=canary

# Monitor canary deployment before proceeding
kubectl get bundledeployments -n fleet-default \
  -l fleet.cattle.io/cluster=prod-us-east-1a

# After canary validation, trigger the next partition
# (Fleet proceeds automatically if maxUnavailable conditions are met)
```

## Section 7: Fleet Bundle and BundleDeployment Resources

Understanding the internal Fleet resources helps with debugging:

### Bundle Resource Structure

```bash
# A Bundle is created for each path in a GitRepo
kubectl get bundles -n fleet-default

# Describe a bundle to see its targets and status
kubectl describe bundle fleet-default-platform-config-monitoring \
  -n fleet-default

# Key fields in a Bundle:
# spec.resources: the rendered Kubernetes resources
# spec.targets: the target cluster selectors
# status.summary: deployment status across all matched clusters
#   ready: N      - clusters where this is in desired state
#   notReady: N   - clusters still reconciling
#   waitApplied: N - clusters waiting to apply
#   errApplied: N  - clusters with errors
```

### BundleDeployment — Per-Cluster Reconciliation

```bash
# BundleDeployments are in the management cluster, one per bundle+cluster pair
kubectl get bundledeployments -n fleet-default

# Filter by cluster
kubectl get bundledeployments -n fleet-default \
  -l fleet.cattle.io/cluster=prod-us-east-1

# Get detailed status of a specific deployment
kubectl describe bundledeployment \
  fleet-default-platform-config-monitoring-prod-us-east-1 \
  -n fleet-default

# Key status fields:
# status.display.state: Ready | Modified | NotReady | ...
# status.conditions: details on any issues
# status.appliedDeploymentID: which version is currently applied
# status.nonReadyStatus: resources not yet in desired state
```

### BundleDeployment Status States

| State | Meaning |
|---|---|
| `Ready` | All resources are deployed and healthy |
| `Modified` | Resources exist but differ from desired state |
| `NotReady` | Resources are being applied or have failures |
| `WaitApplied` | Waiting for the fleet-agent to apply |
| `Pending` | Waiting for dependencies |
| `ErrApplied` | Errors during resource apply |
| `OutOfSync` | Git has new changes not yet applied |

## Section 8: Complete Multi-Cluster Application Deployment

A complete example deploying a microservice application across all clusters:

### Repository Structure

```
company-platform/
├── apps/
│   └── order-service/
│       ├── fleet.yaml
│       ├── base/
│       │   ├── deployment.yaml
│       │   ├── service.yaml
│       │   ├── hpa.yaml
│       │   └── ingress.yaml
│       └── overlays/
│           ├── production/
│           │   ├── kustomization.yaml
│           │   └── values-patch.yaml
│           └── staging/
│               ├── kustomization.yaml
│               └── values-patch.yaml
```

```yaml
# apps/order-service/fleet.yaml
namespace: order-service

kustomize: {}    # Use kustomization.yaml in current directory

# Base resources applied to all clusters
targetCustomizations:
  - name: production
    clusterSelector:
      matchLabels:
        env: production
    kustomize:
      dir: overlays/production

  - name: staging
    clusterSelector:
      matchLabels:
        env: staging
    kustomize:
      dir: overlays/staging

  - name: development
    clusterSelector:
      matchLabels:
        env: development
    kustomize:
      dir: overlays/development

# Diff options — ignore fields that change frequently
diff:
  comparePatches:
    - apiVersion: apps/v1
      kind: Deployment
      name: order-service
      namespace: order-service
      jsonPointers:
        - /status
        - /metadata/annotations/deployment.kubernetes.io~1revision
    - apiVersion: autoscaling/v2
      kind: HorizontalPodAutoscaler
      name: order-service-hpa
      namespace: order-service
      jsonPointers:
        - /status
```

```yaml
# apps/order-service/base/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-service
  namespace: order-service
  labels:
    app: order-service
    version: "2.5.0"
spec:
  replicas: 2
  selector:
    matchLabels:
      app: order-service
  template:
    metadata:
      labels:
        app: order-service
        version: "2.5.0"
    spec:
      serviceAccountName: order-service
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: order-service
          image: registry.company.com/order-service:2.5.0
          ports:
            - containerPort: 8080
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi
          readinessProbe:
            httpGet:
              path: /readyz
              port: 8080
            initialDelaySeconds: 10
          livenessProbe:
            httpGet:
              path: /livez
              port: 8080
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
```

```yaml
# apps/order-service/overlays/production/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

bases:
  - ../../base

patches:
  - patch: |-
      - op: replace
        path: /spec/replicas
        value: 3
    target:
      kind: Deployment
      name: order-service

  - patch: |-
      - op: replace
        path: /spec/template/spec/containers/0/resources
        value:
          requests:
            cpu: 500m
            memory: 512Mi
          limits:
            cpu: 2000m
            memory: 2Gi
    target:
      kind: Deployment
      name: order-service
```

## Section 9: Troubleshooting Fleet Sync Failures

### Diagnostic Workflow

```bash
# Step 1: Check GitRepo sync status
kubectl get gitrepo -n fleet-default
# NAME               REPO                              COMMIT   BUNDLEDEPLOYMENTS
# platform-config    https://github.com/company/...   abc1234  5/5

# If BUNDLEDEPLOYMENTS shows failures:
kubectl describe gitrepo platform-config -n fleet-default
# Events section shows fetch/parse errors

# Step 2: Check Bundle status
kubectl get bundles -n fleet-default
# NAME                             BUNDLEDEPLOYMENTS   READY   NOTREADY   ...
# fleet-default-platform-config-monitoring   5          4       1

# Step 3: Find the failing BundleDeployment
kubectl get bundledeployments -n fleet-default | grep -v "Ready"

# Step 4: Describe the failing deployment
kubectl describe bundledeployment fleet-default-platform-config-monitoring-prod-eu-1 \
  -n fleet-default

# Look for:
# Status:
#   Conditions:
#     Type: Deployed
#     Status: False
#     Message: helm upgrade failed: UPGRADE FAILED: cannot patch "prometheus-stack"
#              with kind StatefulSet: ...

# Step 5: Check fleet-agent logs on the target cluster
kubectl logs -n cattle-fleet-system \
  -l app=fleet-agent \
  --tail=200

# Step 6: Check fleet-controller logs
kubectl logs -n cattle-fleet-system \
  -l app=fleet-controller \
  --tail=200 \
  --since=1h
```

### Common Issues and Resolutions

```bash
# Issue 1: Helm upgrade failing due to immutable field change

# Symptom: "cannot patch ... with kind StatefulSet: ... field is immutable"
# Resolution: Delete the StatefulSet and let Fleet recreate it
# Or: Use fleet.yaml diff.comparePatches to ignore the field
# Or: Enable force upgrade in fleet.yaml

# fleet.yaml
helm:
  force: true   # Deletes and recreates resources on upgrade conflict
  # WARNING: causes downtime, only use when necessary

# Issue 2: Bundle shows "Modified" but never transitions to "Ready"

# Check what's modified
kubectl get bundledeployment ... -o json | \
  jq '.status.nonReadyStatus'

# Force re-apply
kubectl annotate bundledeployment \
  fleet-default-platform-config-monitoring-prod-eu-1 \
  -n fleet-default \
  "fleet.cattle.io/force-apply=$(date -u +%Y%m%d%H%M%S)"

# Issue 3: GitRepo shows "fetching" forever

# Check if credentials are valid
kubectl get secret github-credentials -n fleet-default -o yaml | \
  base64 -d

# Verify gitjob pod can reach the repository
kubectl exec -n cattle-fleet-system deploy/gitjob -- \
  git ls-remote https://github.com/company/platform-config HEAD

# Issue 4: Cluster not receiving any bundles

# Check if cluster is registered correctly
kubectl get cluster prod-us-east-1 -n fleet-default -o yaml
# Should show status.agent.connected: true

# Check fleet-agent in the target cluster
kubectl get pods -n cattle-fleet-system   # Run on the target cluster

# Issue 5: Conflicting resources across bundles

# Two GitRepos deploying the same resource causes conflicts
# Resolution: Use diff.comparePatches or namespace different deployments
kubectl get bundles -n fleet-default | grep -v "Ready"
```

### Fleet Debugging Tool

```bash
#!/bin/bash
# fleet-health-check.sh — comprehensive Fleet status report

set -euo pipefail

NAMESPACE="${FLEET_NAMESPACE:-fleet-default}"

echo "=== Rancher Fleet Health Check ==="
echo "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Namespace: $NAMESPACE"
echo ""

echo "=== Cluster Status ==="
kubectl get clusters -n "$NAMESPACE" \
  -o custom-columns='NAME:.metadata.name,STATE:.status.agent.state,CONNECTED:.status.agent.connected,LAST_SEEN:.status.agent.lastSeen'
echo ""

echo "=== GitRepo Status ==="
kubectl get gitrepos -n "$NAMESPACE" \
  -o custom-columns='NAME:.metadata.name,COMMIT:.status.commit,READY:.status.summary.ready,ERRORS:.status.summary.errApplied'
echo ""

echo "=== Bundle Summary ==="
kubectl get bundles -n "$NAMESPACE" \
  -o custom-columns='NAME:.metadata.name,READY:.status.summary.ready,NOT_READY:.status.summary.notReady,ERR:.status.summary.errApplied'
echo ""

echo "=== Failed BundleDeployments ==="
kubectl get bundledeployments -n "$NAMESPACE" \
  -o json | \
  jq -r '
    .items[] |
    select(.status.display.state != "Ready") |
    "Bundle: \(.metadata.name)\n  State: \(.status.display.state)\n  Message: \(.status.display.message)\n"
  '

echo "=== Fleet Controller Errors (last 50 lines) ==="
kubectl logs -n cattle-fleet-system \
  -l app=fleet-controller \
  --tail=50 2>/dev/null | \
  grep -i "error\|ERR\|WARN" || echo "No errors found"
```

## Section 10: Advanced Fleet Patterns

### Multi-Tenant Fleet Workspaces

Fleet workspaces provide namespace-level isolation for different teams:

```bash
# Create workspaces for different teams
cat <<EOF | kubectl apply -f -
apiVersion: management.cattle.io/v3
kind: FleetWorkspace
metadata:
  name: team-platform
---
apiVersion: management.cattle.io/v3
kind: FleetWorkspace
metadata:
  name: team-applications
EOF

# Move clusters to specific workspaces
kubectl patch cluster prod-us-east-1 \
  -n fleet-default \
  --type=json \
  -p='[{"op":"replace","path":"/spec/targetWorkspace","value":"team-platform"}]'
```

### Dependency Management Between Bundles

```yaml
# fleet.yaml — bundle with dependency on cert-manager
dependsOn:
  - name: fleet-default-platform-config-cert-manager
    selector:
      matchLabels:
        fleet.cattle.io/bundle: fleet-default-platform-config-cert-manager
```

### Per-Cluster Helm Values from Cluster Labels

```yaml
# fleet.yaml — generate values dynamically from cluster metadata
helm:
  values:
    global:
      clusterName: "{{cluster.name}}"
      region: "{{cluster.labels.region}}"
      environment: "{{cluster.labels.env}}"
      cloudProvider: "{{cluster.labels.cloud}}"

targetCustomizations:
  - name: aws-clusters
    clusterSelector:
      matchLabels:
        cloud: aws
    helm:
      values:
        cloud:
          provider: aws
          region: "{{cluster.labels.region}}"
          accountID: "{{cluster.annotations[\"aws-account-id\"]}}"

  - name: gcp-clusters
    clusterSelector:
      matchLabels:
        cloud: gcp
    helm:
      values:
        cloud:
          provider: gcp
          project: "{{cluster.annotations[\"gcp-project\"]}}"
```

### Continuous Compliance Scanning with Fleet

```yaml
# gitrepo-compliance.yaml — enforce compliance policies across all clusters
apiVersion: fleet.cattle.io/v1alpha1
kind: GitRepo
metadata:
  name: compliance-policies
  namespace: fleet-default
spec:
  repo: https://github.com/company/security-policies
  branch: main
  paths:
    - /gatekeeper/templates
    - /gatekeeper/constraints

  # Apply to ALL clusters
  targets:
    - name: all-clusters
      clusterSelector: {}

  # Never allow drift — policies must match Git exactly
  correctDrift:
    enabled: true
    force: true

  rolloutStrategy:
    # Apply policies conservatively — one cluster at a time
    autoPartitionSize: 5%
    maxUnavailablePartitions: 1
```

### Integration with Rancher Pipeline Notifications

```bash
# Configure webhook notification on Fleet state changes
cat <<EOF | kubectl apply -f -
apiVersion: fleet.cattle.io/v1alpha1
kind: GitRepo
metadata:
  name: app-gitrepo
  namespace: fleet-default
  annotations:
    # Slack notification on sync failures (via Rancher notification webhook)
    cattle.io/webhook: "https://hooks.company.com/fleet-notifications"
spec:
  repo: https://github.com/company/apps
  branch: main
  paths:
    - /apps
  targets:
    - name: all
      clusterSelector: {}
EOF
```

Rancher Fleet's combination of GitOps-driven reconciliation, cluster label selectors, per-cluster value customization, and partition-based rollout strategies makes it a production-capable platform for managing Kubernetes configuration at enterprise scale. The key to success is a well-organized repository structure, comprehensive cluster labeling taxonomy, and monitoring of BundleDeployment status across all registered clusters.
