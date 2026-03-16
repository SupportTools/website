---
title: "Kubernetes FinOps: Cost Optimization, Chargeback, and Resource Right-Sizing"
date: 2027-07-14T00:00:00-05:00
draft: false
tags: ["FinOps", "Kubernetes", "Cost Optimization", "Resource Management"]
categories:
- Kubernetes
- FinOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes FinOps covering cost visibility with Kubecost and OpenCost, namespace chargeback models, VPA-driven right-sizing, spot node strategies, and multi-cluster cost aggregation for enterprise teams."
more_link: "yes"
url: "/kubernetes-finops-cost-optimization-guide/"
---

Kubernetes cost management has matured from a nice-to-have discipline into a core engineering responsibility. As clusters grow to hundreds of nodes spanning multiple cloud regions, unconstrained workloads silently consume thousands of dollars per day in wasted compute. This guide covers the complete FinOps lifecycle for Kubernetes: instrumentation, allocation, right-sizing, architectural changes, and the organizational processes that make cost discipline stick.

<!--more-->

# Kubernetes FinOps: Cost Optimization, Chargeback, and Resource Right-Sizing

## Section 1: Understanding Kubernetes Cost Structure

Kubernetes cost is not simply the sum of VM prices. The total cost of ownership includes node compute, persistent storage, network egress between availability zones, load balancer hours, and management plane fees charged by managed Kubernetes services (EKS, GKE, AKS). Each of these line items requires separate instrumentation.

### The Cost Attribution Problem

Kubernetes workloads from dozens of teams share the same node pools. Without deliberate attribution, platform teams can only report aggregate cluster spend — not which namespace, team, or application is responsible for a given cost spike.

The three levels of cost attribution are:

- **Node-level**: Raw cloud billing, easily obtained from the provider API
- **Namespace-level**: Proportional allocation of node cost based on requests or usage
- **Workload-level**: Per-Deployment or per-Job allocation, required for true chargeback

Tools in this space — Kubecost, OpenCost, and cloud-native cost explorers — differ primarily in how they perform the proportional allocation calculation and how far down the workload hierarchy they can attribute.

### Cost Components by Category

| Component | Typical Share | Optimization Lever |
|---|---|---|
| Compute (nodes) | 60–75% | Right-sizing, spot nodes |
| Persistent storage | 10–20% | Volume right-sizing, storage class tiering |
| Network egress | 5–15% | Topology-aware routing, CDN offload |
| Load balancers | 2–8% | Shared ingress controllers |
| Management plane | 1–5% | Cluster consolidation |

---

## Section 2: Cost Visibility with OpenCost and Kubecost

### OpenCost: The Open Standard

OpenCost is a CNCF project that provides a vendor-neutral cost allocation model. It scrapes cloud billing APIs and node metadata to compute per-workload cost in real time.

**Install OpenCost with Prometheus integration:**

```bash
helm repo add opencost https://opencost.github.io/opencost-helm-chart
helm repo update

helm install opencost opencost/opencost \
  --namespace opencost \
  --create-namespace \
  --set opencost.exporter.cloudProviderApiKey="" \
  --set opencost.prometheus.internal.enabled=false \
  --set opencost.prometheus.external.enabled=true \
  --set opencost.prometheus.external.url="http://prometheus-operated.monitoring.svc.cluster.local:9090"
```

**OpenCost Helm values for AWS with spot support:**

```yaml
# opencost-values.yaml
opencost:
  exporter:
    cloudProvider: "aws"
    aws:
      spotDataEnabled: true
      spotDataBucket: "my-org-spot-data-feed"
      spotDataRegion: "us-east-1"
      awsSpotDataPrefix: "spot-feed"
    defaultClusterId: "prod-us-east-1"
  ui:
    enabled: true
  prometheus:
    external:
      enabled: true
      url: "http://prometheus-operated.monitoring.svc.cluster.local:9090"
```

**Query OpenCost API for namespace costs:**

```bash
# Cost breakdown by namespace for the last 7 days
curl -s "http://opencost.opencost.svc.cluster.local:9003/allocation/compute?window=7d&aggregate=namespace&accumulate=false" \
  | jq '.data[] | {namespace: .name, totalCost: .totalCost, cpuCost: .cpuCost, ramCost: .ramCost}'
```

**Example output:**
```json
{
  "namespace": "payments",
  "totalCost": 847.32,
  "cpuCost": 612.18,
  "ramCost": 235.14
}
```

### Kubecost: Enterprise Cost Management

Kubecost extends OpenCost with richer features including savings recommendations, anomaly alerts, and business unit reporting. The free tier covers single clusters; the enterprise tier adds multi-cluster aggregation.

```bash
helm repo add kubecost https://kubecost.github.io/cost-analyzer
helm install kubecost kubecost/cost-analyzer \
  --namespace kubecost \
  --create-namespace \
  --set kubecostToken="KUBECOST_TOKEN_REPLACE_ME" \
  --set global.prometheus.enabled=false \
  --set global.prometheus.fqdn="http://prometheus-operated.monitoring.svc.cluster.local:9090"
```

**Kubecost cost allocation API:**

```bash
# Cost by label (team label on namespaces)
curl "http://kubecost.kubecost.svc.cluster.local:9090/model/allocation?window=30d&aggregate=label:team&accumulate=true" \
  | jq '.data[0] | to_entries[] | {team: .key, cost: .value.totalCost}'
```

### Prometheus Recording Rules for Cost Metrics

Storing pre-aggregated cost metrics in Prometheus enables cost dashboards without hitting the OpenCost API on every query.

```yaml
# prometheus-cost-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kubecost-recording-rules
  namespace: monitoring
spec:
  groups:
    - name: cost.namespace
      interval: 5m
      rules:
        - record: namespace:cost_per_hour:sum
          expr: |
            sum by (namespace) (
              label_replace(
                kube_pod_container_resource_requests{resource="cpu", unit="core"}
                * on(node) group_left()
                node_cpu_hourly_cost,
                "namespace", "$1", "namespace", "(.*)"
              )
            )
        - record: namespace:memory_cost_per_hour:sum
          expr: |
            sum by (namespace) (
              kube_pod_container_resource_requests{resource="memory", unit="byte"}
              / 1073741824
              * on(node) group_left()
              node_ram_hourly_cost
            )
```

---

## Section 3: Chargeback vs. Showback Models

### Showback: Visibility Without Billing

Showback reports what each team would be charged but does not actually transfer funds. This model is suitable for organizations building cost awareness culture before enforcing financial accountability.

A showback report is generated by querying OpenCost and rendering a Markdown or HTML table:

```python
#!/usr/bin/env python3
"""Generate weekly showback report from OpenCost API."""
import json
import requests
from datetime import datetime

OPENCOST_URL = "http://opencost.opencost.svc.cluster.local:9003"

def get_namespace_costs(window="7d"):
    resp = requests.get(
        f"{OPENCOST_URL}/allocation/compute",
        params={"window": window, "aggregate": "namespace", "accumulate": "true"}
    )
    resp.raise_for_status()
    return resp.json()["data"][0]

def render_showback_table(costs):
    rows = []
    for ns, data in sorted(costs.items(), key=lambda x: x[1]["totalCost"], reverse=True):
        rows.append(
            f"| {ns:<40} | ${data['totalCost']:>10.2f} | "
            f"${data['cpuCost']:>10.2f} | ${data['ramCost']:>9.2f} |"
        )
    header = (
        "| Namespace                                | Total Cost   | CPU Cost     | RAM Cost   |\n"
        "|------------------------------------------|-------------|-------------|------------|\n"
    )
    return header + "\n".join(rows)

if __name__ == "__main__":
    costs = get_namespace_costs()
    print(f"# Weekly Cost Report — {datetime.utcnow().strftime('%Y-%m-%d')}\n")
    print(render_showback_table(costs))
```

### Chargeback: Financial Accountability

Chargeback transfers actual cost responsibility to the owning team or business unit. Implementation requires:

1. **Label standards**: Every namespace must carry a `team`, `cost-center`, and `environment` label.
2. **Cost allocation policy**: Define whether unused reservations are distributed proportionally or absorbed by the platform team.
3. **Integration with finance systems**: Cost data flows to ERP or internal billing via API or CSV export.

**Namespace label enforcement with Kyverno:**

```yaml
# enforce-namespace-cost-labels.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-namespace-cost-labels
spec:
  validationFailureAction: Enforce
  rules:
    - name: check-cost-labels
      match:
        any:
          - resources:
              kinds:
                - Namespace
      validate:
        message: "Namespace must have labels: team, cost-center, environment"
        pattern:
          metadata:
            labels:
              team: "?*"
              cost-center: "?*"
              environment: "?*"
```

**Allocating shared costs:**

Shared infrastructure (CoreDNS, kube-proxy, monitoring stack) needs to be distributed. Two common strategies:

- **Proportional allocation**: Shared cost is split in proportion to each namespace's direct spend.
- **Equal split**: Shared cost divided equally across all namespaces.

```bash
# Example: proportional shared cost allocation
TOTAL_SHARED=500.00  # USD, shared infra monthly cost
NAMESPACE_COSTS=$(curl -s "http://opencost.opencost.svc.cluster.local:9003/allocation/compute?window=30d&aggregate=namespace&accumulate=true" \
  | jq -r '.data[0] | to_entries[] | [.key, (.value.totalCost | tostring)] | @tsv')

TOTAL_DIRECT=$(echo "$NAMESPACE_COSTS" | awk '{sum += $2} END {print sum}')

while IFS=$'\t' read -r ns cost; do
  share=$(echo "scale=4; $cost / $TOTAL_DIRECT * $TOTAL_SHARED" | bc)
  echo "$ns: allocated shared cost = \$$share"
done <<< "$NAMESPACE_COSTS"
```

---

## Section 4: Resource Right-Sizing with VPA

### Why Over-Provisioning Happens

Developers set resource requests conservatively high at deployment time. Without feedback loops, those requests never decrease. A service that peaks at 200m CPU may run with a 1000m request for months, reserving five times the capacity it needs.

### Vertical Pod Autoscaler in Recommendation Mode

Running VPA in `Off` mode generates recommendations without applying them — safe for production.

```yaml
# vpa-recommendation-only.yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: payment-api-vpa
  namespace: payments
spec:
  targetRef:
    apiVersion: "apps/v1"
    kind: Deployment
    name: payment-api
  updatePolicy:
    updateMode: "Off"
  resourcePolicy:
    containerPolicies:
      - containerName: payment-api
        minAllowed:
          cpu: 50m
          memory: 64Mi
        maxAllowed:
          cpu: 4000m
          memory: 8Gi
        controlledResources:
          - cpu
          - memory
```

**Read VPA recommendations:**

```bash
kubectl get vpa payment-api-vpa -n payments -o json | jq '
  .status.recommendation.containerRecommendations[] |
  {
    container: .containerName,
    target_cpu: .target.cpu,
    target_memory: .target.memory,
    lower_cpu: .lowerBound.cpu,
    upper_cpu: .upperBound.cpu
  }'
```

**Bulk VPA recommendation report:**

```bash
#!/bin/bash
# List all VPA recommendations across namespaces
echo "NAMESPACE | DEPLOYMENT | CONTAINER | CURRENT_CPU | REC_CPU | CURRENT_MEM | REC_MEM"
echo "---------|-----------|---------|------------|--------|------------|--------"

kubectl get vpa --all-namespaces -o json | jq -r '
  .items[] |
  .metadata.namespace as $ns |
  .metadata.name as $name |
  .status.recommendation.containerRecommendations[]? |
  [$ns, $name, .containerName, "N/A", .target.cpu, "N/A", .target.memory] |
  @tsv' | column -t -s $'\t'
```

### Applying VPA Recommendations Safely

For non-critical workloads, VPA can be set to `Auto` mode with controlled bounds:

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: worker-vpa
  namespace: batch
spec:
  targetRef:
    apiVersion: "apps/v1"
    kind: Deployment
    name: batch-worker
  updatePolicy:
    updateMode: "Auto"
    minReplicas: 2
  resourcePolicy:
    containerPolicies:
      - containerName: batch-worker
        minAllowed:
          cpu: 100m
          memory: 128Mi
        maxAllowed:
          cpu: 2000m
          memory: 4Gi
```

### Right-Sizing Workflow

```
1. Deploy VPA in Off mode for 2 weeks (collects baseline metrics)
2. Export recommendations to spreadsheet for team review
3. Update Deployment resource requests to match VPA target values
4. Monitor for performance regressions (HPA history, error rates)
5. Optionally switch to VPA Auto mode with guarded bounds
```

---

## Section 5: Idle Capacity Elimination

### Identifying Idle Workloads

Idle workloads request resources but process no meaningful traffic. Common causes include staging deployments left running permanently, feature branches never cleaned up, and cron jobs with excessive replicas.

**Prometheus query for idle CPU:**

```promql
# Workloads where CPU usage is less than 5% of request for the past 24 hours
(
  sum by (namespace, pod, container) (
    rate(container_cpu_usage_seconds_total{container!=""}[24h])
  )
  /
  sum by (namespace, pod, container) (
    kube_pod_container_resource_requests{resource="cpu"}
  )
) < 0.05
```

**Grafana dashboard panel query for idle namespace report:**

```promql
# Namespaces with average CPU utilization below 10% of request
sum by (namespace) (
  rate(container_cpu_usage_seconds_total{container!="", namespace!~"kube-.*|monitoring"}[1h])
)
/
sum by (namespace) (
  kube_pod_container_resource_requests{resource="cpu", namespace!~"kube-.*|monitoring"}
)
```

### Automated Namespace Hibernation

For non-production environments, scale down deployments during off-hours using a CronJob:

```yaml
# namespace-hibernator-cronjob.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: scale-down-staging
  namespace: platform-ops
spec:
  schedule: "0 20 * * 1-5"  # Weekdays at 8 PM
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: namespace-hibernator
          containers:
            - name: kubectl
              image: bitnami/kubectl:1.29
              command:
                - /bin/sh
                - -c
                - |
                  for ns in staging qa dev; do
                    echo "Scaling down namespace: $ns"
                    kubectl scale deployment --all -n "$ns" --replicas=0
                    kubectl annotate namespace "$ns" \
                      hibernation.ops/scaled-down-at="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
                      --overwrite
                  done
          restartPolicy: OnFailure
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: scale-up-staging
  namespace: platform-ops
spec:
  schedule: "0 8 * * 1-5"  # Weekdays at 8 AM
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: namespace-hibernator
          containers:
            - name: kubectl
              image: bitnami/kubectl:1.29
              command:
                - /bin/sh
                - -c
                - |
                  for ns in staging qa dev; do
                    echo "Scaling up namespace: $ns"
                    kubectl scale deployment --all -n "$ns" --replicas=1
                    kubectl annotate namespace "$ns" \
                      hibernation.ops/scaled-up-at="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
                      --overwrite
                  done
          restartPolicy: OnFailure
```

**RBAC for the hibernator service account:**

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: namespace-hibernator
  namespace: platform-ops
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: deployment-scaler
rules:
  - apiGroups: ["apps"]
    resources: ["deployments", "statefulsets"]
    verbs: ["get", "list", "patch", "update"]
  - apiGroups: [""]
    resources: ["namespaces"]
    verbs: ["get", "list", "patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: namespace-hibernator-binding
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: deployment-scaler
subjects:
  - kind: ServiceAccount
    name: namespace-hibernator
    namespace: platform-ops
```

---

## Section 6: Spot and Preemptible Node Strategies

### Node Pool Architecture with Mixed Instances

A cost-optimized node pool strategy combines:

- **On-demand nodes**: For stateful workloads, PodDisruptionBudget-constrained deployments, and system components
- **Spot nodes**: For stateless, interruption-tolerant workloads (batch jobs, CI runners, ML training)
- **Reserved instances**: For predictable baseline capacity with 1–3 year commitments

**GKE spot node pool configuration (Terraform):**

```hcl
resource "google_container_node_pool" "spot_workers" {
  name       = "spot-workers"
  cluster    = google_container_cluster.primary.name
  location   = var.region
  node_count = 0

  autoscaling {
    min_node_count  = 0
    max_node_count  = 50
    location_policy = "BALANCED"
  }

  node_config {
    machine_type = "n2d-standard-8"
    spot         = true
    disk_size_gb = 100
    disk_type    = "pd-ssd"

    labels = {
      "cloud.google.com/gke-spot" = "true"
      node-pool = "spot-workers"
    }

    taint {
      key    = "cloud.google.com/gke-spot"
      value  = "true"
      effect = "NO_SCHEDULE"
    }

    oauth_scopes = [
      "https://www.googleapis.com/auth/cloud-platform"
    ]
  }
}
```

**AWS Karpenter NodePool for spot diversification:**

```yaml
# karpenter-spot-nodepool.yaml
apiVersion: karpenter.sh/v1beta1
kind: NodePool
metadata:
  name: spot-diversified
spec:
  template:
    metadata:
      labels:
        node-pool: spot-diversified
    spec:
      taints:
        - key: spot
          value: "true"
          effect: NoSchedule
      nodeClassRef:
        name: default
      requirements:
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["spot"]
        - key: kubernetes.io/arch
          operator: In
          values: ["amd64"]
        - key: karpenter.k8s.aws/instance-family
          operator: In
          values: ["m5", "m5a", "m5d", "m5n", "m6i", "m6a", "m7i"]
        - key: karpenter.k8s.aws/instance-cpu
          operator: In
          values: ["4", "8", "16"]
  disruption:
    consolidationPolicy: WhenUnderutilized
    consolidateAfter: 30s
  limits:
    cpu: 1000
    memory: 4000Gi
```

### Workload Tolerations for Spot Nodes

```yaml
# Deployment spec for spot-tolerant workload
spec:
  template:
    spec:
      tolerations:
        - key: "spot"
          operator: "Equal"
          value: "true"
          effect: "NoSchedule"
        - key: "cloud.google.com/gke-spot"
          operator: "Equal"
          value: "true"
          effect: "NoSchedule"
      affinity:
        nodeAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 80
              preference:
                matchExpressions:
                  - key: node-pool
                    operator: In
                    values: ["spot-diversified"]
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  app: payment-api
              topologyKey: kubernetes.io/hostname
```

### Graceful Spot Interruption Handling

AWS Node Termination Handler ensures pods are gracefully evicted before a spot instance is reclaimed:

```bash
helm repo add eks https://aws.github.io/eks-charts
helm install aws-node-termination-handler eks/aws-node-termination-handler \
  --namespace kube-system \
  --set enableSpotInterruptionDraining=true \
  --set enableScheduledEventDraining=true \
  --set enableRebalanceMonitoring=true \
  --set enableRebalanceDraining=true \
  --set nodeTerminationGracePeriod=120
```

---

## Section 7: Pod Disruption Budgets for Cost-Efficient Scaling

PodDisruptionBudgets (PDBs) protect availability during node consolidation and voluntary disruptions like spot reclamation. Without PDBs, Karpenter or the cluster autoscaler may evict too many pods simultaneously.

### PDB Design Patterns

```yaml
# Minimum available — suitable for stateless services
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-pdb
  namespace: production
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: api-server

---
# Max unavailable — suitable for large deployments
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: worker-pdb
  namespace: production
spec:
  maxUnavailable: "25%"
  selector:
    matchLabels:
      app: batch-worker
```

**Audit PDB coverage across namespaces:**

```bash
#!/bin/bash
# Find deployments without PDB coverage
echo "Deployments without PDB:"
for ns in $(kubectl get ns -o jsonpath='{.items[*].metadata.name}'); do
  deployments=$(kubectl get deploy -n "$ns" -o jsonpath='{.items[*].metadata.name}' 2>/dev/null)
  for deploy in $deployments; do
    labels=$(kubectl get deploy "$deploy" -n "$ns" \
      -o jsonpath='{.spec.selector.matchLabels}' 2>/dev/null)
    pdb_count=$(kubectl get pdb -n "$ns" 2>/dev/null | grep -c "$deploy" || true)
    if [ "$pdb_count" -eq 0 ]; then
      echo "  $ns/$deploy — no PDB"
    fi
  done
done
```

---

## Section 8: Reserved Capacity Planning

### Commitment Analysis

Reserved instances (AWS) and committed use discounts (GCP) deliver 30–60% savings over on-demand for stable baseline capacity. The analysis workflow:

1. Extract 90-day node utilization data
2. Identify the stable floor (P10 of daily node count)
3. Model 1-year vs. 3-year reservation ROI
4. Purchase reservations for baseline; use spot for burst

```python
#!/usr/bin/env python3
"""Reserved instance recommendation from Prometheus node metrics."""
import requests
from datetime import datetime, timedelta

PROMETHEUS_URL = "http://prometheus-operated.monitoring.svc.cluster.local:9090"

def query_range(promql, start, end, step="1h"):
    resp = requests.get(
        f"{PROMETHEUS_URL}/api/v1/query_range",
        params={"query": promql, "start": start, "end": end, "step": step}
    )
    resp.raise_for_status()
    return resp.json()["data"]["result"]

def recommend_reservations():
    end = datetime.utcnow()
    start = end - timedelta(days=90)

    # Daily node count by instance type
    results = query_range(
        'count by (label_beta_kubernetes_io_instance_type) (kube_node_labels)',
        start.isoformat() + "Z",
        end.isoformat() + "Z",
        step="1d"
    )

    for series in results:
        instance_type = series["metric"].get(
            "label_beta_kubernetes_io_instance_type", "unknown"
        )
        counts = [float(v[1]) for v in series["values"]]
        p10 = sorted(counts)[len(counts) // 10]
        avg = sum(counts) / len(counts)
        print(
            f"{instance_type}: avg={avg:.1f} nodes, "
            f"P10={p10:.1f} nodes — recommend {int(p10)} reserved"
        )

if __name__ == "__main__":
    recommend_reservations()
```

---

## Section 9: Cost Anomaly Detection

### Anomaly Detection with Prometheus Alertmanager

```yaml
# cost-anomaly-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: cost-anomaly-detection
  namespace: monitoring
spec:
  groups:
    - name: cost.anomalies
      rules:
        - alert: NamespaceCostSpike
          expr: |
            (
              sum by (namespace) (namespace:cost_per_hour:sum)
              /
              sum by (namespace) (
                avg_over_time(namespace:cost_per_hour:sum[7d] offset 1h)
              )
            ) > 2.0
          for: 30m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "Cost spike in namespace {{ $labels.namespace }}"
            description: >
              Namespace {{ $labels.namespace }} is spending
              {{ $value | humanize }}x its 7-day average.
              Investigate new deployments or resource limit removals.

        - alert: UnexpectedNodeScaleOut
          expr: |
            increase(kube_node_status_condition{condition="Ready",status="true"}[30m]) > 5
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Rapid node scale-out detected"
            description: "More than 5 nodes added in 30 minutes — verify autoscaler activity."
```

### Daily Cost Digest with Slack Notification

```bash
#!/bin/bash
# daily-cost-digest.sh — runs as a CronJob
set -euo pipefail

OPENCOST_URL="http://opencost.opencost.svc.cluster.local:9003"
SLACK_WEBHOOK="${SLACK_WEBHOOK_URL}"  # injected from Secret

# Get yesterday's cost by namespace
COSTS=$(curl -sf "${OPENCOST_URL}/allocation/compute?window=1d&aggregate=namespace&accumulate=true" \
  | jq -r '.data[0] | to_entries | sort_by(-.value.totalCost) | .[0:10] |
    .[] | "• \(.key): $\(.value.totalCost | . * 100 | round / 100)"')

TOTAL=$(curl -sf "${OPENCOST_URL}/allocation/compute?window=1d&aggregate=cluster&accumulate=true" \
  | jq -r '.data[0] | to_entries[0].value.totalCost | . * 100 | round / 100')

PAYLOAD=$(jq -n \
  --arg costs "$COSTS" \
  --arg total "$TOTAL" \
  --arg date "$(date -u +%Y-%m-%d)" \
  '{
    text: "*Kubernetes Daily Cost Report — \($date)*\n*Cluster Total: $\($total)*\n\nTop Namespaces:\n\($costs)"
  }')

curl -sf -X POST -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  "$SLACK_WEBHOOK"
```

**Secret for webhook URL:**

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: cost-digest-secrets
  namespace: platform-ops
type: Opaque
stringData:
  SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/TXXXXXXXXX/BXXXXXXXXX/REPLACE_WITH_YOUR_WEBHOOK_TOKEN"
```

---

## Section 10: Multi-Cluster Cost Aggregation

### Kubecost Enterprise Federation

Kubecost Enterprise supports a federated model where each cluster runs a lightweight agent, and a central aggregator consolidates data.

**Central aggregator Helm values:**

```yaml
# kubecost-aggregator-values.yaml
federatedETL:
  enabled: true
  federatedStorageConfigSecret: federated-storage-config
  agentMode: false

global:
  prometheus:
    enabled: false
    fqdn: "http://prometheus-operated.monitoring.svc.cluster.local:9090"

kubecostAggregator:
  enabled: true
  replicaCount: 2
  resources:
    requests:
      cpu: 500m
      memory: 1Gi
    limits:
      cpu: 2000m
      memory: 4Gi
```

**Per-cluster agent Helm values:**

```yaml
# kubecost-agent-values.yaml
federatedETL:
  enabled: true
  agentMode: true
  federatedStorageConfigSecret: federated-storage-config
  clusterId: "prod-eu-west-1"
  clusterName: "EU Production"
```

**Federated storage config secret (S3):**

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: federated-storage-config
  namespace: kubecost
type: Opaque
stringData:
  federated-store.yaml: |
    type: S3
    config:
      bucket: my-org-kubecost-federated
      endpoint: s3.amazonaws.com
      region: us-east-1
      insecure: false
      signature_version2: false
      put_user_metadata: {}
      http_config:
        idle_conn_timeout: 90s
        response_header_timeout: 2m
        insecure_skip_verify: false
      trace:
        enable: false
      part_size: 134217728
      sse_config:
        type: ""
```

### OpenCost Multi-Cluster with Thanos

For multi-cluster cost queries using OpenCost + Thanos:

```yaml
# thanos-query-cost-values.yaml
query:
  stores:
    - dnssrv+_grpc._tcp.thanos-store-shard-0.thanos.svc.cluster.local
    - dnssrv+_grpc._tcp.thanos-store-shard-1.thanos.svc.cluster.local
  replicaLabels:
    - prometheus_replica
  extraFlags:
    - --query.partial-response
```

```promql
# Cross-cluster cost query via Thanos
sum by (cluster, namespace) (
  label_replace(
    namespace:cost_per_hour:sum,
    "cluster", "$1", "cluster_id", "(.*)"
  )
)
```

---

## Section 11: FinOps Governance and Process

### Cost Review Cadence

| Cadence | Audience | Scope |
|---|---|---|
| Daily | Platform team | Anomaly alerts, overnight batch costs |
| Weekly | Engineering leads | Per-namespace trends, VPA recommendations |
| Monthly | Engineering VPs | Chargeback reports, reserved capacity review |
| Quarterly | Finance + Eng | Commitment renewals, architecture cost trade-offs |

### Cost Efficiency KPIs

Track these metrics as engineering OKR inputs:

```promql
# CPU efficiency ratio (actual usage / requested)
sum(rate(container_cpu_usage_seconds_total{container!=""}[1h]))
/
sum(kube_pod_container_resource_requests{resource="cpu"})

# Memory efficiency ratio
sum(container_memory_working_set_bytes{container!=""})
/
sum(kube_pod_container_resource_requests{resource="memory"})

# Node utilization (pods scheduled vs. node capacity)
sum(kube_pod_container_resource_requests{resource="cpu"})
/
sum(kube_node_status_allocatable{resource="cpu"})
```

A healthy cluster targets CPU efficiency above 60% and memory efficiency above 70%. Values below 40% indicate significant over-provisioning.

### Optimization Roadmap Template

```
Phase 1 — Visibility (Weeks 1–4)
  [ ] Deploy OpenCost in all clusters
  [ ] Enforce namespace cost labels via Kyverno
  [ ] Build Grafana cost dashboard
  [ ] Send weekly showback reports to engineering leads

Phase 2 — Right-Sizing (Weeks 5–10)
  [ ] Deploy VPA in Off mode cluster-wide
  [ ] Review VPA recommendations in weekly meetings
  [ ] Apply recommendations to dev/staging environments
  [ ] Roll out to production incrementally

Phase 3 — Architecture Changes (Weeks 11–20)
  [ ] Identify spot-eligible workloads
  [ ] Configure Karpenter with spot node pools
  [ ] Implement namespace hibernation for non-prod
  [ ] Begin reserved instance analysis

Phase 4 — Chargeback (Weeks 21–30)
  [ ] Define cost allocation policy with finance
  [ ] Integrate OpenCost API with internal billing
  [ ] Automate monthly chargeback reports
  [ ] Track cost-per-feature for new development
```

---

## Summary

Kubernetes FinOps is a layered practice. The foundation is visibility: deploying OpenCost or Kubecost and establishing label standards that make attribution possible. On top of that, right-sizing with VPA recommendations and idle capacity elimination deliver quick wins — typically 20–40% cost reduction. The larger structural savings come from spot node strategies and reserved capacity commitments. Chargeback models close the loop by creating financial accountability at the team level, ensuring that the organization's cost discipline becomes self-sustaining.

The tools and configurations in this guide are production-tested. Start with visibility, measure continuously, and apply changes incrementally with PodDisruptionBudgets protecting availability throughout.
