---
title: "Kubernetes Topology-Aware Routing: Zone-Aware Load Balancing and Cross-AZ Cost Reduction"
date: 2028-06-08T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Networking", "Topology", "Load Balancing", "Cost Optimization", "AWS"]
categories: ["Kubernetes", "Networking", "Cost Optimization"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Kubernetes topology-aware routing: TopologySpreadConstraints, EndpointSlice topology hints, zone-aware load balancing to reduce cross-AZ data transfer costs, and real-world configuration for multi-AZ clusters."
more_link: "yes"
url: "/kubernetes-topology-aware-routing/"
---

Cross-availability-zone (cross-AZ) data transfer is one of the most significant and least-understood cost drivers in cloud Kubernetes deployments. In AWS, inter-AZ traffic within a region costs $0.01/GB in each direction — seemingly small, but a service handling 10TB/day of inter-pod traffic will spend $100,000/year on cross-AZ transfer alone. Kubernetes topology-aware routing addresses this by routing traffic preferentially to endpoints in the same availability zone, dramatically reducing both cost and latency. This guide covers the full configuration: TopologySpreadConstraints, EndpointSlice topology hints, the topology-aware hints feature, and the operational trade-offs involved.

<!--more-->

## Understanding the Cross-AZ Traffic Problem

In a typical Kubernetes cluster spanning three availability zones, traffic routing is round-robin by default:

```
Pod in us-east-1a makes 1000 requests/second
  → kube-proxy uses IPVS/iptables round-robin
    → ~333 requests go to us-east-1a (free)
    → ~333 requests go to us-east-1b ($0.01/GB)
    → ~333 requests go to us-east-1c ($0.01/GB)
```

For a service with 100 pods (33 per AZ), roughly 67% of inter-service traffic crosses AZ boundaries. At $0.01/GB per direction, the cost adds up quickly. Beyond cost, cross-AZ traffic also adds 1-3ms of additional latency compared to intra-AZ routing.

Topology-aware routing ensures that traffic from a pod in `us-east-1a` preferentially routes to pods also in `us-east-1a`, crossing AZ boundaries only when local endpoints are unavailable or overloaded.

## TopologySpreadConstraints

Before routing, the pods must be distributed across zones. `TopologySpreadConstraints` controls pod placement to ensure even distribution:

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
        # Spread evenly across availability zones
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule  # Hard constraint
          labelSelector:
            matchLabels:
              app: api-service
          # minDomains: 3  # Require all 3 zones to have pods (k8s 1.24+)
          matchLabelKeys:
            - pod-template-hash  # Only consider pods from the same ReplicaSet

        # Also spread across nodes within zones (prevents all zone pods on same node)
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: ScheduleAnyway  # Soft constraint
          labelSelector:
            matchLabels:
              app: api-service
```

### Understanding MaxSkew

`maxSkew` defines the maximum allowed difference in pod count between topology domains:

```
With 9 replicas across 3 zones and maxSkew=1:
  Allowed distributions:
    - 3/3/3 (perfectly balanced)
    - 4/3/2 (skew = 2, NOT allowed with maxSkew=1)
    - 4/4/1 (skew = 3, NOT allowed)

With maxSkew=2:
  Allowed distributions:
    - 4/4/1 (skew = 3, NOT allowed)
    - 4/3/2 (skew = 2, allowed)
```

### WhenUnsatisfiable Options

```yaml
# DoNotSchedule: strict - pods remain Pending if constraint cannot be satisfied
# Use for critical services where imbalance is unacceptable
whenUnsatisfiable: DoNotSchedule

# ScheduleAnyway: soft - pods are scheduled even if constraint is violated
# Use for secondary constraints or non-critical services
whenUnsatisfiable: ScheduleAnyway
```

### NodeAffinityPolicy and NodeTaintsPolicy (k8s 1.26+)

```yaml
topologySpreadConstraints:
  - maxSkew: 1
    topologyKey: topology.kubernetes.io/zone
    whenUnsatisfiable: DoNotSchedule
    labelSelector:
      matchLabels:
        app: api-service
    # Honor node affinity when counting pods for spread
    nodeAffinityPolicy: Honor
    # Honor node taints when counting pods for spread
    nodeTaintsPolicy: Honor
```

## EndpointSlice Topology Hints

Topology hints are the mechanism by which kube-proxy uses zone information when routing traffic. When enabled, the EndpointSlice controller adds `hints.forZones` to each endpoint, and kube-proxy uses these hints to prefer local endpoints.

### Enabling Topology Hints

```yaml
apiVersion: v1
kind: Service
metadata:
  name: api-service
  namespace: production
  annotations:
    # Enable topology-aware hints
    service.kubernetes.io/topology-mode: "auto"
    # Legacy annotation (k8s < 1.27): service.kubernetes.io/topology-aware-hints: "auto"
spec:
  selector:
    app: api-service
  ports:
    - port: 8080
      targetPort: 8080
      protocol: TCP
```

### Verifying Hints Are Set

```bash
# Check that EndpointSlice hints are being assigned
kubectl get endpointslices -n production \
  -l kubernetes.io/service-name=api-service \
  -o yaml | grep -A 10 "hints"

# Expected output shows zone hints on each endpoint:
# endpoints:
# - addresses:
#   - 10.0.1.5
#   hints:
#     forZones:
#     - name: us-east-1a
#   conditions:
#     ready: true
#   nodeName: node-us-east-1a-1
#   zone: us-east-1a
```

### Conditions for Hints to Activate

Topology hints have strict activation conditions. If these are not met, kube-proxy falls back to standard routing:

1. **Balanced distribution**: The service has roughly proportional endpoints across zones. If a zone has >20% more or fewer endpoints than expected, hints are not assigned.
2. **Sufficient endpoints**: The total endpoint count times the ratio for any zone must be at least 3. With 2 pods per zone and 3 zones, hints may not activate.
3. **Zone labels**: All nodes must have the `topology.kubernetes.io/zone` label.
4. **Feature gate**: `TopologyAwareHints` must be enabled (default in k8s 1.23+).

```bash
# Verify nodes have zone labels
kubectl get nodes -o custom-columns='NAME:.metadata.name,ZONE:.metadata.labels.topology\.kubernetes\.io/zone'

# Check if hints are disabled due to insufficient endpoints
kubectl get events -n production \
  --field-selector reason=TopologyAwareHintsDisabled
```

### Minimum Replica Count for Hints

A common misconception: with too few replicas, hints are disabled. The minimum is:

```
minimum_replicas = max(3 per zone, zones * 3)

For 3 zones: minimum 9 total replicas (3 per zone)
For 2 zones: minimum 6 total replicas (3 per zone)
```

```yaml
# Insufficient for hints with 3 zones:
replicas: 3  # Only 1 per zone

# Minimum viable for hints with 3 zones:
replicas: 9  # 3 per zone

# Recommended for production with hints:
replicas: 12  # 4 per zone, provides buffer during rolling updates
```

## Verification and Debugging

### Checking Actual Traffic Distribution

```bash
# Check which endpoints kube-proxy is using
# Run from a pod in a specific zone
kubectl exec -it debug-pod-us-east-1a -- \
  for i in $(seq 1 20); do curl -s api-service.production.svc.cluster.local:8080/health | grep -o '"zone":"[^"]*"'; done

# Expected with topology hints: all 20 responses from us-east-1a
# Without hints: ~33% from each zone
```

### EndpointSlice Inspection

```bash
# Full EndpointSlice details including hints
kubectl get endpointslice -n production \
  -l kubernetes.io/service-name=api-service \
  -o json | jq '
    .items[] | {
      name: .metadata.name,
      endpoints: [.endpoints[] | {
        address: .addresses[0],
        zone: .zone,
        hints: .hints,
        ready: .conditions.ready
      }]
    }
  '
```

### kube-proxy Behavior Verification

```bash
# On a worker node, check IPVS rules to see if zone filtering is active
ssh node-us-east-1a
ipvsadm -Ln | grep -A 20 "10.100.0.50:8080"  # Replace with service ClusterIP

# With topology hints: only see endpoints from us-east-1a
# Without topology hints: see endpoints from all zones
```

## Service Internal Traffic Policy

For services that only need to be reachable within the cluster, `internalTrafficPolicy: Local` routes traffic only to local-node endpoints:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: metrics-aggregator
  namespace: monitoring
spec:
  selector:
    app: metrics-aggregator
  internalTrafficPolicy: Local  # Route only to pods on the same node
  ports:
    - port: 9090
      targetPort: 9090
```

This is more aggressive than zone-aware routing: it restricts to node-local endpoints entirely. Appropriate for:
- DaemonSet services where every node has an endpoint
- Node-local caching services
- Performance monitoring agents

If there are no local endpoints, the connection is dropped (not rerouted). Use with caution.

## External Traffic Policy for LoadBalancer Services

For services exposed via cloud load balancers, `externalTrafficPolicy: Local` routes traffic to the node-local pods:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: api-ingress
  namespace: production
spec:
  type: LoadBalancer
  externalTrafficPolicy: Local  # Only route to nodes with local pods
  selector:
    app: api-service
  ports:
    - port: 443
      targetPort: 8443
```

Benefits:
- Preserves source IP (the load balancer's SNAT is bypassed)
- Eliminates one hop of cross-node routing

Drawbacks:
- Uneven load distribution: nodes with more pods receive more traffic
- Health check nodes must have a matching pod (the cloud LB health-checks each node)
- During rolling updates, some nodes may be unhealthy briefly

### Combined Strategy: External Local + Internal Zone-Aware

```yaml
# Frontend LoadBalancer: external traffic stays on the node where it lands
apiVersion: v1
kind: Service
metadata:
  name: nginx-ingress
  namespace: ingress-nginx
spec:
  type: LoadBalancer
  externalTrafficPolicy: Local
  selector:
    app: nginx-ingress

---
# Backend API: internal traffic is zone-aware
apiVersion: v1
kind: Service
metadata:
  name: api-service
  namespace: production
  annotations:
    service.kubernetes.io/topology-mode: "auto"
spec:
  selector:
    app: api-service
  ports:
    - port: 8080
```

## Cost Analysis and Monitoring

### Measuring Cross-AZ Traffic

```bash
# AWS VPC Flow Logs query to measure cross-AZ traffic
# Requires flow logs enabled to CloudWatch or S3
aws logs filter-log-events \
  --log-group-name /aws/vpc/flowlogs \
  --filter-pattern '[version, account, interfaceId, srcAddr, dstAddr, srcPort, dstPort, protocol, packets, bytes, startTime, endTime, action, logStatus]' \
  --query "events[*].message" \
  | grep "ACCEPT"
```

### Estimating Savings

A rough calculation for a microservices application with 10 services, each handling 100MB/s of inter-service traffic:

```
Total inter-service traffic: 10 services * 100MB/s = 1000MB/s
Without topology routing: 67% cross-AZ = 670MB/s cross-AZ
With topology routing: ~5% cross-AZ (only during zone failures/imbalance) = 50MB/s

Cross-AZ traffic reduction: 620MB/s
Daily savings: 620MB/s * 86400s * $0.01/GB / 1000 = $535/day
Annual savings: ~$195,000
```

### Istio/Envoy Locality Weighted Load Balancing

For service mesh users, Envoy provides more sophisticated locality-aware routing:

```yaml
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: api-service
  namespace: production
spec:
  host: api-service.production.svc.cluster.local
  trafficPolicy:
    connectionPool:
      tcp:
        maxConnections: 1000
    loadBalancer:
      localityLbSetting:
        enabled: true
        # Distribute traffic based on locality
        distribute:
          - from: us-east-1/us-east-1a/*
            to:
              "us-east-1/us-east-1a/*": 90  # 90% to same zone
              "us-east-1/us-east-1b/*": 10  # 10% to other zones
          - from: us-east-1/us-east-1b/*
            to:
              "us-east-1/us-east-1b/*": 90
              "us-east-1/us-east-1a/*": 10
          - from: us-east-1/us-east-1c/*
            to:
              "us-east-1/us-east-1c/*": 90
              "us-east-1/us-east-1a/*": 10
        # Failover when zone has no healthy endpoints
        failover:
          - from: us-east-1
            to: us-west-2
```

## Production Configuration Checklist

### Node Configuration

```bash
# Verify all nodes have topology zone labels
kubectl get nodes -o custom-columns='NAME:.metadata.name,ZONE:.metadata.labels.topology\.kubernetes\.io/zone,REGION:.metadata.labels.topology\.kubernetes\.io/region'

# Expected output:
# NAME                    ZONE           REGION
# ip-10-0-1-100.internal us-east-1a     us-east-1
# ip-10-0-2-100.internal us-east-1b     us-east-1
# ip-10-0-3-100.internal us-east-1c     us-east-1
```

### Deployment Configuration Validation

```bash
# Verify pods are actually spread across zones
kubectl get pods -n production -l app=api-service \
  -o custom-columns='NAME:.metadata.name,NODE:.spec.nodeName,ZONE:.metadata.labels.topology\.kubernetes\.io/zone'

# Check TopologySpreadConstraints are being satisfied
kubectl describe pod -n production -l app=api-service | grep -A 5 "Topology"
```

### Monitoring Topology Hint Activation

```yaml
# PrometheusRule to alert when topology hints are disabled
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: topology-routing-alerts
  namespace: monitoring
spec:
  groups:
    - name: topology-routing
      rules:
        - alert: TopologyHintsDisabled
          expr: |
            kube_service_annotations{annotation_service_kubernetes_io_topology_mode="auto"}
            unless
            kube_endpointslice_endpoint_info{topology_zone!=""}
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Topology hints may be disabled for service {{ $labels.service }}"
            description: "Service has topology-mode=auto but endpoints may not have zone hints assigned. Check that replicas are balanced across zones (minimum 3 per zone)."
```

### Prometheus Metrics for Cross-Zone Traffic

If using Cilium as the CNI, additional metrics are available:

```
# Cilium metrics for cross-zone traffic
cilium_drop_count_total{direction="INGRESS",reason="Lack of IPv4 fragment buffer"}
cilium_forward_count_total{direction="EGRESS"}
```

For Istio:
```
# Istio locality load balancing metrics
envoy_cluster_upstream_cx_total{envoy_cluster_name="outbound|8080||api-service.production.svc.cluster.local"}
envoy_cluster_upstream_rq_total
```

## When Topology-Aware Routing Is Not Appropriate

Topology hints should not be enabled for:

- **Services with very few replicas** (< 3 per zone): Hints are automatically disabled, but attempting to enable them adds confusion
- **Services that must be globally distributed**: If cross-AZ routing provides redundancy for stateful services, disabling it may cause availability issues
- **Services with extreme load imbalance**: If one zone handles 90% of traffic and has fewer replicas, topology routing will overload those pods
- **Dev/staging environments**: Single-AZ environments don't benefit and may behave unexpectedly

Topology-aware routing is a production optimization for multi-AZ clusters at scale. The configuration is straightforward, but the pre-conditions (balanced pod distribution, sufficient replica count, node zone labels) must all be satisfied for hints to activate. Monitor the EndpointSlice controller events for `TopologyAwareHintsDisabled` warnings to diagnose when hints are not taking effect.
