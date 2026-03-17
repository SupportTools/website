---
title: "Kubernetes Multi-Tenancy: Namespace Isolation, Hierarchical Namespaces, and Virtual Clusters"
date: 2027-09-06T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Multi-tenancy", "Security", "vcluster"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Kubernetes multi-tenancy patterns covering soft vs hard multi-tenancy, hierarchical namespace controller, virtual clusters with vcluster, Capsule for tenant-based RBAC, and resource isolation guarantees for shared clusters."
more_link: "yes"
url: /kubernetes-multi-tenancy-vcluster-hnc-capsule-guide/
---

Multi-tenant Kubernetes clusters present a fundamental tension between sharing infrastructure costs and providing adequate isolation between tenants. Namespace-based soft multi-tenancy provides resource and RBAC boundaries but shares the kernel, network stack, and control plane. Hard multi-tenancy via virtual clusters or node pools adds a second isolation layer at the cost of operational complexity. Selecting the right model requires understanding what isolation guarantees are actually provided and where the boundaries are. This guide covers all viable models with production-ready configurations.

<!--more-->

## Section 1: Isolation Threat Model

Before choosing an isolation model, define the threat. Three categories of threats require different mitigations:

### Threat Level 1: Accidental Cross-Contamination

Teams deploying to wrong namespaces, resource quota overflow affecting neighbors, misconfigured network policies. Mitigation: RBAC, ResourceQuota, NetworkPolicy.

### Threat Level 2: Insider Lateral Movement

A compromised application container attempting to access other tenants' secrets, network traffic, or the Kubernetes API. Mitigation: Pod Security Standards, NetworkPolicy, audit logging, service mesh mTLS.

### Threat Level 3: Kernel Exploitation

A malicious tenant exploiting kernel vulnerabilities to escape the container boundary. Mitigation: Node pools per tenant, gVisor/Kata Containers, or dedicated clusters.

```
Isolation Model            Level 1   Level 2   Level 3
Namespace + RBAC             Yes      Partial    No
+ NetworkPolicy              Yes       Yes       No
+ Pod Security Restricted    Yes       Yes      Partial
+ Dedicated Node Pool        Yes       Yes      Partial
Virtual Cluster (vcluster)   Yes       Yes      Partial
Dedicated Physical Cluster   Yes       Yes       Yes
```

## Section 2: Namespace-Based Soft Multi-Tenancy

### Namespace Provisioning Template

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: tenant-acme
  labels:
    tenant: acme
    cost-center: CC-1234
    team: platform
    environment: production
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: v1.30
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/warn: restricted
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: tenant-acme-quota
  namespace: tenant-acme
spec:
  hard:
    requests.cpu: "20"
    requests.memory: "40Gi"
    limits.cpu: "40"
    limits.memory: "80Gi"
    pods: "200"
    services: "20"
    services.loadbalancers: "2"
    secrets: "100"
    configmaps: "100"
    persistentvolumeclaims: "20"
    requests.storage: "500Gi"
---
apiVersion: v1
kind: LimitRange
metadata:
  name: tenant-acme-limits
  namespace: tenant-acme
spec:
  limits:
  - type: Container
    default:
      cpu: "200m"
      memory: "256Mi"
    defaultRequest:
      cpu: "50m"
      memory: "64Mi"
    max:
      cpu: "4"
      memory: "8Gi"
    min:
      cpu: "10m"
      memory: "16Mi"
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: tenant-acme
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  - Egress
---
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
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
    ports:
    - port: 53
      protocol: UDP
    - port: 53
      protocol: TCP
```

### Tenant RBAC

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: tenant-admin
  namespace: tenant-acme
rules:
- apiGroups: ["", "apps", "batch", "autoscaling", "networking.k8s.io"]
  resources:
  - deployments
  - replicasets
  - pods
  - pods/log
  - pods/exec
  - services
  - configmaps
  - endpoints
  - ingresses
  - horizontalpodautoscalers
  - cronjobs
  - jobs
  verbs: ["*"]
- apiGroups: [""]
  resources: ["secrets"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: [""]
  resources: ["resourcequotas", "limitranges"]
  verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: tenant-acme-admin-binding
  namespace: tenant-acme
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: tenant-admin
subjects:
- kind: Group
  name: tenant-acme-admins
  apiGroup: rbac.authorization.k8s.io
```

## Section 3: Hierarchical Namespace Controller (HNC)

HNC enables parent-child namespace relationships, propagating RBAC, NetworkPolicy, and LimitRange objects from parent to child namespaces automatically.

### HNC Installation

```bash
kubectl apply -f https://github.com/kubernetes-sigs/hierarchical-namespaces/releases/download/v1.1.0/default.yaml

# Verify
kubectl get pods -n hnc-system
# NAME                                     READY   STATUS    RESTARTS   AGE
# hnc-controller-manager-xxxx              2/2     Running   0          60s
```

### Creating a Namespace Hierarchy

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: team-payments
  labels:
    tenant: payments
---
apiVersion: hnc.x-k8s.io/v1alpha2
kind: HierarchyConfiguration
metadata:
  name: hierarchy
  namespace: team-payments
spec:
  parent: ""
```

```bash
# Create child namespaces using kubectl-hns plugin
kubectl hns create payments-dev -n team-payments
kubectl hns create payments-staging -n team-payments
kubectl hns create payments-production -n team-payments

# Verify hierarchy
kubectl hns tree team-payments
# team-payments
# ├── payments-dev
# ├── payments-staging
# └── payments-production
```

### Propagating Resources

```yaml
# Role defined in parent namespace; auto-propagated to all children
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: payments-developer
  namespace: team-payments
rules:
- apiGroups: ["apps"]
  resources: ["deployments"]
  verbs: ["get", "list", "watch", "create", "update", "patch"]
- apiGroups: [""]
  resources: ["pods", "pods/log"]
  verbs: ["get", "list", "watch"]
```

```bash
# Configure propagation modes
kubectl hns config set-resource roles --mode Propagate
kubectl hns config set-resource rolebindings --mode Propagate
kubectl hns config set-resource networkpolicies --mode Propagate
kubectl hns config set-resource limitranges --mode Propagate

# Verify propagation
kubectl get role payments-developer -n payments-production
# NAME                  CREATED AT
# payments-developer    2026-03-15T10:00:00Z
```

## Section 4: Capsule for Tenant-Based RBAC

Capsule provides a higher-level tenant abstraction wrapping multiple namespaces under a single tenant identity with centralized policy control.

### Capsule Installation

```bash
helm repo add projectcapsule https://projectcapsule.github.io/charts
helm install capsule projectcapsule/capsule \
  --namespace capsule-system \
  --create-namespace \
  --set manager.options.forceTenantPrefix=true \
  --wait
```

### Tenant Definition

```yaml
apiVersion: capsule.clastix.io/v1beta2
kind: Tenant
metadata:
  name: acme
spec:
  owners:
  - name: alice@acme.example.com
    kind: User
  - name: acme-admins
    kind: Group

  namespaceOptions:
    quota: 10

  resourceQuotas:
    scope: Tenant
    items:
    - hard:
        requests.cpu: "50"
        requests.memory: "100Gi"
        pods: "500"

  limitRanges:
    items:
    - limits:
      - type: Container
        default:
          cpu: 200m
          memory: 256Mi
        defaultRequest:
          cpu: 50m
          memory: 64Mi

  nodeSelector:
    kubernetes.io/os: linux
    node-pool: tenant-workloads

  ingressOptions:
    allowedClasses:
      allowed:
      - nginx
    allowedHostnames:
      allowedRegex: "^.*\\.acme\\.example\\.com$"

  storageClasses:
    allowed:
    - gp3
    - standard

  networkPolicies:
    items:
    - ingress:
      - from:
        - namespaceSelector:
            matchLabels:
              capsule.clastix.io/tenant: acme
    egress:
      - to:
        - namespaceSelector:
            matchLabels:
              capsule.clastix.io/tenant: acme
      - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
        ports:
        - port: 53
          protocol: UDP

  additionalRoleBindings:
  - clusterRoleName: view
    subjects:
    - name: acme-readonly
      kind: Group
      apiGroup: rbac.authorization.k8s.io
```

```bash
# Creating a namespace as a tenant owner
# Capsule intercepts and applies all policies automatically
kubectl create namespace acme-analytics

kubectl get namespaces | grep acme
# NAME               STATUS   AGE
# acme-analytics     Active   5s
# acme-payments      Active   2d
# acme-web           Active   5d
```

## Section 5: Virtual Clusters with vcluster

vcluster creates fully functional Kubernetes API servers running as pods inside a host namespace, providing near-cluster-level isolation without dedicated physical infrastructure.

### vcluster Architecture

```
Host Cluster
  └── namespace: vcluster-team-a
        ├── vcluster-0 (StatefulSet)
        │     ├── k3s API server (inside pod)
        │     ├── kube-controller-manager (inside pod)
        │     └── etcd (inside pod)
        └── vcluster syncer
              └── Syncs pods, services, PVCs to host namespace
```

### vcluster Installation

```bash
# Install vcluster CLI
curl -L -o /usr/local/bin/vcluster \
  "https://github.com/loft-sh/vcluster/releases/latest/download/vcluster-linux-amd64"
chmod +x /usr/local/bin/vcluster

# Create virtual cluster for a team
vcluster create team-analytics \
  --namespace vcluster-team-analytics \
  --chart-version 0.20.0 \
  --values vcluster-values.yaml
```

### vcluster Production Values

```yaml
# vcluster-values.yaml
controlPlane:
  distro:
    k3s:
      enabled: true
      image:
        tag: "v1.30.0-k3s1"

  statefulSet:
    resources:
      requests:
        cpu: 200m
        memory: 256Mi
      limits:
        cpu: 1
        memory: 1Gi

  backingStore:
    etcd:
      embedded:
        enabled: false
      deploy:
        enabled: true
        statefulSet:
          resources:
            requests:
              cpu: 100m
              memory: 256Mi

sync:
  toHost:
    pods:
      enabled: true
      rewriteHosts:
        enabled: true
    services:
      enabled: true
    persistentVolumeClaims:
      enabled: true
    ingresses:
      enabled: true
    configMaps:
      enabled: true
      all: false
    secrets:
      enabled: true
      all: false
  fromHost:
    nodes:
      enabled: true
      syncAllNodes: false
      nodeSelector: "node-pool=tenant-workloads"
    storageClasses:
      enabled: true

telemetry:
  enabled: false

podSecurityContext:
  runAsNonRoot: true
  runAsUser: 12345
  fsGroup: 12345
  seccompProfile:
    type: RuntimeDefault
```

### Connecting to a vcluster

```bash
# Connect and switch kubeconfig context
vcluster connect team-analytics --namespace vcluster-team-analytics

# List virtual nodes
kubectl get nodes
# NAME       STATUS   ROLES    AGE   VERSION
# node-01    Ready    <none>   5d    v1.30.0+k3s1

# Deploy workloads (actual pods run in host namespace)
kubectl create deployment web --image=nginx:alpine

# Pod in vcluster view
kubectl get pods
# NAME              READY   STATUS    AGE
# web-6d8b9-abc12   1/1     Running   30s

# Same pod in host cluster namespace
kubectl get pods -n vcluster-team-analytics --context=host-cluster
# NAME                                    READY   STATUS
# vcluster-team-analytics-web-6d8b9       1/1     Running
```

## Section 6: Dedicated Node Pools per Tenant

For Level 3 isolation, assign dedicated nodes to each tenant and prevent workload mixing.

```bash
# Taint nodes for exclusive tenant use
kubectl taint node node-01 node-02 \
  tenant=acme:NoSchedule
```

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-service
  namespace: tenant-acme
spec:
  template:
    spec:
      nodeSelector:
        tenant: acme
      tolerations:
      - key: tenant
        operator: Equal
        value: acme
        effect: NoSchedule
```

### Karpenter NodePool per Tenant

```yaml
apiVersion: karpenter.sh/v1beta1
kind: NodePool
metadata:
  name: tenant-acme
spec:
  template:
    metadata:
      labels:
        tenant: acme
    spec:
      nodeClassRef:
        apiVersion: karpenter.k8s.aws/v1beta1
        kind: EC2NodeClass
        name: tenant-acme-nodes
      requirements:
      - key: karpenter.sh/capacity-type
        operator: In
        values: ["on-demand"]
      taints:
      - key: tenant
        value: acme
        effect: NoSchedule
  limits:
    cpu: 200
    memory: 400Gi
  disruption:
    consolidationPolicy: WhenUnderutilized
    consolidateAfter: 5m
```

## Section 7: Isolation Verification Testing

### Network Isolation Test

```bash
#!/usr/bin/env bash
set -euo pipefail

TENANT_A_NS="tenant-acme"
TENANT_B_NS="tenant-widgets"

kubectl run isolation-test-a --image=busybox --restart=Never -n "$TENANT_A_NS" \
  --command -- sleep 3600
kubectl run isolation-test-b --image=busybox --restart=Never -n "$TENANT_B_NS" \
  --command -- sleep 3600

kubectl wait --for=condition=Ready pod/isolation-test-a -n "$TENANT_A_NS" --timeout=60s
kubectl wait --for=condition=Ready pod/isolation-test-b -n "$TENANT_B_NS" --timeout=60s

POD_B_IP=$(kubectl get pod isolation-test-b -n "$TENANT_B_NS" \
  -o jsonpath='{.status.podIP}')

if kubectl exec -n "$TENANT_A_NS" isolation-test-a -- \
  nc -zv -w3 "$POD_B_IP" 80 2>&1 | grep -q "open"; then
    echo "FAIL: Cross-tenant network connectivity should be blocked"
else
    echo "PASS: Cross-tenant network connectivity is blocked"
fi

kubectl delete pod isolation-test-a -n "$TENANT_A_NS" --ignore-not-found
kubectl delete pod isolation-test-b -n "$TENANT_B_NS" --ignore-not-found
```

### RBAC Boundary Test

```bash
#!/usr/bin/env bash
TENANT_USER="alice@acme.example.com"
FORBIDDEN_NS="tenant-widgets"

if kubectl --as="$TENANT_USER" get pods -n "$FORBIDDEN_NS" 2>&1 | grep -q "Forbidden"; then
    echo "PASS: $TENANT_USER cannot access $FORBIDDEN_NS"
else
    echo "FAIL: $TENANT_USER has unauthorized access to $FORBIDDEN_NS"
fi

if kubectl --as="$TENANT_USER" create clusterrole test --verb=get --resource=pods 2>&1 | grep -q "Forbidden"; then
    echo "PASS: $TENANT_USER cannot create ClusterRole"
else
    echo "FAIL: $TENANT_USER has unauthorized ClusterRole creation access"
fi
```

## Section 8: Admission Webhooks for Tenant Enforcement

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: tenant-namespace-required
spec:
  failurePolicy: Fail
  matchConstraints:
    resourceRules:
    - apiGroups: ["apps"]
      apiVersions: ["v1"]
      operations: ["CREATE", "UPDATE"]
      resources: ["deployments"]
  validations:
  - expression: |
      has(object.metadata.labels) &&
      has(object.metadata.labels["tenant"])
    message: "Deployments must have a 'tenant' label"
  - expression: |
      object.spec.template.spec.securityContext != null &&
      object.spec.template.spec.securityContext.runAsNonRoot == true
    message: "Pods must not run as root"
---
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicyBinding
metadata:
  name: tenant-namespace-required-binding
spec:
  policyName: tenant-namespace-required
  validationActions: [Deny, Audit]
  matchResources:
    namespaceSelector:
      matchLabels:
        tenant-managed: "true"
```

## Section 9: Isolation Model Comparison

| Model | Implementation Effort | Cost Overhead | Blast Radius | Suitable For |
|-------|----------------------|---------------|--------------|--------------|
| Namespaces + RBAC | Low | None | High | Dev/test, low-risk tenants |
| + NetworkPolicy | Low | Minimal | Medium | Most production tenants |
| HNC | Medium | Minimal | Medium | Team-per-hierarchy structures |
| Capsule | Medium | Minimal | Medium | SaaS platforms, self-service |
| vcluster | High | 100-200 MB RAM/cluster | Low | Strong isolation needs |
| Dedicated nodes | High | 30-40% node overhead | Low | Compliance workloads |
| Dedicated cluster | Very High | Full cluster overhead | Minimal | Regulated data, government |

## Section 10: Tenant Onboarding Automation

```bash
#!/usr/bin/env bash
set -euo pipefail

TENANT_NAME="${1:?Usage: $0 <tenant-name> <cost-center> <admin-group>}"
COST_CENTER="${2:?}"
ADMIN_GROUP="${3:?}"
NAMESPACE="tenant-${TENANT_NAME}"

echo "Onboarding tenant: $TENANT_NAME"

# Create namespace with required labels
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | \
  kubectl apply -f -

kubectl label namespace "$NAMESPACE" \
  "tenant=${TENANT_NAME}" \
  "cost-center=${COST_CENTER}" \
  "tenant-managed=true" \
  "pod-security.kubernetes.io/enforce=restricted" \
  "pod-security.kubernetes.io/enforce-version=v1.30" \
  --overwrite

# Apply standard ResourceQuota
kubectl apply -f - <<EOF
apiVersion: v1
kind: ResourceQuota
metadata:
  name: default-quota
  namespace: ${NAMESPACE}
spec:
  hard:
    requests.cpu: "10"
    requests.memory: "20Gi"
    pods: "100"
EOF

# Create admin RBAC binding
kubectl create rolebinding "tenant-${TENANT_NAME}-admin" \
  --role=tenant-admin \
  --group="${ADMIN_GROUP}" \
  --namespace="${NAMESPACE}" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "Tenant ${TENANT_NAME} onboarded in namespace ${NAMESPACE}"
echo "Admin group: ${ADMIN_GROUP}"
```

## Summary

Kubernetes multi-tenancy is not a single solution but a spectrum of isolation models that trade operational complexity for isolation strength. For the majority of enterprise use cases, namespace-based isolation with RBAC, ResourceQuota, NetworkPolicy, and Pod Security Standards provides adequate protection against accidental cross-contamination and most insider threat scenarios. Capsule and HNC reduce per-tenant operational overhead by automating policy propagation. Virtual clusters with vcluster provide near-full API isolation when tenants need different admission webhooks, CRDs, or cluster-admin access without the full cost of dedicated clusters. Dedicated physical clusters remain the only guarantee against kernel-level exploitation and are justified for workloads subject to strict regulatory requirements.
