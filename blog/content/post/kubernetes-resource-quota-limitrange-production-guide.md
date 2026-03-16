---
title: "ResourceQuota and LimitRange: Namespace-Level Resource Governance in Kubernetes"
date: 2027-03-05T00:00:00-05:00
draft: false
tags: ["Kubernetes", "ResourceQuota", "LimitRange", "Multi-Tenancy", "Resource Management"]
categories: ["Kubernetes", "Multi-Tenancy", "Operations"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Kubernetes ResourceQuota and LimitRange for namespace-level resource governance, covering quota scopes, priority class quotas, LimitRange defaults, admission flow, GitOps management, and Prometheus monitoring for multi-tenant clusters."
more_link: "yes"
url: "/kubernetes-resource-quota-limitrange-production-guide/"
---

Multi-tenant Kubernetes clusters require guardrails that prevent any single team or workload from monopolizing shared infrastructure. Without resource governance, a runaway deployment can exhaust cluster CPU and memory, leaving other teams unable to schedule pods. **ResourceQuota** and **LimitRange** are the two native Kubernetes mechanisms for enforcing namespace-scoped resource boundaries — quotas set hard ceilings on aggregate consumption while LimitRanges establish per-object defaults and constraints.

This guide covers both objects in production depth: quota scopes, priority class quotas, ephemeral storage limits, the admission flow, monitoring quota utilization, and GitOps-managed governance patterns for enterprise multi-tenancy.

<!--more-->

## Admission Flow

Understanding the admission order is critical for avoiding unexpected rejection messages. When a pod creation request arrives:

1. **MutatingAdmissionWebhooks** run first — this is where LimitRange defaults are injected if containers lack explicit requests/limits
2. **ResourceQuota admission controller** evaluates whether the namespace has sufficient quota to accommodate the pod's resources after defaults have been applied
3. **ValidatingAdmissionWebhooks** run last

The consequence: if a LimitRange injects a default memory limit of `512Mi` and the namespace has only `256Mi` of quota remaining, the pod is rejected at step 2 even though no explicit limit was specified in the pod spec. Teams must understand both their LimitRange defaults and their current quota usage.

## ResourceQuota

### CPU and Memory Quota

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: team-alpha-quota
  namespace: team-alpha
spec:
  hard:
    # Compute resources
    requests.cpu: "10"
    requests.memory: 20Gi
    limits.cpu: "20"
    limits.memory: 40Gi
    # Object count limits
    pods: "50"
    services: "20"
    services.loadbalancers: "2"
    services.nodeports: "0"
    persistentvolumeclaims: "20"
    secrets: "50"
    configmaps: "50"
    # Ephemeral storage
    requests.ephemeral-storage: 100Gi
    limits.ephemeral-storage: 200Gi
```

The `requests.*` and `limits.*` prefixes in quota match the corresponding `resources.requests` and `resources.limits` fields in pod specs. Both requests and limits must be specified in pod specs when a ResourceQuota with CPU or memory limits exists in the namespace — pods without explicit requests/limits are rejected unless a LimitRange provides defaults.

### Object Count Quotas

Object count quotas prevent namespace sprawl and accidental resource leaks. Critical objects to limit in shared clusters:

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: team-alpha-object-counts
  namespace: team-alpha
spec:
  hard:
    count/deployments.apps: "30"
    count/replicasets.apps: "60"
    count/statefulsets.apps: "10"
    count/jobs.batch: "20"
    count/cronjobs.batch: "10"
    count/ingresses.networking.k8s.io: "20"
    count/serviceaccounts: "30"
    count/roles.rbac.authorization.k8s.io: "20"
    count/rolebindings.rbac.authorization.k8s.io: "20"
```

The `count/<resource>.<group>` syntax works for any API resource, including CRDs. This allows platform teams to limit the number of custom resources (e.g., `count/prometheusrules.monitoring.coreos.com: "50"`) to prevent excessively large monitoring configurations.

### Quota Scopes

**Quota scopes** restrict which pods a quota applies to, based on pod QoS class or lifecycle phase. This allows fine-grained control where different quotas govern different pod categories.

```yaml
# Quota that only applies to BestEffort pods (no requests/limits)
apiVersion: v1
kind: ResourceQuota
metadata:
  name: besteffort-pod-count
  namespace: team-alpha
spec:
  hard:
    pods: "5"
  scopes:
    - BestEffort

---
# Quota that only applies to Burstable/Guaranteed pods
apiVersion: v1
kind: ResourceQuota
metadata:
  name: notbesteffort-compute
  namespace: team-alpha
spec:
  hard:
    pods: "45"
    requests.cpu: "10"
    requests.memory: 20Gi
    limits.cpu: "20"
    limits.memory: 40Gi
  scopes:
    - NotBestEffort

---
# Quota for Terminating pods (pods with activeDeadlineSeconds)
apiVersion: v1
kind: ResourceQuota
metadata:
  name: terminating-pod-resources
  namespace: team-alpha
spec:
  hard:
    pods: "10"
    requests.cpu: "2"
    requests.memory: 4Gi
  scopes:
    - Terminating

---
# Quota for long-running (non-terminating) pods
apiVersion: v1
kind: ResourceQuota
metadata:
  name: noterminating-pod-resources
  namespace: team-alpha
spec:
  hard:
    pods: "40"
    requests.cpu: "8"
    requests.memory: 16Gi
  scopes:
    - NotTerminating
```

The `Terminating` scope matches pods with `spec.activeDeadlineSeconds` set, which includes Job pods. Using separate quotas for Jobs and long-running workloads prevents a batch workload surge from crowding out production services.

### Priority Class Quotas

Priority class-scoped quotas are the most powerful tool for protecting critical workloads in multi-tenant environments. They ensure that high-priority production workloads always have reserved capacity regardless of what other teams deploy.

```yaml
# Reserve capacity for production-critical workloads
apiVersion: v1
kind: ResourceQuota
metadata:
  name: priority-critical-quota
  namespace: team-alpha
spec:
  hard:
    pods: "10"
    requests.cpu: "4"
    requests.memory: 8Gi
  scopeSelector:
    matchExpressions:
      - operator: In
        scopeName: PriorityClass
        values:
          - production-critical

---
# Standard quota for normal-priority workloads
apiVersion: v1
kind: ResourceQuota
metadata:
  name: priority-standard-quota
  namespace: team-alpha
spec:
  hard:
    pods: "40"
    requests.cpu: "6"
    requests.memory: 12Gi
  scopeSelector:
    matchExpressions:
      - operator: In
        scopeName: PriorityClass
        values:
          - standard
          - low-priority

---
# Corresponding PriorityClass objects
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: production-critical
value: 1000
globalDefault: false
description: "Reserved for production-critical workloads with guaranteed capacity."
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: standard
value: 500
globalDefault: true
description: "Default priority for most workloads."
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: low-priority
value: 100
globalDefault: false
description: "Batch and background workloads."
```

## LimitRange

**LimitRange** enforces per-object resource boundaries at three levels: `Container`, `Pod`, and `PersistentVolumeClaim`. It provides:

- `default`: the default `limits` value injected when a container has no limits set
- `defaultRequest`: the default `requests` value injected when a container has no requests set
- `max`: the maximum allowed value for requests or limits
- `min`: the minimum allowed value for requests or limits
- `maxLimitRequestRatio`: the maximum ratio between limits and requests (prevents extreme burst ratios)

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
      # Defaults injected when container spec omits limits/requests
      default:
        cpu: "500m"
        memory: "512Mi"
        ephemeral-storage: "2Gi"
      defaultRequest:
        cpu: "100m"
        memory: "128Mi"
        ephemeral-storage: "512Mi"
      # Hard boundaries
      max:
        cpu: "4"
        memory: "8Gi"
        ephemeral-storage: "20Gi"
      min:
        cpu: "10m"
        memory: "32Mi"
      # Limit cannot exceed 10x request for CPU, 4x for memory
      maxLimitRequestRatio:
        cpu: "10"
        memory: "4"
```

### Pod LimitRange

Pod-level limits aggregate all container values. A Pod `max` prevents teams from specifying multiple containers that individually pass container limits but collectively exceed pod-level boundaries.

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: team-alpha-pod-limits
  namespace: team-alpha
spec:
  limits:
    - type: Pod
      max:
        cpu: "8"
        memory: "16Gi"
      min:
        cpu: "10m"
        memory: "32Mi"
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
      max:
        storage: 100Gi
      min:
        storage: 1Gi
```

## ResourceQuota and LimitRange Interaction

The interaction between these two objects creates a complete governance framework:

1. A pod spec arrives with no `resources` field set
2. The LimitRange mutating webhook injects `defaultRequest: cpu: 100m, memory: 128Mi` and `default: cpu: 500m, memory: 512Mi`
3. The ResourceQuota controller checks whether `100m` CPU request and `512Mi` memory limit can be accommodated within namespace quota
4. If quota is sufficient, the pod is admitted; if not, the pod is rejected with `exceeded quota` error

This means deploying a LimitRange changes the effective cost of every pod in the namespace from a quota perspective. When tightening LimitRange defaults, always check current quota utilization first.

### Checking Quota Status

```bash
# View current quota usage across all namespaces
kubectl get resourcequota -A -o custom-columns=\
"NAMESPACE:.metadata.namespace,NAME:.metadata.name,\
CPU-REQ:.status.used['requests\.cpu'],CPU-REQ-LIMIT:.status.hard['requests\.cpu'],\
MEM-REQ:.status.used['requests\.memory'],MEM-REQ-LIMIT:.status.hard['requests\.memory']"

# Describe a specific quota with used vs hard
kubectl describe resourcequota team-alpha-quota -n team-alpha

# Check what LimitRange defaults will be applied
kubectl describe limitrange team-alpha-container-limits -n team-alpha
```

## Ephemeral Storage Quotas

Ephemeral storage (container writable layer, emptyDir volumes, container logs) can consume significant node disk space. Including ephemeral storage in quotas prevents log-heavy containers from exhausting node disks.

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: team-alpha-storage-quota
  namespace: team-alpha
spec:
  hard:
    requests.ephemeral-storage: "50Gi"
    limits.ephemeral-storage: "100Gi"
    requests.storage: "500Gi"
    # StorageClass-specific PVC capacity limits
    gold.storageclass.storage.k8s.io/requests.storage: "200Gi"
    silver.storageclass.storage.k8s.io/requests.storage: "300Gi"
    bronze.storageclass.storage.k8s.io/requests.storage: "500Gi"
    bronze.storageclass.storage.k8s.io/persistentvolumeclaims: "20"
```

StorageClass-scoped quota (`<storageclass>.storageclass.storage.k8s.io/requests.storage`) is particularly valuable for ensuring that teams do not exhaust expensive SSD-backed storage while cheaper spinning-disk storage remains available.

## GitOps-Managed Quota Per Team

Managing quotas through GitOps (Argo CD or Flux) ensures consistency and prevents manual drift. A common pattern uses a shared repository where each team's quota is defined in a directory structure.

### Repository Structure

```
teams/
├── team-alpha/
│   ├── namespace.yaml
│   ├── resource-quota.yaml
│   ├── limitrange.yaml
│   └── rbac.yaml
├── team-beta/
│   ├── namespace.yaml
│   ├── resource-quota.yaml
│   ├── limitrange.yaml
│   └── rbac.yaml
└── _defaults/
    ├── baseline-quota.yaml
    └── baseline-limitrange.yaml
```

### Kustomize Overlay for Per-Team Customization

```yaml
# teams/_defaults/baseline-quota.yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: baseline-quota
spec:
  hard:
    requests.cpu: "4"
    requests.memory: 8Gi
    limits.cpu: "8"
    limits.memory: 16Gi
    pods: "20"
    persistentvolumeclaims: "10"
    services: "10"
    services.loadbalancers: "0"
    services.nodeports: "0"
```

```yaml
# teams/team-alpha/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: team-alpha
resources:
  - namespace.yaml
  - ../_defaults/baseline-quota.yaml
  - ../_defaults/baseline-limitrange.yaml
  - rbac.yaml

patches:
  - target:
      kind: ResourceQuota
      name: baseline-quota
    patch: |
      - op: replace
        path: /spec/hard/requests.cpu
        value: "10"
      - op: replace
        path: /spec/hard/requests.memory
        value: 20Gi
      - op: replace
        path: /spec/hard/limits.cpu
        value: "20"
      - op: replace
        path: /spec/hard/limits.memory
        value: 40Gi
      - op: replace
        path: /spec/hard/pods
        value: "50"
```

### Argo CD Application

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: team-alpha-namespace-config
  namespace: argocd
spec:
  project: platform
  source:
    repoURL: https://github.com/company/platform-config
    targetRevision: main
    path: teams/team-alpha
  destination:
    server: https://kubernetes.default.svc
    namespace: team-alpha
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
      - ServerSideApply=true
```

## Admission Webhook for Label-Based Quota Enforcement

A validating admission webhook can enforce organizational policies on top of native quota — for example, requiring that all namespaces have a `team` label before quota can be created, or blocking namespaces from exceeding a cluster-wide CPU allocation budget.

```go
// quota-validator/main.go
package main

import (
	"encoding/json"
	"fmt"
	"net/http"

	admissionv1 "k8s.io/api/admission/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
)

const maxCPURequestPerNamespace = "20"

func validateQuota(w http.ResponseWriter, r *http.Request) {
	var admissionReview admissionv1.AdmissionReview
	if err := json.NewDecoder(r.Body).Decode(&admissionReview); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	var quota corev1.ResourceQuota
	if err := json.Unmarshal(admissionReview.Request.Object.Raw, &quota); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	allowed := true
	var message string

	if cpuLimit, ok := quota.Spec.Hard[corev1.ResourceLimitsCPU]; ok {
		maxCPU := resource.MustParse(maxCPURequestPerNamespace)
		if cpuLimit.Cmp(maxCPU) > 0 {
			allowed = false
			message = fmt.Sprintf("CPU limits quota %s exceeds maximum allowed %s per namespace",
				cpuLimit.String(), maxCPURequestPerNamespace)
		}
	}

	// Require team label on namespace before accepting quota
	ns := admissionReview.Request.Namespace
	if ns != "" && quota.Labels["team"] == "" {
		allowed = false
		message = "ResourceQuota must have a 'team' label for chargeback tracking"
	}

	response := admissionv1.AdmissionResponse{
		UID:     admissionReview.Request.UID,
		Allowed: allowed,
	}
	if !allowed {
		response.Result = &metav1.Status{
			Message: message,
		}
	}

	admissionReview.Response = &response
	json.NewEncoder(w).Encode(admissionReview)
}

func main() {
	http.HandleFunc("/validate/quota", validateQuota)
	http.ListenAndServeTLS(":8443", "/tls/tls.crt", "/tls/tls.key", nil)
}
```

## Monitoring Quota Utilization with Prometheus

The `kube-state-metrics` deployment exports quota utilization as Prometheus metrics.

### Key Metrics

```promql
# Quota utilization percentage for CPU requests
(
  kube_resourcequota{type="used", resource="requests.cpu"}
  /
  kube_resourcequota{type="hard", resource="requests.cpu"}
) * 100

# Namespaces with > 80% CPU quota utilization
(
  kube_resourcequota{type="used", resource="requests.cpu"}
  /
  kube_resourcequota{type="hard", resource="requests.cpu"}
) * 100 > 80

# Memory quota utilization by namespace
(
  kube_resourcequota{type="used", resource="requests.memory"}
  /
  kube_resourcequota{type="hard", resource="requests.memory"}
) * 100

# Pod count utilization
(
  kube_resourcequota{type="used", resource="pods"}
  /
  kube_resourcequota{type="hard", resource="pods"}
) * 100

# PVC count utilization
(
  kube_resourcequota{type="used", resource="persistentvolumeclaims"}
  /
  kube_resourcequota{type="hard", resource="persistentvolumeclaims"}
) * 100
```

### Alerting Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: resource-quota-alerts
  namespace: monitoring
  labels:
    release: prometheus
spec:
  groups:
    - name: resource-quota
      interval: 60s
      rules:
        - alert: NamespaceCpuQuotaNearLimit
          expr: |
            (
              kube_resourcequota{type="used", resource="requests.cpu"}
              /
              kube_resourcequota{type="hard", resource="requests.cpu"}
            ) * 100 > 85
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "CPU quota near limit in namespace {{ $labels.namespace }}"
            description: "Namespace {{ $labels.namespace }} CPU request quota is at {{ $value | humanize }}%. Contact the team to review usage or request a quota increase."

        - alert: NamespaceMemoryQuotaNearLimit
          expr: |
            (
              kube_resourcequota{type="used", resource="requests.memory"}
              /
              kube_resourcequota{type="hard", resource="requests.memory"}
            ) * 100 > 85
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "Memory quota near limit in namespace {{ $labels.namespace }}"
            description: "Namespace {{ $labels.namespace }} memory request quota is at {{ $value | humanize }}%."

        - alert: NamespacePodCountNearLimit
          expr: |
            (
              kube_resourcequota{type="used", resource="pods"}
              /
              kube_resourcequota{type="hard", resource="pods"}
            ) * 100 > 90
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Pod count quota near limit in namespace {{ $labels.namespace }}"
            description: "Namespace {{ $labels.namespace }} is at {{ $value | humanize }}% of its pod count quota."

        - alert: NamespaceQuotaExhausted
          expr: |
            kube_resourcequota{type="used"}
            >=
            kube_resourcequota{type="hard"}
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "Resource quota exhausted in namespace {{ $labels.namespace }}"
            description: "Namespace {{ $labels.namespace }} quota for {{ $labels.resource }} is fully exhausted. New pods will be rejected."
```

## Multi-Tenancy Design Patterns

### Namespace-Per-Team with Tiered Quotas

Large engineering organizations benefit from tiered quota profiles that match team size and workload type:

```yaml
# Small team / experimental namespace
apiVersion: v1
kind: ResourceQuota
metadata:
  name: tier-small
  namespace: team-experimental
spec:
  hard:
    requests.cpu: "2"
    requests.memory: 4Gi
    limits.cpu: "4"
    limits.memory: 8Gi
    pods: "10"
    persistentvolumeclaims: "5"

---
# Medium team / standard production namespace
apiVersion: v1
kind: ResourceQuota
metadata:
  name: tier-medium
  namespace: team-backend
spec:
  hard:
    requests.cpu: "10"
    requests.memory: 20Gi
    limits.cpu: "20"
    limits.memory: 40Gi
    pods: "50"
    persistentvolumeclaims: "20"

---
# Large team / high-traffic production namespace
apiVersion: v1
kind: ResourceQuota
metadata:
  name: tier-large
  namespace: team-platform
spec:
  hard:
    requests.cpu: "30"
    requests.memory: 60Gi
    limits.cpu: "60"
    limits.memory: 120Gi
    pods: "150"
    persistentvolumeclaims: "50"
```

### Namespace Annotations for Chargeback

Annotate ResourceQuota objects with cost-center information for chargeback reporting:

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: team-alpha-quota
  namespace: team-alpha
  annotations:
    cost-center: "engineering-platform"
    team-owner: "platform-engineering"
    billing-tier: "production"
    max-monthly-budget-usd: "5000"
spec:
  hard:
    requests.cpu: "10"
    requests.memory: 20Gi
```

A separate reporting job queries `kube_resourcequota` metrics and matches them against annotation data to produce per-team cost reports.

### Quota Increase Workflow

Quota increase requests should follow a GitOps workflow with PR review:

```bash
#!/bin/bash
# quota-increase-request.sh
# Creates a PR branch with a quota increase patch for review.

set -euo pipefail

NAMESPACE="$1"
RESOURCE="$2"
NEW_VALUE="$3"
REPO_ROOT="/path/to/platform-config"
BRANCH="quota-increase/${NAMESPACE}-${RESOURCE}-$(date +%Y%m%d)"

cd "$REPO_ROOT"
git checkout -b "$BRANCH"

QUOTA_FILE="teams/${NAMESPACE}/resource-quota.yaml"

# Use kubectl patch to generate the updated file
kubectl patch resourcequota --dry-run=client \
  -f "$QUOTA_FILE" \
  --patch "{\"spec\":{\"hard\":{\"${RESOURCE}\":\"${NEW_VALUE}\"}}}" \
  -o yaml > "${QUOTA_FILE}.new"

mv "${QUOTA_FILE}.new" "$QUOTA_FILE"

git add "$QUOTA_FILE"
git commit -m "quota: increase ${RESOURCE} to ${NEW_VALUE} in ${NAMESPACE}"
git push origin "$BRANCH"

echo "Branch ${BRANCH} pushed. Open a PR for review."
```

## Summary

ResourceQuota and LimitRange form a complementary pair for namespace-level resource governance. Quotas enforce hard aggregate ceilings that protect shared infrastructure from runaway consumption, while LimitRanges ensure every pod has sensible resource specifications through injected defaults and validated boundaries. Combining priority class-scoped quotas to protect critical workloads, GitOps-managed quota definitions to prevent drift, and Prometheus alerting to detect quota exhaustion before it causes pod admission failures creates a multi-tenancy model that balances autonomy for development teams with operational safety for the platform.
