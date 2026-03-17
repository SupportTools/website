---
title: "Kubernetes Vertical Pod Autoscaler Deep Dive: Recommendations and Admission"
date: 2029-06-16T00:00:00-05:00
draft: false
tags: ["Kubernetes", "VPA", "Autoscaling", "Resource Management", "Goldilocks", "Performance"]
categories: ["Kubernetes", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into the Kubernetes Vertical Pod Autoscaler: VPA modes (Off, Initial, Auto), the recommendation algorithm, LimitRange interaction, combining VPA with HPA, and using Goldilocks for right-sizing workloads in production."
more_link: "yes"
url: "/kubernetes-vpa-deep-dive-recommendations-admission/"
---

The Vertical Pod Autoscaler (VPA) addresses one of the most common Kubernetes operational problems: over-provisioned and under-provisioned resource requests. Engineers either set requests too high (wasting cluster capacity) or too low (causing OOM kills and CPU throttling). VPA observes actual resource usage and either recommends or automatically adjusts requests. This guide covers VPA's architecture, operating modes, the recommendation algorithm, and practical patterns for production use.

<!--more-->

# Kubernetes Vertical Pod Autoscaler Deep Dive: Recommendations and Admission

## VPA Architecture

VPA consists of three components:

```
┌─────────────────────────────────────────────────────┐
│ VPA Components                                      │
│                                                     │
│  ┌────────────────┐   ┌────────────────────────┐   │
│  │  Recommender   │   │  Admission Controller  │   │
│  │                │   │                        │   │
│  │ Watches:       │   │ Intercepts pod creation│   │
│  │ - VPA objects  │   │ Mutates resource       │   │
│  │ - Metrics API  │   │ requests to match VPA  │   │
│  │ - History API  │   │ recommendation         │   │
│  │                │   │                        │   │
│  │ Produces:      │   └────────────────────────┘   │
│  │ - Recommended  │                                 │
│  │   requests     │   ┌────────────────────────┐   │
│  └────────────────┘   │  Updater               │   │
│                       │                        │   │
│                       │ Evicts pods when VPA   │   │
│                       │ recommendation differs │   │
│                       │ significantly from     │   │
│                       │ current requests       │   │
│                       └────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

### Installation

```bash
# Install VPA using the official script
git clone https://github.com/kubernetes/autoscaler.git
cd autoscaler/vertical-pod-autoscaler/
./hack/vpa-up.sh

# Or with Helm
helm repo add fairwinds-stable https://charts.fairwinds.com/stable
helm install vpa fairwinds-stable/vpa \
    --namespace vpa \
    --create-namespace \
    --set admissionController.enabled=true \
    --set recommender.enabled=true \
    --set updater.enabled=true

# Verify
kubectl get pods -n kube-system | grep vpa
# vpa-admission-controller-xxx   1/1   Running
# vpa-recommender-xxx            1/1   Running
# vpa-updater-xxx                1/1   Running
```

## VPA Modes

VPA operates in four modes, controlled by the `updateMode` field:

### Off Mode (Recommendation Only)

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
    updateMode: "Off"  # Generate recommendations but do NOT apply them

  resourcePolicy:
    containerPolicies:
    - containerName: myapp
      # Min and max bounds for recommendations
      minAllowed:
        cpu: 50m
        memory: 64Mi
      maxAllowed:
        cpu: "4"
        memory: 4Gi
      controlledResources: ["cpu", "memory"]
```

```bash
# View recommendations
kubectl describe vpa myapp-vpa -n production
# Recommendation:
#   Container Recommendations:
#     Container Name:  myapp
#     Lower Bound:     cpu: 250m, memory: 512Mi
#     Target:          cpu: 400m, memory: 768Mi
#     Uncapped Target: cpu: 400m, memory: 768Mi
#     Upper Bound:     cpu: 2, memory: 2Gi

# The fields mean:
# LowerBound: minimum resources — below this, the pod will struggle
# Target: recommended setting — what VPA would apply in Auto mode
# UpperBound: maximum reasonable amount — above this, wasteful
# UncappedTarget: recommendation without min/maxAllowed bounds applied
```

### Initial Mode (Apply Only at Pod Creation)

```yaml
spec:
  updatePolicy:
    updateMode: "Initial"
  # VPA patches resource requests on new pods when they are created
  # Existing pods are NOT modified
  # Safe for stateful workloads where in-place modification would be disruptive
```

### Recreate Mode (Evict and Recreate Pods)

```yaml
spec:
  updatePolicy:
    updateMode: "Recreate"
  # VPA applies recommendations by evicting pods
  # Pods restart with new resource requests
  # Respects PodDisruptionBudgets
```

### Auto Mode (Preferred)

```yaml
spec:
  updatePolicy:
    updateMode: "Auto"
  # In-place update if supported (Kubernetes 1.27+ with InPlaceVerticalScaling gate)
  # Otherwise falls back to eviction like Recreate
  # Respects PodDisruptionBudgets during eviction
```

## The Recommendation Algorithm

### How VPA Calculates Recommendations

The VPA recommender collects CPU and memory usage from the Metrics API (or Prometheus) and applies a statistical model:

**CPU Recommendations:**
- VPA uses a histogram of CPU usage samples
- Target = 90th percentile of CPU usage over the observation window
- Lower bound = 50th percentile
- Upper bound = estimated 99th percentile

**Memory Recommendations:**
- Memory is handled differently because it is not compressible
- VPA uses the maximum observed RSS over the window
- Includes a safety buffer to prevent OOM kills
- Target = max(observed_max, recent_max * safety_factor)

```bash
# The observation window defaults to 8 days
# Shorter windows respond faster but are noisier
# Configure in the recommender flags:
--recommender-interval=1m           # How often to compute recommendations
--memory-saver=false                # Keep full history in memory (requires more RAM)
--recommendation-lower-bound-cpu-percentile=0.5
--recommendation-target-cpu-percentile=0.9
--recommendation-upper-bound-cpu-percentile=0.95

# View the histogram data
kubectl get --raw /apis/autoscaling.k8s.io/v1/namespaces/production/verticalpodautoscalers/myapp-vpa | \
    jq '.status.recommendation'
```

### CPU vs. Memory Behavior

Understanding the difference is critical:

```
CPU (compressible):
  - When pod requests 100m but uses 400m, the container is throttled
  - It runs slower, not killed
  - VPA recommendation prevents throttling at P90

Memory (non-compressible):
  - When pod hits its memory limit, it is OOM killed
  - Memory requests affect node scheduling, not runtime limit
  - VPA recommendation prevents scheduling on nodes with insufficient memory
  - Memory limits are NOT automatically updated (by default)
```

### Resource Policy Configuration

```yaml
spec:
  resourcePolicy:
    containerPolicies:
    - containerName: "*"  # Apply to all containers
      minAllowed:
        cpu: 10m
        memory: 32Mi
      maxAllowed:
        cpu: "8"
        memory: 16Gi

      # Only recommend CPU, not memory
      controlledResources: ["cpu"]

      # Or control values independently
      controlledValues: RequestsAndLimits  # Update both requests and limits
      # controlledValues: RequestsOnly     # Update only requests, leave limits unchanged
```

## Admission Controller Behavior

The VPA Admission Controller is a mutating webhook that intercepts pod creation requests. When a pod is created that is covered by a VPA object in Auto or Initial mode, the admission controller patches the pod's resource requests before the pod is scheduled.

```bash
# See the webhook configuration
kubectl get mutatingwebhookconfiguration vpa-webhook-config -o yaml

# The webhook intercepts Pod creation in all namespaces
# (or specific namespaces based on configuration)

# Simulate what the admission controller would set for a pod spec
kubectl apply --dry-run=server -f pod.yaml
# This shows what values the webhook would inject
```

### Admission Controller Failure Policy

```yaml
# By default, VPA admission controller uses FailurePolicy: Ignore
# This means if the webhook fails, pods are created with their original resource values
# This is important: a broken VPA should not prevent pod creation

# Check the current policy
kubectl get mutatingwebhookconfiguration vpa-webhook-config \
    -o jsonpath='{.webhooks[0].failurePolicy}'
```

## LimitRange Interaction

LimitRange objects in a namespace interact with VPA in non-obvious ways:

```yaml
# LimitRange in the namespace
apiVersion: v1
kind: LimitRange
metadata:
  name: default-limits
  namespace: production
spec:
  limits:
  - type: Container
    default:          # Applied when no limit is specified
      cpu: 500m
      memory: 512Mi
    defaultRequest:   # Applied when no request is specified
      cpu: 100m
      memory: 128Mi
    max:              # Maximum allowed limit
      cpu: "4"
      memory: 4Gi
    min:              # Minimum allowed request
      cpu: 10m
      memory: 32Mi
```

### The Interaction Problem

```
VPA recommends:  cpu: 600m request, 1.2 cpu limit (2x ratio)
LimitRange max:  cpu: 4 (no issue with VPA recommendation)

BUT:
LimitRange maxLimitRequestRatio:
  If set to 2, then limit/request <= 2
  VPA recommends 600m request, 1.2 cpu limit → ratio = 2x ✓

Problem scenario:
  VPA recommends: memory: 1.5Gi request
  LimitRange max: memory: 1Gi
  → VPA recommendation is CAPPED at LimitRange max
  → Pod may still OOM if actual usage exceeds 1Gi
```

```bash
# Check if LimitRange is capping VPA recommendations
kubectl describe vpa myapp-vpa -n production | grep -A 5 "Uncapped Target"
# If UncappedTarget > Target, LimitRange or maxAllowed is capping the recommendation

# Uncapped Target: cpu: 600m, memory: 1.5Gi
# Target:         cpu: 600m, memory: 1Gi     ← capped by LimitRange
```

### Resolution

```yaml
# Option 1: Increase LimitRange max to accommodate VPA
spec:
  limits:
  - type: Container
    max:
      memory: 8Gi  # Increase max to allow VPA to recommend higher values

# Option 2: Set VPA maxAllowed to stay within LimitRange
spec:
  resourcePolicy:
    containerPolicies:
    - containerName: myapp
      maxAllowed:
        memory: 900Mi  # Keep within LimitRange max of 1Gi
```

## VPA with HPA: The Conflict

Running both HPA and VPA on the same deployment creates a conflict:
- HPA scales the number of pods based on CPU/memory utilization
- VPA scales pod resource requests based on per-pod usage
- Both react to the same signals and can fight each other

### The Problem

```
Scenario:
  Deployment: 3 pods, each requesting 100m CPU
  HPA: scale when avg CPU > 50% of request (50m)
  VPA: observes pods using 90m CPU each

  VPA recommends: 150m CPU request per pod
  After VPA update: 3 pods, each requesting 150m CPU
  HPA recalculates: 90m / 150m = 60% utilization
  HPA scales OUT: adds pods (despite actual load not changing!)
```

### Solution: Use VPA for Memory Only with HPA for CPU

```yaml
# VPA: only manage memory (not CPU)
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: myapp-vpa
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: myapp
  updatePolicy:
    updateMode: "Auto"
  resourcePolicy:
    containerPolicies:
    - containerName: myapp
      controlledResources: ["memory"]  # Only adjust memory
      minAllowed:
        memory: 128Mi
      maxAllowed:
        memory: 4Gi

---
# HPA: manage replica count based on CPU
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: myapp-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: myapp
  minReplicas: 2
  maxReplicas: 20
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  # Do NOT include memory in HPA metrics when VPA manages memory
```

### Multi-Dimensional Autoscaling (MDA)

For workloads that need both horizontal and vertical scaling:

```yaml
# Use VPA in Off mode to get recommendations, then apply manually or via automation
# This gives you control over when each type of scaling happens

# Or use Keda with custom metrics for HPA, and VPA with "Initial" mode only
# Initial mode: VPA sets good initial values at pod creation
# KEDA HPA: scales replicas based on queue depth, not CPU/memory
```

## Goldilocks: Right-Sizing Made Visible

Goldilocks from Fairwinds runs VPA in `Off` mode across all namespaces and provides a dashboard showing recommendations without automatically applying them.

```bash
# Install Goldilocks
helm repo add fairwinds-stable https://charts.fairwinds.com/stable
helm install goldilocks fairwinds-stable/goldilocks \
    --namespace goldilocks \
    --create-namespace

# Enable Goldilocks for a namespace
kubectl label namespace production goldilocks.fairwinds.com/enabled=true

# Goldilocks creates a VPA object for every Deployment/StatefulSet in the namespace
# Access the dashboard
kubectl port-forward -n goldilocks svc/goldilocks-dashboard 8080:80
# Open: http://localhost:8080
```

### Goldilocks Output Interpretation

Goldilocks shows three columns per container:
- **Guaranteed QoS**: requests == limits (highest priority scheduling, no QoS degradation)
- **Burstable QoS**: requests < limits (can burst when capacity is available)
- **Current**: what is currently set

```bash
# Get Goldilocks recommendations via CLI
kubectl get vpa -n production -o json | jq '
    .items[] |
    .metadata.name,
    (.status.recommendation.containerRecommendations[] |
        .containerName,
        "  target: " + .target.cpu + " / " + .target.memory,
        "  lower:  " + .lowerBound.cpu + " / " + .lowerBound.memory,
        "  upper:  " + .upperBound.cpu + " / " + .upperBound.memory
    )
'
```

## Production VPA Patterns

### Pattern 1: Start in Off Mode, Graduate to Initial

```yaml
# Phase 1: Observation (2 weeks)
updateMode: "Off"
# Review recommendations, validate they make sense

# Phase 2: Apply to new pods only
updateMode: "Initial"
# New deployments, rollouts, and pod restarts get recommended values
# No disruption to running pods

# Phase 3: Auto with PDB protection
updateMode: "Auto"
# VPA can evict pods to apply recommendations
# Protected by PodDisruptionBudget
```

### Pattern 2: PodDisruptionBudget for VPA Safety

```yaml
# PDB that prevents VPA from evicting too many pods at once
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: myapp-pdb
  namespace: production
spec:
  minAvailable: "75%"  # At least 75% of pods must be available
  selector:
    matchLabels:
      app: myapp
```

### Pattern 3: Conservative Bounds for Stateful Workloads

```yaml
# For databases and stateful workloads, set conservative bounds
# and use Initial mode to avoid disrupting running pods
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: postgres-vpa
spec:
  targetRef:
    apiVersion: apps/v1
    kind: StatefulSet
    name: postgres
  updatePolicy:
    updateMode: "Initial"  # Never evict database pods
  resourcePolicy:
    containerPolicies:
    - containerName: postgres
      minAllowed:
        cpu: 500m      # Never drop below this (db needs consistent baseline)
        memory: 1Gi
      maxAllowed:
        cpu: "8"
        memory: 32Gi
      controlledValues: RequestsOnly  # Do not modify limits
```

### Pattern 4: Namespace-Wide VPA with Goldilocks

```bash
# Use Goldilocks to identify the 10 most wasteful deployments
kubectl get vpa -n production -o json | \
    jq -r '
        .items[] |
        .metadata.name as $name |
        (.status.recommendation.containerRecommendations[]? |
            .target.cpu as $tcpu |
            .target.memory as $tmem |
            [$name, $tcpu, $tmem] | @tsv
        )
    ' | \
    sort -t$'\t' -k3 -rh | \
    head -10
```

## Monitoring VPA

### VPA Metrics

```yaml
# Prometheus scrape config for VPA recommender
- job_name: vpa-recommender
  kubernetes_sd_configs:
  - role: pod
    namespaces:
      names: [kube-system]
  relabel_configs:
  - source_labels: [__meta_kubernetes_pod_label_app]
    action: keep
    regex: vpa-recommender

# Key metrics:
# vpa_recommender_recommendation_latency_seconds
# vpa_updater_evictions_total
# vpa_admission_controller_admission_latency_seconds
```

### Alerting

```yaml
groups:
- name: vpa
  rules:
  - alert: VPARecommendationSigDiffFromActual
    expr: |
      (
        kube_verticalpodautoscaler_status_recommendation_containerrecommendations_target{resource="memory"}
        /
        kube_pod_container_resource_requests{resource="memory"}
      ) > 2
    for: 30m
    labels:
      severity: info
    annotations:
      summary: "VPA recommends {{ $value }}x more memory than currently requested"

  - alert: VPAAdmissionControllerDown
    expr: up{job="vpa-admission-controller"} == 0
    for: 5m
    labels:
      severity: critical
    annotations:
      summary: "VPA admission controller is down — pods will not receive recommendations"
```

## Troubleshooting VPA

```bash
# VPA not generating recommendations?
kubectl logs -n kube-system deployment/vpa-recommender | grep -i "error\|warn"

# Recommendations not being applied to pods?
kubectl logs -n kube-system deployment/vpa-updater | grep -i "evict\|error"

# Admission controller not mutating pods?
kubectl logs -n kube-system deployment/vpa-admission-controller

# Check if a pod was mutated by VPA on admission
kubectl get pod myapp-xxx -o jsonpath='{.metadata.annotations}' | jq
# Look for: "vpaObservedContainers", "vpaUpdates"

# Why is my VPA not evicting pods?
# Check PDB
kubectl get pdb -n production
# Check VPA conditions
kubectl describe vpa myapp-vpa -n production | grep -A 5 "Conditions"

# VPA recommendation seems too low?
# Check the observation window — needs at least 8h of data
kubectl describe vpa myapp-vpa -n production | grep "Last Update"
```

## Summary

VPA is most valuable in two scenarios: initial right-sizing when deploying a new service (use `Off` mode to get recommendations, then set good requests manually) and ongoing memory management for mature services (use `Auto` or `Initial` mode with `controlledResources: ["memory"]`).

The key operational rules:
1. Never use VPA in Auto mode with CPU resources on a deployment that also has an HPA based on CPU utilization
2. Always set `minAllowed` and `maxAllowed` bounds — unconstrained VPA recommendations can be surprising
3. Use `Initial` mode for stateful workloads — automatic eviction of database pods is dangerous
4. Combine with Goldilocks for visibility across all workloads before deciding which to put in Auto mode
5. Protect Auto-mode workloads with PodDisruptionBudgets to prevent VPA from disrupting availability
