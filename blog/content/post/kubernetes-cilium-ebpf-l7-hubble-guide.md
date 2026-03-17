---
title: "Kubernetes Cilium eBPF: L7 Policies, Hubble Observability, and BGP Control Plane"
date: 2028-07-12T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Cilium", "eBPF", "Hubble", "BGP", "Networking"]
categories:
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Cilium CNI on Kubernetes covering eBPF-based networking, L7 network policies with HTTP and DNS filtering, Hubble distributed observability, BGP control plane for bare metal deployments, and performance benchmarking."
more_link: "yes"
url: "/kubernetes-cilium-ebpf-l7-hubble-guide/"
---

Cilium is the most architecturally significant CNI plugin available for Kubernetes. While other CNIs add iptables rules, Cilium replaces iptables with eBPF programs loaded directly into the kernel. This is not merely a performance optimization — it fundamentally changes what network policies can express. L7 HTTP policies, DNS-aware egress filtering, and cryptographic identity-based access control become possible without service meshes or additional proxies.

This guide covers Cilium deployment for production environments: the installation and configuration decisions that matter, L7 CiliumNetworkPolicies with HTTP path and method filtering, the Hubble observability platform for visualizing network flows, BGP integration for bare metal load balancing, and the operational practices for running Cilium in large-scale clusters.

<!--more-->

# Kubernetes Cilium eBPF: L7 Policies, Hubble, and BGP

## Section 1: Architecture and eBPF Fundamentals

### Why eBPF Changes Everything

Traditional Kubernetes networking relies on iptables rules that are evaluated sequentially for every packet. A cluster with 500 services generates thousands of iptables rules. Each new rule increases the time to process the ruleset linearly.

Cilium's eBPF programs are:
1. **JIT compiled** into native machine code by the kernel
2. **Loaded into hash maps** that are O(1) lookups regardless of policy count
3. **Executed in kernel context** at the network driver level, before the packet even reaches the TCP stack
4. **Updated atomically** without replacing all rules

The practical result: adding the 1000th network policy has zero impact on packet processing latency, whereas iptables degrades measurably.

### Cilium Identity Model

Cilium assigns cryptographic identities to workloads based on Kubernetes labels:

```
Pod with labels {app: frontend, env: production}
→ Identity hash: 12345
→ All pods with matching labels share this identity
→ Network policies reference identities, not IP addresses
```

When a pod is migrated, scaled, or rescheduled, its IP changes but its identity remains constant. Policies remain valid through IP changes with no reprogram delay.

## Section 2: Installation and Configuration

### Production Installation with Helm

```bash
helm repo add cilium https://helm.cilium.io/
helm repo update

# Install Cilium with production settings
helm install cilium cilium/cilium \
  --namespace kube-system \
  --version 1.15.0 \
  --set kubeProxyReplacement=true \
  --set k8sServiceHost=APISERVER_IP \
  --set k8sServicePort=6443 \
  --set hostServices.enabled=true \
  --set externalIPs.enabled=true \
  --set nodePort.enabled=true \
  --set hostPort.enabled=true \
  --set bpf.masquerade=true \
  --set ipam.mode=kubernetes \
  --set operator.replicas=2 \
  --set hubble.relay.enabled=true \
  --set hubble.ui.enabled=true \
  --set hubble.metrics.enabled="{dns,drop,tcp,flow,icmp,http}" \
  --set bandwidthManager.enabled=true \
  --set loadBalancer.algorithm=maglev \
  --set monitor.eventQueueSize=65536

# Verify installation
cilium status
cilium connectivity test
```

### IstioOperator Configuration for Cilium + Istio

When running Cilium alongside Istio, configure Cilium to delegate L7 processing to Istio:

```yaml
# cilium-values.yaml
kubeProxyReplacement: true
cni:
  exclusive: false  # Allow Istio sidecar injection

hubble:
  enabled: true
  relay:
    enabled: true
  ui:
    enabled: true
  metrics:
    enabled:
    - dns
    - drop
    - tcp
    - flow
    - http
    serviceMonitor:
      enabled: true

ipam:
  mode: kubernetes
  operator:
    clusterPoolIPv4PodCIDRList:
    - "10.244.0.0/16"

endpointRoutes:
  enabled: true

# Enable WireGuard encryption for node-to-node traffic
encryption:
  enabled: true
  type: wireguard
  nodeEncryption: false  # Only pod-to-pod

# BGP for bare metal
bgpControlPlane:
  enabled: true

# Bandwidth management
bandwidthManager:
  enabled: true
  bbr: true  # Enable BBR congestion control

# Load balancing
loadBalancer:
  algorithm: maglev
  mode: dsr  # Direct Server Return for NodePort

# Optimize for high connection rates
bpf:
  preallocateMaps: true
  ctTcpMax: 524288
  ctAnyMax: 262144
  natMax: 524288
  lbMapMax: 65536
```

```bash
helm upgrade cilium cilium/cilium \
  --namespace kube-system \
  --reuse-values \
  -f cilium-values.yaml
```

### Kernel Version Requirements

```bash
# Check kernel version (minimum: 4.19, recommended: 5.10+)
uname -r

# Check eBPF support
ls /sys/fs/bpf

# Verify required kernel configs
zcat /proc/config.gz | grep -E "BPF|CGROUP" | grep -v "^#"

# Verify Cilium-required configs
cilium bpf info
```

## Section 3: L3/L4 Network Policies

### Pod-to-Pod Policies

```yaml
# Default deny all in production namespace
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: default-deny
  namespace: production
spec:
  endpointSelector: {}  # Matches all pods in namespace
  ingress: []            # Empty = deny all ingress
  egress: []             # Empty = deny all egress
---
# Allow frontend to reach API on port 8080
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: frontend-to-api
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: api-service
  ingress:
  - fromEndpoints:
    - matchLabels:
        app: frontend
    toPorts:
    - ports:
      - port: "8080"
        protocol: TCP
---
# Allow required Kubernetes system traffic
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: allow-dns
  namespace: production
spec:
  endpointSelector: {}
  egress:
  - toEndpoints:
    - matchLabels:
        io.kubernetes.pod.namespace: kube-system
        k8s-app: kube-dns
    toPorts:
    - ports:
      - port: "53"
        protocol: ANY
      rules:
        dns:
        - matchPattern: "*"
---
# Allow access to Kubernetes API server
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: allow-k8s-api
  namespace: production
spec:
  endpointSelector: {}
  egress:
  - toEntities:
    - kube-apiserver
```

## Section 4: L7 Network Policies

This is where Cilium differentiates from other CNIs. L7 policies can inspect HTTP method, path, headers, and DNS names:

### HTTP L7 Policy

```yaml
# Allow GET /api/public but not POST or /api/admin
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: api-l7-policy
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: api-service
  ingress:
  - fromEndpoints:
    - matchLabels:
        app: frontend
    toPorts:
    - ports:
      - port: "8080"
        protocol: TCP
      rules:
        http:
        - method: "GET"
          path: "/api/public/.*"
        - method: "GET"
          path: "/api/v1/products"
        - method: "POST"
          path: "/api/v1/orders"
          headers:
          - "Content-Type: application/json"
  # Admin routes only from internal services
  - fromEndpoints:
    - matchLabels:
        app: admin-service
    toPorts:
    - ports:
      - port: "8080"
        protocol: TCP
      rules:
        http:
        - method: "GET"
          path: "/api/.*"
        - method: "POST"
          path: "/api/.*"
        - method: "PUT"
          path: "/api/.*"
        - method: "DELETE"
          path: "/api/.*"
```

### DNS-Based Egress Policy

```yaml
# Allow pods to reach specific external FQDNs only
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: egress-dns-policy
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: payment-service
  egress:
  # Allow DNS resolution
  - toEndpoints:
    - matchLabels:
        k8s:io.kubernetes.pod.namespace: kube-system
        k8s-app: kube-dns
    toPorts:
    - ports:
      - port: "53"
        protocol: ANY
      rules:
        dns:
        - matchPattern: "api.stripe.com"
        - matchPattern: "*.stripe.com"
        - matchName: "hooks.slack.com"
  # Allow HTTPS to stripe.com
  - toFQDNs:
    - matchName: "api.stripe.com"
    - matchPattern: "*.stripe.com"
    toPorts:
    - ports:
      - port: "443"
        protocol: TCP
  # Allow HTTPS to Slack
  - toFQDNs:
    - matchName: "hooks.slack.com"
    toPorts:
    - ports:
      - port: "443"
        protocol: TCP
```

### Kafka Protocol Policy

```yaml
# L7 policy for Kafka - allow specific topics
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: kafka-l7-policy
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: kafka
  ingress:
  - fromEndpoints:
    - matchLabels:
        kafka-role: producer
    toPorts:
    - ports:
      - port: "9092"
        protocol: TCP
      rules:
        kafka:
        - role: produce
          topic: "orders"
        - role: produce
          topic: "events"
  - fromEndpoints:
    - matchLabels:
        kafka-role: consumer
    toPorts:
    - ports:
      - port: "9092"
        protocol: TCP
      rules:
        kafka:
        - role: consume
          topic: "orders"
        - role: consume
          topic: "events"
```

### gRPC Policy

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: grpc-policy
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: order-service
  ingress:
  - fromEndpoints:
    - matchLabels:
        app: api-gateway
    toPorts:
    - ports:
      - port: "50051"
        protocol: TCP
      rules:
        # gRPC uses HTTP/2
        http:
        - method: "POST"
          path: "/order.OrderService/CreateOrder"
        - method: "POST"
          path: "/order.OrderService/GetOrder"
        - method: "POST"
          path: "/grpc.health.v1.Health/Check"
```

## Section 5: Hubble Observability

Hubble is Cilium's built-in network flow observability platform. Unlike Istio's observability which adds sidecar overhead, Hubble uses the eBPF data already collected by Cilium.

### Installing Hubble CLI

```bash
# Install Hubble CLI
HUBBLE_VERSION=$(curl -s https://raw.githubusercontent.com/cilium/hubble/master/stable.txt)
curl -L --fail --remote-name-all \
  https://github.com/cilium/hubble/releases/download/$HUBBLE_VERSION/hubble-linux-amd64.tar.gz

tar xzvf hubble-linux-amd64.tar.gz
mv hubble /usr/local/bin/

# Enable Hubble port-forward
cilium hubble port-forward &

# Check status
hubble status

# Query live flows
hubble observe --follow --pod production/my-app

# Filter by verdict
hubble observe --verdict DROPPED

# Filter by layer 7
hubble observe --http-method GET --http-path "/api/.*"

# DNS queries
hubble observe --type l7 --protocol DNS --follow

# Specific namespace
hubble observe --namespace production --follow
```

### Hubble Metrics for Prometheus

```yaml
# cilium-config.yaml - Enable Hubble metrics
apiVersion: v1
kind: ConfigMap
metadata:
  name: cilium-config
  namespace: kube-system
data:
  hubble-metrics: >-
    dns;query;ignoreAAAA,
    drop;namespace;pod,
    tcp;namespace;pod,
    flow;namespace;pod,
    icmp;namespace;pod,
    http;namespace;pod;response-labels=status
  hubble-metrics-server: ":9091"
```

### Grafana Dashboard for Hubble

```yaml
# PrometheusRule for Hubble
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: hubble-alerts
  namespace: monitoring
spec:
  groups:
  - name: hubble.network
    rules:
    - alert: HighDropRate
      expr: |
        sum(rate(hubble_drop_total[5m])) by (namespace, reason)
        > 100
      for: 2m
      labels:
        severity: warning
      annotations:
        summary: "High packet drop rate in {{ $labels.namespace }}"
        description: "Drop reason: {{ $labels.reason }}, rate: {{ $value }}/s"

    - alert: PolicyDeniedConnections
      expr: |
        sum(increase(hubble_drop_total{reason="POLICY_DENIED"}[5m])) by (namespace, pod)
        > 50
      for: 1m
      labels:
        severity: warning
      annotations:
        summary: "Policy denying connections for pod {{ $labels.pod }}"

    - alert: DNSResolutionFailures
      expr: |
        sum(rate(hubble_drop_total{reason="DNS_ERROR"}[5m])) by (namespace)
        > 10
      for: 5m
      labels:
        severity: warning
```

### Hubble Network Flow Analysis

```bash
# Analyze flow patterns
hubble observe \
  --namespace production \
  --since 1h \
  --output json | \
  jq -r 'select(.l7 != null and .l7.http != null) |
    [.source.pod_name, .destination.pod_name, .l7.http.method, .l7.http.url]
    | @csv' | \
  sort | uniq -c | sort -rn | head -20

# Find policy violations
hubble observe \
  --verdict DROPPED \
  --namespace production \
  --since 30m \
  --output json | \
  jq -r '[.source.pod_name, .destination.pod_name, .drop_reason_desc] | @tsv'

# Identify top talkers
hubble observe \
  --namespace production \
  --since 5m \
  --output json | \
  jq -r '[.source.pod_name, .destination.pod_name] | @csv' | \
  sort | uniq -c | sort -rn | head -10
```

## Section 6: BGP Control Plane for Bare Metal

Cilium's BGP Control Plane eliminates the need for MetalLB or similar tools on bare metal Kubernetes:

### Configure BGP

```yaml
# CiliumBGPPeeringPolicy — configure BGP peers
apiVersion: cilium.io/v2alpha1
kind: CiliumBGPPeeringPolicy
metadata:
  name: bgp-peering-policy
spec:
  nodeSelector:
    matchLabels:
      node-role.kubernetes.io/worker: ""
  virtualRouters:
  - localASN: 64512
    exportPodCIDR: true
    neighbors:
    - peerAddress: "10.0.0.1/32"   # Router 1
      peerASN: 64513
      eBGPMultihopTTL: 2
      connectRetryTimeSeconds: 120
      holdTimeSeconds: 9
      keepAliveTimeSeconds: 3
      gracefulRestart:
        enabled: true
        restartTimeSeconds: 120
    - peerAddress: "10.0.0.2/32"   # Router 2
      peerASN: 64513
      eBGPMultihopTTL: 2
      connectRetryTimeSeconds: 120
      holdTimeSeconds: 9
      keepAliveTimeSeconds: 3
    serviceSelector:
      matchExpressions:
      - key: "cilium.io/no-export"
        operator: NotIn
        values: ["true"]
```

### BGP Load Balancer Service

```yaml
# Service with BGP advertisement
apiVersion: v1
kind: Service
metadata:
  name: my-app
  namespace: production
  annotations:
    # Request a specific IP from the pool
    io.cilium/lb-ipam-ips: "10.100.0.10"
spec:
  type: LoadBalancer
  selector:
    app: my-app
  ports:
  - port: 443
    targetPort: 8443
---
# Define the IP pool for LoadBalancer services
apiVersion: cilium.io/v2alpha1
kind: CiliumLoadBalancerIPPool
metadata:
  name: production-pool
spec:
  cidrs:
  - cidr: "10.100.0.0/24"
  serviceSelector:
    matchLabels:
      environment: production
```

### Verify BGP Peering

```bash
# Check BGP peer status
cilium bgp peers

# Expected output:
# Node               Local AS   Peer AS   Peer Address   Session State   Uptime    Family     Received   Advertised
# node1              64512      64513     10.0.0.1/32    ESTABLISHED     2h30m     ipv4/unicast    10         5

# Check BGP routes
cilium bgp routes

# Check allocated IPs
kubectl get ciliumpodippool
kubectl get ciliumloadbalancerippool

# Verify the service got an IP
kubectl get svc my-app -n production -o wide
```

## Section 7: WireGuard Transparent Encryption

```yaml
# Enable WireGuard node-to-node encryption
apiVersion: v1
kind: ConfigMap
metadata:
  name: cilium-config
  namespace: kube-system
data:
  enable-wireguard: "true"
  wireguard-userspace-fallback: "false"  # Use kernel WireGuard
  enable-node-encryption: "false"  # Pod-to-pod only (not node-to-pod)
```

Or via Helm:

```bash
helm upgrade cilium cilium/cilium \
  --namespace kube-system \
  --reuse-values \
  --set encryption.enabled=true \
  --set encryption.type=wireguard \
  --set encryption.nodeEncryption=false
```

Verify encryption:

```bash
# Check WireGuard status
cilium status | grep -A5 Encryption

# Verify on a node
kubectl exec -n kube-system ds/cilium -- cilium-dbg status --verbose | grep WireGuard

# Check the WireGuard interface
kubectl exec -n kube-system ds/cilium -- wg show cilium_wg0
```

## Section 8: Performance Tuning

### eBPF Map Sizes

For large clusters, increase eBPF map sizes to avoid drops:

```yaml
# cilium-config updates for large clusters
apiVersion: v1
kind: ConfigMap
metadata:
  name: cilium-config
  namespace: kube-system
data:
  # Connection tracking tables
  bpf-ct-global-tcp-max: "524288"  # 512K TCP connections
  bpf-ct-global-any-max: "262144"  # 256K UDP/ICMP connections

  # NAT table
  bpf-nat-global-max: "524288"

  # Load balancer table
  bpf-lb-map-max: "65536"

  # Policy map (per endpoint)
  bpf-policy-map-max: "16384"

  # Neighbor table
  bpf-lb-maglev-table-size: "65521"  # Prime number

  # Pre-allocate maps at startup
  preallocate-bpf-maps: "true"
```

### Bandwidth Management

```yaml
# Enable bandwidth limiting per pod
apiVersion: cilium.io/v2
kind: CiliumNode
metadata:
  name: my-node
spec:
  # This is configured via annotations on pods
---
# Pod with bandwidth limits
apiVersion: v1
kind: Pod
metadata:
  name: bandwidth-limited-pod
  namespace: production
  annotations:
    kubernetes.io/ingress-bandwidth: "100M"
    kubernetes.io/egress-bandwidth: "100M"
spec:
  containers:
  - name: app
    image: my-app:latest
```

### Connection Rate Limiting

```yaml
# Rate limit connections per source using Cilium's eBPF rate limiter
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: rate-limit-ingress
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: api-gateway
  ingress:
  - fromEntities:
    - world
    toPorts:
    - ports:
      - port: "443"
        protocol: TCP
      # Note: L7 rate limiting requires Envoy proxy
      rules:
        http:
        - method: "GET"
          path: "/api/.*"
```

## Section 9: Debugging Network Issues

### Using Cilium CLI for Debugging

```bash
# Check endpoint status
cilium endpoint list
cilium endpoint get <endpoint-id>

# Check policy enforcement
cilium policy get
cilium policy trace \
  --src-pod production/frontend-abc \
  --dst-pod production/api-service-xyz \
  --dport 8080 \
  --proto tcp

# Check eBPF maps
cilium bpf lb list          # Load balancer entries
cilium bpf ct list global   # Connection tracking
cilium bpf nat list         # NAT entries
cilium bpf policy get       # Policy entries

# Monitor events
cilium monitor --type drop
cilium monitor --type l7
cilium monitor --type debug --verbose

# Check identity allocation
cilium identity list
cilium identity get <identity-id>
```

### Network Flow Debugging

```bash
# Full flow debug for a specific pod pair
hubble observe \
  --from-pod production/frontend \
  --to-pod production/api-service \
  --follow \
  --output compact

# Enable debug flow for specific pods
kubectl annotate pod frontend -n production \
  cilium.io/monitor-aggregation-level=none

# Check if policy is being applied
kubectl exec -n kube-system ds/cilium -- \
  cilium-dbg policy trace \
    --src-k8s-pod production:frontend \
    --dst-k8s-pod production:api-service \
    --dport 8080

# Capture packets
kubectl exec -n kube-system ds/cilium -- \
  cilium-dbg bpf metrics list | grep drop
```

### Common Issues

```bash
# Issue: FQDN policy not working
# Check if DNS is being intercepted
hubble observe \
  --type l7 \
  --protocol DNS \
  --pod production/payment-service

# Check the FQDN cache
kubectl exec -n kube-system ds/cilium -- \
  cilium-dbg fqdn cache list

# Flush the FQDN cache
kubectl exec -n kube-system ds/cilium -- \
  cilium-dbg fqdn cache clean --matchpattern "*.stripe.com"

# Issue: Policy changes not taking effect
# Check policy revision
kubectl exec -n kube-system ds/cilium -- \
  cilium-dbg endpoint list | grep policy-revision

# Trigger policy recalculation
kubectl exec -n kube-system ds/cilium -- \
  cilium-dbg endpoint regenerate --id all

# Issue: High CPU on cilium-agent
# Check map pressure
kubectl exec -n kube-system ds/cilium -- \
  cilium-dbg metrics list | grep -E "bpf_map_pressure|endpoint_regeneration"
```

## Section 10: Multi-Cluster with Cluster Mesh

Cilium Cluster Mesh enables transparent pod-to-pod communication and unified policy enforcement across multiple clusters:

```bash
# Enable Cluster Mesh
cilium clustermesh enable \
  --service-type LoadBalancer

# Get the mesh certificate
cilium clustermesh status

# Connect two clusters
cilium clustermesh connect \
  --destination-context cluster2-context

# Verify the connection
cilium clustermesh status --wait
```

### Global Services

```yaml
# Service shared across clusters
apiVersion: v1
kind: Service
metadata:
  name: redis-global
  namespace: production
  annotations:
    service.cilium.io/global: "true"
    service.cilium.io/shared: "true"
    service.cilium.io/affinity: "local"  # Prefer local cluster
spec:
  type: ClusterIP
  selector:
    app: redis
  ports:
  - port: 6379
    targetPort: 6379
---
# Cross-cluster network policy
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: allow-cross-cluster
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: redis
  ingress:
  - fromEndpoints:
    - matchLabels:
        io.cilium.k8s.policy.cluster: cluster1
        app: api-service
    - matchLabels:
        io.cilium.k8s.policy.cluster: cluster2
        app: api-service
    toPorts:
    - ports:
      - port: "6379"
        protocol: TCP
```

## Section 11: Cilium Upgrade Strategy

```bash
# Check current version
cilium version

# Pre-upgrade validation
cilium upgrade test

# Upgrade Cilium (rolling restart of DaemonSet)
helm upgrade cilium cilium/cilium \
  --namespace kube-system \
  --reuse-values \
  --version 1.16.0

# Watch the rollout
kubectl rollout status daemonset/cilium -n kube-system

# Verify after upgrade
cilium status
cilium connectivity test --all-flows

# Check for dropped connections during upgrade
hubble observe --verdict DROPPED --since 10m | head -50
```

## Conclusion

Cilium's eBPF foundation delivers capabilities that are architecturally impossible for iptables-based CNIs. L7 network policies that filter on HTTP paths and methods, DNS-aware egress control, and WireGuard encryption at line rate are all implemented without adding sidecar proxies or accepting kernel bypass tradeoffs.

The operational investment in Cilium pays off at scale. The identity-based policy model means policies remain valid through IP changes, scaling events, and node migrations. Hubble provides network visibility that previously required expensive service mesh deployments. The BGP control plane eliminates external load balancer dependencies on bare metal.

For production deployments, the key configuration decisions are: `kubeProxyReplacement=true` to eliminate iptables entirely, WireGuard encryption for zero-trust pod-to-pod communication, Hubble metrics integration for network observability, and FQDN policies for tightly controlled egress to external services. These four choices together create a network security posture that is both more secure and more observable than traditional approaches.
