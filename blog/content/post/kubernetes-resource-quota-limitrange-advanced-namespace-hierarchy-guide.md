---
title: "Kubernetes Resource Quota and LimitRange Advanced: Namespace Hierarchy, Admission Validation, and Burst Handling"
date: 2031-12-11T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Resource Quota", "LimitRange", "Admission Control", "Multi-Tenancy", "Capacity Planning", "Namespace Management"]
categories: ["Kubernetes", "Platform Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-grade guide to Kubernetes ResourceQuota and LimitRange configuration covering namespace hierarchy enforcement, admission webhook validation, burst capacity patterns, quota scoping, and operational runbooks for multi-tenant cluster management."
more_link: "yes"
url: "/kubernetes-resource-quota-limitrange-advanced-namespace-hierarchy-guide/"
---

ResourceQuota and LimitRange are Kubernetes' built-in mechanisms for multi-tenant resource governance. Used correctly, they prevent noisy-neighbor problems, guarantee minimum quality of service for all tenants, and enable accurate cluster capacity planning. Used incorrectly — with quotas that are too tight, LimitRanges that are misconfigured, or missing default limits — they either block legitimate workloads or fail to protect other tenants. This guide covers every production-relevant aspect of quota management.

<!--more-->

# Kubernetes Resource Quota and LimitRange: Advanced Guide

## Understanding the Admission Pipeline

Every Pod creation goes through this sequence:

```
kubectl apply / Helm / operator
         |
         v
[API Server Authentication]
         |
         v
[API Server Authorization (RBAC)]
         |
         v
[Mutating Admission Webhooks]   <-- LimitRange defaults injected here
         |
         v
[Schema Validation]
         |
         v
[Validating Admission Webhooks] <-- Custom quota policies checked here
         |
         v
[Resource Quota Admission Plugin] <-- Built-in quota enforcement
         |
         v
[etcd persistence]
```

LimitRange mutations happen BEFORE quota admission. This means if a Pod has no resource requests, LimitRange applies defaults, and THEN quota is checked against those defaults.

## LimitRange: Setting Defaults and Bounds

### Comprehensive LimitRange for a Production Namespace

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: production-limits
  namespace: production-frontend
spec:
  limits:
    # Container-level limits
    - type: Container
      default:          # Applied when container has no limits set
        cpu: "500m"
        memory: "512Mi"
      defaultRequest:   # Applied when container has no requests set
        cpu: "100m"
        memory: "128Mi"
      max:              # Container cannot exceed these
        cpu: "4"
        memory: "8Gi"
      min:              # Container must request at least this much
        cpu: "50m"
        memory: "64Mi"
      maxLimitRequestRatio:  # limit/request cannot exceed this ratio
        cpu: "10"       # Burstable QoS: allows up to 10x burst
        memory: "4"     # Memory cannot burst more than 4x

    # Pod-level limits (applies to sum of all containers)
    - type: Pod
      max:
        cpu: "16"
        memory: "32Gi"
      min:
        cpu: "50m"
        memory: "64Mi"

    # PVC limits
    - type: PersistentVolumeClaim
      max:
        storage: "1Ti"
      min:
        storage: "1Gi"
```

### LimitRange Interaction with QoS Classes

Kubernetes assigns QoS classes based on resource configuration:

| QoS Class | Condition |
|-----------|-----------|
| Guaranteed | All containers have limits == requests |
| Burstable | At least one container has a request or limit |
| BestEffort | No container has any resource specifications |

The `maxLimitRequestRatio` in LimitRange enforces that burstable containers don't burst too aggressively:

```yaml
limits:
  - type: Container
    maxLimitRequestRatio:
      cpu: "5"     # cpu limit cannot be > 5x cpu request
      memory: "2"  # memory limit cannot be > 2x memory request
```

This prevents a container from setting `requests: {cpu: 1m}` and `limits: {cpu: 32}`, which would allow unbounded bursting.

## ResourceQuota: Namespace-Level Caps

### Compute Quota

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: compute-resources
  namespace: production-frontend
spec:
  hard:
    # Total CPU requests cannot exceed 20 cores
    requests.cpu: "20"
    # Total CPU limits cannot exceed 40 cores
    limits.cpu: "40"
    # Total memory requests cannot exceed 40 GiB
    requests.memory: "40Gi"
    # Total memory limits cannot exceed 80 GiB
    limits.memory: "80Gi"
    # Maximum number of pods
    pods: "100"
    # Maximum number of containers (across all pods)
    count/containers: "300"
```

### Storage Quota

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: storage-resources
  namespace: production-frontend
spec:
  hard:
    # Total PVC storage requests
    requests.storage: "10Ti"
    # Per-StorageClass quotas
    rook-ceph-block.storageclass.storage.k8s.io/requests.storage: "5Ti"
    rook-cephfs.storageclass.storage.k8s.io/requests.storage: "5Ti"
    # Maximum number of PVCs
    persistentvolumeclaims: "50"
    # Maximum number of PVCs per StorageClass
    rook-ceph-block.storageclass.storage.k8s.io/persistentvolumeclaims: "30"
```

### Object Count Quota

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: object-counts
  namespace: production-frontend
spec:
  hard:
    # Kubernetes object limits
    count/deployments.apps: "50"
    count/statefulsets.apps: "10"
    count/services: "30"
    count/secrets: "100"
    count/configmaps: "100"
    count/replicationcontrollers: "0"  # Forbid deprecated resource
    # Service type restrictions via count
    count/services.loadbalancers: "5"
    count/services.nodeports: "0"      # No NodePort services allowed
```

### Quota with Scopes

Scopes allow different quotas for different workload types:

```yaml
# Quota for BestEffort pods (no guarantees)
apiVersion: v1
kind: ResourceQuota
metadata:
  name: best-effort-quota
  namespace: production-frontend
spec:
  hard:
    pods: "10"  # Limit number of BestEffort pods
  scopes:
    - BestEffort

---
# Quota for NotBestEffort pods (Guaranteed or Burstable)
apiVersion: v1
kind: ResourceQuota
metadata:
  name: guaranteed-quota
  namespace: production-frontend
spec:
  hard:
    pods: "90"
    requests.cpu: "18"
    requests.memory: "36Gi"
    limits.cpu: "36"
    limits.memory: "72Gi"
  scopes:
    - NotBestEffort

---
# Quota for workloads with PriorityClass
apiVersion: v1
kind: ResourceQuota
metadata:
  name: high-priority-quota
  namespace: production-frontend
spec:
  hard:
    pods: "20"
    requests.cpu: "8"
    requests.memory: "16Gi"
  scopeSelector:
    matchExpressions:
      - operator: In
        scopeName: PriorityClass
        values:
          - high-priority
          - system-cluster-critical
```

## Namespace Hierarchy: Hierarchical Resource Quota

Standard Kubernetes ResourceQuota only works at the namespace level. For multi-tenant platforms with teams, sub-teams, and environments, you need hierarchical quota enforcement. The most mature solution is the **Hierarchical Namespace Controller (HNC)** combined with custom admission webhooks.

### Hierarchical Namespace Controller (HNC)

```bash
# Install HNC
kubectl apply -f https://github.com/kubernetes-sigs/hierarchical-namespaces/releases/download/v1.1.0/default.yaml

# Verify installation
kubectl get pods -n hnc-system
```

### Creating a Namespace Hierarchy

```yaml
# Parent namespace: team-alpha (total budget)
apiVersion: v1
kind: Namespace
metadata:
  name: team-alpha
  labels:
    team: alpha

---
# Child namespace: team-alpha-production
apiVersion: hnc.x-k8s.io/v1alpha2
kind: SubnamespaceAnchor
metadata:
  name: team-alpha-production
  namespace: team-alpha

---
# Child namespace: team-alpha-staging
apiVersion: hnc.x-k8s.io/v1alpha2
kind: SubnamespaceAnchor
metadata:
  name: team-alpha-staging
  namespace: team-alpha
```

### Propagating ResourceQuotas through HNC

HNC can propagate objects (including ResourceQuotas) from parent to child namespaces:

```yaml
# Configure HNC to propagate ResourceQuotas
apiVersion: hnc.x-k8s.io/v1alpha2
kind: HNCConfiguration
metadata:
  name: config
spec:
  resources:
    - resource: resourcequotas
      mode: Propagate   # Propagate from parent to children
    - resource: limitranges
      mode: Propagate
    - resource: networkpolicies
      mode: Propagate
    - resource: rolebindings
      mode: Propagate
```

## Custom Admission Webhook for Quota Policy

The built-in ResourceQuota cannot enforce team-specific rules like "each deployment must have a cost-center label" or "GPU requests require manager approval." Custom validating webhooks fill this gap.

### Quota Policy Admission Controller in Go

```go
// cmd/quota-webhook/main.go
package main

import (
    "context"
    "encoding/json"
    "fmt"
    "net/http"
    "os"
    "strconv"

    admissionv1 "k8s.io/api/admission/v1"
    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/api/resource"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime"
    "k8s.io/apimachinery/pkg/runtime/serializer"
    "log/slog"
)

var (
    scheme = runtime.NewScheme()
    codecs = serializer.NewCodecFactory(scheme)

    // Max GPU requests per namespace without annotation override
    defaultMaxGPUPerNamespace = 4

    log = slog.New(slog.NewJSONHandler(os.Stdout, nil))
)

func validatePod(ar admissionv1.AdmissionReview) *admissionv1.AdmissionResponse {
    pod := &corev1.Pod{}
    if err := json.Unmarshal(ar.Request.Object.Raw, pod); err != nil {
        return &admissionv1.AdmissionResponse{
            Allowed: false,
            Result: &metav1.Status{
                Message: fmt.Sprintf("could not unmarshal pod: %v", err),
            },
        }
    }

    var violations []string

    // Rule 1: All pods must have a cost-center label
    if _, ok := pod.Labels["cost-center"]; !ok {
        violations = append(violations, "pod must have label 'cost-center'")
    }

    // Rule 2: All pods must have a team label
    if _, ok := pod.Labels["team"]; !ok {
        violations = append(violations, "pod must have label 'team'")
    }

    // Rule 3: Resource requests are required (prevent BestEffort pods in production)
    for _, c := range pod.Spec.Containers {
        if c.Resources.Requests == nil || c.Resources.Requests.Cpu().IsZero() {
            violations = append(violations,
                fmt.Sprintf("container %q must have cpu request", c.Name))
        }
        if c.Resources.Requests == nil || c.Resources.Requests.Memory().IsZero() {
            violations = append(violations,
                fmt.Sprintf("container %q must have memory request", c.Name))
        }
    }

    // Rule 4: GPU quota enforcement
    totalGPU := resource.Quantity{}
    for _, c := range pod.Spec.Containers {
        if gpu := c.Resources.Requests[corev1.ResourceName("nvidia.com/gpu")]; !gpu.IsZero() {
            totalGPU.Add(gpu)
        }
    }

    if !totalGPU.IsZero() {
        nsMaxGPU := defaultMaxGPUPerNamespace
        // Check for namespace-level override annotation
        // (In production, fetch namespace via Kubernetes client)
        if override, ok := pod.Annotations["quota.example.com/max-gpu-override"]; ok {
            if v, err := strconv.Atoi(override); err == nil {
                nsMaxGPU = v
            }
        }
        gpuCount, _ := totalGPU.AsInt64()
        if int(gpuCount) > nsMaxGPU {
            violations = append(violations,
                fmt.Sprintf("GPU request %d exceeds namespace maximum %d", gpuCount, nsMaxGPU))
        }
    }

    // Rule 5: Production namespace pods must have readiness probes
    if ar.Request.Namespace == "production" || ar.Request.Namespace == "production-frontend" {
        for _, c := range pod.Spec.Containers {
            if c.ReadinessProbe == nil {
                violations = append(violations,
                    fmt.Sprintf("container %q in production namespace must have readiness probe", c.Name))
            }
        }
    }

    if len(violations) > 0 {
        msg := fmt.Sprintf("Pod policy violations: %v", violations)
        log.Warn("pod rejected", "violations", violations,
            "pod", pod.Name, "namespace", ar.Request.Namespace)
        return &admissionv1.AdmissionResponse{
            Allowed: false,
            Result: &metav1.Status{
                Code:    http.StatusForbidden,
                Message: msg,
            },
        }
    }

    return &admissionv1.AdmissionResponse{Allowed: true}
}

func servePodValidation(w http.ResponseWriter, r *http.Request) {
    var body []byte
    if r.Body != nil {
        defer r.Body.Close()
        body = make([]byte, r.ContentLength)
        r.Body.Read(body)
    }

    var ar admissionv1.AdmissionReview
    if err := json.Unmarshal(body, &ar); err != nil {
        log.Error("unmarshal admission review", "err", err)
        http.Error(w, err.Error(), http.StatusBadRequest)
        return
    }

    response := validatePod(ar)
    response.UID = ar.Request.UID

    responseAR := admissionv1.AdmissionReview{
        TypeMeta: metav1.TypeMeta{
            APIVersion: "admission.k8s.io/v1",
            Kind:       "AdmissionReview",
        },
        Response: response,
    }

    responseJSON, err := json.Marshal(responseAR)
    if err != nil {
        log.Error("marshal response", "err", err)
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }

    w.Header().Set("Content-Type", "application/json")
    w.Write(responseJSON)
}

func main() {
    mux := http.NewServeMux()
    mux.HandleFunc("/validate/pods", servePodValidation)
    mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
    })

    certFile := os.Getenv("TLS_CERT_FILE")
    keyFile := os.Getenv("TLS_KEY_FILE")

    server := &http.Server{
        Addr:    ":8443",
        Handler: mux,
    }

    log.Info("starting quota admission webhook", "addr", ":8443")
    if err := server.ListenAndServeTLS(certFile, keyFile); err != nil {
        log.Error("server failed", "err", err)
        os.Exit(1)
    }
}
```

### Registering the Webhook

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingWebhookConfiguration
metadata:
  name: quota-policy-validator
  annotations:
    cert-manager.io/inject-ca-from: "quota-system/quota-webhook-cert"
webhooks:
  - name: validate-pods.quota.example.com
    admissionReviewVersions: ["v1"]
    sideEffects: None
    timeoutSeconds: 10
    failurePolicy: Fail     # Reject pods if webhook is unreachable
    namespaceSelector:
      matchLabels:
        quota.example.com/enforce: "true"
    rules:
      - apiGroups: [""]
        apiVersions: ["v1"]
        resources: ["pods"]
        operations: ["CREATE"]
    clientConfig:
      service:
        name: quota-webhook
        namespace: quota-system
        path: /validate/pods
        port: 8443
```

## Burst Capacity Patterns

### Time-Based Quota Override

Some workloads (batch jobs, end-of-month reporting) legitimately need more resources temporarily. Rather than permanently over-allocating, implement time-based quota overrides:

```go
// cmd/quota-burster/main.go
// A CronJob that temporarily increases quota for batch windows

package main

import (
    "context"
    "fmt"
    "os"
    "time"

    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/api/resource"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/types"
    "k8s.io/client-go/kubernetes"
    "k8s.io/client-go/rest"
)

type QuotaBurster struct {
    client    kubernetes.Interface
    namespace string
    quotaName string
}

func (b *QuotaBurster) SetBurstQuota(ctx context.Context, cpuLimit, memLimit string) error {
    patch := fmt.Sprintf(`{"spec":{"hard":{"limits.cpu":"%s","limits.memory":"%s"}}}`,
        cpuLimit, memLimit)

    _, err := b.client.CoreV1().ResourceQuotas(b.namespace).Patch(
        ctx,
        b.quotaName,
        types.MergePatchType,
        []byte(patch),
        metav1.PatchOptions{},
    )
    return err
}

func main() {
    action := os.Getenv("BURST_ACTION") // "enable" or "disable"
    namespace := os.Getenv("TARGET_NAMESPACE")
    quotaName := os.Getenv("QUOTA_NAME")

    cfg, err := rest.InClusterConfig()
    if err != nil {
        fmt.Fprintf(os.Stderr, "in-cluster config: %v\n", err)
        os.Exit(1)
    }

    client, err := kubernetes.NewForConfig(cfg)
    if err != nil {
        fmt.Fprintf(os.Stderr, "create client: %v\n", err)
        os.Exit(1)
    }

    burster := &QuotaBurster{
        client:    client,
        namespace: namespace,
        quotaName: quotaName,
    }

    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    switch action {
    case "enable":
        // Burst: allow 3x normal limits
        fmt.Printf("Enabling burst mode for %s/%s\n", namespace, quotaName)
        if err := burster.SetBurstQuota(ctx, "60", "120Gi"); err != nil {
            fmt.Fprintf(os.Stderr, "enable burst: %v\n", err)
            os.Exit(1)
        }
        fmt.Println("Burst mode enabled")

    case "disable":
        // Return to normal limits
        fmt.Printf("Disabling burst mode for %s/%s\n", namespace, quotaName)
        if err := burster.SetBurstQuota(ctx, "20", "40Gi"); err != nil {
            fmt.Fprintf(os.Stderr, "disable burst: %v\n", err)
            os.Exit(1)
        }
        fmt.Println("Burst mode disabled")

    default:
        fmt.Fprintf(os.Stderr, "unknown action: %s (use 'enable' or 'disable')\n", action)
        os.Exit(1)
    }
}
```

```yaml
# CronJob pair for end-of-month batch window
apiVersion: batch/v1
kind: CronJob
metadata:
  name: enable-batch-burst
  namespace: quota-system
spec:
  schedule: "0 22 28-31 * *"  # Enable at 10 PM on days 28-31
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: quota-burster
          containers:
            - name: burster
              image: registry.example.com/quota-burster:v1.0.0
              env:
                - name: BURST_ACTION
                  value: "enable"
                - name: TARGET_NAMESPACE
                  value: "batch-processing"
                - name: QUOTA_NAME
                  value: "compute-resources"
          restartPolicy: OnFailure

---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: disable-batch-burst
  namespace: quota-system
spec:
  schedule: "0 6 1 * *"  # Disable at 6 AM on the 1st
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: quota-burster
          containers:
            - name: burster
              image: registry.example.com/quota-burster:v1.0.0
              env:
                - name: BURST_ACTION
                  value: "disable"
                - name: TARGET_NAMESPACE
                  value: "batch-processing"
                - name: QUOTA_NAME
                  value: "compute-resources"
          restartPolicy: OnFailure
```

## Quota Monitoring and Alerting

```yaml
# PrometheusRule for quota alerts
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: quota-alerts
  namespace: monitoring
spec:
  groups:
    - name: kubernetes-quota
      interval: 60s
      rules:
        - alert: NamespaceQuotaCPUUsageHigh
          expr: >
            (
              kube_resourcequota{type="used", resource="requests.cpu"}
              / kube_resourcequota{type="hard", resource="requests.cpu"}
            ) > 0.80
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Namespace {{ $labels.namespace }} CPU quota above 80%"
            description: >
              Namespace {{ $labels.namespace }} is using
              {{ $value | humanizePercentage }} of its CPU request quota.

        - alert: NamespaceQuotaMemoryUsageHigh
          expr: >
            (
              kube_resourcequota{type="used", resource="requests.memory"}
              / kube_resourcequota{type="hard", resource="requests.memory"}
            ) > 0.80
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Namespace {{ $labels.namespace }} memory quota above 80%"

        - alert: NamespaceQuotaExhausted
          expr: >
            (
              kube_resourcequota{type="used"}
              / kube_resourcequota{type="hard"}
            ) >= 1.0
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "Namespace {{ $labels.namespace }} {{ $labels.resource }} quota EXHAUSTED"
            description: >
              Namespace {{ $labels.namespace }} has exhausted its
              {{ $labels.resource }} quota. New workloads will be rejected.

        - alert: LimitRangeMissingInNamespace
          expr: >
            count(kube_limitrange{}) by (namespace)
            unless count(kube_namespace_labels{}) by (namespace)
          for: 30m
          labels:
            severity: warning
          annotations:
            summary: "Namespace {{ $labels.namespace }} has no LimitRange"
```

## Operational Runbooks

### Checking Quota Usage

```bash
#!/usr/bin/env bash
# check-quota.sh — Display quota usage for all namespaces

set -euo pipefail

echo "=== Resource Quota Usage Report ==="
echo "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

kubectl get resourcequota --all-namespaces -o json | \
  python3 - << 'EOF'
import json, sys

data = json.load(sys.stdin)
namespaces = {}

for item in data.get("items", []):
    ns = item["metadata"]["namespace"]
    name = item["metadata"]["name"]
    hard = item["status"].get("hard", {})
    used = item["status"].get("used", {})

    for resource, hard_val in hard.items():
        used_val = used.get(resource, "0")
        key = (ns, resource)
        namespaces[key] = {
            "quota_name": name,
            "hard": hard_val,
            "used": used_val,
        }

print(f"{'NAMESPACE':<30} {'RESOURCE':<35} {'USED':<15} {'HARD':<15} {'PCT':>6}")
print("-" * 105)

for (ns, resource), info in sorted(namespaces.items()):
    hard = info["hard"]
    used = info["used"]

    # Try to compute percentage for CPU and memory
    pct = "N/A"
    try:
        def parse_quantity(q):
            if q.endswith("m"):
                return float(q[:-1])
            elif q.endswith("Mi"):
                return float(q[:-2])
            elif q.endswith("Gi"):
                return float(q[:-2]) * 1024
            else:
                return float(q)

        pct_val = parse_quantity(used) / parse_quantity(hard) * 100
        pct = f"{pct_val:.1f}%"
        flag = " WARN" if pct_val > 80 else ("  CRIT" if pct_val >= 100 else "")
        pct += flag
    except:
        pass

    print(f"{ns:<30} {resource:<35} {used:<15} {hard:<15} {pct:>10}")
EOF
```

### Debugging "Forbidden: exceeded quota" Errors

```bash
# When a deployment fails with quota error, identify which resource is exhausted
kubectl describe resourcequota -n "${NAMESPACE}"

# Check what's consuming quota
kubectl get pods -n "${NAMESPACE}" \
  -o custom-columns="NAME:.metadata.name,CPU_REQ:.spec.containers[*].resources.requests.cpu,MEM_REQ:.spec.containers[*].resources.requests.memory" | \
  head -30

# Check LimitRange defaults (what gets injected when not specified)
kubectl describe limitrange -n "${NAMESPACE}"

# Simulate a pod create to see if it would be admitted
kubectl auth can-i create pods --namespace "${NAMESPACE}" \
  --as=system:serviceaccount:${NAMESPACE}:default
```

### Safely Increasing Quota

```bash
#!/usr/bin/env bash
# increase-quota.sh — Request quota increase with approval tracking

NAMESPACE="${1:?usage: $0 <namespace> <resource> <new-value>}"
RESOURCE="${2:?}"
NEW_VALUE="${3:?}"
REQUESTOR="${REQUESTOR:-$(git config user.email 2>/dev/null || echo 'unknown')}"

# Get current quota
CURRENT=$(kubectl get resourcequota -n "${NAMESPACE}" \
  -o jsonpath="{.items[?(@.status.hard.${RESOURCE})].status.hard.${RESOURCE}}" \
  2>/dev/null || echo "not set")

echo "Quota increase request:"
echo "  Namespace: ${NAMESPACE}"
echo "  Resource:  ${RESOURCE}"
echo "  Current:   ${CURRENT}"
echo "  Requested: ${NEW_VALUE}"
echo "  Requestor: ${REQUESTOR}"
echo ""
read -p "Apply this change? [y/N] " -r
if [[ ! "$REPLY" =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
fi

# Log the change
kubectl annotate namespace "${NAMESPACE}" \
  "quota.example.com/last-change=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "quota.example.com/last-requestor=${REQUESTOR}" \
  --overwrite

# Apply the change
kubectl patch resourcequota compute-resources -n "${NAMESPACE}" \
  --type merge \
  --patch "{\"spec\":{\"hard\":{\"${RESOURCE}\":\"${NEW_VALUE}\"}}}"

echo "Quota updated successfully."
kubectl describe resourcequota -n "${NAMESPACE}"
```

## Summary

ResourceQuota and LimitRange work together to create a multi-layered resource governance system. LimitRange establishes defaults, minimums, and the burst ratio, which are injected before quota accounting happens. ResourceQuota enforces namespace-level caps with fine-grained scope selectors for different workload classes. Custom admission webhooks enforce policy rules that quota alone cannot express — label requirements, probe requirements, GPU approval workflows. The key operational practices are: always set LimitRange defaults so BestEffort pods cannot appear accidentally, monitor quota utilization at 80% and alert at 90%, use PriorityClass scopes to reserve resources for critical workloads even when the namespace is near quota, and implement automated burst windows for predictable high-demand periods rather than permanently over-allocating.
