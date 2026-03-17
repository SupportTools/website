---
title: "Kubernetes Resource Quotas and LimitRanges: Namespace Resource Management"
date: 2027-12-03T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Resource Quota", "LimitRange", "Namespace", "Multi-Tenancy"]
categories:
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes ResourceQuota and LimitRange objects for namespace-level resource management, covering quota scopes, admission controller behavior, default limits, storage quotas, object count quotas, and Prometheus monitoring."
more_link: "yes"
url: "/kubernetes-resource-quota-limit-range-guide/"
---

Resource quotas and limit ranges are the foundation of multi-tenant resource governance in Kubernetes. Without them, a single namespace can consume all cluster resources, starving other tenants. With them poorly configured, teams find their workloads randomly evicted or unable to deploy. This guide covers production-ready configurations that enforce resource governance without creating operational friction.

<!--more-->

# Kubernetes Resource Quotas and LimitRanges: Namespace Resource Management

## The Two-Layer Resource Management Model

Kubernetes uses two complementary objects for resource governance:

**ResourceQuota** operates at the namespace level. It sets an upper bound on the total resources all objects in a namespace can collectively consume: total CPU, total memory, total PVC storage, number of pods, number of services.

**LimitRange** operates at the individual object level within a namespace. It sets defaults for objects that do not specify resource requests and limits, and enforces minimum and maximum values per container. If a pod is submitted without resource requests, LimitRange injects them—preventing the creation of resource-hungry pods that count against quota as zero but consume unbounded real resources.

The two objects work together: LimitRange ensures every pod has resource requests, and ResourceQuota ensures the sum of all resource requests does not exceed the namespace budget.

## Section 1: ResourceQuota Object Types

### Compute Resource Quotas

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: compute-resources
  namespace: team-payments
spec:
  hard:
    # CPU limits: total CPU limits across all pods
    limits.cpu: "40"
    # CPU requests: total CPU requests (guaranteed allocation)
    requests.cpu: "20"
    # Memory limits
    limits.memory: 80Gi
    # Memory requests (guaranteed allocation)
    requests.memory: 40Gi
    # Extended resources (e.g., GPUs)
    requests.nvidia.com/gpu: "4"
```

### Storage Resource Quotas

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: storage-resources
  namespace: team-payments
spec:
  hard:
    # Total PVC storage requests across all PVCs
    requests.storage: 500Gi
    # Per-StorageClass limits (prevents using expensive storage for non-critical data)
    fast-nvme.storageclass.storage.k8s.io/requests.storage: 200Gi
    standard-ssd.storageclass.storage.k8s.io/requests.storage: 300Gi
    # Number of PVCs
    persistentvolumeclaims: "20"
    # PVCs per storage class
    fast-nvme.storageclass.storage.k8s.io/persistentvolumeclaims: "5"
    # Ephemeral storage (local disk in containers)
    requests.ephemeral-storage: 50Gi
    limits.ephemeral-storage: 100Gi
```

### Object Count Quotas

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: object-counts
  namespace: team-payments
spec:
  hard:
    # Workload objects
    pods: "100"
    replicationcontrollers: "0"  # Disallow legacy objects
    # Networking
    services: "20"
    services.loadbalancers: "3"  # Expensive cloud load balancers
    services.nodeports: "5"
    # Configuration
    secrets: "100"
    configmaps: "50"
    # Other
    count/deployments.apps: "30"
    count/statefulsets.apps: "10"
    count/daemonsets.apps: "0"   # DaemonSets should be managed at cluster level
    count/jobs.batch: "20"
    count/cronjobs.batch: "10"
    count/ingresses.networking.k8s.io: "15"
    count/horizontalpodautoscalers.autoscaling: "20"
```

### Complete Production Namespace Quota

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: production-quota
  namespace: team-payments
  annotations:
    quota.acme.corp/team: "payments"
    quota.acme.corp/tier: "production"
    quota.acme.corp/last-reviewed: "2024-01-15"
spec:
  hard:
    # Compute
    requests.cpu: "20"
    limits.cpu: "40"
    requests.memory: 40Gi
    limits.memory: 80Gi
    # Storage
    requests.storage: 500Gi
    fast-nvme.storageclass.storage.k8s.io/requests.storage: 200Gi
    persistentvolumeclaims: "20"
    requests.ephemeral-storage: 50Gi
    limits.ephemeral-storage: 100Gi
    # Objects
    pods: "100"
    services: "20"
    services.loadbalancers: "3"
    secrets: "100"
    configmaps: "50"
    count/deployments.apps: "30"
    count/statefulsets.apps: "10"
    count/ingresses.networking.k8s.io: "15"
```

## Section 2: Quota Scopes

Quota scopes allow applying quotas only to pods that match specific criteria. This is particularly useful for managing burst capacity and terminating jobs separately from long-running services.

### BestEffort Scope

Applies only to pods with BestEffort QoS class (no resource requests or limits):

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: best-effort-limit
  namespace: team-payments
spec:
  hard:
    pods: "5"  # Very few BestEffort pods allowed
  scopes:
  - BestEffort
```

### Terminating Scope

Applies only to pods with an `activeDeadlineSeconds` field set (Jobs, Spark tasks, batch workloads):

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: batch-quota
  namespace: team-payments
spec:
  hard:
    requests.cpu: "10"
    requests.memory: 20Gi
    pods: "50"
  scopes:
  - Terminating  # Only applies to pods with activeDeadlineSeconds set
```

### NotTerminating Scope

Applies only to long-running pods (Deployments, StatefulSets):

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: service-quota
  namespace: team-payments
spec:
  hard:
    requests.cpu: "20"
    requests.memory: 40Gi
    pods: "100"
  scopes:
  - NotTerminating
```

### PriorityClass Scope

Control resource allocation per priority class, ensuring high-priority workloads have dedicated budget:

```yaml
# First, define priority classes
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: high-priority
value: 1000
globalDefault: false
description: "Critical business workloads"
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: low-priority
value: 100
globalDefault: false
description: "Batch and background workloads"
---
# Quota for high-priority pods only
apiVersion: v1
kind: ResourceQuota
metadata:
  name: high-priority-quota
  namespace: team-payments
spec:
  hard:
    requests.cpu: "10"
    requests.memory: 20Gi
    pods: "20"
  scopeSelector:
    matchExpressions:
    - operator: In
      scopeName: PriorityClass
      values:
      - high-priority
---
# Quota for low-priority pods
apiVersion: v1
kind: ResourceQuota
metadata:
  name: low-priority-quota
  namespace: team-payments
spec:
  hard:
    requests.cpu: "5"
    requests.memory: 10Gi
    pods: "30"
  scopeSelector:
    matchExpressions:
    - operator: In
      scopeName: PriorityClass
      values:
      - low-priority
```

## Section 3: LimitRange Configuration

### Container Limits

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: container-limits
  namespace: team-payments
spec:
  limits:
  - type: Container
    # Default values injected when not specified
    default:
      cpu: 500m
      memory: 512Mi
      ephemeral-storage: 1Gi
    # Default requests (if requests not specified but limits are)
    defaultRequest:
      cpu: 100m
      memory: 128Mi
      ephemeral-storage: 256Mi
    # Minimum allowed values (admission refuses lower)
    min:
      cpu: 50m
      memory: 64Mi
    # Maximum allowed values (admission refuses higher)
    max:
      cpu: "8"
      memory: 16Gi
      ephemeral-storage: 20Gi
    # Maximum ratio of limits to requests
    # Prevents cpu limit: 100 with cpu request: 1 (100:1 ratio is dangerous)
    maxLimitRequestRatio:
      cpu: "4"
      memory: "4"
```

### Pod and PVC Limits

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: pod-and-storage-limits
  namespace: team-payments
spec:
  limits:
  # Pod-level limits (sum of all containers)
  - type: Pod
    max:
      cpu: "16"
      memory: 32Gi
    min:
      cpu: 100m
      memory: 128Mi
  # PVC storage limits
  - type: PersistentVolumeClaim
    max:
      storage: 100Gi
    min:
      storage: 1Gi
  # Init container limits (separate from regular containers)
  - type: Container
    default:
      cpu: 200m
      memory: 256Mi
    defaultRequest:
      cpu: 50m
      memory: 64Mi
    max:
      cpu: "4"
      memory: 8Gi
```

## Section 4: Admission Controller Behavior

### How Admission Works

When a pod is submitted, the resource admission chain operates as follows:

```
Pod Submitted
    |
    v
LimitRange Defaulting Webhook
    - Inject default requests/limits for containers missing them
    - Validate min/max per container
    - Validate maxLimitRequestRatio
    |
    v (pod now has resource requests)
ResourceQuota Admission
    - Sum up existing namespace usage
    - Add new pod's requests
    - If sum > hard limit: reject with 403 Forbidden
    - If sum <= hard limit: admit and record usage
    |
    v
Pod Admitted
```

### Testing Admission Controller Behavior

```bash
# Namespace with quota and limit range configured
NAMESPACE="team-payments"

# Test 1: Pod without resource limits (LimitRange should inject defaults)
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: no-limits-test
  namespace: team-payments
spec:
  containers:
  - name: nginx
    image: nginx:1.25.3
    # No resources specified - LimitRange should inject defaults
EOF

# Verify defaults were injected
kubectl get pod no-limits-test -n team-payments \
  -o jsonpath='{.spec.containers[0].resources}' | jq .

# Expected output:
# {
#   "limits": {"cpu": "500m", "memory": "512Mi"},
#   "requests": {"cpu": "100m", "memory": "128Mi"}
# }

# Test 2: Pod that exceeds maxLimitRequestRatio
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: bad-ratio-test
  namespace: team-payments
spec:
  containers:
  - name: nginx
    image: nginx:1.25.3
    resources:
      requests:
        cpu: 100m
      limits:
        cpu: "2"  # 20:1 ratio - exceeds maxLimitRequestRatio of 4
EOF
# Expected: admission error about maxLimitRequestRatio

# Test 3: Pod that exceeds quota
# First, check current quota usage
kubectl describe quota -n "$NAMESPACE"

# Calculate remaining capacity and try to exceed it
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: quota-exceed-test
  namespace: team-payments
spec:
  containers:
  - name: nginx
    image: nginx:1.25.3
    resources:
      requests:
        cpu: "100"   # Exceeds quota
      limits:
        cpu: "100"
EOF
# Expected: 403 Forbidden - exceeded quota
```

### Namespace Resource Budget Report

```bash
#!/bin/bash
# namespace-budget-report.sh - Report resource usage vs quota

NAMESPACE="${1:?Usage: $0 <namespace>}"

echo "=== Resource Budget Report: $NAMESPACE ==="
echo ""

# Get quota status
QUOTAS=$(kubectl get resourcequota -n "$NAMESPACE" -o json 2>/dev/null)

if [ -z "$QUOTAS" ] || [ "$(echo "$QUOTAS" | jq '.items | length')" = "0" ]; then
  echo "No ResourceQuotas found in $NAMESPACE"
  exit 0
fi

echo "$QUOTAS" | jq -r '
.items[] |
"Quota: \(.metadata.name)",
"  Resource | Hard | Used | Available | % Used",
"  ---------|------|------|-----------|-------",
(.status | to_entries |
  map({
    key: .key,
    hard: (.hard[.key] // "N/A"),
    used: (.used[.key] // "0")
  }) |
  .[] |
  "  \(.key) | \(.hard) | \(.used)"
),
""
'

# Actual pod resource usage vs requested
echo "=== Actual Pod Resource Usage ==="
kubectl top pods -n "$NAMESPACE" 2>/dev/null || echo "Metrics server not available"

echo ""
echo "=== LimitRange Configuration ==="
kubectl get limitrange -n "$NAMESPACE" -o yaml 2>/dev/null | \
  grep -A 5 "limits:" | head -30
```

## Section 5: Quota Monitoring with Prometheus

### Prometheus Alerting Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: resource-quota-alerts
  namespace: monitoring
spec:
  groups:
  - name: resource-quota
    interval: 60s
    rules:
    # Alert when any quota is over 80% utilized
    - alert: ResourceQuotaHighUsage
      expr: |
        (
          kube_resourcequota{type="used"}
          /
          kube_resourcequota{type="hard"} > 0.80
        )
        * on(namespace, resource) group_left(type)
        kube_resourcequota{type="hard"}
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "ResourceQuota {{ $labels.namespace }}/{{ $labels.resource }} is at {{ $value | humanizePercentage }}"
        description: "Namespace {{ $labels.namespace }} has used {{ $value | humanizePercentage }} of its {{ $labels.resource }} quota. Consider requesting a quota increase."
        runbook_url: "https://wiki.acme.corp/runbooks/quota-exhaustion"

    # Alert when quota is near exhaustion (95%)
    - alert: ResourceQuotaNearExhaustion
      expr: |
        (
          kube_resourcequota{type="used"}
          /
          kube_resourcequota{type="hard"} > 0.95
        )
      for: 2m
      labels:
        severity: critical
      annotations:
        summary: "ResourceQuota {{ $labels.namespace }}/{{ $labels.resource }} is NEAR EXHAUSTION at {{ $value | humanizePercentage }}"
        description: "Namespace {{ $labels.namespace }} is at {{ $value | humanizePercentage }} of its {{ $labels.resource }} quota. New deployments may fail."

    # Alert when pod quota is exhausted (100%)
    - alert: PodQuotaExhausted
      expr: |
        kube_resourcequota{resource="pods",type="used"}
        >=
        kube_resourcequota{resource="pods",type="hard"}
      for: 1m
      labels:
        severity: critical
      annotations:
        summary: "Pod quota EXHAUSTED in {{ $labels.namespace }}"
        description: "Namespace {{ $labels.namespace }} pod quota is fully consumed. No new pods can be scheduled."

    # Alert on unusual quota growth (fast consumption)
    - alert: ResourceQuotaRapidGrowth
      expr: |
        (
          kube_resourcequota{type="used",resource="requests.cpu"}
          -
          kube_resourcequota{type="used",resource="requests.cpu"} offset 1h
        )
        /
        kube_resourcequota{type="hard",resource="requests.cpu"} > 0.20
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "CPU quota in {{ $labels.namespace }} grew by >20% in 1 hour"
        description: "Possible runaway deployment or misconfiguration."
```

### Grafana Dashboard Configuration

```json
{
  "title": "Kubernetes Resource Quotas",
  "panels": [
    {
      "title": "CPU Request Utilization by Namespace",
      "type": "bargauge",
      "targets": [
        {
          "expr": "kube_resourcequota{resource='requests.cpu',type='used'} / kube_resourcequota{resource='requests.cpu',type='hard'} * 100",
          "legendFormat": "{{namespace}}"
        }
      ],
      "options": {
        "orientation": "horizontal",
        "reduceOptions": {"calcs": ["lastNotNull"]},
        "thresholds": {
          "mode": "absolute",
          "steps": [
            {"color": "green", "value": null},
            {"color": "yellow", "value": 80},
            {"color": "red", "value": 95}
          ]
        }
      }
    },
    {
      "title": "Memory Request Utilization by Namespace",
      "type": "bargauge",
      "targets": [
        {
          "expr": "kube_resourcequota{resource='requests.memory',type='used'} / kube_resourcequota{resource='requests.memory',type='hard'} * 100",
          "legendFormat": "{{namespace}}"
        }
      ]
    },
    {
      "title": "Pod Count vs Quota",
      "type": "table",
      "targets": [
        {
          "expr": "kube_resourcequota{resource='pods'}",
          "legendFormat": "{{namespace}} - {{type}}"
        }
      ]
    }
  ]
}
```

### Custom Metrics for Quota Tracking

```bash
# Prometheus query for complete quota utilization report
# Use this in scripts, dashboards, or alerting rules

# CPU request utilization per namespace
kubectl exec -n monitoring prometheus-0 -- \
  promtool query instant \
  'sort_desc(kube_resourcequota{resource="requests.cpu",type="used"} / kube_resourcequota{resource="requests.cpu",type="hard"} * 100)' \
  2>/dev/null

# Find namespaces approaching quota limits
kubectl exec -n monitoring prometheus-0 -- \
  promtool query instant \
  'kube_resourcequota{type="used"} / kube_resourcequota{type="hard"} > 0.8' \
  2>/dev/null | jq '.[] | {namespace: .metric.namespace, resource: .metric.resource, pct_used: .value[1]}'
```

## Section 6: Namespace Budget Enforcement Patterns

### Team Budget Enforcement with Hierarchical Quotas

For organizations with teams, departments, and cost centers:

```yaml
# Pattern: Hierarchical quota enforcement
# Level 1: Cluster-level resource pools
# Level 2: Team namespaces within resource pools

# Team namespace with tiered quotas
apiVersion: v1
kind: Namespace
metadata:
  name: team-payments-prod
  labels:
    team: payments
    environment: production
    cost-center: payments-engineering
  annotations:
    quota.acme.corp/team-budget-cpu: "20"
    quota.acme.corp/team-budget-memory: "40Gi"
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: production-budget
  namespace: team-payments-prod
spec:
  hard:
    requests.cpu: "20"
    limits.cpu: "40"
    requests.memory: 40Gi
    limits.memory: 80Gi
    requests.storage: 500Gi
    pods: "100"
    services.loadbalancers: "3"
    count/deployments.apps: "30"
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: staging-budget
  namespace: team-payments-staging
spec:
  hard:
    requests.cpu: "8"
    limits.cpu: "16"
    requests.memory: 16Gi
    limits.memory: 32Gi
    requests.storage: 100Gi
    pods: "50"
    services.loadbalancers: "1"
    count/deployments.apps: "30"
```

### Dynamic Quota Adjustment

```bash
#!/bin/bash
# quota-manager.sh - Manage namespace quotas with approval workflow

NAMESPACE="${1:?}"
ACTION="${2:?increase|decrease|status}"

get_current_quota() {
  kubectl get resourcequota production-budget -n "$NAMESPACE" \
    -o jsonpath='{.spec.hard}' | jq .
}

request_quota_increase() {
  local resource="$1"
  local current="$2"
  local requested="$3"
  
  echo "Quota increase request:"
  echo "  Namespace: $NAMESPACE"
  echo "  Resource: $resource"
  echo "  Current: $current"
  echo "  Requested: $requested"
  
  # Log the request (in production, this would create a ticket)
  kubectl annotate namespace "$NAMESPACE" \
    "quota.acme.corp/pending-request=$resource:$current->$requested" \
    --overwrite
    
  echo "Request recorded. Awaiting platform team approval."
  echo "Slack: #platform-quota-requests"
}

case "$ACTION" in
  status)
    echo "Current quota status for $NAMESPACE:"
    kubectl describe resourcequota -n "$NAMESPACE"
    echo ""
    echo "Current usage:"
    kubectl top pods -n "$NAMESPACE" 2>/dev/null | tail -n +2 | \
      awk '{sum_cpu += $2; sum_mem += $3} END {print "Total CPU:", sum_cpu, "Total Mem:", sum_mem}'
    ;;
  
  increase)
    RESOURCE="${3:?Usage: $0 <namespace> increase <resource> <new-value>}"
    NEW_VALUE="${4:?}"
    CURRENT=$(kubectl get resourcequota production-budget -n "$NAMESPACE" \
      -o jsonpath="{.spec.hard.$RESOURCE}")
    request_quota_increase "$RESOURCE" "$CURRENT" "$NEW_VALUE"
    ;;
  
  apply)
    # Apply an approved quota change
    RESOURCE="${3:?}"
    NEW_VALUE="${4:?}"
    kubectl patch resourcequota production-budget -n "$NAMESPACE" \
      --type='json' \
      -p "[{\"op\": \"replace\", \"path\": \"/spec/hard/$RESOURCE\", \"value\": \"$NEW_VALUE\"}]"
    echo "Quota updated: $RESOURCE = $NEW_VALUE"
    ;;
esac
```

### Preventing Quota Bypass

```yaml
# Ensure all namespaces in the cluster have quotas
# This OPA/Gatekeeper policy enforces it

apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: requireresourcequota
spec:
  crd:
    spec:
      names:
        kind: RequireResourceQuota
  targets:
  - target: admission.k8s.gatekeeper.sh
    rego: |
      package requireresourcequota

      violation[{"msg": msg}] {
        input.review.kind.kind == "Namespace"
        not namespace_has_quota
        msg := sprintf("Namespace %v must have a ResourceQuota", [input.review.object.metadata.name])
      }

      namespace_has_quota {
        # Check if a quota already exists for this namespace
        # (requires caching - simplified version)
        input.review.object.metadata.labels["quota-exempt"] == "true"
      }
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: RequireResourceQuota
metadata:
  name: require-resource-quota
spec:
  match:
    kinds:
    - apiGroups: [""]
      kinds: ["Namespace"]
    excludedNamespaces:
    - kube-system
    - kube-public
    - kube-node-lease
    - monitoring
    - logging
    - ingress-nginx
    - cert-manager
```

## Section 7: LimitRange for Quality of Service Classes

Kubernetes assigns QoS classes based on resource configuration:

- **Guaranteed**: `requests == limits` for all containers. Never OOMKilled first. Best for critical services.
- **Burstable**: `requests < limits` or only limits set. OOMKilled before Guaranteed. Good for most services.
- **BestEffort**: No requests or limits. OOMKilled first. Only for batch workloads where eviction is acceptable.

```yaml
# LimitRange that encourages Guaranteed QoS for critical workloads
# by setting default requests == default limits
apiVersion: v1
kind: LimitRange
metadata:
  name: guaranteed-qos-defaults
  namespace: payments-critical
spec:
  limits:
  - type: Container
    # When both default and defaultRequest are the same,
    # containers without explicit resources get Guaranteed QoS
    default:
      cpu: 500m
      memory: 512Mi
    defaultRequest:
      cpu: 500m    # Same as default = Guaranteed QoS
      memory: 512Mi  # Same as default = Guaranteed QoS
    max:
      cpu: "8"
      memory: 16Gi
    # Enforce 1:1 limit:request ratio to force Guaranteed QoS
    maxLimitRequestRatio:
      cpu: "1"    # Forces requests == limits
      memory: "1" # Forces requests == limits
---
# LimitRange that allows Burstable QoS with controlled overcommit
apiVersion: v1
kind: LimitRange
metadata:
  name: burstable-qos-defaults
  namespace: payments-batch
spec:
  limits:
  - type: Container
    default:
      cpu: 500m
      memory: 512Mi
    defaultRequest:
      cpu: 100m    # requests < limits = Burstable QoS
      memory: 128Mi
    max:
      cpu: "8"
      memory: 16Gi
    maxLimitRequestRatio:
      cpu: "4"    # Allow up to 4x burst
      memory: "4"
```

## Section 8: Quota Status Inspection and Troubleshooting

### Common Quota Rejection Messages

```bash
# When a pod is rejected due to quota:
# Error: pods "my-pod" is forbidden: exceeded quota: compute-resources,
#        requested: requests.cpu=2, used: requests.cpu=19, limited: requests.cpu=20

# When a pod is rejected due to LimitRange:
# Error: pods "my-pod" is forbidden: [maximum cpu usage per Container is 8, but limit is 16.]
# Error: pods "my-pod" is forbidden: [cpu max limit to request ratio per Container is 4, but provided ratio is 10.]

# Check what blocked a recent deployment
kubectl describe deployment my-app -n team-payments
# Look for ReplicaFailure events:
# "Error creating: pods "my-app-xxx" is forbidden: exceeded quota"

kubectl get events -n team-payments --field-selector reason=FailedCreate | tail -20

# Check quota headroom
check_quota_headroom() {
  NAMESPACE="$1"
  echo "Quota headroom for $NAMESPACE:"
  kubectl get resourcequota -n "$NAMESPACE" -o json | jq -r '
    .items[] |
    "Quota: \(.metadata.name)",
    (.status | to_entries |
      map({
        key: .key,
        hard: (.hard[.key] // "N/A"),
        used: (.used[.key] // "0")
      }) |
      .[] |
      "  \(.key): used=\(.used) hard=\(.hard)"
    )
  '
}

check_quota_headroom "team-payments"
```

### Debugging LimitRange Injection

```bash
# Verify LimitRange is active
kubectl get limitrange -n team-payments -o yaml

# Test LimitRange injection on a dry-run
kubectl apply --dry-run=server -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: test-inject
  namespace: team-payments
spec:
  containers:
  - name: test
    image: nginx:1.25.3
EOF
# The dry-run output should show the injected resource values

# Check if LimitRange is applying correctly
kubectl explain limitrange.spec.limits.type
# Types: Container, Pod, PersistentVolumeClaim

# Common issue: LimitRange for containers doesn't apply to init containers
# Must explicitly configure init containers or use a separate LimitRange entry
```

## Section 9: Multi-Tenant Quota Strategy

### Tiered Namespace Model

```bash
# Tier 1: Production (strict quotas, Guaranteed QoS enforced)
kubectl create namespace team-payments-prod
kubectl label namespace team-payments-prod \
  tier=production team=payments environment=production

# Tier 2: Staging (moderate quotas, Burstable QoS)
kubectl create namespace team-payments-staging
kubectl label namespace team-payments-staging \
  tier=staging team=payments environment=staging

# Tier 3: Development (minimal quotas, BestEffort allowed)
kubectl create namespace team-payments-dev
kubectl label namespace team-payments-dev \
  tier=development team=payments environment=development

# Apply quota templates using kustomize overlays
# base/resourcequota.yaml defines the template
# overlays/production/, overlays/staging/, overlays/dev/ customize it
```

### Automatic Quota Application via Namespace Controller

```yaml
# Use Hierarchical Namespace Controller (HNC) for automatic quota propagation
# Or implement with a custom controller/operator
# Simplified version using a CronJob for quota policy enforcement

apiVersion: batch/v1
kind: CronJob
metadata:
  name: quota-policy-enforcer
  namespace: kube-system
spec:
  schedule: "*/15 * * * *"  # Run every 15 minutes
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: quota-enforcer
          containers:
          - name: enforcer
            image: bitnami/kubectl:1.29.0
            command:
            - /bin/sh
            - -c
            - |
              # Apply quota templates to all team namespaces that are missing them
              for ns in $(kubectl get ns -l "tier=production" -o jsonpath='{.items[*].metadata.name}'); do
                if ! kubectl get resourcequota production-quota -n "$ns" &>/dev/null; then
                  echo "Applying production quota to $ns"
                  kubectl apply -f /quota-templates/production.yaml -n "$ns" || true
                fi
              done
            volumeMounts:
            - name: quota-templates
              mountPath: /quota-templates
          volumes:
          - name: quota-templates
            configMap:
              name: quota-templates
          restartPolicy: OnFailure
```

## Section 10: Quota Planning and Capacity Management

### Calculating Namespace Quotas from Workload Requirements

```bash
#!/bin/bash
# quota-calculator.sh - Calculate required quota from workload manifests

MANIFESTS_DIR="${1:?Usage: $0 <manifests-dir>}"

echo "=== Quota Calculator ==="
echo "Analyzing: $MANIFESTS_DIR"
echo ""

# Extract resource requirements from manifests
TOTAL_CPU_REQ=0
TOTAL_CPU_LIM=0
TOTAL_MEM_REQ=0
TOTAL_MEM_LIM=0
POD_COUNT=0

while IFS= read -r -d '' file; do
  # This is a simplified version; a real implementation would parse YAML properly
  if kubectl apply --dry-run=client -f "$file" &>/dev/null; then
    CPU_REQ=$(kubectl apply --dry-run=client -f "$file" -o json 2>/dev/null | \
      jq -r '.. | .requests?.cpu? // empty' | \
      xargs -I{} sh -c 'echo {} | sed "s/m//" | awk "{print int(\$1 / (index(\$1, \"m\") > 0 ? 1 : 1000))}"' | \
      paste -sd+ | bc 2>/dev/null || echo 0)
    
    POD_COUNT=$((POD_COUNT + 1))
  fi
done < <(find "$MANIFESTS_DIR" -name '*.yaml' -print0)

echo "Analyzed $POD_COUNT workload manifests"
echo ""
echo "Recommended quota settings (add 20% buffer):"
echo "  requests.cpu: $(echo "scale=0; ($TOTAL_CPU_REQ * 120) / 100" | bc)m"
echo "  requests.memory: $(echo "scale=0; ($TOTAL_MEM_REQ * 120) / 100" | bc)Mi"
echo "  pods: $(echo "scale=0; ($POD_COUNT * 150) / 100" | bc)"
```

## Summary

Effective resource quota management requires:

1. Define quota at multiple dimensions: compute (CPU, memory), storage (PVC size, count), and objects (pods, services, ingresses)
2. Use LimitRange to ensure every pod has resource requests—this prevents silent resource exhaustion where pods consume real resources but appear to consume zero in quota accounting
3. Scope quotas by QoS class and priority to manage burst capacity separately from baseline commitments
4. Configure Prometheus alerts at 80% and 95% utilization before teams experience deployment failures
5. Enforce the limit-to-request ratio to prevent dangerous overcommit scenarios where a single pod can consume all node memory
6. Apply OPA/Gatekeeper policies to ensure all production namespaces have quotas—enforcement gaps let individual teams impact shared infrastructure
7. Review and adjust quotas quarterly as workload patterns change; quotas set at project launch are rarely appropriate six months later

The teams that succeed with resource quotas treat them as a feedback mechanism, not a compliance checkbox. Quota exhaustion events trigger conversations about capacity planning, right-sizing, and efficient resource use.
