---
title: "Kubernetes Vertical Pod Autoscaler Production Implementation: Modes, Limits, and Recommendations"
date: 2028-05-01T00:00:00-05:00
draft: false
tags: ["Kubernetes", "VPA", "Autoscaling", "Resource Management", "Production"]
categories: ["Kubernetes", "Performance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete production guide to Kubernetes Vertical Pod Autoscaler covering recommendation modes, limit policy configuration, avoiding OOM thrash, integrating VPA with HPA, and building a resource right-sizing workflow for enterprise clusters."
more_link: "yes"
url: "/kubernetes-vpa-production-implementation-guide/"
---

The Vertical Pod Autoscaler (VPA) automatically adjusts container resource requests and limits based on observed usage patterns. Poorly configured VPA deployments cause unnecessary pod restarts and capacity waste; well-tuned VPA becomes a continuous right-sizing engine. This guide covers every VPA mode, recommendation policies, HPA coexistence, and the operational workflow for using VPA recommendations in production without disruption.

<!--more-->

# Kubernetes Vertical Pod Autoscaler Production Implementation: Modes, Limits, and Recommendations

## VPA Architecture

VPA has three components:

**VPA Recommender**: Analyzes historical resource usage from the metrics API and Prometheus. Computes recommendations using a histogram-based algorithm that models CPU as a spike-tolerant resource and memory as a steady-state resource.

**VPA Updater**: Watches for pods whose resource requests differ significantly from recommendations. Evicts pods that need resource adjustments (the pod is then recreated with updated requests by its controller).

**VPA Admission Controller**: Webhook that modifies pod resource requests and limits at creation time based on VPA recommendations. This is the path for `Auto` and `Initial` modes.

```
Metrics API / Prometheus
        ↓
VPA Recommender → VerticalPodAutoscaler.status.recommendation
        ↓
VPA Updater → evict pods needing updates (Auto mode only)
        ↓
VPA Admission Controller → patch resource requests on pod creation
```

## Installing VPA

```bash
# Clone the kubernetes/autoscaler repo for the VPA installer
git clone https://github.com/kubernetes/autoscaler.git
cd autoscaler/vertical-pod-autoscaler

# Install using the official installer
./hack/vpa-up.sh

# Verify components are running
kubectl get pods -n kube-system -l app=vpa-recommender
kubectl get pods -n kube-system -l app=vpa-updater
kubectl get pods -n kube-system -l app=vpa-admission-controller
```

Alternatively, use the Fairwinds Goldilocks Helm chart which includes VPA:

```bash
helm repo add fairwinds-stable https://charts.fairwinds.com/stable
helm install vpa fairwinds-stable/vpa \
  --namespace vpa \
  --create-namespace \
  --version 4.4.6 \
  --set "recommender.extraArgs.pod-recommendation-min-cpu-millicores=10" \
  --set "recommender.extraArgs.pod-recommendation-min-memory-mb=10" \
  --set "recommender.extraArgs.recommendation-margin-fraction=0.15"
```

## VPA Modes

VPA supports four update modes:

| Mode | Behavior | Use Case |
|------|----------|----------|
| `Off` | Compute recommendations, never apply | Read-only analysis, reporting |
| `Initial` | Apply at pod creation only, never evict | Safe for stateful apps, won't restart pods |
| `Recreate` | Apply at creation + evict pods when recommendations change significantly | Standard stateless apps |
| `Auto` | Same as Recreate currently; will use in-place updates when available | Preferred for stateless workloads |

### Off Mode: Recommendation-Only

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: api-server-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-server
  updatePolicy:
    updateMode: "Off"
  # No resourcePolicy = use defaults for all containers
```

Check recommendations:

```bash
kubectl describe vpa api-server-vpa -n production

# Output includes:
# Recommendation:
#   Container Recommendations:
#     Container Name: api-server
#       Lower Bound:
#         Cpu:     75m
#         Memory:  262144k
#       Target:
#         Cpu:     150m
#         Memory:  524288k
#       Uncapped Target:
#         Cpu:     150m
#         Memory:  524288k
#       Upper Bound:
#         Cpu:     500m
#         Memory:  2Gi
```

### Initial Mode for Stateful Applications

Initial mode applies recommendations at pod creation but never triggers evictions. Safe for StatefulSets, databases, and caching layers:

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
    updateMode: "Initial"
  resourcePolicy:
    containerPolicies:
      - containerName: redis
        minAllowed:
          cpu: "100m"
          memory: "128Mi"
        maxAllowed:
          cpu: "2"
          memory: "4Gi"
        controlledResources: ["cpu", "memory"]
        controlledValues: RequestsAndLimits
```

### Auto Mode for Stateless Services

Auto mode evicts pods when recommendations diverge from current requests by more than the configured threshold (default: 10% CPU or memory):

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: order-service-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: order-service
  updatePolicy:
    updateMode: "Auto"
    # Minimum replicas required before VPA will evict
    # Prevents evicting the last pod
    minReplicas: 2
  resourcePolicy:
    containerPolicies:
      - containerName: order-service
        minAllowed:
          cpu: "50m"
          memory: "64Mi"
        maxAllowed:
          cpu: "4"
          memory: "8Gi"
        controlledResources: ["cpu", "memory"]
        # Adjust requests but keep limits as a separate multiplier
        controlledValues: RequestsOnly
```

## Resource Policy Configuration

### Container-Level Policies

```yaml
spec:
  resourcePolicy:
    containerPolicies:
      # Main application container
      - containerName: app
        minAllowed:
          cpu: "100m"      # Never recommend below 100m CPU
          memory: "256Mi"  # Never recommend below 256 MiB RAM
        maxAllowed:
          cpu: "8"         # Never recommend above 8 CPU cores
          memory: "16Gi"   # Never recommend above 16 GiB RAM
        controlledResources: ["cpu", "memory"]
        controlledValues: RequestsAndLimits

      # Sidecar containers often need fixed resources
      - containerName: istio-proxy
        mode: "Off"  # Don't manage sidecar resources

      # Init containers can be tuned
      - containerName: db-migrator
        minAllowed:
          cpu: "100m"
          memory: "128Mi"
        maxAllowed:
          cpu: "2"
          memory: "2Gi"
```

### controlledValues: RequestsOnly vs RequestsAndLimits

`RequestsAndLimits` (default): VPA adjusts both requests and limits, maintaining the same ratio between them that was set in the original spec.

`RequestsOnly`: VPA only adjusts requests, leaving limits unchanged. Use this when you want to maintain a fixed limit as a ceiling while VPA optimizes the request (scheduling size).

```yaml
# Pattern: Fixed limit ceiling + VPA-managed request
# Deployment spec:
spec:
  containers:
    - name: app
      resources:
        requests:
          cpu: "200m"      # VPA will adjust this
          memory: "512Mi"  # VPA will adjust this
        limits:
          cpu: "2000m"     # VPA leaves this alone
          memory: "2Gi"    # VPA leaves this alone

# VPA spec:
spec:
  resourcePolicy:
    containerPolicies:
      - containerName: app
        controlledValues: RequestsOnly
        minAllowed:
          cpu: "100m"
          memory: "256Mi"
        maxAllowed:
          cpu: "2000m"     # Must match the limit to avoid scheduling larger than limit
          memory: "2Gi"
```

## VPA and HPA Coexistence

Using VPA and HPA on the same deployment is safe only with specific resource configurations. Never run both on the same metric (e.g., both scaling on CPU).

### Safe Pattern: VPA on Memory + HPA on CPU

```yaml
# HPA scales on CPU utilization
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: order-service-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: order-service
  minReplicas: 3
  maxReplicas: 20
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
---
# VPA only manages memory requests
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: order-service-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: order-service
  updatePolicy:
    updateMode: "Auto"
  resourcePolicy:
    containerPolicies:
      - containerName: order-service
        # Only control memory - let HPA manage CPU utilization
        controlledResources: ["memory"]
        controlledValues: RequestsOnly
        minAllowed:
          memory: "256Mi"
        maxAllowed:
          memory: "8Gi"
```

### Pattern: VPA Off + HPA for All Scaling

When HPA handles CPU-based scaling, VPA in `Off` mode provides recommendations that inform capacity planning without interfering:

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: api-service-sizing-advisor
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-service
  updatePolicy:
    updateMode: "Off"  # Advisory only
```

## Goldilocks: VPA Recommendations Dashboard

Goldilocks provides a web dashboard showing VPA recommendations for all namespaces:

```bash
helm install goldilocks fairwinds-stable/goldilocks \
  --namespace goldilocks \
  --create-namespace \
  --set dashboard.enabled=true

# Label namespaces to include in Goldilocks
kubectl label namespace production goldilocks.fairwinds.com/enabled=true
kubectl label namespace staging goldilocks.fairwinds.com/enabled=true

# Access the dashboard
kubectl port-forward -n goldilocks svc/goldilocks-dashboard 8080:80
```

Goldilocks creates VPA objects in `Off` mode for every Deployment in labeled namespaces and displays recommendations in a web UI with copy-paste YAML.

## Handling OOM Thrash

VPA memory recommendations use the 95th percentile of observed memory. If a workload has occasional large spikes, VPA may recommend too little memory, causing repeated OOM kills that trigger further VPA evictions.

### Symptoms

```bash
# OOM kills visible in events
kubectl get events -n production --field-selector reason=OOMKilling

# VPA constantly evicting pods
kubectl get events -n production | grep -i "VerticalPodAutoscaler"

# Pod restart count increasing
kubectl get pods -n production -o json | \
  jq -r '.items[] | [.metadata.name, (.status.containerStatuses[0].restartCount | tostring)] | @tsv' | \
  sort -k2 -rn | head -10
```

### Solutions

**Increase memory recommendation margin:**

```bash
# Deploy VPA recommender with higher margin
helm upgrade vpa fairwinds-stable/vpa \
  --namespace vpa \
  --reuse-values \
  --set "recommender.extraArgs.recommendation-margin-fraction=0.25"
# 0.25 = add 25% buffer above observed peak
```

**Use a higher percentile:**

```bash
--set "recommender.extraArgs.target-cpu-percentile=0.9"
--set "recommender.extraArgs.target-memory-percentile=0.99"
```

**Set conservative minimums for memory-spiky workloads:**

```yaml
spec:
  resourcePolicy:
    containerPolicies:
      - containerName: java-service
        minAllowed:
          # JVM needs at least this much to start
          cpu: "500m"
          memory: "2Gi"
        maxAllowed:
          cpu: "8"
          memory: "32Gi"
```

**Use Initial mode to prevent eviction storms:**

```yaml
updatePolicy:
  updateMode: "Initial"
  # Only apply recommendations at pod creation, never evict
```

## Prometheus-Based Custom Recommender

For applications where resource usage depends on external signals (queue depth, request rate), a custom recommender can feed recommendations to VPA via the status API:

```go
package main

import (
    "context"
    "fmt"
    "time"

    vpav1 "k8s.io/autoscaler/vertical-pod-autoscaler/pkg/apis/autoscaling.k8s.io/v1"
    vpaclient "k8s.io/autoscaler/vertical-pod-autoscaler/pkg/client/clientset/versioned"
    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/api/resource"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

type CustomRecommender struct {
    vpaClient   vpaclient.Interface
    promClient  PrometheusClient
    namespace   string
}

// UpdateRecommendations fetches queue-depth-aware recommendations and patches VPA status.
func (r *CustomRecommender) UpdateRecommendations(ctx context.Context, vpaName string) error {
    // Get queue depth from Prometheus
    queueDepth, err := r.promClient.QueryScalar(ctx,
        `rabbitmq_queue_messages{queue="order-processing"}`)
    if err != nil {
        return fmt.Errorf("querying queue depth: %w", err)
    }

    // Scale CPU request based on queue depth
    cpuMillicores := 200 + int64(queueDepth*10)
    if cpuMillicores > 4000 {
        cpuMillicores = 4000
    }

    recommendation := &vpav1.RecommendedPodResources{
        ContainerRecommendations: []vpav1.RecommendedContainerResources{
            {
                ContainerName: "order-processor",
                Target: corev1.ResourceList{
                    corev1.ResourceCPU: *resource.NewMilliQuantity(
                        cpuMillicores, resource.DecimalSI),
                    corev1.ResourceMemory: resource.MustParse("512Mi"),
                },
                LowerBound: corev1.ResourceList{
                    corev1.ResourceCPU:    resource.MustParse("200m"),
                    corev1.ResourceMemory: resource.MustParse("256Mi"),
                },
                UpperBound: corev1.ResourceList{
                    corev1.ResourceCPU:    resource.MustParse("4"),
                    corev1.ResourceMemory: resource.MustParse("2Gi"),
                },
            },
        },
    }

    // Patch VPA status with our recommendation
    vpa, err := r.vpaClient.AutoscalingV1().VerticalPodAutoscalers(r.namespace).Get(
        ctx, vpaName, metav1.GetOptions{})
    if err != nil {
        return fmt.Errorf("getting VPA: %w", err)
    }

    vpa.Status.Recommendation = recommendation

    _, err = r.vpaClient.AutoscalingV1().VerticalPodAutoscalers(r.namespace).UpdateStatus(
        ctx, vpa, metav1.UpdateOptions{})
    return err
}
```

## Monitoring VPA Recommendations

### Prometheus Metrics from VPA

VPA exposes Prometheus metrics for monitoring:

```promql
# Current memory recommendation for all containers
kube_verticalpodautoscaler_status_recommendation_containerrecommendations_target{resource="memory"}

# CPU recommendations vs current requests
kube_verticalpodautoscaler_status_recommendation_containerrecommendations_target{resource="cpu"}
/
kube_pod_container_resource_requests{resource="cpu"}

# VPA update counts (how often pods are evicted for resizing)
kube_verticalpodautoscaler_status_conditions{condition="RecommendationProvided",status="True"}
```

### PrometheusRule for VPA Alerting

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: vpa-alerts
  namespace: monitoring
spec:
  groups:
    - name: vpa.alerts
      rules:
        - alert: VPARecommendationStale
          expr: |
            time() - kube_verticalpodautoscaler_status_recommendation_containerrecommendations_lowerbound{resource="memory"}
            > 86400
          for: 2h
          labels:
            severity: warning
          annotations:
            summary: "VPA recommendation is stale for {{ $labels.container }}"

        - alert: ContainerUnderCPURequest
          expr: |
            sum by (namespace, pod, container) (
              rate(container_cpu_usage_seconds_total[5m])
            ) /
            sum by (namespace, pod, container) (
              kube_pod_container_resource_requests{resource="cpu"}
            ) > 2.0
          for: 30m
          labels:
            severity: warning
          annotations:
            summary: "Container {{ $labels.container }} in {{ $labels.pod }} is using 2x CPU request"
            description: "Consider increasing CPU request or enabling VPA"

        - alert: ContainerOOMKilled
          expr: |
            kube_pod_container_status_last_terminated_reason{reason="OOMKilled"} == 1
          for: 0m
          labels:
            severity: warning
          annotations:
            summary: "Container {{ $labels.container }} in {{ $labels.pod }} was OOM killed"
```

## Right-Sizing Workflow

### Weekly Right-Sizing Review Process

```bash
#!/bin/bash
# weekly-rightsizing-report.sh

NAMESPACE="${1:-production}"
REPORT_FILE="rightsizing-report-$(date +%Y%m%d).csv"

echo "Namespace,Deployment,Container,CurrentCPUReq,VPATargetCPU,CurrentMemReq,VPATargetMem,Action" > "$REPORT_FILE"

# Get all VPA objects in namespace
kubectl get vpa -n "$NAMESPACE" -o json | \
jq -r '.items[] |
  .metadata.name as $name |
  .spec.targetRef.name as $deploy |
  .status.recommendation.containerRecommendations[] |
  [$name, $deploy, .containerName,
   (.target.cpu // "N/A"),
   (.target.memory // "N/A")] |
  @csv' | \
while IFS=, read -r vpa_name deploy container target_cpu target_mem; do
    # Get current requests
    current_cpu=$(kubectl get deploy "$deploy" -n "$NAMESPACE" -o jsonpath=\
"{.spec.template.spec.containers[?(@.name==${container})].resources.requests.cpu}" 2>/dev/null || echo "not-set")
    current_mem=$(kubectl get deploy "$deploy" -n "$NAMESPACE" -o jsonpath=\
"{.spec.template.spec.containers[?(@.name==${container})].resources.requests.memory}" 2>/dev/null || echo "not-set")

    # Recommend action
    action="OK"
    if [ "$current_cpu" = "not-set" ] || [ "$current_mem" = "not-set" ]; then
        action="SET_REQUESTS"
    fi

    echo "$NAMESPACE,$deploy,$container,$current_cpu,$target_cpu,$current_mem,$target_mem,$action" >> "$REPORT_FILE"
done

echo "Report written to $REPORT_FILE"
```

### Applying VPA Recommendations to Deployment Specs

```bash
#!/bin/bash
# apply-vpa-recommendations.sh
# Reads VPA recommendations and patches Deployment resource requests

NAMESPACE="${1}"
DEPLOYMENT="${2}"
VPA_NAME="${3:-${DEPLOYMENT}-vpa}"

if [ -z "$NAMESPACE" ] || [ -z "$DEPLOYMENT" ]; then
    echo "Usage: $0 <namespace> <deployment> [vpa-name]"
    exit 1
fi

echo "Applying VPA recommendations for $DEPLOYMENT in $NAMESPACE..."

# Get recommendations
kubectl get vpa "$VPA_NAME" -n "$NAMESPACE" -o json | \
jq -r '.status.recommendation.containerRecommendations[] |
  "Container: \(.containerName) | CPU: \(.target.cpu) | Memory: \(.target.memory)"'

echo ""
read -p "Apply these recommendations to the Deployment? [y/N] " confirm
if [ "$confirm" != "y" ]; then
    echo "Aborted"
    exit 0
fi

# Patch each container
kubectl get vpa "$VPA_NAME" -n "$NAMESPACE" -o json | \
jq -c '.status.recommendation.containerRecommendations[]' | \
while read -r container_rec; do
    CONTAINER=$(echo "$container_rec" | jq -r '.containerName')
    CPU=$(echo "$container_rec" | jq -r '.target.cpu')
    MEMORY=$(echo "$container_rec" | jq -r '.target.memory')

    # Generate JSON Patch for this container
    PATCH=$(cat << EOF
[
  {
    "op": "replace",
    "path": "/spec/template/spec/containers/0/resources/requests/cpu",
    "value": "$CPU"
  },
  {
    "op": "replace",
    "path": "/spec/template/spec/containers/0/resources/requests/memory",
    "value": "$MEMORY"
  }
]
EOF
)

    kubectl patch deployment "$DEPLOYMENT" -n "$NAMESPACE" \
        --type json \
        --patch "$PATCH"

    echo "Patched $CONTAINER: CPU=$CPU Memory=$MEMORY"
done
```

## VPA Limitations and Workarounds

### Limitation: Pod Eviction Causes Downtime

VPA currently updates resources by evicting pods (triggering recreation). For single-replica Deployments this causes brief downtime.

Workarounds:
1. Always maintain `minReplicas: 2` in Deployments that use VPA Auto mode
2. Configure `PodDisruptionBudget` to limit simultaneous evictions
3. Use `Initial` mode for sensitive applications

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-service-pdb
  namespace: production
spec:
  minAvailable: 1  # At least 1 pod must be available during VPA eviction
  selector:
    matchLabels:
      app: api-service
```

### Limitation: No CronJob Support

VPA does not support CronJobs directly. Apply VPA to the underlying Job template:

```bash
# VPA does not support CronJob targetRef
# Workaround: analyze previous Job runs and set requests manually
kubectl get jobs -n batch-processing -o json | \
  jq '[.items[] | {
    name: .metadata.name,
    cpu_peak: .status.active,
    completed: .status.succeeded
  }]'
```

### Limitation: Cold Start Recommendations

VPA needs at least 1 day of data before producing useful recommendations. New deployments start with default values.

Workaround: Bootstrap VPA with custom initial recommendations using the LimitRange:

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: default-resources
  namespace: production
spec:
  limits:
    - type: Container
      default:          # Default limits if not specified
        cpu: "500m"
        memory: "512Mi"
      defaultRequest:   # Default requests if not specified
        cpu: "100m"
        memory: "128Mi"
      min:
        cpu: "10m"
        memory: "32Mi"
      max:
        cpu: "8"
        memory: "16Gi"
```

## Summary

VPA is a powerful tool when deployed with production discipline:

- Start all VPAs in `Off` mode for 2 weeks to gather recommendation data before enabling updates
- Use `Initial` mode for StatefulSets and databases to prevent disruptive evictions
- Use `Auto` mode with `controlledValues: RequestsOnly` for stateless services alongside HPA
- When using VPA with HPA, restrict VPA to memory-only management to avoid conflicting scale signals
- Set `minAllowed` based on application startup requirements to prevent VPA from recommending unusably small resources
- Monitor OOMKill events; if they increase after enabling VPA, increase `recommendation-margin-fraction`
- The weekly right-sizing workflow using VPA in `Off` mode provides a safe, human-reviewed path to reducing resource waste without automation risk
