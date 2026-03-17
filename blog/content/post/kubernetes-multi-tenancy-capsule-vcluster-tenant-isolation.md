---
title: "Kubernetes Multi-Tenancy: Capsule, vcluster, and Tenant Isolation Patterns"
date: 2029-12-11T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Multi-Tenancy", "Capsule", "vcluster", "Security", "Resource Quotas", "Network Policy"]
categories:
- Kubernetes
- Security
- Multi-Tenancy
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide covering Capsule tenant management, vcluster virtual clusters, resource quotas, network isolation, multi-tenancy security models, and tenant lifecycle management for production Kubernetes platforms."
more_link: "yes"
url: "/kubernetes-multi-tenancy-capsule-vcluster-tenant-isolation/"
---

Kubernetes was designed for single-tenant use. The default RBAC model, namespace isolation, and resource management primitives provide the building blocks for multi-tenancy but not a complete solution. Running multiple teams or customers on a shared cluster requires deliberate architecture decisions: how much isolation do tenants need, what is the blast radius of a breach, and how do you prevent noisy neighbors? This guide covers the two dominant approaches — namespace-based tenancy with Capsule and full virtual cluster isolation with vcluster — along with the network, resource, and admission control patterns that make production multi-tenancy work.

<!--more-->

## Multi-Tenancy Models

Three models exist on a spectrum from isolation to density:

**Namespace tenancy (soft isolation)**: Each tenant gets one or more namespaces on a shared cluster. The control plane, nodes, and kernel are shared. This is the densest packing and lowest operational overhead, but a kernel exploit or node-level resource exhaustion affects all tenants.

**Virtual cluster tenancy (strong isolation)**: Each tenant gets a virtual Kubernetes cluster with its own API server, scheduler, and controller manager, running as pods in the host cluster. Tenants have full cluster-admin within their virtual cluster, and breaking changes (like CRD installations) are isolated. vcluster implements this model.

**Physical cluster tenancy (hard isolation)**: Each tenant gets a dedicated node pool or dedicated cluster. Maximum isolation, highest cost. Suitable for regulated industries with strict compliance requirements.

## Capsule: Namespace-Based Multi-Tenancy

Capsule implements the namespace tenancy model by introducing a `Tenant` CRD that groups namespaces under a single tenant identity, enforcing policies across all of a tenant's namespaces uniformly.

### Installing Capsule

```bash
helm repo add projectcapsule https://projectcapsule.github.io/charts
helm repo update

helm install capsule projectcapsule/capsule \
  --namespace capsule-system \
  --create-namespace \
  --set manager.options.forceTenantPrefix=true \
  --set manager.options.protectedNamespaceRegex="kube-.*|capsule-.*|cert-manager|ingress-.*"
```

### Creating a Tenant

```yaml
apiVersion: capsule.clastix.io/v1beta2
kind: Tenant
metadata:
  name: team-alpha
spec:
  # Tenant owners — these users get admin rights within tenant namespaces
  owners:
  - name: alice
    kind: User
  - name: alpha-team
    kind: Group

  # Namespace quota: max namespaces this tenant can create
  namespaceOptions:
    quota: 10
    # Enforce tenant name prefix on all namespaces
    forbiddenLabels:
      denied:
      - kubernetes.io/metadata.name
    additionalMetadata:
      labels:
        cost-center: "team-alpha"
        environment: "production"

  # Resource quotas applied to EACH namespace
  resourceQuotas:
    scope: Tenant  # or Namespace
    items:
    - hard:
        requests.cpu: "100"
        requests.memory: "200Gi"
        limits.cpu: "200"
        limits.memory: "400Gi"
        pods: "1000"
        services: "100"
        persistentvolumeclaims: "100"

  # LimitRange applied to each namespace
  limitRanges:
    items:
    - limits:
      - type: Container
        default:
          cpu: "500m"
          memory: "512Mi"
        defaultRequest:
          cpu: "100m"
          memory: "128Mi"
        max:
          cpu: "4"
          memory: "8Gi"

  # Network policies applied to each namespace
  networkPolicies:
    items:
    - ingress:
      - from:
        - namespaceSelector:
            matchLabels:
              capsule.clastix.io/tenant: team-alpha
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ingress-nginx
      podSelector: {}
      policyTypes:
      - Ingress

  # Allowed storage classes
  storageClasses:
    allowed:
    - standard
    - fast-ssd
    allowedRegex: ".*"

  # Allowed ingress classes
  ingressOptions:
    allowedClasses:
      allowed:
      - nginx
    allowedHostnames:
      allowedRegex: "^.*\\.team-alpha\\.example\\.com$"
    hostnameCollisionScope: Tenant  # prevents hostname conflicts between tenants

  # Allowed node selectors (restrict to designated nodes)
  nodeSelector:
    matchLabels:
      pool: standard

  # Service account automation
  serviceOptions:
    allowedServices:
      nodePort: false  # Disallow NodePort services
      externalName: false  # Disallow ExternalName services
      loadBalancer: false  # Disallow direct LoadBalancer (use ingress)
```

### Tenant Namespace Creation

Capsule allows tenant users to create namespaces without cluster-admin by providing a `TenantNamespace` resource:

```bash
# Tenant owner creates a namespace (no cluster-admin needed)
kubectl create namespace alpha-production
# Capsule intercepts this and applies all tenant policies automatically

# Verify tenant ownership
kubectl get namespace alpha-production -o yaml | grep capsule
# capsule.clastix.io/tenant: team-alpha
```

### Cross-Tenant Policy: Global Tenant Scope

```yaml
# CapsuleConfiguration for cluster-wide policy
apiVersion: capsule.clastix.io/v1beta2
kind: CapsuleConfiguration
metadata:
  name: default
spec:
  userGroups:
  - capsule.clastix.io  # Group that gets tenant management permissions
  forceTenantPrefix: true
  protectedNamespaceRegex: "system-.*|kube-.*"
  # Prevent tenants from using privileged security contexts
  overrides:
    TLSSecretName: capsule-tls
```

## vcluster: Virtual Cluster Isolation

vcluster runs a full Kubernetes API server + controller manager inside pods on the host cluster, creating virtual clusters where tenants have cluster-admin without affecting the host.

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Host Kubernetes Cluster                                     │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Namespace: vcluster-team-beta                        │   │
│  │  ┌──────────────────────────────────────────────┐   │   │
│  │  │ vcluster Pod                                  │   │   │
│  │  │  ┌─────────────────┐  ┌───────────────────┐  │   │   │
│  │  │  │ k3s API server  │  │ syncer             │  │   │   │
│  │  │  │ k3s scheduler   │  │ (host↔vcluster     │  │   │   │
│  │  │  │ k3s controllers │  │  resource sync)    │  │   │   │
│  │  │  └─────────────────┘  └───────────────────┘  │   │   │
│  │  └──────────────────────────────────────────────┘   │   │
│  │  ┌──────────────────────────────────────────────┐   │   │
│  │  │ Synced resources (actual running Pods, etc.) │   │   │
│  │  └──────────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

The syncer translates virtual cluster resources (Pods, Services, PVCs) to host cluster resources, applying host-level policies transparently to the tenant.

### Deploying vcluster

```bash
# Install vcluster CLI
curl -L -o vcluster https://github.com/loft-sh/vcluster/releases/latest/download/vcluster-linux-amd64
chmod +x vcluster && mv vcluster /usr/local/bin/

# Create a virtual cluster for team-beta
vcluster create team-beta \
  --namespace vcluster-team-beta \
  --chart-version 0.19.0 \
  --values vcluster-values.yaml
```

```yaml
# vcluster-values.yaml
vcluster:
  image: rancher/k3s:v1.28.3-k3s2

sync:
  ingresses:
    enabled: true
  persistentvolumes:
    enabled: true
  hoststorageclasses:
    enabled: true

# Apply host-side policies to synced resources
plugin:
  sync:
    toHost:
      pods:
        patches:
        - op: add
          path: /metadata/labels/cost-center
          value: team-beta
        - op: add
          path: /spec/nodeSelector
          value:
            pool: standard

# Resource limits for the vcluster control plane itself
resources:
  limits:
    memory: 2Gi
    cpu: "2"
  requests:
    memory: 512Mi
    cpu: "200m"
```

### Connecting to a vcluster

```bash
# Generate kubeconfig for the virtual cluster
vcluster connect team-beta --namespace vcluster-team-beta --update-current

# Tenant user now has full cluster-admin in their virtual cluster
kubectl --context vcluster_team-beta_vcluster-team-beta get nodes

# Install CRDs in virtual cluster — doesn't affect host cluster
kubectl --context vcluster_team-beta_vcluster-team-beta apply -f my-crds.yaml
```

### vcluster Resource Isolation

Apply host-level ResourceQuotas to bound vcluster resource consumption:

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: vcluster-team-beta-quota
  namespace: vcluster-team-beta
spec:
  hard:
    requests.cpu: "50"
    requests.memory: "100Gi"
    limits.cpu: "100"
    limits.memory: "200Gi"
    count/pods: "500"
    count/services: "50"
```

## Network Isolation Patterns

### Namespace-Level Network Policy (Capsule)

Capsule automatically applies network policies to each tenant namespace. The baseline policy should:

1. Deny all ingress from other tenants
2. Allow ingress from the ingress controller
3. Allow egress to DNS (kube-dns)
4. Allow intra-tenant communication

```yaml
# Applied automatically by Capsule to every tenant namespace
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: tenant-baseline
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  - Egress
  ingress:
  # Allow traffic from same tenant (any namespace with tenant label)
  - from:
    - namespaceSelector:
        matchLabels:
          capsule.clastix.io/tenant: team-alpha
  # Allow traffic from ingress controller
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: ingress-nginx
  egress:
  # Allow DNS
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
    ports:
    - protocol: UDP
      port: 53
    - protocol: TCP
      port: 53
  # Allow intra-tenant
  - to:
    - namespaceSelector:
        matchLabels:
          capsule.clastix.io/tenant: team-alpha
  # Allow egress to internet (restrict as needed)
  - to:
    - ipBlock:
        cidr: 0.0.0.0/0
        except:
        - 10.0.0.0/8
        - 172.16.0.0/12
        - 192.168.0.0/16
```

### Cilium Network Policy for Stronger Isolation

With Cilium, use `CiliumNetworkPolicy` for L7-aware tenant isolation:

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: tenant-http-isolation
  namespace: alpha-production
spec:
  endpointSelector: {}
  ingress:
  - fromEndpoints:
    - matchLabels:
        k8s:io.kubernetes.pod.namespace: alpha-production
  - fromEndpoints:
    - matchLabels:
        k8s:app: nginx-ingress
        k8s:io.kubernetes.pod.namespace: ingress-nginx
    toPorts:
    - ports:
      - port: "8080"
        protocol: TCP
      rules:
        http:
        - method: "GET|POST|PUT|DELETE|PATCH"
          headers:
          - 'X-Tenant-ID: team-alpha'
```

## Admission Control for Tenant Safety

### OPA Gatekeeper Constraints

Enforce cross-tenant security policies that Capsule doesn't cover:

```yaml
# Constraint template: require all pods to have resource limits
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: requireresourcelimits
spec:
  crd:
    spec:
      names:
        kind: RequireResourceLimits
  targets:
  - target: admission.k8s.gatekeeper.sh
    rego: |
      package requireresourcelimits

      violation[{"msg": msg}] {
        container := input.review.object.spec.containers[_]
        not container.resources.limits.cpu
        msg := sprintf("Container %v must have CPU limits", [container.name])
      }

      violation[{"msg": msg}] {
        container := input.review.object.spec.containers[_]
        not container.resources.limits.memory
        msg := sprintf("Container %v must have memory limits", [container.name])
      }
---
# Apply constraint to tenant namespaces
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: RequireResourceLimits
metadata:
  name: require-limits-in-tenant-namespaces
spec:
  match:
    namespaceSelector:
      matchExpressions:
      - key: capsule.clastix.io/tenant
        operator: Exists
```

## Tenant Lifecycle Management

Capsule supports tenant lifecycle events through `GlobalTenantResource` for cluster-scoped resources:

```yaml
apiVersion: capsule.clastix.io/v1beta2
kind: GlobalTenantResource
metadata:
  name: tenant-monitoring-stack
spec:
  tenantSelector:
    matchLabels:
      monitoring: enabled
  resources:
  - namespaceSelector:
      matchLabels:
        capsule.clastix.io/tenant: ".*"
    rawItems:
    - apiVersion: monitoring.coreos.com/v1
      kind: ServiceMonitor
      metadata:
        name: tenant-app-monitoring
      spec:
        selector:
          matchLabels:
            monitored: "true"
        endpoints:
        - port: metrics
          interval: 30s
```

## Choosing Between Capsule and vcluster

| Criterion | Capsule | vcluster |
|---|---|---|
| Isolation level | Namespace (soft) | Virtual cluster (strong) |
| Tenant CRD control | No | Yes — full CRD freedom |
| API server overhead | None | ~500MB RAM per tenant |
| Max tenants on cluster | Thousands | ~100 (resource-limited) |
| Tenant kubernetes version | Host version | Independent (k3s inside) |
| Tenant node access | Via host policies | Host node pools |
| Blast radius | Namespace escape risk | Limited to vcluster pod |
| Compliance isolation | Sufficient for SoC2 | Better for PCI/HIPAA |

Production platforms often use both: Capsule for developer teams sharing infrastructure, and vcluster for customers or regulated workloads that require stronger isolation guarantees. The key is matching the isolation model to the actual threat model and compliance requirements rather than defaulting to maximum isolation everywhere.
