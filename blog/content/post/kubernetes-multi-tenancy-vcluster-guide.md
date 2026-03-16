---
title: "vCluster: Virtual Kubernetes Clusters for Hard Multi-Tenancy"
date: 2027-05-05T00:00:00-05:00
draft: false
tags: ["Kubernetes", "vCluster", "Multi-Tenancy", "Platform Engineering", "Isolation"]
categories: ["Kubernetes", "Platform Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to deploying vCluster for hard multi-tenancy on Kubernetes, covering virtual cluster architecture, isolation models, persistent storage, networking, GitOps integration, and cost optimization."
more_link: "yes"
url: "/kubernetes-multi-tenancy-vcluster-guide/"
---

Platform engineering teams face a persistent tension between the operational efficiency of shared Kubernetes clusters and the isolation guarantees that enterprise tenants—development teams, business units, or external customers—demand. Namespace-based soft multi-tenancy provides resource quotas and RBAC boundaries, but a determined or simply misconfigured tenant can still leak information via the API server, observe cluster-wide resources, or trigger noisy-neighbour effects through aggressive admission webhook calls.

vCluster solves this by running a fully functional Kubernetes API server inside a host cluster namespace. Each virtual cluster gets its own control plane, its own etcd (or SQLite/embedded database), and its own set of CRDs—all without requiring dedicated physical nodes. Tenants interact with a real Kubernetes API; the vCluster syncer translates that intent into objects on the host cluster's data plane.

<!--more-->

## Executive Summary

vCluster provides hard multi-tenancy by running lightweight virtual Kubernetes clusters inside host cluster namespaces. This guide covers the full production deployment lifecycle: architecture internals, choosing between k3s/k0s/k8s distros, storage and networking configuration, RBAC isolation, GitOps integration with ArgoCD and Flux, resource quota enforcement at the host level, upgrade strategies, and cost optimisation patterns for teams operating tens or hundreds of virtual clusters.

## Understanding vCluster Architecture

### Control Plane Components

A vCluster deployment consists of two main components running in a single StatefulSet (or Deployment) within a dedicated host namespace:

- **Virtual API Server** — a full Kubernetes API server (using the chosen distro's binary) that serves the tenant's requests
- **Syncer** — a controller that watches virtual cluster resources and reconciles them against host cluster namespaces

```
┌─────────────────────────────── Host Cluster ─────────────────────────────────┐
│                                                                               │
│  ┌─────────────── Host Namespace: vcluster-team-a ─────────────────────────┐ │
│  │                                                                          │ │
│  │   ┌──────────────────────────────────────────────────────────────────┐  │ │
│  │   │   StatefulSet: vcluster                                          │  │ │
│  │   │                                                                  │  │ │
│  │   │   ┌─────────────────────────────────────────────────────────┐   │  │ │
│  │   │   │  Virtual API Server (k3s / k0s / k8s)                   │   │  │ │
│  │   │   │  Virtual etcd / SQLite / embedded DB                    │   │  │ │
│  │   │   │  Syncer controller                                      │   │  │ │
│  │   │   └─────────────────────────────────────────────────────────┘   │  │ │
│  │   └──────────────────────────────────────────────────────────────────┘  │ │
│  │                                                                          │ │
│  │   Host Namespace objects (Pods, Services, PVCs) created by syncer       │ │
│  └──────────────────────────────────────────────────────────────────────────┘ │
│                                                                               │
│  Host data plane: kubelet, CNI, CSI — shared across all vclusters            │
└───────────────────────────────────────────────────────────────────────────────┘
```

### The Syncer's Role

The syncer is what makes vCluster both powerful and safe. When a tenant creates a Pod in the virtual cluster, the syncer:

1. Rewrites the Pod manifest (prefixing names with the virtual cluster name to avoid collisions)
2. Strips fields that could expose host cluster internals
3. Creates the Pod in the host namespace under the syncer's ServiceAccount
4. Reflects status back into the virtual cluster

```yaml
# Example: tenant creates this in virtual cluster
apiVersion: v1
kind: Pod
metadata:
  name: my-app
  namespace: default
spec:
  containers:
  - name: app
    image: nginx:1.27
    resources:
      requests:
        cpu: 100m
        memory: 128Mi

# Syncer creates this in host cluster (host namespace: vcluster-team-a)
apiVersion: v1
kind: Pod
metadata:
  name: my-app-x-default-x-team-a-vcluster   # rewritten name
  namespace: vcluster-team-a                   # host namespace
  labels:
    vcluster.loft.sh/object-name: my-app
    vcluster.loft.sh/object-namespace: default
spec:
  containers:
  - name: app
    image: nginx:1.27
    resources:
      requests:
        cpu: 100m
        memory: 128Mi
```

## Choosing a Distro Mode

vCluster supports three virtual control plane distros. The choice affects binary size, startup time, feature parity, and operational complexity.

### k3s Mode (Default, Recommended for Most Cases)

k3s uses SQLite as its backing store by default, making it the lightest option. It starts in under 30 seconds and has a ~64 MB binary footprint.

```yaml
# vcluster-values-k3s.yaml
controlPlane:
  distro:
    k3s:
      enabled: true
      image:
        repository: rancher/k3s
        tag: v1.30.2-k3s1
  statefulSet:
    resources:
      requests:
        cpu: 200m
        memory: 256Mi
      limits:
        cpu: 1000m
        memory: 1Gi

  # Embedded SQLite — no separate etcd pod needed
  backingStore:
    embeddedDatabase:
      enabled: true
```

### k0s Mode (Production Recommended for HA)

k0s ships with embedded etcd and offers better HA story when running multiple control plane replicas.

```yaml
# vcluster-values-k0s.yaml
controlPlane:
  distro:
    k0s:
      enabled: true
      image:
        repository: k0sproject/k0s
        tag: v1.30.2-k0s.0
  statefulSet:
    highAvailability:
      replicas: 3   # requires external etcd or embedded etcd HA
    resources:
      requests:
        cpu: 500m
        memory: 512Mi
      limits:
        cpu: 2000m
        memory: 2Gi

  backingStore:
    etcd:
      embedded:
        enabled: true
```

### Vanilla k8s Mode (Maximum API Compatibility)

Running upstream Kubernetes API server + etcd gives maximum CRD and admission webhook compatibility at the cost of resource overhead.

```yaml
# vcluster-values-k8s.yaml
controlPlane:
  distro:
    k8s:
      enabled: true
      apiServer:
        image:
          repository: registry.k8s.io/kube-apiserver
          tag: v1.30.2
      controllerManager:
        image:
          repository: registry.k8s.io/kube-controller-manager
          tag: v1.30.2
  backingStore:
    etcd:
      deploy:
        enabled: true
        statefulSet:
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
```

## Installing the vCluster CLI

```bash
# Install vCluster CLI
curl -L -o /usr/local/bin/vcluster \
  "https://github.com/loft-sh/vcluster/releases/latest/download/vcluster-linux-amd64"
chmod +x /usr/local/bin/vcluster

# Verify installation
vcluster version
```

## Deploying vCluster with Helm

### Helm-Based Deployment (GitOps-Friendly)

```bash
# Add vCluster Helm repository
helm repo add loft-sh https://charts.loft.sh
helm repo update

# Create host namespace for the virtual cluster
kubectl create namespace vcluster-team-a

# Deploy virtual cluster
helm upgrade --install team-a-vcluster loft-sh/vcluster \
  --namespace vcluster-team-a \
  --version 0.20.0 \
  --values vcluster-values-k3s.yaml \
  --wait
```

### Complete Production Values File

```yaml
# vcluster-production-values.yaml
controlPlane:
  distro:
    k3s:
      enabled: true
      image:
        repository: rancher/k3s
        tag: v1.30.2-k3s1
      # Extra k3s flags
      extraArgs:
        - --kube-apiserver-arg=audit-log-path=/var/log/kubernetes/audit.log
        - --kube-apiserver-arg=audit-log-maxage=7
        - --kube-apiserver-arg=audit-log-maxbackup=5
        - --kube-apiserver-arg=audit-log-maxsize=100
        - --kube-apiserver-arg=audit-policy-file=/etc/kubernetes/audit-policy.yaml

  statefulSet:
    resources:
      requests:
        cpu: 200m
        memory: 256Mi
      limits:
        cpu: 1000m
        memory: 1Gi
    persistence:
      volumeClaim:
        enabled: true
        storageClass: fast-ssd
        size: 5Gi
    scheduling:
      podManagementPolicy: Parallel
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: vcluster

  backingStore:
    embeddedDatabase:
      enabled: true

  proxy:
    # Expose vCluster API via LoadBalancer for external tenant access
    extraSANs:
      - "team-a-vcluster.example.com"

# Sync configuration — control what gets synced to host
sync:
  toHost:
    pods:
      enabled: true
      rewriteHosts:
        enabled: true
        initContainerImage: library/alpine:3.20
    services:
      enabled: true
    persistentVolumeClaims:
      enabled: true
    configMaps:
      enabled: true
      all: false   # only sync referenced ConfigMaps
    secrets:
      enabled: true
      all: false   # only sync referenced Secrets
    endpoints:
      enabled: true
    ingresses:
      enabled: true
    networkPolicies:
      enabled: true
    serviceAccounts:
      enabled: false  # do NOT sync SAs — use virtual cluster SAs only
    storageClasses:
      enabled: false  # controlled via fromHost passthrough
    persistentVolumes:
      enabled: false  # managed by host CSI

  fromHost:
    # Pass host StorageClasses into virtual cluster (read-only view)
    storageClasses:
      enabled: true
    # Pass IngressClasses into virtual cluster
    ingressClasses:
      enabled: true
    # Do NOT expose host nodes — security boundary
    nodes:
      enabled: false
    events:
      enabled: true

# RBAC configuration
rbac:
  role:
    enabled: true
    extraRules:
      - apiGroups: [""]
        resources: ["pods/exec", "pods/portforward"]
        verbs: ["get", "create"]
  clusterRole:
    enabled: true

# Networking
networking:
  # Reuse host cluster DNS for pod resolution
  replicateServices:
    fromHost: []
    toHost: []

# Policies — enforce resource constraints on the virtual cluster itself
policies:
  resourceQuota:
    enabled: true
    quota:
      requests.cpu: "20"
      requests.memory: "40Gi"
      limits.cpu: "40"
      limits.memory: "80Gi"
      persistentvolumeclaims: "50"
      services.loadbalancers: "5"
      pods: "200"
  limitRange:
    enabled: true
    default:
      cpu: "500m"
      memory: "512Mi"
    defaultRequest:
      cpu: "100m"
      memory: "128Mi"
```

## Namespace Isolation and RBAC

### Host Cluster RBAC for the Syncer

The vCluster syncer ServiceAccount must have exactly the right permissions on the host cluster. The Helm chart creates these by default, but production teams often need to audit and tighten them.

```yaml
# Review what the syncer ServiceAccount can do
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: vcluster-team-a
  namespace: vcluster-team-a
rules:
# Minimal pod management in its own namespace
- apiGroups: [""]
  resources: ["pods", "pods/status", "pods/exec", "pods/portforward"]
  verbs: ["create", "delete", "patch", "update", "get", "list", "watch"]
# Service management
- apiGroups: [""]
  resources: ["services", "services/status", "endpoints"]
  verbs: ["create", "delete", "patch", "update", "get", "list", "watch"]
# PVC management
- apiGroups: [""]
  resources: ["persistentvolumeclaims", "persistentvolumeclaims/status"]
  verbs: ["create", "delete", "patch", "update", "get", "list", "watch"]
# ConfigMap and Secret sync
- apiGroups: [""]
  resources: ["configmaps", "secrets", "events"]
  verbs: ["create", "delete", "patch", "update", "get", "list", "watch"]
# Ingress management
- apiGroups: ["networking.k8s.io"]
  resources: ["ingresses", "ingresses/status", "networkpolicies"]
  verbs: ["create", "delete", "patch", "update", "get", "list", "watch"]
---
# ClusterRole — minimal read access to shared resources
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: vcluster-team-a-cluster
rules:
- apiGroups: [""]
  resources: ["nodes"]
  verbs: ["get", "list", "watch"]   # read-only node view for scheduling decisions
- apiGroups: ["storage.k8s.io"]
  resources: ["storageclasses", "csidrivers", "csinodes"]
  verbs: ["get", "list", "watch"]
- apiGroups: ["networking.k8s.io"]
  resources: ["ingressclasses"]
  verbs: ["get", "list", "watch"]
```

### Tenant RBAC Inside the Virtual Cluster

Inside the virtual cluster, tenants receive full admin access to their own namespaces. The platform team grants this via the virtual cluster's own API server.

```bash
# Connect to the virtual cluster
vcluster connect team-a-vcluster --namespace vcluster-team-a -- bash

# Now operating against virtual cluster API
kubectl create namespace app-production
kubectl create namespace app-staging

# Grant team-a developers admin over their namespaces
kubectl create rolebinding dev-admin \
  --clusterrole=admin \
  --group=team-a-developers \
  --namespace=app-production

kubectl create rolebinding dev-admin \
  --clusterrole=admin \
  --group=team-a-developers \
  --namespace=app-staging
```

### NetworkPolicy Isolation Between Virtual Clusters

Even though virtual cluster pods land in separate host namespaces, adding NetworkPolicy at the host level ensures pod-to-pod traffic cannot cross tenant boundaries.

```yaml
# Applied in host cluster — blocks cross-namespace traffic
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: vcluster-isolation
  namespace: vcluster-team-a
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  - Egress
  ingress:
  # Allow traffic only from within the same namespace (same vcluster)
  - from:
    - podSelector: {}
  # Allow traffic from ingress controller
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: ingress-nginx
  # Allow traffic from host DNS
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
    ports:
    - port: 53
      protocol: UDP
    - port: 53
      protocol: TCP
  egress:
  # Allow all egress (restrict further if needed)
  - {}
```

## Persistent Storage Configuration

### StorageClass Passthrough

The recommended pattern is to pass host StorageClasses into the virtual cluster read-only, then let tenants create PVCs that reference them. The syncer translates PVCs from the virtual namespace to the host namespace.

```yaml
# In vCluster values: expose host StorageClasses to virtual cluster
sync:
  fromHost:
    storageClasses:
      enabled: true

# Inside virtual cluster — tenant creates PVC using host StorageClass
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data
  namespace: app-production
spec:
  accessModes:
  - ReadWriteOnce
  storageClassName: fast-ssd    # references host cluster StorageClass
  resources:
    requests:
      storage: 50Gi
```

The syncer creates the following PVC on the host:

```yaml
# Created by syncer in host namespace vcluster-team-a
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data-x-app-production-x-team-a-vcluster
  namespace: vcluster-team-a
  labels:
    vcluster.loft.sh/object-name: postgres-data
    vcluster.loft.sh/object-namespace: app-production
spec:
  accessModes:
  - ReadWriteOnce
  storageClassName: fast-ssd
  resources:
    requests:
      storage: 50Gi
```

### Per-Tenant Storage Quotas

Apply ResourceQuota at the host namespace level to enforce storage limits independent of virtual cluster configuration.

```yaml
# Host namespace ResourceQuota
apiVersion: v1
kind: ResourceQuota
metadata:
  name: vcluster-team-a-storage
  namespace: vcluster-team-a
spec:
  hard:
    requests.storage: "500Gi"
    persistentvolumeclaims: "50"
    # Limit expensive storage class usage
    fast-ssd.storageclass.storage.k8s.io/requests.storage: "100Gi"
    fast-ssd.storageclass.storage.k8s.io/persistentvolumeclaims: "10"
    standard.storageclass.storage.k8s.io/requests.storage: "400Gi"
```

## Networking and Ingress

### Service Exposure Patterns

#### NodePort Services

NodePort services created in the virtual cluster are synced to the host namespace. The host assigns a port from its NodePort range, which the syncer reflects back.

```yaml
# Virtual cluster Service
apiVersion: v1
kind: Service
metadata:
  name: frontend
  namespace: app-production
spec:
  type: NodePort
  selector:
    app: frontend
  ports:
  - port: 80
    targetPort: 8080
    nodePort: 30080   # requested; host may reassign
```

#### LoadBalancer Services

LoadBalancer type works when the host cluster has MetalLB or a cloud load balancer controller.

```yaml
# vCluster values — allow LB services but cap the count
policies:
  resourceQuota:
    enabled: true
    quota:
      services.loadbalancers: "3"

# Virtual cluster Service
apiVersion: v1
kind: Service
metadata:
  name: api-gateway
  namespace: app-production
  annotations:
    service.beta.kubernetes.io/aws-load-balancer-type: "nlb"
spec:
  type: LoadBalancer
  selector:
    app: api-gateway
  ports:
  - port: 443
    targetPort: 8443
```

### Ingress Passthrough

vCluster can sync Ingress objects to the host cluster, where the shared ingress controller handles TLS termination and routing.

```yaml
# vCluster values — enable ingress sync
sync:
  toHost:
    ingresses:
      enabled: true

# Virtual cluster Ingress (tenant creates this)
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: app-ingress
  namespace: app-production
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - team-a-app.example.com
    secretName: team-a-tls
  rules:
  - host: team-a-app.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: frontend
            port:
              number: 80
```

The syncer rewrites the Ingress backend to point at the synced Service in the host namespace before pushing it to the host API server.

### CoreDNS Inside vCluster

Each virtual cluster runs its own CoreDNS instance. Configure it to forward to the host cluster DNS for external resolution.

```yaml
# Custom CoreDNS ConfigMap inside virtual cluster
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns
  namespace: kube-system
data:
  Corefile: |
    .:53 {
        errors
        health
        ready
        kubernetes cluster.local in-addr.arpa ip6.arpa {
          pods insecure
          fallthrough in-addr.arpa ip6.arpa
        }
        # Forward internal company DNS
        forward company.internal 10.96.0.10
        # Forward everything else to host cluster DNS
        forward . /etc/resolv.conf
        cache 30
        loop
        reload
        loadbalance
    }
```

## GitOps Integration

### ArgoCD Multi-vCluster Management

ArgoCD can manage both the vCluster lifecycle (via the host cluster) and application deployments inside virtual clusters.

```yaml
# ArgoCD Application — provision virtual cluster via Helm
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: vcluster-team-a
  namespace: argocd
spec:
  project: platform
  source:
    repoURL: https://charts.loft.sh
    chart: vcluster
    targetRevision: 0.20.0
    helm:
      releaseName: team-a-vcluster
      values: |
        controlPlane:
          distro:
            k3s:
              enabled: true
        sync:
          toHost:
            ingresses:
              enabled: true
            persistentVolumeClaims:
              enabled: true
        policies:
          resourceQuota:
            enabled: true
            quota:
              requests.cpu: "20"
              requests.memory: "40Gi"
              pods: "200"
  destination:
    server: https://kubernetes.default.svc
    namespace: vcluster-team-a
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
    - CreateNamespace=true
    - ServerSideApply=true
---
# ArgoCD Cluster Secret — register vCluster as a managed cluster
# (generate kubeconfig with: vcluster connect team-a-vcluster -n vcluster-team-a --print-kube-config)
apiVersion: v1
kind: Secret
metadata:
  name: vcluster-team-a-cluster
  namespace: argocd
  labels:
    argocd.argoproj.io/secret-type: cluster
type: Opaque
stringData:
  name: vcluster-team-a
  server: https://team-a-vcluster.vcluster-team-a.svc.cluster.local
  config: |
    {
      "bearerToken": "EXAMPLE_TOKEN_REPLACE_ME",
      "tlsClientConfig": {
        "insecure": false,
        "caData": "BASE64_ENCODED_CA_DATA_REPLACE_ME"
      }
    }
```

### ApplicationSet for Multi-Tenant GitOps

Use an ApplicationSet generator to create per-vCluster ArgoCD applications automatically.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: vcluster-tenant-apps
  namespace: argocd
spec:
  generators:
  - list:
      elements:
      - tenant: team-a
        cluster: https://team-a-vcluster.vcluster-team-a.svc.cluster.local
        cpuQuota: "20"
        memoryQuota: "40Gi"
      - tenant: team-b
        cluster: https://team-b-vcluster.vcluster-team-b.svc.cluster.local
        cpuQuota: "10"
        memoryQuota: "20Gi"
      - tenant: team-c
        cluster: https://team-c-vcluster.vcluster-team-c.svc.cluster.local
        cpuQuota: "30"
        memoryQuota: "60Gi"
  template:
    metadata:
      name: "vcluster-{{tenant}}"
      namespace: argocd
    spec:
      project: platform
      source:
        repoURL: https://charts.loft.sh
        chart: vcluster
        targetRevision: 0.20.0
        helm:
          releaseName: "{{tenant}}-vcluster"
          parameters:
          - name: policies.resourceQuota.quota.requests\.cpu
            value: "{{cpuQuota}}"
          - name: policies.resourceQuota.quota.requests\.memory
            value: "{{memoryQuota}}"
      destination:
        server: https://kubernetes.default.svc
        namespace: "vcluster-{{tenant}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
        - CreateNamespace=true
```

### Flux Integration

Flux's HelmRelease resource provides an equivalent GitOps workflow for vCluster lifecycle management.

```yaml
# flux-system/vcluster-team-b.yaml
apiVersion: source.toolkit.fluxcd.io/v1beta2
kind: HelmRepository
metadata:
  name: loft-sh
  namespace: flux-system
spec:
  interval: 1h
  url: https://charts.loft.sh
---
apiVersion: helm.toolkit.fluxcd.io/v2beta2
kind: HelmRelease
metadata:
  name: vcluster-team-b
  namespace: vcluster-team-b
spec:
  interval: 5m
  releaseName: team-b-vcluster
  chart:
    spec:
      chart: vcluster
      version: "0.20.x"
      sourceRef:
        kind: HelmRepository
        name: loft-sh
        namespace: flux-system
  values:
    controlPlane:
      distro:
        k3s:
          enabled: true
    policies:
      resourceQuota:
        enabled: true
        quota:
          requests.cpu: "10"
          requests.memory: "20Gi"
          pods: "100"
  upgrade:
    cleanupOnFail: true
    remediation:
      retries: 3
  rollback:
    timeout: 5m
    cleanupOnFail: true
```

## Host Cluster Resource Quotas

Enforce hard limits at the host namespace level to prevent a single virtual cluster from exhausting cluster-wide resources.

```yaml
# Comprehensive ResourceQuota for a vCluster host namespace
apiVersion: v1
kind: ResourceQuota
metadata:
  name: vcluster-hard-limits
  namespace: vcluster-team-a
spec:
  hard:
    # Compute
    requests.cpu: "20"
    limits.cpu: "40"
    requests.memory: "40Gi"
    limits.memory: "80Gi"
    # Workloads
    pods: "200"
    replicationcontrollers: "20"
    # Services
    services: "50"
    services.loadbalancers: "5"
    services.nodeports: "10"
    # Storage
    requests.storage: "500Gi"
    persistentvolumeclaims: "50"
    # Secrets and ConfigMaps
    secrets: "200"
    configmaps: "200"
---
# LimitRange ensures every pod has sensible defaults even if not set
apiVersion: v1
kind: LimitRange
metadata:
  name: vcluster-defaults
  namespace: vcluster-team-a
spec:
  limits:
  - type: Container
    default:
      cpu: "500m"
      memory: "512Mi"
    defaultRequest:
      cpu: "100m"
      memory: "128Mi"
    max:
      cpu: "8"
      memory: "16Gi"
    min:
      cpu: "10m"
      memory: "32Mi"
  - type: Pod
    max:
      cpu: "16"
      memory: "32Gi"
  - type: PersistentVolumeClaim
    max:
      storage: "100Gi"
    min:
      storage: "1Gi"
```

## Upgrade Strategies

### In-Place Version Upgrade

vCluster uses semver and supports in-place upgrades via Helm. Control plane version and the hosted Kubernetes version can be upgraded independently.

```bash
# Check current version
helm list -n vcluster-team-a

# Preview upgrade diff
helm diff upgrade team-a-vcluster loft-sh/vcluster \
  --namespace vcluster-team-a \
  --version 0.21.0 \
  --values vcluster-production-values.yaml

# Perform upgrade
helm upgrade team-a-vcluster loft-sh/vcluster \
  --namespace vcluster-team-a \
  --version 0.21.0 \
  --values vcluster-production-values.yaml \
  --wait \
  --timeout 10m
```

### Kubernetes Version Upgrade Inside vCluster

To upgrade the hosted Kubernetes version (e.g., k3s 1.29 → 1.30):

```yaml
# Update vcluster-values-k3s.yaml
controlPlane:
  distro:
    k3s:
      enabled: true
      image:
        repository: rancher/k3s
        tag: v1.30.2-k3s1   # was v1.29.4-k3s1
```

```bash
# Apply the version bump
helm upgrade team-a-vcluster loft-sh/vcluster \
  --namespace vcluster-team-a \
  --version 0.21.0 \
  --values vcluster-production-values.yaml \
  --wait

# Verify API server version inside vcluster
vcluster connect team-a-vcluster -n vcluster-team-a -- \
  kubectl version --short
```

### Data Backup Before Upgrade

For k3s (SQLite backing store), back up the SQLite database before any upgrade.

```bash
# Exec into the vcluster pod and dump SQLite
VCLUSTER_POD=$(kubectl get pod -n vcluster-team-a \
  -l app=vcluster -o jsonpath='{.items[0].metadata.name}')

kubectl exec -n vcluster-team-a "$VCLUSTER_POD" -- \
  sqlite3 /data/server/db/state.db ".backup '/tmp/state-backup.db'"

# Copy backup to local machine
kubectl cp "vcluster-team-a/$VCLUSTER_POD:/tmp/state-backup.db" \
  ./vcluster-team-a-backup-$(date +%Y%m%d).db
```

## Cost Optimisation

### Sleep Mode

vCluster Enterprise supports sleep mode: when a virtual cluster is idle, the syncer scales down all synced pods, freeing host compute resources while preserving state.

```yaml
# vcluster-values-sleepmode.yaml
# Available in vCluster Pro/Enterprise
sleepMode:
  enabled: true
  autoSleep:
    afterInactivity: "1h"    # sleep after 1 hour of no API calls
  autoWakeup:
    schedule: "0 8 * * 1-5"  # wake up at 08:00 Mon-Fri
```

### Right-Sizing the Control Plane

Monitor actual vCluster control plane resource usage before committing to limits.

```bash
# Check vcluster pod resource usage
kubectl top pod -n vcluster-team-a --containers

# For small dev clusters (< 50 pods), start with minimal resources
cat <<EOF
controlPlane:
  statefulSet:
    resources:
      requests:
        cpu: 50m
        memory: 128Mi
      limits:
        cpu: 500m
        memory: 512Mi
EOF
```

### Consolidating Development Environments

A cost modelling approach for 50 development teams:

```
Traditional approach: 50 clusters × (3 control plane nodes × $0.10/hr)
= $3,600/month in control plane compute alone

vCluster approach:
- 1 shared host cluster with 10-20 worker nodes
- 50 vClusters (each ~200m CPU / 256Mi memory at idle)
- Total vCluster overhead: 50 × 200m = 10 vCPU, 50 × 256Mi = 12.5Gi memory
- Estimated host cluster cost: ~$600/month for 20 c5.xlarge nodes
- Savings: ~83% vs dedicated clusters
```

## Monitoring and Observability

### Prometheus Metrics for vCluster

```yaml
# ServiceMonitor — scrape vCluster syncer metrics
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: vcluster-team-a-metrics
  namespace: vcluster-team-a
  labels:
    release: kube-prometheus-stack
spec:
  selector:
    matchLabels:
      app: vcluster
  namespaceSelector:
    matchNames:
    - vcluster-team-a
  endpoints:
  - port: metrics
    interval: 30s
    path: /metrics
```

### Key Metrics to Alert On

```yaml
# PrometheusRule for vCluster health
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: vcluster-alerts
  namespace: monitoring
spec:
  groups:
  - name: vcluster.rules
    rules:
    # Alert if syncer is failing to sync objects
    - alert: VClusterSyncErrors
      expr: |
        increase(vcluster_syncer_sync_errors_total[5m]) > 5
      for: 2m
      labels:
        severity: warning
      annotations:
        summary: "vCluster syncer errors detected"
        description: "{{ $labels.namespace }} is experiencing sync errors"

    # Alert if virtual cluster API server is unreachable
    - alert: VClusterAPIServerDown
      expr: |
        up{job="vcluster-metrics"} == 0
      for: 3m
      labels:
        severity: critical
      annotations:
        summary: "vCluster API server unreachable"
        description: "vCluster in {{ $labels.namespace }} is not responding"

    # Alert on resource quota exhaustion
    - alert: VClusterQuotaExhausted
      expr: |
        kube_resourcequota{resource="pods", type="used", namespace=~"vcluster-.*"}
        /
        kube_resourcequota{resource="pods", type="hard", namespace=~"vcluster-.*"}
        > 0.9
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "vCluster approaching pod quota limit"
        description: "{{ $labels.namespace }} is using >90% of its pod quota"
```

### Grafana Dashboard Query Examples

```promql
# Pods running per vCluster
sum by (namespace) (
  kube_pod_info{namespace=~"vcluster-.*"}
)

# CPU usage vs quota per vCluster
sum by (namespace) (
  kube_pod_container_resource_requests{
    resource="cpu",
    namespace=~"vcluster-.*"
  }
)
/
sum by (namespace) (
  kube_resourcequota{
    resource="requests.cpu",
    type="hard",
    namespace=~"vcluster-.*"
  }
)

# Memory usage ratio per vCluster
sum by (namespace) (
  container_memory_working_set_bytes{
    namespace=~"vcluster-.*",
    container!=""
  }
)
```

## Troubleshooting Common Issues

### Pods Stuck in Pending Inside Virtual Cluster

```bash
# Check pod status inside virtual cluster
vcluster connect team-a-vcluster -n vcluster-team-a -- \
  kubectl describe pod <pod-name> -n <namespace>

# Check if syncer has created corresponding host pod
kubectl get pods -n vcluster-team-a \
  | grep "x-<virtual-namespace>-x"

# Check syncer logs for errors
kubectl logs -n vcluster-team-a \
  -l app=vcluster \
  -c syncer \
  --tail=100 \
  | grep -i error
```

### PVC Not Binding

```bash
# Check PVC in virtual cluster
vcluster connect team-a-vcluster -n vcluster-team-a -- \
  kubectl describe pvc <pvc-name> -n <namespace>

# Check synced PVC in host namespace
kubectl get pvc -n vcluster-team-a \
  | grep "x-<virtual-namespace>-x"

# Check host-level StorageClass availability
kubectl get sc

# Verify StorageClass passthrough is enabled in vCluster values
# sync.fromHost.storageClasses.enabled must be true
```

### Ingress Not Routing

```bash
# Verify Ingress sync is enabled
# sync.toHost.ingresses.enabled must be true in values

# Check if Ingress appears in host namespace
kubectl get ingress -n vcluster-team-a

# Check that IngressClass exists in host cluster
kubectl get ingressclass

# Verify the IngressClass is visible inside virtual cluster
vcluster connect team-a-vcluster -n vcluster-team-a -- \
  kubectl get ingressclass
```

### Syncer Stuck / High Error Rate

```bash
# Describe the vCluster StatefulSet
kubectl describe statefulset -n vcluster-team-a team-a-vcluster

# Get full syncer logs
kubectl logs -n vcluster-team-a \
  -l app=vcluster \
  -c syncer \
  --since=1h \
  | grep -E "(ERROR|WARN|panic)"

# Check if host namespace ResourceQuota is exhausted
kubectl describe resourcequota -n vcluster-team-a
```

## Security Hardening Checklist

```yaml
# Security hardening checklist for production vCluster deployments

# 1. Isolate host namespaces with NetworkPolicy
# 2. Restrict syncer ServiceAccount to minimal permissions
# 3. Do NOT sync host nodes into virtual cluster
# 4. Enable Pod Security Standards on host namespace
# 5. Use OPA/Gatekeeper on host to enforce policies on synced pods
# 6. Enable audit logging in the virtual API server
# 7. Rotate vCluster kubeconfig tokens regularly
# 8. Use ExternalSecret / Vault to manage vCluster connection credentials
# 9. Enable ResourceQuota and LimitRange on host namespace
# 10. Monitor syncer metrics and alert on error spikes

# Apply Pod Security Standards to host namespace
kubectl label namespace vcluster-team-a \
  pod-security.kubernetes.io/enforce=restricted \
  pod-security.kubernetes.io/enforce-version=latest \
  pod-security.kubernetes.io/warn=restricted \
  pod-security.kubernetes.io/audit=restricted

# Note: the vCluster StatefulSet itself may need privileged PSS
# for some distro modes — use baseline if restricted causes issues
kubectl label namespace vcluster-team-a \
  pod-security.kubernetes.io/enforce=baseline \
  --overwrite
```

## Operational Runbook Summary

```bash
# Create a new vCluster for a team
helm upgrade --install "${TEAM}-vcluster" loft-sh/vcluster \
  --namespace "vcluster-${TEAM}" \
  --create-namespace \
  --version 0.20.0 \
  --values vcluster-production-values.yaml \
  --wait

# Connect to a vCluster
vcluster connect "${TEAM}-vcluster" --namespace "vcluster-${TEAM}"

# Pause a vCluster (scale control plane to 0)
kubectl scale statefulset "${TEAM}-vcluster" \
  --namespace "vcluster-${TEAM}" \
  --replicas=0

# Resume a vCluster
kubectl scale statefulset "${TEAM}-vcluster" \
  --namespace "vcluster-${TEAM}" \
  --replicas=1

# Delete a vCluster and all its resources
helm uninstall "${TEAM}-vcluster" --namespace "vcluster-${TEAM}"
kubectl delete namespace "vcluster-${TEAM}"

# List all virtual clusters across the host cluster
kubectl get statefulsets -A \
  -l app=vcluster \
  -o custom-columns='NAMESPACE:.metadata.namespace,NAME:.metadata.name,READY:.status.readyReplicas'
```

vCluster provides a production-grade solution for hard multi-tenancy that balances isolation with operational efficiency. The syncer architecture ensures tenants interact with real Kubernetes APIs while the host cluster retains full control over compute, storage, and networking resources. With GitOps integration via ArgoCD or Flux, platform teams can manage hundreds of virtual clusters as code, applying uniform security policies and resource governance across the entire fleet.
