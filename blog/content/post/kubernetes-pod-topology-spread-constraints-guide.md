---
title: "Kubernetes Pod Topology Spread Constraints: Advanced Scheduling for High Availability"
date: 2027-05-01T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Topology", "Scheduling", "High Availability", "Pod Placement"]
categories: ["Kubernetes", "Operations"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Kubernetes Pod Topology Spread Constraints for distributing workloads across zones, nodes, and custom topologies to maximize availability and fault tolerance in production clusters."
more_link: "yes"
url: "/kubernetes-pod-topology-spread-constraints-guide/"
---

Pod anti-affinity rules were the original mechanism for distributing pods across failure domains in Kubernetes. They work, but they suffer from a fundamental limitation: anti-affinity expresses hard or soft preferences without any notion of balance. A deployment with 10 replicas and a `requiredDuringScheduling` anti-affinity rule against `topologyKey: kubernetes.io/hostname` simply fails to schedule the 11th pod once every node already has one copy. Topology Spread Constraints replace this rigid model with a flexible, balance-aware approach that expresses the desired distribution as a maximum acceptable skew between domains.

<!--more-->

# Kubernetes Pod Topology Spread Constraints: Advanced Scheduling for High Availability

## Core Concepts

### What is Skew?

Skew is the difference in pod count between the domain with the most pods and the domain with the fewest pods. Given three availability zones with pod counts `[3, 3, 2]`, the skew is `3 - 2 = 1`. A `maxSkew: 1` constraint permits this distribution and rejects any placement that would result in `[4, 3, 2]` (skew of 2).

Formally:

```
skew(topology domain) = (pods in this domain) - (pods in the domain with the minimum count)
maxSkew >= max skew across all domains
```

### Constraint Fields

A `TopologySpreadConstraint` has five fields:

```yaml
topologySpreadConstraints:
- maxSkew: 1                            # Maximum allowed difference between domains
  topologyKey: topology.kubernetes.io/zone  # Node label that defines the topology domain
  whenUnsatisfiable: DoNotSchedule      # DoNotSchedule | ScheduleAnyway
  labelSelector:                        # Selects pods that count toward the constraint
    matchLabels:
      app: my-app
  minDomains: 3                         # Minimum number of eligible domains (optional, 1.24+)
  matchLabelKeys:                       # Per-rollout label keys for skew calculation (optional, 1.25+)
  - pod-template-hash
  nodeAffinityPolicy: Honor             # Honor | Ignore (1.26+)
  nodeTaintsPolicy: Honor               # Honor | Ignore (1.26+)
```

**maxSkew**: The only required numeric field. Set to 1 for strict even distribution, higher values for looser balance.

**topologyKey**: Any node label. Common choices:
- `topology.kubernetes.io/zone` — cloud provider availability zones
- `kubernetes.io/hostname` — individual nodes
- Custom labels such as `rack`, `datacenter`, or `power-domain`

**whenUnsatisfiable**:
- `DoNotSchedule`: The pod remains Pending if placing it would violate the constraint. Stronger safety guarantee.
- `ScheduleAnyway`: The pod is scheduled even if it violates the constraint, but the scheduler attempts to minimize skew. Useful for availability-first workloads.

**minDomains**: Introduced in 1.24 (stable in 1.28). When the number of eligible domains falls below `minDomains`, the constraint treats this as if pods are spread across `minDomains` domains with zero pods in the missing ones. This prevents a two-zone cluster from satisfying constraints designed for three zones, which would incorrectly signal high availability.

**matchLabelKeys**: Introduced in 1.25. Specifies label keys whose values are appended to the `labelSelector`. During a rolling update, different `pod-template-hash` values distinguish old from new pods, preventing old pods from counting against the spread of new pods.

**nodeAffinityPolicy** and **nodeTaintsPolicy**: Control whether node affinity and taints are respected when identifying eligible domains. `Honor` (default) only counts domains that satisfy the pod's node affinity and that are not tainted against the pod.

## Basic Configuration Patterns

### Zone Spread for a Web Application

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-frontend
  namespace: production
spec:
  replicas: 6
  selector:
    matchLabels:
      app: web-frontend
  template:
    metadata:
      labels:
        app: web-frontend
    spec:
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: web-frontend
      containers:
      - name: frontend
        image: internal.registry.example.com/web-frontend:4.2.1
        resources:
          requests:
            cpu: 250m
            memory: 256Mi
          limits:
            cpu: 500m
            memory: 512Mi
        ports:
        - containerPort: 8080
```

With three zones (us-east-1a, us-east-1b, us-east-1c) and 6 replicas, the scheduler places 2 pods per zone. If one zone goes down, 4 pods continue serving traffic. With pure anti-affinity, the failure of a single zone in a 3-zone cluster would still leave the same 4 pods running, but adding a 7th pod to the deployment would fail to schedule if every node already has a pod.

### Node-Level Spread

Spreading across nodes within a zone prevents a single large node failure from dropping availability significantly:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-service
  namespace: production
spec:
  replicas: 9
  selector:
    matchLabels:
      app: api-service
  template:
    metadata:
      labels:
        app: api-service
    spec:
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: kubernetes.io/hostname
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: api-service
      containers:
      - name: api
        image: internal.registry.example.com/api-service:2.8.0
        resources:
          requests:
            cpu: 500m
            memory: 512Mi
```

### Combining Zone and Node Constraints

Multiple constraints are evaluated with AND logic — a pod must satisfy all constraints simultaneously. This pattern distributes pods across zones first, then distributes within each zone:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: critical-service
  namespace: production
spec:
  replicas: 12
  selector:
    matchLabels:
      app: critical-service
  template:
    metadata:
      labels:
        app: critical-service
    spec:
      topologySpreadConstraints:
      # Constraint 1: At most 1 pod difference across zones
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: critical-service
      # Constraint 2: At most 2 pods per node
      - maxSkew: 1
        topologyKey: kubernetes.io/hostname
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: critical-service
      containers:
      - name: service
        image: internal.registry.example.com/critical-service:1.0.0
        resources:
          requests:
            cpu: 250m
            memory: 256Mi
```

With 12 replicas, 3 zones, and 4 nodes per zone (12 total nodes), this achieves one pod per node with perfect zone balance.

## Advanced Patterns

### minDomains for Cluster Autoscaler Integration

Without `minDomains`, a cluster with only two zones provisioned (due to autoscaler having not yet created nodes in the third zone) would satisfy a `maxSkew: 1` constraint across 2 domains when 3 were intended. This defeats the HA goal.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: database-proxy
  namespace: production
spec:
  replicas: 6
  selector:
    matchLabels:
      app: database-proxy
  template:
    metadata:
      labels:
        app: database-proxy
    spec:
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: database-proxy
        # Require at least 3 zones to exist before considering
        # the constraint satisfiable
        minDomains: 3
      containers:
      - name: proxy
        image: internal.registry.example.com/db-proxy:5.1.0
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
```

When the autoscaler has provisioned nodes in all three zones, pods will schedule with 2 per zone. If a zone is being provisioned, pods wait until the third zone is available rather than concentrating in two zones and falsely appearing HA.

### matchLabelKeys for Rolling Updates

During a rolling update, old pods have one `pod-template-hash` and new pods have another. Without `matchLabelKeys`, the spread constraint counts both old and new pods together when deciding placement of new pods. This can cause new pods to pile up in zones where old pods have already been terminated, creating temporary zone imbalance.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-service
  namespace: production
spec:
  replicas: 9
  selector:
    matchLabels:
      app: payment-service
  template:
    metadata:
      labels:
        app: payment-service
    spec:
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: payment-service
        # Only count pods with the same pod-template-hash as the pod
        # being scheduled; isolates new replicas from old ones
        matchLabelKeys:
        - pod-template-hash
      containers:
      - name: payment
        image: internal.registry.example.com/payment-service:3.4.1
```

### Custom Topology Keys for Rack and Power Domain Awareness

Cloud providers set `topology.kubernetes.io/zone`, but on-premises clusters need custom topology labels applied to nodes:

```bash
# Label nodes with rack information
kubectl label node node01 topology.example.com/rack=rack-a
kubectl label node node02 topology.example.com/rack=rack-a
kubectl label node node03 topology.example.com/rack=rack-b
kubectl label node node04 topology.example.com/rack=rack-b
kubectl label node node05 topology.example.com/rack=rack-c
kubectl label node node06 topology.example.com/rack=rack-c

# Label nodes with power domain information
kubectl label node node01 topology.example.com/pdu=pdu-1
kubectl label node node02 topology.example.com/pdu=pdu-2
kubectl label node node03 topology.example.com/pdu=pdu-1
kubectl label node node04 topology.example.com/pdu=pdu-2
kubectl label node node05 topology.example.com/pdu=pdu-1
kubectl label node node06 topology.example.com/pdu=pdu-2
```

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: storage-cache
  namespace: production
spec:
  replicas: 6
  selector:
    matchLabels:
      app: storage-cache
  template:
    metadata:
      labels:
        app: storage-cache
    spec:
      topologySpreadConstraints:
      # Spread across racks (physical failure domain)
      - maxSkew: 1
        topologyKey: topology.example.com/rack
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: storage-cache
      # Spread across power distribution units
      - maxSkew: 1
        topologyKey: topology.example.com/pdu
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: storage-cache
      containers:
      - name: cache
        image: redis:7.2-alpine
        resources:
          requests:
            cpu: 500m
            memory: 1Gi
```

### DoNotSchedule vs ScheduleAnyway

The choice between `whenUnsatisfiable: DoNotSchedule` and `whenUnsatisfiable: ScheduleAnyway` represents a trade-off between availability guarantees and scheduling flexibility.

```yaml
# Strict: Pod waits for a balanced domain to become available
# Use for: critical services where zone balance is non-negotiable
topologySpreadConstraints:
- maxSkew: 1
  topologyKey: topology.kubernetes.io/zone
  whenUnsatisfiable: DoNotSchedule
  labelSelector:
    matchLabels:
      app: payment-service

---
# Flexible: Pod schedules even if it creates imbalance
# Use for: batch jobs, burst workloads, or services where any pod running
# is better than a pod pending
topologySpreadConstraints:
- maxSkew: 2
  topologyKey: topology.kubernetes.io/zone
  whenUnsatisfiable: ScheduleAnyway
  labelSelector:
    matchLabels:
      app: report-generator
```

A practical hybrid: use `DoNotSchedule` for zone-level constraints (you genuinely need pods in every zone) and `ScheduleAnyway` for node-level constraints (you prefer distribution but will accept stacking under pressure):

```yaml
topologySpreadConstraints:
# Hard zone requirement
- maxSkew: 1
  topologyKey: topology.kubernetes.io/zone
  whenUnsatisfiable: DoNotSchedule
  labelSelector:
    matchLabels:
      app: api-gateway
# Soft node preference
- maxSkew: 2
  topologyKey: kubernetes.io/hostname
  whenUnsatisfiable: ScheduleAnyway
  labelSelector:
    matchLabels:
      app: api-gateway
```

## Integration with PodDisruptionBudgets

Topology Spread Constraints control initial placement. PodDisruptionBudgets control availability during voluntary disruptions. They work together but serve distinct purposes.

```yaml
# Spread constraint ensures even zone distribution at scheduling time
apiVersion: apps/v1
kind: Deployment
metadata:
  name: auth-service
  namespace: production
spec:
  replicas: 6
  selector:
    matchLabels:
      app: auth-service
  template:
    metadata:
      labels:
        app: auth-service
    spec:
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: auth-service
      containers:
      - name: auth
        image: internal.registry.example.com/auth-service:1.5.0
        resources:
          requests:
            cpu: 200m
            memory: 256Mi
---
# PDB ensures at most 1 pod is unavailable at any time during drain/eviction
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: auth-service-pdb
  namespace: production
spec:
  minAvailable: 5
  selector:
    matchLabels:
      app: auth-service
```

With 6 replicas spread evenly across 3 zones (2 per zone), and a PDB of `minAvailable: 5`, at most one pod can be voluntarily disrupted at a time. Node drain will succeed only if it does not drop below 5 available pods.

A stronger configuration uses both `minAvailable` and zone-awareness at the PDB level:

```yaml
# Two PDBs: one for total count, one enforced per-zone via topology label
# (Standard PDBs do not have per-topology awareness; use minAvailable
# conservatively to account for zone-level disruptions)
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: auth-service-pdb-strict
  namespace: production
spec:
  # With 2 pods/zone across 3 zones, losing one full zone leaves 4 pods.
  # Setting minAvailable=4 allows zone maintenance while preserving
  # service continuity.
  minAvailable: 4
  selector:
    matchLabels:
      app: auth-service
```

## Cluster Autoscaler Interaction

The Cluster Autoscaler scales node groups when pods are pending due to resource constraints. Topology Spread Constraints with `DoNotSchedule` can cause pods to remain Pending even when resource capacity exists, because the available nodes are in a zone that would violate `maxSkew`. This is intentional behavior but requires the autoscaler configuration to match the topology intent.

### Balanced Node Group Configuration

For the autoscaler to maintain zone balance that supports `maxSkew: 1` constraints, configure balanced node groups:

```yaml
# cluster-autoscaler ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: cluster-autoscaler-status
  namespace: kube-system
data:
  nodes.max: "100"
  nodes.min: "3"
---
# Deployment flags for balanced similar node groups
# Add to cluster-autoscaler deployment args:
# --balance-similar-node-groups=true
# --skip-nodes-with-local-storage=false
# --expander=least-waste
```

Full autoscaler deployment with topology-aware flags:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cluster-autoscaler
  namespace: kube-system
spec:
  replicas: 1
  selector:
    matchLabels:
      app: cluster-autoscaler
  template:
    metadata:
      labels:
        app: cluster-autoscaler
    spec:
      serviceAccountName: cluster-autoscaler
      containers:
      - name: cluster-autoscaler
        image: registry.k8s.io/autoscaling/cluster-autoscaler:v1.30.0
        command:
        - ./cluster-autoscaler
        - --cloud-provider=aws
        - --namespace=kube-system
        - --nodes=1:20:eks-nodegroup-us-east-1a
        - --nodes=1:20:eks-nodegroup-us-east-1b
        - --nodes=1:20:eks-nodegroup-us-east-1c
        # Balance similar node groups to keep zone counts equal
        - --balance-similar-node-groups=true
        # Do not remove nodes that recently had pods assigned
        - --scale-down-delay-after-add=10m
        # Wait longer before scale-down to allow topology spread to rebalance
        - --scale-down-unneeded-time=10m
        # Respect topology spread constraints during scale-down
        - --skip-nodes-with-system-pods=false
        - --expander=least-waste
        resources:
          requests:
            cpu: 100m
            memory: 300Mi
          limits:
            cpu: 100m
            memory: 300Mi
```

### Detecting Pending Pods Blocked by Topology Constraints

```bash
# Find pods pending due to topology spread violations
kubectl get pods --all-namespaces --field-selector status.phase=Pending \
  -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}{"\n"}{end}' | \
  while read pod_ref; do
    ns=$(echo "$pod_ref" | cut -d/ -f1)
    pod=$(echo "$pod_ref" | cut -d/ -f2)
    reason=$(kubectl describe pod "$pod" -n "$ns" 2>/dev/null | \
      grep -A 2 "Warning\|Unschedulable" | \
      grep -i "topology\|spread\|maxSkew" || true)
    if [[ -n "$reason" ]]; then
      echo "Topology blocked: ${ns}/${pod}"
      echo "  $reason"
    fi
  done
```

```bash
# Check current zone distribution for a deployment
NAMESPACE=production
APP=web-frontend

echo "Zone distribution for ${APP}:"
kubectl get pods -n "${NAMESPACE}" -l "app=${APP}" \
  -o jsonpath='{range .items[*]}{.spec.nodeName}{"\n"}{end}' | \
  while read node; do
    kubectl get node "$node" \
      -o jsonpath='{.metadata.labels.topology\.kubernetes\.io/zone}{"\n"}'
  done | sort | uniq -c | sort -rn
```

## Descheduler Rebalancing

Topology Spread Constraints only apply at scheduling time. Pods already running are not moved when the cluster topology changes (new zones come online, nodes are added). The Kubernetes Descheduler fills this gap by evicting pods that violate the current spread policy so the scheduler can replace them in better positions.

### Descheduler Installation

```bash
helm repo add descheduler https://kubernetes-sigs.github.io/descheduler/
helm repo update

helm install descheduler descheduler/descheduler \
  --namespace kube-system \
  --version 0.30.1 \
  --set schedule="*/10 * * * *"
```

### Descheduler Policy for Topology Rebalancing

```yaml
apiVersion: descheduler/v1alpha2
kind: DeschedulerPolicy
profiles:
- name: topology-rebalance
  pluginConfig:
  - name: RemovePodsViolatingTopologySpreadConstraint
    args:
      # Rebalance both hard (DoNotSchedule) and soft (ScheduleAnyway) constraints
      constraints:
      - DoNotSchedule
      - ScheduleAnyway
      # Namespace filtering
      namespaces:
        include:
        - production
        - staging
      # Do not evict pods with local storage
      nodeFit: true
  plugins:
    balance:
      enabled:
      - RemovePodsViolatingTopologySpreadConstraint
```

Apply as a ConfigMap:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: descheduler-policy
  namespace: kube-system
data:
  policy.yaml: |
    apiVersion: descheduler/v1alpha2
    kind: DeschedulerPolicy
    profiles:
    - name: topology-rebalance
      pluginConfig:
      - name: RemovePodsViolatingTopologySpreadConstraint
        args:
          constraints:
          - DoNotSchedule
          - ScheduleAnyway
          namespaces:
            include:
            - production
            - staging
      plugins:
        balance:
          enabled:
          - RemovePodsViolatingTopologySpreadConstraint
    - name: low-node-utilization
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
      plugins:
        balance:
          enabled:
          - LowNodeUtilization
```

### Protecting Critical Pods from Descheduling

Annotate pods that must not be evicted by the descheduler:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: stateful-cache
  namespace: production
spec:
  template:
    metadata:
      annotations:
        # Prevent descheduler from evicting these pods
        descheduler.alpha.kubernetes.io/evict: "false"
      labels:
        app: stateful-cache
```

## Cluster-Level Default Constraints

Kubernetes 1.24+ allows cluster-level default topology spread constraints configured in the scheduler. These apply to all pods that do not explicitly set `topologySpreadConstraints`:

```yaml
# kube-scheduler configuration
apiVersion: kubescheduler.config.k8s.io/v1
kind: KubeSchedulerConfiguration
profiles:
- schedulerName: default-scheduler
  pluginConfig:
  - name: PodTopologySpread
    args:
      defaultConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: ScheduleAnyway
      - maxSkew: 2
        topologyKey: kubernetes.io/hostname
        whenUnsatisfiable: ScheduleAnyway
      # Apply defaults only to pods that do not have explicit constraints
      defaultingType: List
```

For EKS, configure this through a custom scheduler or use the built-in defaults. For kubeadm clusters, patch the scheduler configuration:

```bash
# Edit the scheduler configuration file
# Location: /etc/kubernetes/manifests/kube-scheduler.yaml (kubeadm clusters)
# Add --config=/etc/kubernetes/scheduler-config.yaml to the command
# Create the config file with the defaultConstraints above
```

## Validation and Testing

### Constraint Validation Script

```bash
#!/bin/bash
# Validate topology spread constraint behavior for a deployment
# Usage: ./validate-topology.sh <namespace> <deployment-name>

set -euo pipefail

NAMESPACE="${1:?namespace required}"
DEPLOYMENT="${2:?deployment-name required}"

echo "=== Topology Spread Constraint Analysis ==="
echo "Deployment: ${NAMESPACE}/${DEPLOYMENT}"
echo ""

# Get replica count
REPLICAS=$(kubectl get deployment "${DEPLOYMENT}" -n "${NAMESPACE}" \
  -o jsonpath='{.spec.replicas}')
echo "Replicas: ${REPLICAS}"

# Get the constraints
echo ""
echo "=== Configured Constraints ==="
kubectl get deployment "${DEPLOYMENT}" -n "${NAMESPACE}" \
  -o jsonpath='{.spec.template.spec.topologySpreadConstraints}' | \
  python3 -m json.tool 2>/dev/null || echo "No topology spread constraints found"

# Get label selector
APP_LABEL=$(kubectl get deployment "${DEPLOYMENT}" -n "${NAMESPACE}" \
  -o jsonpath='{.spec.selector.matchLabels.app}')

# Show current distribution by zone
echo ""
echo "=== Current Zone Distribution ==="
kubectl get pods -n "${NAMESPACE}" -l "app=${APP_LABEL}" \
  -o jsonpath='{range .items[*]}{.spec.nodeName}{" "}{.status.phase}{"\n"}{end}' | \
  while IFS=' ' read -r node phase; do
    zone=$(kubectl get node "${node}" \
      -o jsonpath='{.metadata.labels.topology\.kubernetes\.io/zone}' 2>/dev/null || echo "unknown")
    echo "${zone} (${phase})"
  done | sort | uniq -c

# Show current distribution by node
echo ""
echo "=== Current Node Distribution ==="
kubectl get pods -n "${NAMESPACE}" -l "app=${APP_LABEL}" \
  -o jsonpath='{range .items[*]}{.spec.nodeName}{" "}{.status.phase}{"\n"}{end}' | \
  sort | uniq -c

# Check for pending pods
echo ""
echo "=== Pending Pods ==="
PENDING=$(kubectl get pods -n "${NAMESPACE}" -l "app=${APP_LABEL}" \
  --field-selector status.phase=Pending \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}')
if [[ -n "${PENDING}" ]]; then
  echo "WARNING: Pending pods found:"
  echo "${PENDING}"
  for pod in ${PENDING}; do
    echo ""
    echo "Events for ${pod}:"
    kubectl describe pod "${pod}" -n "${NAMESPACE}" | \
      grep -A 3 "Warning.*topology\|Unschedulable\|didn't match"
  done
else
  echo "No pending pods"
fi
```

### Simulating Zone Failure

```bash
#!/bin/bash
# Simulate zone failure by cordoning all nodes in a zone
# Usage: ./simulate-zone-failure.sh <zone-label> [restore]

ZONE="${1:?zone label required (e.g., us-east-1a)}"
MODE="${2:-fail}"

if [[ "${MODE}" == "fail" ]]; then
  echo "Simulating failure of zone: ${ZONE}"
  echo "Cordoning all nodes in zone ${ZONE}..."

  kubectl get nodes \
    -l "topology.kubernetes.io/zone=${ZONE}" \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' | \
    while read -r node; do
      echo "  Cordoning: ${node}"
      kubectl cordon "${node}"
    done

  echo ""
  echo "Evicting pods from zone ${ZONE}..."
  kubectl get pods --all-namespaces \
    -o jsonpath='{range .items[*]}{.metadata.namespace}{" "}{.metadata.name}{" "}{.spec.nodeName}{"\n"}{end}' | \
    while IFS=' ' read -r ns pod node; do
      node_zone=$(kubectl get node "${node}" \
        -o jsonpath='{.metadata.labels.topology\.kubernetes\.io/zone}' 2>/dev/null || echo "")
      if [[ "${node_zone}" == "${ZONE}" ]]; then
        echo "  Evicting: ${ns}/${pod}"
        kubectl delete pod "${pod}" -n "${ns}" --grace-period=0 --force 2>/dev/null || true
      fi
    done

  echo ""
  echo "Zone failure simulation complete. Watch pod rescheduling:"
  echo "  kubectl get pods --all-namespaces -w"

elif [[ "${MODE}" == "restore" ]]; then
  echo "Restoring zone: ${ZONE}"
  kubectl get nodes \
    -l "topology.kubernetes.io/zone=${ZONE}" \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' | \
    while read -r node; do
      echo "  Uncordoning: ${node}"
      kubectl uncordon "${node}"
    done
  echo "Zone restoration complete"
fi
```

## Monitoring Topology Distribution

### Prometheus Metrics

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: topology-spread-alerts
  namespace: monitoring
spec:
  groups:
  - name: topology-spread
    interval: 60s
    rules:
    # Alert when pods are pending likely due to topology constraints
    - alert: PodsPendingPossibleTopologyViolation
      expr: |
        sum by (namespace, pod) (
          kube_pod_status_phase{phase="Pending"} == 1
        ) * on(namespace, pod) group_left()
        (kube_pod_info unless on(pod, namespace) kube_pod_status_scheduled{condition="true"})
      for: 15m
      labels:
        severity: warning
      annotations:
        summary: "Pod {{ $labels.namespace }}/{{ $labels.pod }} has been pending for 15+ minutes"

    # Alert on zone imbalance exceeding maxSkew 2
    - alert: ZoneImbalanceHigh
      expr: |
        (
          max by (label_app, namespace) (
            count by (label_app, namespace, node) (kube_pod_info)
            * on(node) group_left(label_topology_kubernetes_io_zone)
            kube_node_labels
          )
          -
          min by (label_app, namespace) (
            count by (label_app, namespace, node) (kube_pod_info)
            * on(node) group_left(label_topology_kubernetes_io_zone)
            kube_node_labels
          )
        ) > 2
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "Application {{ $labels.label_app }} in {{ $labels.namespace }} has zone skew > 2"
```

### Grafana Dashboard Query

```json
{
  "panels": [
    {
      "title": "Pod Distribution by Zone",
      "type": "stat",
      "targets": [
        {
          "expr": "count by (label_topology_kubernetes_io_zone) (kube_pod_info{namespace=\"production\"} * on(node) group_left(label_topology_kubernetes_io_zone) kube_node_labels)",
          "legendFormat": "Zone: {{ label_topology_kubernetes_io_zone }}"
        }
      ]
    },
    {
      "title": "Zone Skew per Application",
      "type": "table",
      "targets": [
        {
          "expr": "max by (label_app) (count by (label_app, label_topology_kubernetes_io_zone) (kube_pod_info{namespace=\"production\"} * on(node) group_left(label_topology_kubernetes_io_zone) kube_node_labels)) - min by (label_app) (count by (label_app, label_topology_kubernetes_io_zone) (kube_pod_info{namespace=\"production\"} * on(node) group_left(label_topology_kubernetes_io_zone) kube_node_labels))",
          "legendFormat": "{{ label_app }}"
        }
      ]
    }
  ]
}
```

## Common Pitfalls and Remediation

### Pitfall 1: Empty Topology Domain Counts

If a node is missing the `topologyKey` label, the scheduler treats it as belonging to an empty-string domain `""`. Pods can accumulate there and skew calculations become incorrect.

```bash
# Find nodes missing the zone label
kubectl get nodes \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.labels.topology\.kubernetes\.io/zone}{"\n"}{end}' | \
  awk '$2 == "" {print "Missing zone label: "$1}'
```

### Pitfall 2: Constraint labelSelector Too Broad

If the `labelSelector` in the constraint matches pods from other deployments, those pods count toward skew for all constrained pods. This causes unexpected scheduling failures.

```bash
# Count pods matched by a given labelSelector in a namespace
kubectl get pods -n production -l "app=my-service" \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.nodeName}{"\n"}{end}'
# Verify only the intended pods are matched
```

### Pitfall 3: maxSkew Too Tight During Rolling Updates

With `maxSkew: 1` and exactly 1 pod per zone across 3 zones (3 replicas), a rolling update terminates one old pod and creates one new pod. During the brief period when the old pod is terminating but not yet gone, the zone has 0 pods, creating a skew of 1 from the zones with 1 pod. The new pod may fail to schedule because placing it in the now-empty zone would require waiting. Use `maxSkew: 2` during rolling updates or use `matchLabelKeys` to separate old and new pod counts.

### Pitfall 4: Interaction with Pod Priority and Preemption

High-priority pods can preempt lower-priority pods to satisfy topology constraints. If critical pods preempt best-effort pods repeatedly, this creates instability. Set explicit priority classes and be aware that preemption bypasses `PodDisruptionBudget` protections for the preempted pods.

```yaml
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: production-critical
value: 1000000
globalDefault: false
description: "Critical production workloads"
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: best-effort-batch
value: 100
globalDefault: false
description: "Best-effort batch workloads subject to preemption"
```

## Conclusion

Topology Spread Constraints provide precise, balance-aware scheduling that anti-affinity rules cannot match. The combination of zone-level `DoNotSchedule` constraints with `minDomains` for autoscaler compatibility, node-level `ScheduleAnyway` constraints for soft distribution, `matchLabelKeys` for clean rolling updates, PodDisruptionBudgets for disruption safety, and the descheduler for post-scheduling rebalancing creates a robust HA architecture that survives single-zone failures and adapts gracefully to cluster topology changes.
