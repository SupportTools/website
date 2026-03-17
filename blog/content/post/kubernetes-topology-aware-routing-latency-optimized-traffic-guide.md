---
title: "Kubernetes Topology Aware Routing: Latency-Optimized Traffic"
date: 2029-04-15T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Topology Aware Routing", "EndpointSlices", "Networking", "AWS", "GCP", "Latency"]
categories:
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Kubernetes Topology Aware Routing covering EndpointSlices, topology keys, zone-aware routing, traffic distribution, cross-zone cost reduction, and AWS/GCP zone configuration."
more_link: "yes"
url: "/kubernetes-topology-aware-routing-latency-optimized-traffic-guide/"
---

In a Kubernetes cluster spanning multiple availability zones, every cross-zone service call adds latency and incurs cloud provider data transfer costs. Without topology-aware routing, kube-proxy distributes traffic equally across all endpoints regardless of zone, which means a pod in `us-east-1a` calling a service may regularly hit endpoints in `us-east-1b` or `us-east-1c`.

Topology Aware Routing (TAR) solves this by using hints in EndpointSlices to steer traffic toward endpoints in the same zone as the calling pod. This reduces P99 latency, eliminates most cross-zone bandwidth costs, and makes your traffic patterns more predictable under load.

<!--more-->

# Kubernetes Topology Aware Routing: Latency-Optimized Traffic

## Section 1: Why Topology Aware Routing Matters

### Cross-Zone Traffic Costs

On AWS, cross-AZ data transfer costs $0.01/GB in each direction. For a microservices application generating 1 TB/day of service-to-service traffic, that translates to roughly $600/month in cross-AZ costs alone — and this compounds with every service added.

On GCP, cross-zone traffic within a region is charged at $0.01/GB. On Azure, intra-region cross-zone traffic is charged at $0.01/GB in most regions.

Beyond cost, cross-zone latency adds 0.5-2ms per hop compared to within-zone traffic. For synchronous microservice call chains, this compounds quickly.

### How Topology Aware Routing Works

1. The EndpointSlice controller watches Service and Endpoints objects
2. When a Service has `service.kubernetes.io/topology-mode: Auto` annotation, it populates `hints.forZones` in the EndpointSlice for each endpoint
3. kube-proxy on each node reads these hints and builds local routing tables that prefer endpoints in the same zone
4. Pods on nodes in `us-east-1a` get routed to endpoints also in `us-east-1a` (when available)

### Prerequisites

- Kubernetes 1.27+ (Topology Aware Routing is stable)
- kube-proxy in iptables or IPVS mode
- Nodes must have `topology.kubernetes.io/zone` label
- EndpointSlice controller enabled (default in 1.21+)
- At least 3 endpoints per zone (for hint allocation to work)

## Section 2: EndpointSlices and Topology Hints

### EndpointSlice Structure

EndpointSlices replaced the older Endpoints API with a more scalable, topology-aware design:

```bash
# View EndpointSlices for a service
kubectl get endpointslice -n production -l kubernetes.io/service-name=api-server

# Detailed view with hints
kubectl get endpointslice -n production api-server-xyz12 -o yaml
```

```yaml
apiVersion: discovery.k8s.io/v1
kind: EndpointSlice
metadata:
  name: api-server-xyz12
  namespace: production
  labels:
    kubernetes.io/service-name: api-server
  ownerReferences:
  - apiVersion: v1
    kind: Service
    name: api-server
addressType: IPv4
endpoints:
- addresses:
  - 10.1.0.10
  conditions:
    ready: true
    serving: true
    terminating: false
  hints:
    forZones:            # <-- TAR hint: this endpoint serves zone us-east-1a
    - name: us-east-1a
  nodeName: worker-1a
  targetRef:
    kind: Pod
    name: api-server-abc123
    namespace: production
  zone: us-east-1a     # <-- endpoint's zone
- addresses:
  - 10.2.0.15
  conditions:
    ready: true
    serving: true
    terminating: false
  hints:
    forZones:
    - name: us-east-1b
  nodeName: worker-1b
  targetRef:
    kind: Pod
    name: api-server-def456
    namespace: production
  zone: us-east-1b
ports:
- name: http
  port: 8080
  protocol: TCP
```

### How the EndpointSlice Controller Allocates Hints

The controller allocates hints based on the number of endpoints and nodes per zone:

1. It counts ready endpoints per zone
2. It counts nodes (weighted by allocatable CPU) per zone
3. It assigns endpoints to zones proportionally, ensuring each zone has at least one hint

For a 3-zone cluster with 9 replicas (3 per zone):
- Zone A: 3 endpoints get hints for Zone A
- Zone B: 3 endpoints get hints for Zone B
- Zone C: 3 endpoints get hints for Zone C

For imbalanced replicas (e.g., 5 replicas with 2 in zone A, 2 in zone B, 1 in zone C):
- Zone A: 2 endpoints get hints for Zone A
- Zone B: 2 endpoints get hints for Zone B
- Zone C: 1 endpoint gets hints for Zone C, plus some endpoints from A or B also get Zone C hints to ensure coverage

## Section 3: Enabling Topology Aware Routing

### Service Annotation

Enable TAR by annotating the Service:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: api-server
  namespace: production
  annotations:
    # "Auto" mode: Kubernetes decides whether to enable hints
    # (disables hints if not enough endpoints per zone)
    service.kubernetes.io/topology-mode: "Auto"
spec:
  selector:
    app: api-server
  ports:
  - name: http
    port: 80
    targetPort: 8080
  type: ClusterIP
```

### Verifying TAR is Active

```bash
# Check that hints are populated in EndpointSlice
kubectl get endpointslice -n production \
  -l kubernetes.io/service-name=api-server \
  -o json | jq '.items[].endpoints[].hints'
# [
#   {"forZones": [{"name": "us-east-1a"}]},
#   {"forZones": [{"name": "us-east-1b"}]},
#   {"forZones": [{"name": "us-east-1a"}]},
# ]

# Check kube-proxy routing rules
# On a node in us-east-1a, verify it only knows about zone A endpoints
kubectl debug -it node/worker-1a \
  --image=busybox:1.35 \
  --profile=sysadmin \
  -- /bin/sh -c "iptables -L KUBE-SEP-* -n | head -50"

# Or check via nstat
kubectl debug -it node/worker-1a \
  --image=busybox:1.35 \
  -- /bin/sh -c "cat /proc/net/ip_tables_names"
```

### Conditions for Hint Population

The EndpointSlice controller only populates hints when certain conditions are met:

```bash
# TAR is NOT activated when:
# 1. Fewer than 3 ready endpoints total
# 2. Service type is ExternalName
# 3. A zone has 0 ready endpoints (hint would drop all traffic to that zone)
# 4. The ratio of endpoints to nodes is too imbalanced (> 3:1 or < 1:3)

# Check EndpointSlice events for hint allocation warnings
kubectl describe endpointslice -n production api-server-xyz12 | grep -A5 Events

# Check controller manager logs for topology hint decisions
kubectl logs -n kube-system kube-controller-manager-control-plane-1 | \
  grep -i "topology\|hints" | tail -20
```

## Section 4: Node Zone Labels

### AWS Zone Labels

EKS automatically labels nodes with zone topology. For self-managed clusters on AWS:

```bash
# Verify nodes have zone labels
kubectl get nodes -o custom-columns='NAME:.metadata.name,ZONE:.metadata.labels.topology\.kubernetes\.io/zone'
# NAME              ZONE
# worker-1a-abc     us-east-1a
# worker-1b-def     us-east-1b
# worker-1c-ghi     us-east-1c

# For self-managed nodes, apply zone labels during node join
# kubeadm join ... --node-labels "topology.kubernetes.io/zone=us-east-1a"

# Or apply retroactively
kubectl label node worker-1a topology.kubernetes.io/zone=us-east-1a
kubectl label node worker-1b topology.kubernetes.io/zone=us-east-1b
kubectl label node worker-1c topology.kubernetes.io/zone=us-east-1c

# AWS cloud provider applies these automatically when using:
# --cloud-provider=aws in kubelet config
```

### GCP Zone Labels

```bash
# GKE applies zone labels automatically
kubectl get nodes -o custom-columns='NAME:.metadata.name,ZONE:.metadata.labels.topology\.kubernetes\.io/zone'
# NAME              ZONE
# gke-pool-abc      us-central1-a
# gke-pool-def      us-central1-b
# gke-pool-ghi      us-central1-c

# For Autopilot, zone labels are managed by GKE
# For Standard clusters, they're applied by the GCP cloud provider

# Verify region label is also set (used by some network policies)
kubectl get node gke-pool-abc -o jsonpath='{.metadata.labels.topology\.kubernetes\.io/region}'
# us-central1
```

### Bare Metal Zone Labels

For bare metal or on-premises clusters:

```bash
# Apply zone labels based on your physical topology
# datacenter-1, rack-a
kubectl label node rack-a-node-1 topology.kubernetes.io/zone=datacenter-1-rack-a
kubectl label node rack-a-node-2 topology.kubernetes.io/zone=datacenter-1-rack-a

# datacenter-1, rack-b
kubectl label node rack-b-node-1 topology.kubernetes.io/zone=datacenter-1-rack-b

# datacenter-2
kubectl label node dc2-node-1 topology.kubernetes.io/zone=datacenter-2

# Apply region label for multi-datacenter setups
kubectl label nodes -l topology.kubernetes.io/zone=datacenter-1-rack-a \
  topology.kubernetes.io/region=datacenter-1
```

## Section 5: Traffic Distribution API

### TrafficDistribution Field (Kubernetes 1.31+)

Kubernetes 1.31 introduced the `spec.trafficDistribution` field as a more explicit replacement for the annotation:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: api-server
  namespace: production
spec:
  selector:
    app: api-server
  ports:
  - port: 80
    targetPort: 8080
  # PreferClose: prefer endpoints in the same zone
  # Falls back to other zones if no local endpoints are ready
  trafficDistribution: PreferClose
```

The `PreferClose` policy:
- Routes to endpoints in the same zone when available
- Falls back to any ready endpoint if no local endpoints exist
- Does not guarantee topology alignment (unlike single-zona mode)

### Combined with Internal Traffic Policy

```yaml
apiVersion: v1
kind: Service
metadata:
  name: node-local-metrics
  namespace: monitoring
spec:
  selector:
    app: node-exporter
  ports:
  - port: 9100
    targetPort: 9100
  # Local: traffic only routes to endpoints on the SAME NODE
  # Used for DaemonSet services accessed from the same node
  internalTrafficPolicy: Local
```

The `internalTrafficPolicy: Local` setting is different from TAR — it restricts traffic to the same node, not the same zone. Use it for node-local agents like Prometheus node-exporter, log collectors, and CNI plugins.

## Section 6: kube-proxy Integration

### iptables Mode TAR

In iptables mode, kube-proxy creates separate endpoint chains for each zone and chains them together based on hints:

```bash
# View iptables rules for a service (on a node in us-east-1a)
iptables -t nat -L KUBE-SVC-XXXXXXXXXXX -n --line-numbers
# Chain KUBE-SVC-XXXXXXXXXXX (2 references)
# num  target     prot opt source    destination
# 1    KUBE-SEP-AAAAAA  all  --  0.0.0.0/0   0.0.0.0/0   /* TAR: us-east-1a endpoint */
# 2    KUBE-SEP-BBBBBB  all  --  0.0.0.0/0   0.0.0.0/0   /* TAR: us-east-1a endpoint */
# Note: only us-east-1a endpoints are in the chain for this zone

# Compare with a non-TAR service (all endpoints included):
# 1    KUBE-SEP-AAAAAA  all  --  ...    statistic mode random probability 0.33
# 2    KUBE-SEP-BBBBBB  all  --  ...    statistic mode random probability 0.50
# 3    KUBE-SEP-CCCCCC  all  --  ...    probability 1.0
```

### IPVS Mode TAR

In IPVS mode, kube-proxy creates virtual servers with only zone-local real servers:

```bash
# View IPVS rules
ipvsadm -Ln --service tcp --port 80

# On a node in us-east-1a, only zone A endpoints appear:
# TCP  10.96.0.100:80 rr
#   -> 10.1.0.10:8080     Masq    1      0          0
#   -> 10.1.0.11:8080     Masq    1      0          0
# (Note: 10.2.x.x endpoints from us-east-1b are absent)
```

### Cilium with Topology Aware Routing

Cilium implements its own topology-aware load balancing:

```yaml
# Cilium ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: cilium-config
  namespace: kube-system
data:
  # Enable topology-aware load balancing
  enable-local-redirect-policy: "true"

  # K8s topology hints integration
  enable-k8s-topology-hints: "true"

  # Maglev for consistent hashing within zone
  load-balancer-algorithm: maglev
```

Verify Cilium is using topology hints:

```bash
# Check Cilium endpoint topology
cilium service list
# ID   Frontend         Service Type   Backend
# 1    10.96.0.100:80   ClusterIP      10.1.0.10:8080 (id: 1, zone: us-east-1a)
#                                       10.1.0.11:8080 (id: 2, zone: us-east-1a)
# (remote zone endpoints not shown for local traffic)
```

## Section 7: Measuring TAR Effectiveness

### Metrics for Cross-Zone Traffic

```bash
# Check kube-proxy metrics for zone routing
kubectl port-forward -n kube-system \
  $(kubectl get pod -n kube-system -l k8s-app=kube-proxy -o name | head -1) \
  10249:10249

curl -s http://localhost:10249/metrics | grep topology
# kubeproxy_sync_proxy_rules_endpoint_changes_total
# kubeproxy_network_programming_duration_seconds

# Cloud provider cross-zone traffic metrics
# AWS: VPC Flow Logs with cross-AZ traffic filters
# GCP: VPC Flow Logs in Cloud Logging
# Azure: NSG Flow Logs
```

### Custom Metrics with Prometheus

Add zone labels to application metrics to track cross-zone calls:

```go
package metrics

import (
    "os"
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    zone = os.Getenv("NODE_ZONE")  // Set from downward API

    httpRequests = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "http_requests_total",
            Help: "Total HTTP requests",
        },
        []string{"method", "path", "status", "source_zone", "target_zone"},
    )
)

func RecordRequest(method, path, status, targetZone string) {
    httpRequests.WithLabelValues(method, path, status, zone, targetZone).Inc()
}
```

Expose the pod's zone via the Downward API:

```yaml
spec:
  containers:
  - name: api-server
    env:
    - name: NODE_ZONE
      valueFrom:
        fieldRef:
          fieldPath: metadata.labels['topology.kubernetes.io/zone']
    - name: NODE_NAME
      valueFrom:
        fieldRef:
          fieldPath: spec.nodeName
```

### Prometheus Query for Cross-Zone Traffic Rate

```promql
# Cross-zone request rate
sum(rate(http_requests_total{source_zone != target_zone}[5m]))
  /
sum(rate(http_requests_total[5m]))

# Expected: <5% cross-zone traffic with TAR enabled
# Without TAR: ~67% cross-zone traffic in a 3-zone cluster
```

## Section 8: Advanced TAR Configurations

### Per-Service Zone Configuration

Not all services benefit equally from TAR. Services with very few replicas or stateful services that route based on request content may not benefit:

```yaml
# Stateless API: enable TAR for cost and latency
apiVersion: v1
kind: Service
metadata:
  name: stateless-api
  annotations:
    service.kubernetes.io/topology-mode: "Auto"
spec:
  selector:
    app: stateless-api
  ports:
  - port: 80
---
# Stateful database: disable TAR, route to any endpoint
apiVersion: v1
kind: Service
metadata:
  name: postgres
  # No topology annotation — default load balancing
spec:
  selector:
    app: postgres
  ports:
  - port: 5432
---
# Cache service: only route to local zone for latency
apiVersion: v1
kind: Service
metadata:
  name: redis-cache
  annotations:
    service.kubernetes.io/topology-mode: "Auto"
spec:
  selector:
    app: redis-cache
  ports:
  - port: 6379
```

### Zone-Aware Ingress Configuration

For external traffic entering through an ingress controller, zone routing requires matching the ingress controller pod to the backend pod's zone:

```yaml
# Deploy ingress controller per zone with zone affinity
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx-ingress-zone-a
  namespace: ingress-nginx
spec:
  replicas: 2
  selector:
    matchLabels:
      app: nginx-ingress
      zone: us-east-1a
  template:
    metadata:
      labels:
        app: nginx-ingress
        zone: us-east-1a
    spec:
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            - matchExpressions:
              - key: topology.kubernetes.io/zone
                operator: In
                values:
                - us-east-1a
      containers:
      - name: controller
        image: registry.k8s.io/ingress-nginx/controller:v1.9.0
        env:
        - name: POD_ZONE
          valueFrom:
            fieldRef:
              fieldPath: metadata.labels['zone']
```

### Handling Zone Imbalance

When one zone has significantly fewer pods (e.g., during a rolling update):

```yaml
# Configure gradual zone spillover
apiVersion: v1
kind: Service
metadata:
  name: api-server
  annotations:
    service.kubernetes.io/topology-mode: "Auto"
    # Kubernetes automatically handles zone fallback:
    # If a zone has 0 ready endpoints, TAR is disabled and
    # traffic falls back to global load balancing
spec:
  selector:
    app: api-server
  ports:
  - port: 80
```

Monitor for TAR fallback events:

```bash
# Check EndpointSlice controller events
kubectl get events -n production \
  --field-selector reason=TopologyAwareHintsDisabled

# Sample event:
# LAST SEEN   TYPE      REASON                        OBJECT
# 5m          Warning   TopologyAwareHintsDisabled    Service/api-server
# Topology aware hints for endpoints "api-server" disabled:
# no endpoints for zone "us-east-1c"
```

## Section 9: AWS and GCP Specific Configuration

### AWS EKS Zone Configuration

```bash
# Verify EKS node zone labels
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.labels.topology\.kubernetes\.io/zone}{"\n"}{end}'

# Check that node groups span multiple AZs
aws eks describe-nodegroup \
  --cluster-name production \
  --nodegroup-name workers \
  --query 'nodegroup.subnets'

# For EKS managed node groups, ensure subnets are in multiple AZs
# in the Terraform or CloudFormation configuration

# AWS Load Balancer Controller: use zone affinity for NLB
kubectl annotate service api-server \
  service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled=false
```

### AWS Cost Monitoring

```bash
# Use AWS Cost Explorer to monitor cross-AZ data transfer
aws ce get-cost-and-usage \
  --time-period Start=2029-04-01,End=2029-04-13 \
  --granularity DAILY \
  --metrics "BlendedCost" \
  --filter '{
    "Dimensions": {
      "Key": "USAGE_TYPE",
      "Values": ["USE1-DataTransfer-Regional-Bytes"]
    }
  }' \
  --query 'ResultsByTime[].Total.BlendedCost.Amount'

# Expected reduction: 50-70% cross-AZ data transfer after TAR
```

### GCP GKE Zone Configuration

```bash
# GKE automatically applies zone labels
# Verify zone distribution
kubectl get nodes -o custom-columns='NAME:.metadata.name,ZONE:.metadata.labels.topology\.kubernetes\.io/zone'

# Enable TAR in GKE with annotation
kubectl annotate service api-server \
  service.kubernetes.io/topology-mode=Auto \
  -n production

# GKE also supports topology spread constraints for even distribution
```

```yaml
# Ensure pods are spread evenly across zones for TAR to work effectively
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
  namespace: production
spec:
  replicas: 9  # 3 per zone for balanced hint allocation
  template:
    spec:
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: api-server
      containers:
      - name: api
        image: registry.example.com/api-server:v1.0
```

## Section 10: Troubleshooting TAR

### Common TAR Problems

**Problem: TAR hints not appearing in EndpointSlice**

```bash
# Check EndpointSlice for hints field
kubectl get endpointslice -n production \
  -l kubernetes.io/service-name=api-server \
  -o jsonpath='{.items[0].endpoints[*].hints}'

# If empty, check:
# 1. Service annotation is correct
kubectl get service api-server -n production \
  -o jsonpath='{.metadata.annotations}'

# 2. Enough ready endpoints (need >= 3)
kubectl get endpoints api-server -n production

# 3. All zones have at least 1 ready endpoint
kubectl get pod -n production -l app=api-server \
  -o custom-columns='NAME:.metadata.name,NODE:.spec.nodeName,STATUS:.status.phase'
```

**Problem: Traffic still going cross-zone despite TAR**

```bash
# Verify kube-proxy is reading hints
kubectl logs -n kube-system \
  $(kubectl get pod -n kube-system -l k8s-app=kube-proxy -o name | head -1) \
  | grep -i topology

# Check if pods have zone labels
kubectl get pod api-server-abc -n production \
  -o jsonpath='{.metadata.labels.topology\.kubernetes\.io/zone}'
# Should return the zone, e.g., "us-east-1a"

# Verify kube-proxy feature gate
kubectl get configmap kube-proxy-config -n kube-system -o yaml | grep -i topology
```

**Problem: TAR disabled event**

```bash
kubectl get events -n production --sort-by='.lastTimestamp' | \
  grep -i topology

# Common reasons:
# "no endpoints for zone X" -> add pods to zone X
# "insufficient endpoints" -> increase replica count to >= 3
# "endpoints per node ratio too high" -> check node count per zone
```

### TAR Debugging with Endpointslice Watch

```bash
# Watch EndpointSlice changes in real-time
kubectl get endpointslice -n production \
  -l kubernetes.io/service-name=api-server \
  -w -o json | jq '.endpoints[] | {address: .addresses[0], zone: .zone, hints: .hints}'
```

## Summary

Topology Aware Routing is one of the highest-ROI features available in modern Kubernetes clusters:

- Enable TAR on latency-sensitive services with the `service.kubernetes.io/topology-mode: Auto` annotation
- Use `spec.trafficDistribution: PreferClose` in Kubernetes 1.31+ for a more explicit API
- Ensure nodes have `topology.kubernetes.io/zone` labels — cloud providers set these automatically
- Deploy at least 3 replicas per zone and use `topologySpreadConstraints` for even distribution
- Monitor TAR effectiveness with Prometheus metrics tracking same-zone vs cross-zone request rates
- Cross-zone cost reduction of 50-70% is achievable for most microservice architectures
- TAR falls back to global load balancing automatically when a zone loses all endpoints
- Use `internalTrafficPolicy: Local` for node-agent services (DaemonSets) instead of TAR
