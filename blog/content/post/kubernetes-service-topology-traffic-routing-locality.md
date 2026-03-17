---
title: "Kubernetes Service Topology: Traffic Routing and Locality"
date: 2029-08-30T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Networking", "Service Topology", "EndpointSlice", "AWS", "GCP", "Latency"]
categories: ["Kubernetes", "Networking"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep dive into Kubernetes service topology features covering topology-aware hints, EndpointSlice topology fields, zone-aware load balancing for latency reduction, and AWS/GCP multi-zone topology strategies."
more_link: "yes"
url: "/kubernetes-service-topology-traffic-routing-locality/"
---

Cross-zone traffic is one of the most overlooked cost and latency drivers in multi-zone Kubernetes deployments. In AWS and GCP, every byte that crosses an availability zone boundary incurs per-GB transfer charges and adds measurable network latency. Kubernetes topology-aware routing gives you the mechanisms to keep traffic local without hard-partitioning your services. This guide covers the complete topology routing stack from EndpointSlice fields through production-ready zone-aware service configuration.

<!--more-->

# Kubernetes Service Topology: Traffic Routing and Locality

## Section 1: The Cost of Cross-Zone Traffic

In a typical 3-zone Kubernetes cluster on AWS or GCP, without topology-aware routing, kube-proxy distributes traffic uniformly across all healthy endpoints regardless of zone. For a service with 9 replicas spread 3-per-zone, any given pod sends roughly 67% of its outbound traffic to pods in other zones.

At $0.01/GB for intra-region cross-AZ transfer on AWS (as of 2029), a service processing 10 TB/month of service-to-service traffic pays approximately $670/month just in cross-zone data transfer for a single service pair. At scale across hundreds of microservices, zone-unaware routing can add tens of thousands of dollars per month to your AWS bill.

The latency impact is equally significant. Intra-zone pod-to-pod RTT is typically 0.1-0.5ms. Cross-zone RTT within the same region is typically 1-5ms. For p99 latency targets, these seemingly small differences compound across multi-hop service chains.

## Section 2: Topology-Aware Hints

Topology-aware hints is the current GA feature (Kubernetes 1.27+) for directing traffic toward zone-local endpoints. The mechanism works through annotations and labels on EndpointSlices.

### How Topology-Aware Hints Work

1. The EndpointSlice controller reads zone distribution from the topology labels on nodes.
2. For each endpoint in an EndpointSlice, the controller may set a `hints.forZones` field specifying which zones should consume that endpoint.
3. kube-proxy reads the hints and, when routing traffic from a node in zone X, prefers endpoints that have a hint for zone X.
4. When no zone-local endpoints are available (all unhealthy), kube-proxy falls back to the full endpoint set.

### Enabling Topology-Aware Hints

```yaml
# Service annotation to enable topology-aware hints
apiVersion: v1
kind: Service
metadata:
  name: my-backend
  namespace: production
  annotations:
    # Enable topology-aware hints (GA since Kubernetes 1.27)
    service.kubernetes.io/topology-mode: "auto"
spec:
  selector:
    app: my-backend
  ports:
    - name: http
      protocol: TCP
      port: 80
      targetPort: 8080
  type: ClusterIP
```

The `auto` value instructs the EndpointSlice controller to automatically assign hints based on proportional zone distribution. The controller will only assign hints when:
- The Service has 3 or more endpoints
- Each zone has at least one endpoint
- No zone has more than 2x the CPU capacity of any other zone (for proportional allocation)

### Inspecting EndpointSlice Hints

```bash
# Inspect EndpointSlice topology hints after enabling
kubectl get endpointslice -n production -l kubernetes.io/service-name=my-backend -o yaml

# Example output showing hints field:
# apiVersion: discovery.k8s.io/v1
# kind: EndpointSlice
# metadata:
#   name: my-backend-abc12
#   namespace: production
#   labels:
#     kubernetes.io/service-name: my-backend
# addressType: IPv4
# endpoints:
#   - addresses:
#       - "10.0.1.15"
#     conditions:
#       ready: true
#     hints:
#       forZones:
#         - name: us-east-1a
#     nodeName: ip-10-0-1-100.ec2.internal
#     zone: us-east-1a
#   - addresses:
#       - "10.0.2.20"
#     conditions:
#       ready: true
#     hints:
#       forZones:
#         - name: us-east-1b
#     nodeName: ip-10-0-2-50.ec2.internal
#     zone: us-east-1b
```

## Section 3: EndpointSlice Topology Fields

The EndpointSlice API provides the data model for topology-aware routing. Understanding its fields is essential for debugging routing behavior.

### EndpointSlice Structure

```yaml
# Detailed EndpointSlice showing all topology-relevant fields
apiVersion: discovery.k8s.io/v1
kind: EndpointSlice
metadata:
  name: my-backend-xyz99
  namespace: production
  labels:
    kubernetes.io/service-name: my-backend
    endpointslice.kubernetes.io/managed-by: endpointslice-controller.k8s.io
  ownerReferences:
    - apiVersion: v1
      kind: Service
      name: my-backend
addressType: IPv4
endpoints:
  - addresses:
      - "10.0.1.15"
    conditions:
      ready: true
      serving: true      # Pod is serving traffic (even during graceful shutdown)
      terminating: false # Pod is not terminating
    hints:
      forZones:
        - name: us-east-1a  # kube-proxy in us-east-1a will prefer this endpoint
    hostname: my-backend-pod-xyz  # DNS hostname if applicable
    nodeName: ip-10-0-1-100.ec2.internal
    targetRef:
      kind: Pod
      name: my-backend-7d8f9b-pqrs
      namespace: production
    zone: us-east-1a
  - addresses:
      - "10.0.2.20"
    conditions:
      ready: true
      serving: true
      terminating: false
    hints:
      forZones:
        - name: us-east-1b
    nodeName: ip-10-0-2-50.ec2.internal
    targetRef:
      kind: Pod
      name: my-backend-7d8f9b-tuvw
      namespace: production
    zone: us-east-1b
ports:
  - name: http
    port: 8080
    protocol: TCP
```

### Node Zone Labels

For topology-aware routing to work, nodes must be labeled with zone information. Cloud providers set these automatically; bare-metal clusters require manual labeling or node-lifecycle automation.

```bash
# Check zone labels on nodes
kubectl get nodes --show-labels | grep topology.kubernetes.io/zone

# AWS EKS: nodes are automatically labeled
kubectl get node ip-10-0-1-100.ec2.internal \
  -o jsonpath='{.metadata.labels}' | jq '{
    zone: .["topology.kubernetes.io/zone"],
    region: .["topology.kubernetes.io/region"],
    az: .["failure-domain.beta.kubernetes.io/zone"]
  }'
# Output:
# {
#   "zone": "us-east-1a",
#   "region": "us-east-1",
#   "az": "us-east-1a"
# }

# Manually label nodes in bare-metal clusters
kubectl label node worker-01 \
  topology.kubernetes.io/zone=dc1-rack-a \
  topology.kubernetes.io/region=dc1

# Verify kube-proxy topology awareness
kubectl get configmap kube-proxy -n kube-system -o yaml | grep -A5 topology
```

## Section 4: Zone-Aware Load Balancing — Deep Configuration

### Service with TrafficPolicy InternalLocal

For internal services (ClusterIP), use `internalTrafficPolicy: Local` to force traffic to stay on the same node — the strongest form of locality. This is appropriate for DaemonSet-backed services like log collectors or metrics agents.

```yaml
# node-local service — all traffic stays on the same node
apiVersion: v1
kind: Service
metadata:
  name: log-collector
  namespace: monitoring
spec:
  selector:
    app: fluentd
  ports:
    - port: 24224
      targetPort: 24224
  internalTrafficPolicy: Local  # Only route to pods on the same node
```

For standard services where node-local is too restrictive but zone-local is preferred:

```yaml
# Zone-preferred service — topology-aware hints
apiVersion: v1
kind: Service
metadata:
  name: user-service
  namespace: production
  annotations:
    service.kubernetes.io/topology-mode: "auto"
spec:
  selector:
    app: user-service
  ports:
    - name: grpc
      port: 9090
      targetPort: 9090
    - name: metrics
      port: 9091
      targetPort: 9091
  sessionAffinity: None
```

### External Traffic Policy for LoadBalancer Services

For LoadBalancer services exposed externally, `externalTrafficPolicy: Local` preserves the client source IP and avoids SNAT, while also keeping traffic on the node that received it.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: ingress-nginx
  namespace: ingress-nginx
  annotations:
    # AWS: preserve client IP and avoid extra hop
    service.beta.kubernetes.io/aws-load-balancer-type: "external"
    service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: "ip"
    service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled: "false"
spec:
  selector:
    app.kubernetes.io/name: ingress-nginx
    app.kubernetes.io/component: controller
  ports:
    - name: http
      protocol: TCP
      port: 80
      targetPort: http
    - name: https
      protocol: TCP
      port: 443
      targetPort: https
  type: LoadBalancer
  externalTrafficPolicy: Local
  # With externalTrafficPolicy: Local:
  # - Traffic goes only to nodes running a matching pod
  # - Source IP is preserved (no SNAT)
  # - No cross-node hop
  # - Potential imbalance if pods are unevenly distributed
```

## Section 5: AWS Zone Topology Implementation

### EKS Multi-Zone Deployment Best Practices

```yaml
# Deployment with zone-spread constraints
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
  namespace: production
spec:
  replicas: 6  # Divisible by 3 for even zone spread
  selector:
    matchLabels:
      app: api-server
  template:
    metadata:
      labels:
        app: api-server
    spec:
      # Force pods across zones AND nodes
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: api-server
          matchLabelKeys:
            - pod-template-hash  # Kubernetes 1.27+ - consider only pods from current rollout
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: ScheduleAnyway
          labelSelector:
            matchLabels:
              app: api-server

      # Prefer scheduling on nodes with spare capacity in underutilized zones
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchExpressions:
                    - key: app
                      operator: In
                      values:
                        - api-server
                topologyKey: kubernetes.io/hostname

      containers:
        - name: api-server
          image: registry.internal.corp/api-server:v2.1.0
          resources:
            requests:
              cpu: "500m"
              memory: "512Mi"
            limits:
              cpu: "2"
              memory: "2Gi"
```

### AWS NLB with Zone-Aware Routing

```yaml
# AWS NLB with zonal DNS enabled for lowest latency
apiVersion: v1
kind: Service
metadata:
  name: api-server-nlb
  namespace: production
  annotations:
    service.beta.kubernetes.io/aws-load-balancer-type: "external"
    service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: "ip"
    # Disable cross-zone load balancing — let clients use zone-local NLB nodes
    service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled: "false"
    # Enable zonal shift for better failure isolation
    service.beta.kubernetes.io/aws-load-balancer-enable-zonal-shift: "true"
    # Target group attributes
    service.beta.kubernetes.io/aws-load-balancer-target-group-attributes: >
      deregistration_delay.timeout_seconds=30,
      deregistration_delay.connection_termination.enabled=true
    # IP address type
    service.beta.kubernetes.io/aws-load-balancer-ip-address-type: "ipv4"
    # Health check settings
    service.beta.kubernetes.io/aws-load-balancer-healthcheck-interval: "10"
    service.beta.kubernetes.io/aws-load-balancer-healthcheck-healthy-threshold: "2"
    service.beta.kubernetes.io/aws-load-balancer-healthcheck-unhealthy-threshold: "2"
spec:
  selector:
    app: api-server
  ports:
    - name: https
      protocol: TCP
      port: 443
      targetPort: 8443
  type: LoadBalancer
  externalTrafficPolicy: Local
```

## Section 6: GCP Zone Topology Implementation

### GKE Topology-Aware Routing

```yaml
# GKE Service with NEG and topology hints
apiVersion: v1
kind: Service
metadata:
  name: recommendation-service
  namespace: production
  annotations:
    # Enable container-native load balancing via NEGs
    cloud.google.com/neg: '{"ingress": true}'
    # Topology-aware hints
    service.kubernetes.io/topology-mode: "auto"
    # GKE traffic director integration for advanced routing
    networking.gke.io/load-balancer-type: "Internal"
spec:
  selector:
    app: recommendation-service
  ports:
    - name: grpc
      port: 443
      targetPort: 8443
      protocol: TCP
  type: ClusterIP
```

```yaml
# GKE BackendConfig for advanced health checks and traffic routing
apiVersion: cloud.google.com/v1
kind: BackendConfig
metadata:
  name: recommendation-service-backend
  namespace: production
spec:
  healthCheck:
    checkIntervalSec: 10
    timeoutSec: 5
    healthyThreshold: 2
    unhealthyThreshold: 3
    type: HTTP
    requestPath: /healthz
    port: 8080

  connectionDraining:
    drainingTimeoutSec: 30

  sessionAffinity:
    affinityType: "GENERATED_COOKIE"
    affinityCookieTtlSec: 50
```

### GKE Autopilot Zone Distribution

```yaml
# GKE Autopilot: explicit zone distribution via nodeSelector
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-service
  namespace: production
spec:
  replicas: 3
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

      # GKE Autopilot: request spot/standard capacity class per zone
      nodeSelector:
        cloud.google.com/gke-spot: "false"  # Use standard nodes for critical services

      containers:
        - name: payment-service
          image: gcr.io/myproject/payment-service:v3.0.0
          resources:
            requests:
              cpu: "1"
              memory: "1Gi"
```

## Section 7: Cilium Zone-Aware Routing

For clusters running Cilium as the CNI, Cilium's native load balancing provides even finer-grained topology control.

```yaml
# Cilium CiliumLocalRedirectPolicy for node-local service routing
apiVersion: "cilium.io/v2"
kind: CiliumLocalRedirectPolicy
metadata:
  name: node-local-dns
  namespace: kube-system
spec:
  redirectFrontend:
    serviceMatcher:
      serviceName: kube-dns
      namespace: kube-system
  redirectBackend:
    localEndpointSelector:
      matchLabels:
        k8s-app: node-local-dns
    toPorts:
      - port: "53"
        protocol: UDP
      - port: "53"
        protocol: TCP
```

```yaml
# Cilium LoadBalancer IPAM with zone awareness
apiVersion: "cilium.io/v2alpha1"
kind: CiliumLoadBalancerIPPool
metadata:
  name: zone-a-pool
spec:
  cidrs:
    - cidr: "10.0.100.0/24"
  # Associate this IP pool with zone a nodes
  nodeSelector:
    matchLabels:
      topology.kubernetes.io/zone: us-east-1a
  allowFirstLastIPs: "No"
```

## Section 8: Measuring Zone Topology Effectiveness

### Validate Hint Assignment

```bash
# Check that hints are being assigned
kubectl get endpointslices -n production \
  -l kubernetes.io/service-name=my-backend \
  -o jsonpath='{range .items[*]}{range .endpoints[*]}{.zone}{"\t"}{.hints.forZones[*].name}{"\n"}{end}{end}'

# Expected output - each endpoint's zone matches its hint:
# us-east-1a    us-east-1a
# us-east-1b    us-east-1b
# us-east-1c    us-east-1c
```

### Prometheus Metrics for Cross-Zone Traffic

```yaml
# ServiceMonitor for measuring zone-local traffic ratios
# Deploy kube-state-metrics and network metrics exporters first

# Example PromQL to calculate cross-zone traffic ratio:
#
# Cross-zone traffic rate (requires node exporter with zone labels):
#
# sum by (source_zone, destination_zone) (
#   rate(container_network_transmit_bytes_total[5m])
# )
# where source_zone != destination_zone
# /
# sum(rate(container_network_transmit_bytes_total[5m]))
#
# Zone-local traffic ratio (higher is better):
#
# sum by (zone) (
#   rate(kube_pod_info[5m]) * on(pod, namespace) group_left(zone)
#   kube_pod_info
# ) where source_zone == destination_zone
# /
# sum(rate(kube_pod_info[5m]))

apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: zone-topology-alerts
  namespace: monitoring
spec:
  groups:
    - name: zone.topology
      rules:
        - alert: ZoneTopologyHintsNotAssigned
          expr: |
            kube_endpointslice_info{topology_mode="auto"}
            unless
            kube_endpointslice_endpoint_hints_for_zones > 0
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Topology hints not being assigned for service {{ $labels.service }}"
            description: "Service {{ $labels.service }} has topology-mode=auto but no hints are assigned. Check that enough endpoints exist per zone."
```

### Debugging Topology Routing

```bash
# Check kube-proxy mode
kubectl get configmap kube-proxy -n kube-system -o jsonpath='{.data.config\.conf}' | \
  python3 -c "import sys,yaml; c=yaml.safe_load(sys.stdin); print('Mode:', c.get('mode', 'iptables'))"

# For iptables mode - check if topology rules are installed
# Run on a node in zone us-east-1a:
iptables -t nat -L KUBE-SVC-XXXXXXXXXXX -n -v | head -50
# Topology-aware rules will show higher weights for same-zone endpoints

# For ipvs mode
ipvsadm -Ln | grep -A5 "ClusterIP:port"

# Check events for topology hint issues
kubectl get events -n production --field-selector reason=TopologyAwareHintsDisabled

# Common reasons hints are disabled:
# - "insufficient number of endpoints for zone X" (< 1 endpoint per zone)
# - "unbalanced zone capacities" (one zone has > 2x capacity of another)
# - "insufficient endpoints" (total endpoint count < 3)
```

## Section 9: Latency Benchmarking

### Measuring Zone-to-Zone Latency

```yaml
# latency-benchmark-job.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: zone-latency-benchmark
  namespace: default
spec:
  completions: 30
  parallelism: 3
  template:
    spec:
      # Run in specific zone to measure cross-zone latency
      nodeSelector:
        topology.kubernetes.io/zone: us-east-1a
      containers:
        - name: latency-probe
          image: curlimages/curl:latest
          command:
            - /bin/sh
            - -c
            - |
              # Measure latency to service endpoint with and without topology hints
              echo "=== Zone-local (topology hints enabled) ==="
              for i in $(seq 1 10); do
                curl -s -o /dev/null \
                  -w "connect:%{time_connect} total:%{time_total}\n" \
                  http://my-backend.production.svc.cluster.local/health
              done

              echo "=== Direct pod IPs in different zones ==="
              # Replace with actual pod IPs from other zones
              for ip in 10.0.2.20 10.0.3.30; do
                for i in $(seq 1 5); do
                  curl -s -o /dev/null \
                    -w "connect:%{time_connect} total:%{time_total}\n" \
                    "http://${ip}:8080/health"
                done
              done
      restartPolicy: Never
```

## Section 10: Operational Checklist

```bash
# Pre-deployment topology validation checklist

# 1. Verify node zone labels are set
kubectl get nodes -o custom-columns=\
"NAME:.metadata.name,ZONE:.metadata.labels.topology\.kubernetes\.io/zone" | \
grep -v "<none>"

# 2. Verify minimum replicas per zone (minimum 3 total, 1 per zone)
for zone in us-east-1a us-east-1b us-east-1c; do
  echo "Pods in zone $zone:"
  kubectl get pods -n production -l app=my-backend \
    --field-selector spec.nodeName=$(
      kubectl get nodes -l topology.kubernetes.io/zone=$zone \
        -o jsonpath='{.items[0].metadata.name}'
    ) 2>/dev/null | wc -l
done

# 3. Verify topology annotation is set
kubectl get svc -n production my-backend \
  -o jsonpath='{.metadata.annotations.service\.kubernetes\.io/topology-mode}'

# 4. Verify hints are assigned to EndpointSlices
kubectl get endpointslice -n production \
  -l kubernetes.io/service-name=my-backend \
  -o jsonpath='{range .items[*].endpoints[*]}{.zone}: {.hints.forZones[*].name}{"\n"}{end}'

# 5. Verify PodDisruptionBudget prevents zone emptying
kubectl get pdb -n production -l app=my-backend

# 6. Check for topology events
kubectl get events -n production --field-selector involvedObject.name=my-backend | \
  grep -i topology
```

## Conclusion

Topology-aware routing is one of the highest-ROI Kubernetes features for multi-zone deployments. The configuration overhead is minimal — add a single annotation to your Service and ensure your pods are spread across zones — while the benefits in reduced cloud costs and improved latency are immediately measurable.

The key operational principle is monitoring: deploy the Prometheus rules from Section 8 before enabling topology hints in production, establish a baseline of cross-zone traffic ratios, and verify that hints are actually being assigned after you enable the feature. Services with fewer than 3 endpoints or uneven zone distribution will silently fall back to random load balancing, so the monitoring is essential to validate the feature is actually working.

For AWS deployments, combine topology-aware hints for internal ClusterIP services with `cross-zone-load-balancing-enabled: "false"` on NLBs to achieve end-to-end zone locality from the load balancer through to the backing pod.
