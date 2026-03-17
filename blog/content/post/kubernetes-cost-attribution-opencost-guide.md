---
title: "OpenCost: Kubernetes Cost Attribution and FinOps Implementation"
date: 2027-11-09T00:00:00-05:00
draft: false
tags: ["OpenCost", "FinOps", "Kubernetes", "Cost Optimization", "Cloud"]
categories:
- Kubernetes
- FinOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to deploying OpenCost for Kubernetes cost attribution, implementing FinOps practices, configuring cloud provider integration, and building chargeback reporting for enterprise teams."
more_link: "yes"
url: "/kubernetes-cost-attribution-opencost-guide/"
---

Kubernetes cost attribution is one of the most persistent pain points for engineering organizations running multi-team clusters. Without accurate cost data broken down by namespace, team, application, or label, FinOps initiatives stall and cloud bills remain opaque. OpenCost is the CNCF project that provides real-time Kubernetes cost allocation using pricing data from cloud providers and user-defined asset prices.

This guide covers complete OpenCost deployment, cost allocation configuration, cloud provider pricing integration, Grafana dashboard setup, API usage for automated reporting, and chargeback implementation for enterprise multi-team environments.

<!--more-->

# OpenCost: Kubernetes Cost Attribution and FinOps Implementation

## OpenCost Architecture

OpenCost monitors Kubernetes resource usage and applies cloud pricing to generate cost allocations. It integrates with:

- **Cloud provider billing APIs**: AWS Cost and Usage Reports, GCP Billing, Azure Cost Management
- **Prometheus**: For resource utilization metrics and historical queries
- **Node pricing APIs**: On-demand, spot, and reserved instance pricing

The core allocation model distributes costs at the pod level, then aggregates by namespace, label, deployment, or any Kubernetes attribute.

```
┌─────────────────────────────────────────────────────────┐
│  OpenCost                                               │
│  ┌─────────────────────────────────────────────────┐   │
│  │  Cost Model                                     │   │
│  │  - Node pricing (on-demand/spot/reserved)       │   │
│  │  - PV pricing                                   │   │
│  │  - Network egress pricing                       │   │
│  │  - LoadBalancer pricing                         │   │
│  └────────────┬────────────────────────────────────┘   │
│               │                                         │
│  ┌────────────▼────────────────────────────────────┐   │
│  │  Allocation Engine                              │   │
│  │  - CPU/Memory usage per pod                     │   │
│  │  - Request vs actual cost comparison            │   │
│  │  - Idle cost distribution                       │   │
│  │  - Shared cost attribution                      │   │
│  └────────────┬────────────────────────────────────┘   │
│               │                                         │
│  ┌────────────▼────────────────────────────────────┐   │
│  │  Aggregation                                    │   │
│  │  - By namespace, label, team, deployment        │   │
│  │  - Time window queries                          │   │
│  │  - Custom cost reports                          │   │
│  └────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

## Installation

### Prerequisites

```bash
# OpenCost requires Prometheus with specific metrics
# Verify kube-state-metrics and node-exporter are running
kubectl get pods -n monitoring | grep -E "kube-state|node-exporter"

# Check Prometheus is accessible
kubectl port-forward -n monitoring svc/prometheus-server 9090:80 &
curl -s localhost:9090/api/v1/query?query=up | jq .
```

### Helm Installation

```yaml
# opencost-values.yaml
opencost:
  exporter:
    defaultClusterId: prod-us-east-1
    # AWS pricing configuration
    cloudProviderApiKey: ""
    aws:
      athena:
        enabled: false
    # Node pricing for bare metal or unrecognized instances
    defaultComputedCostNode: "0.048"  # $/hour per node
    defaultCPUCoreHourPrice: "0.031611"
    defaultRAMGBHourPrice: "0.004237"
    resources:
      requests:
        cpu: 100m
        memory: 256Mi
      limits:
        cpu: 1000m
        memory: 1Gi
  prometheus:
    external:
      enabled: true
      url: http://prometheus-server.monitoring.svc.cluster.local
    internal:
      enabled: false
  ui:
    enabled: true
    resources:
      requests:
        cpu: 10m
        memory: 55Mi
      limits:
        cpu: 100m
        memory: 256Mi
  metrics:
    serviceMonitor:
      enabled: true
      namespace: monitoring
```

```bash
helm repo add opencost https://opencost.github.io/opencost-helm-chart
helm repo update

helm install opencost opencost/opencost \
  --namespace opencost \
  --create-namespace \
  --values opencost-values.yaml

# Verify installation
kubectl get pods -n opencost
kubectl port-forward -n opencost svc/opencost 9090:9090 9003:9003 &
curl -s localhost:9090/allocation/compute?window=1d | python3 -m json.tool | head -50
```

### OpenCost RBAC

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: opencost
  namespace: opencost
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: opencost
rules:
- apiGroups: [""]
  resources:
  - configmaps
  - deployments
  - nodes
  - pods
  - services
  - resourcequotas
  - replicationcontrollers
  - limitranges
  - persistentvolumeclaims
  - persistentvolumes
  - namespaces
  - endpoints
  verbs:
  - get
  - list
  - watch
- apiGroups: ["extensions", "apps"]
  resources:
  - daemonsets
  - deployments
  - replicasets
  - statefulsets
  verbs:
  - get
  - list
  - watch
- apiGroups: ["batch"]
  resources:
  - cronjobs
  - jobs
  verbs:
  - get
  - list
  - watch
- apiGroups: ["autoscaling"]
  resources:
  - horizontalpodautoscalers
  verbs:
  - get
  - list
  - watch
- apiGroups: ["policy"]
  resources:
  - poddisruptionbudgets
  verbs:
  - get
  - list
  - watch
- apiGroups: ["storage.k8s.io"]
  resources:
  - storageclasses
  verbs:
  - get
  - list
  - watch
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: opencost
subjects:
- kind: ServiceAccount
  name: opencost
  namespace: opencost
roleRef:
  kind: ClusterRole
  name: opencost
  apiGroup: rbac.authorization.k8s.io
```

## Cloud Provider Integration

### AWS Integration

```yaml
# Create AWS Cost and Usage Report credentials
apiVersion: v1
kind: Secret
metadata:
  name: opencost-aws-credentials
  namespace: opencost
type: Opaque
stringData:
  service-key.json: |
    {
      "type": "AWS",
      "aws_access_key_id": "EXAMPLEAWSACCESSKEY123",
      "aws_secret_access_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      "athena_result_s3_path": "s3://company-cost-reports/opencost/",
      "athena_region": "us-east-1",
      "athena_database": "athenacurcfn_company_cost_reports",
      "athena_table": "company_cost_reports",
      "athena_workgroup": "primary",
      "projectID": "123456789012",
      "billingDataDataset": "company-cost-reports"
    }
```

```yaml
# Update OpenCost deployment to use AWS credentials
apiVersion: apps/v1
kind: Deployment
metadata:
  name: opencost
  namespace: opencost
spec:
  template:
    spec:
      containers:
      - name: opencost
        env:
        - name: CLOUD_PROVIDER_API_KEY
          value: "AIzaSyD-9tSrke72"
        - name: AWS_ACCESS_KEY_ID
          valueFrom:
            secretKeyRef:
              name: opencost-aws-credentials
              key: aws_access_key_id
        - name: AWS_SECRET_ACCESS_KEY
          valueFrom:
            secretKeyRef:
              name: opencost-aws-credentials
              key: aws_secret_access_key
        - name: ATHENA_RESULTS_S3_PATH
          value: s3://company-cost-reports/opencost/
        - name: ATHENA_REGION
          value: us-east-1
        - name: ATHENA_DATABASE
          value: athenacurcfn_company_cost_reports
        - name: ATHENA_TABLE
          value: company_cost_reports
```

### GCP Integration

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: opencost-gcp-credentials
  namespace: opencost
type: Opaque
stringData:
  service-key.json: |
    {
      "type": "service_account",
      "project_id": "company-prod",
      "private_key_id": "key-id",
      "private_key": "-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\n",
      "client_email": "opencost@company-prod.iam.gserviceaccount.com",
      "client_id": "123456789",
      "auth_uri": "https://accounts.google.com/o/oauth2/auth",
      "token_uri": "https://oauth2.googleapis.com/token"
    }
```

```yaml
# Mount GCP credentials in OpenCost
spec:
  template:
    spec:
      volumes:
      - name: gcp-credentials
        secret:
          secretName: opencost-gcp-credentials
      containers:
      - name: opencost
        volumeMounts:
        - name: gcp-credentials
          mountPath: /var/secrets/google
        env:
        - name: GOOGLE_APPLICATION_CREDENTIALS
          value: /var/secrets/google/service-key.json
        - name: GCP_PROJECT_ID
          value: company-prod
        - name: GCP_BILLING_ACCOUNT
          value: "ABCD-1234-5678"
```

### Azure Integration

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: opencost-azure-credentials
  namespace: opencost
type: Opaque
stringData:
  azure-storage-config.json: |
    {
      "subscriptionID": "12345678-1234-1234-1234-123456789012",
      "resourceGroup": "company-billing",
      "storageAccount": "companybilling",
      "containerName": "opencost-exports",
      "directoryPath": "exports/",
      "cloudName": "AZURE_PUBLIC_CLOUD",
      "clientID": "azure-client-id",
      "clientSecret": "azure-client-secret",
      "tenantID": "azure-tenant-id",
      "offerDurableID": "MS-AZR-0003P",
      "billingAccountID": ""
    }
```

## Cost Model Configuration

### Node Price Configuration

For on-premises or custom pricing overrides:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: node-prices
  namespace: opencost
data:
  pricing.yaml: |
    provider: custom
    description: "Custom on-premises pricing"
    CPU: "0.031611"
    spotCPU: "0.006322"
    RAM: "0.004237"
    spotRAM: "0.000847"
    GPU: "2.50"
    spotGPU: "0.75"
    storage: "0.00004"
    zoneNetworkEgress: "0.01"
    regionNetworkEgress: "0.01"
    internetNetworkEgress: "0.09"
    pvCost: "0.07"
    pvStorageClass: "standard"
    node_overrides:
      c5.4xlarge:
        cpu: "0.68"
        ram: "0.068"
      m5.8xlarge:
        cpu: "1.536"
        ram: "0.128"
```

### Idle Cost Distribution

Idle costs represent cluster resources provisioned but unused. OpenCost provides several distribution methods:

```bash
# Query idle cost distribution options
curl -s "localhost:9090/allocation/compute?window=1d&idle=true&idleByNode=true" | \
  python3 -c "
import json, sys
data = json.load(sys.stdin)
for alloc in data.get('data', [{}])[0].values():
    if '__idle__' in alloc.get('name', ''):
        print(f\"Idle: CPU={alloc['cpuCost']:.4f} RAM={alloc['ramCost']:.4f} Total={alloc['totalCost']:.4f}\")
        break
"

# Enable idle cost sharing across namespaces
# (configure in opencost-values.yaml)
# idleByNode: true - distributes idle cost to nodes
# shareIdle: true - shares idle proportionally to usage
```

### Shared Cost Configuration

```yaml
# Configure shared infrastructure costs
apiVersion: v1
kind: ConfigMap
metadata:
  name: opencost-shared-costs
  namespace: opencost
data:
  shared-costs.json: |
    {
      "sharedNamespaces": [
        "kube-system",
        "monitoring",
        "ingress-nginx",
        "cert-manager"
      ],
      "sharedLabels": {
        "team": ["platform", "infrastructure"]
      },
      "sharedCostBreakdown": "weighted",
      "sharedOverhead": 0.1
    }
```

## Cost Allocation API

### Querying Allocations

```bash
# Base URL for OpenCost API
OPENCOST_URL="http://localhost:9090"

# Get allocations for last 7 days by namespace
curl -G "$OPENCOST_URL/allocation/compute" \
  --data-urlencode "window=7d" \
  --data-urlencode "aggregate=namespace" \
  --data-urlencode "accumulate=true" | \
  python3 -m json.tool

# Get allocations by deployment with label filters
curl -G "$OPENCOST_URL/allocation/compute" \
  --data-urlencode "window=2023-11-01T00:00:00Z,2023-11-30T23:59:59Z" \
  --data-urlencode "aggregate=deployment" \
  --data-urlencode "filterNamespaces=production" \
  --data-urlencode "accumulate=true" | \
  python3 -c "
import json, sys
data = json.load(sys.stdin)
allocations = data.get('data', [{}])[0]
sorted_allocs = sorted(allocations.values(), key=lambda x: x['totalCost'], reverse=True)
print(f'{'Deployment':<50} {'CPU Cost':>12} {'RAM Cost':>12} {'Total Cost':>12}')
print('-' * 90)
for alloc in sorted_allocs[:20]:
    print(f\"{alloc['name']:<50} \${alloc['cpuCost']:>11.4f} \${alloc['ramCost']:>11.4f} \${alloc['totalCost']:>11.4f}\")
"

# Query by team label
curl -G "$OPENCOST_URL/allocation/compute" \
  --data-urlencode "window=1w" \
  --data-urlencode "aggregate=label:team" \
  --data-urlencode "accumulate=true"

# Query by multiple labels
curl -G "$OPENCOST_URL/allocation/compute" \
  --data-urlencode "window=1d" \
  --data-urlencode "aggregate=namespace,deployment" \
  --data-urlencode "step=1h"
```

### Asset Cost Queries

```bash
# Get node costs
curl -G "$OPENCOST_URL/assets" \
  --data-urlencode "window=1d" \
  --data-urlencode "aggregate=type" | \
  python3 -m json.tool

# Get PV costs
curl -G "$OPENCOST_URL/assets" \
  --data-urlencode "window=1d" \
  --data-urlencode "aggregate=type" \
  --data-urlencode "filterTypes=PersistentVolume"

# Get network egress costs
curl -G "$OPENCOST_URL/assets" \
  --data-urlencode "window=7d" \
  --data-urlencode "filterTypes=Network"
```

## Chargeback Report Generation

### Python Script for Monthly Chargeback

```python
#!/usr/bin/env python3
"""
opencost-chargeback.py
Generates monthly chargeback report from OpenCost API
"""

import json
import requests
from datetime import datetime, timedelta
from collections import defaultdict
import csv
import sys

OPENCOST_URL = "http://localhost:9090"

def get_allocations(window, aggregate, namespace_filter=None):
    """Fetch cost allocations from OpenCost API."""
    params = {
        "window": window,
        "aggregate": aggregate,
        "accumulate": "true",
        "includeIdle": "true",
        "shareIdle": "false",
    }
    if namespace_filter:
        params["filterNamespaces"] = namespace_filter

    response = requests.get(
        f"{OPENCOST_URL}/allocation/compute",
        params=params,
        timeout=60
    )
    response.raise_for_status()
    data = response.json()
    return data.get("data", [{}])[0]

def generate_team_chargeback(year, month):
    """Generate chargeback report for a specific month."""
    # Calculate month window
    start = datetime(year, month, 1)
    if month == 12:
        end = datetime(year + 1, 1, 1) - timedelta(seconds=1)
    else:
        end = datetime(year, month + 1, 1) - timedelta(seconds=1)

    window = f"{start.strftime('%Y-%m-%dT%H:%M:%SZ')},{end.strftime('%Y-%m-%dT%H:%M:%SZ')}"

    print(f"Generating chargeback report for {year}-{month:02d}")
    print(f"Window: {window}")

    # Get allocations by team label
    team_allocations = get_allocations(window, "label:team")

    # Get allocations by namespace (for items without team label)
    namespace_allocations = get_allocations(window, "namespace")

    # Build chargeback data
    chargeback = defaultdict(lambda: {
        "cpu_cost": 0.0,
        "ram_cost": 0.0,
        "pv_cost": 0.0,
        "network_cost": 0.0,
        "gpu_cost": 0.0,
        "total_cost": 0.0,
        "namespaces": set(),
    })

    for name, alloc in team_allocations.items():
        if name.startswith("__"):
            continue
        team = name if name else "unallocated"
        chargeback[team]["cpu_cost"] += alloc.get("cpuCost", 0)
        chargeback[team]["ram_cost"] += alloc.get("ramCost", 0)
        chargeback[team]["pv_cost"] += alloc.get("pvCost", 0)
        chargeback[team]["network_cost"] += alloc.get("networkCost", 0)
        chargeback[team]["gpu_cost"] += alloc.get("gpuCost", 0)
        chargeback[team]["total_cost"] += alloc.get("totalCost", 0)

    # Generate report
    total = sum(v["total_cost"] for v in chargeback.values())
    print(f"\nTotal cluster cost for {year}-{month:02d}: ${total:.2f}")
    print(f"\n{'Team':<30} {'CPU':>10} {'RAM':>10} {'PV':>10} {'Network':>10} {'Total':>12}")
    print("-" * 85)

    report_rows = []
    for team, costs in sorted(chargeback.items(), key=lambda x: -x[1]["total_cost"]):
        print(
            f"{team:<30} "
            f"${costs['cpu_cost']:>9.2f} "
            f"${costs['ram_cost']:>9.2f} "
            f"${costs['pv_cost']:>9.2f} "
            f"${costs['network_cost']:>9.2f} "
            f"${costs['total_cost']:>11.2f}"
        )
        report_rows.append({
            "team": team,
            "month": f"{year}-{month:02d}",
            "cpu_cost": round(costs["cpu_cost"], 4),
            "ram_cost": round(costs["ram_cost"], 4),
            "pv_cost": round(costs["pv_cost"], 4),
            "network_cost": round(costs["network_cost"], 4),
            "total_cost": round(costs["total_cost"], 4),
            "percentage": round(costs["total_cost"] / total * 100, 2) if total > 0 else 0,
        })

    return report_rows

def write_csv_report(rows, filename):
    """Write chargeback report to CSV."""
    fieldnames = ["month", "team", "cpu_cost", "ram_cost", "pv_cost",
                  "network_cost", "total_cost", "percentage"]
    with open(filename, "w", newline="") as csvfile:
        writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
    print(f"\nReport saved to {filename}")

if __name__ == "__main__":
    year = int(sys.argv[1]) if len(sys.argv) > 1 else datetime.now().year
    month = int(sys.argv[2]) if len(sys.argv) > 2 else datetime.now().month - 1 or 12

    rows = generate_team_chargeback(year, month)
    output_file = f"chargeback-{year}-{month:02d}.csv"
    write_csv_report(rows, output_file)
```

### Automated Monthly Report CronJob

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: opencost-chargeback-report
  namespace: opencost
spec:
  schedule: "0 6 1 * *"
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: opencost
          restartPolicy: OnFailure
          containers:
          - name: report-generator
            image: registry.company.com/opencost-report:1.0.0
            env:
            - name: OPENCOST_URL
              value: http://opencost.opencost.svc.cluster.local:9090
            - name: REPORT_S3_BUCKET
              value: company-finops-reports
            - name: SLACK_WEBHOOK_URL
              valueFrom:
                secretKeyRef:
                  name: slack-webhooks
                  key: finops-channel
            command:
            - /bin/sh
            - -c
            - |
              LAST_MONTH=$(date -d '1 month ago' +%Y-%m)
              python3 /app/opencost-chargeback.py
              aws s3 cp chargeback-${LAST_MONTH}.csv \
                s3://company-finops-reports/chargeback/${LAST_MONTH}/
              curl -s -X POST "$SLACK_WEBHOOK_URL" \
                -H 'Content-type: application/json' \
                --data "{\"text\":\"Monthly chargeback report for ${LAST_MONTH} is ready\"}"
            resources:
              requests:
                cpu: 100m
                memory: 256Mi
```

## Grafana Integration

### Importing OpenCost Dashboards

```bash
# OpenCost provides official Grafana dashboards
# Dashboard ID 15714: OpenCost Kubernetes Cost Monitoring

kubectl create configmap opencost-dashboards \
  --namespace monitoring \
  --from-file=opencost-dashboard.json=/tmp/opencost-dashboard.json \
  -o yaml --dry-run=client | \
  kubectl annotate --local -f - \
    grafana_dashboard=1 \
    -o yaml | kubectl apply -f -
```

### Custom Cost Dashboard Configuration

```json
{
  "title": "Kubernetes Cost Attribution",
  "panels": [
    {
      "title": "Daily Cost by Namespace",
      "type": "timeseries",
      "targets": [
        {
          "expr": "sum(opencost_namespace_hourly_cost) by (namespace)",
          "legendFormat": "{{namespace}}"
        }
      ]
    },
    {
      "title": "Cost Efficiency (Request vs Actual)",
      "type": "table",
      "targets": [
        {
          "expr": "sum(opencost_pod_memory_working_set_bytes * opencost_ram_price) by (namespace) / sum(opencost_pod_memory_request_bytes * opencost_ram_price) by (namespace)",
          "legendFormat": "{{namespace}}"
        }
      ]
    },
    {
      "title": "Top 10 Most Expensive Deployments",
      "type": "bar",
      "targets": [
        {
          "expr": "topk(10, sum(opencost_deployment_hourly_cost * 24 * 30) by (deployment, namespace))",
          "legendFormat": "{{namespace}}/{{deployment}}"
        }
      ]
    },
    {
      "title": "PV Storage Costs",
      "type": "piechart",
      "targets": [
        {
          "expr": "sum(opencost_persistent_volume_hourly_cost * 24 * 30) by (storageclass)",
          "legendFormat": "{{storageclass}}"
        }
      ]
    },
    {
      "title": "Cluster Idle Cost",
      "type": "stat",
      "targets": [
        {
          "expr": "sum(opencost_cluster_idle_hourly_cost) * 24 * 30",
          "legendFormat": "Monthly Idle Cost"
        }
      ]
    }
  ]
}
```

### Prometheus Alerting for Cost Overruns

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: opencost-alerts
  namespace: monitoring
spec:
  groups:
  - name: cost-alerts
    rules:
    - alert: NamespaceCostBudgetExceeded
      expr: |
        sum(opencost_namespace_hourly_cost) by (namespace)
        * 24 * 30
        > on(namespace) group_left
        kube_namespace_annotations{annotation_cost_budget!=""}
        * on(namespace) group_left(annotation_cost_budget)
        kube_namespace_annotations
      for: 1h
      labels:
        severity: warning
      annotations:
        summary: "Namespace {{ $labels.namespace }} exceeding cost budget"
        description: "Monthly cost projection ${{ $value | humanize }} exceeds budget"

    - alert: UnexpectedCostSpike
      expr: |
        sum(rate(opencost_namespace_hourly_cost[1h])) by (namespace)
        > sum(rate(opencost_namespace_hourly_cost[24h])) by (namespace) * 2
      for: 30m
      labels:
        severity: warning
      annotations:
        summary: "Cost spike detected in {{ $labels.namespace }}"
        description: "Hourly rate is 2x the 24h average"

    - alert: HighIdleCost
      expr: |
        sum(opencost_cluster_idle_hourly_cost) * 24
        / sum(opencost_cluster_total_hourly_cost) * 24
        > 0.40
      for: 6h
      labels:
        severity: info
      annotations:
        summary: "Cluster idle cost exceeds 40%"
        description: "Consider right-sizing or cluster autoscaler tuning"
```

## Label-Based Cost Attribution Best Practices

### Namespace Label Strategy

```bash
# Apply cost attribution labels to all namespaces
kubectl label namespace production \
  cost-center=engineering-platform \
  team=platform-engineering \
  environment=production \
  cost-budget=5000

kubectl label namespace checkout-service \
  cost-center=checkout-team \
  team=checkout \
  environment=production \
  cost-budget=2000
```

### Pod Label Enforcement

Use Kyverno or OPA Gatekeeper to require cost labels:

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-cost-labels
spec:
  validationFailureAction: Enforce
  background: true
  rules:
  - name: check-team-label
    match:
      any:
      - resources:
          kinds:
          - Deployment
          - StatefulSet
          namespaces:
          - production
          - staging
    validate:
      message: "Deployments must have 'team' and 'cost-center' labels"
      pattern:
        metadata:
          labels:
            team: "?*"
            cost-center: "?*"
```

### Namespace Budget Annotations

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: checkout-service
  labels:
    team: checkout
    environment: production
  annotations:
    cost-budget: "2000"
    cost-alert-threshold: "1500"
    cost-owner: "checkout-team@company.com"
    cost-center: "checkout-7890"
```

## Multi-Cluster Cost Aggregation

For organizations running multiple clusters, aggregate costs centrally:

```bash
#!/bin/bash
# aggregate-cluster-costs.sh
# Queries OpenCost from multiple clusters and aggregates

CLUSTERS=(
  "prod-us-east-1:https://opencost.us-east-1.internal:9090"
  "prod-us-west-2:https://opencost.us-west-2.internal:9090"
  "prod-eu-west-1:https://opencost.eu-west-1.internal:9090"
)

WINDOW="1d"
OUTPUT_FILE="multi-cluster-costs-$(date +%Y%m%d).json"

echo "[]" > $OUTPUT_FILE

for cluster_info in "${CLUSTERS[@]}"; do
  CLUSTER_NAME="${cluster_info%%:*}"
  CLUSTER_URL="${cluster_info#*:}"

  echo "Querying cluster: $CLUSTER_NAME at $CLUSTER_URL"

  RESULT=$(curl -s -k \
    "$CLUSTER_URL/allocation/compute?window=$WINDOW&aggregate=namespace&accumulate=true" \
    --header "Authorization: Bearer $(cat /etc/opencost/tokens/$CLUSTER_NAME)")

  # Add cluster identifier to each allocation
  echo "$RESULT" | python3 -c "
import json, sys
data = json.load(sys.stdin)
cluster = '$CLUSTER_NAME'
allocations = data.get('data', [{}])[0]
for name, alloc in allocations.items():
    alloc['cluster'] = cluster
print(json.dumps(list(allocations.values())))
" >> /tmp/cluster_${CLUSTER_NAME}.json

done

# Merge all clusters
python3 -c "
import json, glob
all_costs = {}
for f in glob.glob('/tmp/cluster_*.json'):
    with open(f) as fp:
        allocs = json.load(fp)
        for alloc in allocs:
            key = f\"{alloc['cluster']}/{alloc['name']}\"
            all_costs[key] = alloc

# Sort by total cost
sorted_costs = sorted(all_costs.values(), key=lambda x: x.get('totalCost', 0), reverse=True)
print(json.dumps({'data': sorted_costs}, indent=2))
" > $OUTPUT_FILE

echo "Multi-cluster cost report saved to $OUTPUT_FILE"
```

## Resource Efficiency Reporting

### Identifying Overprovisioned Workloads

```bash
# Find pods with low CPU utilization relative to requests
curl -G "localhost:9090/allocation/compute" \
  --data-urlencode "window=7d" \
  --data-urlencode "aggregate=pod" \
  --data-urlencode "accumulate=true" | \
  python3 -c "
import json, sys
data = json.load(sys.stdin)
allocations = data.get('data', [{}])[0]

print('Over-provisioned workloads (CPU utilization < 20%):')
print(f'{\"Pod\":<60} {\"CPU Request\":>12} {\"CPU Used\":>12} {\"Efficiency\":>12} {\"Wasted Cost\":>12}')
print('-' * 100)

for name, alloc in sorted(allocations.items(), key=lambda x: x[1].get('cpuEfficiency', 1)):
    efficiency = alloc.get('cpuEfficiency', 0)
    if efficiency < 0.20 and efficiency > 0 and not name.startswith('__'):
        cpu_req = alloc.get('cpuRequestAverage', 0)
        cpu_used = alloc.get('cpuUsageAverage', 0)
        cpu_cost = alloc.get('cpuCost', 0)
        wasted = cpu_cost * (1 - efficiency)
        if wasted > 0.01:
            print(f'{name:<60} {cpu_req:>12.4f} {cpu_used:>12.4f} {efficiency*100:>11.1f}% \${wasted:>11.4f}')
"
```

## Summary

OpenCost provides production-ready Kubernetes cost attribution with minimal operational overhead. The key implementation points are:

**Deployment**: Install via Helm with Prometheus integration. Configure cloud provider credentials for accurate on-demand and spot pricing instead of default estimates.

**Cost model**: Configure idle cost distribution based on your team's preference. Proportional distribution to active namespaces is most common for chargeback scenarios.

**Labels and attribution**: Enforce team and cost-center labels via admission controllers. Namespace-level labels are the most reliable attribution mechanism.

**Reporting**: The OpenCost API provides flexible allocation queries by namespace, label, deployment, or custom aggregations. The chargeback script and monthly CronJob automate cost reporting.

**Alerting**: Use Prometheus rules with cost budget annotations on namespaces to trigger alerts when teams exceed their allocations.

**Efficiency**: Regularly query CPU and memory efficiency to identify overprovisioned workloads. A cluster with 40%+ idle costs indicates right-sizing opportunities.

OpenCost integrates naturally with existing Prometheus and Grafana deployments, making it the lowest-friction path to Kubernetes FinOps for teams already invested in the Prometheus ecosystem.
