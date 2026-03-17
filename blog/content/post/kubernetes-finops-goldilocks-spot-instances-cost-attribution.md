---
title: "Kubernetes FinOps: Rightsizing with Goldilocks, Spot Instance Handling, and Cost Attribution"
date: 2030-02-09T00:00:00-05:00
draft: false
tags: ["Kubernetes", "FinOps", "Goldilocks", "Spot Instances", "Cost Optimization", "VPA", "Cost Attribution", "Chargeback"]
categories: ["Kubernetes", "FinOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise Kubernetes cost optimization covering VPA-based rightsizing with Goldilocks UI, spot instance node groups with interruption handling, namespace-level cost attribution, and automated chargeback reporting."
more_link: "yes"
url: "/kubernetes-finops-goldilocks-spot-instances-cost-attribution/"
---

Kubernetes clusters at enterprise scale routinely waste 40-70% of provisioned compute capacity due to over-provisioned resource requests. Over-provisioning is rational behavior in the absence of good tooling — engineers set high CPU and memory limits to avoid on-call pages from OOMKilled pods, and those requests determine what node capacity the scheduler consumes. The result is expensive clusters running at 25% actual utilization.

This guide addresses Kubernetes cost optimization systematically: rightsizing workloads using VPA recommendations surfaced through Goldilocks, running batch and stateless workloads on spot instances with proper interruption handling, and implementing namespace-level cost attribution so teams see what they are actually spending.

<!--more-->

## The FinOps Framework Applied to Kubernetes

FinOps is the practice of bringing financial accountability to cloud spending. For Kubernetes, this means three capabilities:

1. **Visibility**: Know what each namespace, team, and workload is costing
2. **Optimization**: Identify and eliminate waste through rightsizing, spot usage, and idle resource removal
3. **Governance**: Enforce spending limits through quotas, alerts, and chargeback mechanisms

These capabilities must work together. Visibility without optimization tools generates reports nobody acts on. Optimization without governance reverts as teams add buffer back to their requests.

## Installing Goldilocks for VPA-Based Rightsizing

Goldilocks wraps the Kubernetes Vertical Pod Autoscaler (VPA) in a UI that shows recommended CPU and memory settings for every workload. It does not apply the recommendations automatically — it surfaces them for human review.

### Installing VPA

```bash
# Clone the VPA repository
git clone https://github.com/kubernetes/autoscaler.git
cd autoscaler/vertical-pod-autoscaler

# Install VPA components
./hack/vpa-install.sh

# Verify installation
kubectl get pods -n kube-system | grep vpa
# vpa-admission-controller-xxx  1/1  Running  0  1m
# vpa-recommender-xxx           1/1  Running  0  1m
# vpa-updater-xxx               1/1  Running  0  1m

# Configure VPA recommender with extended history
kubectl patch deployment vpa-recommender \
  -n kube-system \
  --type=json \
  -p='[{"op": "add", "path": "/spec/template/spec/containers/0/args/-", "value": "--recommendation-margin-fraction=0.15"},
       {"op": "add", "path": "/spec/template/spec/containers/0/args/-", "value": "--pod-recommendation-min-cpu-millicores=25"},
       {"op": "add", "path": "/spec/template/spec/containers/0/args/-", "value": "--pod-recommendation-min-memory-mb=32"}]'
```

### Installing Goldilocks

```bash
# Add Fairwinds helm repo
helm repo add fairwinds-stable https://charts.fairwinds.com/stable
helm repo update

# Install Goldilocks
helm install goldilocks fairwinds-stable/goldilocks \
  --namespace goldilocks \
  --create-namespace \
  --set dashboard.enabled=true \
  --set dashboard.service.type=ClusterIP \
  --set vpa.enabled=true \
  --set vpa.updater.enabled=false \
  --set controller.flags.on-by-default=false

# Verify installation
kubectl get pods -n goldilocks
# goldilocks-controller-xxx  1/1  Running
# goldilocks-dashboard-xxx   1/1  Running
```

### Enabling Goldilocks per Namespace

```bash
# Enable Goldilocks for a namespace (creates VPA objects for all deployments)
kubectl label namespace production goldilocks.fairwinds.com/enabled=true
kubectl label namespace staging goldilocks.fairwinds.com/enabled=true
kubectl label namespace data-processing goldilocks.fairwinds.com/enabled=true

# Exclude specific deployments from VPA analysis
kubectl annotate deployment payment-service \
  -n production \
  goldilocks.fairwinds.com/vpa-update-mode=off

# Access the Goldilocks dashboard via port-forward
kubectl port-forward -n goldilocks svc/goldilocks-dashboard 8080:80
# Open http://localhost:8080
```

### Reading Goldilocks Recommendations

The dashboard shows VPA recommendations in three categories:

- **Guaranteed**: Request = Limit. Highest priority scheduling, no burstability.
- **Burstable**: Request < Limit. Normal for most workloads.
- **Best Effort**: No requests or limits (not recommended for production).

For each workload, Goldilocks shows the VPA-recommended request and limit based on observed usage. The recommendations use percentile-based analysis: P95 for CPU requests, P95 for memory requests with headroom added.

```bash
# View raw VPA recommendation objects
kubectl get vpa -n production
kubectl describe vpa web-api-vpa -n production

# Example output:
# Status:
#   Recommendation:
#     Container Recommendations:
#       Container Name:  web-api
#       Lower Bound:
#         Cpu:     25m
#         Memory:  64Mi
#       Target:
#         Cpu:     150m
#         Memory:  256Mi
#       Uncapped Target:
#         Cpu:     150m
#         Memory:  256Mi
#       Upper Bound:
#         Cpu:     1100m
#         Memory:  1500Mi
```

### Automated Recommendation Application with Slack Notification

```bash
#!/bin/bash
# /usr/local/bin/apply-vpa-recommendations.sh
# Run weekly to surface rightsizing opportunities

set -euo pipefail

NAMESPACE="${1:-production}"
THRESHOLD_CPU=50   # Alert if current > 2x recommended
THRESHOLD_MEM=50   # Alert if current > 2x recommended

echo "Analyzing VPA recommendations for namespace: ${NAMESPACE}"

kubectl get vpa -n "${NAMESPACE}" -o json | python3 - << 'PYTHON'
import json, sys

data = json.load(sys.stdin)
recommendations = []

for vpa in data.get('items', []):
    name = vpa['metadata']['name']
    recs = vpa.get('status', {}).get('recommendation', {}).get('containerRecommendations', [])

    for rec in recs:
        container = rec['containerName']
        target_cpu = rec.get('target', {}).get('cpu', 'N/A')
        target_mem = rec.get('target', {}).get('memory', 'N/A')

        recommendations.append({
            'deployment': name.replace('-vpa', ''),
            'container': container,
            'recommended_cpu': target_cpu,
            'recommended_memory': target_mem,
        })

print("Deployment | Container | Recommended CPU | Recommended Memory")
print("-" * 80)
for r in sorted(recommendations, key=lambda x: x['deployment']):
    print(f"{r['deployment']:<30} {r['container']:<20} {r['recommended_cpu']:<15} {r['recommended_memory']}")
PYTHON
```

## Spot Instance Node Groups

Spot instances (AWS), Preemptible VMs (GCP), and Spot VMs (Azure) offer 70-90% discounts over on-demand pricing. The tradeoff is that cloud providers can reclaim these instances with 2-minute notice. Proper handling of spot interruptions is essential for production use.

### AWS EKS Spot Node Group Configuration

```yaml
# eksctl-spot-nodegroup.yaml
apiVersion: eksctl.io/v1alpha5
kind: ClusterConfig
metadata:
  name: production
  region: us-east-1

managedNodeGroups:
  # On-demand nodes for critical system workloads
  - name: system-ondemand
    instanceType: m6i.xlarge
    minSize: 3
    maxSize: 5
    desiredCapacity: 3
    labels:
      node-type: on-demand
      workload-class: system
    taints:
      - key: CriticalAddonsOnly
        value: "true"
        effect: NoSchedule

  # Spot nodes for stateless application workloads
  - name: app-spot
    instanceTypes:
      - m6i.2xlarge
      - m6a.2xlarge
      - m5.2xlarge
      - m5a.2xlarge
      - m5n.2xlarge
      - c6i.4xlarge
      - c6a.4xlarge
    spot: true
    minSize: 0
    maxSize: 100
    desiredCapacity: 10
    labels:
      node-type: spot
      workload-class: app
    taints:
      - key: spot-instance
        value: "true"
        effect: NoSchedule
    tags:
      k8s.io/cluster-autoscaler/enabled: "true"
      k8s.io/cluster-autoscaler/production: "owned"

  # Spot nodes for batch workloads (highest interruption tolerance)
  - name: batch-spot
    instanceTypes:
      - r6i.2xlarge
      - r6a.2xlarge
      - r5.2xlarge
      - r5a.2xlarge
      - r5n.2xlarge
    spot: true
    minSize: 0
    maxSize: 200
    desiredCapacity: 0
    labels:
      node-type: spot
      workload-class: batch
    taints:
      - key: batch-workload
        value: "true"
        effect: NoSchedule
```

### Node Termination Handler

The AWS Node Termination Handler (NTH) watches for spot interruption notices and gracefully evicts pods before the instance is terminated:

```bash
# Install AWS Node Termination Handler
helm repo add eks https://aws.github.io/eks-charts
helm repo update

helm install aws-node-termination-handler eks/aws-node-termination-handler \
  --namespace kube-system \
  --set enableSpotInterruptionDraining=true \
  --set enableScheduledEventDraining=true \
  --set enableRebalanceMonitoring=true \
  --set enableRebalanceDraining=true \
  --set nodeSelector."node-type"=spot \
  --set podTerminationGracePeriod=120 \
  --set nodeTerminationGracePeriod=180 \
  --set emitKubernetesEvents=true \
  --set webhookURL="https://hooks.slack.com/services/<WORKSPACE_ID>/<CHANNEL_ID>/<WEBHOOK_TOKEN>" \
  --set webhookTemplate='{"text":"Spot interruption: Node {{ .InstanceID }} will be terminated in 2 minutes. Pods being evicted: {{ .Pods }}"}'
```

### Workload Configuration for Spot Tolerances

```yaml
# spot-tolerant-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-api
  namespace: production
spec:
  replicas: 6   # More replicas to tolerate simultaneous interruptions
  selector:
    matchLabels:
      app: web-api
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 2   # Allow up to 2 pods down during interruption
      maxSurge: 2
  template:
    metadata:
      labels:
        app: web-api
    spec:
      # Spread across multiple zones for resilience
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: web-api
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: web-api

      # Prefer spot nodes, fall back to on-demand
      affinity:
        nodeAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              preference:
                matchExpressions:
                  - key: node-type
                    operator: In
                    values: ["spot"]
            - weight: 1
              preference:
                matchExpressions:
                  - key: node-type
                    operator: In
                    values: ["on-demand"]

      tolerations:
        - key: spot-instance
          operator: Equal
          value: "true"
          effect: NoSchedule

      terminationGracePeriodSeconds: 90  # Allow in-flight requests to complete

      containers:
        - name: web-api
          image: registry.internal/web-api:1.5.0
          lifecycle:
            preStop:
              exec:
                # Signal the app to stop accepting new connections
                command: ["/bin/sh", "-c", "sleep 15"]

---
# PDB to ensure minimum availability during spot interruptions
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: web-api-pdb
  namespace: production
spec:
  minAvailable: 4   # Always keep at least 4 pods running
  selector:
    matchLabels:
      app: web-api
```

### Batch Job Spot Configuration

```yaml
# batch-job-spot.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: data-export-job
  namespace: data-processing
spec:
  completions: 100
  parallelism: 20
  backoffLimit: 3
  template:
    metadata:
      labels:
        app: data-export
        workload-class: batch
    spec:
      restartPolicy: OnFailure
      tolerations:
        - key: batch-workload
          operator: Equal
          value: "true"
          effect: NoSchedule
      nodeSelector:
        workload-class: batch

      # Checkpoint-based retry for spot-resilient batch jobs
      initContainers:
        - name: restore-checkpoint
          image: registry.internal/batch-tools:latest
          command: ["/bin/restore-checkpoint.sh"]
          env:
            - name: CHECKPOINT_BUCKET
              value: "s3://company-batch-checkpoints"
            - name: JOB_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name

      containers:
        - name: worker
          image: registry.internal/data-exporter:2.0.0
          env:
            - name: CHECKPOINT_INTERVAL_SECONDS
              value: "60"    # Write checkpoint every 60 seconds
            - name: CHECKPOINT_BUCKET
              value: "s3://company-batch-checkpoints"
          resources:
            requests:
              cpu: "2"
              memory: "4Gi"
            limits:
              cpu: "4"
              memory: "8Gi"
```

## Cost Attribution and Chargeback

### Installing OpenCost

OpenCost is the CNCF standard for Kubernetes cost attribution. It allocates cloud costs to namespaces, labels, and pods using cloud provider billing APIs:

```bash
# Install Prometheus first (required by OpenCost)
helm install prometheus prometheus-community/prometheus \
  --namespace monitoring \
  --set server.global.scrape_interval=1m

# Install OpenCost
helm repo add opencost https://opencost.github.io/opencost-helm-chart
helm install opencost opencost/opencost \
  --namespace opencost \
  --create-namespace \
  --set opencost.exporter.defaultClusterId=production-us-east-1 \
  --set opencost.prometheus.internal.enabled=false \
  --set opencost.prometheus.external.enabled=true \
  --set opencost.prometheus.external.url=http://prometheus-server.monitoring:80 \
  --set opencost.ui.enabled=true

# Configure AWS pricing (for accurate on-demand and spot pricing)
kubectl create secret generic cloud-integration \
  --from-file=cloud-integration.json \
  -n opencost

# cloud-integration.json
cat > cloud-integration.json << 'EOF'
{
  "aws": {
    "athenaBucketName": "s3://company-cur-bucket",
    "athenaRegion": "us-east-1",
    "athenaDatabase": "athenacurcfn_company_cur",
    "athenaTable": "company_cur",
    "athenaWorkgroup": "primary",
    "projectID": "123456789012",
    "billingDataDataset": "company_billing"
  }
}
EOF
```

### Custom Cost Attribution Labels

The most important FinOps practice in Kubernetes is consistent label hygiene. Every pod needs labels that map to cost centers:

```yaml
# Label taxonomy for cost attribution
# Applied via admission webhook to enforce compliance

apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-service
  namespace: production
  labels:
    # Cost attribution labels
    team: payments
    cost-center: "CC-1234"
    product: platform
    environment: production
    tier: critical
spec:
  template:
    metadata:
      labels:
        # Propagate to pods for cost attribution
        team: payments
        cost-center: "CC-1234"
        product: platform
        environment: production
        tier: critical
        app: payment-service
        version: "2.1.0"
```

### Enforcing Label Taxonomy with OPA Gatekeeper

```yaml
# gatekeeper-require-cost-labels.yaml
apiVersion: templates.gatekeeper.sh/v1beta1
kind: ConstraintTemplate
metadata:
  name: k8srequirecostlabels
spec:
  crd:
    spec:
      names:
        kind: K8sRequireCostLabels
      validation:
        openAPIV3Schema:
          properties:
            requiredLabels:
              type: array
              items:
                type: string
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8srequirecostlabels

        violation[{"msg": msg}] {
          provided := {label | input.review.object.metadata.labels[label]}
          required := {label | label := input.parameters.requiredLabels[_]}
          missing := required - provided
          count(missing) > 0
          msg := sprintf(
            "Missing required cost attribution labels: %v",
            [missing]
          )
        }
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequireCostLabels
metadata:
  name: require-cost-labels
spec:
  match:
    kinds:
      - apiGroups: ["apps"]
        kinds: ["Deployment", "StatefulSet", "DaemonSet"]
    excludedNamespaces:
      - kube-system
      - monitoring
      - goldilocks
      - opencost
  parameters:
    requiredLabels:
      - team
      - cost-center
      - environment
      - product
```

### Automated Cost Reporting

```python
#!/usr/bin/env python3
# /usr/local/bin/generate-cost-report.py
# Generate weekly cost reports per team

import json
import requests
from datetime import datetime, timedelta
from collections import defaultdict

OPENCOST_URL = "http://opencost.opencost.svc.cluster.local:9003"

def get_allocation(window: str, aggregate: str) -> dict:
    """Query OpenCost allocation API."""
    response = requests.get(
        f"{OPENCOST_URL}/allocation/compute",
        params={
            "window": window,
            "aggregate": aggregate,
            "accumulate": "true",
            "resolution": "1h",
        }
    )
    response.raise_for_status()
    return response.json()

def generate_team_report(window: str = "lastweek") -> list:
    """Generate cost breakdown by team."""
    data = get_allocation(window, "label:team")

    teams = []
    for team, allocation in data.get("data", [{}])[0].items():
        if team == "__idle__":
            continue
        teams.append({
            "team": team,
            "cpu_cost": allocation.get("cpuCost", 0),
            "memory_cost": allocation.get("ramCost", 0),
            "storage_cost": allocation.get("pvCost", 0),
            "network_cost": allocation.get("networkCost", 0),
            "total_cost": allocation.get("totalCost", 0),
            "cpu_efficiency": allocation.get("cpuEfficiency", 0),
            "memory_efficiency": allocation.get("ramEfficiency", 0),
        })

    return sorted(teams, key=lambda x: x["total_cost"], reverse=True)

def generate_namespace_report(window: str = "lastweek") -> list:
    """Generate cost breakdown by namespace."""
    data = get_allocation(window, "namespace")

    namespaces = []
    for ns, allocation in data.get("data", [{}])[0].items():
        if ns == "__idle__":
            continue
        namespaces.append({
            "namespace": ns,
            "total_cost": allocation.get("totalCost", 0),
            "cpu_efficiency": allocation.get("cpuEfficiency", 0) * 100,
            "memory_efficiency": allocation.get("ramEfficiency", 0) * 100,
        })

    return sorted(namespaces, key=lambda x: x["total_cost"], reverse=True)

def calculate_savings_opportunities(teams: list) -> list:
    """Identify teams with high waste potential."""
    opportunities = []
    for team in teams:
        # Identify workloads with < 30% efficiency
        if team["cpu_efficiency"] < 0.3 or team["memory_efficiency"] < 0.3:
            potential_savings = team["total_cost"] * 0.4  # Estimate 40% savings
            opportunities.append({
                "team": team["team"],
                "current_spend": team["total_cost"],
                "cpu_efficiency": f"{team['cpu_efficiency']*100:.1f}%",
                "memory_efficiency": f"{team['memory_efficiency']*100:.1f}%",
                "potential_savings": potential_savings,
                "action": "Review VPA recommendations in Goldilocks dashboard",
            })

    return sorted(opportunities, key=lambda x: x["potential_savings"], reverse=True)

def format_report(teams: list, namespaces: list, opportunities: list) -> str:
    """Format the report as markdown."""
    report = ["# Weekly Kubernetes Cost Report\n"]
    report.append(f"**Period**: {(datetime.now() - timedelta(days=7)).strftime('%Y-%m-%d')} to {datetime.now().strftime('%Y-%m-%d')}\n")

    # Team summary
    report.append("\n## Cost by Team\n")
    report.append("| Team | CPU Cost | Memory Cost | Storage Cost | Total | CPU Eff% | Mem Eff% |")
    report.append("|------|----------|-------------|--------------|-------|----------|----------|")

    total = sum(t["total_cost"] for t in teams)
    for team in teams[:20]:
        report.append(
            f"| {team['team']} | ${team['cpu_cost']:.2f} | ${team['memory_cost']:.2f} | "
            f"${team['storage_cost']:.2f} | **${team['total_cost']:.2f}** | "
            f"{team['cpu_efficiency']*100:.1f}% | {team['memory_efficiency']*100:.1f}% |"
        )
    report.append(f"\n**Total cluster cost**: ${total:.2f}")

    # Savings opportunities
    if opportunities:
        report.append("\n## Savings Opportunities\n")
        report.append(f"Estimated total savings available: **${sum(o['potential_savings'] for o in opportunities):.2f}/week**\n")

        for opp in opportunities[:5]:
            report.append(f"\n### {opp['team']}")
            report.append(f"- Current spend: ${opp['current_spend']:.2f}/week")
            report.append(f"- CPU efficiency: {opp['cpu_efficiency']}")
            report.append(f"- Memory efficiency: {opp['memory_efficiency']}")
            report.append(f"- Potential savings: **${opp['potential_savings']:.2f}/week**")
            report.append(f"- Action: {opp['action']}")

    return "\n".join(report)

if __name__ == "__main__":
    teams = generate_team_report("lastweek")
    namespaces = generate_namespace_report("lastweek")
    opportunities = calculate_savings_opportunities(teams)

    report = format_report(teams, namespaces, opportunities)
    print(report)

    # Optionally write to a file for distribution
    with open("/var/reports/weekly-cost-report.md", "w") as f:
        f.write(report)
```

### Kubernetes CronJob for Automated Reporting

```yaml
# cost-report-cronjob.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: weekly-cost-report
  namespace: finops
spec:
  schedule: "0 8 * * MON"  # 8 AM every Monday
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: cost-reporter
          containers:
            - name: reporter
              image: registry.internal/cost-reporter:1.0.0
              command: ["/usr/local/bin/generate-cost-report.py"]
              env:
                - name: OPENCOST_URL
                  value: "http://opencost.opencost.svc.cluster.local:9003"
                - name: REPORT_EMAIL
                  value: "engineering-leads@company.com"
                - name: SLACK_WEBHOOK
                  valueFrom:
                    secretKeyRef:
                      name: slack-webhooks
                      key: finops-channel
          restartPolicy: OnFailure
```

## Cluster Autoscaler with Cost Awareness

```yaml
# cluster-autoscaler-config.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cluster-autoscaler
  namespace: kube-system
spec:
  template:
    spec:
      containers:
        - name: cluster-autoscaler
          image: registry.k8s.io/autoscaling/cluster-autoscaler:v1.29.0
          command:
            - ./cluster-autoscaler
            - --v=4
            - --stderrthreshold=info
            - --cloud-provider=aws
            - --skip-nodes-with-local-storage=false
            - --expander=least-waste
            - --scale-down-enabled=true
            - --scale-down-delay-after-add=10m
            - --scale-down-delay-after-delete=10s
            - --scale-down-delay-after-failure=3m
            - --scale-down-unneeded-time=10m
            - --scale-down-utilization-threshold=0.5
            - --balance-similar-node-groups=true
            - --skip-nodes-with-system-pods=false
            - --node-group-auto-discovery=asg:tag=k8s.io/cluster-autoscaler/enabled,k8s.io/cluster-autoscaler/production
```

## Alerting on Cost Anomalies

```yaml
# opencost-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: opencost-cost-alerts
  namespace: monitoring
spec:
  groups:
    - name: cost.rules
      rules:
        - alert: NamespaceCostSpike
          expr: |
            (
              sum by (namespace) (
                opencost:container:totalCost:rate1h
              )
              /
              sum by (namespace) (
                opencost:container:totalCost:rate1h offset 7d
              )
            ) > 1.5
          for: 2h
          labels:
            severity: warning
          annotations:
            summary: "Cost spike in namespace {{ $labels.namespace }}"
            description: "Costs in {{ $labels.namespace }} are {{ $value | humanizePercentage }} higher than 7 days ago"

        - alert: LowCPUEfficiency
          expr: |
            avg by (namespace) (
              opencost:container:cpuEfficiency:avg1h
            ) < 0.20
          for: 24h
          labels:
            severity: info
          annotations:
            summary: "Low CPU efficiency in {{ $labels.namespace }}"
            description: "Average CPU efficiency is {{ $value | humanizePercentage }} in {{ $labels.namespace }}"
```

## Key Takeaways

**Goldilocks provides actionable rightsizing data**: VPA recommendations based on actual historical usage are far more accurate than manually setting resource requests. Start with 2 weeks of VPA observation before applying recommendations. Apply the "Burstable" QoS class (request less than limit) for most workloads — this reduces scheduler reservation while maintaining burst capacity.

**Spot instance strategy requires defense in depth**: A single interruption handling mechanism is not sufficient. Combine PodDisruptionBudgets (limit simultaneous evictions), topology spread constraints (spread across zones), pre-stop hooks (drain in-flight requests), and the AWS Node Termination Handler (handle 2-minute interruption notices). With all four in place, spot interruptions become a managed event rather than a page.

**Label taxonomy is the foundation of cost attribution**: Without consistent `team`, `cost-center`, and `environment` labels on every pod, cost attribution is impossible. Enforce these at admission time with OPA Gatekeeper rather than relying on manual compliance. The enforcement investment pays back immediately in attribution accuracy.

**OpenCost is the standard**: OpenCost (now a CNCF project) provides the most accurate Kubernetes cost allocation by combining actual cloud billing data with Kubernetes resource metrics. The namespace and label-based allocation reports give team leads the visibility to take ownership of their spend.

**Efficiency metrics matter more than raw cost**: A team spending $10,000/week with 80% efficiency is better than a team spending $5,000/week with 20% efficiency — the latter has $4,000 in immediate waste. Focus optimization efforts on low-efficiency workloads first, identified through the Goldilocks dashboard and OpenCost efficiency reports.
