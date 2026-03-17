---
title: "Kubernetes Resource Management: Limit Ranges and Default Container Resources"
date: 2029-09-12T00:00:00-05:00
draft: false
tags: ["Kubernetes", "LimitRange", "Resource Management", "Namespaces", "VPA"]
categories: ["Kubernetes", "Operations"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Kubernetes LimitRange objects: configuring default and defaultRequest resources for containers, maxLimitRequestRatio constraints, namespace-level resource governance, and interaction with the Vertical Pod Autoscaler."
more_link: "yes"
url: "/kubernetes-resource-management-limit-ranges-defaults/"
---

Kubernetes LimitRange objects solve a common problem in multi-tenant clusters: what happens when developers forget to set resource requests and limits on their pods? Without LimitRange, those pods run without any resource constraints, potentially starving other workloads or escaping the capacity model entirely. LimitRange provides namespace-level defaults and constraints that apply automatically to every container, init container, and persistent volume claim created in the namespace.

<!--more-->

# Kubernetes Resource Management: Limit Ranges and Default Container Resources

## The Problem LimitRange Solves

Without LimitRange, a container without resource requests:
- Gets scheduled on any node regardless of available resources
- Receives `BestEffort` QoS class — first to be killed under memory pressure
- Does not count against resource quota (if quota is based on requests)
- May consume unbounded CPU and memory, affecting neighbors

A container without resource limits:
- Can consume all CPU on a node (CPU throttling only applies with limits)
- Can consume all memory on a node and trigger the OOM killer
- Gets `Burstable` QoS class (if it has requests but no limits)
- Gets `Guaranteed` QoS class only when limits = requests for all resources

LimitRange addresses this by:
1. Providing defaults that apply when developers omit requests/limits
2. Enforcing minimum and maximum bounds
3. Constraining the ratio between limits and requests

## LimitRange Resource Types

LimitRange can apply to four resource types:

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: comprehensive-limits
  namespace: production
spec:
  limits:
    - type: Container        # Per-container constraints
      default: ...
      defaultRequest: ...
      max: ...
      min: ...
      maxLimitRequestRatio: ...

    - type: Pod              # Per-pod aggregate constraints (sum across all containers)
      max: ...
      min: ...

    - type: PersistentVolumeClaim  # Per-PVC storage size constraints
      max: ...
      min: ...

    - type: InitContainer    # Per-init-container constraints
      default: ...
      defaultRequest: ...
      max: ...
      min: ...
```

## Container LimitRange: All Fields

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: container-limits
  namespace: development
spec:
  limits:
    - type: Container
      # Default values applied when a container has no limits set
      default:
        cpu: "500m"
        memory: "512Mi"
        ephemeral-storage: "1Gi"

      # Default request values applied when a container has no requests set
      # If defaultRequest is not set but default is, defaultRequest = default
      defaultRequest:
        cpu: "100m"
        memory: "128Mi"
        ephemeral-storage: "256Mi"

      # Maximum values - containers cannot set limits higher than this
      max:
        cpu: "4"
        memory: "4Gi"
        ephemeral-storage: "10Gi"

      # Minimum values - requests must be at least this much
      min:
        cpu: "10m"
        memory: "16Mi"

      # Maximum ratio of limit to request
      # A ratio of 4 means: limit <= 4 * request
      # Prevents containers from requesting tiny amounts but limiting high amounts
      maxLimitRequestRatio:
        cpu: "4"
        memory: "2"
```

## Understanding default vs defaultRequest

The distinction between `default` and `defaultRequest` is subtle but important:

```
defaultRequest: Applied when a container has NO requests set
default:        Applied when a container has NO limits set

If a container sets neither requests nor limits:
  -> Both defaultRequest and default are applied

If a container sets limits but not requests:
  -> defaultRequest is applied for requests
  -> The container's explicit limits are used

If a container sets requests but not limits:
  -> The container's explicit requests are used
  -> default is applied for limits
```

### Demonstration

Given this LimitRange:

```yaml
spec:
  limits:
    - type: Container
      default:
        cpu: "500m"
        memory: "512Mi"
      defaultRequest:
        cpu: "100m"
        memory: "128Mi"
```

And this pod spec:

```yaml
containers:
  - name: app
    image: myapp:latest
    # No resources section at all
```

After admission, the pod spec becomes:

```yaml
containers:
  - name: app
    image: myapp:latest
    resources:
      requests:
        cpu: "100m"      # from defaultRequest
        memory: "128Mi"  # from defaultRequest
      limits:
        cpu: "500m"      # from default
        memory: "512Mi"  # from default
```

If the developer sets only limits:

```yaml
containers:
  - name: app
    resources:
      limits:
        cpu: "2"
        memory: "2Gi"
```

After admission:

```yaml
containers:
  - name: app
    resources:
      requests:
        cpu: "100m"     # from defaultRequest
        memory: "128Mi" # from defaultRequest
      limits:
        cpu: "2"        # developer's explicit value
        memory: "2Gi"   # developer's explicit value
```

## maxLimitRequestRatio: Preventing Resource Speculation

The `maxLimitRequestRatio` field prevents containers from claiming small requests (to appear resource-efficient to the scheduler) while setting very high limits (to burst freely):

```yaml
spec:
  limits:
    - type: Container
      maxLimitRequestRatio:
        cpu: "4"       # limit/request <= 4
        memory: "2"    # limit/request <= 2
```

This admission is rejected:

```yaml
resources:
  requests:
    cpu: "100m"
    memory: "128Mi"
  limits:
    cpu: "2000m"    # 2000/100 = 20 > ratio of 4 -> REJECTED
    memory: "512Mi"
```

This error appears:

```
Error from server (Forbidden): pods "myapp" is forbidden:
[containers cpu limit to request ratio "20" is greater than the limit/request ratio (4.00)]
```

Corrected pod spec:

```yaml
resources:
  requests:
    cpu: "500m"       # 2000/500 = 4, exactly at the ratio limit
    memory: "256Mi"   # 512/256 = 2, exactly at the ratio limit
  limits:
    cpu: "2000m"
    memory: "512Mi"
```

## Pod LimitRange: Aggregate Constraints

Pod LimitRange applies to the total of all containers in the pod (including init containers):

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: pod-aggregate-limits
  namespace: production
spec:
  limits:
    - type: Pod
      max:
        cpu: "8"
        memory: "16Gi"
      min:
        cpu: "100m"
        memory: "128Mi"
```

This ensures no single pod can claim more than 8 CPUs or 16 GB of memory across all its containers combined. If a pod has three containers each with a 4 CPU limit (total: 12 CPU), it is rejected.

## PersistentVolumeClaim LimitRange

Storage quota is often overlooked. LimitRange applies to PVC storage requests:

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: pvc-limits
  namespace: development
spec:
  limits:
    - type: PersistentVolumeClaim
      max:
        storage: "50Gi"   # Maximum PVC size
      min:
        storage: "1Gi"    # Minimum PVC size (prevent accidental 1Mi PVCs)
```

This prevents developers from accidentally requesting 1TB PVCs or requesting extremely small PVCs that may not work with certain storage backends.

## Namespace Resource Governance Architecture

For a multi-tenant cluster, combine LimitRange with ResourceQuota and NetworkPolicy:

```yaml
# Tier 1: ResourceQuota limits namespace aggregate usage
apiVersion: v1
kind: ResourceQuota
metadata:
  name: namespace-quota
  namespace: team-alpha
spec:
  hard:
    requests.cpu: "20"
    requests.memory: "40Gi"
    limits.cpu: "40"
    limits.memory: "80Gi"
    pods: "50"
    persistentvolumeclaims: "20"
    requests.storage: "500Gi"
---
# Tier 2: LimitRange applies per-container defaults and bounds
apiVersion: v1
kind: LimitRange
metadata:
  name: container-defaults
  namespace: team-alpha
spec:
  limits:
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
        memory: "16Mi"
      maxLimitRequestRatio:
        cpu: "4"
        memory: "4"
    - type: Pod
      max:
        cpu: "8"
        memory: "16Gi"
    - type: PersistentVolumeClaim
      max:
        storage: "100Gi"
      min:
        storage: "1Gi"
```

### Automating Namespace Setup

```bash
#!/bin/bash
# create-team-namespace.sh
# Creates a namespace with standard resource governance

NAMESPACE=$1
TIER=${2:-"standard"}  # standard, premium, or basic

case $TIER in
  premium)
    CPU_LIMIT="8"
    CPU_REQUEST="2"
    MEM_LIMIT="16Gi"
    MEM_REQUEST="2Gi"
    QUOTA_CPU="80"
    QUOTA_MEM="160Gi"
    ;;
  standard)
    CPU_LIMIT="4"
    CPU_REQUEST="500m"
    MEM_LIMIT="8Gi"
    MEM_REQUEST="1Gi"
    QUOTA_CPU="40"
    QUOTA_MEM="80Gi"
    ;;
  basic)
    CPU_LIMIT="2"
    CPU_REQUEST="250m"
    MEM_LIMIT="2Gi"
    MEM_REQUEST="256Mi"
    QUOTA_CPU="10"
    QUOTA_MEM="20Gi"
    ;;
esac

kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

kubectl apply -f - <<EOF
apiVersion: v1
kind: LimitRange
metadata:
  name: default-limits
  namespace: ${NAMESPACE}
  labels:
    governance/tier: ${TIER}
spec:
  limits:
    - type: Container
      default:
        cpu: "${CPU_LIMIT}"
        memory: "${MEM_LIMIT}"
      defaultRequest:
        cpu: "${CPU_REQUEST}"
        memory: "${MEM_REQUEST}"
      max:
        cpu: "${CPU_LIMIT}"
        memory: "${MEM_LIMIT}"
      min:
        cpu: "10m"
        memory: "16Mi"
      maxLimitRequestRatio:
        cpu: "4"
        memory: "4"
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: namespace-quota
  namespace: ${NAMESPACE}
  labels:
    governance/tier: ${TIER}
spec:
  hard:
    requests.cpu: "$(echo ${QUOTA_CPU} | awk '{print $1/4}')"
    limits.cpu: "${QUOTA_CPU}"
    requests.memory: "$(echo ${QUOTA_MEM} | sed 's/Gi//' | awk '{print $1/4}')Gi"
    limits.memory: "${QUOTA_MEM}"
    pods: "100"
EOF

echo "Namespace ${NAMESPACE} created with ${TIER} tier limits"
```

## VPA Interaction with LimitRange

The Vertical Pod Autoscaler modifies container resource requests and limits based on historical usage. LimitRange constrains what VPA can set.

### How VPA Respects LimitRange

VPA fetches the LimitRange for the namespace when recommending resources. Its recommendations are clamped to the LimitRange's min and max values:

```yaml
# VPA configuration
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: myapp-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: myapp
  updatePolicy:
    updateMode: "Auto"  # or "Off" for recommendation-only
  resourcePolicy:
    containerPolicies:
      - containerName: "app"
        minAllowed:
          cpu: "50m"
          memory: "64Mi"
        maxAllowed:
          cpu: "2"
          memory: "4Gi"
        controlledResources: ["cpu", "memory"]
        # controlledValues: RequestsOnly  # Only adjust requests, not limits
```

The effective bounds for VPA recommendations:
```
effective_min = max(VPA.minAllowed, LimitRange.min)
effective_max = min(VPA.maxAllowed, LimitRange.max)
```

### Conflict: maxLimitRequestRatio and VPA

VPA can set requests independently of limits, potentially violating `maxLimitRequestRatio`. To prevent this, use `controlledValues: RequestsAndLimits`:

```yaml
containerPolicies:
  - containerName: "app"
    controlledValues: RequestsAndLimits  # VPA adjusts both together
```

Or set `controlledValues: RequestsOnly` and let developers set limits separately:

```yaml
containerPolicies:
  - containerName: "app"
    controlledValues: RequestsOnly
    # VPA only adjusts requests; limits remain as set by developer
    # This means maxLimitRequestRatio may still be violated if limits are high
```

### Testing LimitRange with VPA

```bash
# Check VPA recommendations with LimitRange in place
kubectl get vpa myapp-vpa -n production -o yaml

# Output shows recommendations and any LimitRange constraints applied:
# status:
#   recommendation:
#     containerRecommendations:
#       - containerName: app
#         lowerBound:
#           cpu: 50m      # Clamped to LimitRange.min
#           memory: 64Mi
#         target:
#           cpu: 320m
#           memory: 384Mi
#         upperBound:
#           cpu: 2000m    # Clamped to LimitRange.max
#           memory: 4Gi
#         uncappedTarget:
#           cpu: 450m
#           memory: 512Mi

# uncappedTarget shows what VPA would recommend without LimitRange constraints
```

## Inspecting Effective LimitRange

```bash
# View LimitRange in a namespace
kubectl get limitrange -n production
# NAME              CREATED AT
# container-limits  2029-09-12T10:00:00Z

kubectl describe limitrange container-limits -n production
# Name:       container-limits
# Namespace:  production
# Type        Resource               Min    Max    Default Request  Default Limit  Max Limit/Request Ratio
# ----        --------               ---    ---    ---------------  -------------  -----------------------
# Container   cpu                    10m    4      100m             500m           4
# Container   memory                 16Mi   8Gi    128Mi            512Mi          4
# Pod         cpu                    -      8      -                -              -
# Pod         memory                 -      16Gi   -                -              -

# View what a new pod would receive as defaults (dry-run)
kubectl run test-pod --image=nginx --dry-run=server -o yaml | \
    grep -A 10 resources
# resources:
#   limits:
#     cpu: 500m
#     memory: 512Mi
#   requests:
#     cpu: 100m
#     memory: 128Mi
```

## Admission Webhooks vs LimitRange

LimitRange is a built-in admission controller. Some organizations prefer Kyverno or OPA/Gatekeeper policies instead. Comparison:

| Capability | LimitRange | Kyverno/OPA |
|---|---|---|
| Default resource injection | Yes | Yes (via mutating webhook) |
| Max/min validation | Yes | Yes |
| Namespace-scoped | Yes | Can be namespace or cluster |
| Conditional rules | No | Yes (based on labels, annotations) |
| Audit mode | No | Yes (Kyverno audit mode) |
| Custom error messages | No | Yes |
| Cross-resource policies | No | Yes |

For most use cases, LimitRange is simpler and more reliable (it's built-in). For complex governance requirements (e.g., different limits based on pod labels), use Kyverno alongside LimitRange:

```yaml
# Kyverno policy to set defaults based on namespace label
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: apply-resource-defaults
spec:
  rules:
    - name: set-resources-by-tier
      match:
        any:
          - resources:
              kinds: ["Pod"]
      context:
        - name: ns
          apiCall:
            urlPath: "/api/v1/namespaces/{{request.namespace}}"
            jmesPath: "metadata.labels.\"governance/tier\""
      mutate:
        patchStrategicMerge:
          spec:
            containers:
              - (name): "*"
                resources:
                  requests:
                    +(cpu): "{{ ns == 'premium' && '500m' || '100m' }}"
                    +(memory): "{{ ns == 'premium' && '1Gi' || '256Mi' }}"
```

## LimitRange Monitoring and Enforcement Audit

```bash
# Find containers that are running without resource requests
# (LimitRange defaults should have been applied; this catches pre-LimitRange pods)
kubectl get pods -A -o json | jq '
  .items[] |
  select(.spec.containers[].resources.requests == null) |
  {
    namespace: .metadata.namespace,
    name: .metadata.name,
    containers: [.spec.containers[].name]
  }'

# Find containers that are at their LimitRange max
kubectl get pods -n production -o json | jq '
  .items[].spec.containers[] |
  select(.resources.limits.cpu == "4" or .resources.limits.memory == "8Gi") |
  {name: .name, cpu_limit: .resources.limits.cpu, mem_limit: .resources.limits.memory}'

# Prometheus query for containers without resource limits
# (using kube-state-metrics)
# kube_pod_container_resource_limits{resource="cpu"} == 0
```

### Alert for Missing Resource Limits

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: resource-limit-alerts
  namespace: monitoring
spec:
  groups:
    - name: resource-governance
      rules:
        - alert: ContainerWithoutResourceLimits
          expr: |
            count by (namespace, pod, container) (
              kube_pod_container_info
              unless on (namespace, pod, container)
              kube_pod_container_resource_limits
            ) > 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Container {{$labels.container}} in {{$labels.namespace}}/{{$labels.pod}} has no resource limits"
            description: "LimitRange defaults should have been applied. Check if LimitRange exists in this namespace."

        - alert: LimitRangeMissingFromNamespace
          expr: |
            count by (namespace) (
              kube_namespace_labels{namespace!~"kube.*|monitoring|logging"}
            ) unless on (namespace)
            count by (namespace) (kube_limitrange_info)
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Namespace {{$labels.namespace}} has no LimitRange configured"
```

## Summary

LimitRange provides the first line of defense for namespace-level resource governance:

- `default`: Applied when containers have no limits set; prevents unbounded resource usage
- `defaultRequest`: Applied when containers have no requests set; affects scheduling and QoS class
- `max/min`: Hard admission constraints; rejected pods cause clear error messages
- `maxLimitRequestRatio`: Prevents the "tiny request, huge limit" pattern that allows resource speculation
- Pod LimitRange constrains the aggregate across all containers in a pod
- PVC LimitRange prevents oversized or undersized storage requests
- VPA recommendations are clamped by LimitRange min/max; use `controlledValues: RequestsAndLimits` with `maxLimitRequestRatio`
- Combine with ResourceQuota for complete namespace capacity control
- LimitRange is always active (no controller required) unlike VPA or Kyverno
- Monitor for namespaces missing LimitRange and containers bypassing it via pre-creation
