---
title: "Kubernetes OpenCost: Open-Source Cost Monitoring with Prometheus, Cloud Pricing APIs, and Grafana Dashboards"
date: 2031-12-25T00:00:00-05:00
draft: false
tags: ["Kubernetes", "OpenCost", "Prometheus", "Grafana", "FinOps", "Cost Monitoring", "Cloud Cost"]
categories:
- Kubernetes
- FinOps
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to deploying OpenCost on Kubernetes for open-source cloud cost monitoring, covering Prometheus integration, AWS/GCP/Azure pricing APIs, namespace and workload allocation models, and production Grafana dashboards."
more_link: "yes"
url: "/kubernetes-opencost-open-source-cost-monitoring-prometheus-grafana/"
---

Kubernetes infrastructure costs are notoriously opaque. Engineers provision clusters, deploy workloads, and only discover the financial impact at the end of the month when the cloud bill arrives. OpenCost, the CNCF sandbox project backed by the FinOps Foundation, changes this by giving platform teams real-time cost visibility at the namespace, workload, label, and annotation level. This guide walks through a production-grade OpenCost deployment with Prometheus integration, cloud provider pricing API configuration, allocation model design, and Grafana dashboards that your finance and engineering teams will both understand.

<!--more-->

# Kubernetes OpenCost: Open-Source Cost Monitoring

## Section 1: OpenCost Architecture and Core Concepts

OpenCost operates as a cost allocation engine that maps Kubernetes resource consumption to cloud provider pricing. It runs as a Deployment inside your cluster and exposes its data through a REST API and, optionally, a Prometheus-compatible metrics endpoint.

### The Allocation Model

OpenCost computes cost using the following primitive:

```
cost = (requested_cpu * cpu_price) + (requested_memory * memory_price) + (attached_storage * storage_price) + (network_egress * network_price)
```

It sources pricing from three mechanisms in priority order:

1. **Custom pricing overrides** — static YAML/JSON you provide
2. **Cloud provider pricing APIs** — AWS Pricing API, GCP Cloud Billing Catalog, Azure RateCard API
3. **Default public on-demand prices** — bundled fallback table

The allocation model supports four grouping dimensions that you can combine arbitrarily:

- **Namespace** — the primary boundary for team/project attribution
- **Label/Annotation** — maps to JIRA tickets, cost centers, or application names
- **Controller** — Deployment, StatefulSet, DaemonSet, Job
- **Node** — breaks down by instance type or spot/on-demand tier

### Component Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Kubernetes Cluster                                             │
│                                                                 │
│  ┌─────────────┐    ┌───────────────────┐    ┌─────────────┐  │
│  │   OpenCost  │───▶│   Prometheus      │───▶│   Grafana   │  │
│  │  Deployment │    │   (scrapes /metrics│    │  Dashboards │  │
│  │             │    │    endpoint)       │    │             │  │
│  └──────┬──────┘    └───────────────────┘    └─────────────┘  │
│         │                                                       │
│         │ scrapes kube-state-metrics, kubelet /stats/summary   │
│         ▼                                                       │
│  ┌─────────────┐    ┌───────────────────┐                     │
│  │  kube-state │    │  Cloud Provider   │                     │
│  │  -metrics   │    │  Pricing APIs     │                     │
│  └─────────────┘    └───────────────────┘                     │
└─────────────────────────────────────────────────────────────────┘
```

## Section 2: Prerequisites and Installation

### Prerequisites

Before deploying OpenCost, ensure the following are in place:

- Kubernetes 1.24 or later
- Prometheus Operator or kube-prometheus-stack installed
- Helm 3.10 or later
- `kubectl` configured with cluster-admin or the RBAC permissions defined below
- Cloud provider credentials with read-only access to pricing APIs

### RBAC Configuration

OpenCost needs read access to node, pod, persistent volume, and namespace resources.

```yaml
# opencost-rbac.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: opencost
  labels:
    app.kubernetes.io/managed-by: helm
---
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
    verbs: ["get", "list", "watch"]
  - apiGroups: ["extensions"]
    resources:
      - daemonsets
      - deployments
      - replicasets
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources:
      - statefulsets
      - deployments
      - daemonsets
      - replicasets
    verbs: ["get", "list", "watch"]
  - apiGroups: ["batch"]
    resources:
      - cronjobs
      - jobs
    verbs: ["get", "list", "watch"]
  - apiGroups: ["autoscaling"]
    resources:
      - horizontalpodautoscalers
    verbs: ["get", "list", "watch"]
  - apiGroups: ["policy"]
    resources:
      - poddisruptionbudgets
    verbs: ["get", "list", "watch"]
  - apiGroups: ["storage.k8s.io"]
    resources:
      - storageclasses
    verbs: ["get", "list", "watch"]
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

Apply this before installing via Helm:

```bash
kubectl apply -f opencost-rbac.yaml
```

### Helm Installation

Add the OpenCost Helm repository and inspect available values:

```bash
helm repo add opencost https://opencost.github.io/opencost-helm-chart
helm repo update
helm show values opencost/opencost > opencost-default-values.yaml
```

Create your production values file:

```yaml
# opencost-values.yaml
opencost:
  exporter:
    defaultClusterId: "prod-us-east-1"
    cloudProviderApiKey: ""   # Set via secret for AWS; see below
    aws:
      enabled: true
      region: "us-east-1"
    # Resource requests/limits sized for a 200-node cluster
    resources:
      requests:
        cpu: "250m"
        memory: "512Mi"
      limits:
        cpu: "1000m"
        memory: "2Gi"
    persistence:
      enabled: true
      storageClass: "gp3"
      size: "32Gi"
    # Emit Prometheus metrics
    prometheus:
      enabled: true
      # Point to your existing Prometheus
      existingSecretName: ""
      serverEndpoint: "http://prometheus-operated.monitoring.svc.cluster.local:9090"

  ui:
    enabled: true
    resources:
      requests:
        cpu: "100m"
        memory: "128Mi"
      limits:
        cpu: "500m"
        memory: "512Mi"

# ServiceMonitor for Prometheus Operator
serviceMonitor:
  enabled: true
  namespace: monitoring
  additionalLabels:
    release: kube-prometheus-stack

# Pod annotations for Datadog/custom scraping if needed
podAnnotations:
  prometheus.io/scrape: "true"
  prometheus.io/port: "9003"
  prometheus.io/path: "/metrics"
```

Install the chart:

```bash
helm install opencost opencost/opencost \
  --namespace opencost \
  --create-namespace \
  --values opencost-values.yaml \
  --version 1.42.0 \
  --wait
```

Verify the deployment:

```bash
kubectl -n opencost get pods
kubectl -n opencost logs -l app=opencost -c opencost --tail=50
```

## Section 3: Cloud Provider Pricing API Integration

### AWS Pricing API

OpenCost queries the AWS Pricing API to retrieve on-demand EC2 and EBS prices. The API endpoint is `https://pricing.us-east-1.amazonaws.com` (note: always us-east-1 regardless of your region). Create a minimal IAM policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "pricing:GetProducts",
        "pricing:DescribeServices",
        "pricing:GetAttributeValues",
        "ec2:DescribeSpotPriceHistory",
        "ec2:DescribeInstances",
        "ec2:DescribeRegions"
      ],
      "Resource": "*"
    }
  ]
}
```

Store credentials in a Kubernetes Secret (never hardcode values):

```bash
kubectl -n opencost create secret generic opencost-aws-credentials \
  --from-literal=AWS_ACCESS_KEY_ID="<aws-access-key-id>" \
  --from-literal=AWS_SECRET_ACCESS_KEY="<aws-secret-access-key>"
```

Reference the secret in your values:

```yaml
opencost:
  exporter:
    extraEnv:
      - name: AWS_ACCESS_KEY_ID
        valueFrom:
          secretKeyRef:
            name: opencost-aws-credentials
            key: AWS_ACCESS_KEY_ID
      - name: AWS_SECRET_ACCESS_KEY
        valueFrom:
          secretKeyRef:
            name: opencost-aws-credentials
            key: AWS_SECRET_ACCESS_KEY
```

For EKS clusters using IRSA (recommended over long-lived credentials):

```yaml
# IRSA annotation on the OpenCost service account
serviceAccount:
  annotations:
    eks.amazonaws.com/role-arn: "arn:aws:iam::<account-id>:role/opencost-pricing-role"
```

The IRSA trust policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<account-id>:oidc-provider/oidc.eks.<region>.amazonaws.com/id/<oidc-id>"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "oidc.eks.<region>.amazonaws.com/id/<oidc-id>:sub": "system:serviceaccount:opencost:opencost"
        }
      }
    }
  ]
}
```

### GCP Cloud Billing Catalog

For GKE clusters, OpenCost uses the Cloud Billing Catalog API. Create a service account with the `roles/billing.viewer` role:

```bash
gcloud iam service-accounts create opencost-pricing \
  --display-name="OpenCost Pricing Reader"

gcloud projects add-iam-policy-binding <project-id> \
  --member="serviceAccount:opencost-pricing@<project-id>.iam.gserviceaccount.com" \
  --role="roles/billing.viewer"

gcloud projects add-iam-policy-binding <project-id> \
  --member="serviceAccount:opencost-pricing@<project-id>.iam.gserviceaccount.com" \
  --role="roles/compute.viewer"

# Create and download key
gcloud iam service-accounts keys create opencost-gcp-key.json \
  --iam-account=opencost-pricing@<project-id>.iam.gserviceaccount.com
```

Store and reference in the deployment:

```bash
kubectl -n opencost create secret generic opencost-gcp-key \
  --from-file=key.json=opencost-gcp-key.json
```

```yaml
opencost:
  exporter:
    gcp:
      enabled: true
      projectId: "<project-id>"
    extraVolumes:
      - name: gcp-key
        secret:
          secretName: opencost-gcp-key
    extraVolumeMounts:
      - name: gcp-key
        mountPath: /var/secrets/google
        readOnly: true
    extraEnv:
      - name: GOOGLE_APPLICATION_CREDENTIALS
        value: /var/secrets/google/key.json
```

For Workload Identity (preferred on GKE):

```bash
gcloud iam service-accounts add-iam-policy-binding \
  opencost-pricing@<project-id>.iam.gserviceaccount.com \
  --role="roles/iam.workloadIdentityUser" \
  --member="serviceAccount:<project-id>.svc.id.goog[opencost/opencost]"
```

### Azure RateCard API

For AKS, OpenCost uses the Azure Commerce RateCard API:

```bash
# Create service principal with Reader role
az ad sp create-for-rbac \
  --name "opencost-pricing" \
  --role "Reader" \
  --scopes "/subscriptions/<subscription-id>"
```

Store the output values in a Kubernetes Secret:

```bash
kubectl -n opencost create secret generic opencost-azure-credentials \
  --from-literal=AZURE_SUBSCRIPTION_ID="<subscription-id>" \
  --from-literal=AZURE_CLIENT_ID="<client-id>" \
  --from-literal=AZURE_CLIENT_SECRET="<client-secret>" \
  --from-literal=AZURE_TENANT_ID="<tenant-id>"
```

```yaml
opencost:
  exporter:
    azure:
      enabled: true
    extraEnv:
      - name: AZURE_SUBSCRIPTION_ID
        valueFrom:
          secretKeyRef:
            name: opencost-azure-credentials
            key: AZURE_SUBSCRIPTION_ID
      - name: AZURE_CLIENT_ID
        valueFrom:
          secretKeyRef:
            name: opencost-azure-credentials
            key: AZURE_CLIENT_ID
      - name: AZURE_CLIENT_SECRET
        valueFrom:
          secretKeyRef:
            name: opencost-azure-credentials
            key: AZURE_CLIENT_SECRET
      - name: AZURE_TENANT_ID
        valueFrom:
          secretKeyRef:
            name: opencost-azure-credentials
            key: AZURE_TENANT_ID
```

## Section 4: Custom Pricing Configuration

For on-premises clusters or when you want to override cloud pricing (e.g., for reserved instance blended rates), use a ConfigMap:

```yaml
# opencost-custom-pricing.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: custom-pricing-model
  namespace: opencost
data:
  default.json: |
    {
      "provider": "custom",
      "description": "Blended RI pricing for prod cluster",
      "CPU": "0.031611",
      "spotCPU": "0.006655",
      "RAM": "0.004237",
      "spotRAM": "0.000892",
      "GPU": "0.95",
      "storage": "0.000138",
      "zoneNetworkEgress": "0.01",
      "regionNetworkEgress": "0.01",
      "internetNetworkEgress": "0.12",
      "spotLabel": "eks.amazonaws.com/capacityType",
      "spotLabelValue": "SPOT",
      "awsSpotDataRegion": "us-east-1",
      "awsSpotDataBucket": "<your-spot-data-bucket>",
      "awsSpotDataPrefix": "spot-price-data",
      "projectID": "<project-id>",
      "athenaBucketName": "<athena-bucket>",
      "athenaRegion": "us-east-1",
      "athenaDatabase": "athenacurcfn_<database-name>",
      "athenaTable": "<table-name>",
      "athenaWorkgroup": "primary"
    }
```

Mount this ConfigMap into the OpenCost pod:

```yaml
opencost:
  exporter:
    extraVolumes:
      - name: custom-pricing
        configMap:
          name: custom-pricing-model
    extraVolumeMounts:
      - name: custom-pricing
        mountPath: /models
        readOnly: true
    extraEnv:
      - name: CONFIG_PATH
        value: /models/
```

## Section 5: Prometheus Integration and Metrics Reference

OpenCost exposes metrics on port 9003 at `/metrics`. After installing the ServiceMonitor, Prometheus will scrape these automatically.

### Key Metrics

```
# Cost metrics (cumulative, in USD)
container_cpu_allocation           # CPU cores allocated per container
container_memory_allocation_bytes  # Memory bytes allocated per container
opencost:container:cpu:allocation:rate1h   # Hourly CPU cost rate
opencost:container:memory:allocation:rate1h  # Hourly memory cost rate

# Node-level pricing
node_cpu_hourly_cost               # Hourly CPU cost for the node
node_ram_hourly_cost               # Hourly RAM cost for the node
node_total_hourly_cost             # Total hourly cost for the node

# PV costs
pv_hourly_cost                     # Hourly cost for persistent volumes

# Network costs
network_transfer_bytes_total       # Network bytes transferred
```

### Recording Rules for Aggregated Cost Views

Add these recording rules to your Prometheus configuration for efficient dashboard queries:

```yaml
# opencost-recording-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: opencost-recording-rules
  namespace: monitoring
  labels:
    release: kube-prometheus-stack
spec:
  groups:
    - name: opencost.namespace.cost
      interval: 5m
      rules:
        - record: namespace:container_cpu_allocation:rate1h
          expr: |
            sum by (namespace) (
              rate(container_cpu_allocation[1h])
            )
        - record: namespace:container_memory_allocation_bytes:rate1h
          expr: |
            sum by (namespace) (
              rate(container_memory_allocation_bytes[1h])
            )
        - record: namespace:hourly_cost_total
          expr: |
            sum by (namespace) (
              node_cpu_hourly_cost * on(node) group_left()
                sum by (node) (container_cpu_allocation)
            )
            +
            sum by (namespace) (
              node_ram_hourly_cost / 1024 / 1024 / 1024 * on(node) group_left()
                sum by (node) (container_memory_allocation_bytes)
            )

    - name: opencost.workload.cost
      interval: 5m
      rules:
        - record: workload:hourly_cost_total
          expr: |
            sum by (namespace, owner_name, owner_kind) (
              label_replace(
                container_cpu_allocation * on(node) group_left()
                  node_cpu_hourly_cost,
                "workload", "$1", "pod", "^(.+)-[a-z0-9]+-[a-z0-9]+$"
              )
            )

    - name: opencost.daily.aggregations
      interval: 1h
      rules:
        - record: namespace:daily_cost_usd
          expr: |
            sum by (namespace) (namespace:hourly_cost_total) * 24
        - record: cluster:daily_cost_usd
          expr: |
            sum(namespace:hourly_cost_total) * 24
```

Apply the recording rules:

```bash
kubectl apply -f opencost-recording-rules.yaml
```

### Verify Prometheus Scraping

```bash
# Port-forward to Prometheus
kubectl -n monitoring port-forward svc/prometheus-operated 9090:9090 &

# Check targets
curl -s http://localhost:9090/api/v1/targets | \
  python3 -m json.tool | \
  grep -A5 "opencost"

# Query a metric
curl -s "http://localhost:9090/api/v1/query?query=node_total_hourly_cost" | \
  python3 -m json.tool
```

## Section 6: Allocation Model Design

### Label-Based Cost Attribution

The most powerful feature of OpenCost for enterprise use is label-based cost allocation. Define a labeling convention across your organization:

```yaml
# Recommended label schema
metadata:
  labels:
    # Required for cost allocation
    app.kubernetes.io/name: "payment-service"
    app.kubernetes.io/component: "api"

    # Cost center attribution
    cost-center: "cc-1042"
    team: "platform-engineering"
    environment: "production"

    # Chargeback
    billing-unit: "product-payments"
    jira-project: "PAY"
```

### Multi-Cluster Aggregation

For organizations with multiple clusters, configure a shared Prometheus with remote write:

```yaml
# prometheus-remote-write.yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: prometheus
  namespace: monitoring
spec:
  remoteWrite:
    - url: "http://thanos-receive.thanos.svc.cluster.local:10908/api/v1/receive"
      writeRelabelConfigs:
        # Inject cluster label
        - targetLabel: cluster
          replacement: "prod-us-east-1"
      queueConfig:
        maxSamplesPerSend: 10000
        batchSendDeadline: 5s
```

In the Thanos-backed Prometheus, add the cluster label to all OpenCost queries:

```promql
# Total cost by cluster and namespace
sum by (cluster, namespace) (namespace:hourly_cost_total)
```

### Showback vs. Chargeback Reports

OpenCost's REST API generates allocation reports:

```bash
# Port-forward to OpenCost API
kubectl -n opencost port-forward svc/opencost 9003:9003 &

# Get namespace-level costs for the last 7 days
curl -s "http://localhost:9003/allocation/compute?window=7d&aggregate=namespace&step=1d" | \
  python3 -m json.tool

# Get workload-level costs grouped by team label
curl -s "http://localhost:9003/allocation/compute?window=30d&aggregate=label:team&step=1d&idle=true" | \
  python3 -m json.tool

# Get cost with efficiency metrics
curl -s "http://localhost:9003/allocation/compute?window=7d&aggregate=deployment&includeSharedCostBreakdown=true" | \
  python3 -m json.tool
```

Automate weekly cost reports with a CronJob:

```yaml
# opencost-weekly-report.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: opencost-weekly-report
  namespace: opencost
spec:
  schedule: "0 6 * * 1"  # Every Monday at 6am
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: opencost
          containers:
            - name: reporter
              image: curlimages/curl:8.5.0
              command:
                - /bin/sh
                - -c
                - |
                  REPORT=$(curl -s "http://opencost.opencost.svc.cluster.local:9003/allocation/compute?window=lastweek&aggregate=namespace&step=1d")
                  echo "Weekly Cost Report:"
                  echo $REPORT | python3 -m json.tool
                  # Ship to S3, Slack webhook, or email system here
          restartPolicy: OnFailure
```

## Section 7: Grafana Dashboards

### Installing the OpenCost Dashboard

OpenCost provides official Grafana dashboards via the dashboard marketplace. Import them programmatically:

```bash
# Import via Grafana API
GRAFANA_URL="http://grafana.monitoring.svc.cluster.local:3000"
GRAFANA_TOKEN="<grafana-service-account-token>"

# Download the official OpenCost dashboard
curl -s https://raw.githubusercontent.com/opencost/opencost/develop/docs/grafana-dashboard.json \
  -o opencost-dashboard.json

# Import to Grafana
curl -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${GRAFANA_TOKEN}" \
  -d @opencost-dashboard.json \
  "${GRAFANA_URL}/api/dashboards/import"
```

### Custom Cost Efficiency Dashboard

The following dashboard JSON captures namespace cost vs. request efficiency:

```json
{
  "title": "Kubernetes Cost Efficiency",
  "uid": "k8s-cost-efficiency",
  "panels": [
    {
      "title": "Total Cluster Daily Cost (USD)",
      "type": "stat",
      "targets": [
        {
          "expr": "sum(namespace:hourly_cost_total) * 24",
          "legendFormat": "Daily Cost"
        }
      ],
      "fieldConfig": {
        "defaults": {
          "unit": "currencyUSD",
          "thresholds": {
            "steps": [
              { "color": "green", "value": 0 },
              { "color": "yellow", "value": 500 },
              { "color": "red", "value": 1000 }
            ]
          }
        }
      }
    },
    {
      "title": "Cost by Namespace (Top 15)",
      "type": "bargauge",
      "targets": [
        {
          "expr": "topk(15, sum by (namespace) (namespace:hourly_cost_total) * 24)",
          "legendFormat": "{{namespace}}"
        }
      ],
      "fieldConfig": {
        "defaults": {
          "unit": "currencyUSD"
        }
      }
    },
    {
      "title": "CPU Request Efficiency by Namespace",
      "type": "table",
      "targets": [
        {
          "expr": "sum by (namespace) (rate(container_cpu_usage_seconds_total[1h])) / sum by (namespace) (kube_pod_container_resource_requests{resource='cpu'})",
          "legendFormat": "{{namespace}}",
          "instant": true
        }
      ]
    },
    {
      "title": "Memory Request Efficiency by Namespace",
      "type": "table",
      "targets": [
        {
          "expr": "sum by (namespace) (container_memory_working_set_bytes{container!='',container!='POD'}) / sum by (namespace) (kube_pod_container_resource_requests{resource='memory'})",
          "legendFormat": "{{namespace}}",
          "instant": true
        }
      ]
    }
  ]
}
```

### Grafana AlertManager Rules for Cost Spikes

```yaml
# cost-alerting-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: opencost-cost-alerts
  namespace: monitoring
  labels:
    release: kube-prometheus-stack
spec:
  groups:
    - name: cost.alerts
      rules:
        - alert: NamespaceCostSpikeDetected
          expr: |
            (
              sum by (namespace) (namespace:hourly_cost_total)
              /
              sum by (namespace) (
                avg_over_time(namespace:hourly_cost_total[7d])
              )
            ) > 2.0
          for: 30m
          labels:
            severity: warning
          annotations:
            summary: "Cost spike in namespace {{ $labels.namespace }}"
            description: "Namespace {{ $labels.namespace }} is spending {{ $value | humanize }}x more than its 7-day average."

        - alert: ClusterDailyCostExceedsThreshold
          expr: sum(namespace:hourly_cost_total) * 24 > 2000
          for: 1h
          labels:
            severity: critical
          annotations:
            summary: "Cluster daily cost exceeds $2000 threshold"
            description: "Current projected daily cost is ${{ $value | humanize }}."

        - alert: HighCPURequestEfficiencyWaste
          expr: |
            (
              sum by (namespace) (kube_pod_container_resource_requests{resource="cpu"})
              -
              sum by (namespace) (rate(container_cpu_usage_seconds_total[1h]))
            ) / sum by (namespace) (kube_pod_container_resource_requests{resource="cpu"})
            > 0.7
          for: 2h
          labels:
            severity: warning
          annotations:
            summary: "High CPU waste in namespace {{ $labels.namespace }}"
            description: "Over 70% of requested CPU is unused in {{ $labels.namespace }}. Consider rightsizing."
```

## Section 8: Cost Optimization Workflows

### Identifying Idle Namespaces

```bash
# Find namespaces with zero CPU usage in the last 24h
curl -s "http://localhost:9003/allocation/compute?window=24h&aggregate=namespace&idle=true" | \
  python3 -c "
import sys, json
data = json.load(sys.stdin)
for ns, info in data.get('data', {}).get('sets', [{}])[0].items():
    cpu_eff = info.get('cpuEfficiency', 0)
    total_cost = info.get('totalCost', 0)
    if cpu_eff < 0.1 and total_cost > 1.0:
        print(f'Idle: {ns} | CPU Eff: {cpu_eff:.2%} | Daily Cost: \${total_cost:.2f}')
"
```

### Rightsizing Recommendations Integration

Combine OpenCost with VPA recommendations:

```bash
# Get VPA recommendations for all namespaces
kubectl get vpa -A -o json | python3 -c "
import sys, json
data = json.load(sys.stdin)
for item in data['items']:
    ns = item['metadata']['namespace']
    name = item['metadata']['name']
    recs = item.get('status', {}).get('recommendation', {}).get('containerRecommendations', [])
    for rec in recs:
        target = rec.get('target', {})
        print(f'{ns}/{name}: CPU={target.get(\"cpu\",\"N/A\")} Mem={target.get(\"memory\",\"N/A\")}')
"
```

### Spot Instance Cost Attribution

Nodes running on spot/preemptible instances should be tagged appropriately:

```yaml
# spot-node-labeler-daemonset.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: spot-node-labeler
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: spot-node-labeler
  template:
    metadata:
      labels:
        app: spot-node-labeler
    spec:
      serviceAccountName: spot-node-labeler
      initContainers:
        - name: labeler
          image: bitnami/kubectl:1.28
          command:
            - /bin/sh
            - -c
            - |
              # Check AWS instance lifecycle
              LIFECYCLE=$(curl -s --max-time 2 \
                http://169.254.169.254/latest/meta-data/instance-life-cycle 2>/dev/null || echo "on-demand")
              NODE_NAME=${NODE_NAME}
              if [ "$LIFECYCLE" = "spot" ]; then
                kubectl label node ${NODE_NAME} \
                  node.kubernetes.io/capacity-type=spot --overwrite
              fi
          env:
            - name: NODE_NAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
      containers:
        - name: pause
          image: gcr.io/google_containers/pause:3.9
```

## Section 9: Troubleshooting Common Issues

### OpenCost Reports Zero Costs

Check that the pricing API is reachable:

```bash
# Verify AWS Pricing API connectivity
kubectl -n opencost exec -it deploy/opencost -c opencost -- \
  curl -v https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/index.json 2>&1 | head -20

# Check OpenCost logs for pricing errors
kubectl -n opencost logs deploy/opencost -c opencost | grep -i "pricing\|cost\|error" | tail -30
```

### Metrics Not Appearing in Prometheus

```bash
# Verify ServiceMonitor is picked up
kubectl -n monitoring get servicemonitors | grep opencost

# Check Prometheus targets
kubectl -n monitoring port-forward svc/prometheus-operated 9090:9090 &
curl -s "http://localhost:9090/api/v1/targets?state=active" | \
  python3 -m json.tool | grep -A10 opencost

# Manually test the metrics endpoint
kubectl -n opencost port-forward svc/opencost 9003:9003 &
curl -s http://localhost:9003/metrics | grep node_total_hourly_cost | head -5
```

### High Memory Usage

```bash
# Check OpenCost memory consumption
kubectl -n opencost top pod

# Tune the window retention
# In values.yaml, reduce the default window retention:
#   opencost.exporter.maxQueryConcurrency: 5
#   opencost.exporter.uiCacheRefreshInterval: "15m"
```

### Mismatched Node Costs

When OpenCost assigns incorrect prices to nodes, verify instance type detection:

```bash
# Check detected node labels
kubectl get nodes -o json | python3 -c "
import sys, json
data = json.load(sys.stdin)
for node in data['items']:
    name = node['metadata']['name']
    labels = node['metadata']['labels']
    instance_type = labels.get('node.kubernetes.io/instance-type', 'unknown')
    region = labels.get('topology.kubernetes.io/region', 'unknown')
    zone = labels.get('topology.kubernetes.io/zone', 'unknown')
    print(f'{name}: {instance_type} | {region}/{zone}')
"
```

## Section 10: Production Hardening

### High Availability Configuration

For production, run OpenCost with two replicas and a PodDisruptionBudget:

```yaml
# opencost-ha.yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: opencost
  namespace: opencost
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: opencost
---
# Add to values.yaml
replicaCount: 2
```

### Network Policies

Restrict OpenCost network access:

```yaml
# opencost-netpol.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: opencost
  namespace: opencost
spec:
  podSelector:
    matchLabels:
      app: opencost
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: monitoring
      ports:
        - port: 9003
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: opencost
      ports:
        - port: 9090
  egress:
    # Allow DNS
    - ports:
        - port: 53
          protocol: UDP
    # Allow Prometheus
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: monitoring
      ports:
        - port: 9090
    # Allow AWS/GCP/Azure pricing APIs
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except:
              - 10.0.0.0/8
              - 172.16.0.0/12
              - 192.168.0.0/16
      ports:
        - port: 443
```

### Regular Data Export to Object Storage

For long-term retention beyond Prometheus's default 15-day window:

```yaml
# opencost-export-cronjob.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: opencost-daily-export
  namespace: opencost
spec:
  schedule: "0 1 * * *"  # 1am daily
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: opencost
          containers:
            - name: exporter
              image: amazon/aws-cli:2.15.0
              command:
                - /bin/sh
                - -c
                - |
                  DATE=$(date -d yesterday +%Y-%m-%d)
                  curl -s "http://opencost.opencost.svc.cluster.local:9003/allocation/compute?window=${DATE}&aggregate=namespace&step=1h" \
                    -o /tmp/cost-${DATE}.json
                  aws s3 cp /tmp/cost-${DATE}.json \
                    s3://<your-cost-bucket>/opencost/daily/${DATE}.json
              env:
                - name: AWS_DEFAULT_REGION
                  value: us-east-1
          restartPolicy: OnFailure
```

This production-ready OpenCost deployment gives your platform team real-time cost visibility across namespaces, workloads, and teams, with alerting on cost spikes and automated reports ready for FinOps reviews.
