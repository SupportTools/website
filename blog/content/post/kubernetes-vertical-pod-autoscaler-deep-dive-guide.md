---
title: "Kubernetes VPA Deep Dive: Recommender, Updater, and Right-Sizing Production Workloads"
date: 2027-05-31T00:00:00-05:00
draft: false
tags: ["Kubernetes", "VPA", "Autoscaling", "Resource Management", "Performance", "Cost Optimization"]
categories: ["Kubernetes", "Platform Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive deep dive into Kubernetes Vertical Pod Autoscaler architecture, recommendation algorithms, update modes, VPA and HPA coexistence patterns, and production rollout strategy for enterprise workloads."
more_link: "yes"
url: "/kubernetes-vertical-pod-autoscaler-deep-dive-guide/"
---

Under-provisioned pods run out of memory and get OOM-killed. Over-provisioned pods waste compute budget and starve the scheduler of resources for other workloads. Kubernetes Vertical Pod Autoscaler (VPA) solves the right-sizing problem by continuously observing actual resource consumption and adjusting pod requests and limits to match real-world usage. This guide covers VPA's internal architecture including the exponential histogram algorithm used by the Recommender, all four update modes, safe coexistence patterns with HPA, StatefulSet and CronJob handling, and a phased production rollout strategy for enterprise clusters.

<!--more-->

## VPA Architecture

VPA consists of three independent components that can be deployed and operated separately:

```
┌─────────────────────────────────────────────────────────────┐
│                     VPA Components                          │
│                                                             │
│  ┌──────────────────┐                                       │
│  │   Recommender    │  Watches pod metrics, computes        │
│  │                  │  exponential histogram, generates     │
│  │  Metrics Server  │  VPA recommendation objects           │
│  │  or Prometheus   │                                       │
│  └────────┬─────────┘                                       │
│           │ writes recommendations                          │
│           ▼                                                 │
│  ┌──────────────────┐   ┌──────────────────────────────┐   │
│  │  VPA Objects     │   │  Updater                     │   │
│  │  (CRDs)          │◄──│                              │   │
│  │                  │   │  Evicts pods that are        │   │
│  │  spec.requests   │   │  outside target range        │   │
│  │  status.reco-    │   │  (respects PDB and min-      │   │
│  │  mmendation      │   │  HealthyReplicas)            │   │
│  └────────┬─────────┘   └──────────────────────────────┘   │
│           │ reads recommendation                            │
│           ▼                                                 │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Admission Controller (Webhook)                      │   │
│  │                                                      │   │
│  │  Intercepts pod creation/recreation, injects         │   │
│  │  recommended resource requests/limits into pod spec  │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### Recommender

The Recommender is the intelligence of VPA. It maintains a rolling window of observed CPU and memory samples for each container and applies statistical analysis to produce a recommendation that balances under- and over-provisioning.

The Recommender uses an **exponential histogram** data structure to efficiently store usage distributions without retaining every individual sample. Each histogram bucket covers an exponential range of values, so the histogram accurately captures both low and high usage events with bounded memory footprint regardless of observation window length.

From the histogram, the Recommender derives:

- **Lower Bound**: Conservative lower bound on needed resources, used to avoid excessive over-provisioning
- **Target**: The recommendation value — by default the 90th percentile of observed usage over the past 8 days
- **Upper Bound**: Conservative upper bound, used to avoid under-provisioning under peak conditions
- **Uncapped Target**: Target before minAllowed/maxAllowed bounds are applied

The default recommendation is based on the **90th percentile** of CPU usage and the **95th percentile** of memory usage. Memory uses a higher percentile because memory OOM kills are more disruptive than CPU throttling.

### Updater

The Updater periodically scans all VPA objects and identifies pods whose current resource requests deviate significantly from the Recommender's target. When deviation exceeds a configured threshold (default ±20%), the Updater evicts the pod so that a fresh pod is admitted with the updated resources via the Admission Controller webhook.

The Updater respects:

- **PodDisruptionBudgets**: Will not evict if doing so would violate the PDB's `minAvailable` or `maxUnavailable`
- **In-place updates**: On Kubernetes 1.27+ with `InPlacePodVerticalScaling` feature gate, the Updater can resize CPU resources without eviction (memory still requires restart)
- **minReplicas**: VPA does not evict the last running pod of a Deployment

### Admission Controller

The Admission Controller is a mutating webhook that intercepts pod creation. When a new pod is created (either fresh or after eviction by the Updater), the webhook looks up the VPA object targeting that pod and injects the recommended resource requests and limits before the pod is scheduled. This is the mechanism by which recommendations actually reach running pods.

## Installing VPA

```bash
# Clone the autoscaler repository to access VPA install scripts
git clone https://github.com/kubernetes/autoscaler.git
cd autoscaler/vertical-pod-autoscaler

# Install VPA components
./hack/vpa-up.sh

# Verify all three components are running
kubectl get pods -n kube-system | grep vpa
# Expected output:
# vpa-admission-controller-xxxxx   1/1   Running   0   2m
# vpa-recommender-xxxxx            1/1   Running   0   2m
# vpa-updater-xxxxx                1/1   Running   0   2m

# Verify VPA CRDs
kubectl get crd | grep autoscaling
# verticalpadautoscalers.autoscaling.k8s.io
# verticalpodautoscalercheckpoints.autoscaling.k8s.io
```

For production clusters, deploy using the Helm chart for better lifecycle management:

```bash
helm repo add fairwinds-stable https://charts.fairwinds.com/stable
helm repo update

helm install vpa fairwinds-stable/vpa \
  --namespace kube-system \
  --set admissionController.enabled=true \
  --set recommender.enabled=true \
  --set updater.enabled=true \
  --set recommender.extraArgs.storage=prometheus \
  --set recommender.extraArgs.prometheus-address=http://prometheus-operated.monitoring.svc:9090 \
  --set recommender.extraArgs.prometheus-cadvisor-job-name=kubernetes-cadvisor \
  --set recommender.resources.requests.cpu=50m \
  --set recommender.resources.requests.memory=500Mi \
  --set recommender.resources.limits.cpu=500m \
  --set recommender.resources.limits.memory=2Gi
```

## VPA Update Modes

The `updatePolicy.updateMode` field controls how aggressively VPA applies recommendations. Choosing the right mode is critical for production stability.

### Off Mode — Recommendation Only

`Off` mode runs the full Recommender pipeline but does not modify any pods. The recommendations are written to the VPA object's `status.recommendation` field for human review. This is the safest starting point for onboarding VPA to an existing cluster.

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: my-app-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: my-app
  updatePolicy:
    updateMode: "Off"
  resourcePolicy:
    containerPolicies:
      - containerName: "*"
        minAllowed:
          cpu: 10m
          memory: 32Mi
        maxAllowed:
          cpu: 4
          memory: 4Gi
        controlledResources: ["cpu", "memory"]
```

Read recommendations after at least 24 hours of production traffic:

```bash
kubectl describe vpa my-app-vpa -n production

# Look for:
# Status:
#   Recommendation:
#     Container Recommendations:
#       Container Name: my-app
#       Lower Bound:
#         Cpu:     100m
#         Memory:  128Mi
#       Target:
#         Cpu:     250m
#         Memory:  384Mi
#       Uncapped Target:
#         Cpu:     250m
#         Memory:  384Mi
#       Upper Bound:
#         Cpu:     500m
#         Memory:  768Mi
```

### Initial Mode — Apply on Pod Creation Only

`Initial` mode applies recommendations only when pods are first created. Running pods are never evicted or modified. This mode is appropriate for workloads where any interruption is unacceptable but right-sizing on the next natural restart (deployment update, scaling event) is acceptable.

```yaml
spec:
  updatePolicy:
    updateMode: "Initial"
```

### Recreate Mode — Evict When Significantly Out of Range

`Recreate` mode enables both the Admission Controller injection and the Updater eviction logic. Pods whose requests are significantly outside the recommended range are evicted so they restart with correct resources. The Updater applies eviction only when the deviation from target exceeds the configured threshold (default 20%).

```yaml
spec:
  updatePolicy:
    updateMode: "Recreate"
    minReplicas: 2  # Never evict below this replica count
```

### Auto Mode — Current Best Practice

`Auto` mode currently behaves identically to `Recreate` but is forward-compatible with in-place pod resizing (available in Kubernetes 1.27+ as alpha, 1.29 as beta). When in-place resizing becomes stable, `Auto` will prefer non-disruptive resizing over eviction for supported resource types.

```yaml
spec:
  updatePolicy:
    updateMode: "Auto"
    minReplicas: 2
```

## Container Resource Policies

The `resourcePolicy` section gives fine-grained control over VPA behavior per container.

### Setting Bounds

```yaml
spec:
  resourcePolicy:
    containerPolicies:
      # Main application container
      - containerName: app
        mode: Auto
        minAllowed:
          cpu: 50m       # Never recommend below 50m CPU
          memory: 128Mi  # Never recommend below 128Mi memory
        maxAllowed:
          cpu: "8"       # Never recommend above 8 CPU cores
          memory: 8Gi    # Never recommend above 8Gi memory
        controlledResources: ["cpu", "memory"]

      # Sidecar with stable, predictable resource needs — opt out of VPA
      - containerName: envoy-proxy
        mode: "Off"
        controlledResources: ["cpu", "memory"]

      # Init containers can also be controlled
      - containerName: db-migration
        mode: "Off"
```

### Controlling CPU vs Memory Independently

A common pattern is to use VPA for memory (which benefits most from right-sizing) while using HPA for CPU (which is better scaled horizontally):

```yaml
spec:
  resourcePolicy:
    containerPolicies:
      - containerName: app
        mode: Auto
        controlledResources: ["memory"]  # VPA manages memory only
        minAllowed:
          memory: 256Mi
        maxAllowed:
          memory: 16Gi
```

## VPA and HPA Coexistence Pattern

Running both VPA and HPA on the same metric (CPU) causes a conflict: VPA adjusts requests upward while HPA scales replicas down to compensate, leading to oscillation. The safe coexistence pattern separates their responsibilities:

**VPA manages memory; HPA manages CPU replicas.**

```yaml
# HPA targeting CPU utilization as a percentage of requests
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: my-app-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: my-app
  minReplicas: 2
  maxReplicas: 20
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 60
    # Do NOT include memory here if VPA controls memory
---
# VPA managing memory only, leaving CPU to HPA
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: my-app-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: my-app
  updatePolicy:
    updateMode: "Auto"
    minReplicas: 2
  resourcePolicy:
    containerPolicies:
      - containerName: app
        mode: Auto
        # VPA only controls memory — CPU is HPA's domain
        controlledResources: ["memory"]
        minAllowed:
          memory: 256Mi
        maxAllowed:
          memory: 8Gi
```

### Why This Works

When VPA controls only memory and HPA controls CPU replicas:

- VPA increases memory requests as memory usage grows, preventing OOM kills
- HPA adds replicas as CPU utilization rises above the target ratio
- Neither component fights the other because they operate on different dimensions
- CPU requests can still be set manually in the deployment spec as a stable baseline

## OOM Bump Behavior

VPA has a specific behavior for memory: when a container is OOM-killed, the Recommender automatically bumps the memory recommendation by a configurable factor (default 20%) regardless of what the histogram suggests. This prevents repeated OOM kill loops on workloads with sudden memory spikes.

The OOM bump is applied by watching OOM events from the kubelet and directly inflating the histogram's upper percentile for the affected container.

```bash
# View OOM events that VPA has incorporated into recommendations
kubectl get events -n production --field-selector reason=OOMKilling \
  --sort-by='.lastTimestamp' | tail -20

# Check if VPA recommendation has a recent OOM-driven bump
kubectl get vpa my-app-vpa -n production -o jsonpath='{.status.recommendation}'
```

## VPA for StatefulSets

StatefulSets require special handling because pod identity is persistent. VPA can manage StatefulSet pods but eviction behavior requires careful tuning to avoid disrupting quorum-based applications (databases, message queues).

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: postgresql-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: StatefulSet
    name: postgresql
  updatePolicy:
    updateMode: "Initial"  # Use Initial for StatefulSets to avoid forced eviction
    minReplicas: 2         # Never go below 2 healthy pods
  resourcePolicy:
    containerPolicies:
      - containerName: postgresql
        mode: Auto
        minAllowed:
          cpu: 100m
          memory: 256Mi
        maxAllowed:
          cpu: "16"
          memory: 64Gi
        controlledResources: ["cpu", "memory"]
```

For production databases, use `Off` mode to generate recommendations and apply them manually during maintenance windows:

```bash
# Get recommendations without applying them
kubectl describe vpa postgresql-vpa -n production | grep -A 30 "Container Recommendations"

# Apply recommended values to the StatefulSet during maintenance
kubectl patch statefulset postgresql -n production --type=json -p='[
  {
    "op": "replace",
    "path": "/spec/template/spec/containers/0/resources",
    "value": {
      "requests": {"cpu": "2", "memory": "8Gi"},
      "limits": {"cpu": "4", "memory": "16Gi"}
    }
  }
]'
```

## VPA for CronJobs

CronJobs and batch Jobs benefit significantly from VPA because they often have irregular, unpredictable resource needs. VPA in `Off` mode accumulates historical data across job runs and produces recommendations that account for typical peak usage.

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
    updateMode: "Auto"  # Apply on each job execution via Admission Controller
  resourcePolicy:
    containerPolicies:
      - containerName: pipeline
        mode: Auto
        minAllowed:
          cpu: 100m
          memory: 256Mi
        maxAllowed:
          cpu: "8"
          memory: 32Gi
        controlledResources: ["cpu", "memory"]
```

Because CronJob pods start and stop frequently, the `Initial` and `Auto` modes work well since every job execution creates a fresh pod that the Admission Controller intercepts.

## Goldilocks — VPA Recommendation Visualization

Goldilocks by Fairwinds is a tool that creates VPA objects in `Off` mode for every Deployment in a namespace and exposes a web dashboard summarizing the recommendations and their potential cost impact.

```bash
# Install Goldilocks
helm repo add fairwinds-stable https://charts.fairwinds.com/stable
helm upgrade --install goldilocks fairwinds-stable/goldilocks \
  --namespace goldilocks \
  --create-namespace \
  --set dashboard.enabled=true \
  --set dashboard.replicaCount=2

# Label namespaces for Goldilocks to manage
kubectl label namespace production goldilocks.fairwinds.com/enabled=true
kubectl label namespace staging goldilocks.fairwinds.com/enabled=true

# Access the dashboard
kubectl port-forward -n goldilocks svc/goldilocks-dashboard 8080:80
# Open http://localhost:8080
```

Goldilocks displays:
- Current requests/limits vs VPA Lower Bound/Target/Upper Bound
- Estimated monthly savings from right-sizing
- QoS class implications of the recommendation
- Per-container and per-namespace views

## VPA Metrics and Alerting

VPA exposes Prometheus metrics for monitoring recommendation freshness and Updater activity.

```yaml
# vpa-prometheus-rules.yaml
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
            summary: "VPA Recommender is not running"
            description: "VPA Recommender has been down for 5 minutes. Resource recommendations are stale."

        - alert: VPAAdmissionControllerNotRunning
          expr: absent(up{job="vpa-admission-controller"} == 1)
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "VPA Admission Controller is not running"
            description: "VPA Admission Controller is down. New pods will not receive VPA resource injection."

        - alert: VPARecommendationStale
          expr: |
            (time() - vpa_recommender_recommendation_last_updated_seconds) > 3600
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "VPA recommendation stale for {{ $labels.namespace }}/{{ $labels.vpa }}"
            description: "VPA recommendation has not been updated in over 1 hour. Recommender may be unable to reach metrics."

        - alert: VPAUpdaterEvictionRateHigh
          expr: rate(vpa_updater_evictions_total[5m]) > 0.5
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "High VPA eviction rate in namespace {{ $labels.namespace }}"
            description: "VPA Updater is evicting pods at a rate of {{ $value | humanize }}/s. Review VPA configuration and pod disruption budgets."
```

## Recommender Configuration for Prometheus Backend

By default, VPA Recommender uses Kubernetes Metrics Server. For historical recommendations using longer lookback windows, configure the Prometheus backend:

```yaml
# vpa-recommender-deployment-patch.yaml
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
          command:
            - /recommender
            # Use Prometheus for historical metrics (up to 8 days lookback)
            - --storage=prometheus
            - --prometheus-address=http://prometheus-operated.monitoring.svc.cluster.local:9090
            - --prometheus-cadvisor-job-name=kubernetes-cadvisor
            # Recommendation confidence thresholds
            - --target-cpu-percentile=0.9
            - --target-memory-percentile=0.95
            # OOM bump factor (20% increase after OOM kill)
            - --oom-min-bump-up-ratio=1.2
            - --oom-bump-up-ratio=1.2
            # History decay (recommendations age out after this period)
            - --cpu-histogram-decay-half-life=24h
            - --memory-histogram-decay-half-life=24h
            # Recommendation bounds
            - --recommendation-lower-bound-cpu-percentile=0.5
            - --recommendation-upper-bound-cpu-percentile=0.95
          resources:
            requests:
              cpu: 50m
              memory: 500Mi
            limits:
              cpu: 500m
              memory: 2Gi
```

## In-Place Pod Vertical Scaling (Kubernetes 1.27+)

With the `InPlacePodVerticalScaling` feature gate (beta in 1.29), VPA can resize CPU resources without restarting pods. This is a significant improvement for latency-sensitive applications that cannot tolerate the restart delay.

```bash
# Enable the feature gate on the kubelet (all nodes) and API server
# In kube-apiserver flags:
# --feature-gates=InPlacePodVerticalScaling=true

# In kubelet flags:
# --feature-gates=InPlacePodVerticalScaling=true

# Verify the feature is available
kubectl get node -o jsonpath='{.items[0].status.allocatable}' | jq .

# Check if a pod supports in-place resize
kubectl get pod my-app-pod -o jsonpath='{.status.resize}'
# Outputs: "Proposed", "InProgress", "Deferred", "Infeasible", or empty
```

VPA `Auto` mode automatically uses in-place resizing when available, falling back to eviction when memory changes require a restart.

## Production Rollout Strategy

### Phase 1: Observation (Week 1-2)

Deploy VPA in `Off` mode for all target workloads. Collect recommendations without applying them. Use Goldilocks to review the recommendations and identify workloads that are significantly over- or under-provisioned.

```bash
# Deploy VPA in Off mode for all Deployments in a namespace
for DEPLOY in $(kubectl get deploy -n production -o name); do
  NAME=$(echo "${DEPLOY}" | cut -d/ -f2)
  cat <<EOF | kubectl apply -f -
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: ${NAME}-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: ${NAME}
  updatePolicy:
    updateMode: "Off"
  resourcePolicy:
    containerPolicies:
      - containerName: "*"
        minAllowed:
          cpu: 10m
          memory: 32Mi
        maxAllowed:
          cpu: "8"
          memory: 16Gi
EOF
done
```

### Phase 2: Initial Mode (Week 3-4)

Switch low-risk workloads to `Initial` mode. Verify that pods created during deployments receive correct resource values. Monitor OOM events and throttling metrics.

```bash
# Promote a specific VPA to Initial mode
kubectl patch vpa my-app-vpa -n production \
  --type=merge \
  -p '{"spec":{"updatePolicy":{"updateMode":"Initial"}}}'
```

### Phase 3: Auto Mode for Stateless Workloads (Week 5+)

Enable `Auto` mode for stateless Deployments with PDBs in place. Monitor for excessive eviction rates and adjust `minReplicas` on VPA objects as needed.

```bash
# Verify PDB exists before enabling Auto mode
kubectl get pdb -n production

# Apply Auto mode with safety rails
kubectl patch vpa my-app-vpa -n production \
  --type=merge \
  -p '{"spec":{"updatePolicy":{"updateMode":"Auto","minReplicas":2}}}'
```

### Phase 4: StatefulSet and Critical Service Review

Review StatefulSets individually. Apply `Off` mode recommendations manually during maintenance windows. Consider `Initial` mode for StatefulSets that tolerate routine restarts (stateless services deployed as StatefulSets for stable network identities).

## Troubleshooting Common Issues

### Recommendation Not Updating

```bash
# Check if the Recommender can reach metrics
kubectl logs -n kube-system deployment/vpa-recommender --tail=100 | grep -E "error|warn|metric"

# Verify Metrics Server is running (if not using Prometheus)
kubectl get pods -n kube-system | grep metrics-server
kubectl top pod -n production | head -10

# Check VPA object for recommendation timestamp
kubectl get vpa my-app-vpa -n production -o yaml | grep -A 30 "status:"
```

### Pods Being Evicted Too Frequently

```bash
# Check Updater eviction rate
kubectl logs -n kube-system deployment/vpa-updater --tail=100 | grep "evict"

# Increase update threshold to reduce eviction frequency
# Add to vpa-updater deployment args:
# --pod-update-threshold=0.3  (default is 0.1 — 10% deviation triggers eviction)

# Alternatively, use minReplicas to protect critical services
kubectl patch vpa my-app-vpa -n production \
  --type=merge \
  -p '{"spec":{"updatePolicy":{"minReplicas":3}}}'
```

### Admission Webhook Timeout

```bash
# VPA admission webhook should have a low timeout to avoid blocking pod creation
kubectl get validatingwebhookconfigurations vpa-webhook-config -o yaml | grep timeout

# If the webhook is timing out, check admission controller logs
kubectl logs -n kube-system deployment/vpa-admission-controller --tail=100

# Configure webhook to use Fail Open (FailurePolicy: Ignore) to prevent webhook
# from blocking pod creation if VPA admission controller is unavailable
kubectl patch mutatingwebhookconfigurations vpa-webhook-config \
  --type=json \
  -p='[{"op":"replace","path":"/webhooks/0/failurePolicy","value":"Ignore"}]'
```

## VPA and KEDA Interaction

KEDA (Kubernetes Event-Driven Autoscaling) scales workloads based on external event sources such as queue depth, database row counts, or HTTP request rate. KEDA creates and manages its own HPA objects under the hood. The same coexistence rules apply: VPA should only manage memory when KEDA/HPA is managing replica count.

```yaml
# KEDA ScaledObject targeting CPU-based scaling
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: my-app-keda
  namespace: production
spec:
  scaleTargetRef:
    name: my-app
  minReplicaCount: 2
  maxReplicaCount: 50
  triggers:
    - type: external
      metadata:
        scalerAddress: custom-scaler.example.com:9090
        queueLength: "100"
---
# VPA managing memory only — KEDA manages replicas
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: my-app-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: my-app
  updatePolicy:
    updateMode: "Auto"
    minReplicas: 2
  resourcePolicy:
    containerPolicies:
      - containerName: app
        mode: Auto
        controlledResources: ["memory"]
        minAllowed:
          memory: 128Mi
        maxAllowed:
          memory: 4Gi
```

## VerticalPodAutoscalerCheckpoint

VPA persists its histogram state across Recommender restarts using `VerticalPodAutoscalerCheckpoint` objects. These are automatically managed but understanding them helps with debugging.

```bash
# List all checkpoints in a namespace
kubectl get verticalpodautoscalercheckpoints -n production

# Inspect a checkpoint (shows histogram state per container)
kubectl get vpa-checkpoint my-app-vpa-app -n production -o yaml

# Example output shows:
# spec:
#   containerName: app
#   vpaObjectName: my-app-vpa
# status:
#   cpuHistogram:
#     bucketWeights:
#       0: 100
#       3: 50
#       7: 200
#   memHistogram:
#     referenceTimestamp: "2027-05-15T00:00:00Z"
#   lastUpdateTime: "2027-05-30T12:00:00Z"

# Delete checkpoints to force fresh recommendation (useful after major workload changes)
kubectl delete verticalpodautoscalercheckpoints -n production -l app=my-app
```

## VPA Recommendation Freshness and Stability

VPA recommendations stabilize over time as the histogram accumulates usage data. During the first 24 hours after deploying VPA on a workload, recommendations may swing as the histogram fills in. Key factors affecting recommendation stability:

**Histogram decay half-life**: Configured via `--cpu-histogram-decay-half-life` and `--memory-histogram-decay-half-life` (default 24 hours). A shorter half-life causes recommendations to react faster to recent usage changes but may over-fit to transient spikes. For workloads with strong daily/weekly patterns, a 48-168 hour half-life is more appropriate.

**Lookback window**: VPA retains checkpoints for up to 8 days by default. New checkpoints expire old ones. For workloads with infrequent batch jobs (e.g., monthly reports), the lookback window may not capture peak usage unless the batch job ran within the lookback period.

**Confidence threshold**: VPA requires a minimum number of observations before generating recommendations. Low-traffic workloads or short-lived CronJob pods may take longer to accumulate sufficient data.

```bash
# Check recommendation age and confidence
kubectl get vpa my-app-vpa -n production -o jsonpath='{.status.recommendation}'

# Force the Recommender to re-process a VPA object
kubectl annotate vpa my-app-vpa -n production \
  vpa.kubernetes.io/force-recommender-sync="$(date +%s)" --overwrite
```

## Namespace-Wide VPA Policy with MutatingAdmissionWebhook

For organizations that want VPA recommendations applied automatically to all new deployments, a namespace annotation approach with a custom webhook can inject VPA objects at namespace creation time:

```yaml
# Namespace label that triggers automatic VPA creation
apiVersion: v1
kind: Namespace
metadata:
  name: team-alpha
  labels:
    vpa.example.org/auto-create: "true"
    vpa.example.org/update-mode: "Off"  # Start in observation mode
```

A namespace controller watches for this label and creates corresponding VPA objects for all Deployments found in the namespace:

```python
#!/usr/bin/env python3
"""
vpa-namespace-controller.py
Creates VPA objects in Off mode for all Deployments in labeled namespaces.
"""
from kubernetes import client, config, watch
import yaml
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

VPA_TEMPLATE = {
    "apiVersion": "autoscaling.k8s.io/v1",
    "kind": "VerticalPodAutoscaler",
    "metadata": {
        "annotations": {
            "vpa.example.org/auto-created": "true"
        }
    },
    "spec": {
        "updatePolicy": {
            "updateMode": "Off"
        },
        "resourcePolicy": {
            "containerPolicies": [
                {
                    "containerName": "*",
                    "minAllowed": {
                        "cpu": "10m",
                        "memory": "32Mi"
                    },
                    "maxAllowed": {
                        "cpu": "8",
                        "memory": "16Gi"
                    },
                    "controlledResources": ["cpu", "memory"]
                }
            ]
        }
    }
}


def ensure_vpa_for_deployment(custom_api, apps_api, namespace, deploy_name, update_mode):
    """Create VPA for a deployment if it does not already exist."""
    vpa_name = f"{deploy_name}-vpa"

    try:
        custom_api.get_namespaced_custom_object(
            group="autoscaling.k8s.io",
            version="v1",
            namespace=namespace,
            plural="verticalpodautoscalers",
            name=vpa_name
        )
        return  # Already exists
    except client.ApiException as e:
        if e.status != 404:
            raise

    vpa = VPA_TEMPLATE.copy()
    vpa["metadata"]["name"] = vpa_name
    vpa["metadata"]["namespace"] = namespace
    vpa["spec"]["targetRef"] = {
        "apiVersion": "apps/v1",
        "kind": "Deployment",
        "name": deploy_name
    }
    vpa["spec"]["updatePolicy"]["updateMode"] = update_mode

    custom_api.create_namespaced_custom_object(
        group="autoscaling.k8s.io",
        version="v1",
        namespace=namespace,
        plural="verticalpodautoscalers",
        body=vpa
    )
    logger.info("Created VPA %s in namespace %s", vpa_name, namespace)


def main():
    config.load_incluster_config()
    v1 = client.CoreV1Api()
    apps_v1 = client.AppsV1Api()
    custom_api = client.CustomObjectsApi()
    w = watch.Watch()

    for event in w.stream(v1.list_namespace):
        ns = event["object"]
        labels = ns.metadata.labels or {}

        if labels.get("vpa.example.org/auto-create") != "true":
            continue

        update_mode = labels.get("vpa.example.org/update-mode", "Off")
        namespace = ns.metadata.name

        deployments = apps_v1.list_namespaced_deployment(namespace)
        for deploy in deployments.items:
            ensure_vpa_for_deployment(
                custom_api, apps_v1, namespace, deploy.metadata.name, update_mode
            )


if __name__ == "__main__":
    main()
```

## Integrating VPA Recommendations into CI/CD

Rather than relying solely on automatic in-cluster updates, recommendations can be integrated into the GitOps workflow to update resource definitions in source control:

```bash
#!/bin/bash
# vpa-to-git.sh
# Reads VPA recommendations and opens a PR to update resource definitions

set -euo pipefail

NAMESPACE="${1:?Namespace required}"
OUTPUT_DIR="./resource-updates"
mkdir -p "${OUTPUT_DIR}"

# Collect all VPA recommendations in the namespace
kubectl get vpa -n "${NAMESPACE}" -o json | jq -r '.items[] | .metadata.name' | while read -r VPA_NAME; do
    # Get the target deployment name (assumes naming convention name-vpa)
    DEPLOY_NAME="${VPA_NAME%-vpa}"

    # Extract target recommendation
    TARGET_CPU=$(kubectl get vpa "${VPA_NAME}" -n "${NAMESPACE}" \
        -o jsonpath='{.status.recommendation.containerRecommendations[0].target.cpu}')
    TARGET_MEM=$(kubectl get vpa "${VPA_NAME}" -n "${NAMESPACE}" \
        -o jsonpath='{.status.recommendation.containerRecommendations[0].target.memory}')

    if [[ -z "${TARGET_CPU}" || -z "${TARGET_MEM}" ]]; then
        echo "No recommendation yet for ${VPA_NAME}, skipping"
        continue
    fi

    echo "VPA: ${VPA_NAME} -> CPU: ${TARGET_CPU}, Memory: ${TARGET_MEM}"

    # Generate a patch file
    cat > "${OUTPUT_DIR}/${DEPLOY_NAME}-resources.yaml" <<EOF
# Auto-generated from VPA recommendation on $(date -u +%Y-%m-%dT%H:%MZ)
# VPA: ${VPA_NAME}
resources:
  requests:
    cpu: "${TARGET_CPU}"
    memory: "${TARGET_MEM}"
EOF
done

echo "Resource update files written to ${OUTPUT_DIR}/"
echo "Review and commit these changes to update manifests in source control"
```

## Cost Impact Analysis

VPA's primary financial benefit comes from reducing waste in over-provisioned workloads. A typical enterprise Kubernetes cluster has 30-60% resource waste in memory and 20-40% in CPU due to conservative manual requests set at initial deployment and never revisited.

```bash
# Estimate potential savings by comparing current requests to VPA targets
kubectl get vpa -n production -o json | jq -r '
  .items[] |
  {
    name: .metadata.name,
    current_cpu: .spec.resourcePolicy.containerPolicies[0].minAllowed.cpu,
    recommended_cpu: .status.recommendation.containerRecommendations[0].target.cpu,
    current_mem: .spec.resourcePolicy.containerPolicies[0].minAllowed.memory,
    recommended_mem: .status.recommendation.containerRecommendations[0].target.memory
  }
'

# A dashboard query to track cluster-wide resource efficiency:
# Actual usage / Requested resources
# CPU efficiency:
#   sum(rate(container_cpu_usage_seconds_total[5m])) /
#   sum(kube_pod_container_resource_requests{resource="cpu"})
#
# Memory efficiency:
#   sum(container_memory_working_set_bytes) /
#   sum(kube_pod_container_resource_requests{resource="memory"})
```

VPA is one of the highest-ROI investments available to mature Kubernetes platform teams. A phased rollout starting with `Off` mode observation, moving to `Initial` mode for injection, and finally enabling `Auto` mode for stateless workloads captures the majority of the efficiency gains while protecting production stability. The VPA + HPA coexistence pattern with separated CPU/memory responsibility enables full autoscaling coverage without the oscillation risks that arise from conflicting controllers targeting the same metrics.
