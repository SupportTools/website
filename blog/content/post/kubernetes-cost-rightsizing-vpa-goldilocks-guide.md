---
title: "Kubernetes Resource Rightsizing: VPA Recommendations and Goldilocks"
date: 2028-11-20T00:00:00-05:00
draft: false
tags: ["Kubernetes", "FinOps", "VPA", "Goldilocks", "Cost Optimization"]
categories:
- Kubernetes
- FinOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to eliminating over-provisioned Kubernetes workloads using Vertical Pod Autoscaler recommender mode and the Goldilocks dashboard for namespace-wide cost rightsizing."
more_link: "yes"
url: "/kubernetes-cost-rightsizing-vpa-goldilocks-guide/"
---

Over-provisioned Kubernetes workloads are one of the largest sources of cloud waste. When engineers set resource requests and limits during initial deployment they routinely guess high, and those guesses calcify into permanent configuration. The result is clusters where actual CPU utilization sits at 15% of requested capacity and memory is similarly bloated. A realistic rightsizing program can cut node costs by 30–60% without changing application code.

This guide covers the complete workflow: deploying VPA in recommender-only mode, using Goldilocks to surface namespace-wide recommendations, understanding LimitRange interactions, calculating actual cost impact, and running quarterly reviews that stick.

<!--more-->

# Kubernetes Resource Rightsizing: VPA and Goldilocks in Production

## The Over-Provisioning Problem

Kubernetes schedules pods based on resource **requests**, not actual usage. A pod requesting 2 CPU cores occupies 2 cores of scheduling capacity on a node even if it only ever uses 200m. When every team padding requests by 10x to avoid OOMKills and CPU throttling, you end up paying for infrastructure that runs at single-digit utilization.

Concrete numbers from a typical enterprise cluster:

```
Namespace: payments
Deployment: payment-api (3 replicas)
  Requested:  cpu=2000m, memory=4Gi per pod  (6 CPU, 12Gi total)
  Actual p99:  cpu=180m,  memory=420Mi per pod
  Waste:       ~5.5 CPU cores, ~10.7Gi memory
  Monthly cost at $0.048/vCPU-hour: ~$190/month wasted on CPU alone
```

Multiply this across 50–200 deployments and you have a significant cloud spend problem that tooling can solve.

## VPA Architecture and Modes

The Vertical Pod Autoscaler consists of three components:

- **Recommender**: Watches metrics history and computes optimal requests/limits. Always running.
- **Updater**: Evicts pods that are outside the recommended range so they restart with new values.
- **Admission Plugin**: Mutates pod specs at admission time to apply VPA recommendations.

VPA supports four update modes:

| Mode | Behavior |
|------|----------|
| `Off` | Recommendations computed, no automatic changes |
| `Initial` | Apply on pod creation only, never evict running pods |
| `Recreate` | Evict pods when out of range, apply on restart |
| `Auto` | Same as Recreate currently; will use in-place updates when available |

For rightsizing programs, start with `Off` mode. It generates recommendations without touching running workloads. Move to `Initial` for non-critical workloads, and use `Auto` only for stateless workloads where brief restarts are acceptable.

## Deploying VPA

### Installation via Helm

```bash
helm repo add fairwinds-stable https://charts.fairwinds.com/stable
helm repo update

helm install vpa fairwinds-stable/vpa \
  --namespace vpa \
  --create-namespace \
  --set recommender.enabled=true \
  --set updater.enabled=false \
  --set admissionController.enabled=false \
  --version 4.5.0
```

For production clusters, deploy with recommender only first:

```yaml
# vpa-values.yaml
recommender:
  enabled: true
  extraArgs:
    memory-saver: "true"
    recommender-interval: "1m"
    pod-recommendation-min-cpu-millicores: "25"
    pod-recommendation-min-memory-mb: "64"
    target-cpu-percentile: "0.9"
    cpu-histogram-decay-half-life: "24h"
    memory-histogram-decay-half-life: "24h"
  resources:
    requests:
      cpu: 200m
      memory: 512Mi
    limits:
      cpu: 1000m
      memory: 2Gi

updater:
  enabled: false

admissionController:
  enabled: false
```

```bash
helm install vpa fairwinds-stable/vpa \
  --namespace vpa \
  --create-namespace \
  --values vpa-values.yaml
```

### Creating VPA Objects in Recommender Mode

```yaml
# vpa-payment-api.yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: payment-api
  namespace: payments
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: payment-api
  updatePolicy:
    updateMode: "Off"          # Recommendations only, no changes
  resourcePolicy:
    containerPolicies:
    - containerName: payment-api
      minAllowed:
        cpu: 50m
        memory: 64Mi
      maxAllowed:
        cpu: 4000m
        memory: 8Gi
      controlledResources: ["cpu", "memory"]
      controlledValues: RequestsAndLimits
```

```bash
kubectl apply -f vpa-payment-api.yaml

# Wait for recommendations (requires ~30 minutes of metric history)
kubectl describe vpa payment-api -n payments
```

### Reading VPA Recommendations

```bash
kubectl get vpa payment-api -n payments -o yaml
```

The output includes:

```yaml
status:
  conditions:
  - lastTransitionTime: "2028-11-20T10:00:00Z"
    status: "True"
    type: RecommendationProvided
  recommendation:
    containerRecommendations:
    - containerName: payment-api
      lowerBound:          # Safe lower bound (99th percentile minus buffer)
        cpu: 80m
        memory: 210Mi
      target:              # Recommended value (90th percentile usage)
        cpu: 150m
        memory: 380Mi
      uncappedTarget:      # Recommendation without min/max constraints
        cpu: 150m
        memory: 380Mi
      upperBound:          # Upper bound to prevent OOM or CPU starvation
        cpu: 620m
        memory: 1540Mi
```

The **target** is the value to use in your deployment. The **upperBound** is the recommended limit. The gap between target and upperBound is VPA's built-in headroom for spikes.

## Goldilocks: Namespace-Wide Dashboard

Goldilocks from Fairwinds creates VPA objects for every deployment in labeled namespaces and exposes a web dashboard showing all recommendations alongside current settings.

### Deploying Goldilocks

```bash
helm install goldilocks fairwinds-stable/goldilocks \
  --namespace goldilocks \
  --create-namespace \
  --set dashboard.enabled=true \
  --set controller.enabled=true
```

### Labeling Namespaces for Goldilocks

```bash
# Enable Goldilocks for specific namespaces
kubectl label namespace payments goldilocks.fairwinds.com/enabled=true
kubectl label namespace orders goldilocks.fairwinds.com/enabled=true
kubectl label namespace inventory goldilocks.fairwinds.com/enabled=true

# Verify labels
kubectl get namespaces -l goldilocks.fairwinds.com/enabled=true
```

Goldilocks automatically creates a VPA object in `Off` mode for each Deployment in labeled namespaces. No manual VPA creation required.

### Accessing the Dashboard

```bash
kubectl port-forward -n goldilocks svc/goldilocks-dashboard 8080:80
```

Open http://localhost:8080 to see a table of all deployments with:
- Current CPU/memory requests and limits
- VPA target recommendation
- Estimated cost impact per recommendation
- Quality of Service class changes

For persistent access, expose via Ingress:

```yaml
# goldilocks-ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: goldilocks
  namespace: goldilocks
  annotations:
    nginx.ingress.kubernetes.io/auth-type: basic
    nginx.ingress.kubernetes.io/auth-secret: goldilocks-auth
    nginx.ingress.kubernetes.io/auth-realm: "Goldilocks Dashboard"
spec:
  ingressClassName: nginx
  rules:
  - host: goldilocks.internal.company.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: goldilocks-dashboard
            port:
              number: 80
```

```bash
# Create basic auth secret
htpasswd -c auth admin
kubectl create secret generic goldilocks-auth \
  --from-file=auth \
  --namespace goldilocks
```

### Exporting Recommendations Programmatically

For automation and reporting, export recommendations via kubectl:

```bash
#!/bin/bash
# export-vpa-recommendations.sh

NAMESPACES=$(kubectl get namespaces -l goldilocks.fairwinds.com/enabled=true -o jsonpath='{.items[*].metadata.name}')

echo "deployment,namespace,container,current_cpu_req,current_mem_req,vpa_cpu_target,vpa_mem_target,cpu_reduction_pct,mem_reduction_pct"

for NS in $NAMESPACES; do
  for VPA in $(kubectl get vpa -n "$NS" -o jsonpath='{.items[*].metadata.name}'); do
    DEPLOYMENT="$VPA"

    # Get VPA recommendations
    VPA_CPU=$(kubectl get vpa "$VPA" -n "$NS" \
      -o jsonpath='{.status.recommendation.containerRecommendations[0].target.cpu}' 2>/dev/null)
    VPA_MEM=$(kubectl get vpa "$VPA" -n "$NS" \
      -o jsonpath='{.status.recommendation.containerRecommendations[0].target.memory}' 2>/dev/null)

    # Get current deployment requests
    CURRENT_CPU=$(kubectl get deployment "$DEPLOYMENT" -n "$NS" \
      -o jsonpath='{.spec.template.spec.containers[0].resources.requests.cpu}' 2>/dev/null)
    CURRENT_MEM=$(kubectl get deployment "$DEPLOYMENT" -n "$NS" \
      -o jsonpath='{.spec.template.spec.containers[0].resources.requests.memory}' 2>/dev/null)

    if [ -n "$VPA_CPU" ] && [ -n "$CURRENT_CPU" ]; then
      echo "$DEPLOYMENT,$NS,main,$CURRENT_CPU,$CURRENT_MEM,$VPA_CPU,$VPA_MEM,N/A,N/A"
    fi
  done
done
```

## LimitRange Interaction with VPA

LimitRanges set namespace-level defaults and constraints that interact with VPA in important ways.

### Understanding the Interaction

```yaml
# limitrange-payments.yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: payments-limits
  namespace: payments
spec:
  limits:
  - type: Container
    default:          # Applied when no limits specified
      cpu: 500m
      memory: 512Mi
    defaultRequest:   # Applied when no requests specified
      cpu: 100m
      memory: 128Mi
    max:              # Hard ceiling - VPA cannot exceed this
      cpu: 4000m
      memory: 8Gi
    min:              # Hard floor - VPA cannot go below this
      cpu: 50m
      memory: 64Mi
```

VPA respects LimitRange `max` and `min` constraints. If VPA recommends 8 CPU but LimitRange max is 4000m, VPA will cap its recommendation at 4000m.

The VPA `maxAllowed`/`minAllowed` in the VPA spec further constrains the recommendation within LimitRange bounds:

```
Effective min = max(LimitRange.min, VPA.minAllowed)
Effective max = min(LimitRange.max, VPA.maxAllowed)
```

### Diagnosing Capped Recommendations

When VPA recommendations are capped, the `uncappedTarget` field shows what VPA would recommend without constraints:

```yaml
status:
  recommendation:
    containerRecommendations:
    - containerName: payment-api
      target:
        cpu: "4"          # Capped at LimitRange max
        memory: 8Gi       # Capped at LimitRange max
      uncappedTarget:
        cpu: "7"          # What VPA actually wants to recommend
        memory: 14Gi      # Workload needs more than LimitRange allows
```

When `uncappedTarget` significantly exceeds `target`, the LimitRange max is too restrictive and should be raised, or the workload needs architectural review.

## Cost Impact Calculation

### Converting CPU/Memory to Dollars

```python
#!/usr/bin/env python3
# calculate-rightsizing-savings.py

import subprocess
import json
import re

# Cloud pricing (adjust for your region/instance type)
CPU_COST_PER_CORE_HOUR = 0.048   # $/vCPU/hour (us-east-1 m5.xlarge equivalent)
MEM_COST_PER_GB_HOUR = 0.006     # $/GB/hour

HOURS_PER_MONTH = 730

def parse_cpu_millicores(cpu_str):
    """Convert CPU string to millicores."""
    if cpu_str is None:
        return 0
    if cpu_str.endswith('m'):
        return int(cpu_str[:-1])
    return int(float(cpu_str) * 1000)

def parse_memory_mib(mem_str):
    """Convert memory string to MiB."""
    if mem_str is None:
        return 0
    units = {'Ki': 1/1024, 'Mi': 1, 'Gi': 1024, 'Ti': 1024*1024}
    for unit, factor in units.items():
        if mem_str.endswith(unit):
            return float(mem_str[:-2]) * factor
    return float(mem_str) / (1024 * 1024)  # bytes to MiB

def get_vpas(namespace):
    """Get VPA recommendations for a namespace."""
    result = subprocess.run(
        ['kubectl', 'get', 'vpa', '-n', namespace, '-o', 'json'],
        capture_output=True, text=True
    )
    return json.loads(result.stdout)

def get_deployment_replicas(deployment, namespace):
    """Get replica count for a deployment."""
    result = subprocess.run(
        ['kubectl', 'get', 'deployment', deployment, '-n', namespace,
         '-o', 'jsonpath={.spec.replicas}'],
        capture_output=True, text=True
    )
    try:
        return int(result.stdout) or 1
    except ValueError:
        return 1

def calculate_monthly_cost(cpu_millicores, memory_mib, replicas):
    """Calculate monthly cost for given resources and replicas."""
    cpu_cost = (cpu_millicores / 1000) * CPU_COST_PER_CORE_HOUR * HOURS_PER_MONTH * replicas
    mem_cost = (memory_mib / 1024) * MEM_COST_PER_GB_HOUR * HOURS_PER_MONTH * replicas
    return cpu_cost + mem_cost

def analyze_namespace(namespace):
    vpas = get_vpas(namespace)
    total_current_cost = 0
    total_recommended_cost = 0
    results = []

    for vpa in vpas.get('items', []):
        name = vpa['metadata']['name']
        recs = vpa.get('status', {}).get('recommendation', {})
        container_recs = recs.get('containerRecommendations', [])

        if not container_recs:
            continue

        # Get current resources from the deployment
        dep_result = subprocess.run(
            ['kubectl', 'get', 'deployment', name, '-n', namespace, '-o', 'json'],
            capture_output=True, text=True
        )
        if dep_result.returncode != 0:
            continue

        dep = json.loads(dep_result.stdout)
        replicas = dep['spec'].get('replicas', 1)
        containers = dep['spec']['template']['spec']['containers']

        for container in containers:
            cname = container['name']
            requests = container.get('resources', {}).get('requests', {})

            current_cpu = parse_cpu_millicores(requests.get('cpu'))
            current_mem = parse_memory_mib(requests.get('memory'))

            # Find matching VPA recommendation
            vpa_rec = next(
                (r for r in container_recs if r['containerName'] == cname),
                None
            )
            if not vpa_rec:
                continue

            rec_cpu = parse_cpu_millicores(vpa_rec['target'].get('cpu'))
            rec_mem = parse_memory_mib(vpa_rec['target'].get('memory'))

            current_cost = calculate_monthly_cost(current_cpu, current_mem, replicas)
            recommended_cost = calculate_monthly_cost(rec_cpu, rec_mem, replicas)
            savings = current_cost - recommended_cost

            total_current_cost += current_cost
            total_recommended_cost += recommended_cost

            results.append({
                'deployment': name,
                'container': cname,
                'replicas': replicas,
                'current_cpu_m': current_cpu,
                'current_mem_mib': round(current_mem),
                'rec_cpu_m': rec_cpu,
                'rec_mem_mib': round(rec_mem),
                'current_cost_mo': round(current_cost, 2),
                'recommended_cost_mo': round(recommended_cost, 2),
                'savings_mo': round(savings, 2),
            })

    return results, total_current_cost, total_recommended_cost

# Main analysis
namespaces = ['payments', 'orders', 'inventory', 'frontend']
grand_current = 0
grand_recommended = 0

for ns in namespaces:
    results, ns_current, ns_recommended = analyze_namespace(ns)
    grand_current += ns_current
    grand_recommended += ns_recommended

    print(f"\n=== Namespace: {ns} ===")
    print(f"{'Deployment':<30} {'Reps':<5} {'Curr CPU':<10} {'Rec CPU':<10} {'Curr Mem':<10} {'Rec Mem':<10} {'Savings/Mo':<12}")
    print("-" * 100)
    for r in sorted(results, key=lambda x: x['savings_mo'], reverse=True):
        print(f"{r['deployment']:<30} {r['replicas']:<5} "
              f"{r['current_cpu_m']}m{'':<6} {r['rec_cpu_m']}m{'':<6} "
              f"{r['current_mem_mib']}Mi{'':<4} {r['rec_mem_mib']}Mi{'':<4} "
              f"${r['savings_mo']:<11}")

print(f"\n{'='*60}")
print(f"Total current monthly cost:     ${grand_current:,.2f}")
print(f"Total recommended monthly cost: ${grand_recommended:,.2f}")
print(f"Potential monthly savings:      ${grand_current - grand_recommended:,.2f}")
print(f"Potential annual savings:       ${(grand_current - grand_recommended) * 12:,.2f}")
```

## Combining VPA with HPA

VPA and HPA conflict when both target CPU utilization. The safe combination is:

- **HPA**: Target custom metrics or memory, not CPU percentage when CPU-based VPA is active
- **VPA**: Set `controlledResources: ["memory"]` when HPA handles CPU scaling

```yaml
# VPA targeting only memory (HPA handles CPU scaling)
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: payment-api
  namespace: payments
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: payment-api
  updatePolicy:
    updateMode: "Initial"
  resourcePolicy:
    containerPolicies:
    - containerName: payment-api
      controlledResources: ["memory"]    # VPA manages memory only
      controlledValues: RequestsAndLimits
      minAllowed:
        memory: 128Mi
      maxAllowed:
        memory: 4Gi
---
# HPA targeting CPU percentage (VPA not controlling CPU)
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: payment-api
  namespace: payments
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: payment-api
  minReplicas: 2
  maxReplicas: 20
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
      - type: Pods
        value: 1
        periodSeconds: 60
    scaleUp:
      stabilizationWindowSeconds: 60
      policies:
      - type: Pods
        value: 2
        periodSeconds: 60
```

## Quarterly Rightsizing Review Workflow

### Step 1: Generate Recommendation Report

```bash
#!/bin/bash
# quarterly-rightsizing-report.sh

REPORT_DATE=$(date +%Y-%m-%d)
REPORT_FILE="rightsizing-report-${REPORT_DATE}.csv"

echo "namespace,deployment,container,current_cpu_req,current_mem_req,vpa_cpu_target,vpa_mem_target,vpa_cpu_upper,vpa_mem_upper" > "$REPORT_FILE"

for NS in $(kubectl get namespaces -l goldilocks.fairwinds.com/enabled=true \
           -o jsonpath='{.items[*].metadata.name}'); do
  for VPA in $(kubectl get vpa -n "$NS" -o jsonpath='{.items[*].metadata.name}' 2>/dev/null); do

    RECS=$(kubectl get vpa "$VPA" -n "$NS" -o json 2>/dev/null)

    CPU_TARGET=$(echo "$RECS" | jq -r \
      '.status.recommendation.containerRecommendations[0].target.cpu // "N/A"')
    MEM_TARGET=$(echo "$RECS" | jq -r \
      '.status.recommendation.containerRecommendations[0].target.memory // "N/A"')
    CPU_UPPER=$(echo "$RECS" | jq -r \
      '.status.recommendation.containerRecommendations[0].upperBound.cpu // "N/A"')
    MEM_UPPER=$(echo "$RECS" | jq -r \
      '.status.recommendation.containerRecommendations[0].upperBound.memory // "N/A"')
    CONTAINER=$(echo "$RECS" | jq -r \
      '.status.recommendation.containerRecommendations[0].containerName // "N/A"')

    CURR_CPU=$(kubectl get deployment "$VPA" -n "$NS" \
      -o jsonpath='{.spec.template.spec.containers[0].resources.requests.cpu}' 2>/dev/null || echo "N/A")
    CURR_MEM=$(kubectl get deployment "$VPA" -n "$NS" \
      -o jsonpath='{.spec.template.spec.containers[0].resources.requests.memory}' 2>/dev/null || echo "N/A")

    echo "$NS,$VPA,$CONTAINER,$CURR_CPU,$CURR_MEM,$CPU_TARGET,$MEM_TARGET,$CPU_UPPER,$MEM_UPPER" >> "$REPORT_FILE"
  done
done

echo "Report written to: $REPORT_FILE"
wc -l "$REPORT_FILE"
```

### Step 2: Apply Recommendations Safely

Never apply all recommendations at once. Use a staged rollout:

```bash
#!/bin/bash
# apply-vpa-recommendations.sh
# Usage: ./apply-vpa-recommendations.sh <namespace> <deployment> [--dry-run]

NAMESPACE=$1
DEPLOYMENT=$2
DRY_RUN=${3:-""}

if [ -z "$NAMESPACE" ] || [ -z "$DEPLOYMENT" ]; then
  echo "Usage: $0 <namespace> <deployment> [--dry-run]"
  exit 1
fi

# Get VPA recommendation
VPA_DATA=$(kubectl get vpa "$DEPLOYMENT" -n "$NAMESPACE" -o json)

if [ -z "$VPA_DATA" ]; then
  echo "ERROR: No VPA found for $DEPLOYMENT in $NAMESPACE"
  exit 1
fi

CPU_TARGET=$(echo "$VPA_DATA" | jq -r \
  '.status.recommendation.containerRecommendations[0].target.cpu')
MEM_TARGET=$(echo "$VPA_DATA" | jq -r \
  '.status.recommendation.containerRecommendations[0].target.memory')
CPU_UPPER=$(echo "$VPA_DATA" | jq -r \
  '.status.recommendation.containerRecommendations[0].upperBound.cpu')
MEM_UPPER=$(echo "$VPA_DATA" | jq -r \
  '.status.recommendation.containerRecommendations[0].upperBound.memory')

echo "Recommendation for $DEPLOYMENT in $NAMESPACE:"
echo "  CPU request: $CPU_TARGET (limit: $CPU_UPPER)"
echo "  Memory request: $MEM_TARGET (limit: $MEM_UPPER)"

if [ "$DRY_RUN" == "--dry-run" ]; then
  echo "DRY RUN: Would patch deployment with above values"
  exit 0
fi

# Apply patch
kubectl patch deployment "$DEPLOYMENT" -n "$NAMESPACE" \
  --type='json' \
  -p="[
    {\"op\": \"replace\", \"path\": \"/spec/template/spec/containers/0/resources/requests/cpu\", \"value\": \"$CPU_TARGET\"},
    {\"op\": \"replace\", \"path\": \"/spec/template/spec/containers/0/resources/requests/memory\", \"value\": \"$MEM_TARGET\"},
    {\"op\": \"replace\", \"path\": \"/spec/template/spec/containers/0/resources/limits/cpu\", \"value\": \"$CPU_UPPER\"},
    {\"op\": \"replace\", \"path\": \"/spec/template/spec/containers/0/resources/limits/memory\", \"value\": \"$MEM_UPPER\"}
  ]"

echo "Patch applied. Waiting for rollout..."
kubectl rollout status deployment/"$DEPLOYMENT" -n "$NAMESPACE" --timeout=5m
echo "Done."
```

### Step 3: Monitor After Changes

```bash
# Watch pod restarts after rightsizing
kubectl get pods -n payments -w

# Check if OOMKilled events appear
kubectl get events -n payments \
  --field-selector reason=OOMKilling \
  --sort-by='.lastTimestamp'

# Verify resource utilization post-change with metrics-server
kubectl top pods -n payments --sort-by=cpu
```

## Goldilocks Configuration Tuning

The Goldilocks controller accepts VPA override annotations per deployment:

```yaml
# Override VPA update mode for a specific deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-api
  namespace: payments
  annotations:
    goldilocks.fairwinds.com/update-mode: "off"      # Force off mode
    goldilocks.fairwinds.com/vpa-update-mode: "auto" # Use auto mode
    goldilocks.fairwinds.com/exclude: "true"         # Exclude from Goldilocks
spec:
  # ... deployment spec
```

## Handling Workloads VPA Cannot Manage

Some workloads need manual rightsizing:

- **DaemonSets**: VPA supports them but eviction can impact cluster stability
- **Jobs and CronJobs**: VPA works but recommendations may be noisy
- **Init containers**: VPA recommends for init containers separately
- **StatefulSets with PodDisruptionBudgets**: Updater may be blocked by PDB

For DaemonSets, use VPA in `Off` mode to get recommendations and apply them manually:

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: node-exporter
  namespace: monitoring
spec:
  targetRef:
    apiVersion: apps/v1
    kind: DaemonSet
    name: node-exporter
  updatePolicy:
    updateMode: "Off"   # Always Off for DaemonSets in production
```

## Common Pitfalls and Solutions

### Recommendations Based on Insufficient History

VPA needs at least 8 hours of data for basic recommendations and 24 hours for reliable recommendations. Check recommendation quality:

```bash
kubectl describe vpa payment-api -n payments | grep -A 20 "Conditions:"
```

If you see `LowConfidence` condition, wait for more data.

### VPA and Burstable QoS

When VPA sets different request and limit values, pods become Burstable QoS class. If you need Guaranteed QoS (requests == limits), configure VPA accordingly:

```yaml
resourcePolicy:
  containerPolicies:
  - containerName: payment-api
    controlledValues: RequestsOnly  # Only set requests, leave limits alone
```

Then set limits manually as a multiple of requests (e.g., 2x memory limit for headroom).

### Tracking Rightsizing Progress

```bash
# Calculate cluster-wide request vs actual utilization ratio
kubectl get nodes -o json | jq -r '
  .items[] |
  .metadata.name as $node |
  .status.allocatable.cpu as $alloc_cpu |
  .status.allocatable.memory as $alloc_mem |
  [$node, $alloc_cpu, $alloc_mem] | @csv
'

kubectl top nodes
```

## Summary

An effective rightsizing program combines VPA recommender mode (via Goldilocks) for automated recommendations with a human-in-the-loop process for applying changes. The key principles are:

1. Deploy VPA in `Off` mode first, collect 7+ days of data before acting
2. Use Goldilocks dashboard for team-visible recommendations
3. Start with the highest-waste deployments (sort by savings_mo in your report)
4. Apply changes during low-traffic windows with rollback procedures ready
5. Validate with `kubectl top` and OOMKilled event monitoring after each change
6. Run quarterly reviews to capture configuration drift

Teams that follow this process consistently reduce cluster costs by 30–50% within the first quarter, with ongoing savings as they onboard new workloads with accurate baselines rather than guesses.
