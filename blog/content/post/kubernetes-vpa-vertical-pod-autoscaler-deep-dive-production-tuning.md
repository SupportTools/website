---
title: "Kubernetes VPA Deep Dive: Recommendation Engine, Update Modes, and Production Tuning"
date: 2031-06-11T00:00:00-05:00
draft: false
tags: ["Kubernetes", "VPA", "Vertical Pod Autoscaler", "Resource Management", "Autoscaling", "Performance"]
categories:
- Kubernetes
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive deep dive into the Kubernetes Vertical Pod Autoscaler covering the recommendation algorithm, update modes, LimitRange interactions, Goldilocks integration, and production tuning strategies."
more_link: "yes"
url: "/kubernetes-vpa-vertical-pod-autoscaler-deep-dive-production-tuning/"
---

Most Kubernetes teams start with the Horizontal Pod Autoscaler and ignore the Vertical Pod Autoscaler until they find applications with static resource requests that are either starved of CPU/memory or wasting cluster capacity with over-provisioned limits. The VPA solves this by continuously analyzing actual resource consumption and recommending (or automatically applying) right-sized resource requests. This guide covers the VPA recommendation algorithm in depth, the operational implications of each update mode, interactions with LimitRange and HPA, the Goldilocks dashboard for recommendation visualization, and patterns for safe production deployment.

<!--more-->

# Kubernetes VPA: Vertical Pod Autoscaler Deep Dive

## VPA Architecture

The VPA consists of three independent components:

**VPA Recommender**: Continuously queries Prometheus (or the Metrics API) for historical CPU and memory usage. It builds a histogram of resource consumption over a configurable window and calculates lower bound, target, upper bound, and uncapped target recommendations. This is the core of the VPA and runs independently of the other components.

**VPA Updater**: Evicts pods whose current resource requests deviate significantly from the recommendation. It respects PodDisruptionBudgets and only evicts when a pod can safely be replaced. The updater only acts when the VPA object is in `Auto` or `Recreate` update mode.

**VPA Admission Controller**: A mutating admission webhook that intercepts pod creation events and adjusts the resource requests/limits in the pod spec to match the VPA recommendation. This ensures newly scheduled pods start with right-sized resources even in `Initial` mode.

The VPA also includes a `history-storage` component backed by etcd that stores aggregated usage data across pod restarts, providing continuity in recommendations.

## Installing VPA

```bash
# Clone the VPA repository
git clone https://github.com/kubernetes/autoscaler.git
cd autoscaler/vertical-pod-autoscaler

# Install the VPA components
./hack/vpa-up.sh

# Verify all components are running
kubectl get pods -n kube-system | grep vpa
```

For production, use the Helm chart:

```bash
helm repo add fairwinds-stable https://charts.fairwinds.com/stable
helm repo update

helm install vpa fairwinds-stable/vpa \
  --namespace kube-system \
  --set admissionController.enabled=true \
  --set recommender.enabled=true \
  --set updater.enabled=true \
  --set recommender.extraArgs.storage=prometheus \
  --set recommender.extraArgs."prometheus-address"=http://prometheus-operated.monitoring:9090 \
  --set recommender.extraArgs."history-length"=8d
```

Using Prometheus as the history backend rather than the default Metrics API allows much longer historical windows (days to weeks instead of the last few minutes), producing more stable and accurate recommendations.

## VPA Object Specification

```yaml
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
    updateMode: "Auto"
    minReplicas: 2  # Do not evict if fewer than 2 replicas are available
  resourcePolicy:
    containerPolicies:
    - containerName: api
      minAllowed:
        cpu: 100m
        memory: 128Mi
      maxAllowed:
        cpu: 4
        memory: 8Gi
      controlledResources:
        - cpu
        - memory
      controlledValues: RequestsAndLimits
    - containerName: sidecar-proxy
      mode: "Off"  # Do not manage this container's resources
      minAllowed:
        cpu: 10m
        memory: 32Mi
      maxAllowed:
        cpu: 500m
        memory: 512Mi
```

Key fields:

- **updateMode**: Controls how recommendations are applied (see next section).
- **minReplicas**: The VPA updater will not evict pods if doing so would leave fewer than this many replicas running. Default is 2.
- **minAllowed/maxAllowed**: Bounds the recommendations. The VPA will never recommend below `minAllowed` or above `maxAllowed`. Always set `maxAllowed` to prevent runaway recommendations.
- **controlledValues**: `RequestsOnly` adjusts only requests; `RequestsAndLimits` adjusts both proportionally.
- **mode: "Off"** on a container policy means the VPA still collects data and generates recommendations but does not apply changes to that container.

## Update Modes in Depth

### Off Mode

```yaml
updatePolicy:
  updateMode: "Off"
```

The recommender collects data and generates recommendations, but neither the updater nor the admission controller takes any action. The recommendations appear in `kubectl get vpa <name> -o yaml` under `status.recommendation`. Use this mode for:

- Initial observability: run VPA in Off mode for 1–2 weeks to build a recommendation baseline before enabling automation.
- Applications that cannot tolerate any disruption (stateful workloads in specific).
- Understanding VPA behavior before committing to automation.

### Initial Mode

```yaml
updatePolicy:
  updateMode: "Initial"
```

The admission controller applies recommendations to newly created pods. The updater never evicts pods. Existing pods retain their current resource requests until they are restarted (by a deployment rollout, node eviction, etc.). Use this mode for:

- Applications where you want right-sizing on the next natural restart cycle.
- Workloads with long pod lifetimes where the overhead of VPA-triggered restarts is not acceptable.
- A conservative migration path: Initial before Auto.

### Recreate Mode

```yaml
updatePolicy:
  updateMode: "Recreate"
```

The updater evicts pods that are significantly out of range with the recommendation. The admission controller applies recommendations to new pods. This causes pod restarts when recommendations change significantly. For Deployments with multiple replicas, the updater evicts one pod at a time and respects PodDisruptionBudgets. Use for:

- Applications that can tolerate periodic restarts.
- Deployments with 3+ replicas.
- Situations where getting the right resources applied quickly matters more than avoiding restarts.

### Auto Mode

```yaml
updatePolicy:
  updateMode: "Auto"
```

Currently identical to `Recreate` mode. The intent is that future versions of the VPA will support in-place resource updates (via the `InPlacePodVerticalScaling` feature gate, available in Kubernetes 1.27+ as alpha), which would apply resource changes without restarting pods. Use `Auto` mode when you intend to benefit from in-place updates as they mature.

## Understanding VPA Recommendations

Reading a VPA recommendation:

```bash
kubectl get vpa api-service-vpa -n production -o yaml
```

```yaml
status:
  conditions:
  - lastTransitionTime: "2031-06-11T00:00:00Z"
    status: "True"
    type: RecommendationProvided
  recommendation:
    containerRecommendations:
    - containerName: api
      lowerBound:
        cpu: 200m
        memory: 256Mi
      target:
        cpu: 500m
        memory: 512Mi
      uncappedTarget:
        cpu: 500m
        memory: 512Mi
      upperBound:
        cpu: 2
        memory: 2Gi
```

**lowerBound**: The 10th percentile of usage over the history window. Setting requests below this will likely cause throttling or OOM kills.

**target**: The recommended request value. The VPA aims for the 90th percentile for memory and a CPU value that balances utilization and burst capacity. This is what gets applied to pods.

**upperBound**: The 90th or 95th percentile (depending on configuration). If requests exceed this value, the VPA considers them over-provisioned.

**uncappedTarget**: The target value before applying the `minAllowed`/`maxAllowed` bounds. Useful for detecting when your bounds are constraining the recommendation.

### The Recommendation Algorithm

The VPA uses an exponentially decaying histogram for CPU and memory:

- **Memory**: Uses the maximum usage (not average) because a container that needs 512Mi of memory needs 512Mi — averaging would miss peak usage and cause OOM kills. Memory recommendations decay slowly.
- **CPU**: Uses a percentile-based approach (typically 90th percentile) to handle bursty workloads. A CPU recommendation at the 90th percentile means the container will be throttled roughly 10% of the time, which is generally acceptable.

The decay factor means recent usage has more influence than older usage. By default, data older than 8 days is discarded. Configure this with the `--history-length` recommender argument.

### Safety Margins

The VPA applies a confidence multiplier to recommendations when data is sparse:

- **Short history** (< 24 hours): Recommendations have wide safety margins (upper bound may be 10x the target).
- **Long history** (> 1 week): Recommendations converge to tight bounds reflecting actual usage patterns.

This means VPA recommendations in the first 24 hours after deployment are conservative and will tighten as more data accumulates.

## Interactions with LimitRange

LimitRange objects define default and maximum resource constraints for pods in a namespace. VPA and LimitRange interact in potentially surprising ways:

```yaml
# Example LimitRange
apiVersion: v1
kind: LimitRange
metadata:
  name: default-limits
  namespace: production
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
      cpu: "4"
      memory: 8Gi
    min:
      cpu: 50m
      memory: 64Mi
```

The VPA's recommendations are bounded by `LimitRange.max`. If the VPA recommends 6Gi of memory but `LimitRange.max.memory` is 8Gi, the recommendation will be applied. But if the VPA recommends 10Gi and `LimitRange.max.memory` is 8Gi, the admission controller will cap the recommendation at 8Gi.

This means your `LimitRange.max` values effectively serve as a backstop for VPA's `maxAllowed`. Ensure they are aligned.

**Important**: When VPA sets a request, if there is a limit set on the container (either explicitly or via LimitRange default), the VPA may also adjust the limit proportionally (if `controlledValues: RequestsAndLimits` is set). If your limit is 2x the request and VPA doubles the request, the limit also doubles. Watch for this behavior with LimitRange defaults.

## Interactions with HPA

Running VPA and HPA on the same Deployment is problematic if both are managing CPU. The HPA scales out based on CPU utilization relative to the request; if VPA increases the request, the HPA's utilization ratio drops, potentially causing scale-in. The result is an unstable feedback loop.

### Safe HPA + VPA Combination

The supported pattern is to use VPA for memory management and HPA for CPU-based scaling:

```yaml
# HPA manages replica count based on CPU
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api-service-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-service
  minReplicas: 3
  maxReplicas: 20
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 60

---
# VPA manages only memory (disable CPU management)
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
    updateMode: "Auto"
  resourcePolicy:
    containerPolicies:
    - containerName: api
      controlledResources:
        - memory  # Only manage memory, not CPU
      minAllowed:
        memory: 256Mi
      maxAllowed:
        memory: 8Gi
```

Alternatively, use VPA in `Off` mode for CPU recommendations (informational) while HPA handles scaling:

```yaml
resourcePolicy:
  containerPolicies:
  - containerName: api
    controlledResources:
      - cpu
      - memory
    mode: "Off"  # Provide recommendations but don't apply
```

## Goldilocks: VPA Recommendation Dashboard

Goldilocks by Fairwinds runs VPA in `Off` mode on all Deployments in labeled namespaces and provides a dashboard showing recommendations alongside current resource requests. It is invaluable for identifying over-provisioned workloads across a large cluster.

### Installing Goldilocks

```bash
helm repo add fairwinds-stable https://charts.fairwinds.com/stable
helm install goldilocks fairwinds-stable/goldilocks \
  --namespace goldilocks \
  --create-namespace \
  --set dashboard.enabled=true \
  --set dashboard.service.type=ClusterIP
```

Label namespaces to enable Goldilocks VPA creation:

```bash
kubectl label namespace production goldilocks.fairwinds.com/enabled=true
kubectl label namespace staging goldilocks.fairwinds.com/enabled=true
```

Goldilocks creates a VPA object in `Off` mode for every Deployment in labeled namespaces and aggregates the recommendations in its dashboard.

Access the dashboard:

```bash
kubectl port-forward -n goldilocks svc/goldilocks-dashboard 8080:80
# Browse to http://localhost:8080
```

The dashboard shows each container with:
- Current CPU/memory requests and limits
- VPA's recommended requests and limits
- A cost estimate if using a cloud provider's pricing

### Exporting Goldilocks Data Programmatically

```bash
# Get all VPA recommendations in a namespace
kubectl get vpa -n production -o json | \
  jq -r '
    .items[] |
    .metadata.name as $name |
    .status.recommendation.containerRecommendations[]? |
    [$name, .containerName, .target.cpu, .target.memory] |
    @tsv
  '
```

## Production Deployment Patterns

### Pattern 1: Observe Before Automate

For existing deployments migrating to VPA:

```bash
# Week 1-2: Deploy in Off mode
kubectl apply -f - <<EOF
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
    updateMode: "Off"
  resourcePolicy:
    containerPolicies:
    - containerName: api
      minAllowed:
        cpu: 100m
        memory: 128Mi
      maxAllowed:
        cpu: 4
        memory: 8Gi
EOF

# After 2 weeks, check the recommendation
kubectl get vpa api-service-vpa -n production \
  -o jsonpath='{.status.recommendation}' | jq .

# If recommendation differs significantly from current requests,
# update the Deployment manually first
kubectl set resources deployment api-service \
  -c api \
  --requests="cpu=500m,memory=512Mi" \
  --limits="cpu=2,memory=2Gi"

# Week 3: Enable Initial mode
kubectl patch vpa api-service-vpa -n production \
  --type=merge \
  -p '{"spec":{"updatePolicy":{"updateMode":"Initial"}}}'

# Week 4+: Enable Auto mode if restarts are acceptable
kubectl patch vpa api-service-vpa -n production \
  --type=merge \
  -p '{"spec":{"updatePolicy":{"updateMode":"Auto"}}}'
```

### Pattern 2: VPA for Batch Jobs

VPA works well for CronJobs and batch workloads. Use `Initial` mode so each job run starts with optimal resources:

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: data-pipeline-vpa
  namespace: batch
spec:
  targetRef:
    apiVersion: batch/v1
    kind: CronJob
    name: data-pipeline
  updatePolicy:
    updateMode: "Initial"
  resourcePolicy:
    containerPolicies:
    - containerName: processor
      minAllowed:
        cpu: 500m
        memory: 1Gi
      maxAllowed:
        cpu: 16
        memory: 64Gi
      controlledResources:
        - cpu
        - memory
```

### Pattern 3: VPA with Pod Disruption Budgets

Always pair VPA in `Auto` or `Recreate` mode with a PodDisruptionBudget to prevent VPA evictions from taking down too many pods simultaneously:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-service-pdb
  namespace: production
spec:
  minAvailable: 2  # Keep at least 2 pods running during VPA evictions
  selector:
    matchLabels:
      app: api-service

---
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
    updateMode: "Auto"
    minReplicas: 3  # VPA respects this independently of PDB
```

## Tuning the Recommender

The recommender's behavior is highly configurable via command-line arguments:

```yaml
# VPA recommender deployment args
args:
- --recommender-interval=1m          # How often to recompute recommendations
- --history-length=8d                # History window for recommendations
- --history-resolution=1h            # Granularity of stored history
- --cpu-histogram-decay-half-life=24h # How quickly old CPU data loses influence
- --memory-histogram-decay-half-life=24h
- --pod-recommendation-min-cpu-millicores=25      # Minimum CPU recommendation
- --pod-recommendation-min-memory-mb=250          # Minimum memory recommendation (MB)
- --target-cpu-percentile=0.9        # CPU recommendation percentile
- --recommendation-margin-fraction=0.15  # Safety margin (15% above percentile)
- --oom-bump-up-ratio=1.2            # Memory increase multiplier after OOM
- --oom-min-bump-up-bytes=104857600  # Minimum memory bump after OOM (100MB)
```

Key tuning decisions:

**history-length**: Longer history produces more stable recommendations but is slower to respond to workload changes. For batch jobs, use shorter windows (2–3 days). For stable services, 8–14 days is appropriate.

**cpu-histogram-decay-half-life**: A 24-hour half-life means usage from 24 hours ago has half the weight of current usage. Reduce this for workloads with high variability; increase it for stable workloads.

**oom-bump-up-ratio**: When a pod OOM kills, the VPA immediately bumps the memory recommendation by this ratio. The default 1.2 (20% increase) is conservative; for memory-intensive JVM applications, 1.5 may be more appropriate.

**recommendation-margin-fraction**: Adds a safety margin on top of the percentile recommendation. The default 0.15 means the recommendation is 15% above the measured percentile.

## Troubleshooting VPA Issues

### Recommendations Not Updating

```bash
# Check recommender logs
kubectl logs -n kube-system \
  deployment/vpa-recommender \
  --tail=100 | grep -E "(ERROR|WARN|api-service)"

# Verify Metrics API is working
kubectl top pods -n production

# Check if VPA can reach Prometheus (if configured)
kubectl exec -n kube-system \
  deployment/vpa-recommender \
  -- wget -O- http://prometheus-operated.monitoring:9090/api/v1/query?query=up
```

### Admission Controller Not Applying Recommendations

```bash
# Check admission controller logs
kubectl logs -n kube-system \
  deployment/vpa-admission-controller \
  --tail=100

# Verify the webhook is registered
kubectl get mutatingwebhookconfiguration vpa-webhook-config -o yaml

# Test webhook directly with a dry-run pod creation
kubectl apply --dry-run=server -f - <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: test-pod
  namespace: production
spec:
  containers:
  - name: api
    image: nginx:latest
    resources:
      requests:
        cpu: 10m
        memory: 10Mi
EOF
```

### VPA Causing OOM Kills After Recommendation

If pods OOM kill despite VPA being enabled:

1. The VPA memory algorithm uses the 90th percentile of past usage plus a safety margin. If your workload has rare but large memory spikes (e.g., end-of-month batch processing), the VPA may underestimate the peak.

2. Increase `maxAllowed` memory so the recommendation can grow larger.

3. Use `controlledValues: RequestsOnly` and set limits manually to a higher value (e.g., 2x requests), preventing the VPA from setting the limit to the same value as the request.

```yaml
resourcePolicy:
  containerPolicies:
  - containerName: api
    controlledValues: RequestsOnly  # VPA manages only requests
    maxAllowed:
      memory: 16Gi
```

Then set a Deployment-level limit manually:
```yaml
resources:
  requests: {}  # Managed by VPA
  limits:
    memory: 16Gi  # Set manually, higher than expected VPA recommendation
```

## Monitoring VPA Health

```yaml
# prometheus-rules-vpa.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: vpa-alerts
  namespace: monitoring
spec:
  groups:
  - name: vpa
    rules:
    - alert: VPARecommenderNotRunning
      expr: absent(up{job="vpa-recommender"} == 1)
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "VPA recommender is not running"

    - alert: VPAAdmissionControllerNotRunning
      expr: absent(up{job="vpa-admission-controller"} == 1)
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "VPA admission controller is not running"
        description: "New pods will not receive VPA-adjusted resource requests"

    - alert: VPARecommendationOutOfDate
      expr: |
        time() - vpa_recommendation_last_update_time > 3600
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "VPA recommendation for {{ $labels.namespace }}/{{ $labels.target }} is stale"
```

## Conclusion

The Vertical Pod Autoscaler is one of the highest-leverage tools available to platform teams managing large Kubernetes clusters. The combination of the Observe (Off mode) → Initial → Auto migration path with proper PodDisruptionBudgets, bounded `maxAllowed` values, and Goldilocks for fleet-wide visibility provides a safe path to right-sized resource requests across all workloads. The key insight is that the VPA's value is not just in the automation — running it in Off mode across all deployments and periodically reviewing the recommendations in Goldilocks is itself valuable, exposing significant over-provisioning that wastes cluster capacity and real money.
