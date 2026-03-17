---
title: "Kubernetes PriorityClasses: Enterprise Workload Priority Classification and Preemption Design"
date: 2028-06-13T00:00:00-05:00
draft: false
tags: ["Kubernetes", "PriorityClass", "Scheduling", "Preemption", "Resource Management", "Production"]
categories: ["Kubernetes", "Resource Management"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Kubernetes PriorityClasses: workload tier design, preemption policies, system-cluster-critical vs system-node-critical, preventing priority inversion, and production-grade scheduling architecture."
more_link: "yes"
url: "/kubernetes-priority-class-workload-management-guide/"
---

Kubernetes scheduling determines which workloads run when cluster resources become constrained. Without deliberate priority classification, the scheduler treats all Pods as equals — a batch job can consume resources needed by a latency-sensitive API server, a development namespace can starve production workloads, and critical infrastructure Pods can fail to schedule during cluster events. PriorityClasses solve this by encoding business priority into the scheduler's decision-making framework.

This guide covers the complete design space: built-in system priority classes, multi-tier production architecture, preemption control, priority inversion prevention, and operational patterns for maintaining scheduling discipline in large clusters.

<!--more-->

## Understanding Kubernetes Scheduling Priority

### How Priority Affects Scheduling

When the Kubernetes scheduler receives a pending Pod, it evaluates feasibility (can this Pod fit on any node?) and then scores candidate nodes. If no node has sufficient resources, the scheduler enters preemption logic: it searches for nodes where evicting lower-priority Pods would free enough resources for the pending Pod.

Priority value is a 32-bit integer. Higher integers represent higher priority. The scheduler uses this value in two ways:

1. **Preemption eligibility**: A Pod with priority N can preempt Pods with priority less than N (subject to preemption policy and PodDisruptionBudgets)
2. **Queue ordering**: When multiple Pods are pending, higher-priority Pods are dequeued first

```
Priority Value Scale:
0                    →  Default (no PriorityClass)
1,000,000,000        →  system-node-critical (built-in)
2,000,000,000        →  system-cluster-critical (built-in)
2,147,483,647        →  Maximum int32 value
```

### Built-in System Priority Classes

Kubernetes ships with two pre-created PriorityClasses that cannot be deleted:

```bash
kubectl get priorityclasses
```

```
NAME                      VALUE        GLOBAL-DEFAULT   AGE
system-cluster-critical   2000000000   false            450d
system-node-critical      1000000000   false            450d
```

**system-cluster-critical** (value: 2,000,000,000): Reserved for cluster-level components that must run for the cluster to function correctly. Examples include CoreDNS, kube-dns, metrics-server, cluster-autoscaler, and any CNI plugin components. If these Pods fail to schedule, cluster-wide functionality degrades.

**system-node-critical** (value: 1,000,000,000): Reserved for per-node critical components. Examples include kube-proxy, node-local-dnscache, and log collection DaemonSets. These Pods must run on every node to maintain node-level services.

### The Default Priority Class

Any Pod without a `priorityClassName` receives value 0 (zero). Setting `globalDefault: true` on a PriorityClass assigns its value to all Pods that don't specify one explicitly. Only one PriorityClass can be the global default.

```yaml
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: default-workload
value: 100
globalDefault: true
description: "Default priority for workloads without explicit classification"
```

## Designing a Production Priority Tier Architecture

### Five-Tier Model

A practical enterprise design uses five tiers with large gaps between values to allow future insertion of intermediate classes:

```yaml
# Tier 5: Infrastructure (highest application priority)
# Reserved for application-critical infrastructure components
# Value: 900,000,000

# Tier 4: Production Critical
# Revenue-generating, SLA-bound services
# Value: 800,000,000

# Tier 3: Production Standard
# Production workloads without explicit SLA
# Value: 500,000,000

# Tier 2: Staging/QA
# Pre-production environments
# Value: 200,000,000

# Tier 1: Development/Batch
# Non-critical, preemptible workloads
# Value: 100,000
```

### Complete PriorityClass Definitions

```yaml
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: infrastructure-critical
  annotations:
    description: "Application-level infrastructure: databases, message queues, service mesh control planes"
    team: "platform"
value: 900000000
globalDefault: false
preemptionPolicy: PreemptLowerPriority
description: >-
  For application-level infrastructure components that supporting services
  depend on. Preempts all application tiers but not system-critical components.
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: production-critical
  annotations:
    description: "SLA-bound production services with direct revenue impact"
    team: "platform"
value: 800000000
globalDefault: false
preemptionPolicy: PreemptLowerPriority
description: >-
  Revenue-generating services with defined SLAs. These Pods will preempt
  production-standard and lower tiers when resources are constrained.
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: production-standard
  annotations:
    description: "Standard production workloads"
    team: "platform"
value: 500000000
globalDefault: false
preemptionPolicy: PreemptLowerPriority
description: >-
  Standard production workloads. Will preempt staging and development
  workloads. Use production-critical for services with explicit SLAs.
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: staging
  annotations:
    description: "Pre-production staging and QA environments"
    team: "platform"
value: 200000000
globalDefault: false
preemptionPolicy: PreemptLowerPriority
description: >-
  Pre-production environments. Will preempt development and batch workloads
  but yields to all production tiers.
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: development
  annotations:
    description: "Development environments and non-critical batch jobs"
    team: "platform"
value: 100000
globalDefault: false
preemptionPolicy: PreemptLowerPriority
description: >-
  Development workloads and batch jobs. These Pods are first candidates for
  preemption when production workloads need resources.
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: best-effort-batch
  annotations:
    description: "Opportunistic batch jobs that should never preempt other workloads"
    team: "platform"
value: 1
globalDefault: false
preemptionPolicy: Never
description: >-
  Batch jobs that run opportunistically on spare capacity. Never preempts
  other Pods. Suitable for data analytics, ML training, and background tasks.
```

### Enforcing Priority Class Assignment with OPA/Gatekeeper

Without enforcement, teams can assign any PriorityClass. Use OPA Gatekeeper to restrict which namespaces can use which priority tiers:

```yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8sallowedpriorityclasses
spec:
  crd:
    spec:
      names:
        kind: K8sAllowedPriorityClasses
      validation:
        openAPIV3Schema:
          type: object
          properties:
            allowedPriorityClasses:
              type: array
              items:
                type: string
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8sallowedpriorityclasses

        violation[{"msg": msg}] {
          input.review.kind.kind == "Pod"
          pc := input.review.object.spec.priorityClassName
          allowed := input.parameters.allowedPriorityClasses
          not contains(allowed, pc)
          msg := sprintf(
            "Pod %v in namespace %v uses PriorityClass %v which is not allowed. Allowed classes: %v",
            [input.review.object.metadata.name, input.review.object.metadata.namespace, pc, allowed]
          )
        }

        contains(arr, elem) {
          arr[_] == elem
        }
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sAllowedPriorityClasses
metadata:
  name: development-namespace-priority-restriction
spec:
  match:
    namespaceSelector:
      matchLabels:
        environment: development
  parameters:
    allowedPriorityClasses:
      - development
      - best-effort-batch
      - ""
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sAllowedPriorityClasses
metadata:
  name: production-namespace-priority-restriction
spec:
  match:
    namespaceSelector:
      matchLabels:
        environment: production
  parameters:
    allowedPriorityClasses:
      - production-critical
      - production-standard
      - infrastructure-critical
      - ""
```

## Preemption Policy Deep Dive

### PreemptLowerPriority vs Never

The `preemptionPolicy` field controls whether a pending Pod is allowed to preempt running Pods:

**PreemptLowerPriority** (default): The Pod can trigger preemption of lower-priority Pods. When the scheduler cannot find a feasible node, it searches for nodes where evicting lower-priority Pods would create room.

**Never**: The Pod will not trigger preemption. It waits in the scheduling queue until resources become available naturally (scale-out event, other Pods terminate normally). This is appropriate for batch jobs that should not disrupt running workloads.

```yaml
# Preemptible batch job - never causes disruption
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: batch-non-preempting
value: 50000
preemptionPolicy: Never
globalDefault: false
description: "Batch workloads that should never preempt running Pods"
```

### How Preemption Works in Practice

When a Pod with `PreemptLowerPriority` policy cannot be scheduled:

1. Scheduler identifies nodes where removing lower-priority Pods would allow the pending Pod to fit
2. Scheduler selects the node with minimal disruption (fewest Pods to evict, lowest priority victims)
3. Scheduler sets the `nominatedNodeName` field on the pending Pod
4. Lower-priority Pods receive termination signals (respecting graceful termination periods)
5. Once victim Pods terminate, the scheduler places the pending Pod on that node

The nominated node is not guaranteed — other higher-priority Pods could claim the freed space before the original Pod is placed. The scheduler re-evaluates placement at actual scheduling time.

```bash
# Observe preemption events
kubectl get events --field-selector reason=Preempting -A

# Check nominatedNodeName on pending Pods
kubectl get pod pending-pod -n production -o jsonpath='{.status.nominatedNodeName}'

# View eviction events
kubectl get events --field-selector reason=Evicted -A --sort-by=.metadata.creationTimestamp
```

### PodDisruptionBudgets and Preemption

PodDisruptionBudgets (PDBs) limit the number of Pods that can be simultaneously disrupted, but they interact with preemption in a nuanced way:

- Kubernetes 1.22+ respects PDBs during preemption as a best-effort consideration
- If the scheduler cannot find a preemption target that respects all PDBs, it may still proceed with preemption when necessary for critical Pods
- system-cluster-critical and system-node-critical Pods can override PDB constraints

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-server-pdb
  namespace: production
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: api-server
      tier: production-critical
```

## Preventing Priority Inversion

### What Is Priority Inversion?

Priority inversion occurs when a high-priority task is blocked waiting on a low-priority task that holds a shared resource. In Kubernetes, this manifests as:

1. A low-priority Pod holds a PersistentVolumeClaim that a high-priority Pod needs
2. A low-priority Pod occupies the only node with a required hardware resource (GPU, specific topology)
3. A low-priority Pod is part of a service that a high-priority Pod depends on

### Resource Ownership Design

Design resource ownership to minimize cross-priority dependencies:

```yaml
# StorageClass with priority-aware provisioning
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: production-nvme
  annotations:
    description: "NVMe storage reserved for production-critical workloads"
provisioner: ebs.csi.aws.com
parameters:
  type: io2
  iops: "10000"
  encrypted: "true"
reclaimPolicy: Retain
volumeBindingMode: WaitForFirstConsumer
allowedTopologies:
- matchLabelExpressions:
  - key: node-tier
    values:
    - production
```

```yaml
# ResourceQuota to reserve capacity for high-priority namespaces
apiVersion: v1
kind: ResourceQuota
metadata:
  name: production-reserved
  namespace: production-critical
spec:
  hard:
    requests.cpu: "200"
    requests.memory: "400Gi"
    pods: "500"
    # Ensure production workloads don't crowd each other
    count/priorityclass.scheduling.k8s.io/production-critical: "200"
```

### Node Affinity for Priority Tier Separation

Physically separate critical workloads from lower-priority ones to prevent resource contention:

```yaml
# Node labels for tier separation
# kubectl label node node-01 workload-tier=production-critical

apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-api
  namespace: production
spec:
  template:
    spec:
      priorityClassName: production-critical
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            - matchExpressions:
              - key: workload-tier
                operator: In
                values:
                - production-critical
                - production-standard
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            preference:
              matchExpressions:
              - key: workload-tier
                operator: In
                values:
                - production-critical
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchLabels:
                workload-tier: development
            topologyKey: kubernetes.io/hostname
      containers:
      - name: payment-api
        image: payment-api:v2.14.3
        resources:
          requests:
            cpu: "2"
            memory: "4Gi"
          limits:
            cpu: "4"
            memory: "8Gi"
```

### Taint/Toleration Enforcement

Combine PriorityClasses with taints to hard-separate workload tiers:

```bash
# Taint nodes for production-critical workloads only
kubectl taint nodes node-prod-01 workload-tier=production-critical:NoSchedule
kubectl taint nodes node-prod-02 workload-tier=production-critical:NoSchedule

# Taint batch worker nodes
kubectl taint nodes node-batch-01 workload-tier=batch:NoSchedule
```

```yaml
# Only production-critical Pods can schedule on production nodes
spec:
  priorityClassName: production-critical
  tolerations:
  - key: "workload-tier"
    operator: "Equal"
    value: "production-critical"
    effect: "NoSchedule"
```

## Production Workload Examples

### Database Tier (infrastructure-critical)

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres-primary
  namespace: data-platform
spec:
  serviceName: postgres
  replicas: 3
  template:
    spec:
      priorityClassName: infrastructure-critical
      terminationGracePeriodSeconds: 120
      containers:
      - name: postgres
        image: postgres:16.2
        resources:
          requests:
            cpu: "4"
            memory: "16Gi"
          limits:
            cpu: "8"
            memory: "32Gi"
        env:
        - name: POSTGRES_DB
          value: "appdb"
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: postgres
```

### Batch Analytics (best-effort-batch with Never preemption)

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: nightly-analytics-aggregation
  namespace: analytics
spec:
  parallelism: 10
  completions: 100
  backoffLimit: 3
  template:
    spec:
      priorityClassName: best-effort-batch
      restartPolicy: OnFailure
      # Long graceful termination to handle preemption gracefully
      terminationGracePeriodSeconds: 300
      containers:
      - name: analytics-worker
        image: analytics-worker:v3.1.0
        resources:
          requests:
            cpu: "1"
            memory: "2Gi"
          limits:
            cpu: "2"
            memory: "4Gi"
        lifecycle:
          preStop:
            exec:
              # Checkpoint progress before termination
              command: ["/bin/sh", "-c", "kill -SIGTERM 1 && sleep 290"]
```

### API Gateway (production-critical)

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-gateway
  namespace: production
spec:
  replicas: 6
  template:
    spec:
      priorityClassName: production-critical
      terminationGracePeriodSeconds: 60
      containers:
      - name: gateway
        image: envoyproxy/envoy:v1.29.0
        resources:
          requests:
            cpu: "500m"
            memory: "512Mi"
          limits:
            cpu: "2"
            memory: "2Gi"
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: kubernetes.io/hostname
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: api-gateway
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: ScheduleAnyway
        labelSelector:
          matchLabels:
            app: api-gateway
```

## Monitoring Priority and Preemption

### Key Metrics to Track

```yaml
# Prometheus recording rules for priority class monitoring
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: priority-class-monitoring
  namespace: monitoring
spec:
  groups:
  - name: priority-class.rules
    interval: 30s
    rules:
    - record: cluster:pods_by_priority_class:count
      expr: |
        count by (priority_class) (
          kube_pod_info * on(pod, namespace) group_left(priority_class)
          kube_pod_spec_priority_class
        )
    - record: cluster:pending_pods_by_priority:count
      expr: |
        count by (priority_class) (
          kube_pod_status_phase{phase="Pending"} * on(pod, namespace) group_left(priority_class)
          kube_pod_spec_priority_class
        )
    - alert: HighPriorityPodPendingTooLong
      expr: |
        (
          kube_pod_status_phase{phase="Pending"} * on(pod, namespace) group_left(priority_class)
          kube_pod_spec_priority_class{priority_class=~"production-critical|infrastructure-critical"}
        ) > 0
      for: 5m
      labels:
        severity: critical
        team: platform
      annotations:
        summary: "High priority Pod {{ $labels.pod }} has been pending for more than 5 minutes"
        description: "Pod {{ $labels.namespace }}/{{ $labels.pod }} with priority class {{ $labels.priority_class }} has been in Pending state for over 5 minutes. Investigate scheduler events and node capacity."
    - alert: PreemptionEventRate
      expr: |
        increase(scheduler_pod_preemption_victims_total[5m]) > 10
      for: 2m
      labels:
        severity: warning
        team: platform
      annotations:
        summary: "High preemption rate detected"
        description: "More than 10 Pods have been preempted in the last 5 minutes. This may indicate insufficient cluster capacity."
```

### Grafana Dashboard Queries

```promql
# Pods by priority class over time
sum by (priority_class) (
  kube_pod_info * on(pod, namespace) group_left(priority_class)
  kube_pod_spec_priority_class
)

# Preemption events rate
rate(scheduler_pod_preemption_victims_total[5m])

# Scheduling latency by priority class
histogram_quantile(0.99,
  sum by (priority_class, le) (
    scheduler_pod_scheduling_duration_seconds_bucket * on(pod, namespace) group_left(priority_class)
    kube_pod_spec_priority_class
  )
)

# Pending pods per priority class
sum by (priority_class) (
  kube_pod_status_phase{phase="Pending"} * on(pod, namespace) group_left(priority_class)
  kube_pod_spec_priority_class
)
```

### Scheduler Event Analysis

```bash
# Find preemption events in the last hour
kubectl get events -A \
  --field-selector reason=Preempting \
  --sort-by=.metadata.creationTimestamp | \
  tail -20

# Analyze which Pods are being preempted
kubectl get events -A -o json | \
  jq '.items[] | select(.reason == "Preempted") | {
    namespace: .involvedObject.namespace,
    pod: .involvedObject.name,
    message: .message,
    time: .lastTimestamp
  }'

# Check scheduler logs for priority decisions
kubectl logs -n kube-system \
  -l component=kube-scheduler \
  --since=1h | \
  grep -E "preempt|evict|priority" | \
  head -50

# Resource usage per priority class (requires kube-state-metrics)
kubectl top pods -A --sort-by=cpu | head -30
```

## Advanced Patterns

### Dynamic Priority with VPA Integration

When using Vertical Pod Autoscaler, ensure VPA recommendations account for the priority tier. Higher-priority Pods should have more generous resource recommendations to avoid being under-resourced:

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: payment-api-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: "apps/v1"
    kind: Deployment
    name: payment-api
  updatePolicy:
    updateMode: "Auto"
  resourcePolicy:
    containerPolicies:
    - containerName: payment-api
      minAllowed:
        cpu: 500m
        memory: 512Mi
      maxAllowed:
        cpu: 8
        memory: 16Gi
      # Ensure high-priority Pods always have adequate resources
      controlledValues: RequestsAndLimits
```

### Priority-Aware Cluster Autoscaler Configuration

Configure Cluster Autoscaler to scale based on pending high-priority Pods aggressively and not scale down nodes running critical workloads:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: cluster-autoscaler-status
  namespace: kube-system
data:
  # Cluster Autoscaler configuration via annotation on node groups
  # See: cluster.k8s.io/cluster-autoscaler.kubernetes.io/safe-to-evict
  config.yaml: |
    expanderPriorities:
      production-node-group: 100
      standard-node-group: 50
      batch-node-group: 10
```

```bash
# Annotate critical Pods to prevent autoscaler from evicting their nodes
kubectl annotate pod postgres-primary-0 \
  cluster-autoscaler.kubernetes.io/safe-to-evict="false" \
  -n data-platform

# Mark batch Pods as safe to evict for scale-down
kubectl annotate deployment batch-worker \
  cluster-autoscaler.kubernetes.io/safe-to-evict="true" \
  -n analytics
```

### Multi-Tenant Priority Isolation

In multi-tenant clusters, isolate tenant priority classes to prevent tenants from using system-critical values:

```yaml
# Namespace-scoped LimitRange to cap effective priority
# Note: LimitRange cannot directly limit PriorityClass values,
# but can be combined with webhook admission to enforce this

# ValidatingWebhookConfiguration to enforce priority limits per namespace
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingWebhookConfiguration
metadata:
  name: priority-class-validator
webhooks:
- name: validate.priorityclass.support.tools
  clientConfig:
    service:
      name: priority-validator
      namespace: platform-system
      path: "/validate-priority"
  rules:
  - apiGroups: [""]
    apiVersions: ["v1"]
    operations: ["CREATE", "UPDATE"]
    resources: ["pods"]
  namespaceSelector:
    matchLabels:
      tenant: "true"
  admissionReviewVersions: ["v1"]
  sideEffects: None
  failurePolicy: Fail
```

## Troubleshooting Priority Issues

### Diagnosing Scheduling Failures

```bash
# Describe a pending Pod to see scheduling events
kubectl describe pod my-pending-pod -n production

# Look for priority-related messages in events
kubectl describe pod my-pending-pod -n production | \
  grep -A5 "Events:"

# Check if preemption candidates exist
kubectl get pod -A \
  -o custom-columns='NAMESPACE:.metadata.namespace,NAME:.metadata.name,PRIORITY:.spec.priority,STATUS:.status.phase' | \
  sort -k3 -n | head -20
```

### Debugging Preemption Not Triggering

If a high-priority Pod is not preempting lower-priority Pods:

```bash
# Verify the Pod's priority class is set correctly
kubectl get pod pending-pod -n production \
  -o jsonpath='{.spec.priorityClassName}{"\n"}{.spec.priority}'

# Check if all lower-priority Pods on candidate nodes have PDBs blocking eviction
kubectl get pdb -A -o custom-columns=\
'NAMESPACE:.metadata.namespace,NAME:.metadata.name,MIN-AVAILABLE:.spec.minAvailable,DISRUPTIONS-ALLOWED:.status.disruptionsAllowed'

# Verify the PriorityClass exists and has the correct value
kubectl get priorityclass production-critical \
  -o jsonpath='{.value}'

# Check scheduler logs for preemption attempts
kubectl logs -n kube-system \
  $(kubectl get pods -n kube-system -l component=kube-scheduler -o name | head -1) \
  --since=30m | grep -i "preempt"
```

### Common Mistakes

**Setting globalDefault on a high-priority class**: This elevates all unclassified Pods to high priority, defeating the purpose of tiering. Always set globalDefault on a low-to-medium priority class or leave it unset.

**Forgetting to update DaemonSet priority**: DaemonSets often need high priority since they run on every node. Check that critical DaemonSets (log collectors, monitoring agents, CNI components) use appropriate PriorityClasses.

**Not setting terminationGracePeriodSeconds for preemption victims**: Pods receiving preemption SIGTERM signals should have sufficient grace periods to checkpoint state or complete in-flight operations.

```yaml
# Good: Long grace period for stateful workloads
spec:
  terminationGracePeriodSeconds: 120
  priorityClassName: production-standard

# Bad: Default 30s may cause data loss for databases
spec:
  terminationGracePeriodSeconds: 30
  priorityClassName: infrastructure-critical
```

## Summary

Kubernetes PriorityClasses enable production teams to encode business priority directly into the scheduler. Key takeaways for production deployment:

- Reserve system-cluster-critical and system-node-critical for Kubernetes infrastructure only
- Use large gaps between priority values (100x minimum) to allow future class insertion
- Combine PriorityClasses with OPA/Gatekeeper to enforce tier boundaries per namespace
- Set `preemptionPolicy: Never` for batch jobs that should not disrupt running workloads
- Monitor preemption rate as a signal for insufficient cluster capacity
- Pair priority tiers with node taints and affinity rules for physical separation
- Ensure batch and development workloads have adequate termination grace periods to handle preemption gracefully

The five-tier model (infrastructure-critical, production-critical, production-standard, staging, development/batch) covers most enterprise scheduling requirements and provides clear guidelines for workload classification across teams.
