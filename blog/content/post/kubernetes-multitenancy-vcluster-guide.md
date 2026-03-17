---
title: "vCluster: Virtual Kubernetes Clusters for Multi-Tenancy"
date: 2027-11-11T00:00:00-05:00
draft: false
tags: ["vCluster", "Multi-Tenancy", "Kubernetes", "Isolation", "Platform Engineering"]
categories:
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to vCluster for Kubernetes multi-tenancy, covering architecture, Helm deployment, namespace isolation, resource syncing, networking, storage, and use cases for dev environments, CI/CD, and tenant isolation."
more_link: "yes"
url: "/kubernetes-multitenancy-vcluster-guide/"
---

Multi-tenancy in Kubernetes has always involved a tension between isolation and resource efficiency. Namespace-based multi-tenancy provides weak isolation, while provisioning full clusters for each tenant creates operational overhead and increases costs. vCluster occupies the middle ground: virtual Kubernetes clusters that run as pods inside a host cluster, providing strong API isolation without the cost of dedicated control planes.

This guide covers vCluster architecture, Helm-based deployment, isolation mechanisms, resource syncing behavior, networking, storage provisioning, and practical use cases for development environments, CI/CD isolation, and tenant segregation.

<!--more-->

# vCluster: Virtual Kubernetes Clusters for Multi-Tenancy

## Architecture Overview

vCluster creates a fully functional Kubernetes control plane (API server, controller manager, etcd or SQLite) running as pods inside a namespace in a host cluster. The vCluster syncer component translates resource requests from the virtual cluster to the host cluster.

```
┌──────────────────────────────────────────────────────────────┐
│  Host Cluster                                                │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  Namespace: team-alpha-vcluster                        │ │
│  │                                                        │ │
│  │  ┌──────────────────────────────────────────────────┐ │ │
│  │  │  vCluster Control Plane Pod                      │ │ │
│  │  │  ┌────────────┐ ┌──────────────┐ ┌───────────┐  │ │ │
│  │  │  │ API Server │ │  Controller  │ │   etcd /  │  │ │ │
│  │  │  │            │ │   Manager    │ │  SQLite   │  │ │ │
│  │  │  └────────────┘ └──────────────┘ └───────────┘  │ │ │
│  │  └──────────────────────────────────────────────────┘ │ │
│  │                                                        │ │
│  │  ┌──────────────────────────────────────────────────┐ │ │
│  │  │  vCluster Syncer                                 │ │ │
│  │  │  - Translates vCluster resources to host pods    │ │ │
│  │  │  - Syncs namespaces, configmaps, secrets         │ │ │
│  │  │  - Manages PVC/PV lifecycle                      │ │ │
│  │  └──────────────────────────────────────────────────┘ │ │
│  │                                                        │ │
│  │  ┌────────────────────────────────────────────────┐   │ │
│  │  │  Synced pods (running in host cluster)          │   │ │
│  │  │  team-alpha--nginx-xxx  team-alpha--api-yyy     │   │ │
│  │  └────────────────────────────────────────────────┘   │ │
│  └────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘

Virtual Cluster (tenant's view):
  - Independent API server with separate RBAC
  - Own namespace "default", "kube-system"
  - Full cluster-admin access for tenant
  - Resources appear as standard Kubernetes objects
```

## Installation Methods

### CLI Installation

```bash
# Install vCluster CLI
curl -L -o vcluster "https://github.com/loft-sh/vcluster/releases/latest/download/vcluster-linux-amd64"
chmod +x vcluster
sudo mv vcluster /usr/local/bin/

# Create a basic vCluster
vcluster create team-alpha \
  --namespace team-alpha-vcluster \
  --connect=false

# Connect to the vCluster
vcluster connect team-alpha --namespace team-alpha-vcluster

# Your kubectl now points to the virtual cluster
kubectl get nodes
kubectl get namespaces
```

### Helm-Based Production Deployment

```yaml
# vcluster-values.yaml
vcluster:
  image: ghcr.io/loft-sh/vcluster:0.20.0

sync:
  nodes:
    enabled: true
    syncAllNodes: false
    nodeSelector: ""
    enableScheduler: false
    clearImageStatus: false
  persistentvolumes:
    enabled: true
  persistentvolumeclaims:
    enabled: true
  storageClasses:
    enabled: false
    syncBackwards:
      enabled: false
  hoststorageclasses:
    enabled: true
  ingresses:
    enabled: true
  endpoints:
    enabled: true
  networkpolicies:
    enabled: false
  poddisruptionbudgets:
    enabled: false
  serviceaccounts:
    enabled: false
  configmaps:
    enabled: true
    all: false
  secrets:
    enabled: true
    all: false

controlPlane:
  distro:
    k8s:
      enabled: true
      apiServer:
        image:
          tag: "v1.31.0"
        extraArgs:
        - "--audit-log-maxage=7"
        - "--audit-log-maxbackup=3"
        - "--audit-log-maxsize=100"
        resources:
          requests:
            cpu: 200m
            memory: 256Mi
          limits:
            cpu: 1000m
            memory: 2Gi
      controllerManager:
        image:
          tag: "v1.31.0"
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 512Mi
  backingStore:
    etcd:
      deploy:
        enabled: true
        statefulSet:
          highAvailability:
            replicas: 3
          resources:
            requests:
              cpu: 100m
              memory: 256Mi
            limits:
              cpu: 500m
              memory: 1Gi
          persistence:
            volumeClaimTemplate:
              accessModes:
              - ReadWriteOnce
              storageClassName: gp3
              storage: 5Gi

  statefulSet:
    resources:
      requests:
        cpu: 200m
        memory: 256Mi
      limits:
        cpu: 2000m
        memory: 4Gi
    scheduling:
      podManagementPolicy: OrderedReady
      priorityClassName: system-cluster-critical
    highAvailability:
      replicas: 1

networking:
  advanced:
    clusterDomain: cluster.local

rbac:
  role:
    enabled: true
    extraRules: []
  clusterRole:
    enabled: true
    extraRules: []

policies:
  resourceQuota:
    enabled: true
    quota:
      requests.cpu: "10"
      requests.memory: "20Gi"
      limits.cpu: "20"
      limits.memory: "40Gi"
      count/pods: "100"
      count/services: "50"
      count/persistentvolumeclaims: "20"
      requests.storage: "200Gi"

  limitRange:
    enabled: true
    default:
      cpu: "1"
      memory: "512Mi"
    defaultRequest:
      cpu: "100m"
      memory: "128Mi"
    max:
      cpu: "4"
      memory: "8Gi"

  networkPolicy:
    enabled: true
    outgoingConnections:
      ipBlock:
        cidr: "0.0.0.0/0"
        except:
        - "169.254.0.0/16"
        - "10.0.0.0/8"

isolationMode:
  enabled: false

telemetry:
  enabled: false
```

```bash
# Deploy vCluster with Helm
helm repo add loft-sh https://charts.loft.sh
helm repo update

helm install team-alpha-vcluster loft-sh/vcluster \
  --namespace team-alpha-vcluster \
  --create-namespace \
  --values vcluster-values.yaml
```

## Resource Syncing Deep Dive

### What Gets Synced

vCluster uses a syncer to translate virtual resources to host resources. Understanding sync behavior is critical for production deployments.

**Synced from virtual to host** (virtual resources become host resources):
- Pods (renamed to `<namespace>--<pod-name>-<vcluster-suffix>`)
- Services (type: ClusterIP, NodePort, LoadBalancer)
- Endpoints
- ConfigMaps (if configured)
- Secrets (if configured)
- PersistentVolumeClaims
- Ingresses

**Synced from host to virtual** (host resources appear in virtual cluster):
- Nodes (virtual nodes representing host nodes)
- PersistentVolumes
- StorageClasses (host storage classes)
- Node resource information

**Not synced** (virtual only):
- Namespaces
- RBAC resources (Roles, RoleBindings, ClusterRoles, ClusterRoleBindings)
- ServiceAccounts
- NetworkPolicies (virtual)
- CustomResourceDefinitions

### Configuring Sync Behavior

```yaml
# Advanced sync configuration
sync:
  configmaps:
    enabled: true
    all: false  # Only sync configmaps used by pods
  secrets:
    enabled: true
    all: false  # Only sync secrets used by pods
  pods:
    enabled: true
    ephemeralContainers: false
    status: true
    injectBusybox: false
    hostpathMapper:
      enabled: false
    translateImage:
      enabled: false
    rewriteHosts:
      enabled: true
      initContainerImage: "ghcr.io/loft-sh/vcluster:0.20.0"
  services:
    enabled: true
    syncServiceSelector: true
  ingresses:
    enabled: true
    pathMapping:
      enabled: false
```

### Multi-Namespace Mode

By default, vCluster syncs all virtual namespaces to a single host namespace. Multi-namespace mode maps each virtual namespace to a host namespace:

```yaml
# Enable multi-namespace mode
multiNamespaceMode:
  enabled: true

# With this enabled:
# Virtual: default namespace -> Host: team-alpha-vcluster-default
# Virtual: production namespace -> Host: team-alpha-vcluster-production
```

## Networking Configuration

### Service Access Between vClusters

By default, vCluster services are isolated. To enable cross-vCluster communication:

```yaml
networking:
  replicateServices:
    toHost:
    - from: default/frontend
      to: team-alpha-vcluster/frontend
    fromHost:
    - from: shared-services/database
      to: default/database
```

### Exposing vCluster API Server

```yaml
# Expose via LoadBalancer
controlPlane:
  service:
    spec:
      type: LoadBalancer
    annotations:
      service.beta.kubernetes.io/aws-load-balancer-type: "nlb"
      service.beta.kubernetes.io/aws-load-balancer-internal: "true"

# Or via Ingress
controlPlane:
  ingress:
    enabled: true
    ingressClassName: nginx
    host: team-alpha.vcluster.company.internal
    annotations:
      nginx.ingress.kubernetes.io/backend-protocol: HTTPS
      nginx.ingress.kubernetes.io/ssl-passthrough: "true"
      cert-manager.io/cluster-issuer: internal-ca
```

### vCluster with Cilium Network Policies

```yaml
# Apply host-level network policy to restrict vCluster namespace
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: vcluster-network-isolation
  namespace: team-alpha-vcluster
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  - Egress
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: team-alpha-vcluster
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
    ports:
    - port: 443
      protocol: TCP
  egress:
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: team-alpha-vcluster
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
    ports:
    - port: 53
      protocol: UDP
  - to:
    - ipBlock:
        cidr: 0.0.0.0/0
        except:
        - 10.0.0.0/8
        - 172.16.0.0/12
        - 192.168.0.0/16
    ports:
    - port: 443
      protocol: TCP
```

## Storage Configuration

### Using Host Storage Classes

```yaml
# Map host StorageClasses to virtual cluster
sync:
  hoststorageclasses:
    enabled: true

# Tenants can use host storage classes by name:
# storageClassName: gp3 (maps to host gp3 class)
```

### Storage Quota Enforcement

```yaml
# PVC quota via ResourceQuota in virtual cluster
apiVersion: v1
kind: ResourceQuota
metadata:
  name: storage-quota
  namespace: default
spec:
  hard:
    requests.storage: "100Gi"
    persistentvolumeclaims: "10"
    standard.storageclass.storage.k8s.io/requests.storage: "50Gi"
    gp3.storageclass.storage.k8s.io/requests.storage: "50Gi"
```

## Use Case: Development Environment Vending

### GitOps-Driven vCluster Provisioning

```yaml
# argocd-vcluster-appset.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: dev-vclusters
  namespace: argocd
spec:
  generators:
  - list:
      elements:
      - team: payments
        quota_cpu: "8"
        quota_memory: "16Gi"
        quota_pods: "50"
      - team: checkout
        quota_cpu: "4"
        quota_memory: "8Gi"
        quota_pods: "30"
      - team: auth
        quota_cpu: "4"
        quota_memory: "8Gi"
        quota_pods: "30"
  template:
    metadata:
      name: "dev-vcluster-{{team}}"
      namespace: argocd
    spec:
      project: platform
      source:
        repoURL: https://charts.loft.sh
        chart: vcluster
        targetRevision: "0.20.0"
        helm:
          values: |
            controlPlane:
              distro:
                k8s:
                  enabled: true
                  apiServer:
                    image:
                      tag: "v1.31.0"
            policies:
              resourceQuota:
                enabled: true
                quota:
                  requests.cpu: "{{quota_cpu}}"
                  requests.memory: "{{quota_memory}}"
                  count/pods: "{{quota_pods}}"
            telemetry:
              enabled: false
      destination:
        server: https://kubernetes.default.svc
        namespace: "dev-{{team}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
        - CreateNamespace=true
```

### Ephemeral PR Environment vClusters

```yaml
# Tekton pipeline for PR environment
apiVersion: tekton.dev/v1
kind: Pipeline
metadata:
  name: pr-environment
  namespace: ci
spec:
  params:
  - name: pr-number
    type: string
  - name: git-sha
    type: string
  - name: team
    type: string
  tasks:
  - name: create-vcluster
    taskRef:
      name: vcluster-create
    params:
    - name: name
      value: "pr-$(params.pr-number)"
    - name: namespace
      value: "pr-$(params.team)-$(params.pr-number)"
    - name: ttl
      value: "24h"
  - name: deploy-app
    runAfter: [create-vcluster]
    taskRef:
      name: helm-deploy
    params:
    - name: kubeconfig
      value: "$(tasks.create-vcluster.results.kubeconfig)"
    - name: git-sha
      value: "$(params.git-sha)"
  - name: run-integration-tests
    runAfter: [deploy-app]
    taskRef:
      name: run-tests
  finally:
  - name: cleanup-vcluster
    taskRef:
      name: vcluster-delete
    params:
    - name: name
      value: "pr-$(params.pr-number)"
    - name: namespace
      value: "pr-$(params.team)-$(params.pr-number)"
```

## Use Case: CI/CD Isolation

### Per-Pipeline vCluster

```yaml
# GitHub Actions workflow with isolated vCluster
apiVersion: v1
kind: ConfigMap
metadata:
  name: ci-vcluster-template
  namespace: ci-system
data:
  values.yaml: |
    controlPlane:
      distro:
        k8s:
          enabled: true
          apiServer:
            image:
              tag: "v1.31.0"
    policies:
      resourceQuota:
        enabled: true
        quota:
          requests.cpu: "4"
          requests.memory: "8Gi"
          count/pods: "20"
    sync:
      persistentvolumeclaims:
        enabled: true
      hoststorageclasses:
        enabled: true
    telemetry:
      enabled: false
```

```bash
#!/bin/bash
# create-ci-vcluster.sh
# Creates an isolated vCluster for a CI job and prints kubeconfig

JOB_ID=$1
NAMESPACE="ci-${JOB_ID}"
CLUSTER_NAME="ci-${JOB_ID}"

# Create namespace
kubectl create namespace "$NAMESPACE"

# Apply resource limits at namespace level
kubectl apply -f - <<EOF
apiVersion: v1
kind: ResourceQuota
metadata:
  name: ci-quota
  namespace: $NAMESPACE
spec:
  hard:
    requests.cpu: "4"
    requests.memory: "8Gi"
    count/pods: "20"
EOF

# Deploy vCluster
helm install "$CLUSTER_NAME" loft-sh/vcluster \
  --namespace "$NAMESPACE" \
  --values /etc/ci/vcluster-template.yaml \
  --wait \
  --timeout 120s

# Get kubeconfig
vcluster connect "$CLUSTER_NAME" \
  --namespace "$NAMESPACE" \
  --update-current=false \
  --kube-config-context-name "$CLUSTER_NAME" \
  --print > /tmp/kubeconfig-${JOB_ID}.yaml

echo "KUBECONFIG=/tmp/kubeconfig-${JOB_ID}.yaml"
```

## Use Case: Tenant Isolation

### Multi-Tenant Platform Configuration

```yaml
# tenant-vcluster-template.yaml
# Used by Platform Engineering team to provision tenant clusters

controlPlane:
  distro:
    k8s:
      enabled: true
      apiServer:
        image:
          tag: "v1.31.0"
        extraArgs:
        - "--audit-log-path=/audit/audit.log"
        - "--audit-log-maxage=7"
        - "--audit-policy-file=/audit/policy.yaml"

sync:
  nodes:
    enabled: true
  persistentvolumes:
    enabled: true
  persistentvolumeclaims:
    enabled: true
  ingresses:
    enabled: true
  hoststorageclasses:
    enabled: true

policies:
  limitRange:
    enabled: true
    default:
      cpu: "500m"
      memory: "256Mi"
    defaultRequest:
      cpu: "100m"
      memory: "128Mi"

  networkPolicy:
    enabled: true

multiNamespaceMode:
  enabled: false

telemetry:
  enabled: false
```

### Tenant Onboarding Operator

```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: tenantclusters.platform.company.com
spec:
  group: platform.company.com
  versions:
  - name: v1
    served: true
    storage: true
    schema:
      openAPIV3Schema:
        type: object
        properties:
          spec:
            type: object
            properties:
              tenantName:
                type: string
              teamEmail:
                type: string
              resourceQuota:
                type: object
                properties:
                  cpu:
                    type: string
                  memory:
                    type: string
                  pods:
                    type: integer
              allowedNamespaces:
                type: array
                items:
                  type: string
          status:
            type: object
            properties:
              phase:
                type: string
              kubeconfigSecretName:
                type: string
              clusterEndpoint:
                type: string
  scope: Cluster
  names:
    plural: tenantclusters
    singular: tenantcluster
    kind: TenantCluster
```

## Resource Management

### Node Affinity and Resource Scheduling

```yaml
# Pin vCluster control plane to specific nodes
controlPlane:
  statefulSet:
    scheduling:
      nodeSelector:
        node-role: platform
      tolerations:
      - key: node-role
        operator: Equal
        value: platform
        effect: NoSchedule
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            - matchExpressions:
              - key: kubernetes.io/arch
                operator: In
                values:
                - amd64
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchLabels:
                  app: vcluster
              topologyKey: kubernetes.io/hostname
```

### Monitoring vCluster Resource Usage

```bash
# Check resource consumption per vCluster namespace
kubectl top pods -A --sort-by=memory | grep "vcluster"

# Check PVC usage per vCluster
kubectl get pvc -A | grep "vcluster"

# Monitor with Prometheus
# vCluster exposes metrics at port 8443 by default
kubectl port-forward -n team-alpha-vcluster \
  statefulset/team-alpha-vcluster 8443:8443 &
curl -sk https://localhost:8443/metrics | grep vcluster_
```

### Resource Efficiency Recommendations

```bash
# For development/ephemeral vClusters, use SQLite instead of etcd
helm install dev-vcluster loft-sh/vcluster \
  --namespace dev-team \
  --set controlPlane.backingStore.embeddedDatabase.embedded.enabled=true \
  --set controlPlane.distro.k3s.enabled=true  # Use k3s for lighter footprint

# k3s-based vCluster reduces control plane memory by ~60%
# SQLite eliminates the etcd StatefulSet
```

## Comparison with Full Cluster Provisioning

| Factor | vCluster | Dedicated Cluster (EKS/GKE) |
|--------|----------|------------------------------|
| Provisioning time | 30-60 seconds | 15-30 minutes |
| Control plane cost | Minimal (pods) | $70-200/month |
| Isolation level | API isolation, shared kernel | Full isolation |
| Kubernetes version flexibility | Limited to host compat | Full flexibility |
| Network isolation | Via NetworkPolicy | VPC-level |
| Burst capacity | Host cluster limits | Independent limits |
| GitOps management | Standard Helm/ArgoCD | Cluster API / Terraform |

## Security Considerations

### Admission Webhook Configuration

```yaml
# Prevent privilege escalation from vCluster workloads
apiVersion: v1
kind: LimitRange
metadata:
  name: security-limits
  namespace: team-alpha-vcluster
spec:
  limits:
  - type: Container
    defaultRequest:
      cpu: "100m"
      memory: "128Mi"
    max:
      cpu: "8"
      memory: "16Gi"
---
apiVersion: policy/v1beta1
kind: PodSecurityPolicy
metadata:
  name: vcluster-restricted
spec:
  privileged: false
  allowPrivilegeEscalation: false
  requiredDropCapabilities:
  - ALL
  volumes:
  - configMap
  - emptyDir
  - projected
  - secret
  - downwardAPI
  - persistentVolumeClaim
  hostNetwork: false
  hostIPC: false
  hostPID: false
  runAsUser:
    rule: MustRunAsNonRoot
  seLinux:
    rule: RunAsAny
  fsGroup:
    rule: RunAsAny
```

### Preventing Host Resource Abuse

```yaml
# Resource quota on the host namespace prevents runaway vClusters
apiVersion: v1
kind: ResourceQuota
metadata:
  name: vcluster-host-limits
  namespace: team-alpha-vcluster
spec:
  hard:
    requests.cpu: "20"
    requests.memory: "40Gi"
    limits.cpu: "40"
    limits.memory: "80Gi"
    count/pods: "200"
    requests.storage: "500Gi"
    persistentvolumeclaims: "50"
```

## Operational Runbooks

### vCluster Health Check

```bash
#!/bin/bash
# vcluster-health-check.sh

NAMESPACE=$1
CLUSTER_NAME=$2

echo "=== vCluster Health Report: $NAMESPACE/$CLUSTER_NAME ==="
echo ""

echo "--- Control Plane Status ---"
kubectl get pods -n "$NAMESPACE" -l "app=vcluster" -o wide

echo ""
echo "--- etcd Cluster Health ---"
kubectl exec -n "$NAMESPACE" \
  statefulset/${CLUSTER_NAME}-etcd -- \
  etcdctl endpoint health --cluster 2>/dev/null || \
  echo "etcd check skipped (using embedded database)"

echo ""
echo "--- Virtual API Server Health ---"
vcluster connect "$CLUSTER_NAME" --namespace "$NAMESPACE" -- \
  kubectl get --raw /healthz 2>/dev/null || echo "Could not connect to virtual API server"

echo ""
echo "--- Synced Resources ---"
vcluster connect "$CLUSTER_NAME" --namespace "$NAMESPACE" -- \
  kubectl get pods -A 2>/dev/null | head -20

echo ""
echo "--- Host Namespace Resource Usage ---"
kubectl top pods -n "$NAMESPACE" 2>/dev/null
```

### Upgrade Procedure

```bash
#!/bin/bash
# upgrade-vcluster.sh

NAMESPACE=$1
CLUSTER_NAME=$2
NEW_VERSION=${3:-"0.20.0"}

echo "Upgrading vCluster $NAMESPACE/$CLUSTER_NAME to $NEW_VERSION"

# Backup etcd snapshot first
kubectl exec -n "$NAMESPACE" \
  statefulset/${CLUSTER_NAME}-etcd-0 -- \
  etcdctl snapshot save /tmp/pre-upgrade-snapshot.db 2>/dev/null

kubectl cp \
  "$NAMESPACE/${CLUSTER_NAME}-etcd-0:/tmp/pre-upgrade-snapshot.db" \
  "backup-pre-upgrade-$(date +%Y%m%d).db" 2>/dev/null || \
  echo "Backup skipped (no etcd)"

# Helm upgrade
helm upgrade "$CLUSTER_NAME" loft-sh/vcluster \
  --namespace "$NAMESPACE" \
  --version "$NEW_VERSION" \
  --reuse-values \
  --wait \
  --timeout 300s

# Verify
kubectl rollout status statefulset/"$CLUSTER_NAME" \
  -n "$NAMESPACE" --timeout=120s

echo "Upgrade complete"
vcluster connect "$CLUSTER_NAME" --namespace "$NAMESPACE" -- \
  kubectl version
```

## Summary

vCluster provides a pragmatic solution to the Kubernetes multi-tenancy problem by providing full API isolation at a fraction of the cost of dedicated clusters.

**Architecture**: The virtual API server, controller manager, and etcd run as pods in a host namespace. The syncer translates virtual resources to host resources, maintaining the illusion of a full cluster for tenant users.

**Use cases**: Development environments benefit most from vCluster's 30-60 second provisioning time. CI/CD isolation prevents test workloads from interfering with each other. Tenant isolation provides cluster-admin-level access to teams without cluster-level blast radius.

**Isolation**: vCluster provides strong API isolation but workloads share the host kernel and node resources. For true workload isolation, combine vCluster with dedicated node pools and NetworkPolicies.

**Cost**: A k3s-based vCluster with embedded SQLite consumes roughly 100-200m CPU and 256-512Mi memory for the control plane. For 10 teams on a shared cluster, this costs significantly less than 10 dedicated cluster control planes.

**Operations**: Use ArgoCD ApplicationSets or Crossplane for GitOps-driven vCluster provisioning. The Tekton pipeline pattern enables self-service environment creation for development teams.

The primary trade-off is isolation depth: vCluster is appropriate when team-level API access isolation is sufficient, but should not be used when regulatory requirements mandate physical infrastructure isolation.
