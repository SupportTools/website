---
title: "Kubernetes Namespace-Level Isolation: Network Policies, RBAC, and ResourceQuota Patterns"
date: 2030-08-28T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Namespace", "RBAC", "NetworkPolicy", "ResourceQuota", "Multi-tenancy", "Security"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise multi-tenant namespace design combining NetworkPolicy, RBAC, ResourceQuota, and LimitRange for strong isolation, namespace-scoped operator deployment, and automated tenant provisioning."
more_link: "yes"
url: "/kubernetes-namespace-isolation-networkpolicy-rbac-resourcequota/"
---

Multi-tenant Kubernetes clusters require namespace-level isolation that prevents one tenant's workloads from affecting another through network access, resource consumption, or permission escalation. A namespace alone provides only naming isolation — without explicit NetworkPolicy, RBAC, ResourceQuota, and LimitRange configurations, namespaces are porous boundaries. This post builds a complete namespace isolation stack and an automated tenant provisioning controller that creates all required resources atomically when a new namespace is requested.

<!--more-->

## The Four Pillars of Namespace Isolation

Robust namespace isolation requires four independent mechanisms working together:

1. **NetworkPolicy**: Controls which pods can communicate with which other pods and services, both within and across namespaces.
2. **RBAC**: Controls which users and service accounts can perform which operations within the namespace.
3. **ResourceQuota**: Caps the total resource consumption (CPU, memory, pods, PVCs) within the namespace.
4. **LimitRange**: Sets default resource requests/limits and enforces minimum/maximum per container, preventing misconfigured containers from starving or monopolizing node resources.

None of these can substitute for the others. NetworkPolicy without ResourceQuota allows a noisy tenant to consume all node resources. RBAC without NetworkPolicy prevents API tampering but allows network-level snooping. The combination is what creates genuine isolation.

## Network Policy: Default Deny and Explicit Allow

The standard baseline for multi-tenant namespaces is a default-deny policy that blocks all ingress and egress, followed by explicit allow policies for required communication paths.

### Default Deny All Traffic

```yaml
# default-deny.yaml - Apply to every tenant namespace
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: tenant-acme
spec:
  podSelector: {}   # Selects all pods in the namespace
  policyTypes:
    - Ingress
    - Egress
  # No ingress or egress rules = deny all
```

### Allow DNS Resolution

DNS is required for virtually all services. Allow egress to `kube-dns` in `kube-system`:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns
  namespace: tenant-acme
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
      to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
          podSelector:
            matchLabels:
              k8s-app: kube-dns
```

### Allow Intra-Namespace Communication

Pods within the same tenant namespace should communicate freely:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-same-namespace
  namespace: tenant-acme
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - podSelector: {}  # Any pod in this namespace
  egress:
    - to:
        - podSelector: {}  # Any pod in this namespace
```

### Allow Ingress from NGINX Ingress Controller

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-ingress-controller
  namespace: tenant-acme
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/part-of: tenant-acme
  policyTypes:
    - Ingress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ingress-nginx
          podSelector:
            matchLabels:
              app.kubernetes.io/name: ingress-nginx
      ports:
        - protocol: TCP
          port: 8080
        - protocol: TCP
          port: 8443
```

### Allow Egress to Specific External Services

```yaml
# Allow tenant to reach their database in a shared namespace
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-database
  namespace: tenant-acme
spec:
  podSelector:
    matchLabels:
      needs-database: "true"
  policyTypes:
    - Egress
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: databases
          podSelector:
            matchLabels:
              tenant: acme
      ports:
        - protocol: TCP
          port: 5432
```

### Allow Monitoring Scraping

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-prometheus-scrape
  namespace: tenant-acme
spec:
  podSelector:
    matchLabels:
      prometheus.io/scrape: "true"
  policyTypes:
    - Ingress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: monitoring
          podSelector:
            matchLabels:
              app.kubernetes.io/name: prometheus
      ports:
        - protocol: TCP
          port: 9090
```

## RBAC: Namespace-Scoped Roles

### Tenant Developer Role

```yaml
# tenant-developer-role.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: tenant-developer
  namespace: tenant-acme
rules:
  # Read workloads
  - apiGroups: ["apps"]
    resources:
      - deployments
      - replicasets
      - statefulsets
      - daemonsets
    verbs: ["get", "list", "watch"]

  # Manage workloads
  - apiGroups: ["apps"]
    resources:
      - deployments
      - statefulsets
    verbs: ["create", "update", "patch", "delete"]

  # Pod operations (read + exec)
  - apiGroups: [""]
    resources:
      - pods
      - pods/log
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources:
      - pods/exec
    verbs: ["create"]

  # ConfigMaps (manage own config)
  - apiGroups: [""]
    resources:
      - configmaps
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]

  # Secrets (read only — cannot create/update production secrets)
  - apiGroups: [""]
    resources:
      - secrets
    verbs: ["get", "list", "watch"]

  # Services
  - apiGroups: [""]
    resources:
      - services
    verbs: ["get", "list", "watch", "create", "update", "patch"]

  # HPA
  - apiGroups: ["autoscaling"]
    resources:
      - horizontalpodautoscalers
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]

  # Jobs
  - apiGroups: ["batch"]
    resources:
      - jobs
      - cronjobs
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]

  # Events (read only)
  - apiGroups: [""]
    resources:
      - events
    verbs: ["get", "list", "watch"]
---
# Tenant admin gets everything the developer has + more
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: tenant-admin
  namespace: tenant-acme
rules:
  - apiGroups: ["*"]
    resources: ["*"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  # Explicitly exclude cluster-wide resources (handled by ClusterRole)
---
# Bind a group to the developer role
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: tenant-acme-developers
  namespace: tenant-acme
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: tenant-developer
subjects:
  - kind: Group
    name: oidc:acme-developers  # Group from OIDC provider
    apiGroup: rbac.authorization.k8s.io
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: tenant-acme-admins
  namespace: tenant-acme
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: tenant-admin
subjects:
  - kind: Group
    name: oidc:acme-admins
    apiGroup: rbac.authorization.k8s.io
```

### Restricting Service Account Permissions

Prevent pods from using the default service account to interact with the Kubernetes API:

```yaml
# Restrict the default service account to minimal permissions
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: default-sa-minimal
  namespace: tenant-acme
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: minimal-pod-role  # A role with no permissions
subjects:
  - kind: ServiceAccount
    name: default
    namespace: tenant-acme
---
# Disable automounting of the service account token on the default SA
# (pods that need API access should use a dedicated SA)
apiVersion: v1
kind: ServiceAccount
metadata:
  name: default
  namespace: tenant-acme
automountServiceAccountToken: false
```

## ResourceQuota: Capping Namespace Consumption

```yaml
# tenant-quota.yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: tenant-acme-quota
  namespace: tenant-acme
spec:
  hard:
    # Compute resources
    requests.cpu: "20"         # 20 vCPUs total requested
    limits.cpu: "40"           # 40 vCPUs maximum (allows overcommit)
    requests.memory: "40Gi"   # 40 GiB total memory requested
    limits.memory: "80Gi"     # 80 GiB maximum memory

    # Object count limits
    pods: "100"
    services: "20"
    secrets: "50"
    configmaps: "50"
    persistentvolumeclaims: "20"
    services.loadbalancers: "0"   # Tenant cannot create LoadBalancer services
    services.nodeports: "0"       # Tenant cannot use NodePort services

    # Storage
    requests.storage: "500Gi"   # Total PVC storage
    standard.storageclass.storage.k8s.io/requests.storage: "200Gi"
    premium.storageclass.storage.k8s.io/requests.storage: "50Gi"

    # Guaranteed QoS pod limits (higher quota tier)
    count/pods.v1.in-qos-class-guaranteed: "10"
```

### Multiple Quota Tiers

For environments with different SLA requirements, use multiple quotas with priority class scoping:

```yaml
# High-priority quota (for production workloads)
apiVersion: v1
kind: ResourceQuota
metadata:
  name: high-priority-quota
  namespace: tenant-acme
spec:
  hard:
    requests.cpu: "8"
    requests.memory: "16Gi"
    pods: "20"
  scopeSelector:
    matchExpressions:
      - scopeName: PriorityClass
        operator: In
        values:
          - high-priority
---
# Best-effort quota (for background jobs)
apiVersion: v1
kind: ResourceQuota
metadata:
  name: best-effort-quota
  namespace: tenant-acme
spec:
  hard:
    pods: "50"
  scopes:
    - BestEffort
```

## LimitRange: Default and Minimum/Maximum Per Container

ResourceQuota operates at the namespace level; LimitRange operates at the container level. Without LimitRange, a single container can claim the entire namespace quota.

```yaml
# tenant-limitrange.yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: tenant-acme-limits
  namespace: tenant-acme
spec:
  limits:
    # Container defaults and constraints
    - type: Container
      default:
        cpu: "500m"      # Applied when no limit specified
        memory: "512Mi"
      defaultRequest:
        cpu: "100m"      # Applied when no request specified
        memory: "128Mi"
      min:
        cpu: "50m"       # Containers must request at least this
        memory: "64Mi"
      max:
        cpu: "8"         # No container can request more than this
        memory: "16Gi"
      maxLimitRequestRatio:
        cpu: "4"         # limits.cpu can be at most 4× requests.cpu
        memory: "4"      # prevents extreme overcommit per container

    # Pod-level limits
    - type: Pod
      max:
        cpu: "16"        # No pod can use more than 16 vCPUs
        memory: "32Gi"

    # PVC limits
    - type: PersistentVolumeClaim
      max:
        storage: "50Gi"  # No single PVC can exceed 50Gi
      min:
        storage: "1Gi"
```

## Namespace Labels for Policy Targeting

Kubernetes uses namespace labels to target NetworkPolicies and admission webhooks. Standardize labels:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: tenant-acme
  labels:
    # Standard Kubernetes labels
    kubernetes.io/metadata.name: tenant-acme

    # Tenant identification
    tenant.example.com/id: acme
    tenant.example.com/tier: standard  # basic | standard | premium
    tenant.example.com/environment: production

    # Policy enforcement labels
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/warn: restricted

    # Network policy targeting
    network.example.com/isolation: tenant
```

### Pod Security Admission

The `pod-security.kubernetes.io/enforce: restricted` label enforces the Kubernetes Pod Security Standards at the namespace level:

```bash
# Test what would fail in a namespace
kubectl --dry-run=server create -n tenant-acme -f privileged-pod.yaml
# Error from server: admission webhook denied: pod violates PodSecurity "restricted:latest"

# Audit without enforcement (use before switching to enforce)
kubectl label namespace tenant-acme \
  pod-security.kubernetes.io/audit=restricted \
  pod-security.kubernetes.io/warn=restricted

kubectl get events -n tenant-acme | grep PodSecurity
```

## Namespace-Scoped Operator Deployment

Operators typically require cluster-wide permissions, but multi-tenant environments need operators scoped to specific namespaces to prevent tenant operators from accessing other tenants' resources.

### Namespace-Scoped Operator Configuration

```yaml
# operator-serviceaccount.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: tenant-operator
  namespace: tenant-acme
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: tenant-operator-role
  namespace: tenant-acme
rules:
  - apiGroups: ["apps.example.com"]
    resources:
      - databases
      - databases/status
      - caches
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: ["apps"]
    resources:
      - deployments
      - statefulsets
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: [""]
    resources:
      - pods
      - services
      - configmaps
      - secrets
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: tenant-operator-binding
  namespace: tenant-acme
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: tenant-operator-role
subjects:
  - kind: ServiceAccount
    name: tenant-operator
    namespace: tenant-acme
---
# Deploy the operator watching only its own namespace
apiVersion: apps/v1
kind: Deployment
metadata:
  name: tenant-operator
  namespace: tenant-acme
spec:
  replicas: 1
  selector:
    matchLabels:
      app: tenant-operator
  template:
    metadata:
      labels:
        app: tenant-operator
    spec:
      serviceAccountName: tenant-operator
      containers:
        - name: operator
          image: registry.example.com/tenant-operator:v1.2.0
          env:
            - name: WATCH_NAMESPACE
              valueFrom:
                fieldRef:
                  fieldPath: metadata.namespace
            - name: OPERATOR_NAME
              value: "tenant-operator"
          resources:
            requests:
              cpu: "50m"
              memory: "64Mi"
            limits:
              cpu: "200m"
              memory: "256Mi"
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            runAsNonRoot: true
            runAsUser: 65534
            capabilities:
              drop: ["ALL"]
```

## Tenant Provisioning Controller

Automating namespace creation with all required policies ensures consistency and prevents configuration drift. The following controller watches a custom `Tenant` CRD and creates all required resources:

```go
// pkg/controller/tenant_controller.go
package controller

import (
    "context"
    "fmt"

    corev1 "k8s.io/api/core/v1"
    networkingv1 "k8s.io/api/networking/v1"
    rbacv1 "k8s.io/api/rbac/v1"
    "k8s.io/apimachinery/pkg/api/errors"
    "k8s.io/apimachinery/pkg/api/resource"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/log"
    "sigs.k8s.io/controller-runtime/pkg/reconcile"

    tenantv1 "enterprise.example.com/tenant-operator/api/v1"
)

// TenantReconciler reconciles Tenant resources.
type TenantReconciler struct {
    client.Client
}

func (r *TenantReconciler) Reconcile(ctx context.Context, req reconcile.Request) (reconcile.Result, error) {
    logger := log.FromContext(ctx)

    tenant := &tenantv1.Tenant{}
    if err := r.Get(ctx, req.NamespacedName, tenant); err != nil {
        if errors.IsNotFound(err) {
            return reconcile.Result{}, nil
        }
        return reconcile.Result{}, err
    }

    nsName := tenant.Spec.NamespaceName

    // 1. Ensure namespace exists with proper labels
    if err := r.ensureNamespace(ctx, tenant); err != nil {
        return reconcile.Result{}, fmt.Errorf("namespace: %w", err)
    }

    // 2. Apply network policies
    if err := r.ensureNetworkPolicies(ctx, nsName); err != nil {
        return reconcile.Result{}, fmt.Errorf("network policies: %w", err)
    }

    // 3. Apply RBAC
    if err := r.ensureRBAC(ctx, tenant); err != nil {
        return reconcile.Result{}, fmt.Errorf("RBAC: %w", err)
    }

    // 4. Apply ResourceQuota based on tier
    if err := r.ensureResourceQuota(ctx, tenant); err != nil {
        return reconcile.Result{}, fmt.Errorf("resource quota: %w", err)
    }

    // 5. Apply LimitRange
    if err := r.ensureLimitRange(ctx, nsName); err != nil {
        return reconcile.Result{}, fmt.Errorf("limit range: %w", err)
    }

    logger.Info("tenant provisioned", "namespace", nsName, "tier", tenant.Spec.Tier)
    return reconcile.Result{}, r.updateStatus(ctx, tenant, "Ready")
}

func (r *TenantReconciler) ensureNamespace(ctx context.Context, tenant *tenantv1.Tenant) error {
    ns := &corev1.Namespace{
        ObjectMeta: metav1.ObjectMeta{
            Name: tenant.Spec.NamespaceName,
            Labels: map[string]string{
                "kubernetes.io/metadata.name":               tenant.Spec.NamespaceName,
                "tenant.example.com/id":                     tenant.Name,
                "tenant.example.com/tier":                   tenant.Spec.Tier,
                "pod-security.kubernetes.io/enforce":        "restricted",
                "pod-security.kubernetes.io/audit":          "restricted",
                "pod-security.kubernetes.io/warn":           "restricted",
                "network.example.com/isolation":             "tenant",
                "app.kubernetes.io/managed-by":              "tenant-operator",
            },
            Annotations: map[string]string{
                "tenant.example.com/contact": tenant.Spec.ContactEmail,
            },
        },
    }
    return r.createOrUpdate(ctx, ns)
}

func (r *TenantReconciler) ensureNetworkPolicies(ctx context.Context, namespace string) error {
    policies := []*networkingv1.NetworkPolicy{
        buildDefaultDenyPolicy(namespace),
        buildAllowDNSPolicy(namespace),
        buildAllowSameNamespacePolicy(namespace),
        buildAllowIngressControllerPolicy(namespace),
        buildAllowPrometheusPolicy(namespace),
    }
    for _, policy := range policies {
        if err := r.createOrUpdate(ctx, policy); err != nil {
            return fmt.Errorf("policy %s: %w", policy.Name, err)
        }
    }
    return nil
}

func (r *TenantReconciler) ensureResourceQuota(ctx context.Context, tenant *tenantv1.Tenant) error {
    quota := quotaForTier(tenant.Spec.NamespaceName, tenant.Spec.Tier)
    return r.createOrUpdate(ctx, quota)
}

func quotaForTier(namespace, tier string) *corev1.ResourceQuota {
    tiers := map[string]corev1.ResourceList{
        "basic": {
            corev1.ResourceRequestsCPU:    resource.MustParse("4"),
            corev1.ResourceLimitsCPU:      resource.MustParse("8"),
            corev1.ResourceRequestsMemory: resource.MustParse("8Gi"),
            corev1.ResourceLimitsMemory:   resource.MustParse("16Gi"),
            corev1.ResourcePods:           resource.MustParse("20"),
        },
        "standard": {
            corev1.ResourceRequestsCPU:    resource.MustParse("20"),
            corev1.ResourceLimitsCPU:      resource.MustParse("40"),
            corev1.ResourceRequestsMemory: resource.MustParse("40Gi"),
            corev1.ResourceLimitsMemory:   resource.MustParse("80Gi"),
            corev1.ResourcePods:           resource.MustParse("100"),
        },
        "premium": {
            corev1.ResourceRequestsCPU:    resource.MustParse("100"),
            corev1.ResourceLimitsCPU:      resource.MustParse("200"),
            corev1.ResourceRequestsMemory: resource.MustParse("200Gi"),
            corev1.ResourceLimitsMemory:   resource.MustParse("400Gi"),
            corev1.ResourcePods:           resource.MustParse("500"),
        },
    }

    hard, ok := tiers[tier]
    if !ok {
        hard = tiers["basic"]
    }

    return &corev1.ResourceQuota{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "tenant-quota",
            Namespace: namespace,
        },
        Spec: corev1.ResourceQuotaSpec{Hard: hard},
    }
}

func (r *TenantReconciler) createOrUpdate(ctx context.Context, obj client.Object) error {
    existing := obj.DeepCopyObject().(client.Object)
    err := r.Get(ctx, client.ObjectKeyFromObject(obj), existing)
    if errors.IsNotFound(err) {
        return r.Create(ctx, obj)
    }
    if err != nil {
        return err
    }
    obj.SetResourceVersion(existing.GetResourceVersion())
    return r.Update(ctx, obj)
}
```

### Tenant CRD

```yaml
# tenant-crd.yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: tenants.tenant.example.com
spec:
  group: tenant.example.com
  names:
    kind: Tenant
    listKind: TenantList
    plural: tenants
    singular: tenant
  scope: Cluster
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
              required: ["namespaceName", "tier", "contactEmail"]
              properties:
                namespaceName:
                  type: string
                  pattern: "^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$"
                tier:
                  type: string
                  enum: ["basic", "standard", "premium"]
                contactEmail:
                  type: string
                  format: email
                developerGroups:
                  type: array
                  items:
                    type: string
                adminGroups:
                  type: array
                  items:
                    type: string
            status:
              type: object
              properties:
                phase:
                  type: string
                conditions:
                  type: array
      subresources:
        status: {}
      additionalPrinterColumns:
        - name: Namespace
          type: string
          jsonPath: .spec.namespaceName
        - name: Tier
          type: string
          jsonPath: .spec.tier
        - name: Status
          type: string
          jsonPath: .status.phase
```

### Sample Tenant Resource

```yaml
# acme-tenant.yaml
apiVersion: tenant.example.com/v1
kind: Tenant
metadata:
  name: acme-corp
spec:
  namespaceName: tenant-acme
  tier: standard
  contactEmail: platform@acme-corp.com
  developerGroups:
    - oidc:acme-developers
    - oidc:acme-qa
  adminGroups:
    - oidc:acme-platform-leads
```

```bash
# Provision the tenant
kubectl apply -f acme-tenant.yaml

# Verify all resources were created
kubectl get all,networkpolicies,resourcequotas,limitranges -n tenant-acme

# Verify isolation by attempting cross-namespace access
kubectl run test-pod \
  --image=curlimages/curl:8.7.1 \
  -n tenant-acme \
  --rm -it --restart=Never \
  -- curl -s http://api-server.tenant-other.svc.cluster.local:8080
# Should fail: connection timed out (NetworkPolicy blocking egress)
```

## Validating Namespace Isolation

### Network Policy Testing with Netshoot

```bash
# Test network policy enforcement
# Deploy test pods in two different tenant namespaces
kubectl run sender \
  --image=nicolaka/netshoot:latest \
  -n tenant-acme \
  --restart=Never \
  -- sleep 3600

kubectl run receiver \
  --image=nginx:alpine \
  -n tenant-beta \
  --labels="app=receiver" \
  --restart=Never

RECEIVER_IP=$(kubectl get pod receiver -n tenant-beta -o jsonpath='{.status.podIP}')

# This should fail (cross-namespace egress blocked)
kubectl exec -n tenant-acme sender -- curl -s --connect-timeout 3 http://$RECEIVER_IP:80
# curl: (28) Connection timed out

# This should succeed (same-namespace)
kubectl run receiver-same-ns \
  --image=nginx:alpine \
  -n tenant-acme \
  --labels="app=receiver" \
  --restart=Never

RECEIVER_SAME_IP=$(kubectl get pod receiver-same-ns -n tenant-acme -o jsonpath='{.status.podIP}')
kubectl exec -n tenant-acme sender -- curl -s --connect-timeout 3 http://$RECEIVER_SAME_IP:80
# Welcome to nginx!
```

### ResourceQuota Enforcement Test

```bash
# Check current quota usage
kubectl describe resourcequota tenant-quota -n tenant-acme

# Try to exceed the pod limit (assuming limit is 100 and 95 are running)
kubectl create deployment quota-test \
  -n tenant-acme \
  --image=nginx:alpine \
  --replicas=10

# Check for quota exceeded events
kubectl get events -n tenant-acme | grep exceeded
# Warning  FailedCreate  replicaset  Error creating: pods "quota-test-..." is forbidden:
#   exceeded quota: tenant-quota, requested: pods=1, used: pods=100, limited: pods=100
```

## Audit Logging for Namespace Events

Configure Kubernetes audit policy to capture all API operations within tenant namespaces:

```yaml
# audit-policy.yaml
apiVersion: audit.k8s.io/v1
kind: Policy
rules:
  # Log all operations in tenant namespaces at RequestResponse level
  - level: RequestResponse
    namespaces:
      - "tenant-*"
    verbs:
      - create
      - update
      - patch
      - delete
    resources:
      - group: ""
        resources: ["secrets", "serviceaccounts"]
      - group: "rbac.authorization.k8s.io"
        resources: ["roles", "rolebindings"]
      - group: "networking.k8s.io"
        resources: ["networkpolicies"]

  # Metadata-only for reads
  - level: Metadata
    namespaces:
      - "tenant-*"

  # Suppress noisy read-only operations
  - level: None
    verbs: ["get", "list", "watch"]
    users:
      - "system:serviceaccount:monitoring:prometheus"
```

## Summary

Namespace isolation in production Kubernetes requires all four mechanisms applied consistently: NetworkPolicy with default-deny-all followed by explicit allow rules for DNS, same-namespace traffic, and ingress controllers; RBAC scoped to the namespace with a standard developer/admin role hierarchy; ResourceQuota sized per tenant tier with storage class-specific limits; and LimitRange with sensible defaults and maximum constraints to prevent any single container from consuming disproportionate resources. The tenant provisioning controller ensures every namespace receives all four configurations atomically, preventing the configuration drift that occurs when namespaces are created manually. Namespace labels enable targeting by Pod Security Admission, network policies, and monitoring systems, making the labels a critical configuration layer in their own right.
