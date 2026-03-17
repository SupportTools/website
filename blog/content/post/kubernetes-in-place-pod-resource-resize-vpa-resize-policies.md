---
title: "Kubernetes In-Place Pod Resource Resize: VPA with In-Place Updates, Resize Policies, Container Restart on Resize"
date: 2032-01-23T00:00:00-05:00
draft: false
tags: ["Kubernetes", "VPA", "In-Place Resize", "Resource Management", "Pod Autoscaling", "Performance"]
categories:
- Kubernetes
- Operations
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete guide to Kubernetes in-place pod resource resizing covering the InPlacePodVerticalScaling feature gate, resize policies for CPU and memory, how the VPA webhook interacts with resize, container restart semantics during resize operations, and production patterns for zero-downtime resource adjustment."
more_link: "yes"
url: "/kubernetes-in-place-pod-resource-resize-vpa-resize-policies/"
---

In-place pod resource resize, stabilized in Kubernetes 1.33, allows CPU and memory requests and limits to be modified on running pods without pod restart. This eliminates the most disruptive aspect of Vertical Pod Autoscaler (VPA): the forced pod eviction and restart cycle required to apply resource changes. For stateful applications, long-running batch jobs, and latency-sensitive services, this is transformative. This guide covers the complete implementation and operational model.

<!--more-->

# Kubernetes In-Place Pod Resource Resize: Production Guide

## Section 1: Feature Overview and Prerequisites

### What In-Place Resize Enables

Before in-place resize (Kubernetes < 1.27 default), changing container resources required:
1. VPA calculates new resource recommendations
2. VPA evicts the pod
3. Deployment controller creates new pod with updated resources
4. Application restarts, reconnects to dependencies, reloads state

With in-place resize:
1. VPA (or operator) patches `pod.spec.containers[*].resources`
2. Kubelet detects the resource change
3. Kubelet communicates the update to the container runtime (containerd/CRI-O)
4. Container runtime adjusts cgroup limits without process restart (for CPU)
5. Container may optionally restart for memory changes based on resize policy

### Feature Gates and Version Requirements

| Feature | Version | Status |
|---------|---------|--------|
| InPlacePodVerticalScaling | 1.27 | Alpha |
| InPlacePodVerticalScaling | 1.29 | Beta |
| InPlacePodVerticalScaling | 1.33 | Stable (on by default) |

```bash
# Check if feature is enabled (Kubernetes < 1.33)
kubectl get node <node-name> -o json | \
  jq '.metadata.annotations["node.alpha.kubernetes.io/ttl"]'

# Check feature gate on API server
kubectl get pod -n kube-system kube-apiserver-<node> -o yaml | \
  grep -A 10 "feature-gates"

# For clusters running 1.27-1.32, enable explicitly
# kube-apiserver flag:
--feature-gates=InPlacePodVerticalScaling=true

# kubelet flag (all nodes):
--feature-gates=InPlacePodVerticalScaling=true
```

### Container Runtime Requirements

In-place resize requires container runtime support for cgroup updates:
- **containerd 1.6+**: Full support
- **CRI-O 1.26+**: Full support
- **Docker shim**: Removed in 1.24; not supported

```bash
# Verify containerd version
containerd --version
# containerd github.com/containerd/containerd v1.7.12

# Verify CRI API version
crictl version
```

## Section 2: Resize Policies

The `resizePolicy` field on each container controls what happens when a resource request is changed. Without this field, defaults apply.

### Resize Policy Options

```yaml
resizePolicy:
  - resourceName: cpu
    restartPolicy: NotRequired    # CPU can be adjusted without restart
  - resourceName: memory
    restartPolicy: RestartContainer  # Memory change requires container restart
```

| restartPolicy | Effect |
|--------------|--------|
| NotRequired | Resource adjusted in-place, no restart |
| RestartContainer | Container is restarted when this resource changes |

### Default Behavior

If `resizePolicy` is not specified:
- CPU: `NotRequired` (no restart)
- Memory: `NotRequired` (no restart) in Kubernetes 1.33+

**Critical caveat for memory**: The Linux kernel cannot decrease a process's memory without evicting pages. If you decrease memory limits and the container is using more than the new limit, the OOM killer will terminate processes. Set `RestartContainer` for memory decreases if your application cannot gracefully handle OOM.

### Comprehensive Resize Policy Configuration

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: api-server
  template:
    metadata:
      labels:
        app: api-server
    spec:
      containers:
        - name: api
          image: api-server:v2.1.0
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: 2000m
              memory: 2Gi
          resizePolicy:
            - resourceName: cpu
              restartPolicy: NotRequired    # CPU resize is transparent
            - resourceName: memory
              restartPolicy: RestartContainer  # Memory resize restarts container

        - name: sidecar
          image: envoy:v1.28.0
          resources:
            requests:
              cpu: 100m
              memory: 64Mi
            limits:
              cpu: 500m
              memory: 256Mi
          resizePolicy:
            - resourceName: cpu
              restartPolicy: NotRequired
            - resourceName: memory
              restartPolicy: NotRequired    # Envoy handles memory limit changes
```

## Section 3: Performing In-Place Resize

### Manual Resize via kubectl patch

```bash
# Resize a single container's CPU request
kubectl patch pod api-server-abc12 -n production --subresource resize \
  --type merge \
  -p '{"spec":{"containers":[{"name":"api","resources":{"requests":{"cpu":"1000m"}}}]}}'

# Resize using apply (declarative)
kubectl apply -f - << 'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: api-server-abc12
  namespace: production
spec:
  containers:
    - name: api
      resources:
        requests:
          cpu: 1000m
          memory: 1Gi
        limits:
          cpu: 4000m
          memory: 4Gi
EOF
```

Note: You must use the `resize` subresource for pod resource changes. Normal `patch` on pods does not allow most spec changes after creation.

### Verifying Resize Status

After requesting a resize, the pod status reflects the current state of the operation:

```bash
# Check pod resize status
kubectl get pod api-server-abc12 -n production -o json | \
  jq '.status.containerStatuses[] | {name: .name, resources: .resources, allocatedResources: .allocatedResources}'

# Check resize conditions
kubectl get pod api-server-abc12 -n production -o json | \
  jq '.status.conditions[] | select(.type == "PodResizePending" or .type == "PodResizeInProgress")'
```

### Pod Resize Status Conditions

| Condition | Reason | Meaning |
|-----------|--------|---------|
| PodResizePending | InProgress | Kubelet accepted resize, waiting for runtime |
| PodResizePending | Deferred | Node has insufficient resources, waiting |
| PodResizePending | Infeasible | Resize violates limits or node capacity |
| PodResizeInProgress | - | Container runtime is applying the change |
| (no condition) | - | Resize complete |

```bash
# Watch resize progress
kubectl get pod api-server-abc12 -n production -w -o \
  custom-columns=NAME:.metadata.name,CPU_REQ:.spec.containers[0].resources.requests.cpu,CPU_STATUS:.status.containerStatuses[0].resources.requests.cpu,RESIZE:.status.conditions[0].type
```

### Resize via Strategic Merge Patch

```bash
# Increase CPU limit for a specific container
kubectl patch pod api-server-abc12 \
  -n production \
  --subresource resize \
  --type strategic \
  -p '{
    "spec": {
      "containers": [{
        "name": "api",
        "resources": {
          "requests": {"cpu": "2000m", "memory": "2Gi"},
          "limits": {"cpu": "4000m", "memory": "4Gi"}
        }
      }]
    }
  }'
```

## Section 4: VPA with In-Place Updates

The Vertical Pod Autoscaler can use in-place resize instead of pod eviction when the feature is available.

### VPA Update Modes

| Mode | Behavior | In-Place Support |
|------|----------|-----------------|
| Off | Recommendations only, no automatic updates | N/A |
| Initial | Apply at pod creation only | N/A |
| Recreate | Evict and recreate to apply recommendations | No |
| Auto | Use in-place if available, else recreate | Yes (1.33+) |
| InPlaceOrRecreate | Prefer in-place, fall back to recreate | Yes |

### VPA Configuration for In-Place Resize

```yaml
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
    updateMode: InPlaceOrRecreate    # Prefer in-place
    minReplicas: 2                   # Don't evict if below this count
  resourcePolicy:
    containerPolicies:
      - containerName: api
        minAllowed:
          cpu: 250m
          memory: 256Mi
        maxAllowed:
          cpu: 8000m
          memory: 8Gi
        controlledResources: ["cpu", "memory"]
        controlledValues: RequestsAndLimits
        # In-place resize policy per container
        # Matches container's resizePolicy
      - containerName: sidecar
        minAllowed:
          cpu: 50m
          memory: 32Mi
        maxAllowed:
          cpu: 1000m
          memory: 512Mi
        controlledResources: ["cpu"]
        controlledValues: RequestsOnly
```

### VPA Admission Controller and In-Place

When VPA runs with `updateMode: InPlaceOrRecreate`, the VPA admission webhook applies resource recommendations to new pods at admission time. For running pods, the VPA updater watches VPA recommendations and applies them via the pod resize subresource:

```bash
# Check VPA recommendations
kubectl get vpa api-server-vpa -n production -o json | \
  jq '.status.recommendation.containerRecommendations'

# Output:
# [
#   {
#     "containerName": "api",
#     "lowerBound": {"cpu": "319m", "memory": "499Mi"},
#     "target": {"cpu": "587m", "memory": "768Mi"},
#     "uncappedTarget": {"cpu": "587m", "memory": "768Mi"},
#     "upperBound": {"cpu": "2058m", "memory": "2Gi"}
#   }
# ]
```

### VPA Component Installation

```bash
# Install VPA with in-place support
git clone https://github.com/kubernetes/autoscaler.git
cd autoscaler/vertical-pod-autoscaler

# Install CRDs and components
./hack/vpa-up.sh

# Or using Helm
helm repo add fairwinds-stable https://charts.fairwinds.com/stable
helm install vpa fairwinds-stable/vpa \
  -n kube-system \
  -f vpa-values.yaml
```

```yaml
# vpa-values.yaml
updater:
  enabled: true
  extraArgs:
    - --in-place-threshold=0.1   # resize if recommendation differs by >10%
    - --eviction-rate-limit=1.0  # evictions per second if in-place fails

admissionController:
  enabled: true
  mutatingWebhookEnabled: true

recommender:
  enabled: true
  extraArgs:
    - --recommendation-margin-fraction=0.15
    - --pod-recommendation-min-cpu-millicores=25
    - --pod-recommendation-min-memory-mb=250
```

## Section 5: Resource Quota and LimitRange Interaction

In-place resize must respect namespace ResourceQuota and LimitRange objects.

### ResourceQuota Behavior During Resize

```yaml
# Namespace quota affects resize
apiVersion: v1
kind: ResourceQuota
metadata:
  name: production-quota
  namespace: production
spec:
  hard:
    requests.cpu: "100"
    requests.memory: 200Gi
    limits.cpu: "200"
    limits.memory: 400Gi
```

When resizing up, Kubernetes checks the quota before applying:
1. Calculate delta: (new requests) - (current requests)
2. Check if quota has enough headroom
3. If yes: proceed with resize
4. If no: resize deferred with reason `QuotaInsufficient`

```bash
# Check quota usage
kubectl describe resourcequota production-quota -n production

# If resize is blocked by quota, check:
kubectl get events -n production | grep "quota"
```

### LimitRange Enforcement

```yaml
# LimitRange restricts resize bounds
apiVersion: v1
kind: LimitRange
metadata:
  name: container-limits
  namespace: production
spec:
  limits:
    - type: Container
      min:
        cpu: 50m
        memory: 64Mi
      max:
        cpu: 8000m
        memory: 16Gi
      default:
        cpu: 500m
        memory: 512Mi
      defaultRequest:
        cpu: 100m
        memory: 128Mi
```

A resize request that would violate LimitRange is rejected immediately with `Infeasible`.

## Section 6: Resize Constraints and Edge Cases

### CPU vs Memory Behavior

```bash
# CPU resize is transparent to running processes
# The kernel adjusts the cpu.shares and cpu.cfs_quota_us cgroup settings
# Running processes continue without interruption

# Memory resize up: container can use more memory immediately
# Memory resize down with RestartContainer: container restarts
# Memory resize down with NotRequired: OOM risk if usage exceeds new limit

# Check actual vs requested resources after resize
kubectl get pod api-server-abc12 -n production -o json | jq '
{
  spec_requests: .spec.containers[0].resources.requests,
  spec_limits: .spec.containers[0].resources.limits,
  status_requests: .status.containerStatuses[0].resources.requests,
  status_limits: .status.containerStatuses[0].resources.limits
}'
```

### Init Container Resize

Init containers do not support in-place resize because they complete before the pod reaches Running state. Resource changes to init containers always require pod recreation.

### Ephemeral Container Resize

Ephemeral containers (used for debugging) do not support resize - they are designed to be temporary and their resources are fixed at creation.

### Multiple Container Resize

When a pod has multiple containers, each container can be resized independently or simultaneously:

```bash
# Resize two containers in one operation
kubectl patch pod api-server-abc12 \
  -n production \
  --subresource resize \
  --type merge \
  -p '{
    "spec": {
      "containers": [
        {
          "name": "api",
          "resources": {
            "requests": {"cpu": "2000m"},
            "limits": {"cpu": "4000m"}
          }
        },
        {
          "name": "sidecar",
          "resources": {
            "requests": {"cpu": "200m"},
            "limits": {"cpu": "500m"}
          }
        }
      ]
    }
  }'
```

## Section 7: Operator Patterns for In-Place Resize

### Custom Operator Triggering Resize

```go
package controllers

import (
    "context"
    "encoding/json"
    "fmt"

    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/api/resource"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/types"
    "k8s.io/client-go/kubernetes"
)

type ResourceRecommendation struct {
    ContainerName string
    CPU           resource.Quantity
    Memory        resource.Quantity
}

// ResizePodInPlace applies resource recommendations to a running pod
// without restart (for CPU) or with restart (for memory, depending on policy).
func ResizePodInPlace(
    ctx context.Context,
    client kubernetes.Interface,
    namespace, podName string,
    recommendations []ResourceRecommendation,
) error {
    // Build the patch body matching the resize subresource format
    type resourceRequirements struct {
        Requests corev1.ResourceList `json:"requests"`
        Limits   corev1.ResourceList `json:"limits"`
    }
    type containerSpec struct {
        Name      string               `json:"name"`
        Resources resourceRequirements `json:"resources"`
    }
    type podSpec struct {
        Containers []containerSpec `json:"containers"`
    }
    type patchBody struct {
        Spec podSpec `json:"spec"`
    }

    containers := make([]containerSpec, 0, len(recommendations))
    for _, rec := range recommendations {
        containers = append(containers, containerSpec{
            Name: rec.ContainerName,
            Resources: resourceRequirements{
                Requests: corev1.ResourceList{
                    corev1.ResourceCPU:    rec.CPU,
                    corev1.ResourceMemory: rec.Memory,
                },
                Limits: corev1.ResourceList{
                    corev1.ResourceCPU:    scaleQuantity(rec.CPU, 2),
                    corev1.ResourceMemory: scaleQuantity(rec.Memory, 2),
                },
            },
        })
    }

    patch := patchBody{Spec: podSpec{Containers: containers}}
    patchBytes, err := json.Marshal(patch)
    if err != nil {
        return fmt.Errorf("marshaling resize patch: %w", err)
    }

    _, err = client.CoreV1().Pods(namespace).Patch(
        ctx,
        podName,
        types.MergePatchType,
        patchBytes,
        metav1.PatchOptions{},
        "resize",  // subresource
    )
    return err
}

func scaleQuantity(q resource.Quantity, factor int64) resource.Quantity {
    millis := q.MilliValue()
    return *resource.NewMilliQuantity(millis*factor, q.Format)
}
```

### Resize Status Watcher

```go
// WatchResizeCompletion polls pod status until resize is applied or times out
func WatchResizeCompletion(
    ctx context.Context,
    client kubernetes.Interface,
    namespace, podName string,
    expectedCPU resource.Quantity,
) error {
    return wait.PollUntilContextTimeout(ctx, 2*time.Second, 5*time.Minute, true,
        func(ctx context.Context) (bool, error) {
            pod, err := client.CoreV1().Pods(namespace).Get(ctx, podName, metav1.GetOptions{})
            if err != nil {
                return false, err
            }

            // Check if any resize conditions are present
            for _, cond := range pod.Status.Conditions {
                if cond.Type == "PodResizePending" || cond.Type == "PodResizeInProgress" {
                    // Resize still in progress
                    return false, nil
                }
            }

            // Check actual allocated resources match expected
            for _, cs := range pod.Status.ContainerStatuses {
                if cs.Resources != nil && cs.Resources.Requests != nil {
                    allocated := cs.Resources.Requests[corev1.ResourceCPU]
                    if allocated.Cmp(expectedCPU) == 0 {
                        return true, nil
                    }
                }
            }

            return false, nil
        },
    )
}
```

## Section 8: Monitoring and Observability

### Metrics for In-Place Resize

```yaml
# Prometheus recording rules for resize monitoring
groups:
  - name: pod-resize
    rules:
      # Track pods where allocated != spec'd resources (resize in progress)
      - record: kubernetes:pod_resize_pending
        expr: |
          kube_pod_container_resource_requests{resource="cpu"} !=
          kube_pod_container_resource_limits{resource="cpu"}

      # VPA recommendation vs actual CPU
      - record: vpa:recommendation_vs_actual_cpu
        expr: |
          kube_verticalpodautoscaler_spec_resourcepolicy_container_policies_minallowed{resource="cpu"}
          / on (namespace, pod) group_right()
          kube_pod_container_resource_requests{resource="cpu"}
```

```yaml
# Alerting rules
groups:
  - name: in-place-resize-alerts
    rules:
      - alert: PodResizeStuck
        expr: |
          kube_pod_status_condition{condition="PodResizePending", status="true"} == 1
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Pod {{ $labels.namespace }}/{{ $labels.pod }} has pending resize for 10+ minutes"
          description: "Check node capacity and quota constraints"

      - alert: VPARecommendationDrifting
        expr: |
          abs(
            kube_verticalpodautoscaler_status_recommendation_containerrecommendations_target{resource="cpu"} -
            kube_pod_container_resource_requests{resource="cpu"}
          ) / kube_pod_container_resource_requests{resource="cpu"} > 0.5
        for: 30m
        labels:
          severity: warning
        annotations:
          summary: "VPA recommendation differs >50% from actual for {{ $labels.namespace }}/{{ $labels.container }}"
```

## Section 9: Production Patterns

### Safe Resize for Stateful Applications

```yaml
# StatefulSet with resize policy for database workload
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres-primary
  namespace: data
spec:
  serviceName: postgres
  replicas: 1
  selector:
    matchLabels:
      app: postgres
      role: primary
  template:
    spec:
      containers:
        - name: postgres
          image: postgres:16
          resources:
            requests:
              cpu: 2000m
              memory: 4Gi
            limits:
              cpu: 8000m
              memory: 16Gi
          resizePolicy:
            # CPU can be changed transparently
            - resourceName: cpu
              restartPolicy: NotRequired
            # Memory changes require restart (PostgreSQL uses shared_buffers based on memory)
            - resourceName: memory
              restartPolicy: RestartContainer
          env:
            - name: POSTGRES_SHARED_BUFFERS
              value: "1GB"  # Set based on expected memory allocation
```

### Resize Controller for Development Environments

```yaml
# Scale down development namespaces at night
apiVersion: batch/v1
kind: CronJob
metadata:
  name: dev-scale-down
  namespace: platform
spec:
  schedule: "0 20 * * 1-5"  # 8 PM weekdays
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: resize-controller
          containers:
            - name: resizer
              image: bitnami/kubectl:1.29
              command:
                - /bin/bash
                - -c
                - |
                  for pod in $(kubectl get pods -n development -l resizable=true -o name); do
                    kubectl patch "$pod" \
                      -n development \
                      --subresource resize \
                      --type merge \
                      -p '{"spec":{"containers":[{"name":"app","resources":{"requests":{"cpu":"100m","memory":"128Mi"},"limits":{"cpu":"200m","memory":"256Mi"}}}]}}'
                  done
          restartPolicy: OnFailure
```

In-place pod resource resize fundamentally changes the operational model for Kubernetes resource management. The combination of VPA recommendations with in-place application enables truly automated right-sizing of resources without the disruptive restart cycles that made VPA impractical for stateful or latency-sensitive workloads. As this feature stabilizes across distributions, it should become a standard component of every production cluster's autoscaling strategy.
