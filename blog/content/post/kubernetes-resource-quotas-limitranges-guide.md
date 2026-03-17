---
title: "Kubernetes Resource Quotas and LimitRanges: Namespace Budgets, Priority Classes, and QoS Enforcement"
date: 2028-07-27T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Resource Quotas", "LimitRange", "QoS", "Multi-Tenancy"]
categories:
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes resource management using ResourceQuotas, LimitRanges, and PriorityClasses to enforce namespace budgets, guarantee QoS classes, and prevent noisy-neighbor problems in multi-tenant clusters."
more_link: "yes"
url: "/kubernetes-resource-quotas-limitranges-guide/"
---

In a multi-tenant Kubernetes cluster, a single misbehaving namespace can exhaust cluster resources and cause cascading failures across every other tenant. ResourceQuotas and LimitRanges are the primary tools for preventing this — but configuring them correctly for production workloads requires understanding the relationship between requests, limits, QoS classes, and priority-based preemption.

This guide covers the complete resource management story in Kubernetes: namespace-level budgets with ResourceQuota, per-container defaults and constraints with LimitRange, QoS class implications, PriorityClasses for workload criticality, and a practical multi-tier tenancy model.

<!--more-->

# Kubernetes Resource Quotas and LimitRanges: Namespace Budgets and QoS

## The Resource Model

Kubernetes uses a two-level resource model for CPU and memory:

- **Requests**: The amount the scheduler uses when placing a pod on a node. A container is guaranteed at least its requested amount.
- **Limits**: The maximum a container is allowed to use. Exceeding CPU limits causes throttling; exceeding memory limits causes the container to be OOM-killed.

The relationship between requests and limits determines the pod's **Quality of Service (QoS) class**:

| QoS Class | Condition | Eviction Priority |
|---|---|---|
| Guaranteed | All containers: requests == limits | Last to be evicted |
| Burstable | At least one container has requests < limits | Evicted under pressure |
| BestEffort | No container has requests or limits | First to be evicted |

ResourceQuota enforces limits at the namespace level. LimitRange enforces defaults and constraints at the container level. Together, they form the resource governance layer.

## Section 1: ResourceQuota

### Basic CPU and Memory Quota

```yaml
# namespaces/production/resource-quota.yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: production-quota
  namespace: production
spec:
  hard:
    # Compute resources
    requests.cpu: "20"        # Total CPU requests across all pods
    requests.memory: 40Gi     # Total memory requests
    limits.cpu: "40"          # Total CPU limits
    limits.memory: 80Gi       # Total memory limits

    # Object count limits
    pods: "100"               # Maximum number of pods
    services: "20"            # Maximum number of Services
    persistentvolumeclaims: "50"
    secrets: "100"
    configmaps: "100"

    # Service type restrictions
    services.nodeports: "0"   # Prevent NodePort services
    services.loadbalancers: "5"
```

### Checking Quota Usage

```bash
# Show quota usage for a namespace.
kubectl describe quota -n production

# Example output:
# Name:                    production-quota
# Namespace:               production
# Resource                 Used    Hard
# --------                 ----    ----
# limits.cpu               8       40
# limits.memory            16Gi    80Gi
# pods                     23      100
# requests.cpu             4       20
# requests.memory          8Gi     40Gi
```

### Storage Quota

```yaml
# namespaces/production/storage-quota.yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: production-storage-quota
  namespace: production
spec:
  hard:
    # Total requested storage across all PVCs.
    requests.storage: 500Gi

    # Per-StorageClass limits.
    ssd.storageclass.storage.k8s.io/requests.storage: 200Gi
    standard.storageclass.storage.k8s.io/requests.storage: 300Gi

    # Count limits.
    persistentvolumeclaims: "50"
    ssd.storageclass.storage.k8s.io/persistentvolumeclaims: "20"
```

### Priority Class Scoped Quota

You can restrict quota to specific priority classes. This is the foundation of a multi-tier resource model:

```yaml
# namespaces/production/quota-critical.yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: critical-pods-quota
  namespace: production
spec:
  # Only count pods with the 'critical' priority class against this quota.
  scopeSelector:
    matchExpressions:
    - operator: In
      scopeName: PriorityClass
      values:
      - system-cluster-critical
      - critical
  hard:
    pods: "10"
    requests.cpu: "4"
    requests.memory: 8Gi
---
# namespaces/production/quota-standard.yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: standard-pods-quota
  namespace: production
spec:
  scopeSelector:
    matchExpressions:
    - operator: NotIn
      scopeName: PriorityClass
      values:
      - system-cluster-critical
      - critical
  hard:
    pods: "90"
    requests.cpu: "16"
    requests.memory: 32Gi
```

### BestEffort Pod Quota

```yaml
# Limit the number of BestEffort pods (pods with no requests or limits).
apiVersion: v1
kind: ResourceQuota
metadata:
  name: besteffort-quota
  namespace: development
spec:
  scopes:
  - BestEffort
  hard:
    pods: "10"
```

## Section 2: LimitRange

LimitRange controls defaults and constraints at the container level within a namespace. If a pod is created without resource requests or limits, the LimitRange injects defaults. If a pod exceeds the max allowed resources, admission is rejected.

### Container LimitRange

```yaml
# namespaces/production/limit-range.yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: production-limits
  namespace: production
spec:
  limits:
  # Container-level constraints.
  - type: Container
    # Default values injected if the container does not specify them.
    default:
      cpu: "500m"
      memory: "512Mi"
    defaultRequest:
      cpu: "100m"
      memory: "128Mi"
    # Maximum values; requests/limits cannot exceed these.
    max:
      cpu: "4"
      memory: "8Gi"
    # Minimum values; requests cannot be lower than these.
    min:
      cpu: "50m"
      memory: "64Mi"
    # max limit / min request ratio (prevents extreme overcommit per container).
    maxLimitRequestRatio:
      cpu: "10"
      memory: "8"

  # Pod-level constraints (sum of all containers).
  - type: Pod
    max:
      cpu: "8"
      memory: "16Gi"

  # PVC constraints.
  - type: PersistentVolumeClaim
    max:
      storage: 50Gi
    min:
      storage: 1Gi
```

### Verifying LimitRange Injection

```bash
# Create a pod without resource requests or limits.
kubectl run test-defaults --image=nginx -n production

# Inspect the pod to see injected defaults.
kubectl get pod test-defaults -n production -o yaml \
  | grep -A 10 resources:

# Expected output:
# resources:
#   limits:
#     cpu: 500m
#     memory: 512Mi
#   requests:
#     cpu: 100m
#     memory: 128Mi
```

### Verifying LimitRange Enforcement

```bash
# Try to create a container that exceeds the max memory limit.
kubectl run too-big \
  --image=nginx \
  -n production \
  --limits='memory=10Gi' \
  --requests='memory=10Gi'

# Expected error:
# Error from server (Forbidden):
# pods "too-big" is forbidden: [maximum memory usage per Container is 8Gi, but limit is 10Gi]
```

## Section 3: PriorityClasses

PriorityClasses assign a numeric priority to pods. Higher priority pods preempt lower priority pods when the cluster is under resource pressure.

### Defining PriorityClasses

```yaml
# cluster/priority-classes.yaml

# Critical infrastructure (e.g., monitoring, logging agents).
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: infrastructure-critical
value: 1000000
globalDefault: false
preemptionPolicy: PreemptLowerPriority
description: "Critical infrastructure components. Preempts standard workloads."
---
# Standard production workloads.
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: production-standard
value: 100000
globalDefault: true  # Applied to pods with no priorityClassName.
preemptionPolicy: PreemptLowerPriority
description: "Default priority for production workloads."
---
# Batch and background jobs.
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: batch-low
value: 10000
globalDefault: false
preemptionPolicy: Never  # Will not preempt other pods.
description: "Low priority batch jobs. Never preempts."
---
# Development namespace workloads.
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: development
value: 1000
globalDefault: false
preemptionPolicy: Never
description: "Development workloads. Lowest scheduling priority."
```

### Using PriorityClasses in Workloads

```yaml
# apps/critical-monitor/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: prometheus
  namespace: monitoring
spec:
  replicas: 2
  template:
    spec:
      # Assign the infrastructure-critical priority.
      priorityClassName: infrastructure-critical
      containers:
      - name: prometheus
        image: prom/prometheus:v2.48.0
        resources:
          requests:
            cpu: "500m"
            memory: "2Gi"
          limits:
            cpu: "2"
            memory: "4Gi"
---
# apps/batch/cronjob.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: report-generator
  namespace: production
spec:
  schedule: "0 2 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          # Batch jobs use the lowest priority.
          priorityClassName: batch-low
          restartPolicy: OnFailure
          containers:
          - name: generator
            image: report-generator:v1.0
            resources:
              requests:
                cpu: "2"
                memory: "4Gi"
              limits:
                cpu: "4"
                memory: "8Gi"
```

## Section 4: Multi-Tenant Namespace Model

For a real multi-tenant cluster, combine ResourceQuota, LimitRange, and PriorityClasses with RBAC into a cohesive tenancy model.

### Namespace Tiers

```yaml
# cluster/namespace-tiers.yaml

# Tier 1: Production namespaces (high quota, high priority).
apiVersion: v1
kind: Namespace
metadata:
  name: team-payments-prod
  labels:
    tier: production
    team: payments
    environment: production
---
# Tier 2: Staging namespaces (medium quota).
apiVersion: v1
kind: Namespace
metadata:
  name: team-payments-staging
  labels:
    tier: staging
    team: payments
    environment: staging
---
# Tier 3: Development namespaces (low quota, low priority).
apiVersion: v1
kind: Namespace
metadata:
  name: team-payments-dev
  labels:
    tier: development
    team: payments
    environment: development
```

### Tier Quota Templates

```yaml
# templates/quota-production.yaml
# Applied to all production namespaces.
apiVersion: v1
kind: ResourceQuota
metadata:
  name: production-tier-quota
spec:
  hard:
    requests.cpu: "32"
    requests.memory: 64Gi
    limits.cpu: "64"
    limits.memory: 128Gi
    pods: "200"
    services: "50"
    persistentvolumeclaims: "100"
    requests.storage: 1Ti
---
# templates/quota-staging.yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: staging-tier-quota
spec:
  hard:
    requests.cpu: "8"
    requests.memory: 16Gi
    limits.cpu: "16"
    limits.memory: 32Gi
    pods: "50"
    services: "20"
    requests.storage: 200Gi
---
# templates/quota-development.yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: development-tier-quota
spec:
  hard:
    requests.cpu: "4"
    requests.memory: 8Gi
    limits.cpu: "8"
    limits.memory: 16Gi
    pods: "20"
    services: "10"
    requests.storage: 50Gi
    # Block LoadBalancer and NodePort in dev.
    services.loadbalancers: "0"
    services.nodeports: "0"
```

### Automating Namespace Provisioning

```bash
#!/bin/bash
# scripts/provision-namespace.sh
# Usage: ./provision-namespace.sh <team> <environment> [quota-tier]

set -euo pipefail

TEAM=$1
ENV=$2
TIER=${3:-${ENV}}  # Quota tier defaults to environment name.
NS="${TEAM}-${ENV}"

echo "Provisioning namespace: ${NS}"

# Create the namespace.
kubectl create namespace "${NS}" --dry-run=client -o yaml \
  | kubectl label --local -f - \
    tier="${TIER}" \
    team="${TEAM}" \
    environment="${ENV}" \
    -o yaml \
  | kubectl apply -f -

# Apply ResourceQuota from the tier template.
kubectl apply -f "templates/quota-${TIER}.yaml" \
  --namespace="${NS}"

# Apply LimitRange.
kubectl apply -f "templates/limitrange-${TIER}.yaml" \
  --namespace="${NS}"

# Apply RBAC: give the team's group admin access.
kubectl create rolebinding "${TEAM}-admin" \
  --clusterrole=admin \
  --group="${TEAM}-team" \
  --namespace="${NS}" \
  --dry-run=client -o yaml \
  | kubectl apply -f -

echo "Namespace ${NS} provisioned successfully"
```

## Section 5: Monitoring Resource Usage

### Prometheus Queries for Quota Monitoring

```promql
# Namespace CPU request utilization (used / hard).
kube_resourcequota{resource="requests.cpu", type="used"}
  / on(namespace, resourcequota)
kube_resourcequota{resource="requests.cpu", type="hard"}

# Namespace memory request utilization.
kube_resourcequota{resource="requests.memory", type="used"}
  / on(namespace, resourcequota)
kube_resourcequota{resource="requests.memory", type="hard"}

# Namespaces close to pod count limit (>80% utilized).
(
  kube_resourcequota{resource="pods", type="used"}
    / on(namespace, resourcequota)
  kube_resourcequota{resource="pods", type="hard"}
) > 0.80

# Containers without resource requests (BestEffort).
count by(namespace) (
  kube_pod_container_info unless on(namespace, pod, container)
  kube_pod_container_resource_requests{resource="cpu"}
)
```

### Alerting Rules

```yaml
# monitoring/quota-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: resource-quota-alerts
  namespace: monitoring
spec:
  groups:
  - name: resource-quota
    rules:

    - alert: NamespaceQuotaUsageHigh
      expr: |
        (
          kube_resourcequota{resource=~"requests\\.cpu|requests\\.memory", type="used"}
            / on(namespace, resourcequota)
          kube_resourcequota{resource=~"requests\\.cpu|requests\\.memory", type="hard"}
        ) > 0.85
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Namespace quota usage above 85%"
        description: >
          Namespace {{ $labels.namespace }} is using
          {{ $value | humanizePercentage }} of its
          {{ $labels.resource }} quota.

    - alert: NamespaceQuotaExhausted
      expr: |
        (
          kube_resourcequota{type="used"}
            / on(namespace, resourcequota)
          kube_resourcequota{type="hard"}
        ) >= 1.0
      for: 1m
      labels:
        severity: critical
      annotations:
        summary: "Namespace quota exhausted"
        description: >
          Namespace {{ $labels.namespace }} has exhausted its
          {{ $labels.resource }} quota. New pods will be rejected.

    - alert: BestEffortPodsInProduction
      expr: |
        kube_pod_status_qos_class{qos_class="BestEffort",namespace=~".*-prod$"} > 0
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "BestEffort pod in production namespace"
        description: >
          Pod {{ $labels.pod }} in namespace {{ $labels.namespace }}
          has QoS class BestEffort. Add resource requests and limits.
```

## Section 6: Validating Admission with OPA/Gatekeeper

For more sophisticated policy enforcement beyond ResourceQuota and LimitRange, OPA Gatekeeper can enforce custom constraints:

```yaml
# gatekeeper/constraints/require-resources.yaml
# Require all containers to have resource requests and limits.
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequiredResources
metadata:
  name: require-resource-requests-limits
spec:
  match:
    kinds:
    - apiGroups: [""]
      kinds: ["Pod"]
    namespaceSelector:
      matchLabels:
        tier: production
  parameters:
    # Require both requests and limits for CPU and memory.
    requiredResources:
    - requests/cpu
    - requests/memory
    - limits/cpu
    - limits/memory
---
# The ConstraintTemplate defines the Rego policy.
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8srequiredresources
spec:
  crd:
    spec:
      names:
        kind: K8sRequiredResources
      validation:
        openAPIV3Schema:
          properties:
            requiredResources:
              type: array
              items:
                type: string
  targets:
  - target: admission.k8s.gatekeeper.sh
    rego: |
      package k8srequiredresources

      violation[{"msg": msg}] {
        container := input.review.object.spec.containers[_]
        required := input.parameters.requiredResources[_]
        parts := split(required, "/")
        resource_type := parts[0]
        resource_name := parts[1]
        not container.resources[resource_type][resource_name]
        msg := sprintf(
          "Container %v is missing %v/%v",
          [container.name, resource_type, resource_name]
        )
      }

      violation[{"msg": msg}] {
        container := input.review.object.spec.initContainers[_]
        required := input.parameters.requiredResources[_]
        parts := split(required, "/")
        resource_type := parts[0]
        resource_name := parts[1]
        not container.resources[resource_type][resource_name]
        msg := sprintf(
          "InitContainer %v is missing %v/%v",
          [container.name, resource_type, resource_name]
        )
      }
```

## Section 7: VPA (Vertical Pod Autoscaler) Integration

VPA automatically adjusts resource requests based on observed usage, which complements LimitRange by ensuring requests are accurate rather than guessed.

```yaml
# apps/api-service/vpa.yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: api-service-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-service

  updatePolicy:
    # "Auto" mode allows VPA to evict pods to apply recommendations.
    # "Off" mode only provides recommendations without applying them.
    updateMode: "Auto"

  resourcePolicy:
    containerPolicies:
    - containerName: api
      # VPA will not set requests below these values.
      minAllowed:
        cpu: 100m
        memory: 128Mi
      # VPA will not set requests above these values.
      # Must be within the LimitRange max.
      maxAllowed:
        cpu: "2"
        memory: 4Gi
      # Control which resources VPA manages.
      controlledResources: ["cpu", "memory"]
      # Use "RequestsOnly" to avoid changing limits.
      controlledValues: RequestsOnly
```

```bash
# Check VPA recommendations.
kubectl describe vpa api-service-vpa -n production

# Example output:
# Recommendation:
#   Container Recommendations:
#     Container Name:  api
#     Lower Bound:
#       Cpu:     150m
#       Memory:  200Mi
#     Target:
#       Cpu:     300m
#       Memory:  512Mi
#     Upper Bound:
#       Cpu:     800m
#       Memory:  1Gi
```

## Section 8: Troubleshooting Common Issues

### Pod Rejected by ResourceQuota

```bash
# Check quota status.
kubectl describe quota -n my-namespace

# Check recent admission failures.
kubectl get events -n my-namespace --sort-by='.lastTimestamp' \
  | grep -i forbidden

# Common error:
# Error from server (Forbidden): pods "my-pod" is forbidden:
# exceeded quota: production-quota, requested: limits.memory=2Gi,
# used: limits.memory=79Gi, limited: limits.memory=80Gi
```

**Resolution**: Either increase the quota, reduce the request, or delete unused resources to free up quota.

### Pod Rejected by LimitRange

```bash
# Check the LimitRange in the namespace.
kubectl describe limitrange -n my-namespace

# Common error:
# Error from server (Forbidden):
# maximum memory usage per Container is 8Gi, but limit is 10Gi
```

**Resolution**: Reduce the container's limit to be within the LimitRange max.

### BestEffort Pod Being OOM-Killed

```bash
# Check if the pod has resource requests and limits.
kubectl get pod my-pod -o yaml | grep -A 10 resources

# Check the QoS class.
kubectl get pod my-pod -o jsonpath='{.status.qosClass}'

# If BestEffort, add requests and limits to the container spec.
# This promotes it to Burstable or Guaranteed.
```

### Preemption Events

```bash
# Check for preemption events in the cluster.
kubectl get events --all-namespaces \
  --field-selector reason=Preempted \
  --sort-by='.lastTimestamp'

# Check if a pod was preempted.
kubectl describe pod my-pod | grep -A 5 "Preempted"
```

## Section 9: Complete Namespace Provisioning Example

```bash
#!/bin/bash
# scripts/provision-team-namespace.sh

set -euo pipefail

TEAM=${1:?Team name required}
ENV=${2:?Environment required}  # prod, staging, dev
NS="${TEAM}-${ENV}"

cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Namespace
metadata:
  name: ${NS}
  labels:
    team: ${TEAM}
    environment: ${ENV}
    managed-by: platform-team
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: compute-quota
  namespace: ${NS}
spec:
  hard:
    requests.cpu: "$([ "$ENV" = "prod" ] && echo "16" || echo "4")"
    requests.memory: "$([ "$ENV" = "prod" ] && echo "32Gi" || echo "8Gi")"
    limits.cpu: "$([ "$ENV" = "prod" ] && echo "32" || echo "8")"
    limits.memory: "$([ "$ENV" = "prod" ] && echo "64Gi" || echo "16Gi")"
    pods: "$([ "$ENV" = "prod" ] && echo "100" || echo "30")"
    services.loadbalancers: "$([ "$ENV" = "prod" ] && echo "5" || echo "0")"
---
apiVersion: v1
kind: LimitRange
metadata:
  name: container-limits
  namespace: ${NS}
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
      cpu: "$([ "$ENV" = "prod" ] && echo "4" || echo "2")"
      memory: "$([ "$ENV" = "prod" ] && echo "8Gi" || echo "4Gi")"
    min:
      cpu: 50m
      memory: 64Mi
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: team-admin
  namespace: ${NS}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: admin
subjects:
- kind: Group
  name: ${TEAM}-team
  apiGroup: rbac.authorization.k8s.io
EOF

echo "Namespace ${NS} provisioned for team ${TEAM} (${ENV})"
```

## Section 10: Best Practices Summary

**ResourceQuota Design**
- Set quotas at 70-80% of the total cluster capacity allocated to that tier, leaving headroom for cluster autoscaling
- Use scoped quotas to give critical workloads dedicated budget even within a shared namespace
- Always set pod count limits; unconstrained pod counts can exhaust DNS, iptables, and API server capacity

**LimitRange Design**
- Always inject defaults through LimitRange so that pods without resource specifications become Burstable rather than BestEffort
- Set the `maxLimitRequestRatio` to prevent extreme per-container overcommit (a ratio of 4-10x is typical)
- Keep minimum requests above zero to prevent scheduler starvation

**QoS Strategy**
- Guarantee QoS for all stateful workloads (databases, message queues, caches)
- Accept Burstable QoS for stateless services with well-understood load patterns
- Never allow BestEffort pods in production namespaces

**Priority Classes**
- Define at most 4-5 priority classes to keep the system comprehensible
- Always set `preemptionPolicy: Never` for batch/background jobs
- Reserve the Kubernetes built-in `system-cluster-critical` and `system-node-critical` classes for system components only

## Conclusion

ResourceQuota and LimitRange are the foundation of multi-tenant Kubernetes resource governance. Used together, they prevent noisy-neighbor problems, enforce QoS class assignment, and give the platform team visibility and control over how cluster resources are consumed. PriorityClasses add a scheduling dimension: when the cluster is under pressure, the right workloads are preempted first.

The patterns in this guide — tiered namespace templates, scoped quotas, LimitRange injection, and Prometheus alerting — provide a complete resource management framework that scales from a handful of teams to hundreds of namespaces.
