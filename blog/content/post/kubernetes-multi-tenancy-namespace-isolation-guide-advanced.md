---
title: "Kubernetes Multi-Tenancy: Namespace Isolation, Resource Quotas, and Virtual Clusters"
date: 2028-05-19T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Multi-tenancy", "Namespace", "ResourceQuota", "NetworkPolicy", "vcluster", "HNC"]
categories: ["Kubernetes", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide to Kubernetes multi-tenancy: namespace isolation patterns, ResourceQuota and LimitRange configuration, network policies, hierarchical namespaces with HNC, and virtual clusters with vcluster."
more_link: "yes"
url: "/kubernetes-multi-tenancy-namespace-isolation-guide-advanced/"
---

Kubernetes was not designed as a multi-tenant platform. A single cluster serves multiple teams efficiently, but without deliberate isolation, any namespace can starve others of resources, compromise security through misconfigured RBAC, or interfere with networking. Enterprise multi-tenancy requires layered controls: resource governance through quotas, security isolation through RBAC and admission policies, network segmentation through NetworkPolicy, and for the strongest isolation requirements, virtual cluster separation with vcluster. This guide covers the complete isolation stack.

<!--more-->

## Multi-Tenancy Models

Before selecting tooling, clarify the isolation model required:

**Soft multi-tenancy** (trusted tenants): Teams within the same organization share a cluster. Full API server access to their namespaces. Risk of resource exhaustion and misconfiguration is acceptable. Primary controls: RBAC, ResourceQuota, NetworkPolicy.

**Hard multi-tenancy** (untrusted tenants): External customers or teams with conflicting trust levels share infrastructure. Must prevent cross-tenant data access, API server side-channel attacks, and resource interference. Controls: all of soft multi-tenancy plus pod security standards, OPA/Gatekeeper policies, dedicated node pools, potentially vcluster.

**Virtual clusters** (maximum isolation): Each tenant gets a full Kubernetes control plane running in the host cluster. Tenants can deploy CRDs, modify admission webhooks, and manage their own namespaces without affecting others. Used for CI/CD environments, development sandboxes, and customer-facing Kubernetes as a service.

## Namespace Architecture Patterns

### Team-per-Namespace (Flat)

```bash
kubectl create namespace team-payments
kubectl create namespace team-commerce
kubectl create namespace team-platform
kubectl create namespace team-analytics
```

Simple to reason about, hard to scale past ~50 teams. Each namespace gets its own quotas and RBAC.

### Environment-per-Namespace (Flat)

```bash
kubectl create namespace payments-dev
kubectl create namespace payments-staging
kubectl create namespace payments-prod
```

Separation of environment lifecycle. Works well for smaller organizations.

### Hierarchical Namespace Controller (HNC)

HNC enables namespace hierarchies where child namespaces inherit RBAC and policies from parents:

```bash
# Install HNC
kubectl apply -f https://github.com/kubernetes-sigs/hierarchical-namespaces/releases/download/v1.1.0/default.yaml

# Create parent namespace
kubectl create namespace teams

# Create child namespaces
kubectl hns create payments -n teams
kubectl hns create commerce -n teams
kubectl hns create analytics -n teams

# View hierarchy
kubectl hns tree teams
# teams
# ├── [s] payments
# ├── [s] commerce
# └── [s] analytics
```

With HNC, RBAC roles in `teams` propagate to all child namespaces:

```yaml
# This RoleBinding in 'teams' propagates to payments, commerce, analytics
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: platform-team-admin
  namespace: teams
  annotations:
    hnc.x-k8s.io/inherited-from: teams
subjects:
- kind: Group
  name: platform-admins
  apiGroup: rbac.authorization.k8s.io
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: admin
```

Propagate ResourceQuota templates:

```yaml
apiVersion: hnc.x-k8s.io/v1alpha2
kind: HNCConfiguration
metadata:
  name: config
spec:
  resources:
  - resource: resourcequotas
    mode: Propagate
  - resource: limitranges
    mode: Propagate
  - resource: networkpolicies
    mode: Propagate
  - resource: roles
    mode: Propagate
  - resource: rolebindings
    mode: Propagate
```

## ResourceQuota: Resource Governance

ResourceQuota enforces limits per namespace on compute, storage, and object counts:

### Comprehensive Production Quota

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: payments-team-quota
  namespace: team-payments
spec:
  hard:
    # Compute
    requests.cpu: "20"              # Total CPU requests across all pods
    requests.memory: 40Gi           # Total memory requests
    limits.cpu: "40"                # Total CPU limits
    limits.memory: 80Gi             # Total memory limits

    # Storage
    requests.storage: 500Gi         # Total PVC storage
    persistentvolumeclaims: "20"    # Number of PVCs

    # Object counts
    pods: "100"
    services: "20"
    secrets: "50"
    configmaps: "50"
    deployments.apps: "30"
    statefulsets.apps: "10"
    jobs.batch: "20"

    # Service type restrictions
    services.loadbalancers: "3"
    services.nodeports: "0"         # No NodePort services
```

### Storage Class Quotas

Restrict expensive storage classes:

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: storage-class-quota
  namespace: team-payments
spec:
  hard:
    # Fast SSD storage limited
    premium-ssd.storageclass.storage.k8s.io/requests.storage: 100Gi
    premium-ssd.storageclass.storage.k8s.io/persistentvolumeclaims: "5"

    # Standard storage more generous
    standard.storageclass.storage.k8s.io/requests.storage: 1Ti
    standard.storageclass.storage.k8s.io/persistentvolumeclaims: "50"
```

### Priority Class Quotas

Prevent teams from monopolizing high-priority resources:

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: priority-quota
  namespace: team-analytics
spec:
  scopeSelector:
    matchExpressions:
    - scopeName: PriorityClass
      operator: In
      values:
      - high-priority
      - critical
  hard:
    pods: "10"
    requests.cpu: "8"
    requests.memory: 16Gi
```

### Monitoring Quota Usage

```bash
# Check quota usage
kubectl describe resourcequota -n team-payments

# Script to alert on quota approaching limits
kubectl get resourcequota -A -o json | jq -r '
  .items[] |
  .metadata.namespace as $ns |
  .metadata.name as $name |
  .status.hard as $hard |
  .status.used as $used |
  to_entries |
  map(
    select(.key | startswith("requests.cpu") or startswith("requests.memory")) |
    {
      namespace: $ns,
      quota: $name,
      resource: .key,
      used: ($used[.key] // "0"),
      hard: $hard[.key]
    }
  )[] |
  "\(.namespace)/\(.quota): \(.resource) = \(.used) / \(.hard)"
'
```

## LimitRange: Container Defaults and Constraints

LimitRange enforces minimum/maximum resource requests and provides defaults for containers that don't specify resources:

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: payments-limits
  namespace: team-payments
spec:
  limits:
  # Container-level limits
  - type: Container
    default:
      cpu: 500m
      memory: 512Mi
    defaultRequest:
      cpu: 100m
      memory: 128Mi
    max:
      cpu: "8"
      memory: 16Gi
    min:
      cpu: 50m
      memory: 64Mi
    maxLimitRequestRatio:
      cpu: "10"          # limit:request ratio cannot exceed 10x
      memory: "4"        # Prevents extreme bursting

  # Pod-level aggregate limits
  - type: Pod
    max:
      cpu: "16"
      memory: 32Gi

  # PVC size limits
  - type: PersistentVolumeClaim
    max:
      storage: 100Gi
    min:
      storage: 1Gi
```

## RBAC Design for Multi-Tenancy

### Team-Scoped Roles

```yaml
# Namespace-scoped developer role
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: developer
  namespace: team-payments
rules:
# Full access to workloads
- apiGroups: ["apps"]
  resources: ["deployments", "replicasets", "statefulsets", "daemonsets"]
  verbs: ["get", "list", "watch", "create", "update", "patch"]
- apiGroups: [""]
  resources: ["pods", "services", "configmaps", "serviceaccounts"]
  verbs: ["get", "list", "watch", "create", "update", "patch"]
# Read-only access to secrets (no create/update)
- apiGroups: [""]
  resources: ["secrets"]
  verbs: ["get", "list", "watch"]
# Pod exec for debugging (restrict in production)
- apiGroups: [""]
  resources: ["pods/exec", "pods/portforward"]
  verbs: ["create"]
# Read logs
- apiGroups: [""]
  resources: ["pods/log"]
  verbs: ["get", "list"]
# HPA management
- apiGroups: ["autoscaling"]
  resources: ["horizontalpodautoscalers"]
  verbs: ["get", "list", "watch", "create", "update", "patch"]
---
# Read-only role for observability/auditing
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: viewer
  namespace: team-payments
rules:
- apiGroups: ["", "apps", "batch", "autoscaling"]
  resources: ["*"]
  verbs: ["get", "list", "watch"]
- apiGroups: [""]
  resources: ["secrets"]
  verbs: []  # No secret access for viewers
```

### Binding with Group-based RBAC (OIDC)

```yaml
# Bind entire team via OIDC group
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: payments-developers
  namespace: team-payments
subjects:
- kind: Group
  name: "payments-eng@example.com"   # OIDC group claim
  apiGroup: rbac.authorization.k8s.io
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: developer
---
# CI/CD service account with deployment rights
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: cicd-deployer
  namespace: team-payments
subjects:
- kind: ServiceAccount
  name: github-actions-deployer
  namespace: team-payments
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: edit   # Built-in ClusterRole, no secret access
```

## Network Policy: Tenant Network Isolation

By default, all pods in a Kubernetes cluster can communicate with all other pods. NetworkPolicy enforces isolation:

### Default Deny Pattern

Apply to every tenant namespace to start with zero connectivity:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: team-payments
spec:
  podSelector: {}    # Matches all pods in namespace
  policyTypes:
  - Ingress
  - Egress
```

### Allow Intra-Namespace Communication

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-same-namespace
  namespace: team-payments
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  - Egress
  ingress:
  - from:
    - podSelector: {}     # All pods in same namespace
  egress:
  - to:
    - podSelector: {}     # All pods in same namespace
```

### Allow Specific Cross-Namespace Communication

```yaml
# Allow payments to call the shared auth service
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-auth-service
  namespace: team-payments
spec:
  podSelector:
    matchLabels:
      app: payments-api
  policyTypes:
  - Egress
  egress:
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: shared-services
      podSelector:
        matchLabels:
          app: auth-service
    ports:
    - protocol: TCP
      port: 8080
```

### Allow DNS and Monitoring

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns-monitoring
  namespace: team-payments
spec:
  podSelector: {}
  policyTypes:
  - Egress
  egress:
  # Allow DNS resolution
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
      podSelector:
        matchLabels:
          k8s-app: kube-dns
    ports:
    - protocol: UDP
      port: 53
    - protocol: TCP
      port: 53
  # Allow Prometheus scraping
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: monitoring
      podSelector:
        matchLabels:
          app: prometheus
    ports:
    - protocol: TCP
      port: 9090
```

### Allow Internet Egress (Selective)

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-internet-egress
  namespace: team-payments
spec:
  podSelector:
    matchLabels:
      internet-egress: allowed
  policyTypes:
  - Egress
  egress:
  - to:
    - ipBlock:
        cidr: 0.0.0.0/0
        except:
        - 10.0.0.0/8        # RFC1918 - internal cluster
        - 172.16.0.0/12     # RFC1918
        - 192.168.0.0/16    # RFC1918
        - 169.254.0.0/16    # Link-local
    ports:
    - protocol: TCP
      port: 443
```

## Pod Security Standards

Kubernetes Pod Security Standards replaced PodSecurityPolicy in v1.25:

```yaml
# Label namespace with security standard
apiVersion: v1
kind: Namespace
metadata:
  name: team-payments
  labels:
    # Enforce: Pods that don't meet the standard are rejected
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: v1.29
    # Audit: Log violations but allow
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/audit-version: v1.29
    # Warn: Show user-facing warnings
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/warn-version: v1.29
```

The `restricted` profile requires:
- No privileged containers
- No privilege escalation
- Run as non-root user
- seccompProfile set to RuntimeDefault or Localhost
- No hostPID, hostIPC, hostNetwork
- Drop ALL capabilities (can add specific ones back)

For namespaces that need elevated permissions (monitoring, storage):

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: monitoring
  labels:
    pod-security.kubernetes.io/enforce: privileged
    pod-security.kubernetes.io/audit: privileged
```

## OPA/Gatekeeper for Custom Policies

For policies beyond standard RBAC and PSS, Gatekeeper enables custom enforcement:

```yaml
# Require all images to come from approved registries
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: allowedimageregistries
spec:
  crd:
    spec:
      names:
        kind: AllowedImageRegistries
      validation:
        openAPIV3Schema:
          type: object
          properties:
            allowedRegistries:
              type: array
              items:
                type: string
  targets:
  - target: admission.k8s.gatekeeper.sh
    rego: |
      package allowedimageregistries

      violation[{"msg": msg}] {
        container := input.review.object.spec.containers[_]
        not starts_with_allowed(container.image)
        msg := sprintf("Image '%v' is not from an allowed registry", [container.image])
      }

      starts_with_allowed(image) {
        allowed := input.parameters.allowedRegistries[_]
        startswith(image, allowed)
      }
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: AllowedImageRegistries
metadata:
  name: require-approved-registries
spec:
  match:
    kinds:
    - apiGroups: [""]
      kinds: ["Pod"]
    namespaceSelector:
      matchLabels:
        enforce-registry-policy: "true"
  parameters:
    allowedRegistries:
    - "registry.example.com/"
    - "gcr.io/google-containers/"
    - "registry.k8s.io/"
```

```yaml
# Require resource requests and limits on all containers
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: containerresourcerequirements
spec:
  crd:
    spec:
      names:
        kind: ContainerResourceRequirements
  targets:
  - target: admission.k8s.gatekeeper.sh
    rego: |
      package containerresourcerequirements

      violation[{"msg": msg}] {
        container := input.review.object.spec.containers[_]
        not container.resources.requests.cpu
        msg := sprintf("Container '%v' missing CPU request", [container.name])
      }

      violation[{"msg": msg}] {
        container := input.review.object.spec.containers[_]
        not container.resources.requests.memory
        msg := sprintf("Container '%v' missing memory request", [container.name])
      }

      violation[{"msg": msg}] {
        container := input.review.object.spec.containers[_]
        not container.resources.limits.memory
        msg := sprintf("Container '%v' missing memory limit", [container.name])
      }
```

## Virtual Clusters with vcluster

vcluster runs a full Kubernetes control plane as a pod inside the host cluster. Each virtual cluster is completely isolated at the Kubernetes API level:

```bash
# Install vcluster CLI
curl -L -o vcluster "https://github.com/loft-sh/vcluster/releases/latest/download/vcluster-linux-amd64"
chmod +x vcluster && mv vcluster /usr/local/bin/

# Create a virtual cluster for team payments
vcluster create payments-dev \
  --namespace vcluster-payments-dev \
  --connect=false \
  --chart-version="0.20.0" \
  --values payments-dev-values.yaml
```

```yaml
# payments-dev-values.yaml
sync:
  ingresses:
    enabled: true
  persistentvolumes:
    enabled: true
  storageclasses:
    enabled: false    # Use host storage classes

controlPlane:
  distro:
    k8s:
      enabled: true
      version: "1.29"
  coredns:
    enabled: true
  statefulSet:
    resources:
      requests:
        cpu: 200m
        memory: 256Mi
      limits:
        cpu: 1000m
        memory: 1Gi

policies:
  resourceQuota:
    enabled: true
    quota:
      requests.cpu: "10"
      requests.memory: 20Gi
      limits.cpu: "20"
      limits.memory: 40Gi
      pods: "100"

networking:
  resolveDNS:
    - hostname: "*.svc.cluster.local"
      target:
        vCluster:
          name: payments-dev
          namespace: vcluster-payments-dev
```

### Connecting to a Virtual Cluster

```bash
# Connect and set as current context
vcluster connect payments-dev -n vcluster-payments-dev

# The vcluster is fully functional
kubectl get nodes
# NAME                 STATUS   ROLES           AGE   VERSION
# vcluster-node-xxxx   Ready    control-plane   2m    v1.29.0

# Deploy CRDs that would be blocked on shared cluster
kubectl apply -f my-operator-crds.yaml

# Namespaces are isolated to this virtual cluster
kubectl create namespace my-app
```

### vcluster with GitOps

```yaml
# ArgoCD Application for virtual cluster provisioning
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: vcluster-team-analytics
  namespace: argocd
spec:
  project: platform
  source:
    repoURL: https://charts.loft.sh
    chart: vcluster
    targetRevision: "0.20.0"
    helm:
      values: |
        sync:
          ingresses:
            enabled: true
        controlPlane:
          statefulSet:
            resources:
              requests:
                cpu: 200m
                memory: 256Mi
  destination:
    server: https://kubernetes.default.svc
    namespace: vcluster-analytics
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
    - CreateNamespace=true
```

## Namespace Provisioning Automation

For large environments, automate namespace creation with a controller or GitOps:

```yaml
# Namespace template via Helm
# charts/tenant-namespace/templates/namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: {{ .Values.team }}-{{ .Values.environment }}
  labels:
    team: {{ .Values.team }}
    environment: {{ .Values.environment }}
    pod-security.kubernetes.io/enforce: {{ .Values.podSecurity | default "restricted" }}
    gateway.networking.k8s.io/route-allowed: "true"
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: team-quota
  namespace: {{ .Values.team }}-{{ .Values.environment }}
spec:
  hard:
    requests.cpu: {{ .Values.quota.cpuRequests | quote }}
    requests.memory: {{ .Values.quota.memoryRequests }}
    limits.cpu: {{ .Values.quota.cpuLimits | quote }}
    limits.memory: {{ .Values.quota.memoryLimits }}
    pods: {{ .Values.quota.pods | quote }}
---
apiVersion: v1
kind: LimitRange
metadata:
  name: defaults
  namespace: {{ .Values.team }}-{{ .Values.environment }}
spec:
  limits:
  - type: Container
    default:
      cpu: 500m
      memory: 512Mi
    defaultRequest:
      cpu: 100m
      memory: 128Mi
---
# Network Policy: default deny
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: {{ .Values.team }}-{{ .Values.environment }}
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  - Egress
---
# Allow DNS and intra-namespace
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns-intranamespace
  namespace: {{ .Values.team }}-{{ .Values.environment }}
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  - Egress
  ingress:
  - from:
    - podSelector: {}
  egress:
  - to:
    - podSelector: {}
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
    ports:
    - protocol: UDP
      port: 53
```

Provision namespaces via values files in a GitOps repository:

```yaml
# gitops/tenants/team-payments-prod.yaml
team: payments
environment: prod
podSecurity: restricted
quota:
  cpuRequests: "20"
  cpuLimits: "40"
  memoryRequests: 40Gi
  memoryLimits: 80Gi
  pods: "100"
```

## Chargeback and Cost Attribution

Label resources for cost attribution:

```yaml
# Required labels enforced by Gatekeeper
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: RequiredLabels
metadata:
  name: require-cost-labels
spec:
  match:
    kinds:
    - apiGroups: ["apps"]
      kinds: ["Deployment", "StatefulSet"]
  parameters:
    labels:
    - key: "cost-center"
    - key: "team"
    - key: "environment"
```

Query cost allocation:

```bash
# Get CPU requests by team (for chargeback)
kubectl get pods -A -o json | jq -r '
  .items[] |
  select(.metadata.labels.team != null) |
  [
    .metadata.labels.team,
    .metadata.labels.environment // "unknown",
    (.spec.containers[].resources.requests.cpu // "0")
  ] | @csv
' | sort | uniq -c
```

## Summary

Kubernetes multi-tenancy is a layered problem with no single solution. ResourceQuota and LimitRange prevent resource starvation. RBAC with namespace-scoped roles limits blast radius from misconfigurations. NetworkPolicy enforces network segmentation between tenants. Pod Security Standards eliminate privileged container risks. HNC simplifies policy inheritance in hierarchical organizations. For maximum isolation - CI/CD environments, customer-facing Kubernetes, or teams needing CRD management - vcluster delivers full control plane isolation without separate physical clusters. The right combination depends on trust model, scale, and operational complexity tolerance.
