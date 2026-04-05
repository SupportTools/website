---
title: "Kubernetes VPA Vertical Pod Autoscaler: Recommender, Updater, and Admission Controller Integration in Production"
date: 2032-04-06T00:00:00-05:00
draft: false
tags: ["Kubernetes", "VPA", "Autoscaling", "Resource Management", "VerticalPodAutoscaler", "Performance", "Cost Optimization"]
categories:
- Kubernetes
- Performance
- Cost Optimization
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Kubernetes Vertical Pod Autoscaler covering the Recommender, Updater, and Admission Controller components, production configuration patterns, HPA coexistence, and cost optimization strategies."
more_link: "yes"
url: "/kubernetes-vpa-vertical-pod-autoscaler-recommender-updater-admission-controller/"
---

The Vertical Pod Autoscaler (VPA) solves one of the most persistent operational problems in Kubernetes: right-sizing container resource requests and limits. Manual resource tuning is error-prone, labor-intensive, and quickly becomes outdated as application behavior changes. VPA automates this through a continuous feedback loop that observes actual resource consumption, computes evidence-based recommendations, and optionally applies them through pod restarts.

Understanding VPA's three-component architecture — the Recommender that analyzes metrics, the Updater that evicts pods to apply recommendations, and the Admission Controller that patches new pods with recommended resources — is essential for deploying it effectively without causing unnecessary disruption. This guide covers production-ready VPA configuration, coexistence with HPA, custom recommenders, and the operational patterns that separate stable VPA deployments from disruptive ones.

<!--more-->

## VPA Architecture Deep Dive

### Component Responsibilities

```
┌─────────────────────────────────────────────────────────────────┐
│                    VPA Architecture                              │
│                                                                  │
│  ┌──────────────────────────────────────────────────────┐       │
│  │              VPA Recommender                          │       │
│  │  - Queries metrics from Metrics Server / Prometheus   │       │
│  │  - Builds histogram of CPU/memory usage per container │       │
│  │  - Computes Lower Bound, Target, Upper Bound, Min     │       │
│  │  - Updates VPA.Status.Recommendation                  │       │
│  └────────────────────────┬─────────────────────────────┘       │
│                           │                                      │
│  ┌────────────────────────▼─────────────────────────────┐       │
│  │              VPA Updater                              │       │
│  │  - Watches VPA objects for OutOfDate pods             │       │
│  │  - Respects PodDisruptionBudgets                      │       │
│  │  - Evicts pods when resources diverge from target     │       │
│  │  - Honors min-replicas before evicting                │       │
│  └────────────────────────────────────────────────────── ┘       │
│                                                                  │
│  ┌──────────────────────────────────────────────────────┐       │
│  │          VPA Admission Controller (Webhook)           │       │
│  │  - Intercepts pod creation requests                   │       │
│  │  - Patches resource requests/limits from VPA target   │       │
│  │  - Operates even in "Off" updateMode (recommendations)│       │
│  └──────────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────────┘

Data flow:
  Metrics API → Recommender → VPA.Status → Updater → Evicts pods
                                         → Admission Controller → Patches new pods
```

### Installation

```bash
# Clone the VPA repository
git clone https://github.com/kubernetes/autoscaler.git
cd autoscaler/vertical-pod-autoscaler

# Install VPA components
./hack/vpa-up.sh

# Or install via Helm
helm repo add fairwinds-stable https://charts.fairwinds.com/stable
helm install vpa fairwinds-stable/vpa \
  --namespace vpa-system \
  --create-namespace \
  --values vpa-values.yaml

# Verify all components are running
kubectl get pods -n kube-system | grep vpa
# vpa-admission-controller-6d8f9b7c5-x2mno   1/1   Running   0   5m
# vpa-recommender-5f8c9d7b4-p3qrs             1/1   Running   0   5m
# vpa-updater-7b9c8d5f6-vw4xy                 1/1   Running   0   5m
```

```yaml
# vpa-values.yaml — production Helm values
---
recommender:
  replicaCount: 2  # HA recommender
  resources:
    requests:
      cpu: 50m
      memory: 500Mi
    limits:
      cpu: 200m
      memory: 1000Mi
  extraArgs:
    # Increase history window for better recommendations
    - "--history-length=336h"  # 2 weeks
    # Confidence threshold for recommendation changes
    - "--recommendation-margin-fraction=0.15"
    # Memory aggregation settings
    - "--memory-histogram-decay-half-life=24h"
    # CPU aggregation settings
    - "--cpu-histogram-decay-half-life=24h"
    # Min samples for recommendation
    - "--min-samples-for-recommendation=100"

updater:
  replicaCount: 1
  resources:
    requests:
      cpu: 50m
      memory: 256Mi
  extraArgs:
    # How often to run updates
    - "--min-replicas=2"
    # Eviction tolerance
    - "--eviction-tolerance=0.5"
    # Rate limiting evictions
    - "--updater-interval=1m"

admissionController:
  replicaCount: 2  # HA for admission
  resources:
    requests:
      cpu: 50m
      memory: 200Mi
  certGen:
    # Manage TLS certificates for webhook
    image:
      tag: "latest"
```

## VPA Configuration Modes

VPA supports four update modes, each with different automation levels:

### Off Mode: Recommendations Only

```yaml
# vpa/my-app-vpa-off.yaml — recommendations without automatic updates
---
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: my-app-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: "apps/v1"
    kind: Deployment
    name: my-app

  updatePolicy:
    # Off: compute recommendations but never apply them
    # Best for initial analysis and compliance-sensitive workloads
    updateMode: "Off"

  resourcePolicy:
    containerPolicies:
    - containerName: "my-app"
      # Set bounds to prevent extreme recommendations
      minAllowed:
        cpu: 100m
        memory: 128Mi
      maxAllowed:
        cpu: "4"
        memory: 8Gi
      controlledResources: ["cpu", "memory"]
      controlledValues: RequestsAndLimits
```

```bash
# View recommendations after a few hours
kubectl describe vpa my-app-vpa -n production

# Or query the status directly
kubectl get vpa my-app-vpa -n production -o jsonpath='{.status}' | jq .

# Example output:
# {
#   "recommendation": {
#     "containerRecommendations": [{
#       "containerName": "my-app",
#       "lowerBound": {"cpu": "100m", "memory": "256Mi"},
#       "target": {"cpu": "300m", "memory": "512Mi"},
#       "uncappedTarget": {"cpu": "280m", "memory": "490Mi"},
#       "upperBound": {"cpu": "800m", "memory": "1Gi"}
#     }]
#   }
# }
```

### Initial Mode: First Deployment Only

```yaml
# vpa/my-app-vpa-initial.yaml — apply on pod creation only
---
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: my-app-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: "apps/v1"
    kind: Deployment
    name: my-app

  updatePolicy:
    # Initial: apply at pod creation time (from Admission Controller)
    # Never evict running pods
    # Good balance: right-size new pods without disruption
    updateMode: "Initial"

  resourcePolicy:
    containerPolicies:
    - containerName: "my-app"
      minAllowed:
        cpu: 50m
        memory: 64Mi
      maxAllowed:
        cpu: "2"
        memory: 4Gi
      controlledValues: RequestsOnly  # Only set requests, leave limits alone
```

### Auto Mode: Full Automation

```yaml
# vpa/my-app-vpa-auto.yaml — full automatic right-sizing
---
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: my-app-vpa
  namespace: production
  annotations:
    # Document why this is in Auto mode
    team: "platform"
    reason: "stateless service with readiness probes, safe to restart"
spec:
  targetRef:
    apiVersion: "apps/v1"
    kind: Deployment
    name: my-app

  updatePolicy:
    updateMode: "Auto"
    # Minimum replicas required before Updater will evict any pod
    minReplicas: 2

  resourcePolicy:
    containerPolicies:
    - containerName: "my-app"
      minAllowed:
        cpu: 100m
        memory: 128Mi
      maxAllowed:
        cpu: "4"
        memory: 8Gi
      controlledValues: RequestsAndLimits

    # Sidecar containers can have separate policies
    - containerName: "istio-proxy"
      mode: "Off"  # Don't touch Istio sidecar resources
      controlledResources: []
```

### Recreate Mode

```yaml
# vpa/my-app-vpa-recreate.yaml — evict but don't patch admission
---
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: my-app-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: "apps/v1"
    kind: Deployment
    name: my-app

  updatePolicy:
    # Recreate: evict out-of-date pods but don't modify at creation time
    # Rarely useful in practice - usually prefer Initial or Auto
    updateMode: "Recreate"
```

## Production VPA Patterns

### Stateful Workloads: Safe VPA Configuration

Stateful applications like databases require extra care. VPA with `updateMode: Auto` can cause unexpected restarts.

```yaml
# vpa/postgres-vpa.yaml — safe VPA for stateful workloads
---
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: postgres-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: "apps/v1"
    kind: StatefulSet
    name: postgres

  updatePolicy:
    # Initial: only apply when pod is created (maintenance windows)
    updateMode: "Initial"

  resourcePolicy:
    containerPolicies:
    - containerName: "postgres"
      minAllowed:
        cpu: 500m
        memory: 1Gi
      maxAllowed:
        cpu: "16"
        memory: 64Gi
      # For databases: only control requests, not limits
      # Let the DB use available memory for caching
      controlledValues: RequestsOnly
      controlledResources: ["cpu", "memory"]
```

```bash
# For databases: manually apply VPA recommendations during maintenance
# Step 1: Get current recommendation
RECOMMENDATION=$(kubectl get vpa postgres-vpa -n production \
  -o jsonpath='{.status.recommendation.containerRecommendations[0].target}')
echo "Recommendation: $RECOMMENDATION"

# Step 2: Update the StatefulSet during maintenance window
CPU_TARGET=$(echo $RECOMMENDATION | jq -r '.cpu')
MEM_TARGET=$(echo $RECOMMENDATION | jq -r '.memory')

kubectl patch statefulset postgres -n production --type=json \
  -p="[
    {\"op\": \"replace\", \"path\": \"/spec/template/spec/containers/0/resources/requests/cpu\", \"value\": \"$CPU_TARGET\"},
    {\"op\": \"replace\", \"path\": \"/spec/template/spec/containers/0/resources/requests/memory\", \"value\": \"$MEM_TARGET\"}
  ]"
```

### Multi-Container Pod Policies

```yaml
# vpa/multi-container-vpa.yaml
---
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: multi-container-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: "apps/v1"
    kind: Deployment
    name: web-app-with-sidecars

  updatePolicy:
    updateMode: "Auto"
    minReplicas: 3

  resourcePolicy:
    containerPolicies:

    # Main application container
    - containerName: "web-app"
      minAllowed:
        cpu: 100m
        memory: 128Mi
      maxAllowed:
        cpu: "4"
        memory: 4Gi
      controlledValues: RequestsAndLimits

    # Logging sidecar - keep fixed resources
    - containerName: "fluentbit"
      mode: "Off"
      # Manually set optimal values for the sidecar
      # VPA will not modify these

    # Init containers can also be excluded
    - containerName: "init-migrations"
      mode: "Off"

    # Envoy/Istio proxy - exclude from VPA
    - containerName: "istio-proxy"
      mode: "Off"
```

### Namespace-Wide VPA Defaults

```yaml
# vpa/namespace-vpa-defaults.yaml — apply VPA to all unlabeled workloads
---
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: default-namespace-vpa
  namespace: production
  annotations:
    # This is a namespace-wide recommendation VPA
    scope: "namespace-default"
spec:
  # Target all deployments without explicit VPA
  # This is not directly supported - use a controller to create per-workload VPAs
  # See the automation section below
  targetRef:
    apiVersion: "apps/v1"
    kind: Deployment
    name: placeholder-do-not-use-directly
  updatePolicy:
    updateMode: "Off"
```

### Automated VPA Creation Operator

```go
// pkg/vpa-operator/controller.go — auto-create VPAs for new deployments
package controller

import (
    "context"
    "fmt"

    appsv1 "k8s.io/api/apps/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    vpav1 "k8s.io/autoscaler/vertical-pod-autoscaler/pkg/apis/autoscaling.k8s.io/v1"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/log"
)

// VPAAutoCreatorReconciler watches Deployments and creates VPAs
type VPAAutoCreatorReconciler struct {
    client.Client
    DefaultUpdateMode vpav1.UpdateMode
}

func (r *VPAAutoCreatorReconciler) Reconcile(
    ctx context.Context, req ctrl.Request) (ctrl.Result, error) {

    logger := log.FromContext(ctx)

    // Get the deployment
    deployment := &appsv1.Deployment{}
    if err := r.Get(ctx, req.NamespacedName, deployment); err != nil {
        return ctrl.Result{}, client.IgnoreNotFound(err)
    }

    // Skip if opted out
    if _, skip := deployment.Annotations["vpa.kubernetes.io/skip"]; skip {
        return ctrl.Result{}, nil
    }

    // Skip if HPA is managing this deployment (usually don't want both)
    if _, hasHPA := deployment.Annotations["hpa.managed"]; hasHPA {
        logger.Info("Skipping VPA creation for HPA-managed deployment",
            "deployment", req.Name)
        return ctrl.Result{}, nil
    }

    // Check if VPA already exists
    existingVPA := &vpav1.VerticalPodAutoscaler{}
    err := r.Get(ctx, req.NamespacedName, existingVPA)
    if err == nil {
        return ctrl.Result{}, nil // VPA exists, nothing to do
    }

    // Create VPA for this deployment
    updateMode := r.DefaultUpdateMode
    // Allow per-deployment override via annotation
    if mode, ok := deployment.Annotations["vpa.kubernetes.io/update-mode"]; ok {
        um := vpav1.UpdateMode(mode)
        updateMode = um
    }

    minReplicas := int32(2)
    vpa := &vpav1.VerticalPodAutoscaler{
        ObjectMeta: metav1.ObjectMeta{
            Name:      deployment.Name,
            Namespace: deployment.Namespace,
            Labels: map[string]string{
                "app.kubernetes.io/managed-by": "vpa-auto-creator",
            },
            OwnerReferences: []metav1.OwnerReference{
                *metav1.NewControllerRef(deployment, appsv1.SchemeGroupVersion.WithKind("Deployment")),
            },
        },
        Spec: vpav1.VerticalPodAutoscalerSpec{
            TargetRef: &autoscalingv1.CrossVersionObjectReference{
                APIVersion: "apps/v1",
                Kind:       "Deployment",
                Name:       deployment.Name,
            },
            UpdatePolicy: &vpav1.PodUpdatePolicy{
                UpdateMode:  &updateMode,
                MinReplicas: &minReplicas,
            },
        },
    }

    if err := r.Create(ctx, vpa); err != nil {
        return ctrl.Result{}, fmt.Errorf("creating VPA: %w", err)
    }

    logger.Info("Created VPA for deployment",
        "deployment", deployment.Name,
        "namespace", deployment.Namespace,
        "updateMode", updateMode,
    )

    return ctrl.Result{}, nil
}
```

## VPA and HPA Coexistence

VPA and HPA can conflict when both try to manage the same resource dimension. The safe pattern is to use HPA for CPU-based horizontal scaling and VPA for memory right-sizing.

### Recommended Coexistence Pattern

```yaml
# HPA: handle CPU scaling horizontally
---
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
  minReplicas: 3
  maxReplicas: 20
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  # Do NOT include memory in HPA when VPA manages memory

---
# VPA: handle memory right-sizing only
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: my-app-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: "apps/v1"
    kind: Deployment
    name: my-app

  updatePolicy:
    updateMode: "Initial"
    minReplicas: 3

  resourcePolicy:
    containerPolicies:
    - containerName: "my-app"
      # Only control memory — let HPA handle CPU
      controlledResources: ["memory"]
      controlledValues: RequestsOnly
      minAllowed:
        memory: 128Mi
      maxAllowed:
        memory: 4Gi
```

```bash
# Verify there's no conflict
# HPA should not be scaling based on memory
kubectl describe hpa my-app-hpa -n production | grep -A5 "Metrics:"

# VPA should only show memory recommendations
kubectl get vpa my-app-vpa -n production \
  -o jsonpath='{.status.recommendation}' | jq .
```

### KEDA and VPA Integration

```yaml
# When using KEDA (Kubernetes Event-Driven Autoscaler) with VPA
---
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: my-app-scaledobject
  namespace: production
spec:
  scaleTargetRef:
    name: my-app
  minReplicaCount: 2
  maxReplicaCount: 50
  triggers:
  - type: prometheus
    metadata:
      serverAddress: http://prometheus:9090
      metricName: http_requests_per_second
      threshold: "100"
      query: rate(http_requests_total[2m])

---
# VPA with KEDA: same pattern, only control memory
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: my-app-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: "apps/v1"
    kind: Deployment
    name: my-app
  updatePolicy:
    updateMode: "Initial"
    minReplicas: 2
  resourcePolicy:
    containerPolicies:
    - containerName: "my-app"
      controlledResources: ["memory"]
      controlledValues: RequestsOnly
      minAllowed:
        memory: 256Mi
      maxAllowed:
        memory: 8Gi
```

## Recommendation Analysis and Tuning

### Understanding Recommendation Components

```bash
# VPA computes four values for each resource:
# - lowerBound: estimated minimum required (90th percentile safety margin below)
# - target: recommended value (customizable confidence percentile)
# - uncappedTarget: target before applying min/maxAllowed bounds
# - upperBound: estimated maximum needed (safety margin above)

# Check current recommendation for all VPAs in a namespace
kubectl get vpa -n production -o json | jq -r '
.items[] |
"\(.metadata.name): " +
((.status.recommendation.containerRecommendations // []) |
  map("\(.containerName): cpu=\(.target.cpu) mem=\(.target.memory)") |
  join(", "))'
```

### Custom Recommender Configuration

```yaml
# Deploy a custom recommender with different aggregation parameters
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vpa-recommender-aggressive
  namespace: kube-system
spec:
  replicas: 1
  selector:
    matchLabels:
      app: vpa-recommender-aggressive
  template:
    metadata:
      labels:
        app: vpa-recommender-aggressive
    spec:
      serviceAccountName: vpa-recommender
      containers:
      - name: recommender
        image: registry.k8s.io/autoscaling/vpa-recommender:1.0.0
        args:
        # Shorter history for faster adaptation
        - "--history-length=24h"
        # More aggressive: use 90th percentile instead of 95th
        - "--target-cpu-percentile=0.9"
        # Smaller safety margin
        - "--recommendation-margin-fraction=0.05"
        # Faster decay for CPU (adapt to load changes quickly)
        - "--cpu-histogram-decay-half-life=12h"
        # Slower decay for memory (memory leaks need longer observation)
        - "--memory-histogram-decay-half-life=48h"
        # Minimum observation period before making recommendations
        - "--pod-recommendation-min-cpu-millicores=5"
        - "--pod-recommendation-min-memory-mb=100"
        resources:
          requests:
            cpu: 50m
            memory: 500Mi
          limits:
            cpu: 200m
            memory: 1Gi
```

```yaml
# Use per-VPA custom recommender reference
---
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: my-app-vpa-custom-recommender
  namespace: production
spec:
  targetRef:
    apiVersion: "apps/v1"
    kind: Deployment
    name: my-app
  recommenders:
    - name: vpa-recommender-aggressive  # Use custom recommender
  updatePolicy:
    updateMode: "Auto"
```

### Recommendation Export and Visualization

```bash
#!/bin/bash
# export-vpa-recommendations.sh — export recommendations to CSV for analysis

echo "namespace,workload,container,cpu_request_current,cpu_target,cpu_lower,cpu_upper,mem_request_current,mem_target,mem_lower,mem_upper"

for VPA in $(kubectl get vpa --all-namespaces -o json | jq -r '.items[] | "\(.metadata.namespace)/\(.metadata.name)"'); do
    NS=$(echo $VPA | cut -d/ -f1)
    NAME=$(echo $VPA | cut -d/ -f2)

    kubectl get vpa "$NAME" -n "$NS" -o json | jq -r --arg ns "$NS" --arg name "$NAME" '
    .status.recommendation.containerRecommendations[]? |
    [$ns, $name, .containerName,
     .target.cpu, .target.memory,
     .lowerBound.cpu, .lowerBound.memory,
     .upperBound.cpu, .upperBound.memory] |
    @csv'
done
```

## PodDisruptionBudget Integration

VPA Updater respects PodDisruptionBudgets before evicting pods. Proper PDB configuration prevents VPA from disrupting service availability.

```yaml
# pdb/my-app-pdb.yaml — protect against VPA-caused outages
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: my-app-pdb
  namespace: production
spec:
  # At least 2 pods must be available during updates
  minAvailable: 2
  # Or: maximum 1 pod unavailable at a time
  # maxUnavailable: 1
  selector:
    matchLabels:
      app: my-app
```

```bash
# Verify VPA respects the PDB
# If PDB prevents eviction, the Updater will skip and retry later
kubectl describe poddisruptionbudget my-app-pdb -n production

# Check Updater logs for PDB-blocked evictions
kubectl logs -n kube-system deployment/vpa-updater | grep -i "pdb\|budget\|evict"
```

## Monitoring VPA Health

### Prometheus Metrics

```yaml
# monitoring/vpa-servicemonitor.yaml
---
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: vpa-components
  namespace: monitoring
spec:
  namespaceSelector:
    matchNames:
      - kube-system
  selector:
    matchLabels:
      app: vpa-recommender
  endpoints:
    - port: metrics
      interval: 30s
      path: /metrics
```

```yaml
# monitoring/vpa-alerts.yaml — alerting rules for VPA health
---
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
      expr: |
        absent(up{job="vpa-recommender"} == 1)
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "VPA Recommender is not running"
        description: "VPA recommendations will become stale without the recommender"

    - alert: VPARecommendationSignificantChange
      expr: |
        abs(
          vpa_recommender_target_cpu_millicores
          - vpa_recommender_current_cpu_millicores
        ) / vpa_recommender_current_cpu_millicores > 0.5
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "VPA recommendation changed significantly"
        description: "VPA recommends >50% change in CPU for {{ $labels.namespace }}/{{ $labels.target_name }}"

    - alert: VPAUpdaterFrequentEvictions
      expr: |
        rate(vpa_updater_evictions_total[1h]) > 0.1
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "VPA Updater is evicting pods frequently"
        description: "More than 6 pod evictions per hour in {{ $labels.namespace }}"

    - alert: VPAAdmissionControllerDown
      expr: |
        absent(up{job="vpa-admission-controller"} == 1)
      for: 2m
      labels:
        severity: critical
      annotations:
        summary: "VPA Admission Controller is down"
        description: "New pods will not receive VPA resource recommendations"
```

### Grafana Dashboard Queries

```
# Key Grafana queries for VPA monitoring:

# Pods with VPA recommendations vs actual resource usage
avg(
  (container_memory_working_set_bytes{container!=""})
  /
  (kube_pod_container_resource_requests{resource="memory", container!=""})
) by (namespace, pod) > 1.5

# VPA target recommendation over time
vpa_recommender_target_memory_bytes{namespace="production"}

# Number of VPA-managed workloads
count(kube_verticalpodautoscaler_spec_updatepolicy_updatemode) by (namespace, update_mode)

# Updater eviction rate
rate(vpa_updater_evictions_total[5m])
```

## Cost Optimization with VPA

### Identifying Over-Provisioned Workloads

```bash
#!/bin/bash
# identify-overprovisioned.sh — find workloads wasting resources

echo "Looking for pods with VPA target significantly below current requests..."
echo ""

kubectl get vpa --all-namespaces -o json | python3 -c "
import json, sys

data = json.load(sys.stdin)
overprovisioned = []

for vpa in data['items']:
    ns = vpa['metadata']['namespace']
    name = vpa['metadata']['name']

    recs = vpa.get('status', {}).get('recommendation', {}).get('containerRecommendations', [])
    for rec in recs:
        container = rec['containerName']
        target = rec.get('target', {})

        cpu_target = target.get('cpu', '0')
        mem_target = target.get('memory', '0')

        overprovisioned.append({
            'ns': ns,
            'name': name,
            'container': container,
            'cpu_target': cpu_target,
            'mem_target': mem_target,
        })

for item in overprovisioned:
    print(f\"{item['ns']}/{item['name']}/{item['container']}: cpu={item['cpu_target']} mem={item['mem_target']}\")
"
```

### Cluster-Wide Resource Waste Report

```bash
#!/bin/bash
# vpa-savings-report.sh — calculate potential cost savings from VPA adoption

# Get all VPA recommendations
kubectl get vpa --all-namespaces -o json | jq -r '
.items[] |
.metadata.namespace as $ns |
.metadata.name as $name |
.status.recommendation.containerRecommendations[]? |
{
  ns: $ns,
  workload: $name,
  container: .containerName,
  cpu_target_m: (.target.cpu | rtrimstr("m") | tonumber? // 0),
  mem_target_mi: (.target.memory | rtrimstr("Mi") | tonumber? // 0)
} |
"\(.ns),\(.workload),\(.container),\(.cpu_target_m),\(.mem_target_mi)"' | \
while IFS=, read ns workload container cpu_m mem_mi; do
    # Get current resource requests for comparison
    CURRENT=$(kubectl get deployment "$workload" -n "$ns" \
        -o jsonpath="{.spec.template.spec.containers[?(@.name==\"$container\")].resources.requests}" \
        2>/dev/null)
    echo "$ns,$workload,$container,$cpu_m,$mem_mi,$CURRENT"
done
```

## Troubleshooting VPA

### Common Issues

```bash
# Issue 1: VPA not generating recommendations
# Check if metrics are available
kubectl top pods -n production
# If this fails, metrics-server is not running

# Check Recommender logs
kubectl logs -n kube-system -l app=vpa-recommender --tail=100 | \
  grep -E "ERROR|WARN|recommendation"

# Issue 2: Admission Controller not applying recommendations
# Check webhook configuration
kubectl get mutatingwebhookconfiguration vpa-webhook-config -o yaml | \
  grep -A5 "failurePolicy"

# If failurePolicy: Fail and webhook is down, ALL pod creates will fail!
# Set to Ignore for non-critical clusters

# Issue 3: Updater not evicting pods
# Check if PDB is blocking
kubectl get pdb -n production

# Check Updater's assessment
kubectl logs -n kube-system -l app=vpa-updater --tail=50 | \
  grep -E "evict|budget|replicas"

# Issue 4: VPA recommendation is too high/low
# Look at the histogram data
kubectl describe vpa my-app-vpa -n production | grep -A20 "Status:"
```

### Admission Controller Failover

```yaml
# CRITICAL: VPA Admission Controller webhook configuration
# If the webhook is unavailable and failurePolicy is Fail,
# pod creation across the cluster will fail!
---
apiVersion: admissionregistration.k8s.io/v1
kind: MutatingWebhookConfiguration
metadata:
  name: vpa-webhook-config
webhooks:
- name: vpa.k8s.io
  failurePolicy: Ignore  # Use Ignore in production to prevent cascade failures
  # Only target pods in namespaces with VPA objects
  namespaceSelector:
    matchLabels:
      vpa.kubernetes.io/enabled: "true"
  rules:
  - operations: ["CREATE"]
    apiGroups: [""]
    apiVersions: ["v1"]
    resources: ["pods"]
  sideEffects: None
  admissionReviewVersions: ["v1"]
```

## Conclusion

VPA is most valuable as part of a comprehensive resource management strategy. The `Off` mode provides a zero-risk starting point that surfaces actionable recommendations for all workloads. Teams can progressively migrate to `Initial` mode as they validate recommendations, and eventually `Auto` mode for stateless services with proper PDBs and health checks.

The HPA and VPA coexistence pattern — horizontal scaling for CPU via HPA, vertical memory right-sizing via VPA — captures the benefits of both systems without the conflicts that arise when both tools manage the same resource dimension.

The cost optimization case for VPA is compelling: enterprise clusters routinely run with 3x to 5x over-provisioning in resource requests, blocking scheduling of additional workloads and inflating infrastructure costs. VPA's evidence-based recommendations reduce this waste systematically and continuously, adapting as application behavior evolves.
