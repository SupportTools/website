---
title: "Kubernetes Cost Optimization: Rightsizing, Spot Instances, and FinOps Practices"
date: 2028-03-07T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Cost Optimization", "FinOps", "VPA", "Spot Instances", "Goldilocks", "OpenCost"]
categories: ["Kubernetes", "FinOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes cost optimization covering VPA rightsizing, Goldilocks namespace advisor, Spot instance node groups, cluster bin packing, resource quotas, and OpenCost metrics for enterprise FinOps programs."
more_link: "yes"
url: "/kubernetes-cost-optimization-rightsizing-guide/"
---

Kubernetes clusters routinely waste 40–70% of provisioned cloud resources when teams set resource requests based on intuition rather than measurement. Enterprise FinOps programs address this waste systematically: measuring actual utilization, rightsizing workloads, shifting interruptible workloads to Spot capacity, densifying bin packing, and allocating costs to the teams responsible for them. This guide provides actionable implementations for each layer of Kubernetes cost optimization.

<!--more-->

## The Cost Waste Landscape

Before applying optimizations, understand the primary waste categories:

| Waste Category | Typical Contributor | Optimization Tool |
|---|---|---|
| Over-provisioned requests | Teams use "round numbers" | VPA + Goldilocks |
| Under-utilized on-demand nodes | Burstable or seasonal workloads | Spot/Preemptible instances |
| Orphaned persistent volumes | Deleted namespaces, staging drift | Idle resource detection |
| Idle cluster nodes | Poor bin packing | Descheduler + Karpenter |
| Untracked costs | Missing labels/tags | OpenCost + charge-back labels |

## VPA Recommendations for Rightsizing

The Vertical Pod Autoscaler (VPA) analyzes historical CPU and memory usage to generate requests/limits recommendations.

### Installing VPA

```bash
# Clone the VPA repo for the CRD and components
git clone https://github.com/kubernetes/autoscaler.git
cd autoscaler/vertical-pod-autoscaler

# Install using the provided script
./hack/vpa-up.sh
```

Verify VPA components are running:

```bash
kubectl get pods -n kube-system | grep vpa
# vpa-admission-controller-xxx   Running
# vpa-recommender-xxx            Running
# vpa-updater-xxx                Running
```

### Recommendation-Only VPA (Safe Baseline)

Use `Off` update mode to gather recommendations without changing running pods:

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: payment-service-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: payment-service
  updatePolicy:
    updateMode: "Off"  # Recommendations only, no automatic changes
  resourcePolicy:
    containerPolicies:
      - containerName: payment-service
        minAllowed:
          cpu: 50m
          memory: 64Mi
        maxAllowed:
          cpu: "4"
          memory: 8Gi
        controlledResources:
          - cpu
          - memory
```

Read recommendations after 24–48 hours of traffic:

```bash
kubectl describe vpa payment-service-vpa -n production | grep -A20 "Recommendation:"
# Container Recommendations:
#   Container Name: payment-service
#   Lower Bound:
#     Cpu: 120m
#     Memory: 128Mi
#   Target:
#     Cpu: 250m
#     Memory: 256Mi
#   Uncapped Target:
#     Cpu: 230m
#     Memory: 243Mi
#   Upper Bound:
#     Cpu: 1200m
#     Memory: 1Gi
```

Extract recommendations programmatically:

```bash
#!/bin/bash
# extract-vpa-recommendations.sh
# Outputs current vs recommended requests for all VPAs in a namespace

NAMESPACE=${1:-production}

kubectl get vpa -n "${NAMESPACE}" -o json | \
  jq -r '
    .items[] |
    .metadata.name as $name |
    .status.recommendation.containerRecommendations[]? |
    [$name, .containerName,
     .target.cpu // "N/A",
     .target.memory // "N/A"] |
    @tsv
  ' | \
  column -t -s $'\t' \
  -N "VPA,Container,Rec-CPU,Rec-Memory"
```

### Auto-Update VPA for Non-Critical Workloads

For batch jobs and non-production namespaces, enable automatic updates:

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: batch-worker-vpa
  namespace: batch-jobs
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: batch-worker
  updatePolicy:
    updateMode: "Auto"
    minReplicas: 2
  resourcePolicy:
    containerPolicies:
      - containerName: batch-worker
        controlledValues: RequestsAndLimits
        minAllowed:
          cpu: 100m
          memory: 128Mi
        maxAllowed:
          cpu: "2"
          memory: 4Gi
```

## Goldilocks Namespace Advisor

Goldilocks runs VPA in recommendation mode for every Deployment in a namespace and presents the data in a dashboard.

### Installation

```bash
helm repo add fairwinds-stable https://charts.fairwinds.com/stable
helm repo update

helm install goldilocks fairwinds-stable/goldilocks \
  --namespace goldilocks \
  --create-namespace \
  --set dashboard.replicaCount=1 \
  --set controller.resources.requests.cpu=100m \
  --set controller.resources.requests.memory=128Mi
```

### Enabling Goldilocks for a Namespace

```bash
kubectl label namespace production goldilocks.fairwinds.com/enabled=true
kubectl label namespace staging goldilocks.fairwinds.com/enabled=true
```

Goldilocks automatically creates VPA objects in `Off` mode for every Deployment in labeled namespaces.

### Accessing the Dashboard

```bash
kubectl -n goldilocks port-forward svc/goldilocks-dashboard 8080:80
# Access at http://localhost:8080
```

The dashboard shows per-container current requests vs. VPA recommendations and the estimated monthly cost difference, broken down by QoS class.

### Exporting Goldilocks Recommendations to CSV

```bash
kubectl get vpa -n production -o json | \
  jq -r '
    ["Namespace","Deployment","Container","Current Request (guess)","Rec CPU","Rec Memory","QoS"] as $headers |
    $headers,
    (.items[] |
      .metadata.namespace as $ns |
      .metadata.name as $deploy |
      .status.recommendation.containerRecommendations[]? |
      [$ns, $deploy, .containerName,
       "see kubectl get deploy",
       .target.cpu,
       .target.memory,
       "Burstable"] |
      map(. // "N/A")
    ) |
    @csv
  ' > rightsizing-recommendations.csv
```

## Spot Instance Node Groups with Tolerations

Spot/Preemptible instances offer 60–90% cost savings over on-demand pricing at the cost of potential interruption. Suitable workloads include stateless services with multiple replicas, batch jobs, and CI/CD runners.

### Karpenter NodePool for Spot Instances

```yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: spot-general
spec:
  template:
    metadata:
      labels:
        node-type: spot
    spec:
      taints:
        - key: spot
          value: "true"
          effect: NoSchedule
      nodeClassRef:
        apiVersion: karpenter.k8s.aws/v1
        kind: EC2NodeClass
        name: spot-general
      requirements:
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["spot"]
        - key: kubernetes.io/arch
          operator: In
          values: ["amd64"]
        - key: karpenter.k8s.aws/instance-category
          operator: In
          values: ["c", "m", "r"]
        - key: karpenter.k8s.aws/instance-generation
          operator: Gt
          values: ["2"]
  disruption:
    consolidationPolicy: WhenUnderutilized
    consolidateAfter: 30s
    expireAfter: 720h
  limits:
    cpu: "1000"
    memory: 4000Gi
---
apiVersion: karpenter.k8s.aws/v1
kind: EC2NodeClass
metadata:
  name: spot-general
spec:
  amiFamily: AL2023
  role: KarpenterNodeRole-cluster-prod
  subnetSelectorTerms:
    - tags:
        karpenter.sh/discovery: cluster-prod
  securityGroupSelectorTerms:
    - tags:
        karpenter.sh/discovery: cluster-prod
  blockDeviceMappings:
    - deviceName: /dev/xvda
      ebs:
        volumeSize: 100Gi
        volumeType: gp3
        encrypted: true
```

### Workload Tolerations for Spot Nodes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-worker
  namespace: production
spec:
  replicas: 6
  template:
    spec:
      tolerations:
        - key: spot
          value: "true"
          effect: NoSchedule
      affinity:
        nodeAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 80
              preference:
                matchExpressions:
                  - key: node-type
                    operator: In
                    values: ["spot"]
            - weight: 20
              preference:
                matchExpressions:
                  - key: node-type
                    operator: NotIn
                    values: ["spot"]
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  app: api-worker
              topologyKey: kubernetes.io/hostname
      terminationGracePeriodSeconds: 60
      containers:
        - name: api-worker
          image: example/api-worker:latest
          lifecycle:
            preStop:
              exec:
                command: ["/bin/sh", "-c", "sleep 15"]
```

### Spot Interruption Handling with AWS Node Termination Handler

```bash
helm repo add eks https://aws.github.io/eks-charts
helm install aws-node-termination-handler eks/aws-node-termination-handler \
  --namespace kube-system \
  --set enableSpotInterruptionDraining=true \
  --set enableScheduledEventDraining=true \
  --set enableRebalanceMonitoring=true \
  --set enableRebalanceDraining=true \
  --set podTerminationGracePeriod=60 \
  --set webhookURL="" \
  --set emitKubernetesEvents=true
```

## Cluster Bin Packing with Descheduler

The Kubernetes Descheduler evicts pods that violate scheduling policies, allowing the scheduler to place them more efficiently.

### Descheduler Deployment

```bash
helm repo add descheduler https://kubernetes-sigs.github.io/descheduler/
helm install descheduler descheduler/descheduler \
  --namespace kube-system \
  --set schedule="*/30 * * * *" \
  --set deschedulerPolicy.strategies.LowNodeUtilization.enabled=true
```

### Descheduler Policy for Cost Optimization

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: descheduler-policy
  namespace: kube-system
data:
  policy.yaml: |
    apiVersion: "descheduler/v1alpha2"
    kind: "DeschedulerPolicy"
    profiles:
      - name: default
        pluginConfig:
          - name: DefaultEvictor
            args:
              ignorePvcPods: true
              evictSystemCriticalPods: false
              evictFailedBarePods: false
              evictLocalStoragePods: false
              nodeFit: true
          - name: LowNodeUtilization
            args:
              thresholds:
                cpu: 20
                memory: 20
                pods: 20
              targetThresholds:
                cpu: 50
                memory: 50
                pods: 50
              useDeviationThresholds: false
              numberOfNodes: 2
          - name: HighNodeUtilization
            args:
              thresholds:
                cpu: 20
                memory: 20
                pods: 20
          - name: RemoveDuplicates
            args:
              excludeOwnerKinds:
                - ReplicaSet
          - name: RemovePodsViolatingInterPodAntiAffinity
          - name: RemovePodsViolatingTopologySpreadConstraint
            args:
              constraints:
                - DoNotSchedule
          - name: PodLifeTime
            args:
              maxPodLifeTimeSeconds: 86400
              labelSelector:
                matchLabels:
                  descheduler.alpha.kubernetes.io/evict: "true"
        plugins:
          balance:
            enabled:
              - LowNodeUtilization
              - RemoveDuplicates
              - RemovePodsViolatingTopologySpreadConstraint
          deschedule:
            enabled:
              - RemovePodsViolatingInterPodAntiAffinity
              - PodLifeTime
```

## Namespace Resource Quotas

Resource quotas prevent individual teams from monopolizing cluster capacity and create cost visibility boundaries.

### Tiered Quota Strategy

```yaml
# Small team quota
apiVersion: v1
kind: ResourceQuota
metadata:
  name: team-quota-small
  namespace: team-alpha
spec:
  hard:
    requests.cpu: "4"
    requests.memory: 8Gi
    limits.cpu: "8"
    limits.memory: 16Gi
    persistentvolumeclaims: "10"
    requests.storage: 100Gi
    pods: "20"
    services: "10"
    services.loadbalancers: "2"
    count/deployments.apps: "10"
    count/statefulsets.apps: "3"
---
# Large team quota
apiVersion: v1
kind: ResourceQuota
metadata:
  name: team-quota-large
  namespace: team-platform
spec:
  hard:
    requests.cpu: "32"
    requests.memory: 64Gi
    limits.cpu: "64"
    limits.memory: 128Gi
    persistentvolumeclaims: "50"
    requests.storage: 1Ti
    pods: "100"
    services.loadbalancers: "5"
```

### LimitRange for Default Requests

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: default-limits
  namespace: team-alpha
spec:
  limits:
    - type: Container
      default:
        cpu: 200m
        memory: 256Mi
      defaultRequest:
        cpu: 100m
        memory: 128Mi
      max:
        cpu: "4"
        memory: 8Gi
      min:
        cpu: 10m
        memory: 16Mi
    - type: Pod
      max:
        cpu: "8"
        memory: 16Gi
    - type: PersistentVolumeClaim
      max:
        storage: 100Gi
      min:
        storage: 1Gi
```

### Monitoring Quota Usage

```bash
#!/bin/bash
# quota-usage-report.sh
# Generates a quota utilization report for all namespaces with quotas

echo "Namespace | Resource | Used | Hard | % Used"
echo "---|---|---|---|---"

kubectl get resourcequota --all-namespaces -o json | \
  jq -r '
    .items[] |
    .metadata.namespace as $ns |
    .status.hard as $hard |
    .status.used as $used |
    to_entries |
    .[] |
    select(.key | startswith("status")) |
    .value |
    to_entries[] |
    [$ns, .key, ($used[.key] // "0"), ($hard[.key] // "0")] |
    @tsv
  ' 2>/dev/null | \
  awk -F'\t' '{
    used=$3; hard=$4
    if (hard+0 > 0) {
      pct = (used+0)/(hard+0)*100
      printf "%s | %s | %s | %s | %.1f%%\n", $1, $2, used, hard, pct
    }
  }' | sort -t'|' -k5 -rn | head -40
```

## OpenCost and Kubecost Metrics

### Installing OpenCost (Open Source)

```bash
kubectl create namespace opencost

# Install Prometheus first if not present
helm install prometheus prometheus-community/kube-prometheus-stack \
  --namespace monitoring

# Install OpenCost
helm install opencost opencost/opencost \
  --namespace opencost \
  --set opencost.prometheus.internal.serviceName=prometheus-kube-prometheus-prometheus \
  --set opencost.prometheus.internal.port=9090 \
  --set opencost.exporter.cloudProviderApiKey="" \
  --set opencost.ui.enabled=true
```

### OpenCost Prometheus Metrics

Key metrics for cost dashboards:

```promql
# Total cluster cost per hour
sum(node_total_hourly_cost)

# Cost per namespace per hour
sum by (namespace) (
  namespace_hourly_cost
)

# Cost efficiency (actual usage / allocated cost)
sum by (namespace) (
  container_cpu_usage_seconds_total rate
) /
sum by (namespace) (
  kube_pod_container_resource_requests{resource="cpu"}
)

# Top 10 most expensive deployments
topk(10,
  sum by (namespace, deployment) (
    deployment_hourly_cost
  )
)

# PVC cost by namespace
sum by (namespace) (
  pv_hourly_cost
)

# Idle CPU cost (requested but not used)
sum by (node) (
  kube_node_status_allocatable{resource="cpu"} -
  sum by (node) (
    kube_pod_container_resource_requests{resource="cpu"}
  )
) * on(node) group_left()
  node_cpu_hourly_cost
```

### Cost Allocation Labels

Apply consistent labels to all workloads for cost attribution:

```yaml
# Required labels for cost allocation
apiVersion: apps/v1
kind: Deployment
metadata:
  name: checkout-service
  namespace: ecommerce
  labels:
    app: checkout-service
    team: commerce
    cost-center: "1234"
    environment: production
    tier: backend
    business-unit: retail
```

Enforce cost labels with OPA Gatekeeper:

```yaml
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequiredLabels
metadata:
  name: require-cost-labels
spec:
  match:
    kinds:
      - apiGroups: ["apps"]
        kinds: ["Deployment", "StatefulSet", "DaemonSet"]
  parameters:
    labels:
      - key: team
        allowedRegex: "^[a-z][a-z0-9-]{1,30}$"
      - key: cost-center
        allowedRegex: "^[0-9]{4}$"
      - key: environment
        allowedRegex: "^(production|staging|development|testing)$"
```

## Idle Resource Detection Scripts

### Detecting Underutilized Deployments

```bash
#!/bin/bash
# find-idle-deployments.sh
# Identifies Deployments with CPU usage below 5% of requests for the past 24h

PROMETHEUS_URL=${PROMETHEUS_URL:-http://prometheus:9090}
THRESHOLD=${1:-5}  # percentage

echo "Checking for deployments with CPU usage below ${THRESHOLD}% of requests..."

# Query Prometheus for the ratio
curl -sG "${PROMETHEUS_URL}/api/v1/query" \
  --data-urlencode 'query=
    100 * (
      sum by (namespace, pod) (
        rate(container_cpu_usage_seconds_total{container!="POD",container!=""}[24h])
      )
      /
      sum by (namespace, pod) (
        kube_pod_container_resource_requests{resource="cpu",container!="POD"}
      )
    ) < '"${THRESHOLD}" \
  | jq -r '
    .data.result[] |
    "\(.metric.namespace)/\(.metric.pod): \(.value[1] | tonumber | . * 100 | round / 100)%"
  ' | sort
```

### Orphaned PVC Detection

```bash
#!/bin/bash
# find-orphaned-pvcs.sh
# Lists PVCs not bound to any running pod

echo "Checking for PVCs not attached to any pod..."

# Get all PVCs
ALL_PVCS=$(kubectl get pvc --all-namespaces -o json | \
  jq -r '.items[] | "\(.metadata.namespace)/\(.metadata.name)"')

# Get PVCs currently mounted by pods
MOUNTED_PVCS=$(kubectl get pods --all-namespaces -o json | \
  jq -r '
    .items[] |
    .metadata.namespace as $ns |
    .spec.volumes[]? |
    select(.persistentVolumeClaim) |
    "\($ns)/\(.persistentVolumeClaim.claimName)"
  ' | sort -u)

echo "Orphaned PVCs (not mounted by any pod):"
echo "${ALL_PVCS}" | while read -r pvc; do
  if ! echo "${MOUNTED_PVCS}" | grep -q "^${pvc}$"; then
    NS=$(echo "${pvc}" | cut -d/ -f1)
    NAME=$(echo "${pvc}" | cut -d/ -f2)
    STORAGE=$(kubectl get pvc "${NAME}" -n "${NS}" \
      -o jsonpath='{.spec.resources.requests.storage}')
    STATUS=$(kubectl get pvc "${NAME}" -n "${NS}" \
      -o jsonpath='{.status.phase}')
    echo "  ${pvc} | Status: ${STATUS} | Size: ${STORAGE}"
  fi
done
```

### Zero-Replica Deployments

```bash
#!/bin/bash
# find-scaled-to-zero.sh
# Lists Deployments intentionally or accidentally scaled to 0 replicas

kubectl get deployments --all-namespaces -o json | \
  jq -r '
    .items[] |
    select(.spec.replicas == 0) |
    "\(.metadata.namespace)\t\(.metadata.name)\t\(.metadata.creationTimestamp)"
  ' | \
  column -t -s $'\t' -N "NAMESPACE,DEPLOYMENT,CREATED"
```

### Node Utilization Report

```bash
#!/bin/bash
# node-utilization-report.sh
# Shows CPU and memory utilization vs allocatable capacity per node

echo "Node Utilization Report"
echo "========================"

kubectl get nodes -o json | jq -r '.items[].metadata.name' | while read -r node; do
  CPU_ALLOC=$(kubectl get node "${node}" \
    -o jsonpath='{.status.allocatable.cpu}')
  MEM_ALLOC=$(kubectl get node "${node}" \
    -o jsonpath='{.status.allocatable.memory}')

  # Get requested resources for pods on this node
  CPU_REQ=$(kubectl get pods --all-namespaces \
    --field-selector="spec.nodeName=${node}" \
    -o json | \
    jq '[.items[].spec.containers[].resources.requests.cpu // "0"] |
        map(if test("m$") then (.[:-1]|tonumber)/1000 else tonumber end) |
        add // 0')

  MEM_REQ=$(kubectl get pods --all-namespaces \
    --field-selector="spec.nodeName=${node}" \
    -o json | \
    jq '[.items[].spec.containers[].resources.requests.memory // "0"] |
        map(if test("Mi$") then (.[:-2]|tonumber)
            elif test("Gi$") then (.[:-2]|tonumber*1024)
            else (tonumber/1048576) end) |
        add // 0')

  echo "Node: ${node}"
  echo "  CPU Allocatable: ${CPU_ALLOC}, Requested: ${CPU_REQ} cores"
  echo "  Memory Allocatable: ${MEM_ALLOC}, Requested: ${MEM_REQ} Mi"
  echo ""
done
```

## Cost Savings Dashboard with Grafana

A Grafana dashboard YAML for cost visibility:

```yaml
# grafana-cost-dashboard-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: cost-optimization-dashboard
  namespace: monitoring
  labels:
    grafana_dashboard: "1"
data:
  cost-optimization.json: |
    {
      "title": "Kubernetes Cost Optimization",
      "panels": [
        {
          "title": "Monthly Estimated Cost by Namespace",
          "type": "bargauge",
          "targets": [
            {
              "expr": "sort_desc(sum by (namespace) (namespace_hourly_cost * 730))",
              "legendFormat": "{{namespace}}"
            }
          ]
        },
        {
          "title": "CPU Request vs Actual Usage by Namespace",
          "type": "barchart",
          "targets": [
            {
              "expr": "sum by (namespace) (kube_pod_container_resource_requests{resource='cpu'})",
              "legendFormat": "Requested - {{namespace}}"
            },
            {
              "expr": "sum by (namespace) (rate(container_cpu_usage_seconds_total[1h]))",
              "legendFormat": "Used - {{namespace}}"
            }
          ]
        },
        {
          "title": "Spot vs On-Demand Node Cost",
          "type": "piechart",
          "targets": [
            {
              "expr": "sum by (label_node_kubernetes_io_instance_type) (node_total_hourly_cost * 730)",
              "legendFormat": "{{label_node_kubernetes_io_instance_type}}"
            }
          ]
        }
      ]
    }
```

## FinOps Reporting Workflow

A weekly cost report script for distribution to engineering leads:

```bash
#!/bin/bash
# weekly-cost-report.sh
# Generates cost summary for the past 7 days from OpenCost API

OPENCOST_URL=${OPENCOST_URL:-http://opencost.opencost.svc.cluster.local:9090}
START=$(date -d "7 days ago" -u +%Y-%m-%dT%H:%M:%SZ)
END=$(date -u +%Y-%m-%dT%H:%M:%SZ)

echo "=== Kubernetes Cost Report: ${START} to ${END} ==="
echo ""

# Total cluster cost
TOTAL=$(curl -sG "${OPENCOST_URL}/allocation" \
  --data-urlencode "window=${START},${END}" \
  --data-urlencode "aggregate=cluster" \
  | jq -r '.data[0][].totalCost // 0')
echo "Total cluster cost (7 days): \$$(printf '%.2f' "${TOTAL}")"
echo ""

# Cost by namespace
echo "Cost by namespace (top 10):"
curl -sG "${OPENCOST_URL}/allocation" \
  --data-urlencode "window=${START},${END}" \
  --data-urlencode "aggregate=namespace" \
  | jq -r '
    [.data[0] | to_entries[] |
     {namespace: .key, cost: .value.totalCost}] |
    sort_by(-.cost) |
    .[:10][] |
    "  \(.namespace): $\(.cost | . * 100 | round / 100)"
  '
echo ""

# Efficiency summary
echo "Resource efficiency:"
curl -sG "${OPENCOST_URL}/allocation" \
  --data-urlencode "window=${START},${END}" \
  --data-urlencode "aggregate=namespace" \
  | jq -r '
    [.data[0] | to_entries[] |
     {
       namespace: .key,
       cpuEff: (.value.cpuEfficiency // 0),
       memEff: (.value.memEfficiency // 0)
     }] |
    sort_by(.cpuEff) |
    .[:5][] |
    "  \(.namespace): CPU \(.cpuEff * 100 | round)%, Mem \(.memEff * 100 | round)%"
  '
```

## Implementation Roadmap

| Phase | Duration | Actions | Expected Savings |
|---|---|---|---|
| 1. Measure | Week 1-2 | Deploy VPA Off mode, Goldilocks, OpenCost | Baseline visibility |
| 2. Rightsize | Week 3-4 | Apply VPA recommendations to dev/staging | 20–40% resource reduction |
| 3. Spot adoption | Week 5-6 | Move 50% of stateless workloads to Spot | 30–50% compute reduction |
| 4. Bin packing | Week 7-8 | Enable Descheduler, tune Karpenter | 10–20% node reduction |
| 5. Governance | Ongoing | Quota enforcement, cost labels, weekly reports | Prevents regression |

## Summary

Kubernetes cost optimization is not a one-time task — it is an ongoing practice combining automated tooling (VPA, Goldilocks, Karpenter, Descheduler) with organizational discipline (cost labels, resource quotas, weekly reviews). The highest-leverage interventions are VPA-based rightsizing, which typically recovers 30–50% of over-provisioned CPU and memory, and Spot instance adoption for stateless workloads, which cuts compute spend by 60–80% on eligible capacity. OpenCost and Kubecost provide the namespace-level attribution data needed to turn these savings into accountable FinOps programs.
