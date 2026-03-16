---
title: "Goldilocks: VPA-Based Resource Rightsizing for Kubernetes"
date: 2027-02-22T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Goldilocks", "VPA", "Resource Optimization", "FinOps"]
categories: ["Kubernetes", "FinOps", "Resource Management"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to deploying Goldilocks alongside the Vertical Pod Autoscaler to generate resource rightsizing recommendations, interpret QoS classes, export patches, and integrate with FinOps workflows."
more_link: "yes"
url: "/goldilocks-vertical-pod-autoscaler-rightsizing-guide/"
---

Goldilocks is a Fairwinds open-source tool that leverages the Kubernetes Vertical Pod Autoscaler (VPA) recommender to surface CPU and memory sizing recommendations through a web dashboard. Rather than auto-applying VPA changes, Goldilocks operates purely in **recommendation mode**, giving platform engineers actionable data without the operational risk of live resource mutations.

This guide covers the full stack: installing VPA and Goldilocks, opting namespaces into scanning, reading QoS class recommendations from the dashboard, exporting patches for GitOps workflows, integrating with Kubecost for cost impact, and monitoring recommendation drift over time with Prometheus.

<!--more-->

## The Resource Rightsizing Problem

Kubernetes resource requests and limits are notoriously difficult to set correctly. Teams typically face two failure modes:

- **Over-provisioning**: Requests are set too high, nodes fill up with reserved-but-unused capacity, and cloud spend balloons. Engineers guess at limits based on load tests that do not reflect production traffic patterns.
- **Under-provisioning**: Requests are too low, the scheduler packs pods onto nodes that cannot actually sustain them, and OOMKill or CPU throttling degrades application performance during peak traffic.

Goldilocks solves this by running VPA recommenders continuously against real workload data and surfacing the recommendations without applying them, keeping operations teams in control of the change process.

## Architecture

### Component Breakdown

Goldilocks consists of two Kubernetes components:

**Goldilocks Controller** — Watches namespaces labeled with `goldilocks.fairwinds.com/enabled: "true"` and creates a VPA object (in `Off` mode) for every `Deployment` in those namespaces. The VPA recommender collects resource utilization from the Metrics Server or Prometheus and populates recommendations on the VPA status.

**Goldilocks Dashboard** — A read-only web UI that queries all VPA objects managed by the controller and presents the recommendations alongside the current requests and QoS class impact.

Neither component modifies Pod specs directly. The VPA update mode is always `Off`, which means the recommender collects data and publishes recommendations to the VPA status field but never evicts or patches any pod.

### VPA Recommender Data Flow

```
Metrics Server / Prometheus
        │
        ▼
 VPA Recommender (kube-system)
        │  reads historical CPU/memory samples
        ▼
 VPA Object (.status.recommendation)
        │
        ▼
 Goldilocks Dashboard
        │  renders recommendations per container
        ▼
 Engineer exports YAML patch → GitOps PR
```

## Prerequisites

### Install the Metrics Server

```bash
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml

# Verify
kubectl top nodes
kubectl top pods -A
```

### Install the Vertical Pod Autoscaler

```bash
git clone https://github.com/kubernetes/autoscaler.git
cd autoscaler/vertical-pod-autoscaler

# Install CRDs and components
./hack/vpa-install.sh

# Verify VPA components
kubectl -n kube-system get pods | grep vpa
# vpa-admission-controller-xxx   Running
# vpa-recommender-xxx            Running
# vpa-updater-xxx                Running
```

For production deployments, install via Helm to get configurable resource limits:

```bash
helm repo add fairwinds-stable https://charts.fairwinds.com/stable
helm repo update

helm install vpa fairwinds-stable/vpa \
  --namespace kube-system \
  --set recommender.resources.requests.cpu=100m \
  --set recommender.resources.requests.memory=512Mi \
  --set recommender.resources.limits.cpu=500m \
  --set recommender.resources.limits.memory=1Gi \
  --set updater.enabled=false \
  --set admissionPlugin.enabled=false
```

Disabling the updater and admission plugin is recommended when using Goldilocks in recommendation-only mode. This reduces risk and avoids unexpected pod evictions.

## Installing Goldilocks

### Helm Installation

```bash
helm repo add fairwinds-stable https://charts.fairwinds.com/stable
helm repo update

helm install goldilocks fairwinds-stable/goldilocks \
  --namespace goldilocks \
  --create-namespace \
  --version 9.0.0 \
  --set controller.enabled=true \
  --set dashboard.enabled=true \
  --set dashboard.replicaCount=1 \
  --set dashboard.service.type=ClusterIP \
  --set controller.resources.requests.cpu=25m \
  --set controller.resources.requests.memory=64Mi \
  --set controller.resources.limits.cpu=250m \
  --set controller.resources.limits.memory=256Mi
```

### Production values.yaml

```yaml
# goldilocks-values.yaml
controller:
  enabled: true
  replicaCount: 1
  resources:
    requests:
      cpu: 25m
      memory: 64Mi
    limits:
      cpu: 250m
      memory: 256Mi
  securityContext:
    runAsNonRoot: true
    runAsUser: 10324
    allowPrivilegeEscalation: false
    readOnlyRootFilesystem: true
    capabilities:
      drop:
        - ALL
  # Only manage specific namespaces if not using label opt-in
  # flags:
  #   - "--on-by-default=false"

dashboard:
  enabled: true
  replicaCount: 2
  resources:
    requests:
      cpu: 25m
      memory: 64Mi
    limits:
      cpu: 250m
      memory: 256Mi
  securityContext:
    runAsNonRoot: true
    runAsUser: 10324
    allowPrivilegeEscalation: false
    readOnlyRootFilesystem: true
    capabilities:
      drop:
        - ALL
  service:
    type: ClusterIP
    port: 80
  ingress:
    enabled: true
    ingressClassName: nginx
    annotations:
      nginx.ingress.kubernetes.io/auth-type: basic
      nginx.ingress.kubernetes.io/auth-secret: goldilocks-basic-auth
      cert-manager.io/cluster-issuer: letsencrypt-prod
    hosts:
      - host: goldilocks.internal.company.com
        paths:
          - path: /
            pathType: Prefix
    tls:
      - secretName: goldilocks-tls
        hosts:
          - goldilocks.internal.company.com

vpa:
  # Point to the VPA CRD group installed earlier
  enabled: true
  updater:
    enabled: false
```

Apply:

```bash
helm install goldilocks fairwinds-stable/goldilocks \
  --namespace goldilocks \
  --create-namespace \
  --version 9.0.0 \
  -f goldilocks-values.yaml
```

### Accessing the Dashboard

```bash
# Port-forward for local access during evaluation
kubectl -n goldilocks port-forward svc/goldilocks-dashboard 8080:80

# Then open http://localhost:8080
```

## Opting Namespaces into Scanning

Label any namespace to enable Goldilocks for all Deployments within it:

```bash
# Enable a namespace
kubectl label namespace production goldilocks.fairwinds.com/enabled=true

# Confirm VPA objects are created
kubectl -n production get vpa
# NAME                    MODE   CPU   MEM       PROVIDED   AGE
# payment-api             Off    25m   200Mi     True       5m
# order-service           Off    50m   512Mi     True       5m
# frontend                Off    100m  256Mi     True       5m
```

### Bulk Enablement via Label Selector

```bash
# Enable all namespaces with a specific label
for ns in $(kubectl get namespaces -l environment=production -o jsonpath='{.items[*].metadata.name}'); do
  kubectl label namespace "$ns" goldilocks.fairwinds.com/enabled=true
done

# Verify
kubectl get namespaces -l goldilocks.fairwinds.com/enabled=true
```

### Per-Deployment VPA Resource Policy

Override the VPA resource policy for specific containers to exclude them from recommendations or set min/max bounds:

```yaml
# Apply a VPA with a controlled resource policy
# Goldilocks respects existing VPA objects — do not duplicate
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: payment-api
  namespace: production
  labels:
    app.kubernetes.io/managed-by: goldilocks
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: payment-api
  updatePolicy:
    updateMode: "Off"
  resourcePolicy:
    containerPolicies:
      - containerName: payment-api
        minAllowed:
          cpu: 50m
          memory: 128Mi
        maxAllowed:
          cpu: 4000m
          memory: 4Gi
        controlledResources:
          - cpu
          - memory
      - containerName: envoy-sidecar
        # Exclude the sidecar from recommendations
        mode: "Off"
```

## Interpreting Dashboard Recommendations

### QoS Class Impact

The Goldilocks dashboard presents each container with three recommendation rows corresponding to QoS classes:

- **Guaranteed** — `requests == limits` for both CPU and memory. The scheduler will not over-commit these resources on the node. Pods get the highest priority when the node is under pressure. Recommended for latency-sensitive workloads.
- **Burstable** — `requests < limits`. The pod gets at least the requested amount but can burst to the limit if node capacity allows. The most common production pattern.
- **Best Effort** — No requests or limits set. The pod gets whatever is left on the node and is the first to be evicted under memory pressure. Appropriate only for non-critical batch jobs.

The dashboard color-codes containers based on how far current requests deviate from the VPA recommendation:

- Green: Current requests within 15% of recommendation
- Yellow: Current requests 15–50% off from recommendation
- Red: Current requests more than 50% off from recommendation (significant waste or risk)

### Reading a Recommendation

Example VPA status output:

```bash
kubectl -n production describe vpa order-service
```

```
Status:
  Recommendation:
    Container Recommendations:
      Container Name:  order-service
      Lower Bound:
        Cpu:     25m
        Memory:  262144k
      Target:
        Cpu:     50m
        Memory:  524288k
      Uncapped Target:
        Cpu:     45m
        Memory:  498Mi
      Upper Bound:
        Cpu:     250m
        Memory:  2Gi
```

- **Target**: The recommended value based on observed usage plus a safety margin.
- **Lower Bound**: Minimum safe value — setting requests below this risks OOMKill or severe CPU throttling.
- **Upper Bound**: Maximum practical value — anything above this wastes capacity.
- **Uncapped Target**: The raw recommendation before applying `minAllowed`/`maxAllowed` bounds.

Set requests to the **Target** value for steady-state workloads. For burst-heavy workloads, set requests to the Target and limits to the Upper Bound.

## Exporting Recommendations as YAML Patches

The dashboard provides copy-paste YAML for each container. Automate this extraction via the VPA API:

```bash
#!/usr/bin/env bash
# export-vpa-recommendations.sh
# Exports VPA recommendations for all VPAs in a namespace as strategic merge patches

NAMESPACE="${1:-production}"
OUTPUT_DIR="./vpa-patches/${NAMESPACE}"
mkdir -p "${OUTPUT_DIR}"

kubectl -n "${NAMESPACE}" get vpa -o json | jq -r '.items[]' | while IFS= read -r vpa_json; do
  vpa_name=$(echo "${vpa_json}" | jq -r '.metadata.name')
  target_name=$(echo "${vpa_json}" | jq -r '.spec.targetRef.name')
  target_kind=$(echo "${vpa_json}" | jq -r '.spec.targetRef.kind')

  containers=$(echo "${vpa_json}" | jq -c '.status.recommendation.containerRecommendations[]?' 2>/dev/null)

  if [[ -z "${containers}" ]]; then
    echo "No recommendations yet for ${vpa_name}, skipping."
    continue
  fi

  patch_file="${OUTPUT_DIR}/${target_name}-resource-patch.yaml"

  cat > "${patch_file}" <<EOF
apiVersion: apps/v1
kind: ${target_kind}
metadata:
  name: ${target_name}
  namespace: ${NAMESPACE}
spec:
  template:
    spec:
      containers:
EOF

  echo "${containers}" | while IFS= read -r container_json; do
    container_name=$(echo "${container_json}" | jq -r '.containerName')
    cpu_target=$(echo "${container_json}" | jq -r '.target.cpu')
    mem_target=$(echo "${container_json}" | jq -r '.target.memory')
    cpu_upper=$(echo "${container_json}" | jq -r '.upperBound.cpu')
    mem_upper=$(echo "${container_json}" | jq -r '.upperBound.memory')

    cat >> "${patch_file}" <<EOF
        - name: ${container_name}
          resources:
            requests:
              cpu: "${cpu_target}"
              memory: "${mem_target}"
            limits:
              cpu: "${cpu_upper}"
              memory: "${mem_upper}"
EOF
  done

  echo "Written: ${patch_file}"
done
```

```bash
chmod +x export-vpa-recommendations.sh
./export-vpa-recommendations.sh production

# Apply patches
kubectl apply -f ./vpa-patches/production/
```

## Integration with Kubecost for Cost Impact

Combining Goldilocks recommendations with Kubecost allocation data reveals the dollar-value impact of rightsizing:

```bash
# Query Kubecost allocation API for a namespace
curl -s "http://kubecost.monitoring.svc.cluster.local:9090/model/allocation" \
  --data-urlencode "window=7d" \
  --data-urlencode "aggregate=namespace" \
  --data-urlencode "namespace=production" \
  | jq '.data[].production | {
      cpuCost: .cpuCost,
      memoryCost: .memoryCost,
      cpuEfficiency: .cpuEfficiency,
      memoryEfficiency: .memoryEfficiency,
      totalCost: .totalCost
    }'
```

Compare CPU efficiency against the Goldilocks recommendations. Containers with efficiency below 30% are prime rightsizing candidates. A simple script correlates the two data sources:

```python
#!/usr/bin/env python3
"""correlate-goldilocks-kubecost.py
Cross-references VPA recommendations with Kubecost container-level cost data.
"""

import json
import subprocess
import sys
from decimal import Decimal


def get_vpa_recommendations(namespace: str) -> dict:
    result = subprocess.run(
        ["kubectl", "-n", namespace, "get", "vpa", "-o", "json"],
        capture_output=True, text=True, check=True
    )
    vpas = json.loads(result.stdout)
    recs = {}
    for vpa in vpas.get("items", []):
        target = vpa["spec"]["targetRef"]["name"]
        containers = vpa.get("status", {}).get("recommendation", {}).get("containerRecommendations", [])
        recs[target] = containers
    return recs


def parse_cpu_millicores(value: str) -> int:
    if value.endswith("m"):
        return int(value[:-1])
    return int(Decimal(value) * 1000)


def main():
    namespace = sys.argv[1] if len(sys.argv) > 1 else "production"
    recs = get_vpa_recommendations(namespace)

    print(f"{'Deployment':<30} {'Container':<25} {'Current CPU':<15} {'Recommended':<15} {'Savings %':<12}")
    print("-" * 100)

    for deployment, containers in recs.items():
        for container in containers:
            name = container["containerName"]
            target_cpu = container.get("target", {}).get("cpu", "unknown")
            print(f"{deployment:<30} {name:<25} {'(check manifest)':<15} {target_cpu:<15} {'run export script':<12}")


if __name__ == "__main__":
    main()
```

## Setting Namespace-Level VPA Exclusion

Exclude containers that should not be resized (databases with pinned memory, JVM heap containers):

```yaml
# Label a namespace but exclude specific containers via VPA resource policy
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: postgres-primary
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: StatefulSet
    name: postgres-primary
  updatePolicy:
    updateMode: "Off"
  resourcePolicy:
    containerPolicies:
      - containerName: postgres
        # Database memory is tuned separately via shared_buffers
        mode: "Off"
      - containerName: exporter
        minAllowed:
          cpu: 10m
          memory: 32Mi
        maxAllowed:
          cpu: 200m
          memory: 128Mi
```

## CI/CD Integration for Ongoing Rightsizing

Embed recommendation checks into a weekly pipeline that flags drifted workloads:

```yaml
# .github/workflows/rightsizing-report.yaml
name: Weekly Rightsizing Report

on:
  schedule:
    - cron: "0 8 * * 1"   # Every Monday at 08:00 UTC
  workflow_dispatch:

jobs:
  generate-report:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Configure kubectl
        uses: azure/setup-kubectl@v3

      - name: Export recommendations
        run: |
          chmod +x ./scripts/export-vpa-recommendations.sh
          ./scripts/export-vpa-recommendations.sh production
          ./scripts/export-vpa-recommendations.sh staging

      - name: Open PR if changes detected
        uses: peter-evans/create-pull-request@v6
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          commit-message: "chore: update resource requests from Goldilocks recommendations"
          title: "Weekly resource rightsizing recommendations"
          body: |
            This PR was automatically generated from Goldilocks VPA recommendations.

            Review each patch file and merge when approved by the owning team.

            Generated on: $(date -u +%Y-%m-%dT%H:%M:%SZ)
          branch: rightsizing/weekly-update
          delete-branch: true
          labels:
            - rightsizing
            - automated
```

## Monitoring Recommendations with Prometheus

Expose VPA recommendation metrics via the kube-state-metrics VPA collector (available in kube-state-metrics v2.6+):

```bash
helm upgrade kube-state-metrics prometheus-community/kube-state-metrics \
  --namespace monitoring \
  --set rbac.extraRules[0].apiGroups[0]="autoscaling.k8s.io" \
  --set rbac.extraRules[0].resources[0]="verticalpodautoscalers" \
  --set rbac.extraRules[0].verbs[0]="list" \
  --set rbac.extraRules[0].verbs[1]="watch" \
  --set collectors[0]=verticalpodautoscalers
```

Useful PromQL queries:

```promql
# Containers where current CPU request is more than 2x the VPA recommendation
(
  kube_pod_container_resource_requests{resource="cpu"}
  / on(namespace, pod, container) group_left
  label_replace(
    kube_verticalpodautoscaler_status_recommendation_containerrecommendations_target{resource="cpu"},
    "pod", "$1", "target_name", "(.*)"
  )
) > 2

# Total wasted CPU millicores across production
sum by (namespace) (
  kube_pod_container_resource_requests{resource="cpu", namespace=~"production.*"}
  -
  kube_verticalpodautoscaler_status_recommendation_containerrecommendations_target{resource="cpu", namespace=~"production.*"}
)

# Memory over-provisioning ratio
sum by (namespace) (
  kube_pod_container_resource_requests{resource="memory"}
) /
sum by (namespace) (
  kube_verticalpodautoscaler_status_recommendation_containerrecommendations_target{resource="memory"}
)
```

```yaml
# Alert on high over-provisioning
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: goldilocks-rightsizing-alerts
  namespace: monitoring
spec:
  groups:
    - name: goldilocks
      rules:
        - alert: ContainerHighlyOverProvisioned
          expr: >
            (
              kube_pod_container_resource_requests{resource="cpu"}
              / on(namespace, pod, container) group_left
              kube_verticalpodautoscaler_status_recommendation_containerrecommendations_target{resource="cpu"}
            ) > 3
          for: 24h
          labels:
            severity: info
          annotations:
            summary: "Container CPU requests are 3x the VPA recommendation"
            description: >-
              {{ $labels.namespace }}/{{ $labels.pod }}/{{ $labels.container }}
              has CPU requests {{ $value }}x above the VPA target.
              Consider rightsizing to reclaim capacity.
```

## Troubleshooting Common Issues

### VPA Objects Not Created for Deployments

```bash
# Check controller logs for reconciliation errors
kubectl -n goldilocks logs -l app.kubernetes.io/name=goldilocks \
  -c goldilocks \
  --tail=100

# Confirm the namespace label is correct
kubectl get namespace production --show-labels \
  | grep goldilocks

# Verify the VPA CRD is installed
kubectl get crd verticalpodautoscalers.autoscaling.k8s.io

# List all VPAs in the namespace
kubectl -n production get vpa -o wide
```

### Dashboard Shows No Recommendations

VPA requires sufficient historical data to generate recommendations. Common causes:

```bash
# Check VPA recommender is running and healthy
kubectl -n kube-system get pods -l app=vpa-recommender
kubectl -n kube-system logs -l app=vpa-recommender --tail=50

# Verify Metrics Server is returning data
kubectl top pods -n production

# Check if VPA has enough data (look for "Provided: True")
kubectl -n production describe vpa payment-api
# If Provided: False — wait at least 2 hours for initial recommendation

# Check for VPA recommender errors related to specific workloads
kubectl -n kube-system logs -l app=vpa-recommender \
  | grep -E "(ERROR|payment-api)"
```

### Goldilocks Dashboard Pod Failing to Start

```bash
# Check events
kubectl -n goldilocks describe pod -l app.kubernetes.io/name=goldilocks-dashboard

# Common issue: RBAC insufficient permissions
kubectl -n goldilocks logs -l app.kubernetes.io/name=goldilocks-dashboard \
  | grep -E "(forbidden|error)"

# Verify the goldilocks service account has list/watch on VPAs
kubectl auth can-i list verticalpodautoscalers \
  --as=system:serviceaccount:goldilocks:goldilocks \
  -A
```

### VPA Conflicts with Horizontal Pod Autoscaler

Running VPA `Auto` or `Recreate` mode alongside HPA on the same deployment creates a conflict: VPA may change requests while HPA is scaling replicas, causing thrashing. For workloads managed by HPA, use VPA in `Off` mode (which is Goldilocks' default) and apply recommendations manually:

```yaml
# Correct pattern: VPA Off mode + HPA
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: web-frontend
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: web-frontend
  updatePolicy:
    updateMode: "Off"   # Never auto-apply — Goldilocks reads recommendations only
  resourcePolicy:
    containerPolicies:
      - containerName: web-frontend
        controlledResources:
          - cpu
          - memory
        # Exclude memory from VPA — HPA is scaling replicas instead
        controlledValues: RequestsOnly
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: web-frontend
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: web-frontend
  minReplicas: 2
  maxReplicas: 20
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 60
```

## Automation: Applying Recommendations at Scale

### Bulk Patch Application Script

After reviewing the exported patches, apply them in a controlled rollout by namespace:

```bash
#!/usr/bin/env bash
# apply-rightsizing-patches.sh
# Applies VPA recommendation patches with rolling deployment restarts

PATCH_DIR="${1:-./vpa-patches}"
DRY_RUN="${2:-client}"   # Use "none" to apply for real

for patch_file in "${PATCH_DIR}"/**/*-resource-patch.yaml; do
  namespace=$(basename "$(dirname "$patch_file")")
  deployment=$(basename "$patch_file" -resource-patch.yaml)

  echo "==> Applying patch: ${namespace}/${deployment}"

  if [[ "${DRY_RUN}" == "none" ]]; then
    kubectl apply -f "${patch_file}" --server-side
    # Trigger rolling restart to use new requests
    kubectl -n "${namespace}" rollout restart "deployment/${deployment}"
    kubectl -n "${namespace}" rollout status "deployment/${deployment}" \
      --timeout=300s
  else
    kubectl apply -f "${patch_file}" --dry-run=client
  fi

  echo "    Done: ${namespace}/${deployment}"
  sleep 5   # Stagger restarts to avoid simultaneous pod disruptions
done

echo "All patches applied."
```

### Validation After Applying Recommendations

After applying rightsizing patches, validate that the workloads remain healthy:

```bash
#!/usr/bin/env bash
# validate-rightsizing.sh
# Checks that all deployments in a namespace are healthy after rightsizing

NAMESPACE="${1:-production}"
SLEEP_SECONDS=300   # Wait 5 minutes before checking

echo "Waiting ${SLEEP_SECONDS}s for deployments to stabilize..."
sleep "${SLEEP_SECONDS}"

# Check for any OOMKilled containers
echo "==> Checking for OOMKilled events..."
kubectl -n "${NAMESPACE}" get events \
  --field-selector reason=OOMKilling \
  --sort-by='.lastTimestamp' \
  | tail -20

# Check all deployments are at desired replica count
echo "==> Checking deployment rollout status..."
kubectl -n "${NAMESPACE}" get deployments \
  -o custom-columns='NAME:.metadata.name,DESIRED:.spec.replicas,READY:.status.readyReplicas,AVAILABLE:.status.availableReplicas'

# Report CPU throttling (high throttle = requests still too low)
echo "==> Checking CPU throttle metrics..."
kubectl top pods -n "${NAMESPACE}" \
  | sort -k3 -hr \
  | head -20

echo "Validation complete. Review any OOMKill events or unavailable deployments above."
```

## Best Practices

### Data Maturity Before Acting

VPA recommendations improve significantly with more historical data. Wait at least **7 days** (and ideally 14–30 days) before acting on recommendations for workloads with weekly traffic patterns. For daily-cycle workloads, 3–5 days of data is usually sufficient.

### Start with Non-Critical Workloads

Apply recommendations to development and staging environments first. Validate application behavior before rolling changes to production. Use the VPA Upper Bound as the production limit to handle burst traffic safely.

### JVM and Memory-Pinned Workloads

JVM applications pre-allocate heap at startup. VPA observes the steady-state heap but not the peak GC overhead. For JVM containers, set the VPA recommendation as the `requests` value but keep limits manually tuned to `Xmx` + 20% headroom. Exclude these containers from automatic Goldilocks patches.

### Establish a Rightsizing Workflow

A sustainable rightsizing process should be lightweight enough to run continuously:

1. **Weekly export**: Run the recommendation export script every Monday.
2. **Automated PR**: Use the CI/CD workflow to open a PR with the exported patches.
3. **Team review**: Each team reviews patches for their namespaces and merges when satisfied.
4. **Staged rollout**: Apply to staging first, validate for 48 hours, then promote to production.
5. **Post-rollout check**: Run the validation script 5 minutes after applying patches.

### Review Recommendations on a Schedule

Workloads change over time. Integrate Goldilocks into a quarterly FinOps review cadence. Compare the current state against the last recommendation snapshot and open PRs for significant deviations (greater than 30% over or under).

### Combine with Namespace LimitRange

Setting a `LimitRange` in each namespace establishes a floor and ceiling for resource requests independent of Goldilocks. This prevents workloads that accidentally omit resource definitions from affecting node stability:

```yaml
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
        cpu: 50m
        memory: 128Mi
      max:
        cpu: "8"
        memory: 16Gi
      min:
        cpu: 10m
        memory: 32Mi
```

The Goldilocks recommendations respect LimitRange bounds — they will not suggest values outside the `min`/`max` range, making the LimitRange a useful guardrail for the recommendation system.

## Conclusion

Goldilocks provides a low-risk, high-value approach to Kubernetes resource rightsizing by combining VPA's statistical recommender with an accessible dashboard and exportable patches. Running VPA in `Off` mode keeps the operations team in control of when changes land, which is essential for regulated environments or production clusters where unexpected pod restarts are unacceptable. Combined with Kubecost cost allocation data, automated PR generation, and Prometheus alerting on recommendation drift, Goldilocks becomes a cornerstone of an ongoing FinOps practice for Kubernetes platform teams.
