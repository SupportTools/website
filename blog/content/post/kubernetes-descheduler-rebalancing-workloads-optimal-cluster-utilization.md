---
title: "Kubernetes Descheduler: Rebalancing Workloads for Optimal Cluster Utilization"
date: 2028-12-26T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Descheduler", "Scheduling", "Cluster Optimization", "Resource Management", "Platform Engineering"]
categories:
- Kubernetes
- Platform Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to the Kubernetes Descheduler, covering plugin-based eviction strategies, Node utilization rebalancing, topology constraint enforcement, and safe deployment patterns for enterprise clusters."
more_link: "yes"
url: "/kubernetes-descheduler-rebalancing-workloads-optimal-cluster-utilization/"
---

The Kubernetes scheduler makes optimal decisions given cluster state at the moment a pod needs placement. It cannot retroactively fix placements that become suboptimal over time as nodes join or leave, workloads scale, node conditions change, or topology constraints drift from their ideal state. The Descheduler fills this gap: it runs periodically, identifies pods that violate scheduling policies or occupy suboptimal positions, and evicts them to allow the scheduler to place them better. Done correctly, descheduling improves cluster utilization, reduces hot spots, and maintains topology diversity without manual intervention.

<!--more-->

## Descheduler Architecture

The Descheduler is not a replacement for the scheduler — it is a complementary component that enforces long-term placement invariants. It operates in one of three modes:

- **Job**: A one-shot Kubernetes Job, useful for manual rebalancing
- **CronJob**: Scheduled periodic runs (most common for production)
- **Deployment**: Continuous background operation with a configurable interval

The Descheduler reads pod placement state, evaluates configured plugins, and evicts pods that fail plugin criteria. Evicted pods are immediately re-scheduled by the standard Kubernetes scheduler.

```yaml
# descheduler-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: descheduler
  namespace: kube-system
spec:
  replicas: 1
  selector:
    matchLabels:
      app: descheduler
  template:
    metadata:
      labels:
        app: descheduler
    spec:
      serviceAccountName: descheduler
      priorityClassName: system-cluster-critical
      containers:
      - name: descheduler
        image: registry.k8s.io/descheduler/descheduler:v0.30.0
        command:
        - /bin/descheduler
        args:
        - --policy-config-file=/policy-dir/policy.yaml
        - --descheduling-interval=5m
        - --v=3
        ports:
        - containerPort: 10258
          name: metrics
        livenessProbe:
          failureThreshold: 3
          httpGet:
            path: /healthz
            port: 10258
            scheme: HTTPS
          initialDelaySeconds: 3
          periodSeconds: 10
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 512Mi
        securityContext:
          allowPrivilegeEscalation: false
          capabilities:
            drop:
            - ALL
          privileged: false
          readOnlyRootFilesystem: true
          runAsNonRoot: true
          runAsUser: 1000
          seccompProfile:
            type: RuntimeDefault
        volumeMounts:
        - mountPath: /policy-dir
          name: policy-volume
      volumes:
      - name: policy-volume
        configMap:
          name: descheduler-policy
      nodeSelector:
        kubernetes.io/os: linux
      tolerations:
      - key: node-role.kubernetes.io/control-plane
        operator: Exists
        effect: NoSchedule
```

### RBAC Configuration

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: descheduler
  namespace: kube-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: descheduler
rules:
- apiGroups: [""]
  resources: ["events"]
  verbs: ["create", "update"]
- apiGroups: [""]
  resources: ["nodes"]
  verbs: ["get", "watch", "list"]
- apiGroups: [""]
  resources: ["namespaces"]
  verbs: ["get", "watch", "list"]
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "watch", "list", "delete"]
- apiGroups: [""]
  resources: ["pods/eviction"]
  verbs: ["create"]
- apiGroups: ["scheduling.k8s.io"]
  resources: ["priorityclasses"]
  verbs: ["get", "watch", "list"]
- apiGroups: ["policy"]
  resources: ["poddisruptionbudgets"]
  verbs: ["get", "watch", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: descheduler
subjects:
- kind: ServiceAccount
  name: descheduler
  namespace: kube-system
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: descheduler
```

## Policy Configuration

The policy file controls which plugins run and how aggressively they evict pods. The key is balancing thoroughness against cluster stability:

```yaml
# descheduler-policy.yaml
apiVersion: "descheduler/v1alpha2"
kind: "DeschedulerPolicy"

# Global profile: applies to all plugins unless overridden
profiles:
- name: default
  pluginConfig:
  # =========================================================
  # 1. LowNodeUtilization: Move pods from under-utilized nodes
  #    to well-utilized ones, reducing resource fragmentation
  # =========================================================
  - name: LowNodeUtilization
    args:
      thresholds:
        cpu: 20       # Nodes using <20% CPU are "under-utilized"
        memory: 20    # Nodes using <20% memory are "under-utilized"
        pods: 20      # Nodes running <20% max pods are "under-utilized"
      targetThresholds:
        cpu: 50       # Target nodes using <50% CPU to receive evicted pods
        memory: 50
        pods: 50
      useDeviationThresholds: false
      numberOfNodes: 1   # At least 1 under-utilized node required to trigger

  # =========================================================
  # 2. HighNodeUtilization: The opposite — pack pods tighter
  #    to enable scale-down of lightly loaded nodes
  #    Use with cluster autoscaler
  # =========================================================
  # - name: HighNodeUtilization
  #   args:
  #     thresholds:
  #       cpu: 20
  #       memory: 20

  # =========================================================
  # 3. RemoveDuplicates: Spread replicas of the same deployment
  #    across nodes when they were placed on the same node
  # =========================================================
  - name: RemoveDuplicates
    args:
      excludeOwnerKinds:
      - "ReplicaSet"   # Skip if managed by ReplicaSet (use TopologySpread instead)
      # namespaces:
      #   include: ["production"]

  # =========================================================
  # 4. RemovePodsViolatingInterPodAntiAffinity
  #    Evicts pods that now violate anti-affinity rules
  #    (typically occurs after node failures + rescheduling)
  # =========================================================
  - name: RemovePodsViolatingInterPodAntiAffinity

  # =========================================================
  # 5. RemovePodsViolatingNodeAffinity
  #    Evicts pods placed on nodes that no longer satisfy
  #    their nodeAffinity requirements (e.g., after label changes)
  # =========================================================
  - name: RemovePodsViolatingNodeAffinity
    args:
      nodeAffinityType:
      - "requiredDuringSchedulingIgnoredDuringExecution"

  # =========================================================
  # 6. RemovePodsViolatingNodeTaints
  #    Evicts pods on nodes with NoSchedule taints that the
  #    pod does not tolerate
  # =========================================================
  - name: RemovePodsViolatingNodeTaints

  # =========================================================
  # 7. RemovePodsViolatingTopologySpreadConstraint
  #    Re-balances pods that violate TopologySpreadConstraints
  #    after cluster state changes
  # =========================================================
  - name: RemovePodsViolatingTopologySpreadConstraint
    args:
      includeSoftConstraints: false  # Only enforce hard constraints
      constraints:
      - DoNotSchedule  # Only evict for hard violations

  # =========================================================
  # 8. RemovePodsHavingTooManyRestarts
  #    Evict crashlooping pods to allow them to land on
  #    different nodes (may resolve node-local issues)
  # =========================================================
  - name: RemovePodsHavingTooManyRestarts
    args:
      podRestartThreshold: 100
      includingInitContainers: true

  # =========================================================
  # 9. PodLifeTime: Evict long-running pods in non-production
  #    namespaces to enforce refresh cycles
  # =========================================================
  - name: PodLifeTime
    args:
      maxPodLifeTimeSeconds: 604800  # 7 days
      namespaces:
        include:
        - staging
        - testing
      states:
      - Running
      - Pending

  plugins:
    balance:
      enabled:
      - LowNodeUtilization
      - RemoveDuplicates
      - RemovePodsViolatingTopologySpreadConstraint
    deschedule:
      enabled:
      - RemovePodsViolatingInterPodAntiAffinity
      - RemovePodsViolatingNodeAffinity
      - RemovePodsViolatingNodeTaints
      - RemovePodsHavingTooManyRestarts
      - PodLifeTime
```

## Profile Separation: Production vs Non-Production

Applying the same descheduling policy to production and staging workloads is dangerous. Profile-based configuration allows different aggressiveness per namespace:

```yaml
# descheduler-policy-multiprofile.yaml
apiVersion: "descheduler/v1alpha2"
kind: "DeschedulerPolicy"

profiles:
# Production profile: conservative, only fix violations
- name: production
  pluginConfig:
  - name: RemovePodsViolatingInterPodAntiAffinity
  - name: RemovePodsViolatingNodeAffinity
    args:
      nodeAffinityType:
      - "requiredDuringSchedulingIgnoredDuringExecution"
  - name: RemovePodsViolatingNodeTaints
  - name: RemovePodsViolatingTopologySpreadConstraint
    args:
      includeSoftConstraints: false
  plugins:
    deschedule:
      enabled:
      - RemovePodsViolatingInterPodAntiAffinity
      - RemovePodsViolatingNodeAffinity
      - RemovePodsViolatingNodeTaints
      - RemovePodsViolatingTopologySpreadConstraint
  namespaces:
    include:
    - production
    - prod-.*   # Regex matching

# Non-production: aggressive rebalancing and lifecycle enforcement
- name: non-production
  pluginConfig:
  - name: LowNodeUtilization
    args:
      thresholds:
        cpu: 30
        memory: 30
        pods: 30
      targetThresholds:
        cpu: 60
        memory: 60
        pods: 60
  - name: RemoveDuplicates
  - name: PodLifeTime
    args:
      maxPodLifeTimeSeconds: 172800  # 2 days in staging
      states:
      - Running
  - name: RemovePodsHavingTooManyRestarts
    args:
      podRestartThreshold: 25
  plugins:
    balance:
      enabled:
      - LowNodeUtilization
      - RemoveDuplicates
    deschedule:
      enabled:
      - PodLifeTime
      - RemovePodsHavingTooManyRestarts
  namespaces:
    include:
    - staging
    - testing
    - development
    - review-.*
```

## Protecting Critical Workloads from Eviction

The Descheduler respects PodDisruptionBudgets and several annotations:

```bash
# Exclude a specific pod from descheduling
kubectl annotate pod critical-payment-processor-7d9f8b \
  descheduler.alpha.kubernetes.io/evict="false" \
  -n production

# Exclude all pods in a namespace
kubectl annotate namespace kube-system \
  descheduler.alpha.kubernetes.io/namespace-evict="false"
```

### PodDisruptionBudget Integration

The Descheduler respects PDBs during eviction. Workloads with strict PDBs are protected:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: payment-service-pdb
  namespace: production
spec:
  selector:
    matchLabels:
      app: payment-service
  minAvailable: "80%"    # Keep at least 80% of replicas running
---
# For StatefulSets with strict quorum requirements
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: postgres-primary-pdb
  namespace: production
spec:
  selector:
    matchLabels:
      app: postgres
      role: primary
  minAvailable: 1         # Never evict the primary
```

## Monitoring Descheduler Activity

```bash
# Check descheduler logs for eviction activity
kubectl logs -n kube-system -l app=descheduler --tail=100 | \
  grep -E "Evicted|eviction|Error|error"

# Count evictions per plugin in the last hour
kubectl logs -n kube-system -l app=descheduler \
  --since=1h | grep "Evicted pod" | \
  grep -oP 'plugin=\K\S+' | sort | uniq -c | sort -rn

# Watch eviction events in real time
kubectl get events -A \
  --field-selector reason=Evicted \
  --watch
```

### Prometheus Metrics

The Descheduler exposes metrics on port 10258:

```yaml
# prometheus-servicemonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: descheduler
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: descheduler
  endpoints:
  - port: metrics
    scheme: https
    tlsConfig:
      insecureSkipVerify: true
    interval: 30s
---
# descheduler-alerts.yaml
groups:
- name: descheduler
  rules:
  - alert: DeschedulerEvictionRateHigh
    expr: |
      rate(descheduler_pods_evicted_total[10m]) > 0.5
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "Descheduler evicting pods at high rate: {{ $value | humanize }}/s"
      description: "High eviction rate may indicate cluster instability or misconfigured policy."

  - alert: DeschedulerEvictionsFailed
    expr: |
      rate(descheduler_evictions_failed_total[10m]) > 0
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "Descheduler evictions failing"
      description: "Eviction failures may indicate PDB violations or API server issues."

  - record: descheduler:evictions_by_plugin:rate10m
    expr: |
      sum by (plugin, result) (
        rate(descheduler_pods_evicted_total[10m])
      )
```

## LowNodeUtilization Deep Dive

LowNodeUtilization is the most impactful plugin but also the most dangerous if misconfigured. Understanding how it calculates utilization is essential:

```bash
# What LowNodeUtilization considers "utilization"
# It uses REQUESTED resources, not actual usage
# This matters: a node with 5% actual CPU but 80% requested is "utilized"

# Check node requested vs allocatable
kubectl describe node worker-node-1 | grep -A10 "Allocated resources"
# Resource           Requests      Limits
# --------           --------      ------
# cpu                3800m (47%)   7200m (90%)
# memory             6Gi (40%)     14Gi (93%)
# ephemeral-storage  0 (0%)        0 (0%)
# hugepages-1Gi      0 (0%)        0 (0%)
# hugepages-2Mi      0 (0%)        0 (0%)
# Pods               28 (25%)      (not set)

# A node is "under-utilized" only if ALL configured dimensions are below threshold
# Default: cpu AND memory AND pods all < threshold
```

### useDeviationThresholds Mode

Standard thresholds use absolute percentages. Deviation thresholds calculate relative to cluster average, adapting to heterogeneous node sizes:

```yaml
- name: LowNodeUtilization
  args:
    useDeviationThresholds: true
    thresholds:
      cpu: 10       # Evict from nodes >10% below cluster average CPU utilization
      memory: 10
    targetThresholds:
      cpu: 10       # Move to nodes <10% above cluster average
      memory: 10
    numberOfNodes: 2   # Require at least 2 under-utilized nodes
```

## TopologySpreadConstraint Remediation

This plugin is particularly valuable in environments where pods drift from balanced zone distribution after node failures:

```yaml
# Application deployment with topology spread
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-service
  namespace: production
spec:
  replicas: 12
  template:
    spec:
      topologySpreadConstraints:
      # Spread evenly across zones (hard constraint)
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: api-service
      # Spread across nodes within each zone (soft constraint)
      - maxSkew: 2
        topologyKey: kubernetes.io/hostname
        whenUnsatisfiable: ScheduleAnyway
        labelSelector:
          matchLabels:
            app: api-service
```

```bash
# Verify topology spread after descheduler runs
kubectl get pods -n production -l app=api-service \
  -o custom-columns='NAME:.metadata.name,NODE:.spec.nodeName,ZONE:.metadata.labels.topology\.kubernetes\.io/zone' | \
  awk 'NR>1 {print $3}' | sort | uniq -c

# Expected output (3 zones, 12 pods = 4 per zone):
#   4 us-east-1a
#   4 us-east-1b
#   4 us-east-1c

# If zone skew > maxSkew, descheduler should evict and rebalance
```

## Helm Deployment

```yaml
# descheduler-helm-values.yaml
replicas: 1

image:
  repository: registry.k8s.io/descheduler/descheduler
  tag: "v0.30.0"

schedule: "*/5 * * * *"   # Run every 5 minutes as CronJob

deschedulingInterval: 0s   # Only relevant for deployment mode

resources:
  requests:
    cpu: 100m
    memory: 128Mi
  limits:
    cpu: 500m
    memory: 512Mi

priorityClassName: system-cluster-critical

podAnnotations:
  prometheus.io/scrape: "true"
  prometheus.io/port: "10258"
  prometheus.io/scheme: "https"

deschedulerPolicy:
  profiles:
  - name: default
    pluginConfig:
    - name: LowNodeUtilization
      args:
        thresholds:
          cpu: 20
          memory: 20
          pods: 20
        targetThresholds:
          cpu: 50
          memory: 50
          pods: 50
    - name: RemovePodsViolatingInterPodAntiAffinity
    - name: RemovePodsViolatingNodeAffinity
      args:
        nodeAffinityType:
        - "requiredDuringSchedulingIgnoredDuringExecution"
    - name: RemovePodsViolatingTopologySpreadConstraint
      args:
        includeSoftConstraints: false
    plugins:
      balance:
        enabled:
        - LowNodeUtilization
      deschedule:
        enabled:
        - RemovePodsViolatingInterPodAntiAffinity
        - RemovePodsViolatingNodeAffinity
        - RemovePodsViolatingTopologySpreadConstraint
```

```bash
helm repo add descheduler https://kubernetes-sigs.github.io/descheduler/
helm repo update

helm upgrade --install descheduler descheduler/descheduler \
  --namespace kube-system \
  --values descheduler-helm-values.yaml \
  --version 0.30.0
```

## Testing Descheduler Behavior

Before enabling descheduler in production, validate its behavior in a staging environment with a dry run:

```bash
# Dry run: see what would be evicted without actually evicting
kubectl create -n kube-system -f - <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: descheduler-dryrun
  namespace: kube-system
spec:
  serviceAccountName: descheduler
  restartPolicy: Never
  containers:
  - name: descheduler
    image: registry.k8s.io/descheduler/descheduler:v0.30.0
    command:
    - /bin/descheduler
    args:
    - --policy-config-file=/policy-dir/policy.yaml
    - --dry-run=true
    - --v=4
    volumeMounts:
    - mountPath: /policy-dir
      name: policy-volume
  volumes:
  - name: policy-volume
    configMap:
      name: descheduler-policy
EOF

kubectl logs -n kube-system descheduler-dryrun --follow
# Look for lines like:
# "Evicting pod (dry run)" pod=production/api-service-7d9f8b node=worker-node-3
# "Node is underutilized" node=worker-node-1 cpu=12.3% memory=15.7%
```

The Descheduler complements the Kubernetes scheduler by addressing placement drift over time. Conservative configuration targeting only topology and affinity violations provides immediate value with minimal disruption. Gradual expansion to utilization-based balancing, paired with careful PDB configuration and monitoring, unlocks cluster-wide efficiency improvements without sacrificing reliability.
