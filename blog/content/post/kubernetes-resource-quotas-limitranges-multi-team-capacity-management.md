---
title: "Kubernetes Resource Quotas and LimitRanges: Multi-Team Capacity Management and Fairness Enforcement"
date: 2031-07-17T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Resource Quotas", "LimitRanges", "Multi-tenancy", "Capacity Management", "Platform Engineering"]
categories: ["Kubernetes", "Platform Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes ResourceQuota and LimitRange for platform teams managing multi-tenant clusters, covering CPU and memory quotas, storage quotas, object count quotas, priority class quotas, and admission webhook-based quota enforcement."
more_link: "yes"
url: "/kubernetes-resource-quotas-limitranges-multi-team-capacity-management/"
---

Resource quotas and LimitRanges are the primary mechanisms Kubernetes provides for capacity management in multi-tenant clusters. Without them, a single team can monopolize all cluster resources, starving other workloads of CPU and memory. This guide covers the complete quota and LimitRange system: compute quotas, storage quotas, object count limits, priority class quotas, the interaction between quotas and the scheduler, and the operational patterns for managing capacity across dozens of teams in production.

<!--more-->

# Kubernetes Resource Quotas and LimitRanges: Multi-Team Capacity Management

## Section 1: Why Quotas Matter in Multi-Tenant Clusters

In a cluster shared by multiple teams, three failure modes are common without quotas:

1. **Resource monopolization**: One team's uncontrolled workload consumes all available CPU/memory, causing evictions of other teams' pods.
2. **etcd flooding**: A misconfigured controller creates thousands of objects (ConfigMaps, Secrets, Services) in a loop, degrading the entire API server.
3. **Storage exhaustion**: One team provisions unlimited PersistentVolumeClaims, blocking storage provisioning for all other teams.

Resource quotas address all three by placing hard limits on what any given namespace can consume.

### The Quota Enforcement Model

Quotas are evaluated at admission time (when objects are created or updated), not at runtime. The flow is:

```
kubectl apply -f pod.yaml
    │
    ▼
API Server → Admission Controller (ResourceQuota)
    │
    ├─ Sum existing usage in namespace
    ├─ Check if (existing usage + new request) <= quota limit
    │
    ├─ YES: Admit the request, increment quota usage counter
    └─ NO: Reject with 403 Forbidden
              "exceeded quota: namespace-quota, requested: cpu=2, used: cpu=18, limited: cpu=20"
```

Quotas do NOT evict running pods when quota is reduced below current usage. They only prevent new admissions.

## Section 2: ResourceQuota Configuration

### Basic Compute and Memory Quota

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: team-alpha-quota
  namespace: team-alpha
spec:
  hard:
    # CPU: total requested CPU across all pods in the namespace
    requests.cpu: "20"
    # Memory: total requested memory
    requests.memory: 40Gi
    # CPU limits: total CPU limits across all pods
    limits.cpu: "40"
    # Memory limits: total memory limits across all pods
    limits.memory: 80Gi
```

### Object Count Quotas

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: team-alpha-object-quota
  namespace: team-alpha
spec:
  hard:
    # Kubernetes core objects
    pods: "100"
    services: "20"
    secrets: "100"
    configmaps: "100"
    persistentvolumeclaims: "50"
    replicationcontrollers: "0"    # Prevent use of deprecated resource

    # Apps
    count/deployments.apps: "50"
    count/replicasets.apps: "200"   # Should be ~2x deployments for rolling updates
    count/statefulsets.apps: "20"
    count/daemonsets.apps: "5"
    count/jobs.batch: "50"
    count/cronjobs.batch: "20"

    # Networking
    count/ingresses.networking.k8s.io: "30"
    services.loadbalancers: "5"
    services.nodeports: "0"        # Prohibit NodePort services entirely

    # RBAC
    count/roles.rbac.authorization.k8s.io: "20"
    count/rolebindings.rbac.authorization.k8s.io: "30"
```

### Storage Quotas

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: team-alpha-storage-quota
  namespace: team-alpha
spec:
  hard:
    # Total storage across all PVCs
    requests.storage: 2Ti

    # Storage per StorageClass
    fast-ssd.storageclass.storage.k8s.io/requests.storage: 500Gi
    fast-ssd.storageclass.storage.k8s.io/persistentvolumeclaims: "20"

    standard.storageclass.storage.k8s.io/requests.storage: 1Ti
    standard.storageclass.storage.k8s.io/persistentvolumeclaims: "30"

    # Prevent use of expensive storage class for large workloads
    nvme-raid.storageclass.storage.k8s.io/requests.storage: 100Gi
    nvme-raid.storageclass.storage.k8s.io/persistentvolumeclaims: "5"
```

### Priority Class Quotas

Priority class quotas allow different limits for different workload tiers within the same namespace:

```yaml
# First, define priority classes
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: production-critical
value: 1000000
globalDefault: false
description: "Production-critical workloads that must not be preempted"
preemptionPolicy: PreemptLowerPriority

---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: batch-background
value: 100
globalDefault: false
description: "Background batch jobs with lower priority"
preemptionPolicy: Never

---
# Priority-scoped quotas
apiVersion: v1
kind: ResourceQuota
metadata:
  name: production-critical-quota
  namespace: team-alpha
spec:
  hard:
    requests.cpu: "16"
    requests.memory: 32Gi
  scopeSelector:
    matchExpressions:
      - operator: In
        scopeName: PriorityClass
        values: ["production-critical"]

---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: batch-quota
  namespace: team-alpha
spec:
  hard:
    requests.cpu: "8"
    requests.memory: 16Gi
    pods: "50"
  scopeSelector:
    matchExpressions:
      - operator: In
        scopeName: PriorityClass
        values: ["batch-background"]
```

### Cross-Namespace Quota Scope Selectors

```yaml
# Quota for pods that are NOT in the Terminated state
apiVersion: v1
kind: ResourceQuota
metadata:
  name: non-terminating-quota
  namespace: team-alpha
spec:
  hard:
    pods: "80"
    requests.cpu: "20"
    requests.memory: 40Gi
  scopes:
    - NotTerminating   # Only count pods without an active deadline

---
# Separate quota for terminating pods (Jobs)
apiVersion: v1
kind: ResourceQuota
metadata:
  name: terminating-quota
  namespace: team-alpha
spec:
  hard:
    pods: "30"
    requests.cpu: "10"
    requests.memory: 20Gi
  scopes:
    - Terminating      # Only count pods with a deadline (Jobs)
```

## Section 3: LimitRange Configuration

LimitRanges serve a complementary but different purpose: they set default requests/limits for containers that don't specify them, and enforce per-container/per-pod minimum and maximum constraints.

Without a LimitRange, a pod with no `resources` specified is considered to have `requests: 0, limits: 0`. Such pods are not counted against compute quotas, allowing unlimited "best-effort" pods.

### Container LimitRange

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: team-alpha-container-limits
  namespace: team-alpha
spec:
  limits:
    - type: Container
      # Default requests (applied if container specifies no requests)
      defaultRequest:
        cpu: "100m"
        memory: "128Mi"
      # Default limits (applied if container specifies no limits)
      default:
        cpu: "500m"
        memory: "512Mi"
      # Minimum allowed values (prevents very low values that cause instability)
      min:
        cpu: "50m"
        memory: "64Mi"
      # Maximum allowed values (prevents a single container from taking too many resources)
      max:
        cpu: "8"
        memory: "16Gi"
      # Max burst ratio: limits must be <= maxLimitRequestRatio * requests
      # Prevents containers with CPU=1m request and CPU=64 limit (extreme bursting)
      maxLimitRequestRatio:
        cpu: "4"      # limits.cpu <= 4 * requests.cpu
        memory: "2"   # limits.memory <= 2 * requests.memory
```

### Pod LimitRange

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: team-alpha-pod-limits
  namespace: team-alpha
spec:
  limits:
    - type: Pod
      # Maximum resources for the entire pod (sum of all containers)
      max:
        cpu: "16"
        memory: "32Gi"
      # Minimum resources for the entire pod
      min:
        cpu: "100m"
        memory: "64Mi"
```

### PersistentVolumeClaim LimitRange

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: team-alpha-pvc-limits
  namespace: team-alpha
spec:
  limits:
    - type: PersistentVolumeClaim
      # Maximum PVC size
      max:
        storage: 500Gi
      # Minimum PVC size (prevents tiny PVCs that waste provisioner overhead)
      min:
        storage: 1Gi
```

### Combined Namespace Setup Script

```bash
#!/bin/bash
# setup-team-namespace.sh
# Usage: ./setup-team-namespace.sh <team-name> <cpu-quota> <memory-quota-gi>

TEAM=$1
CPU_QUOTA=${2:-20}
MEMORY_QUOTA_GI=${3:-40}

kubectl create namespace $TEAM --dry-run=client -o yaml | kubectl apply -f -
kubectl label namespace $TEAM \
  team=$TEAM \
  environment=production \
  managed-by=platform-team

kubectl apply -f - <<EOF
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: compute-quota
  namespace: $TEAM
spec:
  hard:
    requests.cpu: "${CPU_QUOTA}"
    requests.memory: "${MEMORY_QUOTA_GI}Gi"
    limits.cpu: "$((CPU_QUOTA * 2))"
    limits.memory: "$((MEMORY_QUOTA_GI * 2))Gi"
    pods: "200"
    services: "50"
    secrets: "200"
    configmaps: "200"
    persistentvolumeclaims: "100"
    requests.storage: "2Ti"
    count/deployments.apps: "100"
    count/statefulsets.apps: "20"
    services.loadbalancers: "10"
    services.nodeports: "0"
---
apiVersion: v1
kind: LimitRange
metadata:
  name: default-container-limits
  namespace: $TEAM
spec:
  limits:
    - type: Container
      defaultRequest:
        cpu: "100m"
        memory: "128Mi"
      default:
        cpu: "500m"
        memory: "512Mi"
      min:
        cpu: "50m"
        memory: "64Mi"
      max:
        cpu: "8"
        memory: "16Gi"
      maxLimitRequestRatio:
        cpu: "4"
        memory: "2"
    - type: PersistentVolumeClaim
      max:
        storage: 200Gi
      min:
        storage: 1Gi
EOF

echo "Namespace $TEAM configured with CPU quota: ${CPU_QUOTA}, Memory: ${MEMORY_QUOTA_GI}Gi"
```

## Section 4: Monitoring Quota Usage

### CLI Monitoring

```bash
# Check quota usage for a namespace
kubectl describe resourcequota -n team-alpha

# Example output:
# Name:                        compute-quota
# Namespace:                   team-alpha
# Resource                     Used    Hard
# --------                     ---     ----
# limits.cpu                   8       40
# limits.memory                16Gi    80Gi
# pods                         23      200
# requests.cpu                 3500m   20
# requests.memory              7Gi     40Gi

# Watch quota usage in real time
watch kubectl describe resourcequota -n team-alpha

# Get all quotas across all namespaces
kubectl get resourcequota --all-namespaces \
  -o custom-columns=\
NAMESPACE:.metadata.namespace,\
NAME:.metadata.name,\
CPU-USED:'.status.used.requests\.cpu',\
CPU-HARD:'.status.hard.requests\.cpu',\
MEM-USED:'.status.used.requests\.memory',\
MEM-HARD:'.status.hard.requests\.memory'
```

### Prometheus Metrics for Quota Monitoring

kube-state-metrics exposes ResourceQuota data as Prometheus metrics:

```promql
# CPU requests usage as percentage of quota
(
  kube_resourcequota{resource="requests.cpu", type="used"}
  /
  kube_resourcequota{resource="requests.cpu", type="hard"}
) * 100

# Alert: namespace CPU requests above 85% of quota
kube_resourcequota{resource="requests.cpu", type="used"}
/ on(namespace, resourcequota)
kube_resourcequota{resource="requests.cpu", type="hard"}
> 0.85

# Memory requests usage ratio
kube_resourcequota{resource="requests.memory", type="used"}
/ on(namespace, resourcequota)
kube_resourcequota{resource="requests.memory", type="hard"}

# Pod count usage
kube_resourcequota{resource="pods", type="used"}
/ on(namespace, resourcequota)
kube_resourcequota{resource="pods", type="hard"}

# Storage usage
kube_resourcequota{resource="requests.storage", type="used"}
/ on(namespace, resourcequota)
kube_resourcequota{resource="requests.storage", type="hard"}
```

### PrometheusRule Alerts for Quota

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: quota-alerts
  namespace: monitoring
  labels:
    release: kube-prometheus-stack
spec:
  groups:
    - name: quota.alerts
      rules:
        - alert: NamespaceQuotaCPUHigh
          expr: |
            (
              kube_resourcequota{resource="requests.cpu", type="used"}
              / on(namespace, resourcequota)
              kube_resourcequota{resource="requests.cpu", type="hard"}
            ) > 0.85
          for: 10m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "Namespace {{ $labels.namespace }} CPU quota above 85%"
            description: |
              Namespace {{ $labels.namespace }} has used {{ $value | humanizePercentage }}
              of its CPU request quota. The team may need their quota increased or
              should reduce their resource requests.

        - alert: NamespaceQuotaCPUCritical
          expr: |
            (
              kube_resourcequota{resource="requests.cpu", type="used"}
              / on(namespace, resourcequota)
              kube_resourcequota{resource="requests.cpu", type="hard"}
            ) > 0.95
          for: 5m
          labels:
            severity: critical
            team: platform
          annotations:
            summary: "Namespace {{ $labels.namespace }} CPU quota above 95%"
            description: |
              Namespace {{ $labels.namespace }} is at {{ $value | humanizePercentage }}
              CPU quota utilization. New pods will be rejected once the quota is exceeded.

        - alert: NamespaceQuotaMemoryHigh
          expr: |
            (
              kube_resourcequota{resource="requests.memory", type="used"}
              / on(namespace, resourcequota)
              kube_resourcequota{resource="requests.memory", type="hard"}
            ) > 0.85
          for: 10m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "Namespace {{ $labels.namespace }} memory quota above 85%"

        - alert: NamespaceStorageQuotaHigh
          expr: |
            (
              kube_resourcequota{resource="requests.storage", type="used"}
              / on(namespace, resourcequota)
              kube_resourcequota{resource="requests.storage", type="hard"}
            ) > 0.80
          for: 30m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "Namespace {{ $labels.namespace }} storage quota above 80%"

        - alert: NamespacePodCountHigh
          expr: |
            (
              kube_resourcequota{resource="pods", type="used"}
              / on(namespace, resourcequota)
              kube_resourcequota{resource="pods", type="hard"}
            ) > 0.80
          for: 10m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "Namespace {{ $labels.namespace }} pod count above 80% of quota"
```

## Section 5: Grafana Dashboard for Quota Visibility

### Dashboard JSON Model (Key Panels)

```json
{
  "title": "Kubernetes Namespace Resource Quota",
  "panels": [
    {
      "title": "CPU Request Utilization by Namespace",
      "type": "bargauge",
      "targets": [
        {
          "expr": "sort_desc(kube_resourcequota{resource='requests.cpu', type='used'} / on(namespace, resourcequota) kube_resourcequota{resource='requests.cpu', type='hard'} * 100)",
          "legendFormat": "{{namespace}}"
        }
      ],
      "options": {
        "reduceOptions": {"calcs": ["lastNotNull"]},
        "orientation": "horizontal",
        "thresholds": {
          "steps": [
            {"color": "green", "value": 0},
            {"color": "yellow", "value": 70},
            {"color": "orange", "value": 85},
            {"color": "red", "value": 95}
          ]
        }
      }
    }
  ]
}
```

## Section 6: Quota Management at Scale

### Hierarchical Namespace Controller (HNC)

The HNC (Hierarchical Namespace Controller) allows quota inheritance and propagation:

```bash
# Install HNC
kubectl apply -f https://github.com/kubernetes-sigs/hierarchical-namespaces/releases/latest/download/default.yaml

# Create namespace hierarchy
kubectl hns create team-alpha -n org-engineering
kubectl hns create team-alpha-prod -n team-alpha
kubectl hns create team-alpha-staging -n team-alpha

# Propagate a quota to child namespaces
kubectl annotate namespace team-alpha \
  hnc.x-k8s.io/propagateQuota=compute-quota

# View hierarchy
kubectl hns tree org-engineering
```

### Quota Increase Request Workflow

Implement a GitOps-based quota request system:

```yaml
# quota-requests/team-alpha-increase-2031-07.yaml
apiVersion: platform.company.com/v1
kind: QuotaRequest
metadata:
  name: team-alpha-july-2031
spec:
  namespace: team-alpha
  reason: "Q3 2031 capacity planning for new ML training pipeline"
  requestedBy: "jane.smith@company.com"
  approvedBy: ""  # Filled by platform team
  currentQuota:
    requests.cpu: "20"
    requests.memory: "40Gi"
  requestedQuota:
    requests.cpu: "40"
    requests.memory: "80Gi"
  justification: |
    Team Alpha is launching a new ML training pipeline that requires
    GPU-attached workers and larger CPU/memory allocations.
    Expected 6-month usage: 35 CPU cores, 70Gi memory average.
    Peak usage (training runs): 38 CPU cores, 76Gi memory.
```

### Automated Quota Right-Sizing

```bash
#!/bin/bash
# quota-rightsizing-report.sh
# Generates quota right-sizing recommendations based on actual usage

LOOKBACK_DAYS=30

echo "=== Quota Right-Sizing Report (${LOOKBACK_DAYS} days) ==="
echo ""

kubectl get namespaces -l managed-by=platform-team -o jsonpath='{.items[*].metadata.name}' | \
  tr ' ' '\n' | while read NS; do

    # Get current quota
    CPU_HARD=$(kubectl get resourcequota compute-quota -n $NS \
      -o jsonpath='{.spec.hard.requests\.cpu}' 2>/dev/null || echo "none")

    # Get actual peak usage from Prometheus (requires port-forward or ingress)
    # This is a simplified example using kubectl top
    CPU_USED=$(kubectl top pods -n $NS --no-headers 2>/dev/null | \
      awk '{gsub(/m/,""); sum+=$2} END {printf "%.0fm\n", sum}')

    echo "Namespace: $NS"
    echo "  CPU Quota: $CPU_HARD"
    echo "  CPU Used (current): $CPU_USED"
    echo ""
done
```

## Section 7: Admission Webhooks for Advanced Quota Enforcement

For requirements beyond what ResourceQuota supports (e.g., enforcing cost labels on PVCs, preventing high-memory-to-CPU ratios), use a validating admission webhook:

```go
// webhooks/quota_enforcer.go
package webhooks

import (
    "context"
    "fmt"
    "net/http"
    "strings"

    admissionv1 "k8s.io/api/admission/v1"
    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/api/resource"
    "sigs.k8s.io/controller-runtime/pkg/webhook/admission"
)

// QuotaEnforcerWebhook validates custom quota policies not expressible in ResourceQuota.
type QuotaEnforcerWebhook struct {
    decoder admission.Decoder
}

func (w *QuotaEnforcerWebhook) Handle(ctx context.Context, req admission.Request) admission.Response {
    if req.Operation == admissionv1.Delete {
        return admission.Allowed("delete allowed")
    }

    pod := &corev1.Pod{}
    if err := w.decoder.Decode(req, pod); err != nil {
        return admission.Errored(http.StatusBadRequest, err)
    }

    // Enforce custom policy: all pods must have resource requests set
    for _, container := range pod.Spec.Containers {
        if container.Resources.Requests == nil {
            return admission.Denied(fmt.Sprintf(
                "container %s must have resource requests set; add resources.requests.cpu and resources.requests.memory",
                container.Name,
            ))
        }

        if container.Resources.Requests.Cpu().IsZero() {
            return admission.Denied(fmt.Sprintf(
                "container %s must have a non-zero CPU request",
                container.Name,
            ))
        }

        if container.Resources.Requests.Memory().IsZero() {
            return admission.Denied(fmt.Sprintf(
                "container %s must have a non-zero memory request",
                container.Name,
            ))
        }

        // Enforce memory-to-CPU ratio
        // Prevent pods with extreme ratios like 0.1m CPU and 32Gi memory
        if container.Resources.Requests != nil && container.Resources.Limits != nil {
            if err := validateCPUMemoryRatio(container); err != nil {
                return admission.Denied(err.Error())
            }
        }
    }

    // Enforce cost center label for accountability
    if _, ok := pod.Labels["cost-center"]; !ok {
        return admission.Denied(
            "pod must have a 'cost-center' label for resource attribution; " +
                "see https://internal-docs/cost-centers for valid values",
        )
    }

    return admission.Allowed("quota policy satisfied")
}

func validateCPUMemoryRatio(container corev1.Container) error {
    cpuReq := container.Resources.Requests.Cpu().MilliValue()
    memReq := container.Resources.Requests.Memory().Value()

    if cpuReq == 0 {
        return nil
    }

    // Memory-per-CPU ratio: must be between 1Gi/core and 16Gi/core
    memPerCPU := float64(memReq) / (float64(cpuReq) / 1000)
    minMemPerCPU := float64(resource.MustParse("1Gi").Value())
    maxMemPerCPU := float64(resource.MustParse("16Gi").Value())

    if memPerCPU < minMemPerCPU {
        return fmt.Errorf(
            "container %s memory-to-CPU ratio is too low (%.1f GiB/core); "+
                "minimum is 1 GiB/core. Increase memory or decrease CPU request",
            container.Name, memPerCPU/float64(resource.MustParse("1Gi").Value()),
        )
    }

    if memPerCPU > maxMemPerCPU {
        return fmt.Errorf(
            "container %s memory-to-CPU ratio is too high (%.1f GiB/core); "+
                "maximum is 16 GiB/core. Increase CPU or decrease memory request",
            container.Name, memPerCPU/float64(resource.MustParse("1Gi").Value()),
        )
    }

    return nil
}
```

### Webhook Registration

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingWebhookConfiguration
metadata:
  name: quota-enforcer
  annotations:
    cert-manager.io/inject-ca-from: platform-system/quota-enforcer-tls
spec:
  webhooks:
    - name: quota-enforcer.platform.company.com
      rules:
        - apiGroups: [""]
          apiVersions: ["v1"]
          operations: ["CREATE", "UPDATE"]
          resources: ["pods"]
          scope: "Namespaced"
      clientConfig:
        service:
          namespace: platform-system
          name: quota-enforcer
          path: /validate-pods
        caBundle: "<base64-encoded-tls-certificate>"
      namespaceSelector:
        matchLabels:
          managed-by: platform-team
      failurePolicy: Fail
      sideEffects: None
      admissionReviewVersions: ["v1"]
      timeoutSeconds: 5
```

## Section 8: Quota Troubleshooting

### Common Quota-Related Errors

```bash
# Error: exceeded quota: compute-quota
# Meaning: resource request exceeds available quota

# Check current quota usage
kubectl describe resourcequota -n team-alpha

# Find what's consuming the most quota
kubectl get pods -n team-alpha -o json | \
  jq '.items[] | {name: .metadata.name, cpuReq: .spec.containers[].resources.requests.cpu, memReq: .spec.containers[].resources.requests.memory}' | \
  jq -s 'sort_by(.cpuReq) | reverse'

# Find pods without resource requests (these cause quota issues with default limits)
kubectl get pods -n team-alpha -o json | \
  jq '[.items[] | select(.spec.containers[].resources.requests == null) | .metadata.name]'

# Error: must specify limits
# Meaning: ResourceQuota specifies limits.cpu/memory but pod doesn't have limits
# Fix: Add a LimitRange with defaults, or add explicit limits to the pod

# Error: forbidden: exceeded quota for resource: persistentvolumeclaims
kubectl get pvc -n team-alpha
# Find large or abandoned PVCs to delete

# Clean up completed jobs that still hold quota
kubectl delete jobs -n team-alpha \
  $(kubectl get jobs -n team-alpha -o jsonpath='{.items[?(@.status.completionTime)].metadata.name}')
```

### Debugging Quota Enforcement

```bash
# Simulate quota admission without creating the pod
kubectl auth can-i create pods -n team-alpha --as=system:serviceaccount:team-alpha:default

# Check what would be admitted
kubectl apply --dry-run=server -f my-pod.yaml -n team-alpha

# Watch ResourceQuota admission events
kubectl get events -n team-alpha \
  --field-selector reason=FailedQuotaAdmission \
  --sort-by='.lastTimestamp'

# Or use audit logs
# grep "exceeded quota" /var/log/kubernetes/audit.log | tail -20
```

## Section 9: Best Practices for Platform Teams

### Quota Sizing Principles

1. **Set quotas based on expected peak usage + 20% headroom**. Quotas set too tight cause constant incidents; too loose provide no protection.

2. **Use separate compute and object quotas**. Combine them in one ResourceQuota or use multiple ResourceQuotas — both work.

3. **Always deploy a LimitRange alongside ResourceQuota**. Without defaults, pods without explicit resource requests get admission-controlled at limits.cpu=0, bypassing quota accounting.

4. **Use priority class quotas to reserve capacity for critical workloads**. This prevents batch jobs from starving production services even within the same namespace.

5. **Monitor quota utilization with Prometheus alerts at 75%, 85%, and 95% thresholds**. At 75%, initiate a quota review conversation. At 95%, take immediate action.

6. **Implement a self-service quota request process**. Teams should be able to request quota increases via PR/GitOps without waiting for manual platform team intervention.

### Namespace Standardization

```bash
#!/bin/bash
# standardize-namespace.sh
# Ensures a namespace has all required platform configurations

NS=$1

# Required labels
kubectl label namespace $NS \
  team=$(kubectl get namespace $NS -o jsonpath='{.metadata.labels.team}' || echo "unassigned") \
  environment=$(kubectl get namespace $NS -o jsonpath='{.metadata.labels.environment}' || echo "unassigned") \
  managed-by=platform-team \
  --overwrite

# Required ResourceQuota
kubectl get resourcequota compute-quota -n $NS &>/dev/null || {
    echo "WARNING: namespace $NS is missing compute quota"
}

# Required LimitRange
kubectl get limitrange default-container-limits -n $NS &>/dev/null || {
    echo "WARNING: namespace $NS is missing LimitRange"
}

# Required NetworkPolicy default-deny
kubectl get networkpolicy default-deny-ingress -n $NS &>/dev/null || {
    echo "WARNING: namespace $NS is missing default-deny NetworkPolicy"
}
```

## Conclusion

Resource quotas and LimitRanges are fundamental building blocks for running multi-tenant Kubernetes clusters. ResourceQuota provides the hard ceiling that prevents one team from monopolizing cluster resources, while LimitRange ensures that containers without explicit resource specifications are assigned sensible defaults and cannot bypass quota accounting. The combination of compute quotas, storage quotas, object count quotas, and priority class quotas gives platform teams the controls needed to guarantee fairness across dozens of teams. Prometheus-based quota monitoring with alerts at 75-95% utilization thresholds ensures the platform team is notified before teams hit their limits, turning quota management from a reactive firefighting task into a proactive capacity planning discipline. For complex enforcement requirements beyond what ResourceQuota supports, validating admission webhooks extend the quota system to enforce custom organizational policies at admission time.
