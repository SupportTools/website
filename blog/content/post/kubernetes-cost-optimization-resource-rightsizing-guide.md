---
title: "Kubernetes Cost Optimization: Resource Rightsizing, Spot Instances, and FinOps"
date: 2027-09-03T00:00:00-05:00
draft: false
tags: ["Kubernetes", "FinOps", "Cost Optimization", "Autoscaling"]
categories:
- Kubernetes
- FinOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Kubernetes cost optimization strategies covering VPA for resource rightsizing, Goldilocks recommendations, spot and preemptible node pools with graceful handling, Karpenter for bin-packing, namespace-level cost allocation, and Kubecost for chargeback."
more_link: "yes"
url: "/kubernetes-cost-optimization-resource-rightsizing-guide/"
---

Kubernetes clusters typically run at 15-30% actual CPU and memory utilization against their provisioned capacity, making resource over-provisioning the single largest driver of cloud infrastructure waste. Addressing this waste requires three complementary approaches: rightsizing individual container resource requests using vertical autoscaling recommendations, maximizing node utilization through intelligent bin-packing with Karpenter, and reducing compute costs by shifting fault-tolerant workloads to spot or preemptible instances. This guide provides production-ready implementations for each approach, with namespace-level cost allocation for organizational chargeback.

<!--more-->

## Section 1: Understanding Resource Waste Patterns

### Measuring Actual vs. Requested Resources

```bash
# CPU request vs. actual utilization for all containers
kubectl get pods --all-namespaces -o json | \
  jq -r '
    .items[] |
    .metadata.namespace as $ns |
    .metadata.name as $pod |
    .spec.containers[] |
    [$ns, $pod, .name,
     (.resources.requests.cpu // "none"),
     (.resources.limits.cpu // "none")] |
    @tsv
  ' | head -50

# Prometheus query: namespace-level CPU efficiency
# (actual usage / requested) × 100
# kubectl port-forward -n monitoring svc/prometheus-operated 9090:9090
curl -s "http://localhost:9090/api/v1/query?query=$(python3 -c "import urllib.parse; print(urllib.parse.quote('''
sum by (namespace) (
  rate(container_cpu_usage_seconds_total{container!=\"\",container!=\"POD\"}[30m])
) /
sum by (namespace) (
  kube_pod_container_resource_requests{resource=\"cpu\",container!=\"\"}
) * 100
''')
")" | jq -r '.data.result[] | [.metric.namespace, .value[1]|tonumber|round] | @tsv' | sort -t$'\t' -k2 -n
```

### Cluster-Level Waste Estimate

```bash
# Script: estimate monthly waste from over-provisioned requests
#!/usr/bin/env bash
set -euo pipefail

PROM_URL="${PROM_URL:-http://localhost:9090}"

# Cost constants (adjust for your cloud provider and region)
CPU_COST_PER_CORE_HOUR=0.048   # USD
MEM_COST_PER_GB_HOUR=0.006     # USD
HOURS_PER_MONTH=730

# Fetch actual vs. requested CPU
CPU_WASTE=$(curl -s "${PROM_URL}/api/v1/query?query=$(python3 -c "
import urllib.parse
q = 'sum(kube_pod_container_resource_requests{resource=\"cpu\",container!=\"\"}) - sum(rate(container_cpu_usage_seconds_total{container!=\"\",container!=\"POD\"}[1h]))'
print(urllib.parse.quote(q))
")" | jq -r '.data.result[0].value[1]')

MEM_WASTE=$(curl -s "${PROM_URL}/api/v1/query?query=$(python3 -c "
import urllib.parse
q = '(sum(kube_pod_container_resource_requests{resource=\"memory\",container!=\"\"}) - sum(container_memory_working_set_bytes{container!=\"\",container!=\"POD\"})) / 1073741824'
print(urllib.parse.quote(q))
")" | jq -r '.data.result[0].value[1]')

CPU_WASTE_COST=$(echo "$CPU_WASTE * $CPU_COST_PER_CORE_HOUR * $HOURS_PER_MONTH" | bc -l)
MEM_WASTE_COST=$(echo "$MEM_WASTE * $MEM_COST_PER_GB_HOUR * $HOURS_PER_MONTH" | bc -l)
TOTAL=$(echo "$CPU_WASTE_COST + $MEM_WASTE_COST" | bc -l)

printf "CPU waste: %.2f cores → \$%.2f/month\n" "$CPU_WASTE" "$CPU_WASTE_COST"
printf "Memory waste: %.2f GB → \$%.2f/month\n" "$MEM_WASTE" "$MEM_WASTE_COST"
printf "Total estimated waste: \$%.2f/month\n" "$TOTAL"
```

## Section 2: Vertical Pod Autoscaler (VPA) for Rightsizing

### VPA Installation

```bash
git clone https://github.com/kubernetes/autoscaler.git
cd autoscaler/vertical-pod-autoscaler
./hack/vpa-up.sh

# Verify components
kubectl get pods -n kube-system | grep vpa
# vpa-admission-controller-xxxx   1/1     Running   0   60s
# vpa-recommender-xxxx             1/1     Running   0   60s
# vpa-updater-xxxx                 1/1     Running   0   60s
```

### VPA in Recommendation-Only Mode (Safe Starting Point)

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
    updateMode: "Off"    # Recommendation only; no automatic pod restarts
  resourcePolicy:
    containerPolicies:
    - containerName: api
      minAllowed:
        cpu: 50m
        memory: 64Mi
      maxAllowed:
        cpu: 2
        memory: 4Gi
      controlledResources: ["cpu", "memory"]
      controlledValues: RequestsAndLimits
```

```bash
# Read VPA recommendations after 24 hours of traffic
kubectl get vpa api-service-vpa -n production -o jsonpath='{.status.recommendation}' | jq .
# {
#   "containerRecommendations": [
#     {
#       "containerName": "api",
#       "lowerBound": {"cpu": "80m", "memory": "128Mi"},
#       "target": {"cpu": "150m", "memory": "256Mi"},
#       "uncappedTarget": {"cpu": "148m", "memory": "241Mi"},
#       "upperBound": {"cpu": "300m", "memory": "512Mi"}
#     }
#   ]
# }
```

### VPA Auto Mode with Disruption Budget

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: worker-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: worker
  updatePolicy:
    updateMode: "Auto"
    minReplicas: 2    # Minimum replicas during eviction
  resourcePolicy:
    containerPolicies:
    - containerName: worker
      minAllowed:
        cpu: 100m
        memory: 128Mi
      maxAllowed:
        cpu: 4
        memory: 8Gi
```

## Section 3: Goldilocks for Team-Friendly Recommendations

Goldilocks wraps VPA recommendations in a web UI and Slack notifications.

```bash
helm repo add fairwinds-stable https://charts.fairwinds.com/stable
helm install goldilocks fairwinds-stable/goldilocks \
  --namespace goldilocks \
  --create-namespace \
  --set dashboard.enabled=true \
  --set dashboard.ingress.enabled=true \
  --set dashboard.ingress.hosts[0].host=goldilocks.internal.example.com

# Enable recommendations for a namespace
kubectl label namespace production goldilocks.fairwinds.com/enabled=true
```

### Goldilocks Namespace Report

```bash
# Get recommendations as Helm-compatible values
kubectl goldilocks summary --namespace production --output yaml
# containers:
#   api:
#     requests:
#       cpu: 150m
#       memory: 256Mi
#     limits:
#       cpu: 300m
#       memory: 512Mi
```

## Section 4: Karpenter for Efficient Bin-Packing

Karpenter replaces the Cluster Autoscaler with a more efficient, workload-aware node provisioner that selects optimal instance types for each batch of pending pods.

### Karpenter Installation (AWS)

```bash
# Set environment variables
export CLUSTER_NAME=production-us-east-1
export AWS_DEFAULT_REGION=us-east-1
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# Create IAM role for Karpenter
eksctl create iamserviceaccount \
  --cluster "${CLUSTER_NAME}" \
  --namespace karpenter \
  --name karpenter \
  --role-name "KarpenterControllerRole-${CLUSTER_NAME}" \
  --attach-policy-arn "arn:aws:iam::${AWS_ACCOUNT_ID}:policy/KarpenterControllerPolicy-${CLUSTER_NAME}" \
  --approve

# Install Karpenter
helm registry login public.ecr.aws
helm upgrade --install karpenter oci://public.ecr.aws/karpenter/karpenter \
  --version "0.37.0" \
  --namespace karpenter \
  --create-namespace \
  --set settings.clusterName="${CLUSTER_NAME}" \
  --set settings.interruptionQueue="${CLUSTER_NAME}" \
  --set controller.resources.requests.cpu=1 \
  --set controller.resources.requests.memory=1Gi \
  --set controller.resources.limits.cpu=1 \
  --set controller.resources.limits.memory=1Gi \
  --wait
```

### NodePool Configuration

```yaml
apiVersion: karpenter.sh/v1beta1
kind: NodePool
metadata:
  name: general-purpose
spec:
  template:
    metadata:
      labels:
        node-pool: general-purpose
      annotations:
        cluster-autoscaler.kubernetes.io/safe-to-evict: "true"
    spec:
      nodeClassRef:
        apiVersion: karpenter.k8s.aws/v1beta1
        kind: EC2NodeClass
        name: default
      requirements:
      - key: karpenter.sh/capacity-type
        operator: In
        values: ["spot", "on-demand"]
      - key: kubernetes.io/arch
        operator: In
        values: ["amd64"]
      - key: karpenter.k8s.aws/instance-category
        operator: In
        values: ["c", "m", "r"]
      - key: karpenter.k8s.aws/instance-generation
        operator: Gt
        values: ["3"]
      - key: karpenter.k8s.aws/instance-size
        operator: NotIn
        values: ["nano", "micro", "small", "medium"]
      # Avoid burstable instances for consistent workloads
      - key: karpenter.k8s.aws/instance-cpu-manufacturer
        operator: In
        values: ["intel", "amd"]
      taints: []
  disruption:
    consolidationPolicy: WhenUnderutilized
    consolidateAfter: 30s
    budgets:
    - nodes: "10%"   # Max 10% of nodes consolidated at once
      schedule: "@daily"
      duration: 4h
  limits:
    cpu: 1000
    memory: 4000Gi
  weight: 10
```

### EC2NodeClass for Spot Configuration

```yaml
apiVersion: karpenter.k8s.aws/v1beta1
kind: EC2NodeClass
metadata:
  name: default
spec:
  amiFamily: AL2023
  role: "KarpenterNodeRole-${CLUSTER_NAME}"
  subnetSelectorTerms:
  - tags:
      karpenter.sh/discovery: "${CLUSTER_NAME}"
  securityGroupSelectorTerms:
  - tags:
      karpenter.sh/discovery: "${CLUSTER_NAME}"
  instanceStorePolicy: RAID0    # Use NVMe instance store for temp data

  blockDeviceMappings:
  - deviceName: /dev/xvda
    ebs:
      volumeSize: 100Gi
      volumeType: gp3
      iops: 3000
      throughput: 125
      encrypted: true

  detailedMonitoring: true
  userData: |
    #!/bin/bash
    # Configure kubelet for spot-aware graceful shutdown
    cat > /etc/kubernetes/kubelet/kubelet-custom.conf <<EOF
    [Service]
    Environment="KUBELET_EXTRA_ARGS=--shutdown-grace-period=60s --shutdown-grace-period-critical-pods=10s"
    EOF
    systemctl daemon-reload
    systemctl restart kubelet
```

### Spot Interruption Handling

```yaml
# Node Termination Handler for Spot interruption warnings
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: aws-node-termination-handler
  namespace: kube-system
spec:
  template:
    spec:
      containers:
      - name: node-termination-handler
        image: public.ecr.aws/aws-ec2/aws-node-termination-handler:v1.22.0
        env:
        - name: ENABLE_SPOT_INTERRUPTION_DRAINING
          value: "true"
        - name: ENABLE_SCHEDULED_EVENT_DRAINING
          value: "true"
        - name: DRAIN_TIMEOUT
          value: "120"
        - name: NODE_TERMINATION_GRACE_PERIOD
          value: "120"
        - name: WEBHOOK_URL
          valueFrom:
            secretKeyRef:
              name: nth-webhook-secret
              key: url
```

### Workload Spot Tolerance

```yaml
# Mark spot-tolerant workloads
apiVersion: apps/v1
kind: Deployment
metadata:
  name: batch-processor
  namespace: production
spec:
  template:
    spec:
      tolerations:
      - key: karpenter.sh/capacity-type
        operator: Equal
        value: spot
        effect: NoSchedule
      affinity:
        nodeAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            preference:
              matchExpressions:
              - key: karpenter.sh/capacity-type
                operator: In
                values: ["spot"]
      # Graceful termination for spot
      terminationGracePeriodSeconds: 90
      containers:
      - name: processor
        lifecycle:
          preStop:
            exec:
              command: ["/bin/sh", "-c", "kill -SIGTERM 1 && sleep 60"]
```

## Section 5: Namespace-Level Cost Allocation

### Label Enforcement for Cost Attribution

```yaml
# OPA Gatekeeper policy: require cost labels on namespaces
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequiredLabels
metadata:
  name: namespace-cost-labels
spec:
  match:
    kinds:
    - apiGroups: [""]
      kinds: ["Namespace"]
    excludedNamespaces: ["kube-system", "kube-public", "kube-node-lease"]
  parameters:
    labels:
    - key: cost-center
      allowedRegex: "^CC-[0-9]{4}$"
    - key: team
    - key: product
```

### Prometheus Cost Allocation Queries

```yaml
# PrometheusRule for cost allocation
groups:
- name: cost-allocation
  interval: 5m
  rules:
  # CPU cost per namespace (30-day rolling)
  - record: namespace:cpu_cost_usd:sum_rate30d
    expr: |
      sum by (namespace) (
        label_replace(
          rate(container_cpu_usage_seconds_total{container!="",container!="POD"}[5m]),
          "namespace", "$1", "namespace", "(.*)"
        )
      ) * 0.048 * 730    # $0.048/core-hour × 730 hours/month

  # Memory cost per namespace
  - record: namespace:memory_cost_usd:sum_rate30d
    expr: |
      sum by (namespace) (
        container_memory_working_set_bytes{container!="",container!="POD"}
      ) / 1073741824 * 0.006 * 730

  # Total cost per namespace
  - record: namespace:total_cost_usd:sum_rate30d
    expr: |
      namespace:cpu_cost_usd:sum_rate30d
      +
      namespace:memory_cost_usd:sum_rate30d
```

## Section 6: Kubecost for Chargeback

```bash
helm repo add kubecost https://kubecost.github.io/cost-analyzer
helm install kubecost kubecost/cost-analyzer \
  --namespace kubecost \
  --create-namespace \
  --set global.prometheus.fqdn=http://kube-prometheus-stack-prometheus.monitoring.svc.cluster.local:9090 \
  --set global.prometheus.enabled=false \
  --set kubecostToken="" \
  --set networkCosts.enabled=true \
  --set networkCosts.config.services.google-cloud-services=false \
  --set networkCosts.config.services.amazon-web-services=true \
  --wait
```

### Kubecost API for Automated Reporting

```bash
# Get namespace cost allocation for the last 30 days
curl -s "http://kubecost.kubecost.svc.cluster.local:9090/model/allocation?window=30d&aggregate=namespace&includeIdle=true" | \
  jq -r '.data[0] | to_entries | sort_by(.value.totalCost) | reverse | .[] | [.key, (.value.totalCost|.*100|round/100)] | @tsv' | \
  head -20

# Sample output:
# production          4821.32
# data-processing     2341.15
# staging             891.43
# development         234.12
```

### Cost Reporting Automation

```bash
#!/usr/bin/env bash
# Weekly cost report sent to Slack
KUBECOST_URL="http://kubecost.kubecost.svc.cluster.local:9090"
SLACK_WEBHOOK_URL="${SLACK_WEBHOOK_URL:?Set SLACK_WEBHOOK_URL env var}"

REPORT=$(curl -s "${KUBECOST_URL}/model/allocation?window=7d&aggregate=label:team&includeIdle=false" | \
  jq -r '
    .data[0] |
    to_entries |
    sort_by(.value.totalCost) |
    reverse |
    .[] |
    "• Team \(.key): $\(.value.totalCost | .*100 | round/100) (CPU: $\(.value.cpuCost | .*100 | round/100), Mem: $\(.value.ramCost | .*100 | round/100))"
  ' | head -10)

curl -s -X POST "${SLACK_WEBHOOK_URL}" \
  -H "Content-Type: application/json" \
  -d "{\"text\": \"*Weekly Kubernetes Cost Report*\n${REPORT}\"}"
```

## Section 7: LimitRange and ResourceQuota Enforcement

```yaml
# Enforce resource requests in each namespace
apiVersion: v1
kind: LimitRange
metadata:
  name: default-limits
  namespace: production
spec:
  limits:
  - type: Container
    default:
      cpu: 200m
      memory: 256Mi
    defaultRequest:
      cpu: 50m
      memory: 64Mi
    max:
      cpu: 4
      memory: 8Gi
    min:
      cpu: 10m
      memory: 16Mi
  - type: PersistentVolumeClaim
    max:
      storage: 500Gi
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: namespace-quota
  namespace: production
spec:
  hard:
    requests.cpu: "50"
    requests.memory: "100Gi"
    limits.cpu: "100"
    limits.memory: "200Gi"
    pods: "500"
    services.loadbalancers: "5"
    persistentvolumeclaims: "50"
    requests.storage: "2Ti"
```

## Section 8: KEDA for Event-Driven Scale-to-Zero

```yaml
# Scale workers to zero when no queue messages
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: batch-worker-scaler
  namespace: production
spec:
  scaleTargetRef:
    name: batch-worker
  minReplicaCount: 0       # Scale to zero when idle
  maxReplicaCount: 50
  pollingInterval: 15
  cooldownPeriod: 300
  triggers:
  - type: rabbitmq
    metadata:
      host: amqp://rabbitmq.production.svc.cluster.local:5672
      queueName: batch-jobs
      mode: QueueLength
      value: "5"      # 1 worker per 5 messages
  - type: cron
    metadata:
      timezone: "America/New_York"
      start: "0 8 * * 1-5"    # Pre-warm before business hours
      end: "0 6 * * 1-5"
      desiredReplicas: "3"
```

## Section 9: Horizontal Pod Autoscaler Tuning

Over-provisioned HPA stabilization windows waste money by maintaining excess capacity.

```yaml
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
  minReplicas: 2
  maxReplicas: 50
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70      # Target 70% CPU utilization
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80
  - type: Pods
    pods:
      metric:
        name: http_requests_per_second
      target:
        type: AverageValue
        averageValue: "100"
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300     # 5 minutes before scaling down
      policies:
      - type: Percent
        value: 20                          # Max 20% reduction per step
        periodSeconds: 60
    scaleUp:
      stabilizationWindowSeconds: 0        # Scale up immediately
      policies:
      - type: Percent
        value: 100                         # Double replicas per step
        periodSeconds: 15
      - type: Pods
        value: 5                           # Or add 5 pods, whichever is greater
        periodSeconds: 15
      selectPolicy: Max
```

## Summary

Kubernetes cost optimization delivers the highest return when applied as a system: VPA recommendations provide rightsizing data, Karpenter acts on that data by selecting optimally-sized nodes, spot instances reduce compute costs by 60-80% for fault-tolerant workloads, and KEDA eliminates idle capacity entirely for event-driven workloads. Kubecost closes the loop by attributing costs to teams and namespaces, enabling chargebacks that create the organizational incentives for developers to set accurate resource requests rather than padding estimates.
