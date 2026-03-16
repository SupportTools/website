---
title: "Kubecost: Kubernetes Cost Allocation, Showback, and Budget Alerts"
date: 2027-02-25T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Kubecost", "FinOps", "Cost Optimization", "Cloud Costs"]
categories: ["Kubernetes", "FinOps", "Cost Management"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to deploying Kubecost for Kubernetes cost allocation, showback, and budget alerting, covering cloud provider billing integration, efficiency scoring, savings recommendations, multi-cluster aggregation, and Grafana dashboards."
more_link: "yes"
url: "/kubecost-kubernetes-cost-allocation-showback-guide/"
---

Kubecost delivers real-time and historical cost allocation for Kubernetes workloads, breaking down infrastructure spend by namespace, label, team, deployment, and container. Unlike cloud provider cost explorers that show aggregate VM costs, Kubecost attributes costs to the individual applications and teams responsible for them, enabling accurate showback and chargeback programs for platform teams running shared clusters.

This guide covers Kubecost architecture, Helm deployment, cloud provider billing API integration for AWS, GCP, and Azure, cost allocation by namespace and label, efficiency scoring, savings insights including rightsizing and abandoned workloads, budget alerts with Slack notifications, the cost allocation REST API, multi-cluster aggregation, network cost monitoring, custom pricing, RBAC for team-level cost visibility, and Grafana dashboard integration.

<!--more-->

## Cost Allocation Fundamentals

Kubernetes resource costs are opaque by default. A cloud provider bill shows the total cost of the EC2 instances or GKE nodes running the cluster, but not which application or team is responsible for what portion of that cost. Kubecost solves this by computing the cost of each workload using:

- **Node costs** (from cloud billing APIs or configured custom pricing)
- **Resource requests** (CPU and memory) as the allocation denominator
- **Actual usage** from Prometheus metrics for efficiency scoring
- **Idle capacity** — unused requests on a node, allocated proportionally or as a shared overhead line

The cost model produces a cost figure for each Kubernetes object that can be aggregated along any dimension expressed as a Kubernetes label or namespace attribute.

## Architecture

```
Cloud Billing APIs (AWS CUR, GCP BigQuery, Azure Billing)
         │
         ▼
  Kubecost Cost Model  ◄── Prometheus (metrics, cAdvisor, kube-state-metrics)
         │
         ▼
  PostgreSQL / Thanos  ─── Long-term storage for 90+ day retention
         │
         ▼
  Kubecost Frontend    ─── Dashboard, Cost Allocation, Savings, Alerts
         │
         ▼
  REST API             ─── Integration with billing systems, Grafana
```

**Kubecost cost-model** — The core Go service that continuously computes cost allocation by correlating node costs with resource utilization and request data from Prometheus.

**Kubecost frontend** — A React-based web UI that renders cost allocation tables, savings recommendations, budget alerts, and cluster health views.

**Bundled Prometheus** — Kubecost ships with a Prometheus instance pre-configured for cost metrics. In enterprise deployments, Kubecost integrates with existing Prometheus and Thanos stacks.

**Grafana** — Optional Grafana integration with pre-built dashboards for cost trends and cluster efficiency.

## Installation

### Helm Deployment

```bash
helm repo add kubecost https://kubecost.github.io/cost-analyzer/
helm repo update

# Basic installation — uses bundled Prometheus
helm install kubecost kubecost/cost-analyzer \
  --namespace kubecost \
  --create-namespace \
  --version 2.3.0 \
  --set kubecostToken="KUBECOST_TOKEN_REPLACE_ME" \
  --set global.prometheus.enabled=true \
  --set global.grafana.enabled=true \
  --set persistentVolume.enabled=true \
  --set persistentVolume.size=32Gi
```

### Production values.yaml

```yaml
# kubecost-values.yaml
kubecostToken: "KUBECOST_TOKEN_REPLACE_ME"

global:
  prometheus:
    enabled: true
    fqdn: "http://kubecost-prometheus-server.kubecost.svc.cluster.local"
  grafana:
    enabled: true
  notifications:
    alertmanager:
      enabled: true
      fqdn: "http://kubecost-alertmanager.kubecost.svc.cluster.local"

kubecostFrontend:
  resources:
    requests:
      cpu: 100m
      memory: 256Mi
    limits:
      cpu: 500m
      memory: 1Gi

cost-analyzer:
  resources:
    requests:
      cpu: 200m
      memory: 512Mi
    limits:
      cpu: 1000m
      memory: 2Gi

persistentVolume:
  enabled: true
  size: 50Gi
  storageClass: gp3

# Retention configuration
prometheus:
  server:
    retention: 15d
    persistentVolume:
      enabled: true
      size: 100Gi
      storageClass: gp3
    resources:
      requests:
        cpu: 500m
        memory: 2Gi
      limits:
        cpu: 2000m
        memory: 4Gi

# Ingress for dashboard access
ingress:
  enabled: true
  ingressClassName: nginx
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/auth-type: basic
    nginx.ingress.kubernetes.io/auth-secret: kubecost-basic-auth
  hosts:
    - host: kubecost.internal.company.com
      paths:
        - /
  tls:
    - secretName: kubecost-tls
      hosts:
        - kubecost.internal.company.com
```

### Integrating with Existing Prometheus

For clusters with an existing kube-prometheus-stack, disable the bundled Prometheus and point Kubecost at the existing instance:

```yaml
# kubecost-values.yaml — existing Prometheus integration
global:
  prometheus:
    enabled: false
    fqdn: "http://kube-prometheus-stack-prometheus.monitoring.svc.cluster.local:9090"

# Ensure required recording rules are present
prometheus:
  server:
    enabled: false

# Add Kubecost scrape configs to existing Prometheus
# Apply this ServiceMonitor in the monitoring namespace
```

Apply the required Prometheus scrape configuration:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: kubecost-cost-analyzer
  namespace: monitoring
  labels:
    release: kube-prometheus-stack
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: cost-analyzer
  namespaceSelector:
    matchNames:
      - kubecost
  endpoints:
    - port: tcp-model
      path: /metrics
      interval: 30s
    - port: tcp-frontend
      path: /metrics
      interval: 60s
```

## Cloud Provider Cost Integration

### AWS Cost and Usage Reports

AWS billing data makes Kubecost node cost calculations precise by using actual reserved instance and savings plan rates rather than on-demand pricing:

```bash
# 1. Create an S3 bucket for Cost and Usage Reports
aws s3 mb s3://company-kubecost-cur --region us-east-1

# 2. Configure the CUR report via AWS console or CLI:
# Report name: kubecost-cur
# Time granularity: Hourly
# Include resource IDs: Yes
# Data integration: Amazon Athena
# S3 bucket: company-kubecost-cur
```

Configure Kubecost to read from the CUR bucket:

```yaml
# kubecost-values.yaml — AWS billing integration
kubecostModel:
  cloudCost:
    enabled: true
    labelMappingConfigs:
      aws_customer_label: "kubernetes_label_team"
      aws_namespace_label: "kubernetes_label_kubernetes_io_namespace"

# AWS-specific configuration via ConfigMap
```

```yaml
# cloud-integration-secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: cloud-integration
  namespace: kubecost
type: Opaque
stringData:
  cloud-integration.json: |
    {
      "aws": [
        {
          "athenaBucketName": "s3://company-kubecost-cur",
          "athenaRegion": "us-east-1",
          "athenaDatabase": "kubecost_cur",
          "athenaTable": "kubecost_cur",
          "projectID": "123456789012",
          "serviceKeyName": "aws-integration-sa",
          "id": "production-aws"
        }
      ]
    }
```

IAM policy for the Kubecost service account:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "athena:*",
        "glue:GetDatabase",
        "glue:GetTable",
        "glue:GetPartitions",
        "s3:GetBucketLocation",
        "s3:GetObject",
        "s3:ListBucket",
        "s3:ListBucketMultipartUploads",
        "s3:ListMultipartUploadParts",
        "s3:AbortMultipartUpload",
        "s3:CreateBucket",
        "s3:PutObject",
        "ec2:DescribeInstances",
        "ec2:DescribeReservedInstances",
        "pricing:GetProducts",
        "sts:GetCallerIdentity"
      ],
      "Resource": "*"
    }
  ]
}
```

### GCP Billing Export to BigQuery

```yaml
stringData:
  cloud-integration.json: |
    {
      "gcp": [
        {
          "projectID": "company-production",
          "billingDataDataset": "billing_export.gcp_billing_export_v1_ABCDEF_123456_789ABC",
          "id": "production-gcp",
          "key": {
            "type": "service_account",
            "project_id": "company-production",
            "client_email": "kubecost-billing@company-production.iam.gserviceaccount.com",
            "private_key_id": "GCP_KEY_ID_REPLACE_ME",
            "private_key": "GCP_PRIVATE_KEY_REPLACE_ME",
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token"
          }
        }
      ]
    }
```

### Azure Billing API

```yaml
stringData:
  cloud-integration.json: |
    {
      "azure": [
        {
          "subscriptionID": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
          "tenantID": "yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy",
          "clientID": "AZURE_CLIENT_ID_REPLACE_ME",
          "clientSecret": "AZURE_CLIENT_SECRET_REPLACE_ME",
          "offerDurableID": "MS-AZR-0003P",
          "billingAccountID": "12345678",
          "id": "production-azure"
        }
      ]
    }
```

Apply the secret:

```bash
kubectl apply -f cloud-integration-secret.yaml -n kubecost

# Reference it in kubecost values
helm upgrade kubecost kubecost/cost-analyzer \
  --namespace kubecost \
  --reuse-values \
  --set kubecostModel.cloudCost.enabled=true \
  --set cloudIntegrationSecret=cloud-integration
```

## Cost Allocation Queries

### Namespace-Level Allocation

```bash
# Query cost allocation for all namespaces over the last 7 days
curl -s "http://kubecost.internal.company.com/model/allocation" \
  --data-urlencode "window=7d" \
  --data-urlencode "aggregate=namespace" \
  --data-urlencode "accumulate=false" \
  | jq '.data[0] | to_entries[]
    | {
        namespace: .key,
        cpuCost: (.value.cpuCost | . * 100 | round / 100),
        memoryCost: (.value.memoryCost | . * 100 | round / 100),
        networkCost: (.value.networkCost | . * 100 | round / 100),
        totalCost: (.value.totalCost | . * 100 | round / 100),
        cpuEfficiency: (.value.cpuEfficiency | . * 100 | round / 100),
        memoryEfficiency: (.value.memoryEfficiency | . * 100 | round / 100)
      }' \
  | jq -s 'sort_by(-.totalCost)'
```

### Label-Based Allocation (Team Showback)

```bash
# Allocate costs by the 'team' label across all namespaces
curl -s "http://kubecost.internal.company.com/model/allocation" \
  --data-urlencode "window=month" \
  --data-urlencode "aggregate=label:team" \
  --data-urlencode "accumulate=true" \
  | jq '.data[0] | to_entries[]
    | {
        team: .key,
        totalCost: (.value.totalCost | . * 100 | round / 100),
        cpuCost: (.value.cpuCost | . * 100 | round / 100),
        memoryCost: (.value.memoryCost | . * 100 | round / 100)
      }' \
  | jq -s 'sort_by(-.totalCost)'
```

### Deployment-Level Breakdown

```bash
# Get per-deployment costs in the production namespace
curl -s "http://kubecost.internal.company.com/model/allocation" \
  --data-urlencode "window=7d" \
  --data-urlencode "aggregate=deployment" \
  --data-urlencode "namespace=production" \
  --data-urlencode "accumulate=true" \
  | jq '.data[0] | to_entries | sort_by(-.value.totalCost)[:20]
    | map({
        name: .key,
        cost_7d: (.value.totalCost | . * 100 | round / 100),
        cpu_efficiency_pct: (.value.cpuEfficiency * 100 | round),
        mem_efficiency_pct: (.value.memoryEfficiency * 100 | round)
      })'
```

## Efficiency Scores

Kubecost computes efficiency as:

```
CPU Efficiency   = average CPU usage / average CPU request
Memory Efficiency = average memory usage / average memory request
```

Values above 1.0 indicate the workload is using more than it requested (a warning sign for CPU throttling or OOM risk). Values below 0.3 indicate significant over-provisioning.

### Efficiency Dashboard Query

```bash
# Find all deployments with CPU efficiency below 20%
curl -s "http://kubecost.internal.company.com/model/allocation" \
  --data-urlencode "window=7d" \
  --data-urlencode "aggregate=deployment" \
  --data-urlencode "accumulate=true" \
  | jq '[.data[0] | to_entries[]
    | select(.value.cpuEfficiency < 0.20)
    | {
        deployment: .key,
        cpu_efficiency: (.value.cpuEfficiency * 100 | round),
        monthly_waste_estimate: ((.value.cpuCost * 4.33) * (1 - .value.cpuEfficiency) | . * 100 | round / 100)
      }]
    | sort_by(-.monthly_waste_estimate)'
```

## Idle Cost Allocation

Idle costs represent node capacity that was paid for but not requested by any workload. Kubecost can allocate idle costs in two modes:

- **Proportional**: Idle cost is distributed proportionally to each workload's requests relative to total node capacity. This gives teams accurate cost attribution including their share of headroom.
- **Share**: Idle costs appear as a separate line item and are not distributed to namespaces. Useful when platform teams want to track infrastructure overhead separately.

```bash
# Include idle costs proportionally in namespace allocation
curl -s "http://kubecost.internal.company.com/model/allocation" \
  --data-urlencode "window=7d" \
  --data-urlencode "aggregate=namespace" \
  --data-urlencode "idleByNode=true" \
  --data-urlencode "includeIdle=true" \
  | jq '.data[0]."__idle__" | {idle_cost: .totalCost}'
```

Configure idle allocation mode in Helm values:

```yaml
kubecostModel:
  allocation:
    idleByNode: false          # true = idle allocated per-node, false = cluster-wide
    shareIdle: false           # true = distribute idle to namespaces proportionally
    shareTenancyCosts: true    # Include node overhead (OS, kubelet, etc.)
```

## Savings Insights

### Rightsizing Recommendations

```bash
# Get rightsizing recommendations for all deployments
curl -s "http://kubecost.internal.company.com/model/savings/requestSizing" \
  --data-urlencode "window=7d" \
  --data-urlencode "targetUtilization=0.65" \
  | jq '[.[] | select(.monthlySavings > 5)
    | {
        namespace: .namespace,
        name: .controllerName,
        container: .containerName,
        monthlySavings: (.monthlySavings | . * 100 | round / 100),
        currentCPU: .currentCPURequest,
        recommendedCPU: .recommendedCPURequest,
        currentMemory: .currentMemoryRequest,
        recommendedMemory: .recommendedMemoryRequest
      }]
  | sort_by(-.monthlySavings)'
```

### Abandoned Workloads

Abandoned workloads are deployments with zero requests over the last 7 days:

```bash
curl -s "http://kubecost.internal.company.com/model/savings/abandonedWorkloads" \
  --data-urlencode "window=7d" \
  | jq '[.[] | {
      namespace: .namespace,
      name: .name,
      kind: .kind,
      monthlyCost: (.monthlyCost | . * 100 | round / 100),
      daysSinceLastActivity: .daysSinceLastActivity
    }]
  | sort_by(-.monthlyCost)'
```

### Cluster Right-Sizing (Node Recommendations)

```bash
curl -s "http://kubecost.internal.company.com/model/savings/clusterSizing" \
  | jq '{
      currentMonthlyCost: .currentMonthlyCost,
      recommendedMonthlyCost: .recommendedMonthlyCost,
      monthlySavings: .monthlySavings,
      recommendations: [.recommendations[] | {
        nodeType: .nodeType,
        count: .count,
        totalCost: .totalCost
      }]
    }'
```

## Budget Alerts

### Configuring Alerts via Helm

```yaml
# kubecost-values.yaml — alert configuration
alerts:
  enabled: true
  globalSlackWebhookUrl: "https://hooks.slack.com/services/SLACK_WEBHOOK_REPLACE_ME"
  globalAlertEmails:
    - platform-team@company.com
  cloudCost:
    - type: cloudCost
      window: 7d
      threshold: 1000
      aggregation: service
      filter: "service:EKS"
  budget:
    # Alert when production namespace exceeds $500/week
    - type: budget
      threshold: 500
      window: week
      aggregation: namespace
      filter: "namespace:production"
    # Alert when any team exceeds $1000/month
    - type: budget
      threshold: 1000
      window: month
      aggregation: label
      filter: "label[team]:*"
  spendChange:
    # Alert on >20% week-over-week cost increase
    - type: spendChange
      relativeThreshold: 0.20
      window: week
      baselineWindow: week
      aggregation: namespace
      filter: "namespace:production"
  efficiency:
    # Alert when cluster efficiency drops below 40%
    - type: efficiency
      threshold: 0.40
      window: 7d
      aggregation: cluster
      filter: "cluster:production-us-east-1"
```

### Alert Configuration via ConfigMap

For GitOps-managed alert configuration:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: kubecost-alerts
  namespace: kubecost
data:
  alerts.json: |
    {
      "alerts": [
        {
          "type": "budget",
          "threshold": 500.00,
          "window": "week",
          "aggregation": "namespace",
          "filter": "namespace:production",
          "slackWebhookUrl": "https://hooks.slack.com/services/SLACK_WEBHOOK_REPLACE_ME"
        },
        {
          "type": "spendChange",
          "relativeThreshold": 0.25,
          "window": "week",
          "baselineWindow": "week",
          "aggregation": "label",
          "filter": "label[team]:payments",
          "slackWebhookUrl": "https://hooks.slack.com/services/SLACK_PAYMENTS_WEBHOOK_REPLACE_ME"
        },
        {
          "type": "recurringUpdate",
          "window": "week",
          "aggregation": "namespace",
          "filter": "namespace:production",
          "slackWebhookUrl": "https://hooks.slack.com/services/SLACK_WEBHOOK_REPLACE_ME"
        }
      ]
    }
```

## Network Cost Monitoring

Kubecost tracks network egress costs which are often a significant and overlooked component of Kubernetes spend. Enable network cost monitoring via the network cost daemonset:

```yaml
# kubecost-values.yaml — network cost monitoring
networkCosts:
  enabled: true
  podSecurityPolicy:
    enabled: false
  config:
    destinations:
      - region: "us-east-1"
        zone: ""
      - region: "us-west-2"
        zone: ""
    services:
      amazon-web-services:
        enabled: true
      google-cloud-services:
        enabled: false
      azure-cloud-services:
        enabled: false
```

The daemonset uses eBPF to capture per-pod network traffic and categorizes it as:

- **In-zone**: Traffic within the same availability zone (typically free)
- **Cross-zone**: Traffic between AZs in the same region (billed per GB)
- **Internet egress**: Traffic leaving the cloud region (highest cost)

```bash
# Query network costs by namespace
curl -s "http://kubecost.internal.company.com/model/allocation" \
  --data-urlencode "window=7d" \
  --data-urlencode "aggregate=namespace" \
  --data-urlencode "accumulate=true" \
  | jq '[.data[0] | to_entries[]
    | select(.value.networkCost > 0)
    | {
        namespace: .key,
        networkCost_7d: (.value.networkCost | . * 100 | round / 100),
        networkCrossZone: (.value.networkCrossZoneCost | . * 100 | round / 100),
        networkInternetEgress: (.value.networkInternetCost | . * 100 | round / 100)
      }]
  | sort_by(-.networkCost_7d)'
```

## Custom Pricing

For on-premises clusters or cloud commitments not reflected in public pricing, define custom node pricing:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: node-prices
  namespace: kubecost
data:
  pricing.json: |
    {
      "CPU": 0.031611,
      "spotCPU": 0.006655,
      "RAM": 0.004237,
      "spotRAM": 0.000892,
      "GPU": 0.95,
      "storage": 0.000138,
      "zoneNetworkEgress": 0.01,
      "regionNetworkEgress": 0.01,
      "internetNetworkEgress": 0.12,
      "defaultIdle": "0.1"
    }
```

Reference in Helm values:

```yaml
kubecostModel:
  config:
    configmapName: node-prices
```

## Multi-Cluster Aggregation

### Kubecost Enterprise with Thanos

For multi-cluster environments, Kubecost Enterprise uses Thanos as a long-term metrics store to aggregate costs across all clusters:

```yaml
# Primary cluster values.yaml
global:
  thanos:
    enabled: true
    queryEndpoint: "http://thanos-query.kubecost.svc.cluster.local:10901"
  multiCluster:
    enabled: true
    primaryCluster: true

thanos:
  thanosStore:
    enabled: true
  thanosQuery:
    enabled: true
    stores:
      - "thanos-sidecar.kubecost-cluster-2.svc.cluster.local:10901"
      - "thanos-sidecar.kubecost-cluster-3.svc.cluster.local:10901"
```

```yaml
# Secondary cluster values.yaml
global:
  thanos:
    enabled: true
  multiCluster:
    enabled: true
    primaryCluster: false
    parentClusterID: "production-primary"
```

### Multi-Cluster Allocation Query

```bash
# Query costs across all clusters
curl -s "http://kubecost.internal.company.com/model/allocation" \
  --data-urlencode "window=30d" \
  --data-urlencode "aggregate=cluster" \
  --data-urlencode "accumulate=true" \
  | jq '[.data[0] | to_entries[]
    | {
        cluster: .key,
        totalCost_30d: (.value.totalCost | . * 100 | round / 100)
      }]
  | sort_by(-.totalCost_30d)'
```

## RBAC for Team Cost Visibility

Restrict cost visibility so that development teams can only see costs for their own namespaces:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: kubecost-viewer
rules:
  - apiGroups:
      - ""
    resources:
      - pods
      - nodes
      - namespaces
      - persistentvolumes
      - persistentvolumeclaims
      - services
    verbs:
      - get
      - list
      - watch
  - apiGroups:
      - apps
    resources:
      - deployments
      - daemonsets
      - statefulsets
      - replicasets
    verbs:
      - get
      - list
      - watch
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: team-payments-kubecost
  namespace: payments
subjects:
  - kind: Group
    name: payments-developers
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: kubecost-viewer
  apiGroup: rbac.authorization.k8s.io
```

Configure namespace-scoped API access via Kubecost's built-in RBAC:

```yaml
# kubecost-values.yaml — RBAC configuration
kubecostFrontend:
  api:
    rbacEnabled: true
    rbacProxyImage: "gcr.io/kubebuilder/kube-rbac-proxy:v0.14.1"

# Team-specific API access via namespace annotation
# Annotate namespaces with team ownership
```

```bash
kubectl annotate namespace payments \
  kubecost.com/team=payments \
  kubecost.com/cost-center=cc-1234
```

## Grafana Dashboards

Import the pre-built Kubecost Grafana dashboards:

```bash
# Import via Grafana API
for dashboard_id in 11270 13332 13498 15714; do
  curl -s -X POST \
    "http://grafana.monitoring.svc.cluster.local:3000/api/dashboards/import" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer GRAFANA_API_TOKEN_REPLACE_ME" \
    -d "{\"dashboardId\": ${dashboard_id}, \"overwrite\": true, \"folderId\": 0}"
done
```

### Custom Cost Efficiency Grafana Panel

```yaml
# Grafana panel JSON for cost efficiency trend
panels:
  - type: timeseries
    title: "Cluster CPU Cost Efficiency (7d rolling)"
    targets:
      - expr: >
          avg(
            container_cpu_usage_seconds_total{namespace!="kube-system"}
          ) by (namespace)
          /
          avg(
            kube_pod_container_resource_requests{resource="cpu", namespace!="kube-system"}
          ) by (namespace)
        legendFormat: "{{namespace}}"
    fieldConfig:
      defaults:
        unit: percentunit
        min: 0
        max: 1
        thresholds:
          steps:
            - value: 0
              color: red
            - value: 0.3
              color: yellow
            - value: 0.7
              color: green
```

### Prometheus Recording Rules for Kubecost Metrics

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kubecost-recording-rules
  namespace: monitoring
spec:
  groups:
    - name: kubecost.cost
      interval: 5m
      rules:
        - record: kubecost:namespace_monthly_cost
          expr: >
            sum by (namespace) (
              label_replace(
                kubecost_container_request_hours{namespace!=""}
                * on(node) group_left()
                kubecost_node_hourly_cost,
                "namespace", "$1", "namespace", "(.*)"
              )
            ) * 730
          labels:
            unit: USD

        - record: kubecost:cluster_efficiency
          expr: >
            sum(container_cpu_usage_seconds_total{container!=""})
            /
            sum(kube_pod_container_resource_requests{resource="cpu", container!=""})
```

## Cost Monitoring Best Practices

### Establish Cost Baselines First

Deploy Kubecost in view-only mode for 30 days before acting on recommendations. Cost data needs time to reflect seasonal patterns and deployment cadence. Use this period to:

1. Validate cloud billing API integration produces expected totals
2. Identify the top-5 cost namespaces and their efficiency scores
3. Establish baseline cost per namespace per week

### Label Hygiene is Critical

Cost allocation accuracy depends on consistent label application. Any workload without a `team` or `cost-center` label ends up in the `__unallocated__` bucket, making showback impossible. Combine Kubecost with a Kyverno or Polaris policy that enforces required labels before workloads reach production.

### Alert Gradually

Start budget alerts with thresholds 30% above current spend. As teams become cost-aware and baseline spending stabilizes, tighten thresholds to 10–15% above the rolling average. Avoid alert fatigue from thresholds set too aggressively at initial deployment.

### Review Savings Recommendations Monthly

Rightsizing and abandoned workload recommendations change as traffic patterns evolve. Integrate the savings API into a monthly FinOps review process. For clusters on AWS, combine Kubecost rightsizing with Reserved Instance and Savings Plan coverage reports from the AWS Cost Explorer to quantify the full optimization opportunity.

### Idle Cost Attribution Policy

Decide on an idle cost attribution policy before exposing costs to development teams. Proportional idle distribution gives the most accurate cost signal but can cause confusion when a team's cost increases due to idle capacity added by another team. A dedicated `__idle__` line item in showback reports is often more transparent in shared cluster environments.

## Conclusion

Kubecost provides the cost visibility layer that Kubernetes lacks natively, transforming opaque infrastructure bills into actionable allocation data segmented by the teams and applications responsible for the spend. The combination of cloud provider billing integration, real-time efficiency scoring, and automated savings recommendations delivers the full FinOps capability set needed to run shared Kubernetes infrastructure responsibly. Budget alerts and Slack notifications keep spending trends visible to all stakeholders without requiring them to query the dashboard manually, and RBAC-scoped access ensures development teams see only their own cost data while platform administrators maintain a cluster-wide view.
