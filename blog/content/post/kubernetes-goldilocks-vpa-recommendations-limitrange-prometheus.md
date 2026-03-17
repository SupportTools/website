---
title: "Kubernetes Goldilocks VPA Recommendations: LimitRange Integration, Namespace Annotations, Prometheus Queries, and Reports"
date: 2032-02-29T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Goldilocks", "VPA", "Resource Management", "Cost Optimization", "Prometheus"]
categories:
- Kubernetes
- Cost Optimization
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to using Goldilocks for Kubernetes resource request optimization, covering VPA integration, LimitRange enforcement, namespace-level annotation controls, Prometheus metrics, and automated resource reports."
more_link: "yes"
url: "/kubernetes-goldilocks-vpa-recommendations-limitrange-prometheus/"
---

Goldilocks is a Fairwinds tool that runs the Kubernetes Vertical Pod Autoscaler (VPA) in recommendation-only mode and surfaces those recommendations through a dashboard and Prometheus metrics. It solves one of the most persistent problems in Kubernetes cost management: teams set resource requests based on guesses, resulting in either massive over-provisioning (expensive) or under-provisioning (reliability issues). Goldilocks makes correct resource sizing a data-driven exercise rather than a guess. This guide covers deploying Goldilocks in production, integrating with LimitRange for guardrails, and building Prometheus-based reporting pipelines.

<!--more-->

# Kubernetes Goldilocks VPA Recommendations

## Architecture Overview

Goldilocks consists of two components:

1. **Controller**: Watches namespaces and creates/updates VPA objects in recommendation mode for every Deployment in annotated namespaces.
2. **Dashboard**: Reads VPA recommendation objects and displays them alongside current resource requests.

```
┌─────────────────────────────────────────────────────────────┐
│  Kubernetes Cluster                                         │
│                                                             │
│  ┌──────────────────┐     creates    ┌─────────────────┐   │
│  │ Goldilocks       │────────────────►│ VPA objects     │   │
│  │ Controller       │                │ (recommendation │   │
│  └──────────────────┘                │  mode only)     │   │
│                                      └────────┬────────┘   │
│  ┌──────────────────┐     reads              │             │
│  │ Goldilocks       │◄───────────────────────┘             │
│  │ Dashboard        │                                       │
│  └──────────────────┘                                       │
│                                                             │
│  ┌──────────────────┐                                       │
│  │ VPA Recommender  │── provides recommendations ──────────┘
│  │ (must be         │
│  │  installed)      │
│  └──────────────────┘
└─────────────────────────────────────────────────────────────┘
```

## Section 1: Prerequisites - Installing VPA

Goldilocks requires the VPA Recommender component to be running. Install it without the admission controller or updater (we want recommendations only).

```bash
# Clone the VPA repository
git clone https://github.com/kubernetes/autoscaler.git
cd autoscaler/vertical-pod-autoscaler

# Install VPA CRDs only (no admission controller)
kubectl apply -f deploy/vpa-v1-crd-gen.yaml

# Install only the Recommender component
kubectl apply -f deploy/recommender-deployment.yaml

# Verify VPA Recommender is running
kubectl -n kube-system get pods -l app=vpa-recommender
```

Alternatively, with Helm:

```bash
helm repo add fairwinds-stable https://charts.fairwinds.com/stable
helm repo update

# Install VPA (recommender only)
helm upgrade --install vpa fairwinds-stable/vpa \
  --namespace vpa-system \
  --create-namespace \
  --set recommender.enabled=true \
  --set updater.enabled=false \
  --set admissionController.enabled=false \
  --set recommender.extraArgs.v=4 \
  --set recommender.extraArgs."recommender-interval"=1m \
  --set recommender.extraArgs."memory-saver"=false \
  --set recommender.resources.requests.cpu=50m \
  --set recommender.resources.requests.memory=500Mi \
  --set recommender.resources.limits.cpu=200m \
  --set recommender.resources.limits.memory=1Gi
```

## Section 2: Installing Goldilocks

### Helm Installation

```yaml
# goldilocks-values.yaml
replicaCount: 1

controller:
  resources:
    requests:
      cpu: 25m
      memory: 32Mi
    limits:
      cpu: 100m
      memory: 256Mi

  # Only process namespaces with the annotation
  # This prevents creating VPA objects for every namespace
  flags:
    on-by-default: false

  # VPA update mode: Off means recommendations only, no automatic updates
  updateMode: "Off"

dashboard:
  enabled: true
  replicaCount: 2

  resources:
    requests:
      cpu: 25m
      memory: 32Mi
    limits:
      cpu: 200m
      memory: 256Mi

  service:
    type: ClusterIP
    port: 80

  ingress:
    enabled: true
    annotations:
      nginx.ingress.kubernetes.io/auth-type: basic
      nginx.ingress.kubernetes.io/auth-secret: goldilocks-basic-auth
      nginx.ingress.kubernetes.io/ssl-redirect: "true"
    hosts:
      - host: goldilocks.internal.example.com
        paths:
          - path: /
            pathType: Prefix
    tls:
      - secretName: goldilocks-tls
        hosts:
          - goldilocks.internal.example.com

  # Time range for VPA recommendation history
  vpaLabels:
    app.kubernetes.io/managed-by: goldilocks

serviceAccount:
  create: true
  name: goldilocks

rbac:
  create: true
```

```bash
helm upgrade --install goldilocks fairwinds-stable/goldilocks \
  --namespace goldilocks \
  --create-namespace \
  -f goldilocks-values.yaml

# Verify installation
kubectl -n goldilocks get pods
kubectl -n goldilocks get svc

# Access dashboard (port-forward for initial check)
kubectl -n goldilocks port-forward svc/goldilocks-dashboard 8080:80 &
open http://localhost:8080
```

## Section 3: Namespace Annotation Controls

Goldilocks uses namespace annotations to control which namespaces are analyzed and what update behavior is desired.

### Enabling Goldilocks for a Namespace

```bash
# Enable Goldilocks for a namespace (creates VPA objects in Off mode)
kubectl annotate namespace production \
  goldilocks.fairwinds.com/enabled=true

# Enable with a specific VPA update mode per namespace
# Off: recommendations only (safest, recommended starting point)
# Initial: set on pod creation, don't change running pods
# Auto: automatically update resource requests (requires PDB)
kubectl annotate namespace staging \
  goldilocks.fairwinds.com/enabled=true \
  goldilocks.fairwinds.com/vpa-update-mode=Initial

# Exclude specific workloads from VPA management
kubectl annotate deployment my-stateful-app -n production \
  goldilocks.fairwinds.com/enabled=false

# Enable for all non-system namespaces at once
for ns in $(kubectl get namespaces -o name | \
    grep -v "kube-system\|kube-public\|kube-node-lease\|goldilocks\|vpa-system" | \
    awk -F/ '{print $2}'); do
  kubectl annotate namespace "${ns}" goldilocks.fairwinds.com/enabled=true
done
```

### Namespace-Level Resource Profiles

Use annotations to configure different QoS profiles per namespace:

```bash
# Production: Off mode (manual review required before applying)
kubectl annotate namespace production \
  goldilocks.fairwinds.com/enabled=true \
  goldilocks.fairwinds.com/vpa-update-mode=Off

# Staging: Initial mode (applies on new pod creation)
kubectl annotate namespace staging \
  goldilocks.fairwinds.com/enabled=true \
  goldilocks.fairwinds.com/vpa-update-mode=Initial

# Development: Auto mode (applies automatically)
kubectl annotate namespace development \
  goldilocks.fairwinds.com/enabled=true \
  goldilocks.fairwinds.com/vpa-update-mode=Auto

# Exclude system-like namespaces
kubectl annotate namespace kube-system \
  goldilocks.fairwinds.com/enabled=false
```

### What Goldilocks Creates

Once a namespace is annotated, Goldilocks creates a VPA object for each Deployment:

```yaml
# Auto-generated VPA object (do not edit manually)
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: api-server
  namespace: production
  labels:
    app.kubernetes.io/managed-by: goldilocks
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-server
  updatePolicy:
    updateMode: "Off"
  resourcePolicy:
    containerPolicies:
      - containerName: "*"
        minAllowed:
          cpu: 10m
          memory: 50Mi
        maxAllowed:
          cpu: "8"
          memory: 8Gi
```

Check VPA recommendation after waiting for data collection (at least 1 hour of metrics):

```bash
# View VPA recommendations
kubectl get vpa -n production api-server -o yaml

# The status section shows the recommendation:
# status:
#   recommendation:
#     containerRecommendations:
#       - containerName: api-server
#         lowerBound:
#           cpu: 52m
#           memory: 64Mi
#         target:
#           cpu: 110m
#           memory: 128Mi
#         uncappedTarget:
#           cpu: 110m
#           memory: 128Mi
#         upperBound:
#           cpu: 500m
#           memory: 512Mi

# List all VPA objects in a namespace
kubectl get vpa -n production

# Check all VPA recommendations across namespaces
kubectl get vpa --all-namespaces -o wide
```

## Section 4: LimitRange Integration

LimitRange provides guardrails that prevent poorly configured workloads from consuming excessive resources. It works alongside Goldilocks recommendations.

### LimitRange Configuration by Environment

```yaml
# limitrange-production.yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: production-limits
  namespace: production
spec:
  limits:
    # Per-container limits
    - type: Container
      default:
        # Default limits (applied when container has no limit specified)
        cpu: "1"
        memory: 512Mi
      defaultRequest:
        # Default requests (applied when container has no request specified)
        cpu: 100m
        memory: 128Mi
      min:
        # Minimum allowed values
        cpu: 10m
        memory: 32Mi
      max:
        # Maximum allowed values (prevent runaway containers)
        cpu: "8"
        memory: 16Gi
      maxLimitRequestRatio:
        # Limit cannot exceed request by more than this factor
        cpu: "10"
        memory: "4"

    # Per-pod limits (sum of all containers)
    - type: Pod
      max:
        cpu: "16"
        memory: 32Gi

    # Per-PVC limits
    - type: PersistentVolumeClaim
      max:
        storage: 1Ti
      min:
        storage: 1Gi
```

```yaml
# limitrange-development.yaml - more permissive for dev
apiVersion: v1
kind: LimitRange
metadata:
  name: development-limits
  namespace: development
spec:
  limits:
    - type: Container
      default:
        cpu: 500m
        memory: 256Mi
      defaultRequest:
        cpu: 50m
        memory: 64Mi
      min:
        cpu: 5m
        memory: 16Mi
      max:
        cpu: "4"
        memory: 4Gi
      maxLimitRequestRatio:
        cpu: "20"
        memory: "8"
```

```bash
# Apply LimitRange
kubectl apply -f limitrange-production.yaml

# Verify
kubectl describe limitrange production-limits -n production

# Check if LimitRange is being applied to existing pods
kubectl get pods -n production -o yaml | \
  grep -A5 "resources:"
```

### ResourceQuota for Namespace Caps

```yaml
# resourcequota-production.yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: production-quota
  namespace: production
spec:
  hard:
    # Total compute across all pods in the namespace
    requests.cpu: "50"
    requests.memory: 200Gi
    limits.cpu: "200"
    limits.memory: 400Gi

    # Object counts
    pods: "200"
    services: "50"
    persistentvolumeclaims: "100"
    services.loadbalancers: "5"
    services.nodeports: "0"  # no NodePort in production

    # Storage
    requests.storage: 10Ti
    gold.storageclass.storage.k8s.io/requests.storage: 2Ti
```

## Section 5: Reading and Acting on Recommendations

### Extracting Recommendations Programmatically

```bash
#!/bin/bash
# goldilocks-extract-recommendations.sh
# Extract VPA recommendations for all namespaces and format as table

echo "Namespace | Deployment | Container | CPU Request | CPU Target | Memory Request | Memory Target | Savings"
echo "---------|------------|-----------|------------|------------|----------------|---------------|--------"

kubectl get vpa --all-namespaces -o json | \
jq -r '
  .items[] |
  . as $vpa |
  .metadata.namespace as $ns |
  .metadata.name as $name |
  .status.recommendation.containerRecommendations[]? |
  . as $rec |
  {
    namespace: $ns,
    deployment: $name,
    container: $rec.containerName,
    cpu_target: $rec.target.cpu,
    cpu_lower: $rec.lowerBound.cpu,
    mem_target: $rec.target.memory,
    mem_lower: $rec.lowerBound.memory
  } |
  "\(.namespace) | \(.deployment) | \(.container) | \(.cpu_lower) | \(.cpu_target) | \(.mem_lower) | \(.mem_target)"
' | column -t -s '|'
```

### Generating Kubernetes Manifest Patches

```bash
#!/bin/bash
# goldilocks-generate-patches.sh
# Generate kubectl patch commands from VPA recommendations

NAMESPACE="${1:-production}"
DRY_RUN="${2:-true}"  # set to false to apply

kubectl get vpa -n "${NAMESPACE}" -o json | \
jq -r '
  .items[] |
  . as $vpa |
  .metadata.name as $name |
  .status.recommendation.containerRecommendations[]? |
  . as $rec |
  {
    deployment: $name,
    container: $rec.containerName,
    cpu_request: $rec.target.cpu,
    memory_request: $rec.target.memory
  }
' | jq -c '.' | while read -r rec; do
  DEPLOYMENT=$(echo "${rec}" | jq -r '.deployment')
  CONTAINER=$(echo "${rec}" | jq -r '.container')
  CPU=$(echo "${rec}" | jq -r '.cpu_request')
  MEMORY=$(echo "${rec}" | jq -r '.memory_request')

  PATCH=$(cat <<EOF
[
  {
    "op": "replace",
    "path": "/spec/template/spec/containers/0/resources/requests/cpu",
    "value": "${CPU}"
  },
  {
    "op": "replace",
    "path": "/spec/template/spec/containers/0/resources/requests/memory",
    "value": "${MEMORY}"
  }
]
EOF
)

  if [[ "${DRY_RUN}" == "true" ]]; then
    echo "--- Would patch ${NAMESPACE}/${DEPLOYMENT} (${CONTAINER}): CPU=${CPU} Memory=${MEMORY}"
    kubectl patch deployment "${DEPLOYMENT}" -n "${NAMESPACE}" \
      --type=json \
      -p="${PATCH}" \
      --dry-run=client
  else
    echo "Patching ${NAMESPACE}/${DEPLOYMENT} (${CONTAINER}): CPU=${CPU} Memory=${MEMORY}"
    kubectl patch deployment "${DEPLOYMENT}" -n "${NAMESPACE}" \
      --type=json \
      -p="${PATCH}"
  fi
done
```

## Section 6: Prometheus Metrics

### Goldilocks Prometheus Integration

Configure Goldilocks to expose metrics:

```yaml
# Add to goldilocks-values.yaml
metrics:
  enabled: true
  serviceMonitor:
    enabled: true
    additionalLabels:
      release: kube-prometheus-stack
    interval: 60s
```

The VPA Recommender exposes metrics that you can scrape directly:

```yaml
# ServiceMonitor for VPA Recommender
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: vpa-recommender
  namespace: monitoring
  labels:
    release: kube-prometheus-stack
spec:
  namespaceSelector:
    matchNames:
      - vpa-system
  selector:
    matchLabels:
      app: vpa-recommender
  endpoints:
    - port: metrics
      interval: 60s
      path: /metrics
```

### Key Prometheus Queries

```promql
# ── VPA Recommendation Metrics ───────────────────────────────────────────────

# CPU recommendation target vs current request
# Shows over-provisioned deployments (request >> recommendation)
kube_verticalpodautoscaler_status_recommendation_containerrecommendations_target{
  resource="cpu",
  unit="cores"
}
/
kube_verticalpodautoscaler_spec_resourcepolicy_container_policies_minallowed{
  resource="cpu"
}

# Deployments where current CPU request is more than 2x the VPA recommendation
(
  kube_deployment_spec_strategy_rollingupdate_max_surge
  * 0
  + on(namespace, deployment) group_left()
  label_replace(
    kube_verticalpodautoscaler_status_recommendation_containerrecommendations_target{resource="cpu"},
    "deployment", "$1", "verticalpodautoscaler", "(.*)"
  )
) unless (
  kube_verticalpodautoscaler_status_recommendation_containerrecommendations_target{resource="cpu"}
  * 2 >= on(namespace, container) kube_pod_container_resource_requests{resource="cpu"}
)

# Memory over-provisioning ratio
label_replace(
  kube_verticalpodautoscaler_status_recommendation_containerrecommendations_target{resource="memory"},
  "deployment", "$1", "verticalpodautoscaler", "(.*)"
) as $rec
on(namespace, deployment) group_left()
kube_pod_container_resource_requests{resource="memory"} as $req

# Shows namespace-level resource waste
sum by (namespace) (
  kube_pod_container_resource_requests{resource="cpu"}
  -
  on(namespace, pod, container) group_left()
  label_replace(
    kube_verticalpodautoscaler_status_recommendation_containerrecommendations_target{resource="cpu"},
    "pod", "", "", ""
  )
)

# ── Namespace Utilization vs Requests ────────────────────────────────────────

# CPU utilization efficiency per namespace
sum by (namespace) (
  rate(container_cpu_usage_seconds_total{container!="", container!="POD"}[5m])
)
/
sum by (namespace) (
  kube_pod_container_resource_requests{resource="cpu", container!=""}
)

# Memory utilization efficiency per namespace
sum by (namespace) (
  container_memory_working_set_bytes{container!="", container!="POD"}
)
/
sum by (namespace) (
  kube_pod_container_resource_requests{resource="memory", container!=""}
)

# Cluster-wide resource efficiency score (target: >60%)
(
  sum(rate(container_cpu_usage_seconds_total{container!="", container!="POD"}[5m]))
  /
  sum(kube_pod_container_resource_requests{resource="cpu", container!=""})
) * 100
```

### Recording Rules for Efficiency Reporting

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: goldilocks-vpa-efficiency
  namespace: monitoring
  labels:
    release: kube-prometheus-stack
spec:
  groups:
    - name: vpa.efficiency
      interval: 5m
      rules:
        - record: namespace:cpu_request_efficiency:ratio
          expr: |
            sum by (namespace) (
              rate(container_cpu_usage_seconds_total{
                container!="",
                container!="POD"
              }[5m])
            )
            /
            sum by (namespace) (
              kube_pod_container_resource_requests{
                resource="cpu",
                container!=""
              }
            )

        - record: namespace:memory_request_efficiency:ratio
          expr: |
            sum by (namespace) (
              container_memory_working_set_bytes{
                container!="",
                container!="POD"
              }
            )
            /
            sum by (namespace) (
              kube_pod_container_resource_requests{
                resource="memory",
                container!=""
              }
            )

        - record: deployment:cpu_overprovisioned_cores
          expr: |
            sum by (namespace, deployment) (
              kube_pod_container_resource_requests{resource="cpu"}
            )
            -
            sum by (namespace, deployment) (
              label_replace(
                kube_verticalpodautoscaler_status_recommendation_containerrecommendations_target{resource="cpu"},
                "deployment", "$1", "verticalpodautoscaler", "(.*)"
              ) * on(namespace) group_left()
              kube_deployment_status_replicas
            )

        - record: cluster:monthly_cpu_waste_cost_usd
          expr: |
            # Assumes $0.048 per core-hour (us-east-1 on-demand)
            sum(deployment:cpu_overprovisioned_cores) * 0.048 * 730

    - name: vpa.alerts
      rules:
        - alert: HighCPUOverProvisioning
          expr: namespace:cpu_request_efficiency:ratio < 0.10
          for: 30m
          labels:
            severity: warning
          annotations:
            summary: "CPU efficiency below 10% in {{ $labels.namespace }}"
            description: "Namespace {{ $labels.namespace }} is using only {{ $value | humanizePercentage }} of requested CPU"

        - alert: HighMemoryOverProvisioning
          expr: namespace:memory_request_efficiency:ratio < 0.20
          for: 30m
          labels:
            severity: warning
          annotations:
            summary: "Memory efficiency below 20% in {{ $labels.namespace }}"
```

## Section 7: Automated Weekly Resource Reports

### Report Generation Script

```bash
#!/bin/bash
# goldilocks-weekly-report.sh
# Generates a comprehensive resource efficiency report

REPORT_DATE=$(date +%Y-%m-%d)
PROMETHEUS_URL="${PROMETHEUS_URL:-http://prometheus.monitoring.svc.cluster.local:9090}"

query_prometheus() {
  local query="$1"
  curl -sf \
    "${PROMETHEUS_URL}/api/v1/query" \
    --data-urlencode "query=${query}" \
    | jq -r '.data.result'
}

echo "# Kubernetes Resource Efficiency Report"
echo "Generated: ${REPORT_DATE}"
echo ""

echo "## Cluster Summary"
echo ""

# Overall efficiency
CPU_EFF=$(query_prometheus \
  'sum(rate(container_cpu_usage_seconds_total{container!="",container!="POD"}[1h])) / sum(kube_pod_container_resource_requests{resource="cpu",container!=""}) * 100' \
  | jq -r '.[0].value[1]')
MEM_EFF=$(query_prometheus \
  'sum(container_memory_working_set_bytes{container!="",container!="POD"}) / sum(kube_pod_container_resource_requests{resource="memory",container!=""}) * 100' \
  | jq -r '.[0].value[1]')

printf "CPU Request Efficiency:    %.1f%%\n" "${CPU_EFF:-0}"
printf "Memory Request Efficiency: %.1f%%\n" "${MEM_EFF:-0}"

echo ""
echo "## Top 10 Most Over-Provisioned Deployments (CPU)"
echo ""

kubectl get vpa --all-namespaces -o json | jq -r '
  .items[] |
  . as $vpa |
  select(.status.recommendation != null) |
  .metadata.namespace as $ns |
  .metadata.name as $name |
  .status.recommendation.containerRecommendations[0] |
  {
    namespace: $ns,
    deployment: $name,
    cpu_recommendation: (.target.cpu // "N/A"),
    cpu_lower: (.lowerBound.cpu // "N/A"),
    cpu_upper: (.upperBound.cpu // "N/A"),
    mem_recommendation: (.target.memory // "N/A"),
    mem_lower: (.lowerBound.memory // "N/A")
  }
' | jq -s 'sort_by(.namespace, .deployment)' | \
  jq -r '.[] | "\(.namespace)\t\(.deployment)\t\(.cpu_lower)\t\(.cpu_recommendation)\t\(.cpu_upper)\t\(.mem_lower)\t\(.mem_recommendation)"' | \
  column -t -N "NAMESPACE,DEPLOYMENT,CPU-LOW,CPU-TARGET,CPU-HIGH,MEM-LOW,MEM-TARGET"

echo ""
echo "## Namespace Efficiency Summary"
echo ""

query_prometheus \
  'sum by (namespace) (namespace:cpu_request_efficiency:ratio) * 100' | \
  jq -r '.[] | "\(.metric.namespace)\t\(.value[1])"' | \
  awk '{printf "%-30s CPU efficiency: %.1f%%\n", $1, $2}' | \
  sort -k4 -n
```

### Kubernetes CronJob for Automated Reports

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: goldilocks-weekly-report
  namespace: goldilocks
spec:
  schedule: "0 8 * * 1"  # Every Monday at 8 AM
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 1
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: goldilocks-reporter
          restartPolicy: OnFailure
          containers:
            - name: reporter
              image: bitnami/kubectl:1.29
              command:
                - /bin/bash
                - /scripts/generate-report.sh
              env:
                - name: PROMETHEUS_URL
                  value: "http://prometheus-operated.monitoring.svc.cluster.local:9090"
                - name: SLACK_WEBHOOK_URL
                  valueFrom:
                    secretKeyRef:
                      name: goldilocks-secrets
                      key: slack-webhook-url
              volumeMounts:
                - name: scripts
                  mountPath: /scripts
          volumes:
            - name: scripts
              configMap:
                name: goldilocks-report-scripts
                defaultMode: 0755
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: goldilocks-reporter
  namespace: goldilocks
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: goldilocks-reporter
rules:
  - apiGroups: ["autoscaling.k8s.io"]
    resources: ["verticalpodautoscalers"]
    verbs: ["get", "list"]
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get", "list", "patch"]
  - apiGroups: [""]
    resources: ["namespaces", "pods"]
    verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: goldilocks-reporter
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: goldilocks-reporter
subjects:
  - kind: ServiceAccount
    name: goldilocks-reporter
    namespace: goldilocks
```

## Section 8: Grafana Dashboard for VPA Recommendations

```json
{
  "title": "Goldilocks - VPA Resource Recommendations",
  "uid": "goldilocks-vpa",
  "panels": [
    {
      "id": 1,
      "title": "Cluster CPU Request Efficiency",
      "type": "gauge",
      "gridPos": {"h": 6, "w": 6, "x": 0, "y": 0},
      "targets": [
        {
          "expr": "sum(rate(container_cpu_usage_seconds_total{container!='',container!='POD'}[5m])) / sum(kube_pod_container_resource_requests{resource='cpu',container!=''}) * 100",
          "legendFormat": "CPU Efficiency %"
        }
      ],
      "fieldConfig": {
        "defaults": {
          "unit": "percent",
          "min": 0,
          "max": 100,
          "thresholds": {
            "steps": [
              {"color": "red", "value": 0},
              {"color": "orange", "value": 20},
              {"color": "yellow", "value": 40},
              {"color": "green", "value": 60}
            ]
          }
        }
      }
    },
    {
      "id": 2,
      "title": "Cluster Memory Request Efficiency",
      "type": "gauge",
      "gridPos": {"h": 6, "w": 6, "x": 6, "y": 0},
      "targets": [
        {
          "expr": "sum(container_memory_working_set_bytes{container!='',container!='POD'}) / sum(kube_pod_container_resource_requests{resource='memory',container!=''}) * 100",
          "legendFormat": "Memory Efficiency %"
        }
      ],
      "fieldConfig": {
        "defaults": {
          "unit": "percent",
          "min": 0,
          "max": 100,
          "thresholds": {
            "steps": [
              {"color": "red", "value": 0},
              {"color": "orange", "value": 30},
              {"color": "yellow", "value": 50},
              {"color": "green", "value": 70}
            ]
          }
        }
      }
    },
    {
      "id": 3,
      "title": "CPU Efficiency by Namespace",
      "type": "bargauge",
      "gridPos": {"h": 12, "w": 12, "x": 0, "y": 6},
      "targets": [
        {
          "expr": "sum by (namespace) (rate(container_cpu_usage_seconds_total{container!='',container!='POD'}[5m])) / sum by (namespace) (kube_pod_container_resource_requests{resource='cpu',container!=''}) * 100",
          "legendFormat": "{{namespace}}"
        }
      ],
      "fieldConfig": {
        "defaults": {
          "unit": "percent",
          "thresholds": {
            "steps": [
              {"color": "red", "value": 0},
              {"color": "orange", "value": 10},
              {"color": "yellow", "value": 30},
              {"color": "green", "value": 60}
            ]
          }
        }
      }
    },
    {
      "id": 4,
      "title": "Monthly CPU Waste Cost (Estimated)",
      "type": "stat",
      "gridPos": {"h": 6, "w": 6, "x": 12, "y": 0},
      "targets": [
        {
          "expr": "cluster:monthly_cpu_waste_cost_usd",
          "legendFormat": "Monthly Waste Cost"
        }
      ],
      "fieldConfig": {
        "defaults": {
          "unit": "currencyUSD",
          "thresholds": {
            "steps": [
              {"color": "green", "value": 0},
              {"color": "yellow", "value": 100},
              {"color": "orange", "value": 500},
              {"color": "red", "value": 1000}
            ]
          }
        }
      }
    }
  ],
  "templating": {
    "list": [
      {
        "name": "namespace",
        "type": "query",
        "query": "label_values(kube_pod_container_resource_requests, namespace)",
        "multi": true,
        "includeAll": true
      }
    ]
  },
  "time": {"from": "now-7d", "to": "now"},
  "refresh": "5m"
}
```

## Section 9: Operational Procedures

### Applying Recommendations Safely

The recommended workflow for applying VPA recommendations:

```bash
#!/bin/bash
# apply-vpa-recommendations.sh
# Safe, staged application of VPA recommendations

NAMESPACE="$1"
DRY_RUN="${2:-true}"

if [[ -z "${NAMESPACE}" ]]; then
  echo "Usage: $0 <namespace> [apply]"
  exit 1
fi

# Get all VPA recommendations in the namespace
kubectl get vpa -n "${NAMESPACE}" -o json | jq -c '
  .items[] |
  select(.status.recommendation != null) |
  {
    name: .metadata.name,
    containers: [
      .status.recommendation.containerRecommendations[] |
      {
        name: .containerName,
        cpu: .target.cpu,
        memory: .target.memory,
        cpu_lower: .lowerBound.cpu,
        cpu_upper: .upperBound.cpu
      }
    ]
  }
' | while read -r vpa_rec; do
  DEPLOYMENT=$(echo "${vpa_rec}" | jq -r '.name')

  echo "=== ${NAMESPACE}/${DEPLOYMENT} ==="

  # Check if deployment exists
  if ! kubectl get deployment "${DEPLOYMENT}" -n "${NAMESPACE}" &>/dev/null; then
    echo "  Skipping: deployment not found (may be a StatefulSet)"
    continue
  fi

  # Show current vs recommended
  CURRENT_CPU=$(kubectl get deployment "${DEPLOYMENT}" -n "${NAMESPACE}" \
    -o jsonpath='{.spec.template.spec.containers[0].resources.requests.cpu}')
  CURRENT_MEM=$(kubectl get deployment "${DEPLOYMENT}" -n "${NAMESPACE}" \
    -o jsonpath='{.spec.template.spec.containers[0].resources.requests.memory}')
  TARGET_CPU=$(echo "${vpa_rec}" | jq -r '.containers[0].cpu')
  TARGET_MEM=$(echo "${vpa_rec}" | jq -r '.containers[0].memory')

  echo "  Current:     CPU=${CURRENT_CPU:-unset}, Memory=${CURRENT_MEM:-unset}"
  echo "  Recommended: CPU=${TARGET_CPU}, Memory=${TARGET_MEM}"

  if [[ "${DRY_RUN}" != "apply" ]]; then
    echo "  [DRY RUN] Would update resources"
    continue
  fi

  # Apply the recommendation
  kubectl set resources deployment "${DEPLOYMENT}" \
    -n "${NAMESPACE}" \
    --containers='*' \
    --requests="cpu=${TARGET_CPU},memory=${TARGET_MEM}"

  echo "  Applied!"
done
```

## Conclusion

Goldilocks transforms resource management from a guessing game into a data-driven process. The workflow is: annotate namespaces, let VPA collect at least one week of utilization data, review recommendations through the dashboard or Prometheus queries, apply changes using the staged patch process, and set up LimitRange to prevent future over-provisioning. The Prometheus recording rules enable long-term cost tracking that justifies the engineering investment in right-sizing workloads. Clusters that go through a full Goldilocks optimization cycle typically see 30-60% reduction in resource requests while maintaining or improving reliability through more accurate limit-to-request ratios.
