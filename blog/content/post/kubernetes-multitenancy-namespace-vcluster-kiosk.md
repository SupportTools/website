---
title: "Kubernetes Multitenancy: Namespace Isolation vs vCluster vs Kiosk"
date: 2029-06-24T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Multitenancy", "vCluster", "Kiosk", "HNC", "Security", "Isolation"]
categories: ["Kubernetes", "Platform Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive comparison of Kubernetes multitenancy approaches: namespace-based isolation limits, vCluster virtual clusters, Kiosk account controller, Hierarchical Namespace Controller (HNC), and cost allocation strategies for platform teams."
more_link: "yes"
url: "/kubernetes-multitenancy-namespace-vcluster-kiosk/"
---

Kubernetes multitenancy — running workloads from multiple teams or customers on shared clusters — requires careful architectural decisions. Pure namespace isolation is insufficient for strong security boundaries; virtual clusters provide stronger isolation but add overhead; HNC enables namespace hierarchies for large organizations. The right choice depends on your trust model, operational complexity budget, and cost requirements. This guide provides a systematic comparison with concrete implementation details.

<!--more-->

# Kubernetes Multitenancy: Namespace Isolation vs vCluster vs Kiosk

## Section 1: Isolation Threat Model

Before choosing an isolation strategy, define your threat model:

**Soft Multitenancy (Trusted Tenants)**
- Teams within the same organization
- Accidental resource interference is the primary risk
- Malicious actors not assumed
- Namespace-based isolation may be sufficient

**Hard Multitenancy (Untrusted Tenants)**
- External customers or unknown code
- Malicious actors must be assumed
- Container escape attacks must be mitigated
- Requires stronger isolation (vCluster, separate node pools)

**Compliance Multitenancy**
- PCI DSS, HIPAA, or SOC2 requirements
- Audit logging and separation proof needed
- May require dedicated clusters regardless of technical capability

### The Namespace Isolation Gap

Namespace isolation provides:
- RBAC resource boundaries
- Network policy enforcement (requires CNI support)
- ResourceQuota enforcement
- LimitRange enforcement

Namespace isolation does NOT provide:
- Node-level isolation (pods share the kernel)
- API server-level isolation (all pods call the same API)
- etcd isolation (all data in same database)
- CRD isolation (cluster-scoped, any tenant can list)
- ClusterRole separation (cluster-wide permissions leak)

---

## Section 2: Namespace-Based Isolation — Production Hardening

Even with soft multitenancy, proper namespace isolation requires several components working together.

### ResourceQuota and LimitRange

```yaml
# namespace-setup.yaml
---
apiVersion: v1
kind: Namespace
metadata:
  name: team-alpha
  labels:
    team: alpha
    tier: standard
    cost-center: "12345"
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: team-alpha-quota
  namespace: team-alpha
spec:
  hard:
    # Compute
    requests.cpu: "20"
    requests.memory: 40Gi
    limits.cpu: "40"
    limits.memory: 80Gi
    # Storage
    requests.storage: 100Gi
    persistentvolumeclaims: "20"
    # Object counts
    pods: "50"
    services: "20"
    secrets: "100"
    configmaps: "50"
    # LoadBalancer services (expensive)
    services.loadbalancers: "2"
    services.nodeports: "0"
    # Restrict to specific storage classes
    standard.storageclass.storage.k8s.io/requests.storage: 100Gi
---
apiVersion: v1
kind: LimitRange
metadata:
  name: team-alpha-limits
  namespace: team-alpha
spec:
  limits:
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
      cpu: 10m
      memory: 32Mi
  - type: Pod
    max:
      cpu: "16"
      memory: 32Gi
  - type: PersistentVolumeClaim
    max:
      storage: 50Gi
    min:
      storage: 1Gi
```

### RBAC for Team Self-Service

```yaml
# team-rbac.yaml
---
# Namespace-scoped admin role for the team
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: team-admin
  namespace: team-alpha
rules:
- apiGroups: ["", "apps", "batch", "autoscaling", "networking.k8s.io"]
  resources: ["*"]
  verbs: ["*"]
- apiGroups: [""]
  resources: ["resourcequotas", "limitranges", "namespaces"]
  verbs: ["get", "list", "watch"]
  # Note: teams cannot modify their own quota limits
---
# Bind team members to the role
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: team-alpha-admins
  namespace: team-alpha
subjects:
- kind: Group
  name: "team-alpha"
  apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: Role
  name: team-admin
  apiGroup: rbac.authorization.k8s.io
---
# Prevent cross-namespace access
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: team-alpha-cluster-readonly
rules:
- apiGroups: [""]
  resources: ["namespaces"]
  verbs: ["get", "list"]
  resourceNames: ["team-alpha"]  # Only their own namespace
- apiGroups: ["storage.k8s.io"]
  resources: ["storageclasses"]
  verbs: ["get", "list"]
```

### Network Policy Isolation

```yaml
# network-isolation.yaml — Default deny-all, allow only within namespace
---
# Deny all ingress and egress by default
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: team-alpha
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  - Egress
---
# Allow pods within the same namespace to communicate
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-same-namespace
  namespace: team-alpha
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
---
# Allow DNS resolution
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns
  namespace: team-alpha
spec:
  podSelector: {}
  policyTypes:
  - Egress
  egress:
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
    ports:
    - port: 53
      protocol: UDP
    - port: 53
      protocol: TCP
---
# Allow ingress from the ingress controller
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-ingress-controller
  namespace: team-alpha
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: ingress-nginx
```

### Pod Security Standards

```yaml
# Pod Security Admission for namespace
apiVersion: v1
kind: Namespace
metadata:
  name: team-alpha
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: latest
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/warn: restricted
```

---

## Section 3: Hierarchical Namespace Controller (HNC)

HNC allows namespace hierarchies where child namespaces inherit policies from parents. This solves the problem of applying consistent policies across dozens of team namespaces.

### Install HNC

```bash
# Install HNC
kubectl apply -f https://github.com/kubernetes-sigs/hierarchical-namespaces/releases/download/v1.1.0/default.yaml

# Verify
kubectl get pods -n hnc-system

# Install kubectl plugin
curl -L https://github.com/kubernetes-sigs/hierarchical-namespaces/releases/download/v1.1.0/kubectl-hns_linux_amd64 \
  -o /usr/local/bin/kubectl-hns
chmod +x /usr/local/bin/kubectl-hns
kubectl hns version
```

### Creating a Namespace Hierarchy

```bash
# Create parent namespace for a business unit
kubectl create namespace platform-team

# Create child namespaces under platform-team
kubectl hns create team-alpha -n platform-team
kubectl hns create team-beta -n platform-team
kubectl hns create team-gamma -n platform-team

# Verify hierarchy
kubectl hns tree platform-team
# platform-team
# ├── [s] team-alpha
# ├── [s] team-beta
# └── [s] team-gamma
```

### Propagating Policies via HNC

```yaml
# Apply to parent namespace; HNC propagates to all children
---
# RBAC role propagated to all team namespaces
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: platform-viewer
  namespace: platform-team
  annotations:
    propagate.hnc.x-k8s.io/treeSelect: "true"  # Propagate to all descendants
rules:
- apiGroups: ["", "apps"]
  resources: ["pods", "deployments", "services"]
  verbs: ["get", "list", "watch"]
---
# Network policy propagated to all teams
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-monitoring
  namespace: platform-team
  annotations:
    propagate.hnc.x-k8s.io/treeSelect: "true"
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: monitoring
    ports:
    - port: 9090
      protocol: TCP
```

### HNC Configuration Resource

```yaml
# Configure which resource types HNC propagates
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
  - resource: resourcequotas
    mode: Propagate   # Parent quota applies to descendants
  - resource: secrets
    mode: None        # Don't propagate secrets
```

---

## Section 4: Kiosk — Namespace-as-a-Service

Kiosk provides a self-service namespace provisioning model where tenants request namespace "spaces" within pre-defined account templates.

### Install Kiosk

```bash
# Install Kiosk CRDs and controllers
kubectl apply -f https://raw.githubusercontent.com/loft-sh/kiosk/main/deploy/manifests/deploy.yaml

# Verify
kubectl get pods -n kiosk

# Available CRDs
kubectl get crds | grep kiosk.sh
# accounts.tenancy.kiosk.sh
# accountquotas.tenancy.kiosk.sh
# spaces.tenancy.kiosk.sh
# templates.tenancy.kiosk.sh
# templateinstances.tenancy.kiosk.sh
```

### Define Templates for Self-Service

```yaml
# kiosk-templates.yaml
---
# Standard team template
apiVersion: tenancy.kiosk.sh/v1alpha1
kind: Template
metadata:
  name: team-standard
spec:
  resources:
    manifests:
    # Default ResourceQuota
    - apiVersion: v1
      kind: ResourceQuota
      metadata:
        name: default-quota
      spec:
        hard:
          requests.cpu: "10"
          requests.memory: 20Gi
          limits.cpu: "20"
          limits.memory: 40Gi
          pods: "30"

    # Default LimitRange
    - apiVersion: v1
      kind: LimitRange
      metadata:
        name: default-limits
      spec:
        limits:
        - type: Container
          default:
            cpu: 200m
            memory: 256Mi
          defaultRequest:
            cpu: 50m
            memory: 64Mi

    # Default deny-all network policy
    - apiVersion: networking.k8s.io/v1
      kind: NetworkPolicy
      metadata:
        name: default-deny
      spec:
        podSelector: {}
        policyTypes:
        - Ingress
        - Egress
---
# Premium template with higher limits
apiVersion: tenancy.kiosk.sh/v1alpha1
kind: Template
metadata:
  name: team-premium
spec:
  resources:
    manifests:
    - apiVersion: v1
      kind: ResourceQuota
      metadata:
        name: premium-quota
      spec:
        hard:
          requests.cpu: "50"
          requests.memory: 100Gi
          limits.cpu: "100"
          limits.memory: 200Gi
          pods: "100"
          services.loadbalancers: "5"
```

### Kiosk Accounts

```yaml
# kiosk-accounts.yaml
---
apiVersion: tenancy.kiosk.sh/v1alpha1
kind: Account
metadata:
  name: team-alpha
spec:
  subjects:
  - kind: Group
    name: "team-alpha"
    apiGroup: rbac.authorization.k8s.io
  space:
    templateInstantiationNamespace: team-alpha-*
    clusterRole: admin
    limit: 5   # Max namespaces this account can create
    spaceTemplate:
      metadata:
        labels:
          account: team-alpha
      spec:
        templateRef:
          name: team-standard
```

### Tenant Creates Their Own Namespace (Space)

```yaml
# As the tenant user (team-alpha):
apiVersion: tenancy.kiosk.sh/v1alpha1
kind: Space
metadata:
  name: team-alpha-production
spec:
  account: team-alpha

# Kiosk creates the namespace team-alpha-production
# and applies the team-standard template automatically
```

---

## Section 5: vCluster — Virtual Kubernetes Clusters

vCluster creates fully isolated Kubernetes API servers running inside pods within the host cluster. Each vCluster has its own API server, scheduler, and etcd (or SQLite), while sharing the host cluster's actual compute.

### Architecture

```
Host Cluster
└── namespace: vcluster-team-alpha
    ├── Pod: vcluster (api-server + controller-manager + scheduler + etcd)
    ├── Pod: vcluster-syncer (syncs vCluster objects to host)
    └── Service: vcluster (API server endpoint)

vCluster tenant sees:
  - Full Kubernetes API
  - Can install CRDs
  - Has own RBAC
  - Can create cluster-scoped resources (ClusterRoles, etc.)
```

### Install vCluster CLI

```bash
curl -L -o vcluster "https://github.com/loft-sh/vcluster/releases/latest/download/vcluster-linux-amd64"
chmod +x vcluster
mv vcluster /usr/local/bin/

vcluster version
```

### Create a vCluster

```bash
# Create vCluster for team-alpha using k3s (lightweight, default)
vcluster create team-alpha \
  --namespace vcluster-team-alpha \
  --values vcluster-config.yaml

# With k8s distro (full Kubernetes API server)
vcluster create team-alpha \
  --namespace vcluster-team-alpha \
  --distro k8s \
  --values vcluster-config.yaml
```

### vCluster Configuration

```yaml
# vcluster-config.yaml
controlPlane:
  distro:
    k3s:
      enabled: true
      image:
        tag: "v1.29.3-k3s1"
  statefulSet:
    resources:
      requests:
        cpu: 200m
        memory: 256Mi
      limits:
        cpu: "2"
        memory: 2Gi
    persistence:
      volumeClaim:
        enabled: true
        size: 10Gi
        storageClass: gp3

sync:
  # Sync nodes as virtual (don't expose host node info to tenant)
  nodes:
    enabled: true
    syncAllNodes: false
    selector:
      all: false
    clearImageStatus: true

  # Ingresses are synced to host cluster
  ingresses:
    enabled: true

  # StorageClasses exposed to tenant
  storageClasses:
    enabled: true

  # Persistent volumes synced
  persistentVolumes:
    enabled: true

  # Policies
  hoststorageclasses:
    enabled: false  # Don't expose host storage classes directly

networking:
  replicateServices:
    fromHost: []  # Don't sync services from host to vCluster
    toHost: []    # Don't sync services from vCluster to host

  resolveDNS: []

isolation:
  enabled: true
  resourceQuota:
    enabled: true
    quota:
      requests.cpu: "20"
      requests.memory: 40Gi
      limits.cpu: "40"
      limits.memory: 80Gi
      pods: "50"
  limitRange:
    enabled: true
    default:
      cpu: 200m
      memory: 256Mi
    defaultRequest:
      cpu: 50m
      memory: 64Mi
  networkPolicy:
    enabled: true
    outgoingConnections:
      ipBlock:
        cidr: "0.0.0.0/0"
        except:
        - "100.64.0.0/10"  # Block access to cluster internal CIDR
```

### Connecting to vCluster

```bash
# Connect and switch to vCluster context
vcluster connect team-alpha --namespace vcluster-team-alpha

# Now kubectl commands go to the vCluster
kubectl get nodes
# NAME                  STATUS   ROLES
# vcluster-k3s-node-0   Ready    <none>

kubectl create namespace my-app
kubectl apply -f my-deployment.yaml

# Disconnect (return to host context)
vcluster disconnect
```

### Managing Multiple vClusters

```bash
# List all vClusters
vcluster list

# Pause a vCluster (stop pods, keep PVC)
vcluster pause team-alpha

# Resume
vcluster resume team-alpha

# Delete
vcluster delete team-alpha --namespace vcluster-team-alpha

# Upgrade vCluster
vcluster upgrade team-alpha \
  --namespace vcluster-team-alpha \
  --values new-vcluster-config.yaml
```

---

## Section 6: Comparison Matrix

| Feature | Namespace | HNC | Kiosk | vCluster |
|---|---|---|---|---|
| API isolation | No | No | No | Yes |
| CRD isolation | No | No | No | Yes |
| ClusterRole separation | No | No | No | Yes |
| Policy inheritance | Manual | Yes | Templates | N/A |
| Self-service namespaces | No | Limited | Yes | Yes |
| Kernel sharing | Yes | Yes | Yes | Yes |
| Node sharing | Yes | Yes | Yes | Yes/No |
| Operational overhead | Low | Low | Medium | High |
| Resource overhead | None | Minimal | Minimal | 200m/256Mi per vCluster |
| Cluster-scoped resources | Shared | Shared | Shared | Isolated |
| etcd isolation | No | No | No | Yes |
| API rate limiting per tenant | No | No | No | Yes |
| CRD installation by tenant | No | No | No | Yes |
| Suitable for | Same org teams | Large orgs | SaaS | External customers |

---

## Section 7: Cost Allocation

Regardless of isolation model, cost allocation requires labeling and measurement.

### Label-Based Cost Attribution

```yaml
# Namespace labels for cost tracking
apiVersion: v1
kind: Namespace
metadata:
  name: team-alpha
  labels:
    cost-center: "engineering-12345"
    team: "platform"
    product: "api-gateway"
    environment: "production"
    billing-tier: "standard"
```

### Kubecost Integration

```bash
# Install Kubecost
helm repo add kubecost https://kubecost.github.io/cost-analyzer/
helm install kubecost kubecost/cost-analyzer \
  --namespace kubecost \
  --create-namespace \
  --set prometheus.fqdn=http://prometheus.monitoring:9090 \
  --set global.grafana.fqdn=http://grafana.monitoring:3000

# Access Kubecost UI
kubectl port-forward svc/kubecost-cost-analyzer 9090:9090 -n kubecost
```

### Prometheus-Based Cost Allocation

```yaml
# cost-allocation.yaml — Prometheus recording rules
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: cost-allocation
  namespace: monitoring
spec:
  groups:
  - name: cost-allocation
    interval: 5m
    rules:
    # CPU cost per namespace (assuming $0.048 per CPU-hour)
    - record: namespace:cost_cpu_per_hour
      expr: |
        sum by (namespace) (
          kube_pod_container_resource_requests{resource="cpu"}
        ) * 0.048

    # Memory cost per namespace (assuming $0.006 per GB-hour)
    - record: namespace:cost_memory_per_hour
      expr: |
        sum by (namespace) (
          kube_pod_container_resource_requests{resource="memory"}
        ) / 1073741824 * 0.006

    # Total cost per namespace per hour
    - record: namespace:cost_total_per_hour
      expr: |
        namespace:cost_cpu_per_hour + namespace:cost_memory_per_hour

    # Storage cost per namespace ($0.10 per GB-month)
    - record: namespace:cost_storage_per_hour
      expr: |
        sum by (namespace) (
          kube_persistentvolumeclaim_resource_requests_storage_bytes
        ) / 1073741824 * (0.10 / 720)
```

### Chargeback Report Generation

```bash
#!/bin/bash
# generate-chargeback.sh
MONTH=${1:-$(date +%Y-%m)}
PROMETHEUS_URL="http://prometheus.monitoring:9090"

echo "Cost Allocation Report: $MONTH"
echo "================================"

# Query monthly cost per namespace
curl -s "$PROMETHEUS_URL/api/v1/query" \
  --data-urlencode "query=sum by (namespace, label_cost_center, label_team) (
    namespace:cost_total_per_hour
    * on(namespace) group_left(label_cost_center, label_team)
    kube_namespace_labels
  ) * 720" | \
  jq -r '.data.result[] | [
    .metric.namespace,
    .metric.label_cost_center,
    .metric.label_team,
    (.value[1] | tonumber | . * 100 | round / 100 | tostring)
  ] | @tsv' | \
  sort -t$'\t' -k4 -rn | \
  awk -F'\t' 'BEGIN{printf "%-30s %-20s %-15s %10s\n","Namespace","Cost Center","Team","Cost ($)"}
    {printf "%-30s %-20s %-15s %10s\n",$1,$2,$3,$4}'
```

---

## Section 8: Node Isolation for Hard Multitenancy

For compliance or untrusted workloads, use dedicated node pools:

```yaml
# tenant-node-pool.yaml
# First, taint the dedicated nodes
kubectl taint nodes node1 node2 node3 \
  tenant=team-alpha:NoSchedule

# Then configure the vCluster or namespace to use these nodes
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: team-alpha
spec:
  template:
    spec:
      # Prefer dedicated nodes
      nodeSelector:
        tenant: team-alpha
      tolerations:
      - key: "tenant"
        operator: "Equal"
        value: "team-alpha"
        effect: "NoSchedule"
      # If shared nodes are acceptable as fallback, use affinity instead:
      affinity:
        nodeAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            preference:
              matchExpressions:
              - key: tenant
                operator: In
                values: ["team-alpha"]
```

The choice between namespace isolation, HNC, Kiosk, and vCluster is fundamentally about the trust model and operational investment. For enterprises running internal teams on shared clusters, namespace isolation with HNC for policy inheritance provides the right balance. For SaaS platforms or compliance-sensitive workloads, vCluster's API-level isolation justifies the operational overhead.
