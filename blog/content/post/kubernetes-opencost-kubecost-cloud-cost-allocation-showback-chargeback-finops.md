---
title: "Kubernetes OpenCost and Kubecost: Cloud Cost Allocation, Showback/Chargeback, and FinOps Dashboards"
date: 2031-07-21T00:00:00-05:00
draft: false
tags: ["Kubernetes", "OpenCost", "Kubecost", "FinOps", "Cost Management", "Cloud Cost"]
categories:
- Kubernetes
- FinOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to implementing Kubernetes cost visibility with OpenCost and Kubecost, covering cost allocation models, showback/chargeback reporting, and building FinOps dashboards for enterprise cloud cost governance."
more_link: "yes"
url: "/kubernetes-opencost-kubecost-cloud-cost-allocation-showback-chargeback-finops/"
---

Kubernetes makes it easy to share infrastructure across teams and workloads, but that sharing creates a cost attribution problem. When a production namespace, a staging namespace, and several team sandbox environments all run on the same cluster, how do you answer "what does team X's workload actually cost?" without either dedicated clusters per team (expensive) or spreadsheet-based estimates (inaccurate)? OpenCost and Kubecost solve this problem through real-time cost allocation at the pod level, surfaced through APIs and dashboards that integrate with the broader FinOps toolchain.

<!--more-->

# Kubernetes OpenCost and Kubecost: Cloud Cost Allocation, Showback/Chargeback, and FinOps Dashboards

## Understanding the Cost Attribution Problem

Before diving into tooling, it's worth understanding why Kubernetes cost attribution is hard:

**Node sharing**: Multiple pods from different teams run on the same node. The node cost must be allocated proportionally, but "proportionally by what?" is non-trivial — a CPU-bound batch job and a memory-hungry ML model have different resource profiles.

**Overcommit and utilization gaps**: Kubernetes allows pods to request less than they actually use (burstable QoS), and it's common for teams to request more than they need (wasted capacity). Should cost be allocated by request or by actual usage?

**Shared infrastructure**: Cluster addons (CoreDNS, metrics-server, node-exporter) serve all workloads but don't belong to any one team. How do you allocate these shared costs?

**Idle capacity**: Nodes are often not 100% utilized. Idle capacity has a cost. Should it be distributed proportionally across all workloads, charged to no one, or held separately?

OpenCost defines a standard cost allocation model that answers these questions consistently.

## OpenCost vs Kubecost

**OpenCost** is the CNCF-backed open standard and open-source implementation. It provides:
- Real-time cost allocation via REST API
- Standard cost model based on cloud provider pricing
- Integration with Prometheus for metric storage
- No commercial features

**Kubecost** is the commercial product built on top of OpenCost plus additional capabilities:
- Cost governance policies (budget alerts, anomaly detection)
- Multi-cluster aggregation
- Savings recommendations (right-sizing, reserved instance optimization)
- Showback/chargeback reports with export to finance systems
- Teams, RBAC, and report scheduling

This guide covers both, starting with OpenCost for the open-source foundation and then adding Kubecost Enterprise features for the chargeback use case.

## Installing OpenCost

### Prerequisites

- Prometheus installed and accessible (the kube-prometheus-stack is recommended)
- Cloud provider API credentials for node pricing lookup

### Helm Installation

```bash
helm repo add opencost https://opencost.github.io/opencost-helm-chart
helm repo update
```

```yaml
# opencost-values.yaml
opencost:
  exporter:
    defaultClusterId: "production-us-east-1"
    cloudProviderApiKey: ""  # Used for AWS spot price lookups
    aws:
      serviceAccountAnnotations:
        eks.amazonaws.com/role-arn: "arn:aws:iam::<account-id>:role/opencost-role"

  # Configure the Prometheus endpoint
  prometheus:
    internal:
      enabled: false
    external:
      enabled: true
      url: "http://prometheus-operated.monitoring.svc.cluster.local:9090"

  # Cost model configuration
  costModel:
    # CPU cost per core-hour (adjust for your cloud region and instance type mix)
    defaultIdleCPUCoreHourlyCost: "0.031611"
    defaultIdleRAMGBHourlyCost: "0.004237"
    defaultCPUCoreHourlyCost: "0.031611"
    defaultRAMGBHourlyCost: "0.004237"
    defaultGPUHourlyCost: "2.25"
    defaultStorageGBMonthCost: "0.04"
    defaultNetworkIngressCost: "0.0"
    defaultNetworkEgressCost: "0.09"
    defaultNetworkZoneEgressCost: "0.01"
    defaultNetworkCrossRegionEgressCost: "0.02"

  ui:
    enabled: true

  metrics:
    serviceMonitor:
      enabled: true
      namespace: monitoring

  resources:
    requests:
      cpu: 100m
      memory: 512Mi
    limits:
      cpu: "1"
      memory: 1Gi
```

```bash
helm upgrade --install opencost opencost/opencost \
  --namespace opencost \
  --create-namespace \
  --values opencost-values.yaml \
  --wait
```

### AWS IAM Role for Spot Pricing

OpenCost needs to query EC2 pricing APIs for accurate node cost data:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeSpotPriceHistory",
        "pricing:GetProducts"
      ],
      "Resource": "*"
    }
  ]
}
```

### Configuring Prometheus Recording Rules

OpenCost relies on specific Prometheus metrics. Add recording rules to reduce query load:

```yaml
# opencost-recording-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: opencost-recording-rules
  namespace: monitoring
spec:
  groups:
    - name: opencost
      interval: 1m
      rules:
        - record: node_cpu_hourly_cost
          expr: avg(kube_node_labels{label_beta_kubernetes_io_instance_type!=""}) by (node, label_beta_kubernetes_io_instance_type) * on (label_beta_kubernetes_io_instance_type) group_left() node_cpu_hourly_cost_by_instance_type

        - record: opencost:container_cpu_request_cores:sum
          expr: sum by (namespace, pod, container) (kube_pod_container_resource_requests{resource="cpu"})

        - record: opencost:container_memory_request_bytes:sum
          expr: sum by (namespace, pod, container) (kube_pod_container_resource_requests{resource="memory"})
```

## OpenCost Cost Allocation API

The core of OpenCost is its `/allocation` REST API. This returns granular cost data sliced by any Kubernetes dimension.

```bash
# Port-forward the OpenCost API
kubectl port-forward -n opencost svc/opencost 9003:9003 &

# Query costs for the last 7 days, aggregated by namespace
curl -sG "http://localhost:9003/model/allocation" \
  --data-urlencode "window=7d" \
  --data-urlencode "aggregate=namespace" \
  --data-urlencode "accumulate=true" | \
  jq '.data[0] | to_entries | map({namespace: .key, totalCost: .value.totalCost}) | sort_by(-.totalCost) | .[:10]'
```

Sample response structure:

```json
{
  "data": [
    {
      "production": {
        "name": "production",
        "properties": {
          "cluster": "production-us-east-1",
          "namespace": "production"
        },
        "window": {
          "start": "2031-07-11T00:00:00Z",
          "end": "2031-07-18T00:00:00Z"
        },
        "cpuCost": 142.83,
        "memoryCost": 48.21,
        "gpuCost": 0,
        "pvCost": 23.40,
        "networkCost": 5.12,
        "loadBalancerCost": 15.00,
        "sharedCost": 12.44,
        "externalCost": 0,
        "totalCost": 247.00,
        "cpuEfficiency": 0.42,
        "memoryEfficiency": 0.67,
        "totalEfficiency": 0.53
      }
    }
  ]
}
```

### Querying by Labels for Team Attribution

Teams typically identify themselves via Kubernetes labels. Query by label:

```bash
# Costs aggregated by team label
curl -sG "http://localhost:9003/model/allocation" \
  --data-urlencode "window=30d" \
  --data-urlencode "aggregate=label:team" \
  --data-urlencode "accumulate=true" | \
  jq '.data[0] | to_entries | map({team: .key, cost: .value.totalCost})'

# Costs for a specific team broken down by namespace
curl -sG "http://localhost:9003/model/allocation" \
  --data-urlencode "window=30d" \
  --data-urlencode "aggregate=namespace" \
  --data-urlencode "filter=label[team]='payments'" \
  --data-urlencode "accumulate=true"

# Multi-dimensional aggregation: team + environment
curl -sG "http://localhost:9003/model/allocation" \
  --data-urlencode "window=7d" \
  --data-urlencode "aggregate=label:team,label:environment" \
  --data-urlencode "accumulate=false"  # Returns daily time series
```

## Shared Cost Allocation Strategies

OpenCost and Kubecost support three strategies for distributing shared infrastructure costs:

**Even split**: Each workload pays an equal share of shared costs. Simple but unfair — a tiny test pod pays the same as a large production service.

**Weighted by cost**: Shared costs are distributed proportionally to each workload's direct compute cost. A workload using 10x more CPU/memory absorbs 10x more of the shared overhead.

**Weighted by usage**: Shared costs are distributed proportionally to actual resource utilization. Accounts for idling.

Configure the strategy in Kubecost:

```yaml
# kubecost-shared-cost-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: kubecost-shared-cost
  namespace: kubecost
data:
  # Namespaces whose costs are shared across all other namespaces
  sharedNamespaces: "kube-system,monitoring,cert-manager,ingress-nginx"
  # Distribution strategy: even | proportional | weighted
  sharedCostAllocationStrategy: "weighted"
  # Labels that identify shared overhead workloads
  sharedLabels: "app.kubernetes.io/component=infrastructure"
```

## Installing Kubecost (Enterprise Features)

For showback/chargeback and multi-cluster cost aggregation, Kubecost adds significant capabilities over OpenCost alone.

```bash
helm repo add kubecost https://kubecost.github.io/cost-analyzer/
helm repo update
```

```yaml
# kubecost-values.yaml
global:
  prometheus:
    enabled: false
    fqdn: http://prometheus-operated.monitoring.svc.cluster.local:9090

  grafana:
    enabled: false
    proxy: false
    domainName: grafana.monitoring.svc.cluster.local
    scheme: http

kubecostToken: "<kubecost-token>"

kubecostProductConfigs:
  clusterName: "production-us-east-1"
  currencyCode: "USD"

  # AWS cost data integration
  cloudIntegrationJSON: |
    {
      "aws": [{
        "athenaBucketName": "s3://my-cur-bucket",
        "athenaRegion": "us-east-1",
        "athenaDatabase": "athenacurcfn_my_cur",
        "athenaTable": "my_cur",
        "projectID": "<aws-account-id>",
        "serviceKeyName": "",
        "serviceKeySecret": ""
      }]
    }

  # Shared cost namespaces
  sharedNamespaces: "kube-system,monitoring,cert-manager"
  sharedSplitCost: "weighted"

# Kubecost cost model
costModel:
  enabled: true

# Savings module
savings:
  enabled: true
  requestSizingEnabled: true

# Multi-cluster federation (requires Kubecost Enterprise)
federatedETL:
  enabled: true
  federatedStore:
    awsS3:
      enabled: true
      bucket: "kubecost-federated-store"
      region: "us-east-1"

resources:
  requests:
    cpu: 200m
    memory: 512Mi
  limits:
    cpu: "2"
    memory: 2Gi
```

### AWS Cost and Usage Report (CUR) Integration

For accurate billing data rather than on-demand list prices, integrate with AWS CUR:

1. Enable Cost and Usage Reports in AWS Billing Console
2. Configure an Athena query on the CUR data

```sql
-- Create Athena table from CUR data
CREATE EXTERNAL TABLE IF NOT EXISTS athenacurcfn_my_cur.my_cur (
  identity_line_item_id STRING,
  product_servicename STRING,
  product_region STRING,
  line_item_resource_id STRING,
  line_item_unblended_cost DOUBLE,
  line_item_usage_amount DOUBLE,
  line_item_usage_start_date TIMESTAMP,
  resource_tags_user_kubernetes_cluster STRING,
  resource_tags_user_kubernetes_namespace STRING,
  resource_tags_user_team STRING
)
PARTITIONED BY (year STRING, month STRING)
ROW FORMAT SERDE 'org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe'
WITH SERDEPROPERTIES ('field.delim' = ',')
STORED AS INPUTFORMAT 'org.apache.hadoop.mapred.TextInputFormat'
OUTPUTFORMAT 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat'
LOCATION 's3://my-cur-bucket/my_cur/my_cur/'
TBLPROPERTIES ('has_encrypted_data'='false');
```

## Showback and Chargeback Implementation

### Showback: Visibility Without Financial Transfer

Showback means giving teams visibility into their infrastructure costs without actually moving money between cost centers. It's the starting point for cost culture development.

Kubecost's reporting API enables automated showback reports:

```bash
# Query monthly costs per team
curl -sG "http://kubecost.kubecost.svc.cluster.local:9090/model/allocation" \
  --data-urlencode "window=month" \
  --data-urlencode "aggregate=label:team" \
  --data-urlencode "accumulate=true" \
  --data-urlencode "includeSharedCostBreakdown=true" | \
  jq '[.data[0] | to_entries[] | {
    team: .key,
    computeCost: (.value.cpuCost + .value.memoryCost),
    storageCost: .value.pvCost,
    networkCost: .value.networkCost,
    lbCost: .value.loadBalancerCost,
    sharedCost: .value.sharedCost,
    totalCost: .value.totalCost,
    efficiency: .value.totalEfficiency
  }] | sort_by(-.totalCost)'
```

### Automated Monthly Showback Report Script

```bash
#!/usr/bin/env bash
# generate-showback-report.sh
# Generates a monthly showback report and sends it to a Slack channel

set -euo pipefail

KUBECOST_URL="http://kubecost.kubecost.svc.cluster.local:9090"
SLACK_WEBHOOK="<slack-webhook-url>"
REPORT_MONTH="${1:-$(date -d 'last month' '+%Y-%m')}"

# Fetch allocation data
ALLOCATION=$(curl -sG "${KUBECOST_URL}/model/allocation" \
  --data-urlencode "window=${REPORT_MONTH}" \
  --data-urlencode "aggregate=label:team" \
  --data-urlencode "accumulate=true")

# Generate CSV
echo "Team,Compute Cost,Storage Cost,Network Cost,LB Cost,Shared Cost,Total Cost,Efficiency" > \
  /tmp/showback-${REPORT_MONTH}.csv

echo "${ALLOCATION}" | jq -r '
  .data[0] | to_entries[] |
  [.key,
   (.value.cpuCost + .value.memoryCost),
   .value.pvCost,
   .value.networkCost,
   .value.loadBalancerCost,
   .value.sharedCost,
   .value.totalCost,
   .value.totalEfficiency] |
  @csv
' >> /tmp/showback-${REPORT_MONTH}.csv

echo "Showback report generated for ${REPORT_MONTH}"
cat /tmp/showback-${REPORT_MONTH}.csv
```

### Chargeback: Kubernetes-as-a-Service Billing

Chargeback means actually transferring cost responsibility to teams, either through internal billing systems or cloud provider cost allocation mechanisms.

**Strategy 1: Label-based AWS Cost Allocation Tags**

Ensure pods propagate their team labels to cloud resources:

```yaml
# All team workloads must have these labels
# enforced via OPA/Gatekeeper
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-team-labels
spec:
  validationFailureAction: enforce
  rules:
    - name: check-team-label
      match:
        any:
          - resources:
              kinds:
                - Deployment
                - StatefulSet
                - DaemonSet
      validate:
        message: "Workloads must have a 'team' label for cost allocation"
        pattern:
          metadata:
            labels:
              team: "?*"
              cost-center: "?*"
```

**Strategy 2: Kubecost Chargeback API Export**

```python
#!/usr/bin/env python3
"""
kubecost-chargeback.py
Exports Kubecost allocation data to a finance system or internal billing API.
"""

import requests
import json
import os
from datetime import date, timedelta
from decimal import Decimal

KUBECOST_URL = os.environ.get("KUBECOST_URL", "http://kubecost:9090")
BILLING_API_URL = os.environ.get("BILLING_API_URL", "https://billing.internal.example.com")
BILLING_API_TOKEN = os.environ.get("BILLING_API_TOKEN", "")

def fetch_allocations(window: str = "lastmonth") -> dict:
    response = requests.get(
        f"{KUBECOST_URL}/model/allocation",
        params={
            "window": window,
            "aggregate": "label:team,label:cost-center",
            "accumulate": "true",
            "includeSharedCostBreakdown": "true",
        },
        timeout=30,
    )
    response.raise_for_status()
    return response.json()

def build_chargeback_records(allocations: dict) -> list:
    records = []
    period_start = date.today().replace(day=1) - timedelta(days=1)
    period_start = period_start.replace(day=1)

    for key, alloc in allocations["data"][0].items():
        if key == "__idle__" or key == "__unallocated__":
            continue

        # Parse the team/cost-center from the aggregate key
        parts = key.split("/")
        team = parts[0] if len(parts) > 0 else "unknown"
        cost_center = parts[1] if len(parts) > 1 else "unknown"

        record = {
            "billing_period": period_start.strftime("%Y-%m"),
            "team": team,
            "cost_center": cost_center,
            "cluster": alloc.get("properties", {}).get("cluster", ""),
            "compute_cost_usd": round(
                alloc.get("cpuCost", 0) + alloc.get("memoryCost", 0), 4
            ),
            "storage_cost_usd": round(alloc.get("pvCost", 0), 4),
            "network_cost_usd": round(alloc.get("networkCost", 0), 4),
            "lb_cost_usd": round(alloc.get("loadBalancerCost", 0), 4),
            "shared_cost_usd": round(alloc.get("sharedCost", 0), 4),
            "total_cost_usd": round(alloc.get("totalCost", 0), 4),
            "cpu_efficiency": round(alloc.get("cpuEfficiency", 0), 4),
            "memory_efficiency": round(alloc.get("memoryEfficiency", 0), 4),
        }
        records.append(record)

    return sorted(records, key=lambda x: x["total_cost_usd"], reverse=True)

def push_to_billing_system(records: list) -> None:
    headers = {
        "Authorization": f"Bearer {BILLING_API_TOKEN}",
        "Content-Type": "application/json",
    }
    response = requests.post(
        f"{BILLING_API_URL}/v1/kubernetes/chargeback",
        headers=headers,
        json={"records": records},
        timeout=30,
    )
    response.raise_for_status()
    print(f"Pushed {len(records)} chargeback records to billing system")

if __name__ == "__main__":
    allocations = fetch_allocations()
    records = build_chargeback_records(allocations)
    print(json.dumps(records, indent=2))
    if BILLING_API_TOKEN:
        push_to_billing_system(records)
```

Run as a Kubernetes CronJob:

```yaml
# chargeback-cronjob.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: kubecost-chargeback-export
  namespace: kubecost
spec:
  schedule: "0 8 1 * *"  # 8 AM on the 1st of each month
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: chargeback
              image: python:3.12-slim
              command:
                - python3
                - /app/kubecost-chargeback.py
              env:
                - name: KUBECOST_URL
                  value: "http://kubecost.kubecost.svc.cluster.local:9090"
                - name: BILLING_API_URL
                  valueFrom:
                    configMapKeyRef:
                      name: chargeback-config
                      key: billing_api_url
                - name: BILLING_API_TOKEN
                  valueFrom:
                    secretKeyRef:
                      name: billing-credentials
                      key: api_token
              volumeMounts:
                - name: script
                  mountPath: /app
          volumes:
            - name: script
              configMap:
                name: chargeback-script
          restartPolicy: OnFailure
```

## Budget Alerts and Cost Governance

### Kubecost Budget Alerts

```yaml
# kubecost-budgets.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: kubecost-alert-configs
  namespace: kubecost
data:
  alerts.json: |
    {
      "alerts": [
        {
          "type": "budget",
          "threshold": 5000,
          "window": "month",
          "aggregation": "namespace",
          "filter": "namespace=production",
          "slackWebhookUrl": "<slack-webhook-url>",
          "alertEmails": ["platform-team@example.com"]
        },
        {
          "type": "budget",
          "threshold": 1000,
          "window": "month",
          "aggregation": "label:team",
          "filter": "label[team]=payments",
          "alertEmails": ["payments-lead@example.com"]
        },
        {
          "type": "efficiency",
          "threshold": 0.35,
          "window": "24h",
          "aggregation": "namespace",
          "filter": "namespace=production",
          "alertEmails": ["platform-team@example.com"]
        }
      ]
    }
```

### Prometheus Alerting Rules for Cost

```yaml
# cost-alerting-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kubernetes-cost-alerts
  namespace: monitoring
spec:
  groups:
    - name: kubernetes-cost
      rules:
        - alert: HighMonthlyNamespaceCost
          expr: |
            sum by (namespace) (
              avg_over_time(opencost_namespace_current_cost[30d])
            ) * 720 > 5000
          for: 1h
          labels:
            severity: warning
          annotations:
            summary: "High monthly cost for namespace {{ $labels.namespace }}"
            description: "Namespace {{ $labels.namespace }} is on track to cost ${{ $value | humanize }} this month."

        - alert: LowCPUEfficiency
          expr: |
            avg by (namespace) (
              rate(container_cpu_usage_seconds_total{container!=""}[24h])
            ) / sum by (namespace) (
              kube_pod_container_resource_requests{resource="cpu"}
            ) < 0.2
          for: 2h
          labels:
            severity: warning
          annotations:
            summary: "Low CPU efficiency in namespace {{ $labels.namespace }}"
            description: "CPU efficiency is {{ $value | humanizePercentage }} — consider right-sizing."

        - alert: UnusedPVCCost
          expr: |
            kube_persistentvolumeclaim_status_phase{phase="Bound"} == 1
            unless on (namespace, persistentvolumeclaim)
            kube_pod_spec_volumes_persistentvolumeclaims_info
          for: 48h
          labels:
            severity: info
          annotations:
            summary: "Unattached PVC {{ $labels.persistentvolumeclaim }} in {{ $labels.namespace }}"
            description: "PVC has been unattached for 48h, incurring unnecessary storage cost."
```

## FinOps Dashboards with Grafana

### OpenCost Grafana Dashboard

Kubecost ships a pre-built Grafana dashboard. For OpenCost-only deployments, here's a minimal dashboard definition:

```json
{
  "title": "Kubernetes Cost Overview",
  "panels": [
    {
      "title": "Total Monthly Cost by Namespace",
      "type": "bargauge",
      "targets": [
        {
          "expr": "sum by (namespace) (opencost_namespace_current_cost) * 720",
          "legendFormat": "{{ namespace }}"
        }
      ]
    },
    {
      "title": "CPU Cost vs Memory Cost",
      "type": "piechart",
      "targets": [
        {
          "expr": "sum(opencost_cluster_cpu_cost_total)",
          "legendFormat": "CPU"
        },
        {
          "expr": "sum(opencost_cluster_memory_cost_total)",
          "legendFormat": "Memory"
        },
        {
          "expr": "sum(opencost_cluster_pv_cost_total)",
          "legendFormat": "Storage"
        },
        {
          "expr": "sum(opencost_cluster_network_cost_total)",
          "legendFormat": "Network"
        }
      ]
    },
    {
      "title": "Daily Spend Trend",
      "type": "timeseries",
      "targets": [
        {
          "expr": "sum(increase(opencost_cluster_total_cost[1d]))",
          "legendFormat": "Daily Cost"
        }
      ]
    },
    {
      "title": "Resource Efficiency by Namespace",
      "type": "table",
      "targets": [
        {
          "expr": "avg by (namespace) (opencost_namespace_cpu_efficiency)",
          "legendFormat": "CPU Efficiency"
        },
        {
          "expr": "avg by (namespace) (opencost_namespace_memory_efficiency)",
          "legendFormat": "Memory Efficiency"
        }
      ]
    }
  ]
}
```

## Savings Recommendations

Kubecost's right-sizing recommendations identify over-provisioned workloads:

```bash
# Query right-sizing recommendations
curl -sG "http://kubecost.kubecost.svc.cluster.local:9090/savings/requestSizing" \
  --data-urlencode "window=7d" \
  --data-urlencode "minSavings=10" | \
  jq '[.recommendations[] | {
    namespace: .namespace,
    controller: .controllerName,
    currentCPURequest: .currentCPURequest,
    recommendedCPURequest: .recommendedCPURequest,
    currentMemoryRequest: .currentMemoryRequest,
    recommendedMemoryRequest: .recommendedMemoryRequest,
    monthlySavings: .monthlySavings
  }] | sort_by(-.monthlySavings) | .[:20]'
```

Apply right-sizing recommendations as a VPA policy:

```yaml
# vpa-from-kubecost.yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: payments-api-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: payments-api
  updatePolicy:
    updateMode: "Off"  # Recommendation only — review before applying
  resourcePolicy:
    containerPolicies:
      - containerName: payments-api
        minAllowed:
          cpu: 100m
          memory: 128Mi
        maxAllowed:
          cpu: "2"
          memory: 2Gi
        controlledResources:
          - cpu
          - memory
```

## Summary

Kubernetes cost visibility requires three layers working together:

1. **Data collection**: OpenCost provides the foundational cost allocation model with pod-level granularity and cloud provider pricing integration.

2. **Attribution**: Labels (`team`, `cost-center`, `environment`) on all workloads enable cost slicing by business dimension. Enforce label presence with policy tools like Kyverno.

3. **Reporting and governance**: Kubecost extends OpenCost with showback/chargeback APIs, budget alerts, and savings recommendations that integrate with the broader FinOps practice.

The key insight is that cost governance is a cultural problem as much as a technical one. The tooling is only effective when teams can actually see their costs in real-time and when there are clear accountability mechanisms (showback → chargeback progression) that create incentives for efficient resource usage.
