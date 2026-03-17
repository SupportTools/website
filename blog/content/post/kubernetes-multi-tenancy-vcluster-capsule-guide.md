---
title: "Kubernetes Multi-Tenancy: vCluster and Capsule for Tenant Isolation"
date: 2028-09-30T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Multi-Tenancy", "vCluster", "Capsule", "Security"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Kubernetes multi-tenancy covering namespace-based vs virtual cluster approaches, vCluster deployment and networking, Capsule tenant policies with NetworkPolicy and ResourceQuota automation, hierarchical namespaces with HNC, and operational patterns for SaaS providers on shared clusters."
more_link: "yes"
url: "/kubernetes-multi-tenancy-vcluster-capsule-guide/"
---

Running multiple teams or customers on a shared Kubernetes cluster reduces operational overhead and infrastructure costs, but introduces isolation challenges. Namespace-based multi-tenancy provides soft boundaries enforced by RBAC and NetworkPolicy. Virtual clusters (vCluster) provide strong isolation by giving each tenant their own Kubernetes control plane running inside the host cluster. Capsule sits between these extremes, automating namespace-level isolation policies at scale.

This guide covers the architecture and operational patterns for each approach, with complete configuration examples.

<!--more-->

# Kubernetes Multi-Tenancy: vCluster and Capsule for Tenant Isolation

## Multi-Tenancy Approaches Compared

| Approach | Isolation Strength | Operational Overhead | Cost | Best For |
|----------|-------------------|---------------------|------|----------|
| Namespaces + RBAC | Soft (policy-based) | Low | Low | Single org, trusted teams |
| Capsule | Medium (automated policies) | Low-Medium | Low | SaaS, multiple teams, enforced quotas |
| vCluster | Strong (separate control plane) | Medium | Medium | Untrusted tenants, custom API servers |
| Separate clusters | Strongest | High | High | Compliance, critical isolation |

## Namespace-Based Multi-Tenancy Baseline

Even with Capsule or vCluster, understanding namespace-based isolation is essential.

### RBAC for Namespace Tenants

```yaml
# namespace-rbac.yaml
# Create a namespace for the tenant
apiVersion: v1
kind: Namespace
metadata:
  name: tenant-alpha
  labels:
    tenant: alpha
    environment: production

---
# ServiceAccount for the tenant's CI/CD system
apiVersion: v1
kind: ServiceAccount
metadata:
  name: tenant-alpha-deployer
  namespace: tenant-alpha

---
# Role: what the tenant can do in their namespace
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: tenant-admin
  namespace: tenant-alpha
rules:
  - apiGroups: ["", "apps", "autoscaling", "batch"]
    resources:
      - deployments
      - replicasets
      - pods
      - pods/log
      - pods/exec
      - services
      - endpoints
      - configmaps
      - horizontalpodautoscalers
      - jobs
      - cronjobs
    verbs: ["*"]
  # Can view secrets but not create/delete
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get", "list", "watch"]
  # Cannot modify NetworkPolicies or ResourceQuotas (cluster admin does that)
  - apiGroups: ["networking.k8s.io"]
    resources: ["ingresses"]
    verbs: ["*"]

---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: tenant-alpha-admin
  namespace: tenant-alpha
subjects:
  - kind: ServiceAccount
    name: tenant-alpha-deployer
    namespace: tenant-alpha
  - kind: Group
    name: tenant-alpha-developers
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: Role
  name: tenant-admin
  apiGroup: rbac.authorization.k8s.io
```

```yaml
# tenant-network-policy.yaml
# Default deny all ingress/egress
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: tenant-alpha
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress

---
# Allow intra-namespace communication
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-intra-namespace
  namespace: tenant-alpha
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              tenant: alpha
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              tenant: alpha

---
# Allow DNS resolution
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns
  namespace: tenant-alpha
spec:
  podSelector: {}
  policyTypes:
    - Egress
  egress:
    - ports:
        - port: 53
          protocol: UDP
        - port: 53
          protocol: TCP

---
# Allow egress to the internet (restricted to HTTPS)
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-internet-egress
  namespace: tenant-alpha
spec:
  podSelector:
    matchLabels:
      allow-internet: "true"
  policyTypes:
    - Egress
  egress:
    - ports:
        - port: 443
          protocol: TCP
```

## Capsule for Automated Namespace Isolation

Capsule introduces the `Tenant` CRD. A Tenant owns one or more namespaces and automatically propagates NetworkPolicy, LimitRange, ResourceQuota, and other policies to every namespace in the tenant.

### Installing Capsule

```bash
helm repo add projectcapsule https://projectcapsule.dev/charts
helm repo update

helm install capsule projectcapsule/capsule \
  --namespace capsule-system \
  --create-namespace \
  --version 0.7.0 \
  --set manager.options.forceTenantPrefix=true \
  --set manager.options.protectedNamespaceRegex="kube-.*|capsule-.*|monitoring|logging|ingress-nginx" \
  --set manager.options.allowTenantIngressHostnamesCollision=false

# Verify installation
kubectl get pods -n capsule-system
kubectl get crd | grep capsule
```

### Defining a Tenant

```yaml
# tenant-alpha.yaml
apiVersion: capsule.clastix.io/v1beta2
kind: Tenant
metadata:
  name: alpha
spec:
  owners:
    # Users who can create namespaces in this tenant
    - name: alice
      kind: User
    - name: team-alpha
      kind: Group
    - name: tenant-alpha-admin
      kind: ServiceAccount
      namespace: capsule-system

  # Tenants can create namespaces with this prefix
  namespaceOptions:
    quota: 10           # Max 10 namespaces
    additionalMetadata:
      labels:
        tenant: alpha
        cost-center: CC-1234
        environment-tier: production
      annotations:
        contact: team-alpha@example.com

  # Resource quotas applied to ALL tenant namespaces automatically
  resourceQuotas:
    scope: Tenant  # Tenant: total across all namespaces; Namespace: per-namespace
    items:
      - hard:
          requests.cpu: "20"
          requests.memory: 40Gi
          limits.cpu: "40"
          limits.memory: 80Gi
          pods: "200"
          services: "50"
          persistentvolumeclaims: "30"
          requests.storage: 500Gi

  # LimitRange applied to all tenant namespaces
  limitRanges:
    items:
      - limits:
          - type: Pod
            max:
              cpu: "4"
              memory: 8Gi
            min:
              cpu: "10m"
              memory: 64Mi
          - type: Container
            default:
              cpu: "500m"
              memory: 512Mi
            defaultRequest:
              cpu: "100m"
              memory: 128Mi
            max:
              cpu: "4"
              memory: 8Gi
            min:
              cpu: "10m"
              memory: 64Mi

  # NetworkPolicies applied to all tenant namespaces
  networkPolicies:
    items:
      - podSelector: {}
        policyTypes:
          - Ingress
          - Egress
        ingress:
          - from:
              - namespaceSelector:
                  matchLabels:
                    capsule.clastix.io/tenant: alpha
        egress:
          - to:
              - namespaceSelector:
                  matchLabels:
                    capsule.clastix.io/tenant: alpha
          - ports:
              - port: 53
                protocol: UDP
              - port: 53
                protocol: TCP
          - ports:
              - port: 443
                protocol: TCP

  # Allowed node selectors (limit tenant to specific node pools)
  nodeSelector:
    node-pool: tenant-workloads

  # Allowed ingress hostnames
  ingressOptions:
    allowedHostnames:
      allowedRegex: "^.*\\.alpha\\.example\\.com$"
    hostnameCollisionScope: Tenant

  # Allowed storage classes
  storageClasses:
    allowed:
      - "gp3"
      - "io1"
    allowedRegex: "^tenant-.*$"

  # Allowed priority classes
  priorityClasses:
    allowed:
      - "tenant-high"
      - "tenant-medium"
      - "tenant-low"

  # Pod security (using PodSecurity admission)
  podOptions:
    enableDefaultSeccompProfile: true

  # Allowed container registries
  containerRegistries:
    allowed:
      - "my-registry.example.com"
      - "ghcr.io/my-org"
    allowedRegex: "^.*\\.example\\.com/.*$"
```

```bash
# Deploy the tenant
kubectl apply -f tenant-alpha.yaml

# Check tenant status
kubectl get tenant alpha -o yaml

# As a tenant user: create a namespace
# The namespace automatically gets all policies applied
kubectl create namespace alpha-frontend
# This works because alice/team-alpha are owners

# Verify policies were propagated
kubectl get networkpolicies -n alpha-frontend
kubectl get resourcequota -n alpha-frontend
kubectl get limitrange -n alpha-frontend
```

### Capsule Proxy for Tenant Self-Service

Capsule Proxy lets tenant users safely interact with cluster-level resources (ClusterRoles, StorageClasses, Nodes) as if they had cluster access, while filtering results to only show what belongs to them:

```bash
helm install capsule-proxy projectcapsule/capsule-proxy \
  --namespace capsule-system \
  --version 0.5.0 \
  --set options.generateCertificates=true \
  --set options.listeningPort=9001 \
  --set options.logLevel=4

# Tenant users point their kubeconfig to capsule-proxy instead of the API server
# They can then run:
kubectl get namespaces      # Returns only tenant namespaces
kubectl get storageclass    # Returns only allowed storage classes
kubectl get nodes           # Returns only nodes in the tenant's node selector
```

## vCluster: Virtual Kubernetes Clusters

vCluster runs a full Kubernetes control plane (API server, controller manager, etcd/SQLite) inside a host cluster namespace. Tenant workloads run in the host cluster but are managed by the virtual control plane.

### Installing vCluster CLI

```bash
curl -L -o /usr/local/bin/vcluster \
  "https://github.com/loft-sh/vcluster/releases/download/v0.20.0/vcluster-linux-amd64"
chmod +x /usr/local/bin/vcluster

# Or via Helm directly
helm repo add loft-sh https://charts.loft.sh
helm repo update
```

### Creating a vCluster

```bash
# Create a vCluster for tenant beta
vcluster create tenant-beta \
  --namespace vcluster-tenant-beta \
  --chart-version v0.20.0 \
  --values vcluster-values.yaml
```

```yaml
# vcluster-values.yaml
controlPlane:
  distro:
    k8s:
      enabled: true
      apiServer:
        image:
          tag: "1.30.0"
      controllerManager:
        image:
          tag: "1.30.0"

  # Use SQLite instead of etcd for single-node vclusters (lower overhead)
  # For production: use etcd for HA
  backingStore:
    embeddedEtcd:
      enabled: false
    database:
      embedded:
        enabled: true  # SQLite

  # HA vCluster (requires enterprise or embedded etcd)
  # statefulSet:
  #   highAvailability:
  #     replicas: 3

  # Resource limits for the vCluster control plane pod
  statefulSet:
    resources:
      requests:
        cpu: "100m"
        memory: "256Mi"
      limits:
        cpu: "2"
        memory: "2Gi"

# Sync configuration: what resources sync between vCluster and host cluster
sync:
  toHost:
    # Pods: required (vCluster schedules pods on host nodes)
    pods:
      enabled: true
      rewriteHosts:
        enabled: true
    # Persistent volumes are synced to host
    persistentVolumeClaims:
      enabled: true
    ingresses:
      enabled: true
    services:
      enabled: true
    secrets:
      enabled: true  # Sync secrets for image pull
    configmaps:
      enabled: true

  fromHost:
    # Allow vCluster to use host StorageClasses
    storageClasses:
      enabled: true
    # Allow vCluster pods to pull from host-accessible registries
    # (via shared ServiceAccounts)

# Networking
networking:
  replicateServices:
    toHost:
      - from: default/nginx
        to: vcluster-tenant-beta/tenant-beta-nginx

# Isolation mode: prevent vCluster from accessing host resources it shouldn't
isolation:
  enabled: true
  resourceQuota:
    enabled: true
    quota:
      requests.cpu: "10"
      requests.memory: 20Gi
      limits.cpu: "20"
      limits.memory: 40Gi
      pods: "100"
      services: "20"
      persistentvolumeclaims: "10"
      requests.storage: 200Gi
  limitRange:
    enabled: true
    default:
      cpu: "500m"
      memory: "512Mi"
    defaultRequest:
      cpu: "100m"
      memory: "128Mi"
  networkPolicy:
    enabled: true
    outgoingConnections:
      ipBlock:
        cidr: 0.0.0.0/0
        except:
          - 10.0.0.0/8     # Block access to internal network
          - 172.16.0.0/12
          - 192.168.0.0/16
```

### Connecting to a vCluster

```bash
# Connect to the vCluster (creates a kubeconfig entry)
vcluster connect tenant-beta --namespace vcluster-tenant-beta

# Now kubectl operates against the virtual cluster
kubectl get nodes      # Shows virtual nodes
kubectl get namespaces # Shows namespaces in the vCluster

# Disconnect
vcluster disconnect

# Get kubeconfig for CI/CD integration
vcluster connect tenant-beta \
  --namespace vcluster-tenant-beta \
  --print \
  > tenant-beta-kubeconfig.yaml

# Deploy to the vCluster
KUBECONFIG=tenant-beta-kubeconfig.yaml kubectl apply -f myapp.yaml
```

### vCluster with Helm (GitOps)

```yaml
# vcluster-helmrelease.yaml
apiVersion: helm.toolkit.fluxcd.io/v2beta1
kind: HelmRelease
metadata:
  name: vcluster-tenant-beta
  namespace: flux-system
spec:
  interval: 5m
  targetNamespace: vcluster-tenant-beta
  storageNamespace: vcluster-tenant-beta
  chart:
    spec:
      chart: vcluster
      version: "0.20.0"
      sourceRef:
        kind: HelmRepository
        name: loft-sh
  values:
    controlPlane:
      distro:
        k8s:
          enabled: true
    isolation:
      enabled: true
      resourceQuota:
        enabled: true
        quota:
          requests.cpu: "8"
          requests.memory: 16Gi
```

## Hierarchical Namespaces with HNC

Hierarchical Namespace Controller (HNC) allows parent-child namespace relationships where policies propagate from parent to children:

```bash
# Install HNC
kubectl apply -f https://github.com/kubernetes-sigs/hierarchical-namespaces/releases/download/v1.1.0/default.yaml

# Install HNC kubectl plugin
curl -L https://github.com/kubernetes-sigs/hierarchical-namespaces/releases/download/v1.1.0/kubectl-hns_linux_amd64 \
  -o /usr/local/bin/kubectl-hns
chmod +x /usr/local/bin/kubectl-hns
```

```yaml
# Create parent namespace for team gamma
apiVersion: v1
kind: Namespace
metadata:
  name: team-gamma

---
# Propagate NetworkPolicy from parent to all children
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-external
  namespace: team-gamma
  annotations:
    # HNC will copy this to all descendant namespaces
    hnc.x-k8s.io/managed-by: team-gamma
spec:
  podSelector: {}
  policyTypes:
    - Egress
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              hierarchyGroup: team-gamma
```

```bash
# Create child namespaces
kubectl hns create gamma-frontend --namespace team-gamma
kubectl hns create gamma-backend --namespace team-gamma
kubectl hns create gamma-data --namespace team-gamma

# View namespace hierarchy
kubectl hns tree team-gamma
# team-gamma
# ├── gamma-frontend
# ├── gamma-backend
# └── gamma-data

# Verify policy propagation
kubectl get networkpolicies -n gamma-frontend
# Shows policies propagated from team-gamma

# Sub-namespaces inherit parent labels
kubectl get namespace gamma-frontend -o jsonpath='{.metadata.labels}'
```

## Operational Patterns for SaaS Providers

### Tenant Provisioning Automation

```go
// tenant-provisioner/main.go
// Example: Kubernetes operator that provisions tenants on request

package main

import (
    "context"
    "fmt"

    capsulev1beta2 "github.com/projectcapsule/capsule/api/v1beta2"
    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/api/resource"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "sigs.k8s.io/controller-runtime/pkg/client"
)

type TenantSpec struct {
    Name        string
    OwnerEmail  string
    Plan        string  // "starter", "professional", "enterprise"
    MaxCPU      string
    MaxMemory   string
    MaxPods     int32
}

func provisionTenant(ctx context.Context, k8sClient client.Client, spec TenantSpec) error {
    quotasByPlan := map[string]corev1.ResourceList{
        "starter": {
            corev1.ResourceRequestsCPU:    resource.MustParse("2"),
            corev1.ResourceRequestsMemory: resource.MustParse("4Gi"),
            corev1.ResourceLimitsCPU:      resource.MustParse("4"),
            corev1.ResourceLimitsMemory:   resource.MustParse("8Gi"),
        },
        "professional": {
            corev1.ResourceRequestsCPU:    resource.MustParse("8"),
            corev1.ResourceRequestsMemory: resource.MustParse("16Gi"),
            corev1.ResourceLimitsCPU:      resource.MustParse("16"),
            corev1.ResourceLimitsMemory:   resource.MustParse("32Gi"),
        },
        "enterprise": {
            corev1.ResourceRequestsCPU:    resource.MustParse("32"),
            corev1.ResourceRequestsMemory: resource.MustParse("64Gi"),
            corev1.ResourceLimitsCPU:      resource.MustParse("64"),
            corev1.ResourceLimitsMemory:   resource.MustParse("128Gi"),
        },
    }

    quota, ok := quotasByPlan[spec.Plan]
    if !ok {
        return fmt.Errorf("unknown plan: %s", spec.Plan)
    }

    tenant := &capsulev1beta2.Tenant{
        ObjectMeta: metav1.ObjectMeta{
            Name: spec.Name,
            Labels: map[string]string{
                "saas-plan": spec.Plan,
            },
            Annotations: map[string]string{
                "owner-email": spec.OwnerEmail,
            },
        },
        Spec: capsulev1beta2.TenantSpec{
            Owners: []capsulev1beta2.OwnerSpec{
                {
                    Name: fmt.Sprintf("system:serviceaccount:%s-system:tenant-sa", spec.Name),
                    Kind: "ServiceAccount",
                },
            },
            NamespaceOptions: &capsulev1beta2.NamespaceOptions{
                Quota: 5,
            },
            ResourceQuotas: capsulev1beta2.ResourceQuotaSpec{
                Scope: capsulev1beta2.ResourceQuotaScopeTenant,
                Items: []corev1.ResourceQuotaSpec{
                    {Hard: quota},
                },
            },
        },
    }

    return k8sClient.Create(ctx, tenant)
}
```

### Resource Isolation with Priority Classes

```yaml
# priority-classes.yaml
# Prevent tenant workloads from preempting system workloads
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: tenant-high
value: 100000
globalDefault: false
description: "High priority for tenant production workloads"

---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: tenant-medium
value: 50000
globalDefault: false
description: "Medium priority for tenant workloads"

---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: tenant-low
value: 10000
globalDefault: false
description: "Low priority for tenant batch/background workloads"

---
# System workloads use much higher priority (default: 1,000,000,000)
# This ensures tenant workloads cannot preempt system pods
```

### Cross-Tenant Isolation Testing

```bash
#!/bin/bash
# isolation-test.sh — Verify tenant isolation is working

set -euo pipefail

TENANT_A_NS="tenant-alpha-app"
TENANT_B_NS="tenant-beta-app"

echo "=== Testing cross-tenant isolation ==="

# Test 1: Tenant A cannot reach Tenant B
echo "Test 1: Network isolation between tenants"
kubectl run test-pod \
  --namespace "${TENANT_A_NS}" \
  --image curlimages/curl:latest \
  --rm \
  --restart=Never \
  --command -- \
  curl --connect-timeout 5 "http://nginx.${TENANT_B_NS}:80" 2>&1 && \
  echo "FAIL: Tenant A reached Tenant B" && exit 1 || \
  echo "PASS: Tenant A cannot reach Tenant B"

# Test 2: Tenant cannot exceed resource quota
echo "Test 2: Resource quota enforcement"
kubectl apply -f - <<EOF
apiVersion: v1
kind: ResourceQuota
metadata:
  name: test-enforcement
  namespace: ${TENANT_A_NS}
spec:
  hard:
    pods: "0"  # Try to set to 0 — should fail if tenant doesn't own the quota
EOF
RESULT=$?
[ $RESULT -ne 0 ] && echo "PASS: Tenant cannot modify cluster-level quotas" || \
  echo "FAIL: Tenant modified quota"

# Test 3: Tenant cannot access another tenant's secrets
echo "Test 3: RBAC isolation"
kubectl get secrets \
  --namespace "${TENANT_B_NS}" \
  --as="system:serviceaccount:${TENANT_A_NS}:default" 2>&1 | \
  grep -q "forbidden" && \
  echo "PASS: Tenant A cannot list Tenant B secrets" || \
  echo "FAIL: Tenant A accessed Tenant B secrets"

echo "=== Isolation tests complete ==="
```

## Summary

Multi-tenancy in Kubernetes is not a single feature but a combination of mechanisms applied at the appropriate layer:

**Namespace + RBAC**: baseline for all approaches; every multi-tenant deployment needs proper RBAC regardless of other tools

**Capsule** is the right choice when:
- You need to onboard many teams or customers on one cluster
- You want ResourceQuota, LimitRange, and NetworkPolicy automatically applied to new namespaces
- You need to enforce boundaries (allowed registries, storage classes, ingress hostnames) without per-namespace configuration
- Tenant users should be able to self-service namespace creation within bounds you define

**vCluster** is the right choice when:
- Tenants need their own Kubernetes API (custom CRDs, admission webhooks, API server access)
- You need strong blast radius isolation (a broken tenant cannot affect others' control plane)
- Tenants are external customers with untrusted workloads
- Multi-version Kubernetes support per tenant is required

**HNC** complements both by enabling policy propagation in namespace hierarchies within a tenant.

For SaaS providers: start with Capsule for rapid tenant onboarding and resource governance, and graduate tenants with elevated isolation requirements to vClusters without changing the host cluster.
