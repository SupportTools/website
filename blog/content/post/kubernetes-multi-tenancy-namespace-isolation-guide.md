---
title: "Kubernetes Multi-Tenancy: Namespace Isolation, Resource Quotas, and Network Policies"
date: 2027-04-29T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Multi-Tenancy", "Namespace", "RBAC", "Network Policy", "Resource Quota"]
categories: ["Kubernetes", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide to Kubernetes multi-tenancy patterns including soft multi-tenancy with namespaces, hard multi-tenancy with virtual clusters, resource isolation, RBAC design, and network segmentation."
more_link: "yes"
url: "/kubernetes-multi-tenancy-namespace-isolation-guide/"
---

Kubernetes was designed as a single-tenant system that later evolved to support multiple tenants through a layered set of isolation primitives. Understanding where these layers provide genuine isolation and where they provide only soft boundaries is critical for making sound architectural decisions. Running SaaS tenants, internal engineering teams, or regulated workloads on shared infrastructure each demands a different combination of isolation techniques.

This guide covers the full spectrum from lightweight namespace-per-team patterns to hard isolation with virtual clusters, with production-ready configurations for each layer of the isolation stack.

<!--more-->

# Multi-Tenancy Models in Kubernetes

## Soft Multi-Tenancy vs Hard Multi-Tenancy

**Soft multi-tenancy** uses Kubernetes-native constructs — namespaces, RBAC, NetworkPolicies, ResourceQuotas — to create logical boundaries between tenants. These boundaries are enforced by the Kubernetes control plane and are appropriate when tenants are internal teams that are trusted not to intentionally subvert cluster security.

**Hard multi-tenancy** uses kernel-level isolation (separate nodes, virtual clusters, or hypervisor-level separation) to create boundaries that remain secure even if a tenant actively attempts to escape their namespace. This is required when tenants are external customers, when compliance mandates physical separation, or when tenants run untrusted code.

```
┌──────────────────────────────────────────────────────────────────────┐
│              Multi-Tenancy Isolation Spectrum                       │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  SOFT ◄─────────────────────────────────────────────────► HARD      │
│                                                                      │
│  Namespace + RBAC    │   Node pools    │   vCluster   │  Separate   │
│  NetworkPolicy        │   + taints/     │   (virtual   │  clusters   │
│  ResourceQuota        │   tolerations   │   k8s)       │             │
│                       │                │              │             │
│  Single cluster       │  Single cluster│  Single      │  Per-tenant │
│  Shared nodes         │  Dedicated     │  cluster,    │  clusters   │
│  Shared kernel        │  nodes per     │  separate    │             │
│                       │  tenant        │  API server  │             │
│                       │                │              │             │
│  Cost: Low            │  Cost: Medium  │  Cost: Med   │  Cost: High │
│  Isolation: Weak      │  Isolation: Med│  Isolation:  │  Isolation: │
│                       │                │  Med-High    │  High       │
└──────────────────────────────────────────────────────────────────────┘
```

## Threat Model for Each Pattern

Before selecting an isolation model, define the threats:

- **Noisy neighbor:** A tenant consumes disproportionate CPU/memory → Mitigated by ResourceQuota + LimitRange
- **Network access:** A tenant's pod reaches another tenant's service → Mitigated by NetworkPolicy
- **Secret enumeration:** A tenant lists another tenant's Secrets → Mitigated by RBAC namespace isolation
- **Node escape:** A tenant exploits a kernel vulnerability to access another tenant's data → Requires dedicated nodes or separate clusters
- **API server abuse:** A tenant spams API calls to degrade control plane → Mitigated by API priority and fairness

# Namespace Architecture Patterns

## Namespace Per Team Pattern

The most common soft multi-tenancy pattern: one namespace per engineering team, with RBAC giving each team admin access to their namespace and read-only access to shared monitoring.

```bash
# Namespace provisioning script for team onboarding
#!/bin/bash
TEAM_NAME="${1}"
TEAM_EMAIL="${2}"

if [ -z "${TEAM_NAME}" ] || [ -z "${TEAM_EMAIL}" ]; then
  echo "Usage: $0 <team-name> <team-email>"
  exit 1
fi

# Create namespace with standard labels for policy enforcement
kubectl create namespace "${TEAM_NAME}" \
  --dry-run=client -o yaml | \
  kubectl apply -f -

kubectl label namespace "${TEAM_NAME}" \
  team="${TEAM_NAME}" \
  env=production \
  cost-center="${TEAM_NAME}" \
  network-policy.my-org.io/tenant=true \
  pod-security.kubernetes.io/enforce=restricted \
  pod-security.kubernetes.io/enforce-version=latest \
  pod-security.kubernetes.io/warn=restricted \
  pod-security.kubernetes.io/warn-version=latest

# Apply standard resource quota
kubectl apply -f - <<EOF
apiVersion: v1
kind: ResourceQuota
metadata:
  name: team-quota
  namespace: ${TEAM_NAME}
spec:
  hard:
    # Compute resources
    requests.cpu: "20"
    requests.memory: 40Gi
    limits.cpu: "40"
    limits.memory: 80Gi
    # Storage
    requests.storage: 500Gi
    persistentvolumeclaims: "20"
    # Object counts
    pods: "100"
    services: "20"
    services.loadbalancers: "2"
    services.nodeports: "0"
    configmaps: "50"
    secrets: "50"
    replicationcontrollers: "0"
    # No cluster-scoped resources
    count/clusterroles.rbac.authorization.k8s.io: "0"
    count/clusterrolebindings.rbac.authorization.k8s.io: "0"
EOF

echo "Namespace ${TEAM_NAME} provisioned"
```

## Namespace Per Environment Pattern

Some organizations prefer environment-scoped namespaces rather than team-scoped ones. This maps better to promotion workflows but creates cross-namespace dependencies.

```yaml
# namespace-per-environment-structure.yaml
# Pattern: <service>-<environment>
# payments-production, payments-staging, payments-development
---
apiVersion: v1
kind: Namespace
metadata:
  name: payments-production
  labels:
    team: payments
    environment: production
    tier: production
    pod-security.kubernetes.io/enforce: restricted
---
apiVersion: v1
kind: Namespace
metadata:
  name: payments-staging
  labels:
    team: payments
    environment: staging
    tier: non-production
    pod-security.kubernetes.io/enforce: baseline
---
apiVersion: v1
kind: Namespace
metadata:
  name: payments-development
  labels:
    team: payments
    environment: development
    tier: non-production
    pod-security.kubernetes.io/enforce: privileged
```

## Hierarchical Namespace Controller (HNC)

The Hierarchical Namespace Controller (HNC) enables namespace hierarchies where child namespaces inherit policies from parent namespaces. This eliminates the need to duplicate RoleBindings, LimitRanges, and NetworkPolicies across every team namespace.

```bash
# Install HNC
kubectl apply -f https://github.com/kubernetes-sigs/hierarchical-namespaces/releases/download/v1.1.0/default.yaml

# Wait for HNC to be ready
kubectl -n hnc-system rollout status deployment/hnc-controller-manager
```

```yaml
# hnc-namespace-hierarchy.yaml
---
# Create a parent namespace for the platform team
apiVersion: v1
kind: Namespace
metadata:
  name: platform
  labels:
    hnc.x-k8s.io/managed-by: hnc
---
# Create child namespaces that inherit from platform
apiVersion: hnc.x-k8s.io/v1alpha2
kind: SubnamespaceAnchor
metadata:
  name: platform-monitoring
  namespace: platform
---
apiVersion: hnc.x-k8s.io/v1alpha2
kind: SubnamespaceAnchor
metadata:
  name: platform-logging
  namespace: platform
---
# Configure what objects propagate from parent to children
apiVersion: hnc.x-k8s.io/v1alpha2
kind: HNCConfiguration
metadata:
  name: config
spec:
  resources:
    - resource: roles
      mode: Propagate
    - resource: rolebindings
      mode: Propagate
    - resource: networkpolicies
      mode: Propagate
    - resource: limitranges
      mode: Propagate
    - resource: configmaps
      mode: Propagate
    # Do NOT propagate resourcequotas (child quotas are independent)
    - resource: resourcequotas
      mode: Ignore
```

# Resource Isolation

## LimitRange Configuration

LimitRanges set per-container and per-namespace resource defaults and maximums. They prevent containers without resource requests from being scheduled without limits, which is a common cause of noisy neighbor incidents.

```yaml
# limitrange-standard.yaml
---
apiVersion: v1
kind: LimitRange
metadata:
  name: standard-limits
  namespace: team-payments
spec:
  limits:
    # Container-level limits
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
      min:
        cpu: "10m"
        memory: "32Mi"
      maxLimitRequestRatio:
        cpu: "10"     # limit can be at most 10x the request
        memory: "4"   # limit can be at most 4x the request

    # Pod-level aggregate limits
    - type: Pod
      max:
        cpu: "8"
        memory: "16Gi"
      min:
        cpu: "10m"
        memory: "32Mi"

    # PVC size limits
    - type: PersistentVolumeClaim
      max:
        storage: "50Gi"
      min:
        storage: "1Gi"
```

## ResourceQuota Design by Tier

Different tenants should have different quota profiles based on their workload patterns. Production tenants need higher limits; development tenants should be constrained to prevent runaway resource consumption.

```yaml
# resourcequota-production.yaml
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: production-quota
  namespace: payments-production
spec:
  hard:
    # Compute
    requests.cpu: "32"
    requests.memory: 64Gi
    limits.cpu: "64"
    limits.memory: 128Gi

    # GPU (if applicable)
    requests.nvidia.com/gpu: "4"

    # Storage
    requests.storage: 2Ti
    persistentvolumeclaims: "50"
    # Only allow fast SSD storage class in production
    fast-ssd.storageclass.storage.k8s.io/requests.storage: 2Ti
    fast-ssd.storageclass.storage.k8s.io/persistentvolumeclaims: "50"
    # Deny slow storage in production
    slow-hdd.storageclass.storage.k8s.io/requests.storage: "0"

    # Object limits
    pods: "200"
    services: "50"
    secrets: "100"
    configmaps: "100"
    replicationcontrollers: "0"
    services.nodeports: "0"
    services.loadbalancers: "5"
```

```yaml
# resourcequota-development.yaml
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: development-quota
  namespace: payments-development
spec:
  hard:
    requests.cpu: "4"
    requests.memory: 8Gi
    limits.cpu: "8"
    limits.memory: 16Gi
    requests.storage: 100Gi
    persistentvolumeclaims: "10"
    pods: "30"
    services: "15"
    secrets: "30"
    configmaps: "30"
    services.loadbalancers: "0"   # No external LBs in dev
    services.nodeports: "0"
```

## ResourceQuota Scopes for Priority Classes

```yaml
# resourcequota-priority-scoped.yaml
---
# Limit how many pods can be scheduled as high-priority in this namespace.
# Without this, a team could mark all pods as high-priority, starving
# other tenants during node pressure events.
apiVersion: v1
kind: ResourceQuota
metadata:
  name: priority-limits
  namespace: team-payments
spec:
  hard:
    pods: "10"
    requests.cpu: "8"
    requests.memory: 16Gi
  scopeSelector:
    matchExpressions:
      - operator: In
        scopeName: PriorityClass
        values:
          - high-priority
          - critical
---
# Best-effort pods get a separate, tighter quota
apiVersion: v1
kind: ResourceQuota
metadata:
  name: best-effort-limits
  namespace: team-payments
spec:
  hard:
    pods: "5"
  scopes:
    - BestEffort
```

# RBAC for Tenant Isolation

## Role Design for Namespace Administrators

```yaml
# tenant-rbac.yaml
---
# Namespace admin role: full control within the namespace
# but cannot escalate to cluster-level resources
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: namespace-admin
  namespace: team-payments
rules:
  # Core workload resources
  - apiGroups: ["apps"]
    resources:
      - deployments
      - statefulsets
      - daemonsets
      - replicasets
    verbs: ["*"]
  - apiGroups: [""]
    resources:
      - pods
      - pods/log
      - pods/exec
      - pods/portforward
      - services
      - endpoints
      - configmaps
      - persistentvolumeclaims
      - serviceaccounts
    verbs: ["*"]
  # Secrets: no list to prevent bulk enumeration
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get", "create", "update", "patch", "delete", "watch"]
  # Networking
  - apiGroups: ["networking.k8s.io"]
    resources: ["ingresses", "networkpolicies"]
    verbs: ["*"]
  # Autoscaling
  - apiGroups: ["autoscaling"]
    resources: ["horizontalpodautoscalers"]
    verbs: ["*"]
  # Batch
  - apiGroups: ["batch"]
    resources: ["jobs", "cronjobs"]
    verbs: ["*"]
  # Policy
  - apiGroups: ["policy"]
    resources: ["poddisruptionbudgets"]
    verbs: ["*"]
  # Read events for debugging
  - apiGroups: [""]
    resources: ["events"]
    verbs: ["get", "list", "watch"]
  # View (but not modify) resource quotas and limit ranges
  - apiGroups: [""]
    resources: ["resourcequotas", "limitranges"]
    verbs: ["get", "list", "watch"]
---
# Read-only role for developers who need to inspect but not change
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: namespace-viewer
  namespace: team-payments
rules:
  - apiGroups: ["", "apps", "batch", "autoscaling", "networking.k8s.io", "policy"]
    resources:
      - pods
      - pods/log
      - deployments
      - statefulsets
      - daemonsets
      - replicasets
      - services
      - endpoints
      - configmaps
      - persistentvolumeclaims
      - jobs
      - cronjobs
      - horizontalpodautoscalers
      - ingresses
      - networkpolicies
      - events
      - resourcequotas
      - limitranges
    verbs: ["get", "list", "watch"]
  # Explicitly no access to secrets
---
# CI/CD deployer role: deploy but not configure cluster networking or RBAC
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: deployer
  namespace: team-payments
rules:
  - apiGroups: ["apps"]
    resources:
      - deployments
      - statefulsets
    verbs: ["get", "list", "watch", "update", "patch"]
  - apiGroups: [""]
    resources:
      - pods
      - pods/log
      - configmaps
    verbs: ["get", "list", "watch", "create", "update", "patch"]
  # Can create/update secrets for deployment config (not list/enumerate)
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get", "create", "update", "patch"]
  - apiGroups: ["batch"]
    resources: ["jobs"]
    verbs: ["get", "list", "watch", "create", "delete"]
---
# Bind roles to groups
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: payments-team-admin
  namespace: team-payments
subjects:
  - kind: Group
    name: payments-team-leads
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: Role
  name: namespace-admin
  apiGroup: rbac.authorization.k8s.io
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: payments-team-viewer
  namespace: team-payments
subjects:
  - kind: Group
    name: payments-engineers
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: Role
  name: namespace-viewer
  apiGroup: rbac.authorization.k8s.io
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: payments-ci-deployer
  namespace: team-payments
subjects:
  - kind: ServiceAccount
    name: payments-ci-sa
    namespace: cicd-system
roleRef:
  kind: Role
  name: deployer
  apiGroup: rbac.authorization.k8s.io
```

## Preventing Privilege Escalation

RBAC alone is insufficient to prevent privilege escalation if service accounts have elevated permissions. The following patterns close common escalation paths.

```yaml
# service-account-hardening.yaml
---
# Workload service account with minimal permissions
apiVersion: v1
kind: ServiceAccount
metadata:
  name: payments-api
  namespace: team-payments
  annotations:
    # Prevent automatic token mounting (Kubernetes 1.24+)
    # Applications that need API access mount tokens explicitly
automountServiceAccountToken: false
---
# For workloads that DO need API access, use projected volume tokens
# with a short expiry and specific audiences
# (configured in the Pod spec, not the ServiceAccount)
# spec:
#   serviceAccountName: payments-api-reader
#   volumes:
#     - name: kube-api-token
#       projected:
#         sources:
#           - serviceAccountToken:
#               path: token
#               expirationSeconds: 3600
#               audience: kubernetes
```

```bash
# Audit: find all service accounts with cluster-level permissions
kubectl get clusterrolebindings -o json | \
  jq -r '.items[] | select(.subjects != null) |
    .subjects[] |
    select(.kind == "ServiceAccount") |
    "\(.namespace)/\(.name)"' | sort | uniq

# Audit: find service accounts with wildcard permissions
kubectl get roles,clusterroles -A -o json | \
  jq -r '.items[] |
    select(.rules != null) |
    .rules[] |
    select(.verbs[] == "*" or .resources[] == "*") |
    "WILDCARD: \(.)"'
```

# Network Policies for Namespace Segmentation

## Default Deny Pattern

The default-deny pattern requires every namespace to explicitly declare what traffic is allowed. Traffic not covered by a NetworkPolicy is denied, following a least-privilege model.

```yaml
# default-deny-all.yaml - Apply this to every tenant namespace
---
# Deny all ingress traffic
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-ingress
  namespace: team-payments
spec:
  podSelector: {}   # applies to all pods in the namespace
  policyTypes:
    - Ingress
---
# Deny all egress traffic
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-egress
  namespace: team-payments
spec:
  podSelector: {}
  policyTypes:
    - Egress
```

```yaml
# allow-namespace-internal.yaml
---
# Allow all traffic within the namespace (intra-tenant communication)
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-within-namespace
  namespace: team-payments
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - podSelector: {}   # any pod in THIS namespace
  egress:
    - to:
        - podSelector: {}   # any pod in THIS namespace
```

```yaml
# allow-dns-egress.yaml - DNS must be allowed explicitly
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns-egress
  namespace: team-payments
spec:
  podSelector: {}
  policyTypes:
    - Egress
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
        - podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
```

## Fine-Grained Cross-Namespace Policies

```yaml
# cross-namespace-access.yaml
---
# Allow the ingress controller to reach pods in this namespace
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-ingress-controller
  namespace: team-payments
spec:
  podSelector:
    matchLabels:
      app: payments-api
  policyTypes:
    - Ingress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ingress-nginx
        - podSelector:
            matchLabels:
              app.kubernetes.io/name: ingress-nginx
      ports:
        - protocol: TCP
          port: 8080
---
# Allow the payments namespace to reach the shared database namespace
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-egress-to-shared-db
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
              kubernetes.io/metadata.name: shared-databases
        - podSelector:
            matchLabels:
              db: payments-postgres
      ports:
        - protocol: TCP
          port: 5432
---
# Allow monitoring namespace to scrape metrics
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-prometheus-scrape
  namespace: team-payments
spec:
  podSelector: {}   # all pods may be scraped
  policyTypes:
    - Ingress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: monitoring
        - podSelector:
            matchLabels:
              app.kubernetes.io/name: prometheus
      ports:
        - protocol: TCP
          port: 9090   # metrics port
        - protocol: TCP
          port: 8080   # if app exposes metrics on 8080
```

## Egress to External Services

```yaml
# egress-to-internet.yaml
---
# Restrict egress to specific external services (CIDR-based)
# For FQDN-based policies, use a CNI that supports DNS-based policies
# (e.g., Cilium NetworkPolicy with toFQDNs)
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-egress-to-payment-gateway
  namespace: team-payments
spec:
  podSelector:
    matchLabels:
      role: payment-processor
  policyTypes:
    - Egress
  egress:
    # Stripe API CIDRs (example - verify current CIDRs with your provider)
    - to:
        - ipBlock:
            cidr: 54.187.174.169/32
        - ipBlock:
            cidr: 54.241.31.99/32
      ports:
        - protocol: TCP
          port: 443
```

# Admission Policies for Tenant Enforcement

## ValidatingAdmissionPolicy (Kubernetes 1.26+)

ValidatingAdmissionPolicies (CEL-based) provide policy enforcement without external admission webhooks, making them ideal for multi-tenancy constraints.

```yaml
# admission-policies-multitenancy.yaml
---
# Policy: Require all pods to have team labels
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: require-team-label
spec:
  failurePolicy: Fail
  matchConstraints:
    resourceRules:
      - apiGroups: [""]
        apiVersions: ["v1"]
        operations: ["CREATE", "UPDATE"]
        resources: ["pods"]
  validations:
    - expression: >
        has(object.metadata.labels) &&
        has(object.metadata.labels.team) &&
        object.metadata.labels.team != ""
      message: "Pods must have a 'team' label"
    - expression: >
        has(object.metadata.labels) &&
        has(object.metadata.labels['cost-center'])
      message: "Pods must have a 'cost-center' label for billing"
---
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicyBinding
metadata:
  name: require-team-label-binding
spec:
  policyName: require-team-label
  validationActions: [Deny]
  matchResources:
    namespaceSelector:
      matchExpressions:
        - key: network-policy.my-org.io/tenant
          operator: Exists
---
# Policy: Prevent containers from running as root in production namespaces
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: no-root-containers-production
spec:
  failurePolicy: Fail
  matchConstraints:
    resourceRules:
      - apiGroups: [""]
        apiVersions: ["v1"]
        operations: ["CREATE", "UPDATE"]
        resources: ["pods"]
  validations:
    - expression: >
        object.spec.containers.all(c,
          has(c.securityContext) &&
          has(c.securityContext.runAsNonRoot) &&
          c.securityContext.runAsNonRoot == true
        )
      message: "All containers must set securityContext.runAsNonRoot: true"
    - expression: >
        !has(object.spec.securityContext) ||
        !has(object.spec.securityContext.runAsUser) ||
        object.spec.securityContext.runAsUser > 0
      message: "Pod securityContext.runAsUser must not be 0 (root)"
---
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicyBinding
metadata:
  name: no-root-production-binding
spec:
  policyName: no-root-containers-production
  validationActions: [Deny]
  matchResources:
    namespaceSelector:
      matchLabels:
        tier: production
```

## OPA Gatekeeper Constraints

For more complex policies that CEL cannot express, OPA Gatekeeper provides Rego-based policy enforcement.

```yaml
# gatekeeper-constraint-template.yaml
---
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8srequiredtenantlabels
spec:
  crd:
    spec:
      names:
        kind: K8sRequiredTenantLabels
      validation:
        openAPIV3Schema:
          type: object
          properties:
            labels:
              type: array
              items:
                type: string
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8srequiredtenantlabels

        violation[{"msg": msg}] {
          provided := {label | input.review.object.metadata.labels[label]}
          required := {label | label := input.parameters.labels[_]}
          missing := required - provided
          count(missing) > 0
          msg := sprintf("Missing required tenant labels: %v", [missing])
        }
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequiredTenantLabels
metadata:
  name: require-tenant-labels-all-namespaces
spec:
  enforcementAction: deny
  match:
    kinds:
      - apiGroups: ["apps"]
        kinds: ["Deployment", "StatefulSet", "DaemonSet"]
    namespaceSelector:
      matchExpressions:
        - key: network-policy.my-org.io/tenant
          operator: Exists
  parameters:
    labels:
      - team
      - cost-center
      - environment
```

# Hard Multi-Tenancy with vCluster

## vCluster Architecture

vCluster creates a virtual Kubernetes API server running inside a namespace of the host cluster. Tenant workloads see a full Kubernetes API but are actually scheduled on the host cluster nodes via a syncer component. This provides API-level isolation without dedicated hardware.

```bash
# Install vcluster CLI
curl -L -o /usr/local/bin/vcluster \
  "https://github.com/loft-sh/vcluster/releases/latest/download/vcluster-linux-amd64"
chmod +x /usr/local/bin/vcluster

# Create a vcluster for a tenant
vcluster create tenant-alpha \
  --namespace tenant-alpha-vcluster \
  --values - <<'EOF'
# vcluster configuration
vcluster:
  image: rancher/k3s:v1.28.4-k3s1

# Syncer: control what resources sync from vcluster to host
sync:
  services:
    enabled: true
  configmaps:
    enabled: true
  persistentvolumeclaims:
    enabled: true
  ingresses:
    enabled: true
  # Nodes are NOT synced - pods see virtual nodes
  nodes:
    enabled: false
    syncAllNodes: false
    nodeSelector: "team=tenant-alpha"

# Resource isolation
resources:
  limits:
    cpu: "8"
    memory: 16Gi
  requests:
    cpu: "2"
    memory: 4Gi

# Networking: use host cluster's network
networking:
  replicateServices:
    toHost: []
    fromHost: []
EOF

# Get kubeconfig for the tenant
vcluster connect tenant-alpha --namespace tenant-alpha-vcluster \
  --kube-config /tmp/tenant-alpha.kubeconfig

# Verify tenant has their own API server
KUBECONFIG=/tmp/tenant-alpha.kubeconfig kubectl get nodes
KUBECONFIG=/tmp/tenant-alpha.kubeconfig kubectl get namespaces
```

```yaml
# vcluster-host-namespace-isolation.yaml
# Apply these to the host namespace that contains the vcluster
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: vcluster-quota
  namespace: tenant-alpha-vcluster
spec:
  hard:
    requests.cpu: "10"
    requests.memory: 20Gi
    limits.cpu: "20"
    limits.memory: 40Gi
    requests.storage: 500Gi
    pods: "150"   # all vcluster pods + synced tenant pods
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: vcluster-isolation
  namespace: tenant-alpha-vcluster
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
  ingress:
    # Allow traffic within the vcluster namespace
    - from:
        - podSelector: {}
  egress:
    # Allow within namespace
    - to:
        - podSelector: {}
    # Allow DNS
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
      ports:
        - port: 53
          protocol: UDP
    # Allow access to the host API server
    - to:
        - ipBlock:
            cidr: 10.0.0.1/32   # host API server IP
      ports:
        - port: 443
          protocol: TCP
```

# API Priority and Fairness

## Preventing API Server Starvation Between Tenants

Kubernetes API Priority and Fairness (APF) ensures that one tenant's API calls cannot starve another's. This is the control plane equivalent of ResourceQuotas.

```yaml
# apf-tenant-isolation.yaml
---
# FlowSchema: classify requests from tenant namespaces
apiVersion: flowcontrol.apiserver.k8s.io/v1beta3
kind: FlowSchema
metadata:
  name: tenant-workloads
spec:
  priorityLevelConfiguration:
    name: tenant-priority
  matchingPrecedence: 800
  distinguisherMethod:
    type: ByNamespace   # Each namespace gets its own flow
  rules:
    - subjects:
        - kind: ServiceAccount
          serviceAccount:
            namespace: "*"
            name: "*"
      resourceRules:
        - verbs: ["*"]
          apiGroups: ["*"]
          resources: ["*"]
          namespaces: ["*"]
---
# PriorityLevelConfiguration: define concurrency limits for tenant requests
apiVersion: flowcontrol.apiserver.k8s.io/v1beta3
kind: PriorityLevelConfiguration
metadata:
  name: tenant-priority
spec:
  type: Limited
  limited:
    # Maximum concurrent requests across all tenant namespaces
    nominalConcurrencyShares: 30
    limitResponse:
      type: Queue
      queuing:
        queues: 64
        handSize: 6
        queueLengthLimit: 50
```

# Monitoring Multi-Tenancy Health

## Per-Tenant Resource Consumption Dashboards

```yaml
# tenant-monitoring-alerts.yaml
---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: tenant-resource-alerts
  namespace: monitoring
spec:
  groups:
    - name: tenant-quota-health
      interval: 1m
      rules:
        # Alert when a namespace uses >90% of its CPU request quota
        - alert: NamespaceCPUQuotaUsageHigh
          expr: |
            (
              kube_resourcequota{resource="requests.cpu", type="used"}
              /
              kube_resourcequota{resource="requests.cpu", type="hard"}
            ) > 0.9
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Namespace {{ $labels.namespace }} CPU quota >90% used"
            description: "{{ $value | humanizePercentage }} of CPU request quota consumed in {{ $labels.namespace }}"

        # Alert when a namespace uses >90% of its memory request quota
        - alert: NamespaceMemoryQuotaUsageHigh
          expr: |
            (
              kube_resourcequota{resource="requests.memory", type="used"}
              /
              kube_resourcequota{resource="requests.memory", type="hard"}
            ) > 0.9
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Namespace {{ $labels.namespace }} memory quota >90% used"

        # Alert when pods are being rejected due to quota
        - alert: PodRejectedByQuota
          expr: |
            increase(kube_pod_created{phase="Failed"}[5m]) > 0
          labels:
            severity: warning
          annotations:
            summary: "Pod creation rejected in {{ $labels.namespace }}"
```

```bash
# Generate a per-tenant resource usage report
#!/bin/bash
echo "=== Tenant Resource Usage Report ==="
echo ""
printf "%-30s %-10s %-12s %-12s %-12s\n" "NAMESPACE" "PODS" "CPU REQ" "MEM REQ" "QUOTA%CPU"

kubectl get resourcequota --all-namespaces -o json | \
  jq -r '.items[] |
    "\(.metadata.namespace) \(.status.used["requests.cpu"] // "0") \(.status.used["requests.memory"] // "0") \(.status.hard["requests.cpu"] // "N/A")"' | \
  while read -r NS CPU_USED MEM_USED CPU_HARD; do
    POD_COUNT=$(kubectl get pods -n "${NS}" --no-headers 2>/dev/null | wc -l)
    printf "%-30s %-10s %-12s %-12s %-12s\n" \
      "${NS}" "${POD_COUNT}" "${CPU_USED}" "${MEM_USED}" "${CPU_HARD}"
  done
```

# Namespace Provisioning Automation

## Namespace-as-a-Service with a Controller

For large organizations, a custom controller automates namespace provisioning based on a `TenantNamespace` custom resource, eliminating manual provisioning steps.

```yaml
# tenant-namespace-crd.yaml
---
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: tenantnamespaces.platform.my-org.io
spec:
  group: platform.my-org.io
  names:
    kind: TenantNamespace
    listKind: TenantNamespaceList
    plural: tenantnamespaces
    singular: tenantnamespace
    shortNames: [tns]
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
              required: [team, environment, quotaTier]
              properties:
                team:
                  type: string
                  pattern: '^[a-z0-9-]+$'
                environment:
                  type: string
                  enum: [production, staging, development]
                quotaTier:
                  type: string
                  enum: [small, medium, large, xlarge]
                ownerEmail:
                  type: string
                costCenter:
                  type: string
            status:
              type: object
              properties:
                phase:
                  type: string
                namespace:
                  type: string
                message:
                  type: string
```

```yaml
# Example TenantNamespace request
---
apiVersion: platform.my-org.io/v1alpha1
kind: TenantNamespace
metadata:
  name: payments-production
spec:
  team: payments
  environment: production
  quotaTier: large
  ownerEmail: payments-team@my-org.io
  costCenter: PAYM-001
```

```bash
# Verify namespace was provisioned by the controller
kubectl get tenantnamespace payments-production -o yaml

# Check all resources created in the namespace
kubectl -n payments-production get \
  resourcequota,limitrange,networkpolicy,rolebinding -o wide

# Verify labels are set correctly for policy enforcement
kubectl get namespace payments-production --show-labels
```

Multi-tenancy in Kubernetes is not a single feature but a composition of overlapping isolation layers. The right combination depends entirely on the trust model between tenants. Internal engineering teams can share nodes safely with namespace-level isolation; external SaaS customers or regulated workloads require dedicated node pools or virtual clusters to meet both security and compliance requirements. ResourceQuotas and LimitRanges prevent noisy neighbor problems, NetworkPolicies enforce network segmentation, RBAC controls API access, and admission policies enforce organizational standards — together these create a multi-tenant environment that remains manageable as the number of tenants and applications grows.
