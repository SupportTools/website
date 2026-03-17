---
title: "Kubernetes Cost Optimization: Kubecost, Resource Right-Sizing, Spot Instance Strategies, and FinOps"
date: 2028-09-09T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Cost Optimization", "Kubecost", "FinOps", "Spot Instances", "Resource Management"]
categories:
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Reduce Kubernetes infrastructure costs by 40-70% using Kubecost for allocation visibility, VPA for resource right-sizing, Karpenter for intelligent node provisioning, spot/preemptible instance strategies, and FinOps practices for chargeback."
more_link: "yes"
url: "/kubernetes-cost-optimization-kubecost-finops-guide/"
---

Kubernetes clusters waste money in predictable ways: over-provisioned resources, idle nodes, right-sized workloads on wrong instance types, and lack of team-level cost visibility. Organizations running Kubernetes at scale typically overpay by 40-70% before implementing FinOps practices. This guide covers the tools and strategies to identify waste, right-size workloads, leverage spot instances safely, implement chargeback, and build a culture of cost awareness.

<!--more-->

# Kubernetes Cost Optimization: Kubecost, Resource Right-Sizing, Spot Instance Strategies, and FinOps

## Section 1: The Cost Waste Taxonomy

Before optimizing, understand where money goes in a typical Kubernetes cluster:

```
Typical cost breakdown (before optimization):
├── Compute (60-70% of total)
│   ├── Idle CPU: 30-40% (requests >> actual usage)
│   ├── Idle memory: 20-30% (limits >> actual usage)
│   ├── Node overhead: 5-10% (system pods, node overhead)
│   └── On-demand premium: 50-70% markup vs spot
├── Storage (15-25%)
│   ├── Orphaned PVCs: 5-15%
│   ├── Over-provisioned PVCs: 10-20%
│   └── Unused snapshots: 2-5%
└── Network (10-15%)
    ├── Cross-AZ traffic: 5-10%
    ├── NAT gateway: 3-5%
    └── Unused load balancers: 2-3%
```

## Section 2: Kubecost Installation and Configuration

```bash
# Install Kubecost via Helm
helm repo add kubecost https://kubecost.github.io/cost-analyzer/
helm repo update

helm upgrade --install kubecost kubecost/cost-analyzer \
  --namespace kubecost \
  --create-namespace \
  --version 2.3.0 \
  --set kubecostToken="YOUR_TOKEN" \
  --set prometheus.enabled=true \
  --set grafana.enabled=false \
  --set kubecostProductConfigs.currencyCode="USD" \
  --set kubecostProductConfigs.clusterName="production-us-east-1" \
  --set networkCosts.enabled=true \
  --set networkCosts.config.services.amazon-web-services=true

# Wait for deployment
kubectl rollout status deploy/kubecost-cost-analyzer -n kubecost --timeout=5m
```

```yaml
# kubecost-values.yaml — production configuration
kubecostProductConfigs:
  currencyCode: USD
  clusterName: production-us-east-1
  # AWS spot instance pricing integration
  awsSpotDataRegion: us-east-1
  awsSpotDataBucket: my-spot-pricing-bucket
  awsSpotDataPrefix: spot-data
  # Azure/GCP alternatives
  # cloudProviderApiKey: ...

# Use existing Prometheus instead of bundled
prometheus:
  enabled: false
  fqdn: http://prometheus.monitoring.svc.cluster.local:9090

# Custom cost allocation labels (map to your teams/cost centers)
costModel:
  defaultVCPUPrice: "0.031611"
  defaultRAMGBPrice: "0.004237"
  defaultGPUPrice: "0.95"
  defaultStoragePrice: "0.00005480"
  defaultEgressCost: "0.12"

kubecostProductConfigs:
  # Map Kubernetes labels to departments for chargeback
  labelMappingConfigs:
    enabled: true
    owner_label: "team"
    team_label: "team"
    department_label: "department"
    product_label: "product"
    environment_label: "environment"

savings:
  # Run savings recommendations every 24 hours
  requestSizingEnabled: true
  namespaceRequestSizing: true
  clusterSizingEnabled: true
```

```bash
# Access Kubecost UI
kubectl port-forward -n kubecost svc/kubecost-cost-analyzer 9090 &
open http://localhost:9090

# Query cost allocations via API
# Cost by namespace for the last 30 days
curl -s "http://localhost:9090/model/allocation?window=30d&aggregate=namespace" | \
  jq '.data[0] | to_entries | sort_by(-.value.totalCost) | 
      map({namespace: .key, cost: (.value.totalCost | round)}) | .[:10]'

# Cost by team label
curl -s "http://localhost:9090/model/allocation?window=30d&aggregate=label:team" | \
  jq '.data[0] | to_entries | sort_by(-.value.totalCost) | 
      map({team: .key, cost: (.value.totalCost | round), 
           cpuCost: (.value.cpuCost | round), 
           ramCost: (.value.ramCost | round)}) | .[:20]'

# Unused PVC costs
curl -s "http://localhost:9090/model/assets?window=7d&aggregate=type" | \
  jq '.data[0].PersistentVolume | {count: .count, cost: (.totalCost | round)}'
```

## Section 3: Resource Right-Sizing with VPA

Vertical Pod Autoscaler recommends and sets CPU/memory requests based on actual usage:

```bash
# Install VPA
git clone https://github.com/kubernetes/autoscaler
cd autoscaler/vertical-pod-autoscaler
./hack/vpa-install.sh
```

```yaml
# vpa-recommendation.yaml — VPA in "Off" mode first (recommendations only)
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: api-server-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-server
  updatePolicy:
    updateMode: "Off"     # Start with Off — just get recommendations
    # Change to "Auto" once you trust the recommendations
  resourcePolicy:
    containerPolicies:
      - containerName: api-server
        # Don't go below these minimums
        minAllowed:
          cpu: 50m
          memory: 64Mi
        # Don't exceed these maximums
        maxAllowed:
          cpu: 4
          memory: 4Gi
        # VPA controls both CPU and memory
        controlledResources: ["cpu", "memory"]
        controlledValues: RequestsAndLimits
---
# After running in Off mode for 7+ days, check recommendations:
# kubectl get vpa api-server-vpa -n production -o yaml
# Look for: status.recommendation.containerRecommendations[*].target
```

```bash
# Check VPA recommendations
kubectl get vpa -n production -o json | \
  jq '.items[] | {
    name: .metadata.name,
    containers: [.status.recommendation.containerRecommendations[]? | {
      container: .containerName,
      cpu_target: .target.cpu,
      memory_target: .target.memory,
      cpu_lower: .lowerBound.cpu,
      memory_lower: .lowerBound.memory
    }]
  }'

# Compare current requests vs VPA recommendations
kubectl get pods -n production -o json | jq -r '
  .items[] | 
  .metadata.name as $pod |
  .spec.containers[] | 
  "\($pod) \(.name) cpu_req:\(.resources.requests.cpu) mem_req:\(.resources.requests.memory)"
'

# Script to apply VPA recommendations as deployment patches
for deploy in $(kubectl get deploy -n production -o name); do
  vpa_name=$(kubectl get vpa -n production -l "app=$(kubectl get $deploy -n production -o jsonpath='{.metadata.labels.app}')" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
  if [ -n "$vpa_name" ]; then
    cpu=$(kubectl get vpa $vpa_name -n production -o jsonpath='{.status.recommendation.containerRecommendations[0].target.cpu}')
    mem=$(kubectl get vpa $vpa_name -n production -o jsonpath='{.status.recommendation.containerRecommendations[0].target.memory}')
    echo "$deploy: CPU=$cpu MEM=$mem"
  fi
done
```

## Section 4: Karpenter for Intelligent Node Provisioning

Karpenter replaces cluster-autoscaler with a more flexible approach: it provisions exactly the right instance type for each pending pod:

```bash
# Install Karpenter (AWS)
helm repo add karpenter https://charts.karpenter.sh/
helm upgrade --install karpenter oci://public.ecr.aws/karpenter/karpenter \
  --version 1.0.0 \
  --namespace kube-system \
  --set settings.clusterName=production-us-east-1 \
  --set settings.interruptionQueue=karpenter-interruption-queue \
  --set controller.resources.requests.cpu=1 \
  --set controller.resources.requests.memory=1Gi
```

```yaml
# karpenter-nodepool.yaml — general-purpose workloads with spot/on-demand mix
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: general
spec:
  template:
    metadata:
      labels:
        node-pool: general
    spec:
      requirements:
        # Instance categories — exclude GPU and bare-metal
        - key: karpenter.k8s.aws/instance-category
          operator: In
          values: ["c", "m", "r"]
        # Generation 5 or newer only
        - key: karpenter.k8s.aws/instance-generation
          operator: Gt
          values: ["4"]
        # Allow both AMD64 and ARM64 (Graviton) for cost savings
        - key: kubernetes.io/arch
          operator: In
          values: ["amd64", "arm64"]
        # 70% spot, 30% on-demand — adjust based on workload tolerance
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["spot", "on-demand"]
        # Require multiple AZs for HA
        - key: topology.kubernetes.io/zone
          operator: In
          values: ["us-east-1a", "us-east-1b", "us-east-1c"]
        # Size range — don't provision tiny or huge nodes
        - key: karpenter.k8s.aws/instance-cpu
          operator: In
          values: ["2", "4", "8", "16", "32"]
        - key: karpenter.k8s.aws/instance-memory
          operator: Gt
          values: ["4096"]  # At least 4 GiB
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: general
      # Disruption settings
      expireAfter: 720h  # Recycle nodes after 30 days for security patches
  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 30s

  limits:
    cpu: 1000         # Max 1000 vCPUs in this NodePool
    memory: 2000Gi    # Max 2 TiB RAM
---
# Spot-only pool for batch/ML workloads
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: spot-batch
spec:
  template:
    metadata:
      labels:
        node-pool: spot-batch
      annotations:
        "cluster-autoscaler.kubernetes.io/safe-to-evict": "false"
    spec:
      taints:
        - key: batch
          value: "true"
          effect: NoSchedule
      requirements:
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["spot"]
        - key: karpenter.k8s.aws/instance-category
          operator: In
          values: ["c", "m", "r"]
        - key: kubernetes.io/arch
          operator: In
          values: ["amd64", "arm64"]
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: general
      expireAfter: 24h  # Batch nodes recycled daily
  disruption:
    consolidationPolicy: WhenEmpty
    consolidateAfter: 60s
  limits:
    cpu: 500
---
apiVersion: karpenter.k8s.aws/v1
kind: EC2NodeClass
metadata:
  name: general
spec:
  amiFamily: Bottlerocket  # Minimal, security-focused AMI
  role: KarpenterNodeRole
  subnetSelectorTerms:
    - tags:
        karpenter.sh/discovery: production-us-east-1
  securityGroupSelectorTerms:
    - tags:
        karpenter.sh/discovery: production-us-east-1
  instanceStorePolicy: RAID0  # Use NVMe instance storage for ephemeral data
  tags:
    ManagedBy: karpenter
    Environment: production
  blockDeviceMappings:
    - deviceName: /dev/xvda
      ebs:
        volumeSize: 100Gi
        volumeType: gp3
        encrypted: true
        throughput: 125
        iops: 3000
```

## Section 5: Spot Instance Interruption Handling

Spot instances can be reclaimed with a 2-minute warning. Applications must handle this gracefully:

```yaml
# Deploy batch jobs on spot with interruption tolerance
apiVersion: apps/v1
kind: Deployment
metadata:
  name: worker
  namespace: batch
spec:
  replicas: 10
  selector:
    matchLabels:
      app: worker
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 3    # Tolerate losing 3 pods at once
      maxSurge: 2
  template:
    metadata:
      labels:
        app: worker
    spec:
      # Schedule on spot nodes from the spot-batch pool
      tolerations:
        - key: batch
          value: "true"
          effect: NoSchedule
        - key: karpenter.sh/disruption
          value: underutilized
          effect: NoSchedule
      nodeSelector:
        node-pool: spot-batch

      # Give the pod 90 seconds to finish in-flight work on SIGTERM
      terminationGracePeriodSeconds: 90

      containers:
        - name: worker
          image: myorg/worker:latest
          # Checkpoint progress frequently
          env:
            - name: CHECKPOINT_INTERVAL_SECONDS
              value: "30"
            - name: GRACEFUL_SHUTDOWN_TIMEOUT
              value: "80"
          lifecycle:
            preStop:
              exec:
                command:
                  - sh
                  - -c
                  - |
                    # Signal worker to stop accepting new jobs and finish current
                    kill -SIGUSR1 1
                    # Wait for in-flight jobs to complete (max 80s)
                    timeout 80 sh -c 'while [ -f /tmp/worker.busy ]; do sleep 2; done'
          resources:
            requests:
              cpu: 500m
              memory: 1Gi
            limits:
              cpu: 2
              memory: 2Gi
---
# PodDisruptionBudget ensures enough workers are always running
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: worker-pdb
  namespace: batch
spec:
  selector:
    matchLabels:
      app: worker
  minAvailable: "50%"    # Always keep at least 50% running
```

```go
// worker/graceful.go — handle SIGTERM and spot interruption
package worker

import (
    "context"
    "log/slog"
    "os"
    "os/signal"
    "syscall"
    "time"
)

func RunWithGracefulShutdown(ctx context.Context, process func(context.Context) error) error {
    ctx, cancel := context.WithCancel(ctx)
    defer cancel()

    // Handle OS signals
    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT, syscall.SIGUSR1)

    // Monitor AWS spot interruption notice endpoint
    go func() {
        ticker := time.NewTicker(5 * time.Second)
        defer ticker.Stop()
        for {
            select {
            case <-ctx.Done():
                return
            case <-ticker.C:
                if isSpotInterruptionImminent() {
                    slog.Warn("Spot interruption notice received — beginning graceful shutdown")
                    cancel()
                    return
                }
            }
        }
    }()

    go func() {
        select {
        case sig := <-sigCh:
            slog.Info("Signal received, stopping", "signal", sig)
            cancel()
        case <-ctx.Done():
        }
    }()

    return process(ctx)
}

// isSpotInterruptionImminent checks the AWS IMDS endpoint for spot interruption notice.
func isSpotInterruptionImminent() bool {
    ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
    defer cancel()

    req, _ := http.NewRequestWithContext(ctx, "GET",
        "http://169.254.169.254/latest/meta-data/spot/interruption-action", nil)
    resp, err := http.DefaultClient.Do(req)
    if err != nil {
        return false
    }
    defer resp.Body.Close()
    // 200 means interruption is coming; 404 means we're safe
    return resp.StatusCode == http.StatusOK
}
```

## Section 6: Cost Allocation with Labels and Namespaces

```yaml
# Enforce cost labels via OPA/Gatekeeper
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: requirecostlabels
spec:
  crd:
    spec:
      names:
        kind: RequireCostLabels
      validation:
        type: object
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package requirecostlabels

        required_labels := {"team", "department", "environment", "product"}

        violation[{"msg": msg}] {
          provided := {label | input.review.object.metadata.labels[label]}
          missing := required_labels - provided
          count(missing) > 0
          msg := sprintf("Missing required cost labels: %v", [missing])
        }
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: RequireCostLabels
metadata:
  name: require-cost-labels
spec:
  match:
    kinds:
      - apiGroups: ["apps"]
        kinds: ["Deployment", "StatefulSet", "DaemonSet"]
    namespaces:
      - production
      - staging
  parameters: {}
```

```bash
# Generate cost report by team using Kubecost API
generate_chargeback_report() {
  WINDOW="${1:-30d}"
  OUTPUT="${2:-/tmp/chargeback-$(date +%Y%m).csv}"

  echo "team,namespace,cpu_cost,memory_cost,storage_cost,network_cost,total_cost,efficiency_pct" > "$OUTPUT"

  curl -s "http://localhost:9090/model/allocation?window=${WINDOW}&aggregate=label:team,namespace&includeIdle=false" | \
    jq -r '.data[0] | to_entries[] | 
      (.key | split("/")) as $parts |
      [
        ($parts[0] // "unknown"),
        ($parts[1] // "unknown"),
        (.value.cpuCost | round),
        (.value.ramCost | round),
        (.value.pvCost | round),
        (.value.networkCost | round),
        (.value.totalCost | round),
        ((.value.cpuEfficiency + .value.ramEfficiency) / 2 * 100 | round)
      ] | @csv' >> "$OUTPUT"

  echo "Chargeback report written to $OUTPUT"
  cat "$OUTPUT" | column -t -s','
}

generate_chargeback_report 30d
```

## Section 7: Namespace Resource Quotas for Budget Enforcement

```yaml
# namespace-resource-quotas.yaml
# Set hard limits per team namespace to enforce budgets
apiVersion: v1
kind: ResourceQuota
metadata:
  name: team-alpha-quota
  namespace: team-alpha
  annotations:
    monthly-budget-usd: "5000"
    finops-contact: "finops@myorg.com"
spec:
  hard:
    # Compute
    requests.cpu: "50"
    limits.cpu: "100"
    requests.memory: 100Gi
    limits.memory: 200Gi
    # Pods
    pods: "100"
    # Storage
    requests.storage: 2Ti
    persistentvolumeclaims: "20"
    # Services
    services: "20"
    services.loadbalancers: "2"     # LBs are expensive!
    services.nodeports: "0"
---
# LimitRange: set default requests/limits so pods without them get sensible defaults
apiVersion: v1
kind: LimitRange
metadata:
  name: team-alpha-defaults
  namespace: team-alpha
spec:
  limits:
    - type: Container
      default:
        cpu: 500m
        memory: 512Mi
      defaultRequest:
        cpu: 100m
        memory: 128Mi
      max:
        cpu: "8"
        memory: 16Gi
      min:
        cpu: 10m
        memory: 16Mi
    - type: PersistentVolumeClaim
      max:
        storage: 100Gi
      min:
        storage: 1Gi
```

## Section 8: Automated Cost Alerts

```yaml
# prometheus-cost-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: cost-optimization-alerts
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
spec:
  groups:
    - name: cost.rules
      interval: 1h
      rules:
        # Alert when a namespace's monthly projected cost exceeds budget
        - alert: NamespaceCostBudgetExceeded
          expr: |
            (
              sum by (namespace) (
                rate(container_cpu_usage_seconds_total{container!=""}[1h]) * 0.031611 * 720
                + container_memory_working_set_bytes{container!=""} / 1e9 * 0.004237 * 720
              )
            ) > on (namespace) (
              kube_namespace_annotations{annotation_monthly_budget_usd!=""} 
              | label_replace(., "budget", "$1", "annotation_monthly_budget_usd", "(.*)")
            )
          for: 1h
          labels:
            severity: warning
          annotations:
            summary: "Namespace {{ $labels.namespace }} projected to exceed monthly budget"
            description: "Projected monthly cost: ${{ $value | humanize }}"

        # CPU requests much higher than usage
        - alert: HighCPURequestsOverProvisioned
          expr: |
            (
              sum by (namespace, pod, container) (
                rate(container_cpu_usage_seconds_total{container!=""}[6h])
              )
            ) /
            (
              sum by (namespace, pod, container) (
                kube_pod_container_resource_requests{resource="cpu", container!=""}
              )
            ) < 0.1
          for: 6h
          labels:
            severity: info
            runbook: "https://runbooks.myorg.com/kubernetes-cost-optimization"
          annotations:
            summary: "Container {{ $labels.namespace }}/{{ $labels.pod }}/{{ $labels.container }} uses <10% of CPU requests"
            description: "CPU efficiency: {{ $value | humanizePercentage }}. Consider reducing requests."

        # Unused PVCs (no pods mounting them for 7 days)
        - alert: UnusedPersistentVolumeClaim
          expr: |
            kube_persistentvolumeclaim_info{phase="Bound"} unless on(persistentvolumeclaim, namespace) (
              kube_pod_spec_volumes_persistentvolumeclaims_info
            )
          for: 168h   # 7 days
          labels:
            severity: warning
          annotations:
            summary: "PVC {{ $labels.namespace }}/{{ $labels.persistentvolumeclaim }} unused for 7 days"

        # Nodes underutilized
        - alert: NodeUnderutilized
          expr: |
            (
              sum by (node) (kube_pod_container_resource_requests{resource="cpu"}) /
              sum by (node) (kube_node_status_allocatable{resource="cpu"})
            ) < 0.3
          for: 2h
          labels:
            severity: info
          annotations:
            summary: "Node {{ $labels.node }} CPU utilization below 30%"
            description: "Consider consolidating pods and scaling down this node."
```

## Section 9: Cost Dashboard Queries for Grafana

```promql
# Monthly cost by namespace (approximate, based on CPU+RAM usage)
sum by (namespace) (
  rate(container_cpu_usage_seconds_total{container!="", namespace!=""}[30d]) * 0.031611 * 720
  +
  avg_over_time(container_memory_working_set_bytes{container!="", namespace!=""}[30d]) / 1e9 * 0.004237 * 720
)

# CPU request efficiency by team
sum by (label_team) (
  rate(container_cpu_usage_seconds_total{container!=""}[6h])
  * on(pod, namespace) group_left(label_team)
  kube_pod_labels
) /
sum by (label_team) (
  kube_pod_container_resource_requests{resource="cpu", container!=""}
  * on(pod, namespace) group_left(label_team)
  kube_pod_labels
)

# Storage cost (requires kubecost metrics)
sum by (namespace) (kubecost_cluster_storage_cost) * 720

# Wasted money: requests - actual usage, converted to dollars
(
  sum by (namespace) (kube_pod_container_resource_requests{resource="cpu"}) -
  sum by (namespace) (rate(container_cpu_usage_seconds_total{container!=""}[1h]))
) * 0.031611 * 720  # monthly waste in dollars
```

## Section 10: FinOps Maturity Model and Quick Wins

```bash
# Phase 1: Visibility (first 30 days)
# - Install Kubecost
# - Add cost labels to all workloads  
# - Set up monthly chargeback reports
# - Identify top 5 most expensive namespaces

# Phase 2: Optimization (30-90 days)

# Quick Win 1: Delete orphaned resources
# Find PVCs not mounted by any pod
kubectl get pvc --all-namespaces -o json | jq -r '
  .items[] | 
  select(.status.phase == "Bound") |
  "\(.metadata.namespace)/\(.metadata.name)"
' | while read pvc; do
  ns=$(echo $pvc | cut -d/ -f1)
  name=$(echo $pvc | cut -d/ -f2)
  used=$(kubectl get pods -n $ns -o json | jq --arg pvc "$name" '
    .items[] | .spec.volumes[]? | 
    select(.persistentVolumeClaim.claimName == $pvc) | 
    "used"
  ' 2>/dev/null)
  if [ -z "$used" ]; then
    echo "ORPHANED PVC: $ns/$name"
  fi
done

# Quick Win 2: Find deployments with no requests set
kubectl get pods --all-namespaces -o json | jq -r '
  .items[] | 
  select(.spec.containers[].resources.requests == null or 
         .spec.containers[].resources.requests == {}) |
  "\(.metadata.namespace)/\(.metadata.name)"
' | sort -u

# Quick Win 3: Find LoadBalancer services with no traffic
kubectl get svc --all-namespaces -o json | jq -r '
  .items[] | 
  select(.spec.type == "LoadBalancer") | 
  "\(.metadata.namespace)/\(.metadata.name)"
'
# Check each one: kubectl describe svc -n $ns $name
# Delete unused LBs — each one costs ~$20/month on AWS

# Quick Win 4: Scale down dev/staging clusters at night
cat << 'EOF' | kubectl apply -f -
apiVersion: batch/v1
kind: CronJob
metadata:
  name: scale-down-non-prod
  namespace: kube-system
spec:
  schedule: "0 20 * * 1-5"   # 8 PM weekdays
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: scale-controller
          containers:
          - name: kubectl
            image: bitnami/kubectl:latest
            command:
            - sh
            - -c
            - |
              for ns in staging development qa; do
                kubectl get deploy -n $ns -o json | 
                  jq -r '.items[] | "\(.metadata.name) \(.spec.replicas)"' | 
                  while read name replicas; do
                    kubectl annotate deploy -n $ns $name \
                      "pre-scale-replicas=$replicas" --overwrite
                    kubectl scale deploy -n $ns $name --replicas=0
                  done
              done
          restartPolicy: OnFailure
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: scale-up-non-prod
  namespace: kube-system
spec:
  schedule: "0 8 * * 1-5"   # 8 AM weekdays
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: scale-controller
          containers:
          - name: kubectl
            image: bitnami/kubectl:latest
            command:
            - sh
            - -c
            - |
              for ns in staging development qa; do
                kubectl get deploy -n $ns -o json | 
                  jq -r '.items[] | 
                    select(.metadata.annotations."pre-scale-replicas" != null) |
                    "\(.metadata.name) \(.metadata.annotations["pre-scale-replicas"])"' | 
                  while read name replicas; do
                    kubectl scale deploy -n $ns $name --replicas=$replicas
                  done
              done
          restartPolicy: OnFailure
EOF

# Phase 3: Culture (ongoing)
# - Weekly cost review meetings
# - Per-team cost dashboards in Grafana
# - Cost efficiency KPIs in engineering OKRs
# - Savings sharing: teams keep 50% of savings as engineering budget
```

The combination of Kubecost visibility, VPA right-sizing, Karpenter intelligent provisioning, spot instance strategies, and FinOps cultural practices consistently delivers 40-70% cost reductions in Kubernetes environments without sacrificing reliability.
