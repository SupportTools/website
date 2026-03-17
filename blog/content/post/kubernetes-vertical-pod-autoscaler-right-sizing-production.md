---
title: "Kubernetes Vertical Pod Autoscaler: Right-Sizing Workloads in Production"
date: 2030-11-27T00:00:00-05:00
draft: false
tags: ["Kubernetes", "VPA", "Autoscaling", "Resource Management", "FinOps", "HPA", "Production"]
categories: ["Kubernetes", "Resource Management"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Kubernetes Vertical Pod Autoscaler (VPA) for production workloads: VPA modes, recommendation engine tuning, HPA interaction patterns, LimitRange constraints, and migrating from manual resource sizing."
more_link: "yes"
url: "/kubernetes-vertical-pod-autoscaler-right-sizing-production/"
---

Kubernetes clusters routinely waste 40–70% of requested CPU and memory because teams set resource requests based on peak estimates rather than observed usage. Vertical Pod Autoscaler (VPA) closes that gap by continuously monitoring actual resource consumption and adjusting requests and limits automatically. This guide covers the full VPA architecture, all four operating modes, recommendation engine tuning, safe HPA coexistence, LimitRange constraint interactions, and a migration strategy for clusters running manual resource sizing today.

<!--more-->

# Kubernetes Vertical Pod Autoscaler: Right-Sizing Workloads in Production

## Why Resource Sizing Matters More Than You Think

Every pod in a Kubernetes cluster carries two resource dimensions: requests (used for scheduling decisions) and limits (enforced via cgroup throttling). Misconfigured requests create a cascade of problems:

- **Over-provisioned requests** waste cluster capacity. A node with 16 CPU cores allocated to pods that actually use 4 cores can't schedule new workloads even though 12 cores sit idle.
- **Under-provisioned requests** mislead the scheduler. Pods end up on nodes that can't sustain their actual usage, causing CPU throttling and OOM kills.
- **Static limits** set once during initial deployment never adapt to workload growth, traffic spikes, or JVM heap expansion.

VPA addresses all three problems through continuous observation and automated recommendation application.

## VPA Architecture: Three Controllers Working Together

VPA consists of three independent controllers deployed into a dedicated namespace:

```
┌─────────────────────────────────────────────────────────────┐
│                    Kubernetes API Server                     │
└────────────┬──────────────────┬──────────────────┬──────────┘
             │                  │                  │
    ┌────────▼────────┐ ┌───────▼───────┐ ┌───────▼────────┐
    │   Recommender   │ │    Updater    │ │   Admission    │
    │                 │ │               │ │   Controller   │
    │ Reads metrics   │ │ Evicts pods   │ │ Patches pod    │
    │ Writes VPA      │ │ when recs     │ │ specs at       │
    │ status.recs     │ │ diverge       │ │ admission time │
    └────────┬────────┘ └───────┬───────┘ └───────┬────────┘
             │                  │                  │
    ┌────────▼──────────────────▼──────────────────▼────────┐
    │              Metrics Server / Prometheus               │
    └────────────────────────────────────────────────────────┘
```

### Recommender

The Recommender scrapes the Kubernetes Metrics API (and optionally a Prometheus-compatible endpoint) to build a histogram of CPU and memory usage per container over the configured history window (default: 8 days). It applies a confidence interval — by default the 90th percentile for CPU and 95th for memory — to produce recommendations that handle normal variance without being dominated by brief spikes.

The Recommender writes recommendations back to the VPA object's `.status.recommendation` field. It does not evict pods or modify running workloads.

### Updater

The Updater watches VPA objects with `updateMode: Recreate` or `Auto` and periodically compares running pod requests against current recommendations. When the gap exceeds the configured eviction tolerance (default: ±20%), the Updater evicts the pod. The pod then gets rescheduled with updated requests injected by the Admission Controller.

The Updater respects PodDisruptionBudgets. If evicting a pod would violate a PDB, the Updater skips that pod and retries later.

### Admission Controller

The Admission Controller is a MutatingAdmissionWebhook that intercepts pod creation requests. When a new pod matches a VPA selector, the webhook patches the pod spec to insert the recommended resource requests and limits before the pod is scheduled.

This is the only component that requires continuous availability — if the webhook is down and `failurePolicy: Ignore` is not set, pod creation will fail.

## Installing VPA

VPA is not bundled with Kubernetes. The recommended installation path is the official repo:

```bash
# Clone the autoscaler repository
git clone https://github.com/kubernetes/autoscaler.git
cd autoscaler/vertical-pod-autoscaler

# Deploy VPA CRDs and controllers
./hack/vpa-up.sh

# Verify deployment
kubectl get pods -n kube-system | grep vpa
# vpa-admission-controller-xxxx   1/1   Running   0   2m
# vpa-recommender-xxxx            1/1   Running   0   2m
# vpa-updater-xxxx                1/1   Running   0   2m

# Check CRDs
kubectl get crd | grep verticalpodautoscaler
# verticalpodautoscalercheckpoints.autoscaling.k8s.io
# verticalpodautoscalers.autoscaling.k8s.io
```

For production clusters, deploy VPA with high-availability admission controller replicas:

```yaml
# vpa-admission-controller-ha.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vpa-admission-controller
  namespace: kube-system
spec:
  replicas: 3
  selector:
    matchLabels:
      app: vpa-admission-controller
  template:
    metadata:
      labels:
        app: vpa-admission-controller
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchExpressions:
                  - key: app
                    operator: In
                    values: ["vpa-admission-controller"]
              topologyKey: kubernetes.io/hostname
      containers:
        - name: admission-controller
          image: registry.k8s.io/autoscaling/vpa-admission-controller:1.0.0
          resources:
            requests:
              cpu: 50m
              memory: 200Mi
            limits:
              cpu: 200m
              memory: 500Mi
```

## The Four VPA Modes

VPA's `updatePolicy.updateMode` field controls how aggressively recommendations are applied.

### Mode: Off (Recommendation-Only)

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: webapp-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: webapp
  updatePolicy:
    updateMode: "Off"
  resourcePolicy:
    containerPolicies:
      - containerName: "*"
        minAllowed:
          cpu: 10m
          memory: 50Mi
        maxAllowed:
          cpu: 4
          memory: 8Gi
```

`Off` mode is ideal for:
- New workloads where you want to observe before committing
- Stateful applications where eviction is disruptive
- Any workload where you want human review before resource changes

Inspect recommendations:

```bash
kubectl describe vpa webapp-vpa -n production
# Status:
#   Recommendation:
#     Container Recommendations:
#       Container Name: webapp
#       Lower Bound:
#         Cpu:     25m
#         Memory:  128Mi
#       Target:
#         Cpu:     100m
#         Memory:  256Mi
#       Uncapped Target:
#         Cpu:     100m
#         Memory:  256Mi
#       Upper Bound:
#         Cpu:     500m
#         Memory:  1Gi
```

The four recommendation values have distinct meanings:

| Field | Meaning |
|-------|---------|
| `lowerBound` | Conservative minimum — below this, the pod will likely be throttled or OOM-killed |
| `target` | Recommended value at the configured percentile |
| `uncappedTarget` | Target ignoring `minAllowed`/`maxAllowed` constraints |
| `upperBound` | Upper bound — above this is considered wasteful |

### Mode: Initial (Apply at Pod Creation Only)

```yaml
spec:
  updatePolicy:
    updateMode: "Initial"
```

`Initial` mode applies recommendations via the Admission Controller when pods are created or recreated, but the Updater never evicts running pods. Use this for workloads where you accept natural pod turnover (deployments during CI/CD, regular restarts) but don't want VPA-triggered evictions mid-flight.

This is the safest mode for stateful workloads with long startup times — database pods, JVM services with 2–5 minute warm-up periods.

### Mode: Recreate (Evict When Resources Diverge)

```yaml
spec:
  updatePolicy:
    updateMode: "Recreate"
```

`Recreate` mode enables the Updater to evict pods when their current requests deviate from the recommendation by more than the eviction tolerance. The Admission Controller then applies updated values when the replacement pod is created.

Important constraints:
- The Updater respects PodDisruptionBudgets — always define PDBs for production workloads
- Eviction rate is limited by `--evict-after-oom-threshold` and `--eviction-rate-limit` flags on the Updater
- Single-replica deployments will experience brief downtime during eviction

### Mode: Auto (Currently Equivalent to Recreate)

```yaml
spec:
  updatePolicy:
    updateMode: "Auto"
```

`Auto` is reserved for future in-place pod resource updates (KEP-1287), which will allow resource changes without pod eviction. As of Kubernetes 1.29 with VPA 1.0, `Auto` behavior is identical to `Recreate`. When in-place updates stabilize in a future release, `Auto` will use them preferentially.

## Resource Policy: Controlling the Recommendation Envelope

The `resourcePolicy` section gives you fine-grained control over what VPA recommends per container.

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
    updateMode: "Recreate"
  resourcePolicy:
    containerPolicies:
      # Main application container
      - containerName: api-server
        mode: Auto
        minAllowed:
          cpu: 100m
          memory: 256Mi
        maxAllowed:
          cpu: 8
          memory: 16Gi
        controlledResources:
          - cpu
          - memory
        controlledValues: RequestsAndLimits

      # Sidecar — only control memory, not CPU
      - containerName: envoy-proxy
        mode: Auto
        minAllowed:
          memory: 64Mi
        maxAllowed:
          memory: 512Mi
        controlledResources:
          - memory
        controlledValues: RequestsOnly

      # Init containers — leave them alone
      - containerName: db-migration
        mode: "Off"
```

### controlledValues Options

| Value | Behavior |
|-------|----------|
| `RequestsAndLimits` | Adjusts both requests and limits, preserving the request-to-limit ratio |
| `RequestsOnly` | Only adjusts requests; limits remain at their original values |

`RequestsOnly` is essential for workloads where you want burst capacity preserved — a container with `memory: requests: 256Mi, limits: 1Gi` running with `RequestsOnly` will get its request adjusted but keep the 1Gi limit ceiling.

## Interaction with Horizontal Pod Autoscaler

Running VPA and HPA on the same deployment using the same metric (CPU or memory) creates a feedback loop: VPA raises CPU requests, HPA sees lower utilization percentage (same usage / higher request = lower %), scales down, VPA sees less data, adjusts differently. This cycle destabilizes both controllers.

### Safe HPA + VPA Coexistence Pattern

The correct pattern is to run HPA on custom metrics or throughput-based metrics, and let VPA manage CPU/memory requests:

```yaml
# HPA scales on requests-per-second (custom metric), NOT CPU
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api-server-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-server
  minReplicas: 3
  maxReplicas: 50
  metrics:
    - type: Pods
      pods:
        metric:
          name: http_requests_per_second
        target:
          type: AverageValue
          averageValue: "1000"
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
        - type: Percent
          value: 10
          periodSeconds: 60
    scaleUp:
      stabilizationWindowSeconds: 60
      policies:
        - type: Percent
          value: 50
          periodSeconds: 30
---
# VPA manages CPU and memory requests, not replica count
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
    updateMode: "Recreate"
  resourcePolicy:
    containerPolicies:
      - containerName: api-server
        minAllowed:
          cpu: 100m
          memory: 256Mi
        maxAllowed:
          cpu: 4
          memory: 8Gi
        controlledResources:
          - cpu
          - memory
```

If you must use CPU-based HPA alongside VPA, disable VPA's CPU control:

```yaml
  resourcePolicy:
    containerPolicies:
      - containerName: "*"
        controlledResources:
          - memory     # VPA manages memory only
        # CPU is managed by HPA — VPA leaves it alone
```

## LimitRange Integration

LimitRange objects in a namespace define default and maximum resource values. VPA recommendations interact with LimitRange in a specific order:

1. VPA Admission Controller calculates the recommended value
2. LimitRange defaults are applied if no value is set
3. LimitRange min/max are enforced — VPA cannot set values outside LimitRange bounds
4. If VPA recommendation exceeds LimitRange max, the pod uses the LimitRange max

```yaml
# Define reasonable namespace-level bounds
apiVersion: v1
kind: LimitRange
metadata:
  name: production-limits
  namespace: production
spec:
  limits:
    - type: Container
      default:
        cpu: 500m
        memory: 512Mi
      defaultRequest:
        cpu: 100m
        memory: 128Mi
      min:
        cpu: 10m
        memory: 32Mi
      max:
        cpu: 8
        memory: 32Gi
    - type: Pod
      max:
        cpu: 16
        memory: 64Gi
```

When VPA and LimitRange coexist, the effective recommendation is:

```
effective_value = max(vpa_min_allowed, min(vpa_recommendation, vpa_max_allowed, limitrange_max))
```

A common mistake is setting `vpa.maxAllowed` higher than `limitrange.max`. VPA will clamp to LimitRange max and log a warning — verify via:

```bash
kubectl get events -n production --field-selector reason=VPAConfigError
```

## Tuning the Recommender

The Recommender's behavior is configurable via command-line flags on its deployment.

```yaml
# vpa-recommender-tuned.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vpa-recommender
  namespace: kube-system
spec:
  template:
    spec:
      containers:
        - name: recommender
          image: registry.k8s.io/autoscaling/vpa-recommender:1.0.0
          command:
            - /recommender
            # How long to keep historical data (default 8 days)
            - --history-length=336h
            # CPU recommendation percentile (default 0.9 = 90th percentile)
            - --target-cpu-percentile=0.9
            # Memory recommendation percentile (default 0.95 = 95th percentile)
            - --recommendation-margin-fraction=0.15
            # Minimum samples before making a recommendation
            - --pod-recommendation-min-cpu-millicores=15
            - --pod-recommendation-min-memory-mb=10
            # How often to recompute recommendations
            - --recommender-interval=1m
            # Use Prometheus for metrics instead of Metrics API
            - --prometheus-address=http://prometheus-operated.monitoring:9090
            - --prometheus-cadvisor-job-name=cadvisor
            # Memory safety margin — multiply recommendation by this factor
            - --oom-bump-up-ratio=1.2
            # After OOM, how long to wait before reducing recommendation
            - --oom-min-bump-up-interval=10m
```

### Workload-Specific Tuning Guidelines

**Batch workloads** with predictable resource spikes:
- Increase `--history-length` to capture multiple batch cycles
- Use higher percentiles (`--target-cpu-percentile=0.95`) to handle peak load

**JVM workloads** (Java, Scala, Kotlin):
- Memory usage grows over time due to JVM heap expansion — shorter history underestimates
- Set generous `minAllowed.memory` (at least 512Mi for most JVM apps)
- Use `controlledValues: RequestsOnly` for memory to preserve a fixed limit ceiling

**Stateless microservices** with burst traffic:
- Standard 8-day history captures weekly traffic patterns including weekday/weekend variance
- 90th percentile CPU recommendation is appropriate for most cases

**Machine learning inference servers**:
- Memory footprint is dominated by model loading — spikes on startup are not representative
- Use `--oom-bump-up-ratio=1.5` to provide safety margin above observed OOMs

## Memory Limit Recommendations Deep Dive

VPA's handling of memory limits deserves special attention because OOM kills have different consequences than CPU throttling.

CPU throttling: the container runs slowly but continues running.
OOM kill: the container is terminated immediately and restarted.

For workloads where OOM restarts are unacceptable:

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: redis-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: redis
  updatePolicy:
    updateMode: "Initial"   # No eviction — apply only on pod creation
  resourcePolicy:
    containerPolicies:
      - containerName: redis
        minAllowed:
          memory: 512Mi     # Redis needs baseline memory for data structures
        maxAllowed:
          memory: 16Gi
        controlledResources:
          - memory
        controlledValues: RequestsAndLimits
```

For workloads that can tolerate OOM (ephemeral batch jobs):

```yaml
  resourcePolicy:
    containerPolicies:
      - containerName: batch-processor
        controlledValues: RequestsOnly   # Let limits stay high for burst
        maxAllowed:
          memory: 4Gi
```

## VPA Checkpoint: Preserving History Across Restarts

VPA stores recommendation history in `VerticalPodAutoscalerCheckpoint` objects. These persist Recommender state across restarts and allow recommendations to resume without waiting for the full history window to repopulate.

```bash
# List checkpoints for a namespace
kubectl get verticalpodautoscalercheckpoints -n production

# Inspect a checkpoint
kubectl get vpa-checkpoint webapp-vpa-webapp -n production -o yaml
```

In clusters with many VPA objects, checkpoint storage can consume significant etcd space. Monitor checkpoint count:

```bash
kubectl get verticalpodautoscalercheckpoints --all-namespaces | wc -l
```

If you delete a VPA object, its checkpoints are automatically garbage collected.

## Building a VPA Recommendation Reporter in Go

The following tool queries all VPA objects across namespaces and produces a structured report comparing current requests against VPA recommendations:

```go
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"text/tabwriter"
	"time"

	vpa "k8s.io/autoscaler/vertical-pod-autoscaler/pkg/apis/autoscaling.k8s.io/v1"
	vpaclient "k8s.io/autoscaler/vertical-pod-autoscaler/pkg/client/clientset/versioned"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/clientcmd"
	"k8s.io/apimachinery/pkg/api/resource"
)

type ContainerDiff struct {
	Namespace     string
	Workload      string
	Container     string
	CurrentCPU    string
	RecommCPU     string
	CPUDelta      float64   // percentage change
	CurrentMem    string
	RecommMem     string
	MemDelta      float64
	Saving        bool      // true if recommendation would reduce waste
}

type VPAReport struct {
	GeneratedAt time.Time
	Diffs       []ContainerDiff
	TotalSaving string
}

func main() {
	kubeconfig := os.Getenv("KUBECONFIG")
	if kubeconfig == "" {
		kubeconfig = os.Getenv("HOME") + "/.kube/config"
	}

	config, err := clientcmd.BuildConfigFromFlags("", kubeconfig)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error building kubeconfig: %v\n", err)
		os.Exit(1)
	}

	k8s, err := kubernetes.NewForConfig(config)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error creating Kubernetes client: %v\n", err)
		os.Exit(1)
	}

	vpaClient, err := vpaclient.NewForConfig(config)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error creating VPA client: %v\n", err)
		os.Exit(1)
	}

	report, err := generateReport(context.Background(), k8s, vpaClient)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error generating report: %v\n", err)
		os.Exit(1)
	}

	outputFormat := "table"
	if len(os.Args) > 1 {
		outputFormat = os.Args[1]
	}

	switch outputFormat {
	case "json":
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		enc.Encode(report)
	default:
		printTable(report)
	}
}

func generateReport(ctx context.Context, k8s kubernetes.Interface, vpaClient vpaclient.Interface) (*VPAReport, error) {
	namespaces, err := k8s.CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("listing namespaces: %w", err)
	}

	report := &VPAReport{
		GeneratedAt: time.Now(),
	}

	for _, ns := range namespaces.Items {
		vpaList, err := vpaClient.AutoscalingV1().VerticalPodAutoscalers(ns.Name).List(ctx, metav1.ListOptions{})
		if err != nil {
			continue
		}

		for _, vpaObj := range vpaList.Items {
			diffs, err := processVPA(ctx, k8s, &vpaObj)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Warning: processing VPA %s/%s: %v\n", ns.Name, vpaObj.Name, err)
				continue
			}
			report.Diffs = append(report.Diffs, diffs...)
		}
	}

	// Sort by memory delta (biggest waste first)
	sort.Slice(report.Diffs, func(i, j int) bool {
		return report.Diffs[i].MemDelta > report.Diffs[j].MemDelta
	})

	return report, nil
}

func processVPA(ctx context.Context, k8s kubernetes.Interface, vpaObj *vpa.VerticalPodAutoscaler) ([]ContainerDiff, error) {
	if vpaObj.Status.Recommendation == nil {
		return nil, nil // No recommendations yet
	}

	// Get the target workload's pods to read current requests
	selector, err := getWorkloadSelector(ctx, k8s, vpaObj)
	if err != nil {
		return nil, err
	}

	pods, err := k8s.CoreV1().Pods(vpaObj.Namespace).List(ctx, metav1.ListOptions{
		LabelSelector: selector,
		Limit:         1,
	})
	if err != nil || len(pods.Items) == 0 {
		return nil, nil
	}

	pod := pods.Items[0]
	var diffs []ContainerDiff

	containerRequests := make(map[string]corev1.ResourceRequirements)
	for _, c := range pod.Spec.Containers {
		containerRequests[c.Name] = c.Resources
	}

	for _, rec := range vpaObj.Status.Recommendation.ContainerRecommendations {
		current, ok := containerRequests[rec.ContainerName]
		if !ok {
			continue
		}

		diff := ContainerDiff{
			Namespace: vpaObj.Namespace,
			Workload:  vpaObj.Spec.TargetRef.Name,
			Container: rec.ContainerName,
		}

		// CPU comparison
		currentCPU := current.Requests.Cpu()
		if currentCPU != nil {
			diff.CurrentCPU = currentCPU.String()
		}
		if recCPU, ok := rec.Target[corev1.ResourceCPU]; ok {
			diff.RecommCPU = recCPU.String()
			if currentCPU != nil && currentCPU.MilliValue() > 0 {
				diff.CPUDelta = float64(recCPU.MilliValue()-currentCPU.MilliValue()) / float64(currentCPU.MilliValue()) * 100
			}
		}

		// Memory comparison
		currentMem := current.Requests.Memory()
		if currentMem != nil {
			diff.CurrentMem = currentMem.String()
		}
		if recMem, ok := rec.Target[corev1.ResourceMemory]; ok {
			diff.RecommMem = recMem.String()
			if currentMem != nil && currentMem.Value() > 0 {
				diff.MemDelta = float64(recMem.Value()-currentMem.Value()) / float64(currentMem.Value()) * 100
			}
		}

		// Mark as saving if recommendation reduces waste by more than 20%
		diff.Saving = diff.CPUDelta < -20 || diff.MemDelta < -20

		diffs = append(diffs, diff)
	}

	return diffs, nil
}

func getWorkloadSelector(ctx context.Context, k8s kubernetes.Interface, vpaObj *vpa.VerticalPodAutoscaler) (string, error) {
	ref := vpaObj.Spec.TargetRef
	switch ref.Kind {
	case "Deployment":
		d, err := k8s.AppsV1().Deployments(vpaObj.Namespace).Get(ctx, ref.Name, metav1.GetOptions{})
		if err != nil {
			return "", err
		}
		return metav1.FormatLabelSelector(d.Spec.Selector), nil
	case "StatefulSet":
		ss, err := k8s.AppsV1().StatefulSets(vpaObj.Namespace).Get(ctx, ref.Name, metav1.GetOptions{})
		if err != nil {
			return "", err
		}
		return metav1.FormatLabelSelector(ss.Spec.Selector), nil
	default:
		return "", fmt.Errorf("unsupported target kind: %s", ref.Kind)
	}
}

func printTable(report *VPAReport) {
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintf(w, "Generated: %s\n\n", report.GeneratedAt.Format(time.RFC3339))
	fmt.Fprintln(w, "NAMESPACE\tWORKLOAD\tCONTAINER\tCUR_CPU\tREC_CPU\tCPU_DELTA\tCUR_MEM\tREC_MEM\tMEM_DELTA\tSAVING")
	fmt.Fprintln(w, "---------\t--------\t---------\t-------\t-------\t---------\t-------\t-------\t---------\t------")

	for _, d := range report.Diffs {
		saving := ""
		if d.Saving {
			saving = "YES"
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%+.1f%%\t%s\t%s\t%+.1f%%\t%s\n",
			d.Namespace, d.Workload, d.Container,
			d.CurrentCPU, d.RecommCPU, d.CPUDelta,
			d.CurrentMem, d.RecommMem, d.MemDelta,
			saving,
		)
	}
	w.Flush()
}

// Keep the resource import used
var _ = resource.Quantity{}
```

Run the reporter:

```bash
go run ./vpa-reporter.go table
go run ./vpa-reporter.go json | jq '.Diffs[] | select(.Saving == true)'
```

## Automated VPA Recommendation Applier

For workloads in `Off` mode where you want periodic bulk updates to Deployment manifests (GitOps-style), this script reads VPA recommendations and patches the Deployment directly:

```bash
#!/usr/bin/env bash
# apply-vpa-recommendations.sh
# Applies VPA recommendations to Deployment resource requests without evictions.
# Requires: kubectl, jq

set -euo pipefail

NAMESPACE="${1:-production}"
DRY_RUN="${DRY_RUN:-true}"
THRESHOLD_PCT="${THRESHOLD_PCT:-25}"  # Only apply if delta exceeds 25%

echo "=== VPA Recommendation Applier ==="
echo "Namespace: ${NAMESPACE}"
echo "Dry run: ${DRY_RUN}"
echo "Threshold: ${THRESHOLD_PCT}%"
echo ""

# Get all VPA objects in namespace
vpas=$(kubectl get vpa -n "${NAMESPACE}" -o json | jq -r '.items[].metadata.name')

for vpa_name in ${vpas}; do
  echo "--- Processing VPA: ${vpa_name} ---"

  # Extract target deployment name
  target=$(kubectl get vpa "${vpa_name}" -n "${NAMESPACE}" -o jsonpath='{.spec.targetRef.name}')
  target_kind=$(kubectl get vpa "${vpa_name}" -n "${NAMESPACE}" -o jsonpath='{.spec.targetRef.kind}')

  if [[ "${target_kind}" != "Deployment" ]]; then
    echo "  Skipping non-Deployment target: ${target_kind}"
    continue
  fi

  # Get VPA recommendations
  recommendations=$(kubectl get vpa "${vpa_name}" -n "${NAMESPACE}" \
    -o jsonpath='{.status.recommendation.containerRecommendations}' 2>/dev/null || echo "[]")

  if [[ "${recommendations}" == "[]" || -z "${recommendations}" ]]; then
    echo "  No recommendations available yet"
    continue
  fi

  # Process each container recommendation
  container_count=$(echo "${recommendations}" | jq '. | length')

  for i in $(seq 0 $((container_count - 1))); do
    container_name=$(echo "${recommendations}" | jq -r ".[${i}].containerName")
    rec_cpu=$(echo "${recommendations}" | jq -r ".[${i}].target.cpu // empty")
    rec_mem=$(echo "${recommendations}" | jq -r ".[${i}].target.memory // empty")

    echo "  Container: ${container_name}"

    # Get current requests
    current_cpu=$(kubectl get deployment "${target}" -n "${NAMESPACE}" \
      -o jsonpath="{.spec.template.spec.containers[?(@.name==\"${container_name}\")].resources.requests.cpu}" 2>/dev/null || echo "")
    current_mem=$(kubectl get deployment "${target}" -n "${NAMESPACE}" \
      -o jsonpath="{.spec.template.spec.containers[?(@.name==\"${container_name}\")].resources.requests.memory}" 2>/dev/null || echo "")

    echo "    Current CPU: ${current_cpu:-unset}, Recommended: ${rec_cpu:-none}"
    echo "    Current Mem: ${current_mem:-unset}, Recommended: ${rec_mem:-none}"

    # Build the patch
    patch_containers="[]"

    if [[ -n "${rec_cpu}" || -n "${rec_mem}" ]]; then
      requests="{}"
      [[ -n "${rec_cpu}" ]] && requests=$(echo "${requests}" | jq --arg c "${rec_cpu}" '. + {cpu: $c}')
      [[ -n "${rec_mem}" ]] && requests=$(echo "${requests}" | jq --arg m "${rec_mem}" '. + {memory: $m}')

      patch=$(cat <<-PATCH
[{"op":"replace","path":"/spec/template/spec/containers/0/resources/requests","value":${requests}}]
PATCH
      )

      if [[ "${DRY_RUN}" == "true" ]]; then
        echo "    [DRY RUN] Would patch ${target} container ${container_name}"
        echo "    Patch: ${patch}"
      else
        kubectl patch deployment "${target}" -n "${NAMESPACE}" \
          --type=json \
          -p "${patch}"
        echo "    Patched ${target} container ${container_name}"
      fi
    fi
  done
done

echo ""
echo "=== Done ==="
```

## Migrating from Manual Sizing to VPA

A phased migration prevents the chaos of applying all VPA recommendations simultaneously.

### Phase 1: Observation (Weeks 1–3)

Deploy VPA in `Off` mode for all workloads. No pods are modified.

```bash
#!/usr/bin/env bash
# create-vpa-off-all-deployments.sh
# Creates Off-mode VPA for every Deployment in a namespace

NAMESPACE="${1:-production}"

kubectl get deployments -n "${NAMESPACE}" -o name | while read -r deployment; do
  name="${deployment#deployment.apps/}"

  cat <<EOF | kubectl apply -f -
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: ${name}-vpa
  namespace: ${NAMESPACE}
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: ${name}
  updatePolicy:
    updateMode: "Off"
  resourcePolicy:
    containerPolicies:
      - containerName: "*"
        minAllowed:
          cpu: 10m
          memory: 32Mi
        maxAllowed:
          cpu: 8
          memory: 32Gi
EOF
  echo "Created VPA for ${name}"
done
```

### Phase 2: Selective Adoption (Weeks 4–6)

Identify workloads where VPA would save the most resources (from the reporter tool above). Apply recommendations manually to Deployments for high-waste workloads while keeping VPA in `Off` mode. This gives you a controlled rollout you can review in GitOps pull requests.

```bash
DRY_RUN=false THRESHOLD_PCT=30 ./apply-vpa-recommendations.sh production
```

### Phase 3: Initial Mode for Stable Workloads (Week 7+)

Promote stateless, well-understood workloads to `Initial` mode. VPA applies recommendations on pod restarts without active eviction:

```bash
# Upgrade specific VPAs from Off to Initial
kubectl patch vpa webapp-vpa -n production \
  --type=merge \
  -p '{"spec":{"updatePolicy":{"updateMode":"Initial"}}}'
```

### Phase 4: Recreate Mode for High-Confidence Workloads (Week 10+)

After confirming that recommendations are stable (inspect checkpoint history), enable `Recreate` for workloads where brief eviction is acceptable:

```bash
kubectl patch vpa api-server-vpa -n production \
  --type=merge \
  -p '{"spec":{"updatePolicy":{"updateMode":"Recreate"}}}'
```

Always ensure PodDisruptionBudgets are in place before enabling `Recreate`:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-server-pdb
  namespace: production
spec:
  selector:
    matchLabels:
      app: api-server
  minAvailable: "66%"   # Keep at least 2/3 of pods available during evictions
```

## Prometheus Monitoring for VPA

Deploy these recording rules and alerts to track VPA health and resource efficiency:

```yaml
# vpa-prometheus-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: vpa-rules
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
    - name: vpa.recommendations
      interval: 5m
      rules:
        # Track how much VPA recommends vs current requests (CPU)
        - record: vpa:cpu_recommendation_ratio
          expr: |
            kube_verticalpodautoscaler_status_recommendation_containerrecommendations_target{resource="cpu"}
            /
            kube_verticalpodautoscaler_spec_resourcepolicy_container_policies_minallowed{resource="cpu"}

        # Memory right-sizing efficiency
        - record: vpa:memory_waste_ratio
          expr: |
            (
              kube_pod_container_resource_requests{resource="memory"}
              - on(namespace, pod, container) kube_verticalpodautoscaler_status_recommendation_containerrecommendations_target{resource="memory"}
            ) / kube_pod_container_resource_requests{resource="memory"}

    - name: vpa.alerts
      rules:
        # Alert when VPA cannot make recommendations (insufficient data)
        - alert: VPANoRecommendations
          expr: |
            kube_verticalpodautoscaler_status_condition{condition="RecommendationProvided",status="False"} == 1
          for: 2h
          labels:
            severity: warning
          annotations:
            summary: "VPA {{ $labels.namespace }}/{{ $labels.verticalpodautoscaler }} has no recommendations"
            description: "VPA has not produced recommendations for 2 hours. Metrics may be unavailable."

        # Alert on significant memory waste (VPA recommends >40% less than current)
        - alert: VPASignificantMemoryWaste
          expr: |
            vpa:memory_waste_ratio > 0.4
          for: 24h
          labels:
            severity: info
          annotations:
            summary: "Container {{ $labels.container }} in {{ $labels.namespace }}/{{ $labels.pod }} over-provisioned by {{ $value | humanizePercentage }}"
            description: "VPA recommends significantly lower memory. Consider applying recommendations."

        # Alert when VPA admission controller is unavailable
        - alert: VPAAdmissionControllerDown
          expr: |
            absent(up{job="vpa-admission-controller"} == 1)
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "VPA Admission Controller is down"
            description: "VPA Admission Controller has been unavailable for 5 minutes. Pod resource injection is disabled."

        # Alert on OOM kills that VPA should have prevented
        - alert: VPAMissedOOMKill
          expr: |
            increase(kube_pod_container_status_restarts_total{reason="OOMKilled"}[1h]) > 0
            and on(namespace, pod)
            kube_verticalpodautoscaler_status_condition{condition="RecommendationProvided",status="True"} == 1
          for: 0m
          labels:
            severity: warning
          annotations:
            summary: "OOM kill on pod {{ $labels.pod }} despite VPA recommendation"
            description: "A pod with active VPA recommendations was OOM killed. Check if recommendations are being applied."
```

## Grafana Dashboard Configuration

```json
{
  "title": "VPA Resource Efficiency",
  "panels": [
    {
      "title": "CPU Right-Sizing Opportunities",
      "type": "table",
      "targets": [
        {
          "expr": "100 * (kube_pod_container_resource_requests{resource=\"cpu\"} - kube_verticalpodautoscaler_status_recommendation_containerrecommendations_target{resource=\"cpu\"}) / kube_pod_container_resource_requests{resource=\"cpu\"}",
          "legendFormat": "{{namespace}}/{{pod}}/{{container}}"
        }
      ],
      "fieldConfig": {
        "overrides": [
          {
            "matcher": {"id": "byName", "options": "Value"},
            "properties": [
              {"id": "unit", "value": "percent"},
              {"id": "thresholds", "value": {
                "steps": [
                  {"color": "green", "value": null},
                  {"color": "yellow", "value": 20},
                  {"color": "red", "value": 40}
                ]
              }}
            ]
          }
        ]
      }
    }
  ]
}
```

## Common Pitfalls and Solutions

### Pitfall 1: VPA Evicts Pods During Peak Traffic

**Symptom**: The Updater evicts pods exactly when traffic is highest, causing brief availability drops.

**Root Cause**: The Recommender's percentile-based recommendations look conservative during peak hours, triggering evictions when pods diverge from recommendations.

**Solution**: Configure eviction windows and rate limits:

```yaml
# vpa-updater args
- --min-replicas=2           # Never evict if fewer than 2 replicas exist
- --eviction-rate-limit=1.0  # Max 1 pod evicted per second
- --eviction-tolerance=0.20  # Only evict if off by more than 20%
```

And add PDBs to ensure minimum availability:

```yaml
spec:
  minAvailable: "80%"   # Never drop below 80% pod availability
```

### Pitfall 2: Recommendations Oscillate

**Symptom**: VPA recommendations change significantly every day, causing frequent evictions.

**Root Cause**: Short history window captures daily variance as signal rather than noise.

**Solution**: Increase history length and use higher percentiles:

```
--history-length=720h      # 30 days of history
--target-cpu-percentile=0.9
```

### Pitfall 3: VPA and LimitRange Conflict

**Symptom**: Pods fail to start with error: `Invalid value: [resource.Quantity]: must be less than or equal to memory limit`.

**Root Cause**: VPA sets memory request higher than the LimitRange max allows.

**Solution**: Align VPA `maxAllowed` with LimitRange max, or remove the LimitRange max constraint:

```bash
kubectl get limitrange -n production -o yaml | grep -A5 max
# Verify LimitRange max >= VPA maxAllowed
```

### Pitfall 4: JVM Workloads Get Undersized Memory

**Symptom**: Java applications get OOM killed despite VPA recommendations being applied.

**Root Cause**: JVM heap grows over time; early samples underestimate steady-state usage.

**Solution**:
1. Set explicit `minAllowed.memory` based on known JVM heap requirements
2. Use `controlledValues: RequestsOnly` to keep a fixed limit headroom
3. Configure `-Xms` and `-Xmx` to specific values rather than relying on percentage-based defaults

```yaml
env:
  - name: JAVA_OPTS
    value: "-Xms512m -Xmx2g -XX:+UseG1GC"
```

```yaml
# VPA with memory RequestsOnly for JVM workload
- containerName: java-app
  controlledValues: RequestsOnly
  minAllowed:
    memory: 768Mi   # Xms + overhead
  maxAllowed:
    memory: 4Gi
```

### Pitfall 5: Single-Replica Deployments and Eviction

**Symptom**: Single-pod deployments experience downtime when VPA evicts the pod.

**Solution**: For single-replica workloads, use `Initial` mode or ensure the eviction window is during low-traffic hours:

```yaml
updatePolicy:
  updateMode: "Initial"   # Apply on next natural restart, not forced eviction
```

## Summary

Vertical Pod Autoscaler is one of the highest-ROI tools in the Kubernetes ecosystem, but it requires deliberate configuration to deploy safely. The key principles:

1. Start with `Off` mode to observe recommendations before applying them.
2. Progress to `Initial` before `Recreate` — let natural pod turnover apply updates first.
3. Always pair `Recreate` mode with PodDisruptionBudgets.
4. Separate VPA and HPA concerns — use custom metrics for HPA, let VPA own CPU/memory.
5. Set explicit `minAllowed`/`maxAllowed` bounds to prevent extreme recommendations.
6. Use the VPA Recommendation Reporter regularly to identify right-sizing opportunities.
7. Monitor VPA Admission Controller availability — it is a critical path for all pod scheduling.

With a phased rollout and proper observability, VPA can reduce cluster CPU waste by 30–60% and memory waste by 20–50% in typical enterprise workloads.
