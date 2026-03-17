---
title: "Kubernetes Resource Quotas and LimitRanges: Multi-Tenant Resource Management"
date: 2028-03-17T00:00:00-05:00
draft: false
tags: ["Kubernetes", "ResourceQuota", "LimitRange", "Multi-Tenancy", "FinOps", "Platform Engineering"]
categories: ["Kubernetes", "Platform Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Kubernetes ResourceQuota and LimitRange for multi-tenant clusters, covering quota scopes, namespace budget allocation, admission priority, monitoring with kube-state-metrics, and tenant onboarding automation."
more_link: "yes"
url: "/kubernetes-resource-quota-limitrange-guide/"
---

Resource isolation is foundational to safe multi-tenancy in Kubernetes. Without it, a single misbehaving tenant can exhaust cluster compute, degrade adjacent workloads, and trigger cascading failures. ResourceQuota and LimitRange are the two admission-time guardrails that enforce budget constraints before workloads are scheduled.

This guide covers quota scope semantics, namespace budget modeling, LimitRange default injection, monitoring with kube-state-metrics, hierarchical quota inheritance using the Hierarchical Namespace Controller, and automation patterns for tenant onboarding.

<!--more-->

## ResourceQuota Fundamentals

A ResourceQuota object defines the maximum aggregate resource consumption allowed within a namespace. The API server rejects any request that would cause the namespace to exceed its quota.

### Basic Compute Quota

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: compute-quota
  namespace: team-alpha
spec:
  hard:
    # CPU
    requests.cpu: "8"
    limits.cpu: "16"
    # Memory
    requests.memory: 16Gi
    limits.memory: 32Gi
    # Pod count
    pods: "50"
    # Container count (all init + regular containers)
    count/pods: "50"
    # Services
    services: "20"
    services.loadbalancers: "2"
    services.nodeports: "0"
    # Persistent storage
    requests.storage: 200Gi
    persistentvolumeclaims: "20"
    # Secrets and ConfigMaps
    secrets: "100"
    configmaps: "50"
```

### Object Count Quota

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: object-count-quota
  namespace: team-alpha
spec:
  hard:
    count/deployments.apps: "30"
    count/statefulsets.apps: "10"
    count/jobs.batch: "20"
    count/cronjobs.batch: "10"
    count/ingresses.networking.k8s.io: "15"
    count/roles.rbac.authorization.k8s.io: "20"
    count/rolebindings.rbac.authorization.k8s.io: "20"
```

## ResourceQuota Scopes

Scopes restrict which pods a quota applies to. This allows differentiated treatment of workloads with different characteristics.

```yaml
# Quota for Terminating pods only (Jobs, CronJobs, pods with activeDeadlineSeconds)
apiVersion: v1
kind: ResourceQuota
metadata:
  name: terminating-pods-quota
  namespace: team-alpha
spec:
  hard:
    pods: "20"
    requests.cpu: "4"
    requests.memory: 8Gi
  scopes:
    - Terminating

---
# Quota for NotTerminating pods (Deployments, StatefulSets — long-running workloads)
apiVersion: v1
kind: ResourceQuota
metadata:
  name: long-running-quota
  namespace: team-alpha
spec:
  hard:
    pods: "40"
    requests.cpu: "16"
    requests.memory: 32Gi
  scopes:
    - NotTerminating

---
# Quota restricting BestEffort pods (no requests/limits set)
# BestEffort pods are the first evicted under node pressure
apiVersion: v1
kind: ResourceQuota
metadata:
  name: besteffort-quota
  namespace: team-alpha
spec:
  hard:
    pods: "5"
  scopes:
    - BestEffort

---
# Quota for NotBestEffort pods (Burstable or Guaranteed QoS)
apiVersion: v1
kind: ResourceQuota
metadata:
  name: qos-quota
  namespace: team-alpha
spec:
  hard:
    pods: "45"
    requests.cpu: "12"
    requests.memory: 24Gi
  scopes:
    - NotBestEffort
```

### Scope Matrix

```
Scope            | Applies To                              | Quota Fields Allowed
-----------------|----------------------------------------|---------------------
Terminating      | pods with activeDeadlineSeconds set     | cpu, memory, pods, storage
NotTerminating   | pods without activeDeadlineSeconds      | cpu, memory, pods, storage
BestEffort       | pods with no requests or limits         | pods only
NotBestEffort    | pods with requests or limits            | cpu, memory, pods, storage
PriorityClass    | pods with matching priorityClassName    | cpu, memory, pods, storage
CrossNamespacePodAffinity | pods with cross-namespace affinity | pods
```

### ScopeSelector for PriorityClass

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: critical-workloads-quota
  namespace: team-alpha
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
```

## LimitRange

LimitRange enforces minimum/maximum resource constraints per container, pod, or PVC, and injects default requests/limits when none are specified. Without default injection, pods in namespaces with ResourceQuota fail to schedule because quota requires explicit requests.

### Container LimitRange

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: container-limits
  namespace: team-alpha
spec:
  limits:
    - type: Container
      # Injected defaults when absent from pod spec
      default:
        cpu: 500m
        memory: 256Mi
      defaultRequest:
        cpu: 100m
        memory: 128Mi
      # Hard minimums — below these values the pod is rejected
      min:
        cpu: 50m
        memory: 64Mi
      # Hard maximums — above these the pod is rejected
      max:
        cpu: "4"
        memory: 4Gi
      # Max/Request ratio — prevents "requests 1m, limit 32Gi" abuse
      maxLimitRequestRatio:
        cpu: "10"
        memory: "4"
```

### Pod LimitRange

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: pod-limits
  namespace: team-alpha
spec:
  limits:
    - type: Pod
      # Sum of all containers in the pod
      max:
        cpu: "8"
        memory: 16Gi
      min:
        cpu: 50m
        memory: 64Mi
```

### PVC LimitRange

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: storage-limits
  namespace: team-alpha
spec:
  limits:
    - type: PersistentVolumeClaim
      max:
        storage: 50Gi
      min:
        storage: 1Gi
```

## Admission Priority for Quota Evaluation

The admission flow for resource-constrained namespaces follows a specific sequence:

```
1. MutatingAdmissionWebhook  — may add resource requests/limits
2. LimitRange admission plugin — injects defaults for missing requests/limits
3. ResourceQuota admission plugin — verifies aggregate does not exceed quota
```

This ordering is critical: LimitRange defaults are applied before quota is evaluated. A pod missing resource requests will have defaults injected by LimitRange, then those injected values are checked against quota. If quota is exceeded, the pod is rejected.

```bash
# Verify admission plugin order in kube-apiserver flags
kubectl -n kube-system get pod kube-apiserver-<node> -o yaml | \
  grep -- '--enable-admission-plugins'
# Expected: LimitRanger appears before ResourceQuota
# Default order includes both automatically in modern Kubernetes
```

## Namespace Budget Allocation Patterns

### Tiered Tenant Model

Different tenant tiers receive different resource allocations:

```yaml
# Tier 1: Development namespaces — small budgets, permissive limits
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: dev-quota
  namespace: dev-team-alpha
spec:
  hard:
    requests.cpu: "2"
    limits.cpu: "4"
    requests.memory: 4Gi
    limits.memory: 8Gi
    pods: "20"

---
# Tier 2: Staging — medium budgets matching production scale
apiVersion: v1
kind: ResourceQuota
metadata:
  name: staging-quota
  namespace: staging-team-alpha
spec:
  hard:
    requests.cpu: "8"
    limits.cpu: "16"
    requests.memory: 16Gi
    limits.memory: 32Gi
    pods: "50"

---
# Tier 3: Production — full allocation, strict limits
apiVersion: v1
kind: ResourceQuota
metadata:
  name: prod-quota
  namespace: prod-team-alpha
spec:
  hard:
    requests.cpu: "32"
    limits.cpu: "64"
    requests.memory: 64Gi
    limits.memory: 128Gi
    pods: "200"
    services.loadbalancers: "5"
```

## Hierarchical Namespace Controller (HNC) for Quota Inheritance

The Hierarchical Namespace Controller allows quota to propagate from parent namespaces to child namespaces, enforcing department-level budgets across multiple team namespaces.

### HNC Setup

```bash
# Install HNC
kubectl apply -f https://github.com/kubernetes-sigs/hierarchical-namespaces/releases/download/v1.1.0/default.yaml

# Create parent namespace
kubectl create namespace engineering

# Create child namespaces
cat <<EOF | kubectl apply -f -
apiVersion: hnc.x-k8s.io/v1alpha2
kind: SubnamespaceAnchor
metadata:
  name: team-alpha
  namespace: engineering
EOF

cat <<EOF | kubectl apply -f -
apiVersion: hnc.x-k8s.io/v1alpha2
kind: SubnamespaceAnchor
metadata:
  name: team-beta
  namespace: engineering
EOF
```

### Propagated Quota

```yaml
# Configure HNC to propagate ResourceQuota objects
apiVersion: hnc.x-k8s.io/v1alpha2
kind: HNCConfiguration
metadata:
  name: config
spec:
  resources:
    - resource: resourcequotas
      mode: Propagate  # Copies quota from parent to all descendants
    - resource: limitranges
      mode: Propagate
    - resource: networkpolicies
      mode: Propagate
    - resource: roles
      mode: Propagate
    - resource: rolebindings
      mode: Propagate
```

```yaml
# Quota defined in parent namespace propagates to all children
apiVersion: v1
kind: ResourceQuota
metadata:
  name: engineering-quota
  namespace: engineering
spec:
  hard:
    requests.cpu: "64"
    limits.cpu: "128"
    requests.memory: 128Gi
```

## Quota Usage Monitoring with kube-state-metrics

kube-state-metrics exposes quota usage as Prometheus metrics:

```promql
# CPU request utilization per namespace (percentage)
100 * sum by (namespace) (
    kube_resourcequota{type="used", resource="requests.cpu"}
  ) /
  sum by (namespace) (
    kube_resourcequota{type="hard", resource="requests.cpu"}
  )

# Memory limit utilization
100 * sum by (namespace) (
    kube_resourcequota{type="used", resource="limits.memory"}
  ) /
  sum by (namespace) (
    kube_resourcequota{type="hard", resource="limits.memory"}
  )

# Pod count utilization
100 * sum by (namespace) (
    kube_resourcequota{type="used", resource="pods"}
  ) /
  sum by (namespace) (
    kube_resourcequota{type="hard", resource="pods"}
  )

# Namespaces approaching quota saturation (>80%)
kube_resourcequota{type="used"} /
kube_resourcequota{type="hard"} > 0.8
```

### Alerting Rules

```yaml
# prometheus-alerts.yaml
groups:
  - name: quota.alerts
    interval: 2m
    rules:
      - alert: NamespaceQuotaHighUsage
        expr: |
          kube_resourcequota{type="used", resource=~"requests.cpu|requests.memory|pods"} /
          kube_resourcequota{type="hard", resource=~"requests.cpu|requests.memory|pods"} > 0.85
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "Namespace {{ $labels.namespace }} quota at {{ $value | humanizePercentage }}"
          description: "Resource {{ $labels.resource }} in namespace {{ $labels.namespace }} is {{ $value | humanizePercentage }} utilized."
          runbook: "https://wiki.support.tools/runbooks/quota-exhaustion"

      - alert: NamespaceQuotaExhausted
        expr: |
          kube_resourcequota{type="used", resource=~"requests.cpu|requests.memory|pods"} /
          kube_resourcequota{type="hard", resource=~"requests.cpu|requests.memory|pods"} >= 0.98
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Namespace {{ $labels.namespace }} quota exhausted"
          description: "New {{ $labels.resource }} requests in {{ $labels.namespace }} will be rejected."
```

## Tenant Onboarding Automation

### Helm Chart for Tenant Namespaces

```yaml
# chart/templates/namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: {{ .Values.tenant.namespace }}
  labels:
    tenant: {{ .Values.tenant.name }}
    tier: {{ .Values.tenant.tier }}
    policy.support.tools/enforce: "true"
    hnc.x-k8s.io/included-namespace: "true"
```

```yaml
# chart/templates/resourcequota.yaml
{{- range .Values.tenant.quotas }}
apiVersion: v1
kind: ResourceQuota
metadata:
  name: {{ .name }}
  namespace: {{ $.Values.tenant.namespace }}
spec:
  hard:
    {{- toYaml .hard | nindent 4 }}
  {{- if .scopes }}
  scopes:
    {{- toYaml .scopes | nindent 4 }}
  {{- end }}
---
{{- end }}
```

```yaml
# chart/templates/limitrange.yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: default-limits
  namespace: {{ .Values.tenant.namespace }}
spec:
  limits:
    - type: Container
      default:
        cpu: {{ .Values.limits.container.default.cpu }}
        memory: {{ .Values.limits.container.default.memory }}
      defaultRequest:
        cpu: {{ .Values.limits.container.defaultRequest.cpu }}
        memory: {{ .Values.limits.container.defaultRequest.memory }}
      max:
        cpu: {{ .Values.limits.container.max.cpu }}
        memory: {{ .Values.limits.container.max.memory }}
```

```yaml
# chart/values.yaml — Tier 2 tenant example
tenant:
  name: team-alpha
  namespace: prod-team-alpha
  tier: production
  quotas:
    - name: compute-quota
      hard:
        requests.cpu: "16"
        limits.cpu: "32"
        requests.memory: 32Gi
        limits.memory: 64Gi
        pods: "100"
    - name: storage-quota
      hard:
        requests.storage: 500Gi
        persistentvolumeclaims: "50"
    - name: object-quota
      hard:
        count/deployments.apps: "50"
        count/services: "30"
        secrets: "200"
        configmaps: "100"

limits:
  container:
    default:
      cpu: 500m
      memory: 512Mi
    defaultRequest:
      cpu: 100m
      memory: 128Mi
    max:
      cpu: "4"
      memory: 8Gi
```

### Onboarding Script

```bash
#!/bin/bash
# onboard-tenant.sh — Creates a fully configured tenant namespace
set -euo pipefail

TENANT_NAME="${1:?tenant name required}"
TIER="${2:-development}"
NAMESPACE="${3:-${TENANT_NAME}}"

VALUES_FILE=$(mktemp)
trap "rm -f ${VALUES_FILE}" EXIT

cat > "${VALUES_FILE}" <<EOF
tenant:
  name: ${TENANT_NAME}
  namespace: ${NAMESPACE}
  tier: ${TIER}
EOF

# Apply tier-specific values overlay
TIER_VALUES="charts/tenant/tiers/${TIER}.yaml"
if [[ ! -f "${TIER_VALUES}" ]]; then
  echo "Unknown tier: ${TIER}" >&2
  exit 1
fi

helm upgrade --install \
  "tenant-${TENANT_NAME}" \
  charts/tenant \
  --namespace platform-system \
  --values "${TIER_VALUES}" \
  --values "${VALUES_FILE}" \
  --wait

echo "Tenant ${TENANT_NAME} provisioned in namespace ${NAMESPACE} (tier: ${TIER})"

# Verify quota was applied
kubectl get resourcequota,limitrange -n "${NAMESPACE}"
```

## Debugging Quota Rejection

```bash
# Check current quota usage in a namespace
kubectl describe quota -n team-alpha

# Output format:
# Name:            compute-quota
# Namespace:       team-alpha
# Resource         Used    Hard
# --------         ----    ----
# limits.cpu       6200m   16
# limits.memory    12Gi    32Gi
# pods             18      50
# requests.cpu     2100m   8

# Find which quota prevented a deployment
kubectl get events -n team-alpha --field-selector reason=FailedCreate \
  --sort-by='.lastTimestamp' | tail -20

# Simulate whether a pod would be admitted
cat <<EOF | kubectl apply --dry-run=server -f -
apiVersion: v1
kind: Pod
metadata:
  name: test-admission
  namespace: team-alpha
spec:
  containers:
    - name: app
      image: registry.support.tools/myapp:latest
      resources:
        requests:
          cpu: 500m
          memory: 256Mi
        limits:
          cpu: "1"
          memory: 512Mi
EOF
```

## Storage Class Quota

```yaml
# Restrict storage class usage per namespace
apiVersion: v1
kind: ResourceQuota
metadata:
  name: ssd-storage-quota
  namespace: team-alpha
spec:
  hard:
    # Per-storage-class syntax: <class>.storageclass.storage.k8s.io/requests.storage
    premium-ssd.storageclass.storage.k8s.io/requests.storage: 100Gi
    premium-ssd.storageclass.storage.k8s.io/persistentvolumeclaims: "10"
    standard.storageclass.storage.k8s.io/requests.storage: 500Gi
    standard.storageclass.storage.k8s.io/persistentvolumeclaims: "50"
```

## Production Checklist

```
Quota Design
[ ] Separate quotas for Terminating vs NotTerminating scopes
[ ] BestEffort pod count restricted to prevent eviction storms
[ ] Object count limits set for secrets/configmaps to prevent etcd bloat
[ ] LoadBalancer services capped to control cloud cost
[ ] Per-StorageClass quotas to protect premium tiers

LimitRange Design
[ ] Default CPU/memory requests injected for all containers
[ ] maxLimitRequestRatio set to prevent extreme overcommit
[ ] PVC min/max storage bounds defined

Monitoring
[ ] kube-state-metrics scraping quota objects
[ ] Alerts at 85% (warning) and 98% (critical) utilization
[ ] Dashboard showing per-namespace quota consumption trends
[ ] Monthly quota review process for right-sizing

Automation
[ ] Tenant onboarding fully automated via Helm/GitOps
[ ] Tier definitions version-controlled
[ ] HNC propagating standard LimitRanges to child namespaces
[ ] Quota increase request process documented
```

Resource quotas prevent tenant interference and enforce organizational resource governance. When combined with LimitRange defaults, they ensure every workload has predictable resource behavior, enabling accurate cluster capacity planning and cost allocation.
