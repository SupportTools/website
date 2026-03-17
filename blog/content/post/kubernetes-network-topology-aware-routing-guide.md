---
title: "Kubernetes Topology-Aware Routing: Zone-Aware Load Balancing"
date: 2028-10-16T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Networking", "Topology", "Load Balancing", "Cloud"]
categories:
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Kubernetes Topology-Aware Routing, covering Topology Aware Hints, EndpointSlice topology fields, Traffic Distribution policy, cross-AZ cost reduction, and troubleshooting zone-local routing."
more_link: "yes"
url: "/kubernetes-network-topology-aware-routing-guide/"
---

Cross-availability-zone data transfer is one of the largest hidden costs in Kubernetes on cloud providers. Every time kube-proxy or a service mesh routes traffic from a pod in us-east-1a to an endpoint in us-east-1b, you pay $0.01/GB in cross-AZ transfer fees. For services handling hundreds of gigabytes per day, this accumulates into thousands of dollars monthly for no reliability benefit when replicas exist in every zone.

Kubernetes Topology-Aware Routing (TAR) solves this by annotating EndpointSlices with zone hints that tell kube-proxy to prefer endpoints in the same zone as the requesting pod. This guide covers the mechanism, configuration, testing methodology, and failure modes.

<!--more-->

# Kubernetes Topology-Aware Routing: Zone-Aware Load Balancing

## The Cross-AZ Cost Problem

In a three-zone EKS cluster, a service with three pods (one per zone) receiving traffic from pods spread across all three zones has a 2/3 probability that any given request crosses zones. With kube-proxy's default random load balancing:

```
Pod in us-east-1a → Service →
  33% chance: endpoint in us-east-1a (free)
  33% chance: endpoint in us-east-1b ($0.01/GB)
  33% chance: endpoint in us-east-1c ($0.01/GB)
```

Effective cross-AZ rate: 67% of all service-to-service traffic.

With topology-aware routing:
```
Pod in us-east-1a → Service →
  ~100% chance: endpoint in us-east-1a (free)
  (falls back to other zones only if local endpoints are unavailable)
```

## How Topology-Aware Hints Work

The EndpointSlice controller (in kube-controller-manager) watches Services and their EndpointSlices. When topology hints are enabled, it:

1. Reads the zone topology of every endpoint (from `topology.kubernetes.io/zone` node label)
2. Calculates how many endpoints each zone should receive based on the distribution of kube-proxy consuming that service across zones
3. Annotates each endpoint in the EndpointSlice with `hints.forZones` specifying which zones should use it

kube-proxy reads these hints and installs iptables/ipvs rules that route to zone-local endpoints, falling back to all endpoints if local ones become unavailable.

## Node Topology Labels

Topology-aware routing requires nodes to have the standard zone label. Verify your cluster:

```bash
kubectl get nodes -o custom-columns=\
"NAME:.metadata.name,ZONE:.metadata.labels.topology\.kubernetes\.io/zone,REGION:.metadata.labels.topology\.kubernetes\.io/region"

# NAME                            ZONE          REGION
# ip-10-0-1-100.ec2.internal      us-east-1a    us-east-1
# ip-10-0-2-100.ec2.internal      us-east-1b    us-east-1
# ip-10-0-3-100.ec2.internal      us-east-1c    us-east-1
```

Cloud-managed node groups (EKS managed nodes, GKE node pools, AKS node pools) set these labels automatically. Self-managed nodes require explicit configuration:

```yaml
# In kubelet config or as node labels set during bootstrap
--node-labels=topology.kubernetes.io/zone=us-east-1a,topology.kubernetes.io/region=us-east-1
```

## Enabling Topology Aware Hints

Add the annotation `service.kubernetes.io/topology-mode: Auto` to your Service:

```yaml
# topology-aware-service.yaml
apiVersion: v1
kind: Service
metadata:
  name: payment-processor
  namespace: payments
  annotations:
    # Auto: EndpointSlice controller adds hints when conditions are met
    service.kubernetes.io/topology-mode: "Auto"
spec:
  selector:
    app: payment-processor
  ports:
    - name: http
      port: 80
      targetPort: 8080
  type: ClusterIP
```

```bash
kubectl apply -f topology-aware-service.yaml

# Check that hints were applied to EndpointSlices
kubectl get endpointslices -n payments -l kubernetes.io/service-name=payment-processor -o yaml
```

## Inspecting EndpointSlice Hints

After enabling, the EndpointSlice should show `forZones` hints on each endpoint:

```bash
kubectl get endpointslice -n payments \
  -l kubernetes.io/service-name=payment-processor \
  -o jsonpath='{.items[0]}' | jq '.endpoints[] | {addresses, zone: .topology["topology.kubernetes.io/zone"], hints: .hints}'
```

Expected output:

```json
{
  "addresses": ["10.0.1.50"],
  "zone": "us-east-1a",
  "hints": {
    "forZones": [{"name": "us-east-1a"}]
  }
}
{
  "addresses": ["10.0.2.50"],
  "zone": "us-east-1b",
  "hints": {
    "forZones": [{"name": "us-east-1b"}]
  }
}
{
  "addresses": ["10.0.3.50"],
  "zone": "us-east-1c",
  "hints": {
    "forZones": [{"name": "us-east-1c"}]
  }
}
```

If hints are missing, check the conditions under which the EndpointSlice controller adds them (see "Conditions and Fallbacks" section below).

## Traffic Distribution Policy (Kubernetes 1.31+)

Starting in Kubernetes 1.31, a simpler `spec.trafficDistribution` field replaces the annotation approach for common cases:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: payment-processor
  namespace: payments
spec:
  selector:
    app: payment-processor
  ports:
    - port: 80
      targetPort: 8080
  # PreferClose routes to topologically closest endpoints (same zone first)
  trafficDistribution: PreferClose
```

`PreferClose` is the recommended field for zone-local routing. It has the same semantics as `topology-mode: Auto` but is part of the stable API.

## Conditions and Fallbacks

The EndpointSlice controller adds hints only when:

1. **Sufficient endpoints per zone**: Each zone must have at least one endpoint. The controller uses the ratio of kube-proxy-consuming nodes per zone to determine how many endpoints each zone should be allocated. If a zone has 40% of nodes, it needs endpoints that represent 40% of capacity.

2. **No overload condition**: If a zone's allocated endpoints would receive more than 150% of their proportional share of traffic (due to uneven distribution), hints are removed and traffic reverts to random.

3. **All endpoints healthy**: If endpoints in any zone go unhealthy and the remaining capacity cannot absorb the load, hints are removed for the affected zone.

Check hint status events:

```bash
kubectl describe endpointslice -n payments \
  $(kubectl get endpointslice -n payments \
    -l kubernetes.io/service-name=payment-processor \
    -o jsonpath='{.items[0].metadata.name}')

# Look for events like:
# Warning  TopologyAwareHintsDisabled  Disabled "Auto" topology hints:
#   insufficient number of endpoints for topology hints (need at least 3)
```

Common reasons hints are disabled:

```bash
# Check EndpointSlice controller events
kubectl get events -n payments --field-selector reason=TopologyAwareHintsDisabled

# Verify pod distribution across zones
kubectl get pods -n payments -l app=payment-processor \
  -o custom-columns="NAME:.metadata.name,NODE:.spec.nodeName,STATUS:.status.phase" | \
  while read name node status; do
    zone=$(kubectl get node $node -o jsonpath='{.metadata.labels.topology\.kubernetes\.io/zone}' 2>/dev/null)
    echo "$name $node $zone $status"
  done
```

## Ensuring Pod Distribution Across Zones

Topology-aware routing only helps when pods are spread across zones. Use `topologySpreadConstraints` to enforce this:

```yaml
# Deployment with zone-spread constraints
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-processor
  namespace: payments
spec:
  replicas: 6  # 2 per zone in a 3-zone cluster
  selector:
    matchLabels:
      app: payment-processor
  template:
    metadata:
      labels:
        app: payment-processor
    spec:
      topologySpreadConstraints:
        # Hard requirement: at most 1 pod difference between zones
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: payment-processor
        # Soft preference: spread across nodes within each zone
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: ScheduleAnyway
          labelSelector:
            matchLabels:
              app: payment-processor
      containers:
        - name: payment-processor
          image: registry.yourorg.com/payment-processor:v1.2.3
          ports:
            - containerPort: 8080
          resources:
            requests:
              cpu: 250m
              memory: 256Mi
```

## Configuring a PodDisruptionBudget for Zone Resilience

Topology-aware routing fails back to cross-zone routing when a zone's endpoints are unavailable. Protect against losing all endpoints in a zone during rolling updates:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: payment-processor-pdb
  namespace: payments
spec:
  minAvailable: "67%"  # Keep at least 2 of 3 zones healthy during disruption
  selector:
    matchLabels:
      app: payment-processor
```

## Testing Topology-Aware Routing

Verify that traffic stays zone-local by running a test pod pinned to a specific zone:

```bash
# Create a test pod in us-east-1a
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: topology-test
  namespace: payments
spec:
  nodeSelector:
    topology.kubernetes.io/zone: us-east-1a
  containers:
    - name: curl
      image: curlimages/curl:latest
      command: ["sleep", "3600"]
EOF

kubectl exec -n payments topology-test -- \
  sh -c 'for i in $(seq 1 20); do
    curl -s http://payment-processor/zone-header
  done'
```

Add a zone-reporting endpoint to your service for testing:

```go
// Add to your Go HTTP handler
http.HandleFunc("/zone-header", func(w http.ResponseWriter, r *http.Request) {
    zone := os.Getenv("POD_ZONE")  // Set via downward API
    podName := os.Getenv("POD_NAME")
    w.Header().Set("X-Pod-Zone", zone)
    w.Header().Set("X-Pod-Name", podName)
    fmt.Fprintf(w, `{"zone":"%s","pod":"%s"}`, zone, podName)
})
```

Pass zone information to pods via the downward API:

```yaml
env:
  - name: POD_ZONE
    valueFrom:
      fieldRef:
        fieldPath: metadata.annotations['topology.kubernetes.io/zone']
  - name: POD_NAME
    valueFrom:
      fieldRef:
        fieldPath: metadata.name
```

Or use node labels via init container:

```yaml
initContainers:
  - name: zone-init
    image: bitnami/kubectl:latest
    command:
      - sh
      - -c
      - |
        ZONE=$(kubectl get node $NODE_NAME -o jsonpath='{.metadata.labels.topology\.kubernetes\.io/zone}')
        echo "POD_ZONE=$ZONE" >> /etc/pod-env/zone
    env:
      - name: NODE_NAME
        valueFrom:
          fieldRef:
            fieldPath: spec.nodeName
    volumeMounts:
      - name: pod-env
        mountPath: /etc/pod-env
```

## Monitoring Cross-AZ Traffic

Track whether topology-aware routing is working with Prometheus metrics. kube-proxy does not expose per-zone routing metrics directly, but you can instrument your applications:

```go
var (
    requestsTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
        Name: "service_requests_total",
        Help: "Total requests by source and destination zone",
    }, []string{"source_zone", "dest_zone"})
)

// In your HTTP handler or gRPC interceptor:
sourceZone := os.Getenv("POD_ZONE")
destZone := r.Header.Get("X-Pod-Zone")  // set by the responding service
requestsTotal.WithLabelValues(sourceZone, destZone).Inc()
```

Alert on cross-zone traffic exceeding expected levels:

```promql
# Cross-zone requests as fraction of total
sum(rate(service_requests_total{source_zone!="",dest_zone!=""}[5m])
    and on (source_zone, dest_zone) (source_zone != dest_zone))
/
sum(rate(service_requests_total[5m]))
```

## Service Mesh Integration

Istio and Cilium implement topology-aware routing independently of kube-proxy:

**Istio**: Use `DestinationRule` with `localityLbSetting`:

```yaml
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: payment-processor
  namespace: payments
spec:
  host: payment-processor.payments.svc.cluster.local
  trafficPolicy:
    loadBalancer:
      localityLbSetting:
        enabled: true
        failover:
          - from: us-east-1/us-east-1a
            to: us-east-1/us-east-1b
          - from: us-east-1/us-east-1b
            to: us-east-1/us-east-1c
          - from: us-east-1/us-east-1c
            to: us-east-1/us-east-1a
    outlierDetection:
      consecutiveGatewayErrors: 5
      interval: 30s
      baseEjectionTime: 30s
```

**Cilium**: Enable with `--enable-endpoint-routes` and configure load balancing topology in the Cilium ConfigMap.

## Troubleshooting Checklist

```bash
# 1. Verify node zone labels exist
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}:{.metadata.labels.topology\.kubernetes\.io/zone}{"\n"}{end}'

# 2. Confirm service annotation is present
kubectl get svc -n payments payment-processor -o jsonpath='{.metadata.annotations}'

# 3. Check EndpointSlice for hints
kubectl get endpointslice -n payments \
  -l kubernetes.io/service-name=payment-processor \
  -o jsonpath='{range .items[0].endpoints[*]}{.addresses[0]}:{.hints.forZones[0].name}{"\n"}{end}'

# 4. Verify pod spread across zones
kubectl get pods -n payments -l app=payment-processor -o wide | \
  awk 'NR>1{print $7}' | sort | uniq -c

# 5. Check kube-proxy is using the hints
# On a node in us-east-1a, verify iptables rules prefer 1a endpoints
kubectl debug node/ip-10-0-1-100.ec2.internal -it --image=busybox -- \
  chroot /host iptables-save | grep KUBE-SEP | grep 10.0.1

# 6. Check for hint-disabled events
kubectl get events --all-namespaces \
  --field-selector reason=TopologyAwareHintsDisabled
```

Topology-aware routing is one of the few Kubernetes features that simultaneously reduces costs and improves performance (lower latency from zone-local routing) without affecting reliability (automatic fallback to cross-zone when local endpoints fail). Enable it on any service where all zones have running endpoints, and measure the cross-AZ transfer cost reduction over a billing cycle.
