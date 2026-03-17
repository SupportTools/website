---
title: "Kubernetes Vertical Pod Autoscaler Deep Dive: Recommendations, Modes, and Pitfalls"
date: 2029-01-08T00:00:00-05:00
draft: false
tags: ["Kubernetes", "VPA", "Autoscaling", "Resource Management", "Performance"]
categories:
- Kubernetes
- Platform Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to the Kubernetes Vertical Pod Autoscaler covering recommendation algorithms, update modes, interaction with HPA, admission webhook behavior, and production deployment strategies."
more_link: "yes"
url: "/kubernetes-vpa-deep-dive-recommendations-modes-pitfalls/"
---

Kubernetes Vertical Pod Autoscaler (VPA) addresses one of the most persistent operational challenges in container orchestration: right-sizing resource requests and limits. Manual resource configuration is error-prone—under-provisioned pods get OOMKilled or throttled, over-provisioned pods waste cluster capacity and increase costs. VPA replaces this manual process with a data-driven recommendation engine that observes historical resource consumption and automatically adjusts pod resource specifications.

This guide provides a deep technical examination of VPA's recommendation algorithm, update modes, interaction with Horizontal Pod Autoscaler, and the production pitfalls that are not obvious from the documentation.

<!--more-->

## VPA Architecture

VPA consists of three components:

**VPA Recommender**: Monitors resource consumption via the Metrics API and stores historical data in an exponentially weighted moving average. Generates recommendations for target, lower bound, and upper bound resource values.

**VPA Updater**: Watches VPA objects and evicts pods whose current resource requests fall outside the recommended range (when update mode is `Auto` or `Recreate`).

**VPA Admission Controller**: A mutating admission webhook that rewrites pod resource requests at creation time to match the current VPA recommendation. This is how `Auto` and `Initial` modes actually apply recommendations.

### Recommendation Components

VPA recommendations contain four values per resource (CPU and memory):

```
lowerBound:   Conservative estimate; pod should not need less than this
target:       The recommended value; set this as the request
upperBound:   A high estimate; limit may be set here
uncappedTarget: Recommendation ignoring the minAllowed/maxAllowed constraints
```

```bash
# View VPA recommendation for a deployment
kubectl describe vpa myapp-vpa -n production

# Example output:
# Status:
#   Conditions:
#     Last Transition Time: 2024-11-15T14:23:00Z
#     Status: True
#     Type: RecommendationProvided
#   Recommendation:
#     Container Recommendations:
#       Container Name: app
#       Lower Bound:
#         Cpu: 50m
#         Memory: 128Mi
#       Target:
#         Cpu: 150m
#         Memory: 256Mi
#       Uncapped Target:
#         Cpu: 150m
#         Memory: 256Mi
#       Upper Bound:
#         Cpu: 600m
#         Memory: 1Gi
```

## Installing VPA

### Helm Installation

```bash
# Install VPA from the official chart
helm repo add fairwinds-stable https://charts.fairwinds.com/stable
helm repo update

helm install vpa fairwinds-stable/vpa \
  --namespace kube-system \
  --version 4.5.0 \
  --set "recommender.extraArgs.memory-saver=true" \
  --set "recommender.extraArgs.pod-recommendation-min-cpu-millicores=10" \
  --set "recommender.extraArgs.pod-recommendation-min-memory-mb=10" \
  --set "recommender.extraArgs.recommendation-lower-bound-cpu-percentile=0.5" \
  --set "recommender.extraArgs.recommendation-upper-bound-cpu-percentile=0.95" \
  --set "updater.evictAfterOOMThreshold=10m" \
  --set "updater.evictionRateBurst=1" \
  --set "updater.evictionRateLimit=0.5"

# Verify VPA components
kubectl -n kube-system get pods -l app.kubernetes.io/name=vpa
```

### Verifying the Admission Webhook

```bash
# Check that VPA admission webhook is registered
kubectl get mutatingwebhookconfigurations | grep vpa

# Test that the webhook mutates a pod correctly
kubectl apply -f - <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: vpa-test-pod
  namespace: production
spec:
  containers:
    - name: test
      image: nginx:1.27.2
      resources:
        requests:
          cpu: 1m
          memory: 1Mi
EOF
# With VPA in Auto mode for this namespace, the admission webhook
# should rewrite the requests to match the recommendation
kubectl -n production get pod vpa-test-pod -o jsonpath='{.spec.containers[0].resources}'
```

## VPA Object Configuration

### Basic VPA Setup

```yaml
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
    updateMode: "Auto"
  resourcePolicy:
    containerPolicies:
      - containerName: app
        minAllowed:
          cpu: 50m
          memory: 64Mi
        maxAllowed:
          cpu: 2000m
          memory: 4Gi
        controlledResources: ["cpu", "memory"]
        # "RequestsAndLimits" or "RequestsOnly"
        controlledValues: RequestsAndLimits
```

### Update Modes Explained

```yaml
# Mode: Off
# Recommendations are computed but never applied.
# Use to observe what VPA would do before enabling automatic updates.
updatePolicy:
  updateMode: "Off"

# Mode: Initial
# Recommendations applied only at pod creation (via admission webhook).
# Running pods are never evicted or mutated.
# Safe default for production - no unexpected restarts.
updatePolicy:
  updateMode: "Initial"

# Mode: Recreate
# Pods are evicted when their resources fall outside the recommended range.
# The admission webhook applies updated resources when they restart.
# Causes pod restarts; suitable for stateless single-pod deployments.
updatePolicy:
  updateMode: "Recreate"

# Mode: Auto
# Currently equivalent to Recreate. May change when in-place updates
# (KEP-1287) graduate to stable.
updatePolicy:
  updateMode: "Auto"
```

### Multi-Container VPA

Each container in a pod can have independent VPA policies:

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: webapp-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: webapp
  updatePolicy:
    updateMode: "Initial"
  resourcePolicy:
    containerPolicies:
      - containerName: app
        minAllowed:
          cpu: 100m
          memory: 128Mi
        maxAllowed:
          cpu: 4000m
          memory: 8Gi
        controlledValues: RequestsAndLimits

      - containerName: nginx-sidecar
        minAllowed:
          cpu: 10m
          memory: 32Mi
        maxAllowed:
          cpu: 200m
          memory: 256Mi
        controlledValues: RequestsOnly   # Only control requests, not limits

      - containerName: datadog-agent
        # Exclude VPA from managing this container
        mode: "Off"
```

## The Recommendation Algorithm

VPA's recommender uses a histogram-based approach to estimate resource usage:

1. **Sample collection**: CPU usage samples are collected every 60 seconds from the Metrics API. Memory usage samples account for the maximum over the last 8 minutes (to capture memory spikes).

2. **Histogram construction**: A multi-resolution histogram tracks CPU and memory usage over time. Recent samples are weighted more heavily via exponential decay.

3. **Percentile recommendation**: The `target` recommendation is set at the CPU usage `recommendation-cpu-percentile` (default: 0.9) and memory `recommendation-memory-percentile` (default: 0.9).

4. **Safety margin**: An optional margin factor (`--recommendation-margin-fraction`, default 0.15) adds 15% to memory recommendations to prevent OOMKills at the target percentile.

### Tuning the Recommender

```yaml
# Deploy recommender with custom percentile settings
# for a latency-sensitive service
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vpa-recommender
  namespace: kube-system
spec:
  template:
    spec:
      containers:
        - name: recommender
          args:
            - --v=4
            # History window (default 8 days)
            - --history-length=168h
            # CPU recommendation at 95th percentile (default 90th)
            - --recommendation-cpu-percentile=0.95
            # Memory recommendation at 99th percentile (higher for safety)
            - --recommendation-memory-percentile=0.99
            # Add 20% safety margin to memory
            - --recommendation-margin-fraction=0.2
            # Minimum observation time before making recommendations
            - --pod-min-uptime=24h
            # Minimum CPU recommendation
            - --pod-recommendation-min-cpu-millicores=10
            - --pod-recommendation-min-memory-mb=10
```

## VPA and HPA: Avoiding Conflicts

Combining VPA with HPA on the same deployment requires careful configuration. Both autoscalers modifying the same resource specification simultaneously creates instability:

**The conflict**: HPA scales replicas based on CPU utilization (requests vs usage). VPA changes CPU requests. When VPA increases CPU requests, HPA may interpret the ratio change as lower utilization and scale down replicas, defeating the scaling intent.

### Safe HPA + VPA Configuration

```yaml
# When using VPA with HPA, VPA should NOT control CPU requests
# if HPA is scaling on CPU metrics. Restrict VPA to memory only.
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: webapp-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: webapp
  updatePolicy:
    updateMode: "Auto"
  resourcePolicy:
    containerPolicies:
      - containerName: app
        # Control only memory when HPA controls scaling based on CPU
        controlledResources: ["memory"]
        minAllowed:
          memory: 128Mi
        maxAllowed:
          memory: 8Gi
        controlledValues: RequestsAndLimits
---
# HPA scales on CPU utilization
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: webapp-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: webapp
  minReplicas: 3
  maxReplicas: 20
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
```

### KEDA + VPA: Custom Metric Scaling

When using KEDA (Kubernetes Event-Driven Autoscaler) for HPA scaling, VPA can safely control both CPU and memory since KEDA scales on external/custom metrics, not CPU utilization:

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: worker-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: message-worker
  updatePolicy:
    updateMode: "Auto"
  resourcePolicy:
    containerPolicies:
      - containerName: worker
        # Safe to control both when HPA uses queue length, not CPU
        controlledResources: ["cpu", "memory"]
        minAllowed:
          cpu: 100m
          memory: 256Mi
        maxAllowed:
          cpu: 8000m
          memory: 16Gi
```

## Production Pitfalls

### Pitfall 1: VPA Evictions During Traffic Peaks

VPA's Updater evicts pods when their actual resources deviate from recommendations. If VPA has not seen the peak traffic pattern (e.g., a marketing campaign), it may recommend resources below what the peak requires. When the peak hits, VPA might evict over-provisioned pods, causing brief unavailability precisely when traffic is highest.

**Mitigation**: Use `updateMode: Initial` for peak-sensitive services. VPA still provides recommendations (visible in the VPA status), and platform engineers can apply them during maintenance windows.

### Pitfall 2: Insufficient PodDisruptionBudget Respect

VPA's Updater does respect PodDisruptionBudgets, but the interaction can be surprising:

```yaml
# Ensure PDB prevents simultaneous evictions
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: webapp-pdb
  namespace: production
spec:
  maxUnavailable: 1
  selector:
    matchLabels:
      app: webapp
```

With `maxUnavailable: 1` and 3 replicas, VPA can only evict one pod at a time. Set `evictionRateLimit` in the VPA updater args to control the rate of evictions globally:

```bash
--eviction-rate-limit=0.5   # 0.5 evictions per second across all pods
--eviction-rate-burst=1     # Burst of 1 eviction
```

### Pitfall 3: Memory Requests Set Too Low After OOMKill

After an OOMKill, the pod restarts. VPA sees the OOMKill and may increase the memory recommendation. However, if the container is using `controlledValues: RequestsOnly`, the memory limit remains unchanged, and OOMKills will recur regardless of the request increase.

**Solution**: Use `controlledValues: RequestsAndLimits` when memory is being controlled, or explicitly set limits via `maxAllowed`:

```yaml
resourcePolicy:
  containerPolicies:
    - containerName: app
      controlledValues: RequestsAndLimits
      maxAllowed:
        memory: 4Gi   # Explicit ceiling to prevent runaway memory allocation
```

### Pitfall 4: Single-Replica Deployments and Updater Evictions

For deployments with only 1 replica, an eviction causes a brief service interruption. VPA's updater respects `minReplicas` in deployments, but a single-replica deployment with a PDB `maxUnavailable: 0` will cause the updater to stall indefinitely:

```yaml
# For single-replica deployments, use Initial mode
updatePolicy:
  updateMode: "Initial"
  # Alternatively, use evictionRequirements to gate evictions
  evictionRequirements:
    - resources: ["memory"]
      changeRequirement: TargetHigherThanRequests
```

### Pitfall 5: Requests Exceeding Node Capacity

If VPA's `maxAllowed` is not configured and the workload has burst usage patterns, VPA may recommend resource requests that exceed available node capacity, causing pods to remain in `Pending` state:

```bash
# Detect VPA-recommended pods that cannot be scheduled
kubectl get pods -A -o json | jq -r '.items[] |
  select(.status.phase=="Pending") |
  select(.metadata.annotations["vpaUpdates"] != null) |
  "\(.metadata.namespace)/\(.metadata.name): \(.status.conditions[] | select(.type=="PodScheduled") | .message)"'
```

**Solution**: Always configure `maxAllowed` in VPA container policies to a value within the capacity of your largest node. Monitor `kube_pod_container_resource_requests` to track VPA-applied resource usage.

## VPA with StatefulSets

VPA supports StatefulSets but requires additional care since stateful pod eviction has higher operational risk:

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: redis-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: StatefulSet
    name: redis
  updatePolicy:
    updateMode: "Initial"   # Never auto-evict stateful pods
    # minReplicas prevents updater from evicting below this count
    minReplicas: 2
  resourcePolicy:
    containerPolicies:
      - containerName: redis
        minAllowed:
          cpu: 100m
          memory: 256Mi
        maxAllowed:
          cpu: 4000m
          memory: 8Gi
```

## Monitoring VPA Effectiveness

### Prometheus Metrics

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: vpa-alerts
  namespace: monitoring
spec:
  groups:
    - name: vpa.recommendations
      rules:
        - alert: VPARecommendationNotAvailable
          expr: |
            kube_verticalpodautoscaler_status_recommendation_containerrecommendations_target == 0
          for: 2h
          labels:
            severity: warning
          annotations:
            summary: "VPA has no recommendation yet"
            description: "VPA {{ $labels.namespace }}/{{ $labels.verticalpodautoscaler }} has not produced recommendations after 2 hours. Check that pods are running and metrics are available."

        - alert: VPAResourcesUnderprovisioned
          expr: |
            kube_verticalpodautoscaler_status_recommendation_containerrecommendations_target{resource="memory"}
            >
            kube_verticalpodautoscaler_spec_resourcepolicy_container_policies_maxallowed{resource="memory"} * 0.9
          for: 30m
          labels:
            severity: warning
          annotations:
            summary: "VPA memory recommendation approaching maxAllowed"
            description: "VPA for {{ $labels.namespace }}/{{ $labels.verticalpodautoscaler }} container {{ $labels.container }} recommends memory near the maxAllowed limit. Consider increasing maxAllowed."
```

### VPA Recommendation Dashboard Queries

```promql
# Compare actual memory usage vs VPA recommendation
# Highlight over/under-provisioned containers

# Memory requests vs VPA target
(
  sum by (namespace, pod, container) (
    container_memory_working_set_bytes{container!=""}
  )
) / (
  sum by (namespace, pod, container) (
    kube_pod_container_resource_requests{resource="memory", container!=""}
  )
) > 0.9

# Containers where actual usage exceeds requests (at risk of OOM)
sum by (namespace, pod, container) (
  container_memory_working_set_bytes
) > sum by (namespace, pod, container) (
  kube_pod_container_resource_requests{resource="memory"}
)
```

## In-Place Pod Vertical Scaling (KEP-1287)

Kubernetes 1.29 introduced in-place pod resource updates as a beta feature, which will eventually allow VPA to modify running pods without eviction:

```bash
# Enable in-place updates (Kubernetes 1.29+)
# Feature gate: InPlacePodVerticalScaling
# In kubeadm:
kubectl -n kube-system edit cm kubeadm-config
# Add to apiServer.extraArgs:
#   feature-gates: "InPlacePodVerticalScaling=true"
# Add to kubelet-config:
#   featureGates:
#     InPlacePodVerticalScaling: true

# VPA will use in-place updates when available
# Check if a pod supports in-place resize
kubectl get pod myapp-6d4b9f -o jsonpath='{.spec.containers[0].resizePolicy}'
```

When this feature graduates to stable, `updateMode: Auto` in VPA will prefer in-place updates over eviction, dramatically reducing the disruptiveness of VPA in production.

## Summary

VPA provides essential resource right-sizing for Kubernetes workloads but requires careful configuration to operate safely in production:

- Start with `updateMode: Off` or `Initial` to build confidence in recommendations before enabling automatic evictions
- Always configure `minAllowed` and `maxAllowed` to prevent recommendations that are dangerously low or exceed node capacity
- Use `controlledValues: RequestsAndLimits` for memory to prevent limits from becoming a stale ceiling that allows OOMKills
- Restrict VPA to `controlledResources: ["memory"]` when HPA is scaling based on CPU utilization to prevent the two autoscalers from conflicting
- Monitor VPA recommendations against actual usage using Prometheus to detect systematic under- or over-provisioning patterns
- Implement PodDisruptionBudgets and configure VPA updater rate limits to prevent availability impact during bulk evictions
