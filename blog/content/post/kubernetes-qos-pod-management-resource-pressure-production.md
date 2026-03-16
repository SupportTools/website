---
title: "Kubernetes QoS Pod Management: Surviving Resource Pressure in Production"
date: 2026-09-07T00:00:00-05:00
draft: false
tags: ["Kubernetes", "QoS", "Resource Management", "Production", "Performance", "Capacity Planning", "Pod Eviction"]
categories: ["Kubernetes", "Operations", "Performance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Kubernetes Quality of Service (QoS) classes, resource management, and surviving resource pressure in production through proper configuration of Guaranteed, Burstable, and BestEffort pods."
more_link: "yes"
url: "/kubernetes-qos-pod-management-resource-pressure-production/"
---

Resource exhaustion is one of the most common causes of production incidents in Kubernetes clusters. When nodes run out of memory or CPU, the kubelet must make critical decisions about which pods to evict, potentially taking down critical services. Understanding Kubernetes Quality of Service (QoS) classes—Guaranteed, Burstable, and BestEffort—is essential for building resilient production systems that survive resource pressure without service degradation. This comprehensive guide explores QoS mechanics, resource management strategies, and production-tested configurations for critical workloads.

<!--more-->

## Executive Summary

Kubernetes QoS classes determine pod eviction order during resource pressure, but their implications extend far beyond simple priority rankings. Proper QoS configuration affects scheduling decisions, resource allocation, performance guarantees, and ultimately, the reliability of your production services. This post provides a complete framework for implementing QoS-based resource management, including real-world configurations, monitoring strategies, and incident response procedures for resource exhaustion scenarios.

## Understanding Kubernetes QoS Classes

### The Three QoS Classes

Kubernetes assigns every pod to one of three QoS classes based on resource requests and limits:

```yaml
# Guaranteed QoS
# - All containers have memory requests = memory limits
# - All containers have CPU requests = CPU limits
# - Highest priority during eviction
# - Last to be killed under resource pressure

apiVersion: v1
kind: Pod
metadata:
  name: guaranteed-pod
spec:
  containers:
  - name: app
    image: nginx:1.25
    resources:
      requests:
        memory: "1Gi"
        cpu: "1000m"
      limits:
        memory: "1Gi"      # Must equal requests
        cpu: "1000m"       # Must equal requests

---
# Burstable QoS
# - At least one container has memory or CPU requests
# - Requests != limits (or limits not specified)
# - Medium priority during eviction
# - Evicted before Guaranteed, after BestEffort

apiVersion: v1
kind: Pod
metadata:
  name: burstable-pod
spec:
  containers:
  - name: app
    image: nginx:1.25
    resources:
      requests:
        memory: "512Mi"
        cpu: "500m"
      limits:
        memory: "2Gi"      # Greater than requests = Burstable
        cpu: "2000m"

---
# BestEffort QoS
# - No memory or CPU requests or limits specified
# - Lowest priority during eviction
# - First to be killed under resource pressure

apiVersion: v1
kind: Pod
metadata:
  name: besteffort-pod
spec:
  containers:
  - name: app
    image: nginx:1.25
    # No resources specified = BestEffort
```

### QoS Class Assignment Logic

```
┌─────────────────────────────────────────────────────────────────┐
│                  Pod Resource Configuration                      │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
         ┌───────────────────────────────┐
         │  All containers have both      │
         │  requests and limits?         │
         └───────────┬───────────────────┘
                     │
         ┌───────────┴───────────┐
         │                       │
        NO                      YES
         │                       │
         ▼                       ▼
    ┌─────────┐      ┌──────────────────┐
    │ Any     │      │  Do requests ==   │
    │requests?│      │  limits for all   │
    └────┬────┘      │  containers?      │
         │           └────────┬───────────┘
    ┌────┴────┐               │
    │         │          ┌────┴────┐
   YES       NO         YES       NO
    │         │          │         │
    ▼         ▼          ▼         ▼
┌──────────┐ ┌─────────┐ ┌──────────┐ ┌──────────┐
│Burstable │ │BestEffort│ │Guaranteed│ │Burstable │
└──────────┘ └─────────┘ └──────────┘ └──────────┘
```

## The Real Impact of QoS Classes

### Resource Accounting and Scheduling

```bash
# View pod QoS classes in your cluster
kubectl get pods -A -o custom-columns=\
NAMESPACE:.metadata.namespace,\
NAME:.metadata.name,\
QOS:.status.qosClass,\
CPU_REQ:.spec.containers[*].resources.requests.cpu,\
MEM_REQ:.spec.containers[*].resources.requests.memory,\
CPU_LIM:.spec.containers[*].resources.limits.cpu,\
MEM_LIM:.spec.containers[*].resources.limits.memory

# Check resource allocation by QoS class
kubectl top nodes

# View detailed node resource allocation
kubectl describe nodes | grep -A 5 "Allocated resources"
```

### Eviction Thresholds and Behavior

The kubelet monitors resource usage and triggers evictions when thresholds are exceeded:

```yaml
# kubelet-config.yaml
# Kubelet eviction configuration

apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration

# Hard eviction thresholds - immediate eviction, no grace period
evictionHard:
  memory.available: "100Mi"      # Free memory below 100Mi
  nodefs.available: "10%"        # Root filesystem below 10% free
  nodefs.inodesFree: "5%"        # Inodes below 5% free
  imagefs.available: "10%"       # Image filesystem below 10% free

# Soft eviction thresholds - eviction after grace period
evictionSoft:
  memory.available: "500Mi"      # Warning threshold
  nodefs.available: "15%"
  nodefs.inodesFree: "10%"
  imagefs.available: "15%"

# Grace periods for soft eviction
evictionSoftGracePeriod:
  memory.available: "1m30s"      # Wait 90s before evicting
  nodefs.available: "2m"
  nodefs.inodesFree: "2m"
  imagefs.available: "2m"

# Eviction pressure transition grace period
evictionPressureTransitionPeriod: "30s"

# Maximum pod termination grace period during eviction
evictionMaxPodGracePeriod: 30

# Minimum reclaim amounts
evictionMinimumReclaim:
  memory.available: "0Mi"
  nodefs.available: "500Mi"
  nodefs.inodesFree: "1000"
  imagefs.available: "2Gi"

# Node conditions
nodeStatusUpdateFrequency: "10s"
nodeStatusReportFrequency: "5m"

# Enable CPU CFS quota enforcement
cpuCFSQuota: true
cpuCFSQuotaPeriod: "100ms"

# Memory management
memorySwap:
  swapBehavior: "NoSwap"

# System reserved resources (for kubelet, OS)
systemReserved:
  cpu: "500m"
  memory: "1Gi"
  ephemeral-storage: "2Gi"

# Kubernetes reserved resources (for kube components)
kubeReserved:
  cpu: "500m"
  memory: "1Gi"
  ephemeral-storage: "2Gi"

# Enforce node allocatable
enforceNodeAllocatable:
  - pods
  - system-reserved
  - kube-reserved
```

### Eviction Order Within QoS Classes

Within each QoS class, pods are evicted based on:

1. **Priority Class**: Higher priority pods are evicted last
2. **Resource usage relative to requests**: Pods exceeding requests are evicted first
3. **Creation time**: Newer pods are evicted before older pods

```yaml
# priority-class-definitions.yaml
# Production priority classes

---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: system-critical
value: 1000000000
globalDefault: false
description: "Reserved for system-critical pods (DNS, networking, monitoring)"

---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: production-critical
value: 100000
globalDefault: false
description: "Critical production workloads (API servers, databases)"

---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: production-high
value: 10000
globalDefault: false
description: "High-priority production workloads (web frontends)"

---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: production-normal
value: 1000
globalDefault: true
description: "Normal production workloads"

---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: batch-low
value: 100
globalDefault: false
description: "Low-priority batch jobs"

---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: development
value: 10
globalDefault: false
description: "Development and testing workloads"
```

## Production Configuration Patterns

### Critical Stateful Services (Databases, Caches)

```yaml
# postgres-statefulset.yaml
# Production PostgreSQL with Guaranteed QoS

apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
  namespace: production
spec:
  serviceName: postgres
  replicas: 3
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
        tier: database
        qos: guaranteed
    spec:
      # Use critical priority class
      priorityClassName: production-critical

      # Anti-affinity to spread across nodes
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchLabels:
                app: postgres
            topologyKey: kubernetes.io/hostname

      containers:
      - name: postgres
        image: postgres:15.4

        # Guaranteed QoS: requests == limits
        resources:
          requests:
            memory: "8Gi"       # Actual expected usage
            cpu: "4000m"
          limits:
            memory: "8Gi"       # Must match requests
            cpu: "4000m"        # Must match requests

        # Huge pages for better memory performance
        volumeMounts:
        - name: hugepages
          mountPath: /dev/hugepages

        env:
        - name: POSTGRES_DB
          value: "production"
        - name: POSTGRES_USER
          valueFrom:
            secretKeyRef:
              name: postgres-secret
              key: username
        - name: POSTGRES_PASSWORD
          valueFrom:
            secretKeyRef:
              name: postgres-secret
              key: password
        - name: PGDATA
          value: /var/lib/postgresql/data/pgdata

        # Health checks
        livenessProbe:
          exec:
            command:
            - /bin/sh
            - -c
            - pg_isready -U $POSTGRES_USER
          initialDelaySeconds: 30
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 3

        readinessProbe:
          exec:
            command:
            - /bin/sh
            - -c
            - pg_isready -U $POSTGRES_USER
          initialDelaySeconds: 5
          periodSeconds: 5
          timeoutSeconds: 1

        # Security context
        securityContext:
          runAsUser: 999
          runAsGroup: 999
          fsGroup: 999
          capabilities:
            drop:
            - ALL
            add:
            - CHOWN
            - SETUID
            - SETGID
            - DAC_OVERRIDE

      volumes:
      - name: hugepages
        emptyDir:
          medium: HugePages-2Mi

  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: ["ReadWriteOnce"]
      storageClassName: fast-ssd
      resources:
        requests:
          storage: 500Gi

---
# PodDisruptionBudget to prevent disruption
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: postgres-pdb
  namespace: production
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: postgres
```

### High-Priority API Services

```yaml
# api-deployment.yaml
# Production API with Burstable QoS for flexibility

apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
  namespace: production
spec:
  replicas: 10
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 3
      maxUnavailable: 1

  selector:
    matchLabels:
      app: api-server

  template:
    metadata:
      labels:
        app: api-server
        tier: application
        qos: burstable
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9090"
    spec:
      priorityClassName: production-high

      # Spread across availability zones
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchLabels:
                  app: api-server
              topologyKey: topology.kubernetes.io/zone

      # Topology spread to balance load
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: kubernetes.io/hostname
        whenUnsatisfiable: ScheduleAnyway
        labelSelector:
          matchLabels:
            app: api-server

      containers:
      - name: api
        image: company/api-server:v2.5.0

        # Burstable QoS: requests < limits
        # Allows bursting for traffic spikes
        resources:
          requests:
            memory: "512Mi"     # Normal operation
            cpu: "500m"
          limits:
            memory: "2Gi"       # Allow bursting to 2Gi
            cpu: "2000m"        # Allow bursting to 2 cores

        ports:
        - containerPort: 8080
          name: http
        - containerPort: 9090
          name: metrics

        env:
        - name: GOMAXPROCS
          valueFrom:
            resourceFieldRef:
              resource: limits.cpu
              divisor: "1"
        - name: GOMEMLIMIT
          valueFrom:
            resourceFieldRef:
              resource: limits.memory
              divisor: "1"

        # Readiness and liveness probes
        livenessProbe:
          httpGet:
            path: /healthz
            port: 8080
          initialDelaySeconds: 10
          periodSeconds: 10
          timeoutSeconds: 3
          failureThreshold: 3

        readinessProbe:
          httpGet:
            path: /ready
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 5
          timeoutSeconds: 1
          failureThreshold: 2

        # Lifecycle hooks for graceful shutdown
        lifecycle:
          preStop:
            exec:
              command:
              - /bin/sh
              - -c
              - sleep 15  # Allow time for load balancer deregistration

      terminationGracePeriodSeconds: 30

---
# Horizontal Pod Autoscaler
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
  minReplicas: 10
  maxReplicas: 100
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 0
      policies:
      - type: Percent
        value: 100
        periodSeconds: 15
      - type: Pods
        value: 10
        periodSeconds: 15
      selectPolicy: Max
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
      - type: Percent
        value: 50
        periodSeconds: 60
      selectPolicy: Min

---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-server-pdb
  namespace: production
spec:
  minAvailable: 70%
  selector:
    matchLabels:
      app: api-server
```

### Batch Jobs and Background Workers

```yaml
# batch-job.yaml
# Batch job with BestEffort QoS for resource efficiency

apiVersion: batch/v1
kind: Job
metadata:
  name: data-processing-job
  namespace: batch
spec:
  parallelism: 20
  completions: 100
  backoffLimit: 3
  ttlSecondsAfterFinished: 86400  # Clean up after 24 hours

  template:
    metadata:
      labels:
        app: data-processor
        type: batch
        qos: besteffort
    spec:
      priorityClassName: batch-low

      restartPolicy: OnFailure

      containers:
      - name: processor
        image: company/data-processor:v1.2.0

        # BestEffort QoS: no requests or limits
        # Will be evicted first under resource pressure
        # But can use any available resources

        env:
        - name: JOB_TYPE
          value: "batch-processing"
        - name: BATCH_SIZE
          value: "1000"

        # Best effort doesn't get resource guarantees
        # but can opportunistically use idle resources

      # Tolerate being scheduled on spot/preemptible nodes
      tolerations:
      - key: "spot-instance"
        operator: "Exists"
        effect: "NoSchedule"
      - key: "preemptible"
        operator: "Exists"
        effect: "NoSchedule"

      # Prefer low-cost node pools
      affinity:
        nodeAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            preference:
              matchExpressions:
              - key: node-pool
                operator: In
                values:
                - spot
                - preemptible
```

## Resource Quota and LimitRange Configuration

```yaml
# namespace-resource-management.yaml
# Comprehensive namespace resource controls

---
apiVersion: v1
kind: Namespace
metadata:
  name: production
  labels:
    environment: production
    monitoring: enabled

---
# ResourceQuota - limits total namespace resource consumption
apiVersion: v1
kind: ResourceQuota
metadata:
  name: production-quota
  namespace: production
spec:
  hard:
    # Compute resources
    requests.cpu: "200"          # Total CPU requests
    requests.memory: "400Gi"     # Total memory requests
    limits.cpu: "400"            # Total CPU limits
    limits.memory: "800Gi"       # Total memory limits

    # Object counts
    pods: "1000"
    services: "100"
    persistentvolumeclaims: "50"

    # QoS-specific quotas
    count/pods.guaranteed: "100"
    count/pods.burstable: "500"
    count/pods.besteffort: "0"   # No BestEffort pods in production!

---
# LimitRange - default resource limits for pods
apiVersion: v1
kind: LimitRange
metadata:
  name: production-limitrange
  namespace: production
spec:
  limits:
  # Container defaults
  - type: Container
    default:  # Default limits
      cpu: "1000m"
      memory: "1Gi"
    defaultRequest:  # Default requests
      cpu: "100m"
      memory: "128Mi"
    max:  # Maximum allowed
      cpu: "8000m"
      memory: "32Gi"
    min:  # Minimum required
      cpu: "10m"
      memory: "16Mi"
    maxLimitRequestRatio:  # Limit/request ratio
      cpu: "10"      # Max 10x burst
      memory: "8"    # Max 8x burst

  # Pod-level limits
  - type: Pod
    max:
      cpu: "32000m"
      memory: "128Gi"
    min:
      cpu: "10m"
      memory: "16Mi"

  # PersistentVolumeClaim limits
  - type: PersistentVolumeClaim
    max:
      storage: "1Ti"
    min:
      storage: "1Gi"
```

## Monitoring and Alerting for Resource Pressure

```yaml
# prometheus-qos-monitoring.yaml
# Comprehensive QoS and resource monitoring

apiVersion: v1
kind: ConfigMap
metadata:
  name: prometheus-qos-rules
  namespace: monitoring
data:
  qos-alerts.yaml: |
    groups:
    - name: qos_resource_management
      interval: 30s
      rules:
      # Node resource pressure
      - alert: NodeMemoryPressure
        expr: |
          node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes < 0.1
        for: 5m
        labels:
          severity: critical
          component: node
        annotations:
          summary: "Node {{ $labels.node }} under memory pressure"
          description: "Available memory: {{ $value | humanizePercentage }}"

      - alert: NodeDiskPressure
        expr: |
          (node_filesystem_avail_bytes{mountpoint="/"} /
           node_filesystem_size_bytes{mountpoint="/"}) < 0.15
        for: 5m
        labels:
          severity: warning
          component: node
        annotations:
          summary: "Node {{ $labels.node }} under disk pressure"
          description: "Available disk: {{ $value | humanizePercentage }}"

      # Pod evictions
      - alert: PodEvictions
        expr: |
          rate(kube_pod_status_reason{reason="Evicted"}[5m]) > 0
        for: 1m
        labels:
          severity: warning
          component: scheduler
        annotations:
          summary: "Pods being evicted on {{ $labels.node }}"
          description: "Eviction rate: {{ $value }} pods/sec"

      # QoS class distribution
      - alert: TooManyBestEffortPods
        expr: |
          (count(kube_pod_status_qos_class{qos_class="besteffort"}) /
           count(kube_pod_status_qos_class)) > 0.2
        for: 10m
        labels:
          severity: warning
          component: capacity
        annotations:
          summary: "High percentage of BestEffort pods"
          description: "{{ $value | humanizePercentage }} of pods are BestEffort"

      # Resource overcommit
      - alert: NodeCPUOvercommit
        expr: |
          sum(kube_pod_container_resource_requests{resource="cpu"}) by (node) /
          sum(kube_node_status_allocatable{resource="cpu"}) by (node) > 1.5
        for: 15m
        labels:
          severity: warning
          component: capacity
        annotations:
          summary: "Node {{ $labels.node }} CPU overcommitted"
          description: "CPU overcommit ratio: {{ $value }}"

      - alert: NodeMemoryOvercommit
        expr: |
          sum(kube_pod_container_resource_requests{resource="memory"}) by (node) /
          sum(kube_node_status_allocatable{resource="memory"}) by (node) > 1.2
        for: 15m
        labels:
          severity: warning
          component: capacity
        annotations:
          summary: "Node {{ $labels.node }} memory overcommitted"
          description: "Memory overcommit ratio: {{ $value }}"

      # Critical pod resource exhaustion
      - alert: GuaranteedPodNearLimits
        expr: |
          (container_memory_working_set_bytes /
           container_spec_memory_limit_bytes) > 0.9
          and on(pod) kube_pod_status_qos_class{qos_class="guaranteed"}
        for: 5m
        labels:
          severity: warning
          component: workload
        annotations:
          summary: "Guaranteed pod {{ $labels.pod }} near memory limit"
          description: "Memory usage: {{ $value | humanizePercentage }}"

      # Container OOM kills
      - alert: ContainerOOMKilled
        expr: |
          rate(kube_pod_container_status_terminated_reason{reason="OOMKilled"}[5m]) > 0
        for: 1m
        labels:
          severity: critical
          component: workload
        annotations:
          summary: "Container OOM killed in {{ $labels.namespace }}/{{ $labels.pod }}"
          description: "Container {{ $labels.container }} killed due to OOM"

      # Namespace quota exhaustion
      - alert: NamespaceQuotaExhausted
        expr: |
          (kube_resourcequota{type="used"} /
           kube_resourcequota{type="hard"}) > 0.9
        for: 5m
        labels:
          severity: warning
          component: quota
        annotations:
          summary: "Namespace {{ $labels.namespace }} quota nearly exhausted"
          description: "Resource {{ $labels.resource }} at {{ $value | humanizePercentage }}"
```

## Incident Response for Resource Exhaustion

```bash
#!/bin/bash
# resource-exhaustion-response.sh
# Emergency response script for resource exhaustion incidents

set -euo pipefail

# Colors
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m'

log() {
  echo -e "[$(date +'%Y-%m-%d %H:%M:%S')] $*"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $*"
}

log_warning() {
  echo -e "${YELLOW}[WARNING]${NC} $*"
}

log_success() {
  echo -e "${GREEN}[SUCCESS]${NC} $*"
}

# Check node resource pressure
check_node_pressure() {
  log "Checking node resource pressure..."

  kubectl get nodes -o json | jq -r '
    .items[] |
    "\(.metadata.name):
      MemoryPressure=\(.status.conditions[] | select(.type=="MemoryPressure") | .status)
      DiskPressure=\(.status.conditions[] | select(.type=="DiskPressure") | .status)
      PIDPressure=\(.status.conditions[] | select(.type=="PIDPressure") | .status)"
  '

  # Get nodes under pressure
  PRESSURE_NODES=$(kubectl get nodes -o json | \
    jq -r '.items[] |
      select(.status.conditions[] |
        select(.type=="MemoryPressure" or .type=="DiskPressure") |
        .status=="True") |
      .metadata.name')

  if [[ -n "$PRESSURE_NODES" ]]; then
    log_error "Nodes under pressure:"
    echo "$PRESSURE_NODES"
    return 1
  else
    log_success "No nodes under resource pressure"
    return 0
  fi
}

# Identify eviction candidates
identify_eviction_candidates() {
  log "Identifying eviction candidates (BestEffort pods)..."

  kubectl get pods -A -o json | \
    jq -r '.items[] |
      select(.status.qosClass=="BestEffort") |
      "\(.metadata.namespace)/\(.metadata.name)
        Node=\(.spec.nodeName)
        Age=\(.metadata.creationTimestamp)"' | \
    sort -k2
}

# Get resource usage by QoS class
resource_by_qos() {
  log "Resource usage by QoS class..."

  kubectl get pods -A -o json | \
    jq -r '.items[] |
      {
        namespace: .metadata.namespace,
        pod: .metadata.name,
        qos: .status.qosClass,
        node: .spec.nodeName
      }' | \
    jq -s 'group_by(.qos) |
      map({qos: .[0].qos, count: length})'
}

# Emergency eviction of BestEffort pods
emergency_evict_besteffort() {
  local NODE=$1

  log_warning "EMERGENCY: Evicting BestEffort pods from node $NODE"

  kubectl get pods -A --field-selector spec.nodeName="$NODE" -o json | \
    jq -r '.items[] |
      select(.status.qosClass=="BestEffort") |
      "\(.metadata.namespace) \(.metadata.name)"' | \
    while read namespace pod; do
      log "Evicting $namespace/$pod"
      kubectl delete pod -n "$namespace" "$pod" --grace-period=0 --force
    done
}

# Cordon and drain node
cordon_and_drain() {
  local NODE=$1

  log "Cordoning node $NODE..."
  kubectl cordon "$NODE"

  log "Draining node $NODE..."
  kubectl drain "$NODE" \
    --ignore-daemonsets \
    --delete-emptydir-data \
    --force \
    --grace-period=30 \
    --timeout=5m

  log_success "Node $NODE drained successfully"
}

# Main execution
log "======================================"
log "Resource Exhaustion Response"
log "======================================"

# Check for resource pressure
if ! check_node_pressure; then
  log_error "Resource pressure detected!"

  # Show current resource usage
  log "Current resource usage:"
  kubectl top nodes

  # Show QoS distribution
  resource_by_qos

  # Identify candidates for eviction
  identify_eviction_candidates

  read -p "Evict BestEffort pods from pressure nodes? (yes/no): " confirm
  if [[ "$confirm" == "yes" ]]; then
    for node in $PRESSURE_NODES; do
      emergency_evict_besteffort "$node"
    done
  fi

  # Check if draining is needed
  read -p "Drain nodes for maintenance? (yes/no): " drain_confirm
  if [[ "$drain_confirm" == "yes" ]]; then
    for node in $PRESSURE_NODES; do
      cordon_and_drain "$node"
    done
  fi
else
  log_success "All nodes healthy"
fi

log "Response complete"
```

## Capacity Planning and Right-Sizing

```bash
#!/bin/bash
# resource-rightsizing-analysis.sh
# Analyze actual resource usage to right-size requests/limits

set -euo pipefail

LOOKBACK_DAYS="${LOOKBACK_DAYS:-7}"
OUTPUT_FILE="/tmp/rightsizing-$(date +%Y%m%d).csv"

log() {
  echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"
}

log "Resource Right-Sizing Analysis"
log "Analyzing last $LOOKBACK_DAYS days of usage"
log "======================================"

# Query Prometheus for actual resource usage
query_prometheus() {
  local metric=$1
  local duration="${LOOKBACK_DAYS}d"

  curl -s -G "http://prometheus:9090/api/v1/query" \
    --data-urlencode "query=${metric}[${duration}]" | \
    jq -r '.data.result[]'
}

# CSV header
echo "namespace,pod,container,current_cpu_request,current_cpu_limit,p95_cpu_usage,current_mem_request,current_mem_limit,p95_mem_usage,recommendation" > "$OUTPUT_FILE"

# Get all pods
kubectl get pods -A -o json | \
  jq -r '.items[] |
    "\(.metadata.namespace) \(.metadata.name)
     \(.spec.containers[].name)
     \(.spec.containers[].resources.requests.cpu // "none")
     \(.spec.containers[].resources.limits.cpu // "none")
     \(.spec.containers[].resources.requests.memory // "none")
     \(.spec.containers[].resources.limits.memory // "none")"' | \
  while read namespace pod container cpu_req cpu_lim mem_req mem_lim; do

    # Query actual CPU usage (p95)
    cpu_p95=$(query_prometheus \
      "quantile_over_time(0.95, container_cpu_usage_seconds_total{namespace=\"$namespace\",pod=\"$pod\",container=\"$container\"}[${LOOKBACK_DAYS}d])")

    # Query actual memory usage (p95)
    mem_p95=$(query_prometheus \
      "quantile_over_time(0.95, container_memory_working_set_bytes{namespace=\"$namespace\",pod=\"$pod\",container=\"$container\"}[${LOOKBACK_DAYS}d])")

    # Generate recommendation
    if [[ "$cpu_req" != "none" ]] && [[ $(echo "$cpu_p95 > $cpu_req * 0.8" | bc -l) -eq 1 ]]; then
      recommendation="Increase CPU request"
    elif [[ "$cpu_req" != "none" ]] && [[ $(echo "$cpu_p95 < $cpu_req * 0.3" | bc -l) -eq 1 ]]; then
      recommendation="Decrease CPU request"
    elif [[ "$mem_req" != "none" ]] && [[ $(echo "$mem_p95 > $mem_req * 0.8" | bc -l) -eq 1 ]]; then
      recommendation="Increase memory request"
    elif [[ "$mem_req" != "none" ]] && [[ $(echo "$mem_p95 < $mem_req * 0.3" | bc -l) -eq 1 ]]; then
      recommendation="Decrease memory request"
    else
      recommendation="OK"
    fi

    echo "$namespace,$pod,$container,$cpu_req,$cpu_lim,$cpu_p95,$mem_req,$mem_lim,$mem_p95,$recommendation" >> "$OUTPUT_FILE"
  done

log "Analysis complete: $OUTPUT_FILE"

# Summary statistics
log "Summary:"
log "Pods needing CPU increase: $(grep "Increase CPU" "$OUTPUT_FILE" | wc -l)"
log "Pods needing CPU decrease: $(grep "Decrease CPU" "$OUTPUT_FILE" | wc -l)"
log "Pods needing memory increase: $(grep "Increase memory" "$OUTPUT_FILE" | wc -l)"
log "Pods needing memory decrease: $(grep "Decrease memory" "$OUTPUT_FILE" | wc -l)"
```

## Conclusion

Kubernetes QoS classes are fundamental to building resilient production systems. By properly configuring Guaranteed, Burstable, and BestEffort pods, organizations can:

1. **Ensure critical service availability** through Guaranteed QoS for databases and essential services
2. **Optimize resource utilization** with Burstable QoS for applications with variable load
3. **Maximize cluster efficiency** by using BestEffort for batch workloads on idle resources
4. **Survive resource pressure** through predictable eviction behavior
5. **Plan capacity effectively** with clear resource accounting

Key takeaways:

- Use Guaranteed QoS for critical stateful services
- Configure Burstable QoS for most application workloads
- Limit BestEffort pods to non-critical batch jobs
- Implement PriorityClasses to fine-tune eviction order
- Monitor resource pressure proactively
- Right-size resource requests based on actual usage
- Test eviction scenarios in non-production environments
- Maintain sufficient cluster capacity to handle node failures

Resource management is not set-and-forget—it requires continuous monitoring, analysis, and adjustment based on actual workload behavior and business priorities.