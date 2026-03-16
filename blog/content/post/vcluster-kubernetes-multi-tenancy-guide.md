---
title: "vCluster Virtual Kubernetes: Multi-Tenancy, Isolation, and Development Environments"
date: 2027-07-13T00:00:00-05:00
draft: false
tags: ["vCluster", "Kubernetes", "Multi-Tenancy", "Development", "Isolation"]
categories: ["Kubernetes", "Platform Engineering", "Developer Experience"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep-dive guide to vCluster virtual Kubernetes clusters covering syncer architecture, k3s and k0s distributions, namespace vs virtual cluster isolation, persistent storage sync, network isolation, CI pipeline integration, and multi-tenant SaaS patterns."
more_link: "yes"
url: "/vcluster-kubernetes-multi-tenancy-guide/"
---

vCluster creates fully functional Kubernetes clusters that run entirely within a namespace of an existing host cluster. Each virtual cluster has its own API server, controller manager, and etcd (or embedded SQLite), allowing tenants to enjoy the full Kubernetes API surface — including custom resource definitions, cluster-scoped resources, and admin-level operations — without any of that bleeding into adjacent tenants or the host cluster. This architectural approach solves the hardest multi-tenancy problems in Kubernetes while consuming a fraction of the resources of a full cluster.

<!--more-->

## Executive Summary

Kubernetes multi-tenancy has historically required choosing between coarse-grained namespace isolation (insufficient for many enterprise requirements) and expensive full cluster-per-tenant models. vCluster occupies a compelling middle ground: tenants receive a complete Kubernetes API server they can treat as their own, while the host cluster administrator retains control over actual workload scheduling and resource consumption. This guide covers vCluster architecture, deployment patterns, storage and network configuration, CI/CD integration, RBAC delegation, and production multi-tenant SaaS topologies.

## vCluster Architecture

### Virtual Control Plane Components

```
Host Cluster Namespace: tenant-a
├── Pod: vcluster-tenant-a (virtual control plane)
│   ├── Container: vcluster (API server + controller manager)
│   │   └── k3s or k0s embedded distribution
│   ├── Container: syncer (virtual ↔ host resource sync)
│   └── Container: etcd (or embedded SQLite for small vclusters)
└── Pods: synced workloads (from virtual cluster)
    ├── Pod: virtual-deployment-abc123 (real pod on host)
    └── Pod: virtual-deployment-def456 (real pod on host)
```

### The Syncer

The syncer is the critical component that bridges the virtual cluster and the host cluster:

```
Virtual Cluster               Syncer               Host Cluster
─────────────────             ──────               ────────────
kubectl apply                 translates           creates Pod in
  Deployment →                namespace +          host namespace
                              labels               with virtual
                              rewrites             cluster prefix
                                  ↓
kubectl get pods              reads host           returns pod status
  (virtual view) ←            pod status           translated back
```

Resources that are synced to the host cluster (low-level):
- Pods
- PersistentVolumeClaims
- Services (configurable)
- ConfigMaps (when referenced by Pods)
- Secrets (when referenced by Pods)
- ServiceAccounts
- Endpoints/EndpointSlices

Resources that stay entirely within the virtual cluster (high-level):
- Deployments, StatefulSets, DaemonSets
- RBAC (Roles, ClusterRoles, Bindings)
- NetworkPolicies (virtual cluster-level)
- CustomResourceDefinitions
- Namespaces (within the virtual cluster)

### Supported Backing Distributions

```
Distribution   Control Plane    Resource Use    Best For
───────────────────────────────────────────────────────────
k3s            Lightweight      ~100MB RAM      Dev environments, CI
k0s            Standard         ~200MB RAM      Production workloads
vanilla k8s    Full             ~500MB RAM      Conformance requirements
```

## Installation

### vCluster CLI

```bash
# Install vCluster CLI
curl -L -o /usr/local/bin/vcluster \
  "https://github.com/loft-sh/vcluster/releases/latest/download/vcluster-linux-amd64"
chmod +x /usr/local/bin/vcluster

vcluster version
# vcluster version 0.19.0
```

### Helm-Based Installation

```bash
helm repo add loft-sh https://charts.loft.sh
helm repo update

# Create a virtual cluster namespace
kubectl create namespace tenant-a

# Deploy vCluster with k3s backing
helm upgrade --install vcluster-tenant-a loft-sh/vcluster \
  --namespace tenant-a \
  --version 0.19.0 \
  --values vcluster-values.yaml
```

### vcluster-values.yaml (k3s backing)

```yaml
# vcluster-values.yaml
vcluster:
  image: ghcr.io/loft-sh/vcluster-k3s:v1.29.0
  resources:
    requests:
      cpu: 200m
      memory: 256Mi
    limits:
      cpu: "2"
      memory: 2Gi
  # k3s configuration
  extraArgs:
    - --kube-apiserver-arg=--audit-log-path=/var/log/k3s-audit.log
    - --kube-apiserver-arg=--audit-policy-file=/etc/k3s/audit-policy.yaml

syncer:
  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: "1"
      memory: 512Mi
  extraArgs:
    - --sync=ingresses  # Sync Ingress resources to host
    - --sync=storageclasses=false  # Don't sync StorageClasses

storage:
  persistence: true
  size: 5Gi

isolation:
  enabled: true
  podSecurityStandard: restricted
  resourceQuota:
    enabled: true
    quota:
      requests.cpu: "8"
      requests.memory: 16Gi
      limits.cpu: "16"
      limits.memory: 32Gi
      pods: "40"
      services: "20"
      persistentvolumeclaims: "10"
  limitRange:
    enabled: true
    default:
      cpu: 200m
      memory: 256Mi
    defaultRequest:
      cpu: 100m
      memory: 128Mi

sync:
  ingresses:
    enabled: true
  configmaps:
    all: false  # Only sync ConfigMaps used by Pods
  secrets:
    all: false  # Only sync Secrets used by Pods
  persistentvolumes:
    enabled: false  # Use virtual PVs backed by host PVCs
  storageClasses:
    enabled: false  # Use host StorageClasses via VirtualStorageClass
  hoststorageclasses:
    enabled: true  # Expose host StorageClasses inside virtual cluster

networking:
  replicateServices:
    fromHost:
      - from: kube-system/kube-dns
        to: kube-system/kube-dns

telemetry:
  disabled: false
```

## CLI Workflow

### Creating and Connecting

```bash
# Create a vCluster (quickstart)
vcluster create dev-cluster \
  --namespace vcluster-dev \
  --chart-version 0.19.0 \
  --values vcluster-dev-values.yaml

# Connect to the virtual cluster (updates kubeconfig)
vcluster connect dev-cluster \
  --namespace vcluster-dev \
  --update-current=false \
  --kube-config-context-name dev-cluster

# Use the virtual cluster
export KUBECONFIG=~/.kube/dev-cluster.yaml
kubectl get nodes
# NAME                     STATUS   ROLES    AGE
# vcluster-dev-tenant-a    Ready    <none>   2m

# Run a workload
kubectl create deployment nginx --image=nginx:latest
kubectl get pods
# NAME                    READY   STATUS    AGE
# nginx-6d4cf56db-7xq9t   1/1     Running   30s

# On the host cluster — note the prefixed names
kubectl get pods -n vcluster-dev
# NAME                               READY   STATUS
# nginx-6d4cf56db-7xq9t-x-default-x-dev-cluster   1/1     Running
```

### Listing and Managing Clusters

```bash
# List all virtual clusters across all namespaces
vcluster list --all-namespaces

# NAME            NAMESPACE      STATUS    AGE
# dev-cluster     vcluster-dev   Running   5m
# staging-clone   vcluster-stg   Running   1d
# ci-pr-1234      vcluster-ci    Running   2h

# Pause a virtual cluster (scale to zero)
vcluster pause dev-cluster --namespace vcluster-dev

# Resume
vcluster resume dev-cluster --namespace vcluster-dev

# Delete
vcluster delete dev-cluster --namespace vcluster-dev
```

## Isolation Configurations

### Namespace Isolation vs Virtual Cluster Isolation

```
Namespace Isolation          vCluster Isolation
────────────────────────     ──────────────────────────
Shared API server            Dedicated API server
Shared RBAC                  Independent RBAC
No CRD isolation             CRD isolation per tenant
ClusterRole risks            No cluster-scope bleed
NetworkPolicy required       Virtual network boundary
Resource quota via NS        Resource quota at syncer level
```

### Pod Security for Virtual Clusters

```yaml
# Enforce restricted Pod Security at the host namespace level
apiVersion: v1
kind: Namespace
metadata:
  name: tenant-a
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/audit: restricted
```

### Network Isolation Between vClusters

```yaml
# Host-level NetworkPolicy isolating vCluster namespaces
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: vcluster-isolation
  namespace: tenant-a
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: tenant-a
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
      ports:
        - protocol: UDP
          port: 53
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: tenant-a
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except:
              - 10.0.0.0/8
              - 172.16.0.0/12
              - 192.168.0.0/16
```

## Persistent Storage Sync

### Storage Class Mapping

```yaml
# vcluster-values.yaml - map virtual StorageClass to host
sync:
  persistentvolumes:
    enabled: false

hoststorageclasses:
  enabled: true

mapStorageClasses:
  - from: fast-ssd        # Virtual cluster StorageClass name
    to: gp3               # Host cluster StorageClass name
  - from: standard
    to: gp2
  - from: archive
    to: sc1
```

### PVC Sync Behavior

```bash
# In virtual cluster - create PVC
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: data-pvc
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 20Gi
  storageClassName: fast-ssd
EOF

# Host cluster - PVC is synced with renamed StorageClass
kubectl get pvc -n tenant-a
# NAME                          STATUS   VOLUME   CAPACITY   STORAGECLASS
# data-pvc-x-default-x-vc-a   Bound    pv-abc   20Gi       gp3
```

### StatefulSet with Persistent Storage

```yaml
# In virtual cluster - works transparently
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
spec:
  serviceName: postgres
  replicas: 1
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
    spec:
      containers:
        - name: postgres
          image: postgres:15-alpine
          env:
            - name: POSTGRES_PASSWORD
              value: changeme
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: [ReadWriteOnce]
        storageClassName: fast-ssd
        resources:
          requests:
            storage: 20Gi
```

## Service Account Projection

### Projecting Host Service Accounts into vCluster

```yaml
# vcluster-values.yaml - IRSA token projection
sync:
  serviceaccounts:
    enabled: true

# Mount host cluster tokens for cloud provider access
plugin:
  aws-irsa:
    image: ghcr.io/loft-sh/vcluster-plugin-example:latest
    env:
      - name: AWS_REGION
        value: us-east-1
```

### Service Account for Cross-Cluster Access

```yaml
# In virtual cluster - ServiceAccount with IRSA annotation
apiVersion: v1
kind: ServiceAccount
metadata:
  name: payment-service
  namespace: default
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/payment-service-role
---
# The syncer propagates the annotation to the host-level pod
# Host pod receives IRSA token via projected volume automatically
```

## RBAC Delegation

### Giving Tenant Full Admin Inside vCluster

```yaml
# In virtual cluster - ClusterRoleBinding (completely isolated)
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: tenant-a-admins
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cluster-admin
subjects:
  - kind: Group
    name: tenant-a-engineers
    apiGroup: rbac.authorization.k8s.io
```

Note: `cluster-admin` inside the virtual cluster grants no privileges on the host cluster. The virtual API server enforces its own RBAC independently.

### Host-Level RBAC for vCluster Management

```yaml
# Host cluster - allow tenant to manage their vCluster namespace
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: vcluster-manager
  namespace: tenant-a
rules:
  - apiGroups: ['']
    resources: [pods, pods/log, pods/exec]
    verbs: [get, list, watch]
  - apiGroups: [apps]
    resources: [deployments, statefulsets]
    verbs: [get, list, watch, patch]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: tenant-a-vcluster-manager
  namespace: tenant-a
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: vcluster-manager
subjects:
  - kind: Group
    name: tenant-a-engineers
    apiGroup: rbac.authorization.k8s.io
```

## Use Case: Development Environments

### Developer Self-Service vCluster

```yaml
# ArgoCD ApplicationSet for per-developer vClusters
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: developer-vclusters
  namespace: argocd
spec:
  generators:
    - list:
        elements:
          - developer: alice
            resources: small
          - developer: bob
            resources: small
          - developer: charlie
            resources: medium

  template:
    metadata:
      name: 'vcluster-dev-{{developer}}'
    spec:
      project: platform
      source:
        repoURL: https://github.com/acme/platform-gitops
        targetRevision: main
        path: vcluster/templates
        helm:
          values: |
            developer: {{developer}}
            resources: {{resources}}
      destination:
        server: https://kubernetes.default.svc
        namespace: 'vcluster-dev-{{developer}}'
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
```

### Developer vCluster Values Template

```yaml
# vcluster/templates/values.yaml
vcluster:
  image: ghcr.io/loft-sh/vcluster-k3s:v1.29.0
  resources:
    {{- if eq .Values.resources "small" }}
    requests:
      cpu: 100m
      memory: 256Mi
    limits:
      cpu: "1"
      memory: 1Gi
    {{- else if eq .Values.resources "medium" }}
    requests:
      cpu: 200m
      memory: 512Mi
    limits:
      cpu: "2"
      memory: 2Gi
    {{- end }}

isolation:
  enabled: true
  resourceQuota:
    enabled: true
    quota:
      {{- if eq .Values.resources "small" }}
      requests.cpu: "2"
      requests.memory: 4Gi
      {{- else if eq .Values.resources "medium" }}
      requests.cpu: "4"
      requests.memory: 8Gi
      {{- end }}
      pods: "20"

# Auto-sleep after 8 hours of inactivity
inactivity:
  sleep:
    enabled: true
    afterInactivity: 28800  # 8 hours
  wakeup:
    image: ghcr.io/loft-sh/vcluster:0.19.0
```

### Developer Onboarding Script

```bash
#!/usr/bin/env bash
# scripts/create-dev-env.sh
set -euo pipefail

DEVELOPER="${1:?Usage: $0 <developer-name>}"
NAMESPACE="vcluster-dev-${DEVELOPER}"

echo "Creating development vCluster for ${DEVELOPER}..."

# Create namespace
kubectl create namespace "${NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -

# Label for Pod Security
kubectl label namespace "${NAMESPACE}" \
  pod-security.kubernetes.io/enforce=restricted \
  developer="${DEVELOPER}" \
  managed-by=platform \
  --overwrite

# Create vCluster
vcluster create "dev-${DEVELOPER}" \
  --namespace "${NAMESPACE}" \
  --chart-version 0.19.0 \
  --values vcluster/templates/values-small.yaml \
  --connect=false

echo "vCluster created. Connect with:"
echo "  vcluster connect dev-${DEVELOPER} --namespace ${NAMESPACE}"
echo ""
echo "Or add to kubeconfig:"
echo "  vcluster connect dev-${DEVELOPER} --namespace ${NAMESPACE} --update-current=false --kube-config-context-name dev-${DEVELOPER}"
```

## Use Case: CI/CD Pipeline Isolation

### GitHub Actions Integration

```yaml
# .github/workflows/integration-tests.yaml
name: Integration Tests with vCluster

on:
  pull_request:
    branches: [main]

jobs:
  integration-test:
    runs-on: ubuntu-latest
    env:
      KUBECONFIG: /tmp/host-kubeconfig.yaml
      PR_NUMBER: ${{ github.event.pull_request.number }}

    steps:
      - uses: actions/checkout@v4

      - name: Configure Kubernetes credentials
        run: |
          echo "${{ secrets.KUBECONFIG_BASE64 }}" | base64 -d > /tmp/host-kubeconfig.yaml
          chmod 600 /tmp/host-kubeconfig.yaml

      - name: Install vCluster CLI
        run: |
          curl -L -o /usr/local/bin/vcluster \
            "https://github.com/loft-sh/vcluster/releases/latest/download/vcluster-linux-amd64"
          chmod +x /usr/local/bin/vcluster

      - name: Create ephemeral vCluster for PR
        run: |
          NAMESPACE="vcluster-ci-pr-${PR_NUMBER}"
          kubectl create namespace "${NAMESPACE}"
          vcluster create "ci-pr-${PR_NUMBER}" \
            --namespace "${NAMESPACE}" \
            --chart-version 0.19.0 \
            --values vcluster/ci-values.yaml \
            --connect=false

      - name: Connect to vCluster
        run: |
          vcluster connect "ci-pr-${PR_NUMBER}" \
            --namespace "vcluster-ci-pr-${PR_NUMBER}" \
            --update-current=false \
            --kube-config-context-name pr-cluster &
          sleep 10
          export KUBECONFIG=/root/.kube/config:~/.kube/config
          kubectl config use-context pr-cluster

      - name: Deploy application to vCluster
        run: |
          export KUBECONFIG=~/.kube/config
          kubectl config use-context pr-cluster
          helm upgrade --install payment-service ./helm \
            --set image.tag="${{ github.sha }}" \
            --wait --timeout 5m

      - name: Run integration tests
        run: |
          export KUBECONFIG=~/.kube/config
          kubectl config use-context pr-cluster
          go test ./tests/integration/... \
            -v \
            -timeout 15m \
            -tags integration

      - name: Delete vCluster on completion
        if: always()
        run: |
          export KUBECONFIG=/tmp/host-kubeconfig.yaml
          vcluster delete "ci-pr-${PR_NUMBER}" \
            --namespace "vcluster-ci-pr-${PR_NUMBER}" \
            --delete-namespace \
            --non-interactive
```

### CI vCluster Values

```yaml
# vcluster/ci-values.yaml
vcluster:
  image: ghcr.io/loft-sh/vcluster-k3s:v1.29.0
  resources:
    requests:
      cpu: 200m
      memory: 256Mi
    limits:
      cpu: "2"
      memory: 2Gi

storage:
  persistence: false  # Use ephemeral storage for CI

isolation:
  enabled: true
  resourceQuota:
    enabled: true
    quota:
      requests.cpu: "4"
      requests.memory: 8Gi
      pods: "30"

# Speed up startup for CI
sync:
  hoststorageclasses:
    enabled: true
  nodes:
    enabled: true
    syncBackChanges: false
```

## Use Case: Multi-Tenant SaaS

### Tenant Lifecycle with vCluster Platform

```yaml
# platform/crds/tenant-crd.yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: tenants.platform.acme.internal
spec:
  group: platform.acme.internal
  names:
    kind: Tenant
    plural: tenants
  scope: Cluster
  versions:
    - name: v1alpha1
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              required: [name, plan]
              properties:
                name:
                  type: string
                plan:
                  type: string
                  enum: [starter, professional, enterprise]
                region:
                  type: string
                  default: us-east-1
                customDomain:
                  type: string
```

### Tenant Operator Reconciliation Logic

```go
// Pseudocode: Tenant operator creates vCluster per tenant
func (r *TenantReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    tenant := &platformv1.Tenant{}
    if err := r.Get(ctx, req.NamespacedName, tenant); err != nil {
        return ctrl.Result{}, client.IgnoreNotFound(err)
    }

    namespace := fmt.Sprintf("tenant-%s", tenant.Spec.Name)

    // Ensure namespace exists
    if err := r.ensureNamespace(ctx, namespace, tenant); err != nil {
        return ctrl.Result{}, err
    }

    // Deploy vCluster via Helm
    if err := r.ensureVCluster(ctx, namespace, tenant); err != nil {
        return ctrl.Result{}, err
    }

    // Configure ingress for tenant's API endpoint
    if err := r.ensureIngress(ctx, namespace, tenant); err != nil {
        return ctrl.Result{}, err
    }

    // Deploy tenant's application workloads into their vCluster
    if err := r.deployTenantWorkloads(ctx, namespace, tenant); err != nil {
        return ctrl.Result{}, err
    }

    return ctrl.Result{RequeueAfter: 5 * time.Minute}, nil
}
```

### Tenant Resource Quotas by Plan

```yaml
# platform/config/tenant-plans.yaml
plans:
  starter:
    vcluster:
      cpu_limit: "2"
      memory_limit: 4Gi
    quota:
      requests.cpu: "2"
      requests.memory: 4Gi
      pods: "20"
      persistentvolumeclaims: "5"

  professional:
    vcluster:
      cpu_limit: "4"
      memory_limit: 8Gi
    quota:
      requests.cpu: "8"
      requests.memory: 16Gi
      pods: "50"
      persistentvolumeclaims: "20"

  enterprise:
    vcluster:
      cpu_limit: "8"
      memory_limit: 16Gi
    quota:
      requests.cpu: "32"
      requests.memory: 64Gi
      pods: "200"
      persistentvolumeclaims: "100"
```

## Resource Overhead Comparison

### Memory and CPU Overhead per vCluster

```
Configuration          Control Plane RAM    Control Plane CPU
──────────────────────────────────────────────────────────────
k3s (SQLite)           ~80MB                ~50m
k3s (etcd)             ~180MB               ~100m
k0s                    ~200MB               ~100m
vanilla k8s            ~450MB               ~200m
Full separate cluster  ~1.5GB               ~500m
```

### When to Use vCluster vs Full Cluster

```
Use Case                        Recommendation
──────────────────────────────────────────────────────────────────
Developer environments          vCluster (k3s, SQLite)
CI/CD isolation                 vCluster (k3s, ephemeral)
Multi-tenant SaaS               vCluster (k0s, per tenant)
Staging environment             vCluster (k0s) or full cluster
Production workloads            Full cluster preferred
Compliance hard isolation       Full cluster required
Different k8s versions          vCluster (different k8s image)
CRD isolation                   vCluster (CRDs scoped to VC)
Admin-level tenant access       vCluster
```

## Observability

### Host-Level Monitoring of vClusters

```yaml
# monitoring/vcluster-prometheusrule.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: vcluster-alerts
  namespace: monitoring
spec:
  groups:
    - name: vcluster.resources
      rules:
        - alert: VClusterHighMemory
          expr: |
            container_memory_working_set_bytes{
              container="vcluster",
              namespace=~"vcluster-.*"
            } / container_spec_memory_limit_bytes > 0.85
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "vCluster high memory usage"
            description: "vCluster in {{ $labels.namespace }} is using >85% of memory limit"

        - alert: VClusterDown
          expr: |
            absent(up{job="vcluster", namespace=~"vcluster-.*"})
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "vCluster control plane is down"
```

### Metrics Aggregation Across vClusters

```yaml
# Prometheus scrape config to collect metrics from all vClusters
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: vcluster-control-planes
  namespace: monitoring
spec:
  namespaceSelector:
    matchExpressions:
      - key: kubernetes.io/metadata.name
        operator: In
        values:
          - vcluster-dev
          - vcluster-staging
          - tenant-a
          - tenant-b
  selector:
    matchLabels:
      app: vcluster
  endpoints:
    - port: https
      scheme: https
      tlsConfig:
        insecureSkipVerify: true
      interval: 60s
```

## Upgrading vClusters

### Rolling Upgrade Procedure

```bash
# Check current version
vcluster list --all-namespaces

# Upgrade a specific vCluster
helm upgrade vcluster-tenant-a loft-sh/vcluster \
  --namespace tenant-a \
  --version 0.20.0 \
  --values vcluster-values.yaml \
  --wait

# Verify the virtual cluster API server is healthy
vcluster connect tenant-a-cluster \
  --namespace tenant-a \
  -- kubectl get nodes

# Upgrade the virtual Kubernetes version (k3s image)
helm upgrade vcluster-tenant-a loft-sh/vcluster \
  --namespace tenant-a \
  --version 0.20.0 \
  --set vcluster.image=ghcr.io/loft-sh/vcluster-k3s:v1.30.0 \
  --values vcluster-values.yaml \
  --wait
```

## Production Operations Checklist

### Pre-Production Readiness

```bash
# 1. Verify resource quotas are configured
kubectl get resourcequota -n tenant-a

# 2. Verify NetworkPolicy isolation
kubectl get networkpolicy -n tenant-a

# 3. Check Pod Security labels
kubectl get namespace tenant-a -o jsonpath='{.metadata.labels}'

# 4. Verify storage class mapping
vcluster connect tenant-a-cluster --namespace tenant-a -- \
  kubectl get storageclasses

# 5. Test workload scheduling
vcluster connect tenant-a-cluster --namespace tenant-a -- \
  kubectl run test --image=nginx:alpine --restart=Never
kubectl get pods -n tenant-a

# 6. Verify persistent storage
vcluster connect tenant-a-cluster --namespace tenant-a -- \
  kubectl apply -f - <<'EOF'
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: test-pvc
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 1Gi
EOF

# 7. Confirm backup covers vCluster etcd
kubectl exec -n tenant-a \
  $(kubectl get pod -n tenant-a -l app=vcluster -o jsonpath='{.items[0].metadata.name}') \
  -- /bin/sh -c "k3s etcd-snapshot --dir /tmp/ 2>/dev/null; ls -la /tmp/*.db"
```

### Backup vCluster State

```bash
#!/usr/bin/env bash
# scripts/backup-vcluster.sh
NAMESPACE="${1:?Usage: $0 <namespace>}"
BACKUP_DIR="${2:-/backups/vclusters}"
DATE=$(date +%Y-%m-%d-%H%M%S)

POD=$(kubectl get pod -n "${NAMESPACE}" \
  -l "app=vcluster" \
  -o jsonpath='{.items[0].metadata.name}')

mkdir -p "${BACKUP_DIR}/${NAMESPACE}"

# Dump all virtual cluster resources
kubectl exec -n "${NAMESPACE}" "${POD}" -- \
  /bin/sh -c "k3s kubectl get all --all-namespaces -o yaml" \
  > "${BACKUP_DIR}/${NAMESPACE}/resources-${DATE}.yaml"

# Backup etcd snapshot
kubectl exec -n "${NAMESPACE}" "${POD}" -- \
  k3s etcd-snapshot \
  --dir "/tmp/" \
  --name "backup-${DATE}" 2>/dev/null

kubectl cp "${NAMESPACE}/${POD}:/tmp/backup-${DATE}.db" \
  "${BACKUP_DIR}/${NAMESPACE}/etcd-${DATE}.db"

echo "Backup complete: ${BACKUP_DIR}/${NAMESPACE}/"
```

## Summary

vCluster provides a pragmatic solution to Kubernetes multi-tenancy that delivers genuine isolation with dramatically lower resource overhead than full cluster-per-tenant approaches. The syncer architecture ensures that tenants receive a complete Kubernetes API experience — full admin rights, CRD isolation, independent RBAC, and cluster-scoped resource management — while host cluster administrators retain control over actual workload scheduling and can apply consistent security policies at the namespace level. For developer environments, CI/CD pipelines, and multi-tenant SaaS platforms, vCluster reduces infrastructure costs, eliminates noisy-neighbor RBAC conflicts, and enables self-service cluster provisioning at a scale that full cluster models cannot economically sustain.
