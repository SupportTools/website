---
title: "Kubernetes Vertical Pod Autoscaler: Right-Sizing Workloads for Production Efficiency"
date: 2030-09-02T00:00:00-05:00
draft: false
tags: ["Kubernetes", "VPA", "Autoscaling", "Resource Management", "GitOps", "Production"]
categories:
- Kubernetes
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise VPA guide covering Recommender, Updater, and Admission Controller components, update modes, VPA and HPA coexistence, resource recommendation analysis, and integrating VPA into GitOps resource management workflows."
more_link: "yes"
url: "/kubernetes-vertical-pod-autoscaler-production-efficiency-guide/"
---

Resource requests and limits in Kubernetes are one of the most consequential — and most poorly configured — aspects of production cluster management. Over-provisioned workloads waste infrastructure budget. Under-provisioned workloads cause OOMKills, CPU throttling, and latency spikes. The Vertical Pod Autoscaler (VPA) closes the gap by observing actual resource consumption and continuously recommending — or automatically applying — right-sized requests and limits. This guide covers every production-relevant detail of VPA: its three-component architecture, all four update modes, safe coexistence with HPA, actionable recommendation analysis, and end-to-end integration with GitOps workflows.

<!--more-->

## VPA Architecture and Component Responsibilities

VPA is not a monolithic controller. It is composed of three independently deployable components, each with a distinct responsibility. Understanding the separation is essential for operating VPA safely in production.

### Recommender

The Recommender is the brain of VPA. It continuously queries the Metrics API (typically backed by metrics-server) and historical usage data stored in the VPA's own VerticalPodAutoscalerCheckpoint custom resources. From this data it computes CPU and memory recommendations using a histogram-based model with configurable percentile targets.

The Recommender exposes its current conclusions through the `.status.recommendation` field of each VPA object. It does not make any changes to Pods or Deployments — it only writes recommendations.

Key behaviors to understand:

- Recommendations are updated approximately every minute.
- The histogram decay factor (`--recommendation-margin-fraction`, default 0.15) adds a safety buffer above the measured percentile.
- Cold-start behavior: for new workloads with fewer than 8 days of history, recommendations are based only on available data and may be volatile.
- CPU recommendations use a percentile (default p95 of observed usage). Memory recommendations target peak usage plus OOMKill protection margin.

### Updater

The Updater is responsible for evicting Pods whose current resource requests fall outside the recommended range. It runs on a configurable interval (default every minute) and checks whether each Pod managed by a VPA object needs to be replaced with updated requests.

The Updater evicts Pods so that when they are recreated by the workload controller (Deployment, StatefulSet, etc.), the Admission Controller can inject updated requests into the new Pod spec.

Important production implications:

- Eviction respects PodDisruptionBudgets. If a PDB prevents eviction, the Updater skips the Pod.
- The Updater will not evict the last running Pod in a single-replica Deployment unless explicitly configured.
- Evictions are rate-limited to avoid cascading disruptions.

### Admission Controller

The Admission Controller is a mutating webhook that intercepts Pod creation requests. When a new Pod is about to be scheduled and a matching VPA object exists in `Auto` or `Initial` mode, the Admission Controller mutates the Pod spec to inject the recommended resource requests and limits before the Pod reaches the scheduler.

The Admission Controller runs as a critical path component — Pod creation blocks until it responds. High availability configuration is mandatory in production.

## Installing VPA

```bash
git clone https://github.com/kubernetes/autoscaler.git
cd autoscaler/vertical-pod-autoscaler

# Install CRDs and components
./hack/vpa-up.sh
```

For Helm-based installations (preferred for GitOps):

```yaml
# values-vpa.yaml
admissionController:
  replicaCount: 2
  podDisruptionBudget:
    minAvailable: 1
  resources:
    requests:
      cpu: 50m
      memory: 200Mi
    limits:
      memory: 500Mi

recommender:
  replicaCount: 1
  extraArgs:
    recommendation-margin-fraction: "0.15"
    pod-recommendation-min-cpu-millicores: "25"
    pod-recommendation-min-memory-mb: "250"
    history-length: "336h"  # 14 days
  resources:
    requests:
      cpu: 50m
      memory: 500Mi
    limits:
      memory: 1Gi

updater:
  replicaCount: 1
  extraArgs:
    eviction-tolerance: "0.5"
    min-replicas: "2"
  resources:
    requests:
      cpu: 50m
      memory: 200Mi
    limits:
      memory: 500Mi
```

```bash
helm repo add fairwinds-stable https://charts.fairwinds.com/stable
helm upgrade --install vpa fairwinds-stable/vpa \
  --namespace kube-system \
  --values values-vpa.yaml
```

## VPA Update Modes

VPA supports four update modes that control how recommendations are applied. Choosing the correct mode for each workload type is critical to balancing optimization and stability.

### Off Mode — Recommendations Only

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
    updateMode: "Off"
  resourcePolicy:
    containerPolicies:
    - containerName: api
      minAllowed:
        cpu: 100m
        memory: 128Mi
      maxAllowed:
        cpu: 4000m
        memory: 4Gi
      controlledResources: ["cpu", "memory"]
```

`Off` mode is the safest starting point. The Recommender generates recommendations and writes them to `.status.recommendation`, but neither the Updater nor Admission Controller takes any action. Use this mode to:

- Audit current resource requests against actual usage across all namespaces.
- Build confidence in VPA's recommendations before enabling automated changes.
- Collect recommendations in read-only fashion for GitOps-driven resource updates.

### Initial Mode — Apply at Pod Creation Only

```yaml
updatePolicy:
  updateMode: "Initial"
```

In `Initial` mode, the Admission Controller injects recommended requests when Pods are first created, but the Updater never evicts running Pods to trigger re-sizing. Resources are set correctly at start time and remain frozen until the Pod is naturally recreated (during a Deployment rollout, for example).

This mode is appropriate for:

- Stateful workloads where mid-life eviction is disruptive.
- Workloads with long startup times where eviction is expensive.
- Environments where operators want to control when re-sizing occurs.

### Recreate Mode — Evict When Out of Range

```yaml
updatePolicy:
  updateMode: "Recreate"
```

`Recreate` mode enables both the Admission Controller (applies at creation) and the Updater (evicts out-of-range Pods). The Updater evicts Pods when their current requests deviate significantly from the recommendation. The evicted Pod is recreated with updated requests via the Admission Controller.

Use `Recreate` for stateless workloads that tolerate Pod restarts, where the cost of running with incorrect resource sizing exceeds the cost of an occasional restart.

### Auto Mode — Recommended for Most Workloads

```yaml
updatePolicy:
  updateMode: "Auto"
```

`Auto` mode is currently equivalent to `Recreate` in the upstream implementation, but the API specification reserves the right to use in-place Pod vertical scaling (KEP-1287) when it reaches GA. When in-place resource updates become available, `Auto` mode will apply them without Pod restarts where possible.

## Complete Production VPA Configuration

The following example shows a fully configured VPA for a production API service with resource bounds, container-specific policies, and eviction requirements:

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: checkout-api-vpa
  namespace: production
  labels:
    app: checkout-api
    team: platform
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: checkout-api
  updatePolicy:
    updateMode: "Auto"
    minReplicas: 2
  resourcePolicy:
    containerPolicies:
    - containerName: checkout-api
      mode: Auto
      minAllowed:
        cpu: 100m
        memory: 256Mi
      maxAllowed:
        cpu: 2000m
        memory: 2Gi
      controlledResources:
      - cpu
      - memory
    - containerName: envoy-sidecar
      mode: "Off"
      controlledResources: []
```

Key configuration points:

- `minReplicas: 2` prevents the Updater from evicting Pods when only one replica is available.
- `maxAllowed` caps recommendations to prevent runaway resource growth from anomalous load spikes.
- The `envoy-sidecar` container is excluded from VPA management (`mode: "Off"`) because its resource requirements are managed by the service mesh operator.

## Reading and Acting on VPA Status

After VPA has collected sufficient history (typically 24 hours minimum for meaningful recommendations), inspect the status:

```bash
kubectl describe vpa checkout-api-vpa -n production
```

```yaml
Status:
  Conditions:
  - lastTransitionTime: "2030-08-29T14:30:00Z"
    status: "True"
    type: RecommendationProvided
  Recommendation:
    ContainerRecommendations:
    - ContainerName: checkout-api
      LowerBound:
        cpu: 200m
        memory: 512Mi
      Target:
        cpu: 450m
        memory: 768Mi
      UncappedTarget:
        cpu: 450m
        memory: 768Mi
      UpperBound:
        cpu: 900m
        memory: 1200Mi
```

**Interpreting the recommendation fields:**

| Field | Meaning | Action |
|---|---|---|
| `LowerBound` | Safe minimum — Pod is unlikely to be OOMKilled or CPU-throttled | Floor for resource requests |
| `Target` | Recommended request value (p95 CPU, peak memory + buffer) | Set as resource request |
| `UncappedTarget` | Target without applying `maxAllowed` ceiling | Detect when ceiling is too low |
| `UpperBound` | Safe maximum — above this is wasteful | Ceiling for resource limits |

When `UncappedTarget` exceeds `Target`, it means the `maxAllowed` ceiling is artificially constraining the recommendation. Review whether the ceiling needs to be raised.

### Scripted Recommendation Audit

```bash
#!/bin/bash
# vpa-audit.sh — print all VPA recommendations across namespaces

kubectl get vpa --all-namespaces -o json | jq -r '
  .items[] |
  .metadata.namespace as $ns |
  .metadata.name as $name |
  .status.recommendation.containerRecommendations[]? |
  [$ns, $name, .containerName,
   (.target.cpu // "N/A"),
   (.target.memory // "N/A")] |
  @tsv
' | column -t -s $'\t' | sort
```

## VPA and HPA Coexistence

VPA and HPA cannot both control CPU-based scaling simultaneously on the same workload — this creates a conflict where VPA changes resource requests (affecting HPA's utilization percentage calculation) while HPA changes replica count, leading to oscillation.

### Safe Coexistence Patterns

**Pattern 1: VPA on CPU+Memory, HPA disabled**

Use VPA in `Auto` mode to right-size each Pod, and rely on a fixed replica count or manual scaling. Appropriate for workloads with stable, predictable traffic.

**Pattern 2: HPA on CPU, VPA on Memory only**

```yaml
# HPA controls CPU-based scaling
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
# VPA controls Memory only
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
    minReplicas: 3
  resourcePolicy:
    containerPolicies:
    - containerName: api
      controlledResources:
      - memory
      minAllowed:
        memory: 256Mi
      maxAllowed:
        memory: 4Gi
```

**Pattern 3: HPA with custom metrics, VPA on both**

When HPA uses custom metrics (RPS, queue depth, etc.) rather than CPU utilization, VPA can safely manage both CPU and memory without mathematical conflict:

```yaml
# HPA uses custom metric — RPS from Prometheus
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: worker-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: message-worker
  minReplicas: 2
  maxReplicas: 30
  metrics:
  - type: External
    external:
      metric:
        name: queue_depth
        selector:
          matchLabels:
            queue: orders
      target:
        type: AverageValue
        averageValue: "50"
```

With this pattern, VPA manages Pod sizing (CPU + Memory), while HPA manages replica count based on queue depth — there is no interference.

## GitOps Integration: VPA Recommendations into Manifests

For teams using a GitOps workflow (ArgoCD, Flux), VPA recommendations should feed back into the source of truth in Git rather than being applied only in-cluster.

### Workflow: VPA Off Mode + Automated PR Generation

The recommended pattern for GitOps-mature teams is:

1. Deploy VPA in `Off` mode cluster-wide.
2. Run a scheduled job that reads VPA recommendations and generates PRs updating resource requests in the manifest repository.
3. Review and merge PRs through normal GitOps review process.
4. After merge and sync, the Deployment rollout applies the updated requests.

```python
#!/usr/bin/env python3
# vpa-gitops-sync.py — generate resource update patches from VPA recommendations

import subprocess
import json
import sys

def get_vpa_recommendations(namespace):
    result = subprocess.run(
        ["kubectl", "get", "vpa", "-n", namespace, "-o", "json"],
        capture_output=True, text=True, check=True
    )
    return json.loads(result.stdout)

def generate_patch(namespace, deployment, container, target_cpu, target_memory):
    patch = {
        "spec": {
            "template": {
                "spec": {
                    "containers": [
                        {
                            "name": container,
                            "resources": {
                                "requests": {
                                    "cpu": target_cpu,
                                    "memory": target_memory
                                }
                            }
                        }
                    ]
                }
            }
        }
    }
    return json.dumps(patch)

def main():
    namespace = sys.argv[1] if len(sys.argv) > 1 else "production"
    vpa_data = get_vpa_recommendations(namespace)

    for vpa in vpa_data.get("items", []):
        name = vpa["metadata"]["name"]
        target_ref = vpa["spec"]["targetRef"]
        recommendations = (
            vpa.get("status", {})
               .get("recommendation", {})
               .get("containerRecommendations", [])
        )

        for rec in recommendations:
            container = rec["containerName"]
            target_cpu = rec.get("target", {}).get("cpu", "")
            target_memory = rec.get("target", {}).get("memory", "")

            if target_cpu and target_memory:
                print(f"VPA: {name} | Container: {container} | "
                      f"CPU: {target_cpu} | Memory: {target_memory}")
                patch = generate_patch(
                    namespace,
                    target_ref["name"],
                    container,
                    target_cpu,
                    target_memory
                )
                print(f"Patch: {patch}")

if __name__ == "__main__":
    main()
```

### Kustomize Integration

Store VPA-derived resource patches as Kustomize strategic merge patches alongside workload manifests:

```
apps/checkout-api/
  base/
    deployment.yaml
    service.yaml
    kustomization.yaml
  overlays/
    production/
      kustomization.yaml
      resource-patch.yaml        # VPA-generated
      vpa.yaml                   # VPA object (Off mode)
```

```yaml
# overlays/production/resource-patch.yaml
# Generated by vpa-gitops-sync.py on 2030-08-29
apiVersion: apps/v1
kind: Deployment
metadata:
  name: checkout-api
spec:
  template:
    spec:
      containers:
      - name: checkout-api
        resources:
          requests:
            cpu: 450m
            memory: 768Mi
          limits:
            cpu: 900m
            memory: 1536Mi
```

```yaml
# overlays/production/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
- ../../base
- vpa.yaml
patchesStrategicMerge:
- resource-patch.yaml
```

## Troubleshooting VPA

### Recommendation Not Appearing

```bash
# Check Recommender logs
kubectl logs -n kube-system -l app=vpa-recommender --tail=50

# Verify metrics-server is available
kubectl top pods -n production

# Check VPA conditions
kubectl get vpa checkout-api-vpa -n production -o jsonpath='{.status.conditions}' | jq
```

Common causes: metrics-server not installed, insufficient history (less than a few hours), targetRef pointing to a non-existent workload.

### Updater Not Evicting Pods

```bash
kubectl logs -n kube-system -l app=vpa-updater --tail=100 | grep -i evict
```

Common causes: PDB blocking eviction, `minReplicas` not satisfied, workload is a DaemonSet (not supported by Updater).

### Admission Controller Webhook Failures

```bash
# Check webhook configuration
kubectl get mutatingwebhookconfigurations vpa-webhook-config -o yaml

# Check Admission Controller availability
kubectl get pods -n kube-system -l app=vpa-admission-controller

# Test webhook connectivity
kubectl run test-vpa --image=nginx --restart=Never -n production --dry-run=server
```

If the Admission Controller is unavailable and the webhook `failurePolicy` is `Fail`, all Pod creation in targeted namespaces will fail. Set `failurePolicy: Ignore` for non-critical namespaces and keep `Fail` only where right-sizing is mandatory for cost control.

### VPA and StatefulSets

VPA supports StatefulSets as a target reference, but the Updater handles them differently. StatefulSet Pods are evicted one at a time and respect `podManagementPolicy`. For StatefulSets managing databases:

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: postgres-vpa
  namespace: data
spec:
  targetRef:
    apiVersion: apps/v1
    kind: StatefulSet
    name: postgres
  updatePolicy:
    updateMode: "Off"    # Use Off + GitOps for stateful databases
  resourcePolicy:
    containerPolicies:
    - containerName: postgres
      minAllowed:
        cpu: 500m
        memory: 1Gi
      maxAllowed:
        cpu: 8000m
        memory: 16Gi
```

Always use `Off` mode or `Initial` mode for stateful database workloads. Allow GitOps-controlled rollouts to apply the updated requests during scheduled maintenance windows.

## Resource Policy: Controlling Recommender Behavior

The `resourcePolicy` section provides fine-grained control over how the Recommender generates suggestions.

```yaml
resourcePolicy:
  containerPolicies:
  - containerName: "*"          # Apply to all containers not explicitly listed
    mode: Auto
    minAllowed:
      cpu: 10m
      memory: 64Mi
    maxAllowed:
      cpu: 16000m
      memory: 32Gi
    controlledValues: RequestsAndLimits   # or RequestsOnly
```

**`controlledValues` options:**

- `RequestsOnly`: VPA adjusts only resource requests. Limits are unchanged. Suitable for workloads with manually tuned limits (e.g., hard memory ceilings).
- `RequestsAndLimits`: VPA adjusts both requests and limits, maintaining the original ratio between them. If requests double, limits double proportionally.

For most production workloads, `RequestsAndLimits` provides the best automatic behavior. Use `RequestsOnly` when the application has known memory limits that should never be increased automatically.

## Operating VPA at Scale: Multi-Namespace Deployment

For clusters with hundreds of namespaces, use namespace-level VPA objects with standardized resource bounds per workload tier:

```yaml
# Tier definitions — apply at namespace level via automation
---
# web-tier-vpa-template.yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: {{ .DeploymentName }}-vpa
  namespace: {{ .Namespace }}
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: {{ .DeploymentName }}
  updatePolicy:
    updateMode: "Off"
  resourcePolicy:
    containerPolicies:
    - containerName: "*"
      minAllowed:
        cpu: 50m
        memory: 128Mi
      maxAllowed:
        cpu: 2000m
        memory: 4Gi
```

A controller or pipeline can generate VPA objects for every Deployment in each namespace, collect recommendations nightly, and open PRs with right-sized requests — creating a continuous resource optimization loop without ever enabling automated Pod eviction.

## Cost Impact Measurement

Measure the financial impact of VPA recommendations before and after adoption:

```bash
#!/bin/bash
# measure-vpa-savings.sh

echo "=== Current Requests vs VPA Recommendations ==="
echo ""

kubectl get vpa --all-namespaces -o json | jq -r '
  .items[] |
  select(.status.recommendation != null) |
  .metadata.namespace as $ns |
  .metadata.name as $name |
  .status.recommendation.containerRecommendations[]? |
  [$ns, $name, .containerName,
   (.lowerBound.cpu // "N/A"), (.target.cpu // "N/A"), (.upperBound.cpu // "N/A"),
   (.lowerBound.memory // "N/A"), (.target.memory // "N/A"), (.upperBound.memory // "N/A")
  ] | @tsv
' | column -t -s $'\t'
```

Compare actual Pod resource requests (via `kubectl get pods -o json`) against VPA targets to quantify over-provisioning. Most clusters see 30-60% reduction in CPU requests and 20-40% reduction in memory requests after VPA-guided right-sizing.

## Summary

The Vertical Pod Autoscaler is an essential tool for production Kubernetes cost management. The key operational principles are:

- Start all workloads in `Off` mode to collect recommendations without risk.
- Advance to `Initial` or `Auto` mode only after validating recommendations over at least 7 days of representative load.
- Use `minReplicas` in the VPA spec to prevent disruptive evictions on single-replica Deployments.
- Separate CPU and memory control when HPA is active on CPU utilization metrics.
- Integrate VPA recommendations into GitOps workflows for databases and stateful workloads.
- Bound all VPA objects with `minAllowed` and `maxAllowed` to prevent unreasonable recommendations.
- Monitor Recommender, Updater, and Admission Controller independently — each can fail silently if not instrumented.

Right-sized workloads reduce waste, improve scheduling density, and lower the floor for cluster autoscaler scale-down — creating a compounding efficiency improvement across the entire cluster.
