---
title: "Kubernetes Resource Management: LimitRange, ResourceQuota, and Priority Classes"
date: 2028-01-21T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Resource Management", "LimitRange", "ResourceQuota", "QoS", "Priority Classes"]
categories: ["Kubernetes", "Operations"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Advanced guide to Kubernetes resource management covering LimitRange for default requests and limits, ResourceQuota by namespace, PriorityClass for workload tiers, Pod QoS classes, eviction policies, and node pressure thresholds."
more_link: "yes"
url: "/kubernetes-resource-management-advanced-guide/"
---

Kubernetes resource management determines how workloads compete for cluster resources during normal operation and how the scheduler and kubelet behave under resource pressure. Without explicit resource requests and limits, the scheduler cannot make informed placement decisions, and the kubelet has no basis for evicting pods when nodes are under memory or CPU pressure. LimitRange objects enforce defaults at the namespace level, ResourceQuota prevents namespace-level resource exhaustion, and PriorityClasses establish a workload tier hierarchy that guides eviction ordering.

<!--more-->

# Kubernetes Resource Management: LimitRange, ResourceQuota, and Priority Classes

## Section 1: Pod Quality of Service Classes

Kubernetes assigns every pod to a QoS class based on its resource configuration. This class determines the pod's priority during node-level eviction when memory pressure occurs.

### QoS Class Determination Rules

```yaml
# qos-class-examples.yaml

# ── Class: Guaranteed ────────────────────────────────────────────────────────
# Requirements:
# - Every container (including init containers) has memory requests = memory limits
# - Every container has CPU requests = CPU limits
# - No container is missing resource specifications
# Effect: Last to be evicted under memory pressure
apiVersion: v1
kind: Pod
metadata:
  name: guaranteed-pod
  # kubectl get pod guaranteed-pod -o jsonpath='{.status.qosClass}'
  # → Guaranteed
spec:
  containers:
    - name: app
      image: app:latest
      resources:
        requests:
          cpu: 500m        # requests == limits → Guaranteed
          memory: 512Mi
        limits:
          cpu: 500m        # Must equal requests
          memory: 512Mi    # Must equal requests
---
# ── Class: Burstable ─────────────────────────────────────────────────────────
# Requirements:
# - Not Guaranteed (at least one container has requests != limits or missing limit)
# - At least one container has a memory OR cpu request or limit
# Effect: Evicted when node is under pressure and no BestEffort pods remain
apiVersion: v1
kind: Pod
metadata:
  name: burstable-pod
  # qosClass: Burstable
spec:
  containers:
    - name: app
      image: app:latest
      resources:
        requests:
          cpu: 200m        # requests < limits → Burstable
          memory: 256Mi
        limits:
          cpu: 1000m       # Can burst up to 1 CPU
          memory: 1Gi      # Can burst up to 1 GiB memory
---
# ── Class: BestEffort ────────────────────────────────────────────────────────
# Requirements:
# - No resource requests or limits on any container
# Effect: First to be evicted under memory pressure
# Use case: Non-critical batch jobs, development workloads
apiVersion: v1
kind: Pod
metadata:
  name: besteffort-pod
  # qosClass: BestEffort
spec:
  containers:
    - name: batch-job
      image: batch-processor:latest
      # No resources section → BestEffort
```

### Importance of Correct QoS Classification

```bash
#!/bin/bash
# audit-qos-classes.sh
# Report all pods grouped by QoS class for resource management review

NAMESPACE="${1:-}"
NS_FLAG=""
if [[ -n "${NAMESPACE}" ]]; then
  NS_FLAG="-n ${NAMESPACE}"
else
  NS_FLAG="--all-namespaces"
fi

echo "=== Pod QoS Class Audit ==="
echo ""
echo "--- Guaranteed Pods ---"
kubectl get pods ${NS_FLAG} \
  -o jsonpath='{range .items[?(@.status.qosClass=="Guaranteed")]}{.metadata.namespace}{"\t"}{.metadata.name}{"\n"}{end}' \
  | column -t -s $'\t' -N "NAMESPACE,POD_NAME"

echo ""
echo "--- Burstable Pods ---"
kubectl get pods ${NS_FLAG} \
  -o jsonpath='{range .items[?(@.status.qosClass=="Burstable")]}{.metadata.namespace}{"\t"}{.metadata.name}{"\n"}{end}' \
  | column -t -s $'\t' -N "NAMESPACE,POD_NAME"

echo ""
echo "--- BestEffort Pods (will be evicted first) ---"
kubectl get pods ${NS_FLAG} \
  -o jsonpath='{range .items[?(@.status.qosClass=="BestEffort")]}{.metadata.namespace}{"\t"}{.metadata.name}{"\n"}{end}' \
  | column -t -s $'\t' -N "NAMESPACE,POD_NAME"
```

## Section 2: LimitRange

LimitRange objects define defaults and constraints for resource requests and limits within a namespace. When a container does not specify resources, the LimitRange default values are injected by the admission controller.

### Comprehensive LimitRange Configuration

```yaml
# limitrange-production.yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: production-limits
  namespace: production
spec:
  limits:
    # ── Container-level limits ─────────────────────────────────────────────
    - type: Container
      # default: injected when container does not specify limits
      default:
        cpu: "1"          # 1 CPU core limit default
        memory: "512Mi"   # 512 MiB memory limit default
        ephemeral-storage: "2Gi"  # 2 GiB local storage limit

      # defaultRequest: injected when container does not specify requests
      defaultRequest:
        cpu: "100m"       # 100 millicpu request default
        memory: "128Mi"   # 128 MiB memory request default
        ephemeral-storage: "500Mi"

      # max: hard ceiling; containers cannot set limits above this value
      max:
        cpu: "8"          # No container may request > 8 CPUs
        memory: "16Gi"    # No container may request > 16 GiB
        ephemeral-storage: "20Gi"

      # min: floor; containers cannot set requests below this value
      min:
        cpu: "50m"
        memory: "64Mi"

      # maxLimitRequestRatio: maximum ratio of limit to request
      # Prevents containers from setting very high limits with low requests
      # (avoids noisy neighbor effects from burstable pods)
      maxLimitRequestRatio:
        cpu: "10"         # limit may be at most 10x the request
        memory: "4"       # limit may be at most 4x the request

    # ── Pod-level limits ───────────────────────────────────────────────────
    # Applied to the sum of all containers in the pod
    - type: Pod
      max:
        cpu: "32"         # Pod cannot request > 32 CPUs total
        memory: "64Gi"    # Pod cannot request > 64 GiB memory total

    # ── PersistentVolumeClaim limits ───────────────────────────────────────
    - type: PersistentVolumeClaim
      max:
        storage: "100Gi"  # PVCs cannot request > 100 GiB
      min:
        storage: "1Gi"    # PVCs must request at least 1 GiB
---
# LimitRange for development namespace — more permissive
apiVersion: v1
kind: LimitRange
metadata:
  name: development-limits
  namespace: development
spec:
  limits:
    - type: Container
      default:
        cpu: "500m"
        memory: "256Mi"
      defaultRequest:
        cpu: "50m"
        memory: "64Mi"
      max:
        cpu: "4"
        memory: "8Gi"
      maxLimitRequestRatio:
        cpu: "20"   # Dev can burst more aggressively
        memory: "8"
```

### Validating LimitRange Enforcement

```bash
#!/bin/bash
# validate-limitrange.sh
# Verify LimitRange is being applied correctly in a namespace

NAMESPACE="${1:?Usage: $0 <namespace>}"

echo "=== LimitRange Validation for namespace: ${NAMESPACE} ==="

# Show active LimitRanges
echo ""
echo "--- Active LimitRanges ---"
kubectl get limitrange -n "${NAMESPACE}" -o yaml

# Create a test pod without resource specs to verify defaults are injected
echo ""
echo "--- Testing default injection (no resources specified) ---"
kubectl run limitrange-test \
  --image=busybox:1.36 \
  --restart=Never \
  --namespace="${NAMESPACE}" \
  --command -- sleep 60 \
  --dry-run=server -o json \
  | jq '.spec.containers[0].resources'

# Expected output shows injected defaults from LimitRange

# Attempt to create a pod exceeding the max limit (should fail)
echo ""
echo "--- Testing max limit enforcement (should fail) ---"
cat << EOF | kubectl apply --dry-run=server -f - 2>&1 || true
apiVersion: v1
kind: Pod
metadata:
  name: limit-exceed-test
  namespace: ${NAMESPACE}
spec:
  containers:
    - name: app
      image: busybox:1.36
      resources:
        limits:
          cpu: "100"      # Exceeds max cpu limit
          memory: "100Gi" # Exceeds max memory limit
      command: ["sleep", "60"]
EOF
```

## Section 3: ResourceQuota

ResourceQuota limits the aggregate resource consumption of all objects in a namespace. Quotas enforce total limits on compute resources, object counts, and storage.

### Multi-Tier Namespace Quotas

```yaml
# resourcequota-production.yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: production-compute-quota
  namespace: production
spec:
  hard:
    # ── Compute Resources ────────────────────────────────────────────────────
    # Total CPU requests across all pods in namespace
    requests.cpu: "100"
    # Total memory requests across all pods in namespace
    requests.memory: "200Gi"
    # Total CPU limits across all pods in namespace
    limits.cpu: "400"
    # Total memory limits across all pods in namespace
    limits.memory: "800Gi"

    # ── Storage ──────────────────────────────────────────────────────────────
    # Total PVC storage requested across namespace
    requests.storage: "10Ti"
    # PVCs per namespace (prevents PVC sprawl)
    persistentvolumeclaims: "50"
    # Storage class-specific quotas
    local-nvme.storageclass.storage.k8s.io/requests.storage: "5Ti"
    local-nvme.storageclass.storage.k8s.io/persistentvolumeclaims: "20"

    # ── Object Count Limits ───────────────────────────────────────────────
    # Prevent namespace from creating unlimited objects
    pods: "200"
    services: "50"
    services.loadbalancers: "5"
    services.nodeports: "0"  # Disallow NodePort services in production
    secrets: "100"
    configmaps: "100"
    replicationcontrollers: "0"  # Discourage use of RC in favor of Deployments

    # ── Extended Resources ────────────────────────────────────────────────
    requests.nvidia.com/gpu: "8"  # Maximum 8 GPU cards across namespace
---
# Priority-scoped quotas: different limits based on pod priority
# Quotas with scopeSelector apply only to pods matching the scope
apiVersion: v1
kind: ResourceQuota
metadata:
  name: production-critical-quota
  namespace: production
spec:
  # Apply this quota ONLY to pods with the critical priority class
  scopeSelector:
    matchExpressions:
      - operator: In
        scopeName: PriorityClass
        values:
          - critical-workloads
  hard:
    # Critical workloads get reserved capacity
    requests.cpu: "20"
    requests.memory: "40Gi"
    pods: "20"
---
# Separate quota for BestEffort pods (batch workloads)
apiVersion: v1
kind: ResourceQuota
metadata:
  name: production-besteffort-quota
  namespace: production
spec:
  scopeSelector:
    matchExpressions:
      - operator: In
        scopeName: QosClass
        values:
          - BestEffort
  hard:
    # Limit the number of BestEffort pods to prevent resource exhaustion
    pods: "30"
```

### Monitoring Quota Utilization

```bash
#!/bin/bash
# monitor-resource-quotas.sh
# Report quota utilization with percentage calculations

NAMESPACE="${1:?Usage: $0 <namespace>}"

echo "=== Resource Quota Utilization: ${NAMESPACE} ==="
echo ""

kubectl get resourcequota -n "${NAMESPACE}" -o json \
  | jq -r '
    .items[] |
    .metadata.name as $quota_name |
    .status |
    .hard as $hard |
    .used as $used |
    ($hard | keys[]) as $resource |
    {
      quota: $quota_name,
      resource: $resource,
      used: $used[$resource],
      hard: $hard[$resource]
    } |
    select(.used != null) |
    "\(.quota)\t\(.resource)\t\(.used)\t\(.hard)"
  ' \
  | column -t -s $'\t' -N "QUOTA,RESOURCE,USED,LIMIT"

# Highlight quotas above 80% utilization
echo ""
echo "--- Quotas above 80% utilization (warning threshold) ---"
kubectl get resourcequota -n "${NAMESPACE}" -o json \
  | jq -r '
    .items[] |
    .metadata.name as $quota_name |
    .status |
    .hard as $hard |
    .used as $used |
    ($hard | keys[]) as $resource |
    select(
      ($used[$resource] != null) and
      ($hard[$resource] != null) and
      # For numeric values: used/hard > 0.8
      # This is simplified — real implementation needs unit parsing
      (($used[$resource] | tonumber? // 0) / ($hard[$resource] | tonumber? // 1)) > 0.8
    ) |
    "\(.quota)\t\($resource)\t\($used[$resource])\t\($hard[$resource])"
  ' \
  | column -t -s $'\t' -N "QUOTA,RESOURCE,USED,LIMIT"
```

## Section 4: PriorityClasses

PriorityClasses assign numeric priority values to pods. Higher priority pods preempt lower priority pods when the cluster lacks capacity. During eviction, lower priority pods are evicted first.

```yaml
# priority-classes.yaml

# ── Tier 0: Critical system components ──────────────────────────────────────
# Reserved for cluster-critical infrastructure (coredns, kube-proxy, etc.)
# Default system-critical priority is 2000000000
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: cluster-critical
value: 2000000  # High value → hard to preempt
globalDefault: false
preemptionPolicy: PreemptLowerPriority
description: "For cluster-critical infrastructure components. Pods with this class will preempt any lower-priority pod if the cluster lacks capacity."
---
# ── Tier 1: Production business-critical workloads ───────────────────────────
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: critical-workloads
value: 1000000
globalDefault: false
preemptionPolicy: PreemptLowerPriority
description: "Production workloads that must not be disrupted during normal cluster operations. Payment processing, authentication services, etc."
---
# ── Tier 2: Production standard workloads ────────────────────────────────────
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: production-standard
value: 100000
globalDefault: true  # Applied when no priorityClassName is specified
preemptionPolicy: PreemptLowerPriority
description: "Standard production workloads. This is the default priority class."
---
# ── Tier 3: Non-critical production workloads ────────────────────────────────
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: production-low
value: 10000
globalDefault: false
preemptionPolicy: PreemptLowerPriority
description: "Background production jobs, async processors, caching layers. Can be preempted to make room for higher-priority workloads."
---
# ── Tier 4: Batch and development workloads ───────────────────────────────────
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: batch-standard
value: 1000
globalDefault: false
preemptionPolicy: PreemptLowerPriority
description: "Batch processing jobs, data pipelines. Preemptible by all production workloads."
---
# ── Tier 5: Background/best-effort ──────────────────────────────────────────
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: background
value: 100
globalDefault: false
# Never preempts other pods — only scheduled when there is spare capacity
preemptionPolicy: Never
description: "Background indexing, cleanup, and non-urgent batch processing. Never preempts other pods."
---
# ── Tier 6: Development/experimental ────────────────────────────────────────
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: development
value: 0
globalDefault: false
preemptionPolicy: Never
description: "Development and experimental workloads. Lowest priority — evicted first under node pressure."
```

### Applying Priority Classes to Workloads

```yaml
# priority-class-workloads.yaml

# Payment processor: critical workload
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-processor
  namespace: production
spec:
  replicas: 5
  selector:
    matchLabels:
      app: payment-processor
  template:
    metadata:
      labels:
        app: payment-processor
    spec:
      # Critical workload — never preempted by standard production pods
      priorityClassName: critical-workloads
      containers:
        - name: payment-processor
          image: payment-processor:3.1.0
          resources:
            requests:
              cpu: 1000m
              memory: 2Gi
            limits:
              cpu: 2000m
              memory: 4Gi
---
# Data analytics pipeline: batch workload
apiVersion: apps/v1
kind: Deployment
metadata:
  name: analytics-pipeline
  namespace: production
spec:
  replicas: 10
  selector:
    matchLabels:
      app: analytics-pipeline
  template:
    spec:
      # Batch — can be preempted if critical workloads need capacity
      priorityClassName: batch-standard
      containers:
        - name: analytics
          image: analytics:2.0.0
          resources:
            requests:
              cpu: 500m
              memory: 1Gi
            limits:
              cpu: 4000m
              memory: 8Gi
---
# Nightly report job: background priority
apiVersion: batch/v1
kind: CronJob
metadata:
  name: nightly-reports
  namespace: production
spec:
  schedule: "0 2 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          priorityClassName: background
          restartPolicy: OnFailure
          containers:
            - name: report-generator
              image: reports:1.0.0
              resources:
                requests:
                  cpu: 200m
                  memory: 512Mi
```

## Section 5: Eviction Policies and Node Pressure

### Kubelet Eviction Thresholds

The kubelet evicts pods when node resources are below configured thresholds. Understanding these thresholds is essential for predicting eviction behavior.

```yaml
# kubelet-eviction-config.yaml
# Configure via kubelet flags or kubelet configuration file
# Apply via kubeadm's KubeletConfiguration or via node configuration
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration

# ── Eviction Thresholds ────────────────────────────────────────────────────
# Soft eviction: kubelet waits evictionSoftGracePeriod before evicting
# Hard eviction: kubelet evicts immediately when threshold crossed
evictionSoft:
  memory.available: "500Mi"   # Start soft eviction when < 500 MiB free memory
  nodefs.available: "10%"     # Start soft eviction when < 10% node filesystem
  nodefs.inodesFree: "5%"     # Start soft eviction when < 5% inodes free
  imagefs.available: "15%"    # Start soft eviction for image filesystem
  pid.available: "10%"        # Start soft eviction when < 10% PIDs available

evictionSoftGracePeriod:
  memory.available: "1m30s"   # Wait 90s after soft threshold before evicting
  nodefs.available: "1m30s"
  nodefs.inodesFree: "1m30s"

evictionHard:
  memory.available: "200Mi"   # Immediate eviction when < 200 MiB free memory
  nodefs.available: "5%"      # Immediate eviction when < 5% node filesystem
  nodefs.inodesFree: "2%"
  imagefs.available: "10%"
  pid.available: "5%"

# Minimum eviction reclaim: how much to free per eviction cycle
evictionMinimumReclaim:
  memory.available: "0Mi"
  nodefs.available: "500Mi"   # Reclaim at least 500 MiB disk per eviction
  imagefs.available: "2Gi"    # Reclaim at least 2 GiB image storage per eviction

# Pressure transition period: how long to observe pressure before changing node condition
evictionPressureTransitionPeriod: "5m"

# Maximum pods per node
maxPods: 110

# Reserved resources (cannot be used by pods — reserved for system processes)
systemReserved:
  cpu: "500m"
  memory: "512Mi"
  ephemeral-storage: "10Gi"

kubeReserved:
  cpu: "500m"
  memory: "512Mi"
  ephemeral-storage: "10Gi"
```

### Eviction Order

When the kubelet decides to evict pods, it ranks them in this order (evicts lowest ranked first):

1. BestEffort pods (no requests/limits)
2. Burstable pods with lowest priority class, ordered by memory usage relative to request
3. Guaranteed pods (only when memory pressure is critical and no BestEffort/Burstable pods remain)

```bash
#!/bin/bash
# simulate-eviction-order.sh
# Predict which pods would be evicted first on a node under memory pressure

NODE="${1:?Usage: $0 <node-name>}"

echo "=== Eviction Order Prediction for Node: ${NODE} ==="
echo ""
echo "Pods are evicted in this order (evicted first → last):"
echo ""

# Get all pods on the node with QoS class and memory usage vs request
kubectl get pods \
  --all-namespaces \
  --field-selector="spec.nodeName=${NODE}" \
  -o json \
  | jq -r '
    .items[] |
    {
      namespace: .metadata.namespace,
      name: .metadata.name,
      qos: .status.qosClass,
      priority: (.spec.priorityClassName // "production-standard"),
      phase: .status.phase
    } |
    select(.phase == "Running") |
    [.qos, .priority, .namespace, .name] | @tsv
  ' \
  | sort \
  | column -t -s $'\t' -N "QOS_CLASS,PRIORITY_CLASS,NAMESPACE,POD"
```

### Node Condition Monitoring

```yaml
# node-pressure-alerts.yaml
# Prometheus alerts for node eviction conditions
- alert: KubeNodeMemoryPressure
  expr: kube_node_status_condition{condition="MemoryPressure",status="true"} == 1
  for: 2m
  labels:
    severity: critical
  annotations:
    summary: "Node {{ $labels.node }} is under memory pressure"
    description: "Node {{ $labels.node }} has MemoryPressure=True condition. The kubelet has already begun evicting pods. Immediate action required."
    runbook_url: "https://wiki.example.com/runbooks/node-memory-pressure"

- alert: KubeNodeDiskPressure
  expr: kube_node_status_condition{condition="DiskPressure",status="true"} == 1
  for: 2m
  labels:
    severity: critical
  annotations:
    summary: "Node {{ $labels.node }} is under disk pressure"
    description: "Node {{ $labels.node }} has DiskPressure=True. Eviction of pods may occur."

- alert: KubeNodeApproachingMemoryPressure
  expr: |
    (
      node_memory_MemAvailable_bytes
      /
      node_memory_MemTotal_bytes
    ) < 0.1  # Less than 10% memory available
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "Node {{ $labels.instance }} approaching memory pressure threshold"
    description: "Node {{ $labels.instance }} has only {{ $value | humanizePercentage }} memory available. Soft eviction threshold may be reached soon."
```

## Section 6: Vertical Pod Autoscaler Integration

VPA adjusts resource requests and limits based on observed usage, complementing the static LimitRange defaults.

```yaml
# vpa-configuration.yaml
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
    # Off: only provide recommendations, no automatic updates
    # Initial: update only when pods are created/recreated
    # Auto: update running pods (triggers pod restarts)
    updateMode: "Initial"  # Safe for production — applies during rollouts only

  resourcePolicy:
    containerPolicies:
      - containerName: payment-service
        # Set bounds to prevent VPA from recommending extreme values
        minAllowed:
          cpu: 100m
          memory: 128Mi
        maxAllowed:
          cpu: 4000m
          memory: 8Gi
        # VPA recommends both CPU and Memory adjustments
        controlledResources:
          - cpu
          - memory
        # Control which direction VPA adjusts
        # ScaleDown and ScaleUp (default): both directions
        # ScaleUp only: prevents VPA from reducing requests
        controlledValues: RequestsAndLimits
---
# View VPA recommendations without applying them
# kubectl describe vpa payment-service-vpa -n production
# Output shows: Lower Bound, Target, Uncapped Target, Upper Bound
```

## Section 7: Multi-Dimensional Resource Optimization

### CPU vs Memory Trade-offs

```yaml
# resource-optimization-patterns.yaml
# ── Pattern: High CPU, Low Memory (CPU-intensive processing) ────────────────
containers:
  - name: data-processor
    resources:
      requests:
        cpu: "4"      # Request 4 CPUs for parallel processing
        memory: 512Mi  # Low memory requirement
      limits:
        cpu: "8"       # Burst to 8 CPUs during peak
        memory: 1Gi    # Hard memory cap

# ── Pattern: Low CPU, High Memory (in-memory cache) ─────────────────────────
containers:
  - name: cache-service
    resources:
      requests:
        cpu: 200m       # Cache lookups are fast, low CPU
        memory: 8Gi     # Large memory for cache data
      limits:
        cpu: 1000m
        memory: 8Gi     # Memory limit = request for Guaranteed QoS

# ── Pattern: Startup-intensive workload ──────────────────────────────────────
# JVM startup requires more CPU than steady-state
# Use Init Container or startupProbe to manage startup resources
containers:
  - name: java-service
    resources:
      requests:
        cpu: 500m       # Steady-state request
        memory: 2Gi
      limits:
        cpu: 4000m      # Allow high CPU during JVM startup/JIT compilation
        memory: 4Gi
    startupProbe:
      httpGet:
        path: /actuator/health
        port: 8080
      failureThreshold: 60    # Allow 5 minutes for JVM startup
      periodSeconds: 5
```

## Section 8: Namespace Hierarchy and Quota Delegation

```yaml
# hierarchical-namespace-quotas.yaml
# Using HNC (Hierarchical Namespace Controller) or manual quota delegation
# to allocate resources across team namespaces

# Parent namespace: shared-services
# Child namespaces: payments, orders, users (inherit parent quota constraints)

# Root quota: limits total resources available to the business unit
apiVersion: v1
kind: ResourceQuota
metadata:
  name: business-unit-total-quota
  namespace: backend-services  # Root namespace
spec:
  hard:
    requests.cpu: "200"
    requests.memory: "400Gi"
    requests.storage: "20Ti"
    pods: "500"

---
# Each team namespace gets a fraction of the total
apiVersion: v1
kind: ResourceQuota
metadata:
  name: team-quota
  namespace: payments-team
spec:
  hard:
    requests.cpu: "50"
    requests.memory: "100Gi"
    requests.storage: "5Ti"
    pods: "100"
    # Team-specific: cannot create LoadBalancer services without approval
    services.loadbalancers: "2"
```

## Section 9: Resource Request Sizing Tooling

```bash
#!/bin/bash
# rightsize-resources.sh
# Compare actual resource usage (from metrics-server) with configured requests
# to identify over- and under-provisioned workloads

NAMESPACE="${1:?Usage: $0 <namespace>}"

echo "=== Resource Rightsizing Report: ${NAMESPACE} ==="
echo ""
echo "Format: Pod | Container | CPU Request | CPU Used | Memory Request | Memory Used"
echo ""

# Requires: kubectl top pods (metrics-server installed)
kubectl top pods -n "${NAMESPACE}" --containers \
  | tail -n +2 \
  | while read POD_NAME CONTAINER_NAME CPU_USED MEM_USED; do
    # Get the configured requests for this container
    CPU_REQ=$(kubectl get pod "${POD_NAME}" -n "${NAMESPACE}" \
      -o jsonpath="{.spec.containers[?(@.name==\"${CONTAINER_NAME}\")].resources.requests.cpu}" \
      2>/dev/null || echo "N/A")
    MEM_REQ=$(kubectl get pod "${POD_NAME}" -n "${NAMESPACE}" \
      -o jsonpath="{.spec.containers[?(@.name==\"${CONTAINER_NAME}\")].resources.requests.memory}" \
      2>/dev/null || echo "N/A")

    echo "${POD_NAME} | ${CONTAINER_NAME} | ${CPU_REQ} | ${CPU_USED} | ${MEM_REQ} | ${MEM_USED}"
  done \
  | column -t -s '|'
```

## Summary

Resource management in Kubernetes operates at three layers, each addressing a different problem:

**LimitRange** provides namespace-scoped defaults that prevent the "no resources specified" anti-pattern, which leaves the scheduler blind and places workloads in BestEffort QoS class. The `maxLimitRequestRatio` constraint prevents noisy neighbor scenarios by limiting how far a container can burst above its request.

**ResourceQuota** prevents namespace-level resource exhaustion, ensuring that one team or application cannot consume all cluster capacity. Scoped quotas—filtered by PriorityClass or QoS class—enable differentiated capacity reservations for critical vs. batch workloads within the same namespace.

**PriorityClasses** establish an explicit workload tier hierarchy. During preemption events, the scheduler evicts lower-priority pods to accommodate higher-priority ones. During kubelet-level eviction under node pressure, pods are evicted in QoS/priority order, ensuring that critical business workloads outlast batch processes and development workloads.

Together, these mechanisms transform Kubernetes resource management from reactive (responding to OOM kills and scheduling failures) to proactive (defining capacity boundaries, workload tiers, and eviction policies that reflect business priorities).
