---
title: "FinOps and Cloud Cost Optimization for Kubernetes Workloads"
date: 2027-09-28T00:00:00-05:00
draft: false
tags: ["FinOps", "Cost Optimization", "Kubernetes", "AWS", "GCP"]
categories:
- FinOps
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to FinOps practices for Kubernetes — Karpenter spot strategies, Kubecost namespace allocation, VPA rightsizing, commitment discounts, cluster consolidation, and OpenCost dashboards."
more_link: "yes"
url: "/finops-cloud-cost-optimization-kubernetes-guide/"
---

Cloud infrastructure spend is one of the largest and fastest-growing line items in engineering budgets. Kubernetes clusters, while powerful, introduce cost complexity through idle capacity, oversized resource requests, untagged namespaces, and inefficient storage provisioning. FinOps — the practice of aligning financial accountability with engineering decisions — provides a framework for understanding, attributing, and reducing that spend without sacrificing reliability. This guide covers every cost lever available in a Kubernetes environment, from Karpenter spot instance strategies and VPA-driven rightsizing to namespace-level cost allocation with Kubecost and commitment discount modeling.

<!--more-->

# FinOps and Cloud Cost Optimization for Kubernetes Workloads

## Section 1: FinOps Framework for Kubernetes

The FinOps Foundation defines three phases: Inform, Optimize, and Operate. Applied to Kubernetes, these map to:

- **Inform**: Tag all resources, allocate costs to teams, build dashboards with real-time visibility
- **Optimize**: Rightsize workloads, adopt spot/preemptible instances, consolidate clusters
- **Operate**: Automate cost enforcement, integrate cost into CI/CD, review unit economics monthly

### Cost Drivers in Kubernetes Environments

```
Total Kubernetes Cost
├── Compute (typically 60-75%)
│   ├── Requested but unused CPU/memory
│   ├── Node overhead (kubelet, kernel, OS)
│   └── System namespace overhead
├── Storage (10-20%)
│   ├── Unused PersistentVolumes
│   ├── Over-provisioned volumes
│   └── Snapshot accumulation
├── Networking (5-15%)
│   ├── Cross-AZ data transfer
│   ├── NAT Gateway charges
│   └── Egress to internet
└── Load Balancers and IPs (5-10%)
    ├── Idle LoadBalancer services
    └── Unused Elastic IPs
```

## Section 2: Rightsizing with VPA Recommendations

The Vertical Pod Autoscaler (VPA) in recommendation mode analyzes historical resource usage and suggests right-sized requests and limits without automatically applying changes.

### VPA Installation

```bash
# Install VPA components
git clone https://github.com/kubernetes/autoscaler.git
cd autoscaler/vertical-pod-autoscaler

# Deploy in recommendation-only mode initially
./hack/vpa-up.sh

# Verify installation
kubectl get pods -n kube-system | grep vpa
# vpa-admission-controller-xxx   1/1   Running
# vpa-recommender-xxx            1/1   Running
# vpa-updater-xxx                1/1   Running
```

### VPA Recommendation Objects

```yaml
# vpa-payment-service.yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: payment-service-vpa
  namespace: payments
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: payment-service
  updatePolicy:
    updateMode: "Off"  # Recommendation only — apply manually after review
  resourcePolicy:
    containerPolicies:
      - containerName: payment-service
        minAllowed:
          cpu: "100m"
          memory: "128Mi"
        maxAllowed:
          cpu: "4000m"
          memory: "4Gi"
        controlledResources:
          - cpu
          - memory
        controlledValues: RequestsAndLimits
```

### Reading VPA Recommendations

```bash
# View recommendations for all VPAs in a namespace
kubectl get vpa -n payments -o json | \
  python3 -c "
import json, sys
vpas = json.load(sys.stdin)
for v in vpas['items']:
    name = v['metadata']['name']
    recs = v.get('status', {}).get('recommendation', {}).get('containerRecommendations', [])
    for r in recs:
        container = r['containerName']
        lower = r.get('lowerBound', {})
        target = r.get('target', {})
        upper = r.get('upperBound', {})
        print(f'{name}/{container}:')
        print(f'  Target CPU: {target.get(\"cpu\",\"N/A\")}  Mem: {target.get(\"memory\",\"N/A\")}')
        print(f'  Range: [{lower.get(\"cpu\",\"N/A\")} - {upper.get(\"cpu\",\"N/A\")}] CPU')
"
```

### Bulk Rightsizing Script

```bash
#!/bin/bash
# rightsize-report.sh — generate rightsizing report for all deployments
set -euo pipefail

NAMESPACE="${1:-default}"
OUTPUT_FILE="rightsizing-${NAMESPACE}-$(date +%Y%m%d).csv"

echo "namespace,deployment,container,current_cpu_req,recommended_cpu,current_mem_req,recommended_mem,savings_estimate" \
  > "${OUTPUT_FILE}"

kubectl get vpa -n "${NAMESPACE}" -o json | python3 - <<'PYEOF'
import json, sys, subprocess

vpas = json.loads(subprocess.check_output([
    'kubectl', 'get', 'vpa', '-n', sys.argv[1] if len(sys.argv) > 1 else 'default',
    '-o', 'json'
]).decode())

for v in vpas['items']:
    recs = v.get('status', {}).get('recommendation', {}).get('containerRecommendations', [])
    for r in recs:
        target = r.get('target', {})
        print(f"Recommendation: CPU={target.get('cpu','N/A')} Memory={target.get('memory','N/A')}")
PYEOF
```

## Section 3: Spot and Preemptible Instance Strategies with Karpenter

Karpenter replaces the Cluster Autoscaler with a faster, more flexible node provisioner that supports mixed instance types and Spot interruption handling natively.

### Karpenter Installation (EKS)

```bash
# Set environment variables
export CLUSTER_NAME="acme-production"
export AWS_DEFAULT_REGION="us-east-1"
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export KARPENTER_VERSION="v0.37.0"
export KARPENTER_NAMESPACE="kube-system"

# Create IAM roles
eksctl create iamserviceaccount \
  --name karpenter \
  --namespace "${KARPENTER_NAMESPACE}" \
  --cluster "${CLUSTER_NAME}" \
  --role-name "KarpenterControllerRole-${CLUSTER_NAME}" \
  --attach-policy-arn "arn:aws:iam::${AWS_ACCOUNT_ID}:policy/KarpenterControllerPolicy-${CLUSTER_NAME}" \
  --approve

# Install Karpenter
helm upgrade --install karpenter oci://public.ecr.aws/karpenter/karpenter \
  --version "${KARPENTER_VERSION}" \
  --namespace "${KARPENTER_NAMESPACE}" \
  --set "settings.clusterName=${CLUSTER_NAME}" \
  --set "settings.interruptionQueue=${CLUSTER_NAME}" \
  --set controller.resources.requests.cpu=250m \
  --set controller.resources.requests.memory=256Mi \
  --wait
```

### NodePool for Spot Instances with Fallback

```yaml
# karpenter-nodepool-spot.yaml
apiVersion: karpenter.sh/v1beta1
kind: NodePool
metadata:
  name: spot-general
spec:
  template:
    metadata:
      labels:
        node.kubernetes.io/instance-type-category: spot
        cost-center: engineering
    spec:
      nodeClassRef:
        apiVersion: karpenter.k8s.aws/v1beta1
        kind: EC2NodeClass
        name: general-purpose
      requirements:
        - key: karpenter.sh/capacity-type
          operator: In
          values:
            - spot
            - on-demand  # Fallback when spot unavailable
        - key: kubernetes.io/arch
          operator: In
          values:
            - amd64
        - key: karpenter.k8s.aws/instance-category
          operator: In
          values:
            - c
            - m
            - r
        - key: karpenter.k8s.aws/instance-generation
          operator: Gt
          values:
            - "3"
        - key: karpenter.k8s.aws/instance-size
          operator: In
          values:
            - xlarge
            - 2xlarge
            - 4xlarge
      taints:
        - key: "node.kubernetes.io/spot"
          value: "true"
          effect: PreferNoSchedule
  limits:
    cpu: "1000"
    memory: "4000Gi"
  disruption:
    consolidationPolicy: WhenUnderutilized
    consolidateAfter: 30s
    expireAfter: 720h  # 30 days max lifetime for security patching
  weight: 10
---
apiVersion: karpenter.k8s.aws/v1beta1
kind: EC2NodeClass
metadata:
  name: general-purpose
spec:
  amiFamily: AL2023
  role: "KarpenterNodeRole-acme-production"
  subnetSelectorTerms:
    - tags:
        karpenter.sh/discovery: "acme-production"
  securityGroupSelectorTerms:
    - tags:
        karpenter.sh/discovery: "acme-production"
  blockDeviceMappings:
    - deviceName: /dev/xvda
      ebs:
        volumeSize: 100Gi
        volumeType: gp3
        iops: 3000
        throughput: 125
        encrypted: true
  metadataOptions:
    httpEndpoint: enabled
    httpProtocolIPv6: disabled
    httpPutResponseHopLimit: 1
    httpTokens: required
  tags:
    Environment: production
    ManagedBy: karpenter
```

### NodePool for On-Demand Critical Workloads

```yaml
# karpenter-nodepool-ondemand.yaml
apiVersion: karpenter.sh/v1beta1
kind: NodePool
metadata:
  name: ondemand-critical
spec:
  template:
    metadata:
      labels:
        node.kubernetes.io/instance-type-category: on-demand
    spec:
      nodeClassRef:
        apiVersion: karpenter.k8s.aws/v1beta1
        kind: EC2NodeClass
        name: general-purpose
      requirements:
        - key: karpenter.sh/capacity-type
          operator: In
          values:
            - on-demand
        - key: karpenter.k8s.aws/instance-category
          operator: In
          values:
            - m
        - key: karpenter.k8s.aws/instance-generation
          operator: Gt
          values:
            - "5"
  limits:
    cpu: "500"
    memory: "2000Gi"
  disruption:
    consolidationPolicy: WhenEmpty
    consolidateAfter: 60s
  weight: 100  # Higher weight = preferred for critical workloads
```

### Pod Disruption Budget for Spot Safety

```yaml
# pdb-payment-service.yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: payment-service-pdb
  namespace: payments
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: payment-service
```

### Tolerations for Spot Nodes

```yaml
# Add to Deployment spec for workloads that can run on spot
spec:
  template:
    spec:
      tolerations:
        - key: "node.kubernetes.io/spot"
          operator: "Exists"
          effect: "PreferNoSchedule"
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: karpenter.sh/capacity-type
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: payment-service
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: payment-service
```

## Section 4: Namespace-Level Cost Allocation with Kubecost

Kubecost provides granular cost visibility by parsing Kubernetes resource requests and actual usage, then attributing costs to namespaces, labels, and teams.

### Kubecost Installation

```bash
helm repo add kubecost https://kubecost.github.io/cost-analyzer/
helm repo update

helm upgrade --install kubecost kubecost/cost-analyzer \
  --namespace kubecost \
  --create-namespace \
  --set kubecostToken="your-kubecost-token" \
  --set prometheus.server.global.external_labels.cluster_id="acme-production" \
  --set global.prometheus.enabled=true \
  --set global.grafana.enabled=true \
  --set global.notifications.alertConfigs.alerts[0].type=budget \
  --set global.notifications.alertConfigs.alerts[0].threshold=1000 \
  --set global.notifications.alertConfigs.alerts[0].window=weekly \
  --set global.notifications.alertConfigs.alerts[0].aggregation=namespace \
  --set global.notifications.alertConfigs.alerts[0].filter=payments \
  --set global.notifications.slackWebhookUrl="https://hooks.slack.com/services/your/webhook/url" \
  --version 2.5.0 \
  --wait
```

### Cost Allocation Labels

```yaml
# All namespaces should have cost center labels
apiVersion: v1
kind: Namespace
metadata:
  name: payments
  labels:
    team: payments-team
    cost-center: "CC-1042"
    environment: production
    business-unit: ecommerce
```

### Kubecost Allocation API Query

```bash
# Query cost for the last 7 days, aggregated by namespace
curl -s "http://kubecost.kubecost.svc.cluster.local:9090/model/allocation?window=7d&aggregate=namespace&includeIdle=true" | \
  python3 -c "
import json, sys
data = json.load(sys.stdin)
results = data.get('data', [{}])[0]
rows = []
for ns, cost in results.items():
    rows.append({
        'namespace': ns,
        'total_cost': round(cost.get('totalCost', 0), 2),
        'cpu_cost': round(cost.get('cpuCost', 0), 2),
        'ram_cost': round(cost.get('ramCost', 0), 2),
        'pv_cost': round(cost.get('pvCost', 0), 2),
        'network_cost': round(cost.get('networkCost', 0), 2),
        'efficiency': round(cost.get('totalEfficiency', 0) * 100, 1)
    })
rows.sort(key=lambda x: x['total_cost'], reverse=True)
print(f'{'Namespace':<30} {'Total':<12} {'CPU':<10} {'Memory':<10} {'Storage':<10} {'Efficiency%'}')
print('-' * 90)
for r in rows[:20]:
    print(f'{r[\"namespace\"]:<30} \${r[\"total_cost\"]:<11.2f} \${r[\"cpu_cost\"]:<9.2f} \${r[\"ram_cost\"]:<9.2f} \${r[\"pv_cost\"]:<9.2f} {r[\"efficiency\"]}%')
"
```

### Team Budget Alerts

```yaml
# kubecost-budget-alerts.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: kubecost-alerts
  namespace: kubecost
data:
  alerts.yaml: |
    alerts:
      - type: budget
        threshold: 5000
        window: weekly
        aggregation: namespace
        filter: payments
        slackWebhookUrl: https://hooks.slack.com/services/your/webhook/url
        ownerContact:
          - payments-leads@acme.com
      - type: budget
        threshold: 3000
        window: weekly
        aggregation: namespace
        filter: orders
        slackWebhookUrl: https://hooks.slack.com/services/your/webhook/url
      - type: efficiency
        threshold: 0.35
        window: daily
        aggregation: namespace
        slackWebhookUrl: https://hooks.slack.com/services/your/webhook/url
        description: "Namespace efficiency below 35% — review resource requests"
```

## Section 5: Commitment Discounts — Reserved Instances and Savings Plans

On-demand pricing is 30-60% more expensive than 1-year reserved instances. The key is matching commitment to predictable baseline load, leaving variable capacity to Spot.

### AWS Savings Plans Analysis

```bash
# Install AWS Cost Explorer CLI wrapper
pip3 install boto3

python3 <<'PYEOF'
import boto3
from datetime import datetime, timedelta

ce = boto3.client('ce', region_name='us-east-1')

# Get last 30 days of EC2 spend
end = datetime.now().strftime('%Y-%m-%d')
start = (datetime.now() - timedelta(days=30)).strftime('%Y-%m-%d')

response = ce.get_cost_and_usage(
    TimePeriod={'Start': start, 'End': end},
    Granularity='MONTHLY',
    Filter={
        'Dimensions': {
            'Key': 'SERVICE',
            'Values': ['Amazon Elastic Compute Cloud - Compute']
        }
    },
    Metrics=['UnblendedCost', 'UsageQuantity'],
    GroupBy=[
        {'Type': 'DIMENSION', 'Key': 'INSTANCE_TYPE'},
        {'Type': 'DIMENSION', 'Key': 'PURCHASE_OPTION'},
    ]
)

print("Current EC2 spend by instance type and purchase option:")
for result in response['ResultsByTime']:
    for group in result['Groups']:
        instance_type = group['Keys'][0]
        purchase_option = group['Keys'][1]
        cost = float(group['Metrics']['UnblendedCost']['Amount'])
        if cost > 100:
            print(f"  {instance_type:<20} {purchase_option:<20} ${cost:.2f}/month")
PYEOF
```

### Savings Plan Recommendations

```bash
# Get AWS Savings Plan recommendations
aws ce get-savings-plans-purchase-recommendation \
  --savings-plans-type COMPUTE_SP \
  --term-in-years ONE_YEAR \
  --payment-option NO_UPFRONT \
  --lookback-period-in-days THIRTY_DAYS \
  --query 'SavingsPlansPurchaseRecommendation.{
    EstimatedSavingsAmount:SavingsPlansPurchaseRecommendationSummary.EstimatedSavingsAmount,
    EstimatedSavingsPercentage:SavingsPlansPurchaseRecommendationSummary.EstimatedSavingsPercentage,
    HourlyCommitment:SavingsPlansPurchaseRecommendationSummary.HourlyCommitmentToPurchase
  }' \
  --output table
```

### GCP Committed Use Discount Analysis

```bash
# List current GKE node pool machine types for CUD planning
gcloud container node-pools list \
  --cluster=acme-production \
  --region=us-central1 \
  --format="table(name,config.machineType,autoscaling.minNodeCount,autoscaling.maxNodeCount)"

# Get commitment recommendations
gcloud recommender recommendations list \
  --recommender=google.compute.commitment.UsageCommitmentRecommender \
  --location=us-central1 \
  --project=acme-production \
  --format="table(description,primaryImpact.costProjection.cost.units,primaryImpact.costProjection.cost.currencyCode)"
```

## Section 6: Cluster Consolidation and Bin-Packing

Over time, Kubernetes clusters accumulate wasted capacity from poor bin-packing. Node consolidation reclaims this waste.

### Karpenter Consolidation Tuning

```yaml
# Aggressive consolidation NodePool settings
spec:
  disruption:
    consolidationPolicy: WhenUnderutilized
    consolidateAfter: 30s
    budgets:
      - schedule: "0 9 * * MON-FRI"  # Business hours — be conservative
        duration: 8h
        nodes: "10%"
      - schedule: "0 17 * * MON-FRI"  # After hours — aggressive
        duration: 16h
        nodes: "50%"
      - schedule: "0 0 * * SAT-SUN"   # Weekend — very aggressive
        duration: 48h
        nodes: "80%"
```

### Identifying Oversized Nodes

```bash
# Find nodes with low utilization
kubectl top nodes | awk '
NR==1 {print; next}
{
  cpu_used = $2
  cpu_pct = $3
  mem_used = $4
  mem_pct = $5
  gsub(/%/, "", cpu_pct)
  gsub(/%/, "", mem_pct)
  if (cpu_pct+0 < 30 && mem_pct+0 < 40) {
    printf "LOW UTIL: %s CPU=%s(%s%%) MEM=%s(%s%%)\n", $1, cpu_used, cpu_pct, mem_used, mem_pct
  }
}'
```

### Namespace Resource Quotas for Cost Control

```yaml
# resource-quota-payments.yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: payments-quota
  namespace: payments
spec:
  hard:
    requests.cpu: "50"
    requests.memory: "200Gi"
    limits.cpu: "100"
    limits.memory: "400Gi"
    persistentvolumeclaims: "20"
    requests.storage: "500Gi"
    count/services.loadbalancers: "5"
    count/pods: "200"
---
apiVersion: v1
kind: LimitRange
metadata:
  name: payments-limits
  namespace: payments
spec:
  limits:
    - type: Container
      default:
        cpu: "500m"
        memory: "512Mi"
      defaultRequest:
        cpu: "100m"
        memory: "128Mi"
      max:
        cpu: "4000m"
        memory: "8Gi"
      min:
        cpu: "50m"
        memory: "64Mi"
    - type: PersistentVolumeClaim
      max:
        storage: "100Gi"
      min:
        storage: "1Gi"
```

## Section 7: Storage Cost Optimization

Storage is often the most neglected cost category. Unused PVCs, oversized volumes, and expensive storage classes accumulate silently.

### Identify Unused PersistentVolumes

```bash
#!/bin/bash
# find-unused-pvcs.sh
echo "=== Unused PersistentVolumeClaims ==="
kubectl get pvc --all-namespaces -o json | python3 -c "
import json, sys, subprocess

pvcs = json.load(sys.stdin)
pods_json = subprocess.check_output(['kubectl', 'get', 'pods', '--all-namespaces', '-o', 'json']).decode()
pods = json.loads(pods_json)

# Build set of all PVC names in use
used_pvcs = set()
for pod in pods['items']:
    ns = pod['metadata']['namespace']
    for vol in pod.get('spec', {}).get('volumes', []):
        claim = vol.get('persistentVolumeClaim', {}).get('claimName')
        if claim:
            used_pvcs.add(f'{ns}/{claim}')

# Find unused
print(f'{'Namespace':<25} {'Name':<40} {'Size':<10} {'StorageClass':<20} {'Status'}')
print('-' * 105)
for pvc in pvcs['items']:
    ns = pvc['metadata']['namespace']
    name = pvc['metadata']['name']
    key = f'{ns}/{name}'
    size = pvc['spec'].get('resources', {}).get('requests', {}).get('storage', 'N/A')
    sc = pvc['spec'].get('storageClassName', 'default')
    status = pvc['status'].get('phase', 'Unknown')
    if key not in used_pvcs:
        print(f'{ns:<25} {name:<40} {size:<10} {sc:<20} UNUSED-{status}')
"
```

### Storage Class Cost Tiers

```yaml
# storage-classes.yaml
# Premium tier — for databases requiring IOPS
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: premium-ssd
  annotations:
    storageclass.kubernetes.io/is-default-class: "false"
provisioner: ebs.csi.aws.com
parameters:
  type: io2
  iopsPerGB: "50"
  encrypted: "true"
allowVolumeExpansion: true
reclaimPolicy: Retain
volumeBindingMode: WaitForFirstConsumer
---
# Standard tier — for general workloads
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: standard-ssd
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  throughput: "125"
  iops: "3000"
  encrypted: "true"
allowVolumeExpansion: true
reclaimPolicy: Delete
volumeBindingMode: WaitForFirstConsumer
---
# Archive tier — for logs and backups
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: archive-hdd
provisioner: ebs.csi.aws.com
parameters:
  type: sc1
  encrypted: "true"
allowVolumeExpansion: true
reclaimPolicy: Delete
volumeBindingMode: WaitForFirstConsumer
```

### Automated Volume Cleanup CronJob

```yaml
# pvc-cleanup-cronjob.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: pvc-cleanup-reporter
  namespace: platform
spec:
  schedule: "0 8 * * MON"
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: pvc-reporter
          containers:
            - name: reporter
              image: bitnami/kubectl:1.29
              command:
                - /bin/bash
                - -c
                - |
                  echo "=== Weekly PVC Report ===" | tee /tmp/report.txt
                  kubectl get pvc --all-namespaces \
                    -o custom-columns='NAMESPACE:.metadata.namespace,NAME:.metadata.name,STATUS:.status.phase,CAPACITY:.status.capacity.storage,STORAGECLASS:.spec.storageClassName,AGE:.metadata.creationTimestamp' | \
                    tee -a /tmp/report.txt

                  # Post to Slack
                  curl -s -X POST "${SLACK_WEBHOOK_URL}" \
                    -H 'Content-type: application/json' \
                    --data "{\"text\": \"$(cat /tmp/report.txt | head -50)\"}"
              env:
                - name: SLACK_WEBHOOK_URL
                  valueFrom:
                    secretKeyRef:
                      name: slack-webhook
                      key: url
          restartPolicy: OnFailure
```

## Section 8: Egress Cost Reduction

Cross-AZ traffic is billed at $0.01/GB in AWS. For high-throughput clusters, this adds up to thousands of dollars monthly.

### Topology-Aware Routing

```yaml
# Enable topology hints on Service objects
apiVersion: v1
kind: Service
metadata:
  name: payment-service
  namespace: payments
  annotations:
    service.kubernetes.io/topology-mode: Auto
spec:
  selector:
    app: payment-service
  ports:
    - port: 8080
      targetPort: 8080
  type: ClusterIP
```

### Cilium Topology-Aware Load Balancing

```yaml
# cilium-config-topology.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: cilium-config
  namespace: kube-system
data:
  enable-local-redirect-policy: "true"
  k8s-require-ipv4-pod-cidr: "true"
  # Prefer local endpoint selection
  load-balancer-mode: hybrid
  # Reduce cross-AZ traffic
  routing-mode: native
```

### Monitor Cross-AZ Traffic

```bash
# Install Kubecost network cost tracking
helm upgrade kubecost kubecost/cost-analyzer \
  --namespace kubecost \
  --set networkCosts.enabled=true \
  --set networkCosts.podMonitor.enabled=true \
  --reuse-values

# Query network costs by namespace
curl -s "http://kubecost.kubecost.svc.cluster.local:9090/model/allocation?window=7d&aggregate=namespace" | \
  python3 -c "
import json, sys
data = json.load(sys.stdin)
results = data.get('data', [{}])[0]
print(f'{'Namespace':<30} {'Network Cost':<15} {'Egress Cost'}')
for ns, cost in sorted(results.items(), key=lambda x: x[1].get('networkCost', 0), reverse=True)[:15]:
    nc = cost.get('networkCost', 0)
    if nc > 1:
        print(f'{ns:<30} \${nc:.2f}')
"
```

## Section 9: OpenCost Cost Dashboard

OpenCost is the CNCF-sandbox cost monitoring project that provides an open standard for Kubernetes cost allocation.

### OpenCost Installation

```bash
helm repo add opencost https://opencost.github.io/opencost-helm-chart
helm repo update

helm upgrade --install opencost opencost/opencost \
  --namespace opencost \
  --create-namespace \
  --set opencost.exporter.cloudProviderApiKey="" \
  --set opencost.prometheus.external.enabled=true \
  --set opencost.prometheus.external.url="http://prometheus-operated.monitoring.svc.cluster.local:9090" \
  --set opencost.ui.enabled=true \
  --version 1.40.0 \
  --wait
```

### Grafana Dashboard for OpenCost

```json
{
  "dashboard": {
    "title": "Kubernetes FinOps Dashboard",
    "panels": [
      {
        "title": "Daily Cluster Cost",
        "type": "stat",
        "targets": [
          {
            "expr": "sum(opencost_total_cost_hourly) * 24",
            "legendFormat": "Daily Cost USD"
          }
        ]
      },
      {
        "title": "Cost by Namespace (7d)",
        "type": "bargauge",
        "targets": [
          {
            "expr": "sum by (namespace) (increase(opencost_total_cost_hourly[7d])) > 0",
            "legendFormat": "{{ namespace }}"
          }
        ]
      },
      {
        "title": "CPU Efficiency by Namespace",
        "type": "table",
        "targets": [
          {
            "expr": "sum by (namespace) (rate(container_cpu_usage_seconds_total{container!=''}[5m])) / sum by (namespace) (kube_pod_container_resource_requests{resource='cpu'})",
            "legendFormat": "{{ namespace }}"
          }
        ]
      },
      {
        "title": "Memory Efficiency by Namespace",
        "type": "table",
        "targets": [
          {
            "expr": "sum by (namespace) (container_memory_working_set_bytes{container!=''}) / sum by (namespace) (kube_pod_container_resource_requests{resource='memory'})",
            "legendFormat": "{{ namespace }}"
          }
        ]
      }
    ]
  }
}
```

### Monthly Cost Report Script

```bash
#!/bin/bash
# monthly-cost-report.sh
set -euo pipefail

OPENCOST_URL="${OPENCOST_URL:-http://opencost.opencost.svc.cluster.local:9003}"
MONTH="${1:-$(date -d 'last month' '+%Y-%m')}"
YEAR="${MONTH%-*}"
MONTH_NUM="${MONTH#*-}"
START="${YEAR}-${MONTH_NUM}-01T00:00:00Z"
END="${YEAR}-${MONTH_NUM}-$(date -d "${YEAR}-${MONTH_NUM}-01 +1 month -1 day" '+%d')T23:59:59Z"

echo "=== Monthly Cost Report: ${MONTH} ==="
echo

curl -s "${OPENCOST_URL}/allocation/compute?window=${START},${END}&aggregate=namespace&step=monthly" | \
  python3 -c "
import json, sys
data = json.load(sys.stdin)
allocations = data.get('data', [{}])[0]

total = 0
rows = []
for ns, alloc in allocations.items():
    cost = alloc.get('totalCost', 0)
    total += cost
    rows.append((ns, cost, alloc.get('cpuCost', 0), alloc.get('ramCost', 0), alloc.get('pvCost', 0)))

rows.sort(key=lambda x: x[1], reverse=True)
print(f'{'Namespace':<30} {'Total':>12} {'CPU':>10} {'Memory':>10} {'Storage':>10}')
print('-' * 75)
for ns, cost, cpu, ram, pv in rows:
    print(f'{ns:<30} \${cost:>11.2f} \${cpu:>9.2f} \${ram:>9.2f} \${pv:>9.2f}')
print('-' * 75)
print(f'{'TOTAL':<30} \${total:>11.2f}')
"
```

## Section 10: Cost Governance Automation

### Admission Webhook for Resource Requests

```yaml
# ValidatingAdmissionPolicy to require resource requests
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: require-resource-requests
spec:
  failurePolicy: Fail
  matchConstraints:
    resourceRules:
      - apiGroups: ["apps"]
        apiVersions: ["v1"]
        operations: ["CREATE", "UPDATE"]
        resources: ["deployments"]
  validations:
    - expression: |
        object.spec.template.spec.containers.all(c,
          has(c.resources) &&
          has(c.resources.requests) &&
          has(c.resources.requests.cpu) &&
          has(c.resources.requests.memory)
        )
      message: "All containers must specify CPU and memory resource requests"
    - expression: |
        object.spec.template.spec.containers.all(c,
          !has(c.resources.limits) ||
          !has(c.resources.limits.cpu) ||
          quantity(c.resources.limits.cpu) <= quantity('8000m')
        )
      message: "CPU limits must not exceed 8000m per container"
---
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicyBinding
metadata:
  name: require-resource-requests-binding
spec:
  policyName: require-resource-requests
  validationActions: [Deny]
  matchResources:
    namespaceSelector:
      matchExpressions:
        - key: environment
          operator: In
          values:
            - production
            - staging
```

## Summary

A mature FinOps practice for Kubernetes typically achieves 25-40% cost reduction within six months. The highest-impact changes in priority order are:

1. Karpenter spot adoption — 40-70% compute savings on eligible workloads
2. Resource request rightsizing via VPA — 20-30% compute reduction
3. Cluster consolidation — 10-20% savings from improved bin-packing
4. Commitment discounts on baseline — 30-45% savings on reserved capacity
5. Storage class tiering — 15-30% storage savings
6. Cross-AZ traffic reduction — variable but significant for high-throughput services

Combine these with showback/chargeback dashboards in Kubecost or OpenCost to create team accountability, and integrate cost gates into CI/CD pipelines to prevent new inefficiencies from entering production.
