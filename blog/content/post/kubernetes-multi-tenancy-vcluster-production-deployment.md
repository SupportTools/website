---
title: "Kubernetes Multi-Tenancy with Virtual Clusters: vcluster Production Deployment"
date: 2030-07-09T00:00:00-05:00
draft: false
tags: ["Kubernetes", "vcluster", "Multi-Tenancy", "Platform Engineering", "CI/CD", "Isolation", "DevOps"]
categories:
- Kubernetes
- Platform Engineering
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise vcluster guide covering virtual cluster architecture and isolation guarantees, syncer configuration, storage provisioning, multi-tenant CI/CD environments, cost optimization through cluster density, and a rigorous comparison between vcluster and namespace-based multi-tenancy."
more_link: "yes"
url: "/kubernetes-multi-tenancy-vcluster-production-deployment/"
---

Namespace-based multi-tenancy in Kubernetes provides logical isolation through RBAC, NetworkPolicy, and ResourceQuota, but shares the cluster's control plane, API server, and etcd among all tenants. A tenant with sufficient permissions — or an exploited vulnerability — can escape namespace boundaries through cluster-scoped resources, shared admission webhooks, or node-level attacks. vcluster addresses this by running a complete virtual Kubernetes control plane per tenant within a namespace, giving each tenant a fully isolated API server, scheduler, and etcd (or SQLite) while reusing host cluster nodes for actual workload execution. The result is strong isolation economics: tens of virtual clusters per physical cluster node.

<!--more-->

## Architecture: How vcluster Works

Each vcluster consists of:
1. **Virtual API Server**: A standard `k3s` or `k8s` API server running as a pod in the host cluster.
2. **Controller Manager**: Reconciles virtual cluster resources.
3. **Syncer**: The key component — watches virtual cluster objects and syncs them to the host cluster as real workloads.
4. **Datastore**: SQLite (lightweight) or external etcd for larger virtual clusters.

```
Host Cluster
┌──────────────────────────────────────────────────────────────┐
│  Namespace: vcluster-team-payments                           │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  vcluster Pod                                          │  │
│  │  ├── k3s apiserver (virtual control plane)            │  │
│  │  ├── k3s controller-manager                           │  │
│  │  └── syncer sidecar                                   │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  Synced objects (prefixed/namespaced by vcluster):           │
│  ├── Pods (team-payments-pod-xxxxx)                          │
│  ├── Services                                                │
│  ├── Secrets (filtered)                                      │
│  ├── ConfigMaps (filtered)                                   │
│  └── PVCs → PVs                                              │
└──────────────────────────────────────────────────────────────┘

Tenant sees (via virtual kubeconfig):
┌─────────────────────────────────┐
│  Virtual Cluster (k8s API)      │
│  ├── kube-system namespace      │
│  ├── default namespace          │
│  ├── tenant-apps namespace      │
│  ├── Full RBAC control          │
│  ├── CRD management             │
│  └── Custom webhooks            │
└─────────────────────────────────┘
```

### What vcluster Syncs vs. Keeps Virtual

**Synced to host cluster (real resources):**
- Pods (with name mangling to prevent collisions)
- Services (ClusterIP, NodePort)
- Endpoints, EndpointSlices
- PersistentVolumeClaims
- Secrets (only those referenced by synced pods)
- ConfigMaps (only those referenced by synced pods)

**Kept virtual (exist only in virtual etcd):**
- Namespaces
- ServiceAccounts
- RBAC (Roles, RoleBindings, ClusterRoles, ClusterRoleBindings)
- NetworkPolicies
- Ingresses (optionally synced)
- CustomResourceDefinitions
- Admission webhooks

This split is the key to vcluster's security model: a tenant's RBAC, webhooks, and CRDs cannot affect the host cluster.

## Installation and Basic Deployment

### Prerequisites

```bash
# Install vcluster CLI
curl -Lo /usr/local/bin/vcluster \
  https://github.com/loft-sh/vcluster/releases/latest/download/vcluster-linux-amd64
chmod +x /usr/local/bin/vcluster

# Verify
vcluster version
# vcluster version 0.20.0

# Install Helm (required for vcluster deployment)
curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
```

### Creating a Virtual Cluster

```bash
# Create namespace for the virtual cluster
kubectl create namespace vcluster-team-payments

# Deploy using vcluster CLI (wraps Helm chart)
vcluster create team-payments \
  --namespace vcluster-team-payments \
  --chart-version "0.20.0" \
  --values /path/to/team-payments-values.yaml

# Access the virtual cluster
vcluster connect team-payments --namespace vcluster-team-payments
# [done] Virtual cluster connected, use --service-account to override the service account
# - Use "kubectl" to access the virtual cluster

# Or export kubeconfig
vcluster connect team-payments \
  --namespace vcluster-team-payments \
  --print > ~/.kube/vcluster-team-payments.kubeconfig

export KUBECONFIG=~/.kube/vcluster-team-payments.kubeconfig
kubectl get nodes  # Shows virtual nodes
```

## Production vcluster Configuration

### Full Helm Values

```yaml
# team-payments-vcluster-values.yaml
vcluster:
  image: rancher/k3s:v1.30.2-k3s1

sync:
  # Sync ingresses to host cluster (enables real ingress routing)
  ingresses:
    enabled: true
  # Sync storage classes from host cluster into virtual cluster
  storageClasses:
    enabled: true
  # Sync node labels and conditions for workload scheduling decisions
  nodes:
    enabled: true
    syncAllNodes: false
    nodeSelector: "node-pool=general"
  # Sync pod disruption budgets
  podDisruptionBudgets:
    enabled: true
  # Do NOT sync CSI volumes — use standard PVC syncing
  csiDrivers:
    enabled: false
  csiNodes:
    enabled: false
  # Sync NetworkPolicies from virtual to host
  networkPolicies:
    enabled: true
  # Sync priority classes
  priorityClasses:
    enabled: true

# Resource isolation
resources:
  requests:
    cpu: 200m
    memory: 256Mi
  limits:
    cpu: 2000m
    memory: 2Gi

# Use embedded SQLite for most virtual clusters
# For large virtual clusters (>500 resources), consider external etcd
embeddedEtcd:
  enabled: false  # Use SQLite

# Persistent storage for virtual cluster state
persistence:
  storageClass: gp3
  size: 5Gi

# Virtual cluster API server configuration
controlPlane:
  distro:
    k3s:
      enabled: true
      helmValues:
        server:
          args:
            - "--disable=metrics-server"
            - "--disable=coredns"  # Use host cluster CoreDNS syncing
            - "--kube-apiserver-arg=audit-log-path=/var/log/audit.log"
            - "--kube-apiserver-arg=audit-log-maxage=7"
            - "--kube-apiserver-arg=audit-log-maxsize=50"

# High availability — run vcluster control plane with 2 replicas
statefulSet:
  replicas: 1  # Increase to 2+ for HA, requires external etcd

# Networking
networking:
  replicateServices:
    fromHost: []  # Services to replicate from host into virtual cluster
    toHost: []    # Services to replicate from virtual to host

# Security — restrict what the vcluster pod itself can do
securityContext:
  runAsUser: 12345
  runAsNonRoot: true
  allowPrivilegeEscalation: false
  capabilities:
    drop:
      - ALL
  readOnlyRootFilesystem: true
  seccompProfile:
    type: RuntimeDefault

# ServiceAccount for the vcluster workload
serviceAccount:
  name: vc-team-payments

# Host namespace isolation
isolation:
  enabled: true
  resourceQuota:
    requests:
      cpu: "10"
      memory: "20Gi"
      storage: "100Gi"
    limits:
      cpu: "20"
      memory: "40Gi"
    services:
      nodeports: "0"    # No NodePorts from within vcluster
      loadbalancers: "5"
  limitRange:
    default:
      cpu: "1"
      memory: "512Mi"
    defaultRequest:
      cpu: "100m"
      memory: "128Mi"
    max:
      cpu: "8"
      memory: "8Gi"
  networkPolicy:
    enabled: true
    outgoingConnections:
      ipBlock:
        cidr: "0.0.0.0/0"
        except:
          - "10.0.0.0/8"   # Block access to internal infrastructure
          - "172.16.0.0/12"
          - "192.168.0.0/16"

# Telemetry
telemetry:
  enabled: false

# Experimental features
experimental:
  multiNamespaceMode:
    enabled: false  # All tenant namespaces map to one host namespace
  genericSync:
    enabled: false
```

### RBAC for Virtual Cluster Access

The vcluster syncer requires specific RBAC on the host cluster to create/manage synced resources:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: vc-team-payments
  namespace: vcluster-team-payments
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: vc-team-payments
  namespace: vcluster-team-payments
rules:
  - apiGroups: [""]
    resources:
      - configmaps
      - secrets
      - services
      - pods
      - pods/attach
      - pods/portforward
      - pods/exec
      - pods/log
      - endpoints
      - persistentvolumeclaims
      - events
    verbs: ["*"]
  - apiGroups: ["apps"]
    resources:
      - deployments
      - replicasets
      - statefulsets
      - daemonsets
    verbs: ["*"]
  - apiGroups: ["networking.k8s.io"]
    resources:
      - ingresses
      - networkpolicies
    verbs: ["*"]
  - apiGroups: ["storage.k8s.io"]
    resources:
      - storageclasses
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: vc-team-payments
  namespace: vcluster-team-payments
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: vc-team-payments
subjects:
  - kind: ServiceAccount
    name: vc-team-payments
    namespace: vcluster-team-payments
---
# ClusterRole for syncing nodes and storageclasses
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: vc-team-payments-cluster
rules:
  - apiGroups: [""]
    resources:
      - nodes
    verbs: ["get", "list", "watch"]
  - apiGroups: ["storage.k8s.io"]
    resources:
      - storageclasses
      - csinodes
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: vc-team-payments-cluster
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: vc-team-payments-cluster
subjects:
  - kind: ServiceAccount
    name: vc-team-payments
    namespace: vcluster-team-payments
```

## Multi-Tenant CI/CD Environments

vcluster excels for ephemeral CI environments. Each pipeline run gets a fully isolated Kubernetes cluster without the overhead of provisioning real infrastructure:

### GitHub Actions Workflow

```yaml
name: CI with Virtual Cluster
on:
  pull_request:
    branches: [main]

jobs:
  integration-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up kubectl
        uses: azure/setup-kubectl@v4

      - name: Set up vcluster CLI
        run: |
          curl -Lo /usr/local/bin/vcluster \
            https://github.com/loft-sh/vcluster/releases/latest/download/vcluster-linux-amd64
          chmod +x /usr/local/bin/vcluster

      - name: Configure host cluster access
        run: |
          echo "${{ secrets.KUBECONFIG_CI }}" > /tmp/host-kubeconfig.yaml
          export KUBECONFIG=/tmp/host-kubeconfig.yaml

      - name: Create ephemeral virtual cluster
        run: |
          export KUBECONFIG=/tmp/host-kubeconfig.yaml
          VCLUSTER_NAME="ci-pr-${{ github.event.pull_request.number }}-${{ github.run_id }}"
          echo "VCLUSTER_NAME=${VCLUSTER_NAME}" >> $GITHUB_ENV

          kubectl create namespace "vcluster-${VCLUSTER_NAME}" || true

          vcluster create "${VCLUSTER_NAME}" \
            --namespace "vcluster-${VCLUSTER_NAME}" \
            --connect=false \
            --chart-version "0.20.0" \
            --values ci-vcluster-values.yaml

          # Wait for vcluster to be ready
          kubectl wait pod \
            -n "vcluster-${VCLUSTER_NAME}" \
            -l "app=vcluster" \
            --for=condition=Ready \
            --timeout=120s

          # Export virtual kubeconfig
          vcluster connect "${VCLUSTER_NAME}" \
            --namespace "vcluster-${VCLUSTER_NAME}" \
            --print > /tmp/vcluster-kubeconfig.yaml

      - name: Deploy application
        env:
          KUBECONFIG: /tmp/vcluster-kubeconfig.yaml
        run: |
          kubectl apply -f k8s/
          kubectl rollout status deployment/app --timeout=120s

      - name: Run integration tests
        env:
          KUBECONFIG: /tmp/vcluster-kubeconfig.yaml
        run: |
          go test -v -tags=integration ./tests/integration/...

      - name: Cleanup virtual cluster
        if: always()
        run: |
          export KUBECONFIG=/tmp/host-kubeconfig.yaml
          vcluster delete "${VCLUSTER_NAME}" \
            --namespace "vcluster-${VCLUSTER_NAME}" || true
          kubectl delete namespace "vcluster-${VCLUSTER_NAME}" || true
```

### CI vcluster Values (Lightweight)

```yaml
# ci-vcluster-values.yaml — minimal resources for CI
vcluster:
  image: rancher/k3s:v1.30.2-k3s1

resources:
  requests:
    cpu: 50m
    memory: 128Mi
  limits:
    cpu: 500m
    memory: 512Mi

persistence:
  storageClass: ""
  size: 1Gi

sync:
  ingresses:
    enabled: false
  nodes:
    enabled: false
  storageClasses:
    enabled: false

isolation:
  enabled: true
  resourceQuota:
    requests:
      cpu: "4"
      memory: "8Gi"
    limits:
      cpu: "8"
      memory: "16Gi"
```

## Storage Provisioning

### Using Host Cluster Storage Classes

Configure the syncer to make host storage classes available to virtual cluster tenants:

```yaml
# In vcluster values
sync:
  storageClasses:
    enabled: true  # Exposes host storage classes in virtual cluster
  persistentVolumes:
    enabled: false  # Let the syncer manage PV lifecycle

# Tenant creates PVCs using host storage class names
# vcluster syncer creates corresponding PVCs in the host namespace
```

### Per-Tenant Storage Quotas

```yaml
# Applied to the host namespace containing the vcluster
apiVersion: v1
kind: ResourceQuota
metadata:
  name: team-payments-storage
  namespace: vcluster-team-payments
spec:
  hard:
    persistentvolumeclaims: "20"
    requests.storage: "500Gi"
    gp3.storageclass.storage.k8s.io/requests.storage: "200Gi"
    gp3.storageclass.storage.k8s.io/persistentvolumeclaims: "10"
```

## vcluster vs. Namespace-Based Multi-Tenancy

| Dimension | Namespace Isolation | vcluster |
|---|---|---|
| API server | Shared | Dedicated per tenant |
| RBAC scope | Can grant cluster-scoped resources | Full cluster-admin within vcluster |
| CRDs | Shared, potential version conflicts | Isolated per tenant |
| Admission webhooks | Shared, affect all tenants | Tenant-scoped, cannot affect others |
| Kubernetes version | Same as host | Independently configurable |
| Failure blast radius | API server failure affects all | vcluster failure affects one tenant |
| Noisy neighbor (API) | High risk | API traffic isolated to vcluster pod |
| Resource overhead | ~0 per namespace | ~200-500 MB RAM per vcluster |
| Cluster-scoped resource access | Denied | Full access (within virtual cluster) |
| Operations complexity | Lower | Higher |

**Choose namespace isolation when:**
- Tenants are internal teams with trusted operators
- Strict Kubernetes version uniformity is required
- Resource overhead per tenant is a constraint
- All tenants use the same set of CRDs

**Choose vcluster when:**
- Tenants require cluster-admin access (external customers, partner teams)
- Tenants need to install custom CRDs or admission webhooks
- Tenant isolation from control plane failures is required
- CI/CD environments need ephemeral, disposable Kubernetes clusters

## Monitoring Virtual Clusters

```yaml
# PodMonitor for vcluster API server metrics
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: vcluster-metrics
  namespace: monitoring
spec:
  namespaceSelector:
    matchExpressions:
      - key: vcluster-managed
        operator: Exists
  selector:
    matchLabels:
      app: vcluster
  podMetricsEndpoints:
    - port: metrics
      interval: 30s
      path: /metrics
```

```bash
# Check vcluster syncer status
kubectl logs -n vcluster-team-payments \
  deployment/team-payments \
  -c syncer \
  --since=1h | grep -E 'error|warn'

# List synced pods in host namespace
kubectl get pods -n vcluster-team-payments \
  -l vcluster.loft.sh/object-kind=Pod

# Check vcluster resource usage
kubectl top pod -n vcluster-team-payments

# Verify virtual cluster API is responsive
vcluster connect team-payments -n vcluster-team-payments -- \
  kubectl cluster-info
```

## Summary

vcluster delivers production-grade multi-tenancy for scenarios where namespace isolation is insufficient:

- **Isolation**: Each virtual cluster has its own API server, RBAC, CRDs, and admission webhooks — a tenant with cluster-admin cannot escape their virtual boundary.
- **Efficiency**: 10-50 virtual clusters per physical cluster node, with each vcluster consuming ~200-500 MB RAM for control plane overhead.
- **CI/CD**: Ephemeral virtual clusters provide fully isolated test environments without infrastructure provisioning overhead.
- **Tenant autonomy**: Teams manage their own Kubernetes versions, install custom operators, and configure webhooks without host cluster permissions.

The trade-off is operational overhead: each virtual cluster adds a control plane pod to monitor, upgrade, and troubleshoot. For large-scale deployments, tools like Loft (the commercial platform built on vcluster) automate virtual cluster lifecycle management across hundreds of tenants.
