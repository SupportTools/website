---
title: "Kubernetes Service Mesh Selection: Istio vs Linkerd vs Cilium vs Ambient"
date: 2027-05-07T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Service Mesh", "Istio", "Linkerd", "Cilium", "mTLS", "Observability"]
categories: ["Kubernetes", "Networking"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide to selecting the right Kubernetes service mesh, comparing Istio, Linkerd, Cilium Service Mesh, and Istio Ambient Mode on performance, complexity, features, and operational overhead."
more_link: "yes"
url: "/kubernetes-service-mesh-selection-guide/"
---

Service meshes solve real production problems—automatic mutual TLS between services, rich L7 observability without application code changes, fine-grained traffic control for canary deployments, and circuit breaking that prevents cascading failures. Yet the same mesh that improves security posture for one organization becomes an operational burden that consumes an entire platform team's capacity in another.

The landscape has shifted considerably. Istio's sidecar model still leads on features but carries significant resource overhead. Linkerd prioritises simplicity and performance with its Rust-based micro-proxy. Cilium takes a fundamentally different approach by implementing service mesh capabilities in the kernel via eBPF, eliminating sidecar overhead entirely. Istio Ambient Mode represents Istio's own answer to the sidecar overhead problem, splitting mesh functions into per-node and per-pod layers.

<!--more-->

## Executive Summary

This guide compares Istio (sidecar), Linkerd, Cilium Service Mesh, and Istio Ambient Mode across the dimensions that matter most for enterprise decisions: resource overhead, operational complexity, feature completeness, performance characteristics, and migration paths. A decision framework guides teams through the evaluation based on their specific requirements, and benchmark data provides concrete numbers to anchor the comparison.

## Why Service Meshes Exist: Core Capabilities

Before comparing implementations, establish the canonical set of problems a service mesh solves:

```
Capability                    Value Proposition
─────────────────────────────────────────────────────────────────
mTLS (mutual TLS)             Zero-trust pod-to-pod encryption
                              and workload identity without app changes

Traffic Management            Canary deployments, blue/green,
                              fault injection, circuit breaking,
                              retries, timeouts at L7

Observability                 Automatic golden signals: request rate,
                              error rate, latency (RED metrics) for
                              every service pair without instrumentation

Load Balancing                L7-aware load balancing (least-request,
                              consistent hashing, locality-weighted)

Policy Enforcement            AuthorizationPolicy: allow/deny based on
                              workload identity, not just IP address

Multi-cluster / Multi-mesh    East-west traffic across cluster boundaries
```

## Istio Sidecar Architecture

### How It Works

Istio injects an Envoy proxy sidecar container into every pod in the mesh. The `istio-proxy` container intercepts all inbound and outbound traffic via iptables rules inserted by the `istio-init` init container.

```
Pod with Istio sidecar:
┌──────────────────────────────────────────────────────────────┐
│  init container: istio-init                                  │
│  (configures iptables to redirect all traffic through proxy) │
│                                                              │
│  container: app                                              │
│  (unaware of proxy; reads/writes to localhost normally)      │
│                                                              │
│  container: istio-proxy (Envoy)                              │
│  (intercepts all inbound/outbound traffic)                   │
│  (enforces mTLS, policies, retries, circuit breaking)        │
│  (exports metrics, traces to telemetry backends)             │
└──────────────────────────────────────────────────────────────┘
```

### Resource Overhead

The Envoy sidecar consumes real resources on every pod, regardless of traffic load:

```yaml
# Typical Istio sidecar resource usage
# Source: Istio performance benchmarks, 1000 RPS per service pair
sidecar_overhead:
  idle:
    cpu: 2m        # 2 millicores at rest
    memory: 50Mi   # ~50 MiB minimum

  under_load_1000rps:
    cpu: 50m       # 50 millicores at 1000 RPS
    memory: 100Mi  # memory grows with connection table size

  at_scale_example:
    cluster_pods: 500
    total_sidecar_cpu_overhead:  "500 × 50m = 25 vCPU at 1000 RPS each"
    total_sidecar_memory_overhead: "500 × 100Mi = 50 GiB"
```

### Istio Installation

```bash
# Install Istio with istioctl
curl -L https://istio.io/downloadIstio | ISTIO_VERSION=1.22.0 sh -
export PATH="$PWD/istio-1.22.0/bin:$PATH"

# Install with production profile
istioctl install --set profile=default \
  --set values.global.proxy.resources.requests.cpu=10m \
  --set values.global.proxy.resources.requests.memory=40Mi \
  --set values.global.proxy.resources.limits.cpu=2000m \
  --set values.global.proxy.resources.limits.memory=1024Mi \
  -y

# Enable automatic sidecar injection for a namespace
kubectl label namespace production istio-injection=enabled

# Verify installation
istioctl verify-install
```

### Istio Control Plane Components

```yaml
# Verify istiod is running
kubectl get pods -n istio-system

# istiod handles:
# - Pilot: xDS configuration distribution to sidecars
# - Citadel: certificate authority (SPIFFE/X.509 certs)
# - Galley: configuration validation
# - Injector: webhook-based sidecar injection

# Check mesh configuration
kubectl get istiooperator -n istio-system -o yaml
```

### Istio mTLS and Authorization Policy

```yaml
# Enforce strict mTLS across the mesh
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: default
  namespace: istio-system    # mesh-wide policy
spec:
  mtls:
    mode: STRICT
---
# Allow only specific services to communicate
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: orders-policy
  namespace: orders
spec:
  selector:
    matchLabels:
      app: orders-service
  action: ALLOW
  rules:
  - from:
    - source:
        principals:
        - "cluster.local/ns/shop/sa/frontend"
        - "cluster.local/ns/api-gateway/sa/gateway"
    to:
    - operation:
        methods: ["GET", "POST"]
        paths: ["/v1/orders*"]
    when:
    - key: request.headers[x-api-version]
      values: ["v1", "v2"]
```

### Istio VirtualService and DestinationRule

```yaml
# Traffic management with VirtualService
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: orders-vs
  namespace: orders
spec:
  hosts:
  - orders-service
  http:
  # Canary: 10% to v2
  - route:
    - destination:
        host: orders-service
        subset: v1
      weight: 90
    - destination:
        host: orders-service
        subset: v2
      weight: 10
    timeout: 30s
    retries:
      attempts: 3
      perTryTimeout: 10s
      retryOn: "gateway-error,connect-failure,retriable-4xx"
    fault:
      # Chaos engineering: inject 1% delay
      delay:
        percentage:
          value: 1
        fixedDelay: 5s
---
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: orders-dr
  namespace: orders
spec:
  host: orders-service
  trafficPolicy:
    connectionPool:
      tcp:
        maxConnections: 1000
      http:
        h2UpgradePolicy: UPGRADE
        http2MaxRequests: 1000
        maxRequestsPerConnection: 10
    outlierDetection:
      consecutive5xxErrors: 5
      interval: 30s
      baseEjectionTime: 30s
      maxEjectionPercent: 50
  subsets:
  - name: v1
    labels:
      version: v1
  - name: v2
    labels:
      version: v2
```

## Linkerd Architecture

### Design Philosophy

Linkerd takes an opposing philosophical stance to Istio: simplicity and operational safety are primary. Linkerd's micro-proxy is written in Rust, consumes far fewer resources than Envoy, and the control plane is purpose-built (not a general-purpose proxy).

```
Linkerd architecture:
┌──────────────────────────────────────────────────────────────┐
│  Control Plane (linkerd-control-plane namespace)             │
│  ├── linkerd-destination   — service discovery, policy       │
│  ├── linkerd-identity      — certificate issuance (SPIFFE)  │
│  └── linkerd-proxy-injector — webhook for proxy injection    │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  Data Plane: linkerd-proxy (Rust micro-proxy)                │
│  Memory: ~10 MiB per pod  (vs ~50 MiB for Envoy)            │
│  CPU idle: <1m per pod    (vs ~2m for Envoy)                 │
│  Latency added: ~0.5ms p99 (vs ~1-2ms for Envoy)            │
└──────────────────────────────────────────────────────────────┘
```

### Linkerd Installation

```bash
# Install Linkerd CLI
curl --proto '=https' --tlsv1.2 -sSfL https://run.linkerd.io/install | sh
export PATH=$PATH:$HOME/.linkerd2/bin

# Pre-flight check
linkerd check --pre

# Install CRDs then control plane
linkerd install --crds | kubectl apply -f -
linkerd install --set proxyInit.runAsRoot=true | kubectl apply -f -

# Wait for control plane to be ready
linkerd check

# Inject Linkerd proxy into a namespace (annotation-based)
kubectl annotate namespace production \
  linkerd.io/inject=enabled

# Or inject at deployment level
kubectl get deploy -n production -o yaml \
  | linkerd inject - \
  | kubectl apply -f -
```

### Linkerd Resource Consumption Comparison

```bash
# Measure actual proxy resource usage
kubectl top pods -n production --containers \
  | grep linkerd-proxy

# Expected output at 1000 RPS:
# pod-a   linkerd-proxy   3m    12Mi
# pod-b   linkerd-proxy   4m    11Mi
# pod-c   linkerd-proxy   2m    13Mi

# Compare with Istio at same load:
# pod-a   istio-proxy     52m   98Mi
# pod-b   istio-proxy     48m   95Mi
```

### Linkerd Traffic Policies

```yaml
# Server — define what traffic a pod accepts
apiVersion: policy.linkerd.io/v1beta1
kind: Server
metadata:
  name: orders-server
  namespace: orders
spec:
  podSelector:
    matchLabels:
      app: orders-service
  port: 8080
  proxyProtocol: HTTP/2
---
# ServerAuthorization — who may call this server
apiVersion: policy.linkerd.io/v1beta1
kind: ServerAuthorization
metadata:
  name: orders-allow-frontend
  namespace: orders
spec:
  server:
    name: orders-server
  client:
    meshTLS:
      serviceAccounts:
      - name: frontend
        namespace: shop
      - name: api-gateway
        namespace: api-gateway
---
# HTTPRoute for traffic management (Linkerd uses Gateway API HTTPRoute)
apiVersion: policy.linkerd.io/v1beta2
kind: HTTPRoute
metadata:
  name: orders-timeout
  namespace: orders
spec:
  parentRefs:
  - name: orders-server
    kind: Server
    group: policy.linkerd.io
  rules:
  - timeouts:
      request: 30s
      backendRequest: 10s
```

### Linkerd Observability

```bash
# Install the Linkerd viz extension (Prometheus + Grafana + Tap)
linkerd viz install | kubectl apply -f -
linkerd viz check

# View golden signals for the orders namespace
linkerd viz stat deploy -n orders

# Watch live traffic (tap — requires no application changes)
linkerd viz tap deploy/orders-service -n orders \
  --to-namespace shop \
  --to deploy/frontend

# Top services by success rate
linkerd viz top deploy -n production

# Open Linkerd dashboard
linkerd viz dashboard
```

## Cilium Service Mesh

### eBPF-Based Service Mesh

Cilium implements service mesh capabilities entirely in the Linux kernel via eBPF, eliminating the sidecar container model. There are no additional processes injected into pods—the eBPF programs run in the kernel and intercept traffic at the socket level.

```
Cilium Service Mesh architecture:

Traditional sidecar model:
  App Container ──iptables──▶ Sidecar Proxy ──network──▶ Target

Cilium eBPF model:
  App Container ──eBPF socket hook──▶ kernel network stack ──▶ Target
                    (no context switch, no extra process,
                     no iptables, no sidecar memory)
```

### Installation

```bash
# Install Cilium with service mesh features enabled
helm repo add cilium https://helm.cilium.io/
helm repo update

helm upgrade --install cilium cilium/cilium \
  --namespace kube-system \
  --version 1.16.0 \
  --set kubeProxyReplacement=true \
  --set k8sServiceHost=<API_SERVER_IP> \
  --set k8sServicePort=6443 \
  --set ingressController.enabled=true \
  --set ingressController.default=true \
  --set ingressController.loadbalancerMode=dedicated \
  --set gatewayAPI.enabled=true \
  --set hubble.enabled=true \
  --set hubble.relay.enabled=true \
  --set hubble.ui.enabled=true \
  --set hubble.metrics.enableOpenMetrics=true \
  --set hubble.metrics.enabled="{dns,drop,tcp,flow,port-distribution,icmp,httpV2:exemplars=true;labelsContext=source_ip\,source_namespace\,source_workload\,destination_ip\,destination_namespace\,destination_workload\,traffic_direction}" \
  --wait

# Install Cilium CLI
cilium status
cilium connectivity test
```

### Cilium mTLS

Cilium implements mTLS using SPIFFE/SPIRE or its built-in identity model:

```bash
# Enable Cilium mutual authentication (mTLS)
helm upgrade cilium cilium/cilium \
  --namespace kube-system \
  --reuse-values \
  --set authentication.mutual.spire.enabled=true \
  --set authentication.mutual.spire.install.enabled=true
```

```yaml
# CiliumNetworkPolicy with mTLS enforcement
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: orders-mTLS-policy
  namespace: orders
spec:
  endpointSelector:
    matchLabels:
      app: orders-service
  ingress:
  - fromEndpoints:
    - matchLabels:
        app: frontend
        k8s:io.kubernetes.pod.namespace: shop
    authentication:
      mode: "required"    # enforce mTLS for this flow
  egress:
  - toEndpoints:
    - matchLabels:
        app: postgres
    authentication:
      mode: "required"
```

### Hubble Observability

Hubble is Cilium's built-in network observability layer. It provides flow-level visibility without any application changes.

```bash
# Install Hubble CLI
HUBBLE_VERSION=$(curl -s https://raw.githubusercontent.com/cilium/hubble/master/stable.txt)
curl -L --remote-name-all \
  "https://github.com/cilium/hubble/releases/download/${HUBBLE_VERSION}/hubble-linux-amd64.tar.gz"
tar xzvf hubble-linux-amd64.tar.gz
mv hubble /usr/local/bin/

# Port-forward Hubble relay
kubectl port-forward -n kube-system svc/hubble-relay 4245:80 &

# Observe flows in real time
hubble observe --namespace orders --follow

# Observe flows between specific services
hubble observe \
  --from-label "app=frontend" \
  --to-label "app=orders-service" \
  --protocol http \
  --follow

# View HTTP metrics (top URLs, status codes)
hubble observe \
  --namespace orders \
  --type l7 \
  | grep -E "(HTTP|GRPC)"
```

## Istio Ambient Mode

### Sidecarless Architecture

Istio Ambient Mode eliminates per-pod sidecar proxies by splitting mesh functions into two layers:

1. **ztunnel** — a node-level DaemonSet proxy that handles L4 mTLS, telemetry, and policy enforcement
2. **waypoint proxy** — a namespace-level or service-level Envoy proxy (deployed on demand) for L7 features

```
Istio Ambient Mode:
┌────────────────────────── Node ──────────────────────────────┐
│                                                               │
│  ztunnel (DaemonSet, one per node)                           │
│  ├── L4 mTLS between all pods on this node                   │
│  ├── Basic L4 authorization policies                         │
│  └── L4 telemetry                                            │
│                                                              │
│  App Pods — NO sidecar injected                              │
│  ├── Pod A (frontend)                                        │
│  ├── Pod B (orders-service)                                  │
│  └── Pod C (payments-service)                                │
└───────────────────────────────────────────────────────────────┘

Waypoint Proxy (optional, per-namespace/service)
├── L7 traffic management (retries, timeouts, canary)
├── L7 authorization policies
└── L7 telemetry
```

### Ambient Mode Installation

```bash
# Install Istio Ambient (separate profile from sidecar Istio)
istioctl install \
  --set profile=ambient \
  --set components.ingressGateways[0].enabled=true \
  --set components.ingressGateways[0].name=istio-ingressgateway \
  -y

# Label namespace for ambient mesh (no sidecar injection annotation needed)
kubectl label namespace production istio.io/dataplane-mode=ambient

# Verify ztunnel is running on all nodes
kubectl get daemonset -n istio-system ztunnel

# Deploy waypoint proxy for a namespace (enables L7 features)
istioctl waypoint apply --namespace production --enroll-namespace --wait

# Verify waypoint
kubectl get gateway -n production
```

### Ambient Mode L7 Policies

```yaml
# With waypoint deployed, L7 AuthorizationPolicy works as with sidecars
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: orders-l7-policy
  namespace: production
  annotations:
    istio.io/use-waypoint: waypoint    # route through waypoint for L7 inspection
spec:
  targetRef:
    group: ""
    kind: Service
    name: orders-service
  action: ALLOW
  rules:
  - from:
    - source:
        principals: ["cluster.local/ns/production/sa/frontend"]
    to:
    - operation:
        methods: ["GET", "POST"]
        paths: ["/v1/orders*"]
---
# VirtualService with waypoint (same syntax as sidecar mode)
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: orders-canary
  namespace: production
spec:
  hosts:
  - orders-service
  http:
  - route:
    - destination:
        host: orders-service
        subset: v1
      weight: 90
    - destination:
        host: orders-service
        subset: v2
      weight: 10
```

## Performance Benchmark Data

Real-world benchmark data comparing mesh implementations under a constant 1000 requests/second per service pair (HTTP/1.1, 64-byte payload):

```
Metric                    No Mesh   Istio     Linkerd   Cilium    Ambient
──────────────────────────────────────────────────────────────────────────
Latency p50 (ms)          0.2       1.2       0.5       0.3       0.4
Latency p99 (ms)          1.5       8.5       2.0       1.8       2.2
Latency p999 (ms)         5.0       25.0      6.0       5.5       7.0
CPU added per pod (m)     0         50-100    5-15      0*        0*
Memory added per pod (Mi) 0         50-120    10-30     0*        0*
Control plane CPU (m)     0         500-2000  100-300   ~0†       200-600
Control plane Mem (Gi)    0         0.5-2.0   0.1-0.3   ~0†       0.3-1.0

* Cilium: overhead is in kernel eBPF programs, not measurable per-pod
† Cilium: CNI already running; service mesh features add minimal overhead
* Ambient: ztunnel is per-node; waypoint is per-namespace on demand
```

```bash
# Benchmark Linkerd vs Istio using wrk2
# Install wrk2: https://github.com/giltene/wrk2

# Baseline (no mesh)
wrk2 -t4 -c100 -d30s -R 1000 http://orders-service:8080/v1/orders

# With Linkerd
kubectl apply -f linkerd-namespace-annotation.yaml
wrk2 -t4 -c100 -d30s -R 1000 http://orders-service:8080/v1/orders

# Collect latency histogram
wrk2 -t4 -c100 -d30s -R 1000 \
  --latency http://orders-service:8080/v1/orders
```

## Decision Framework

### Step 1: Define Non-Negotiable Requirements

```
Requirement                         Implications
──────────────────────────────────────────────────────────────────────
Must pass PCI/SOC2/HIPAA audit      → Need mTLS + AuthorizationPolicy
                                      Istio, Linkerd, Cilium all qualify

Existing team knows Envoy xDS       → Istio or Envoy Gateway (not Linkerd)

Sidecar injection forbidden         → Cilium Service Mesh or Ambient Mode
(e.g., security policy)

Must support non-HTTP protocols     → Istio (L4 tcp policies)
                                      Cilium (L3/L4 eBPF policies)
                                      (Linkerd is HTTP-first)

Multi-cluster east-west traffic     → Istio (Istio multicluster)
                                      Linkerd (Linkerd multicluster)
                                      Cilium Cluster Mesh

Minimal operational overhead        → Linkerd (simplest ops model)
target: < 2 FTE for mesh ops

Maximum feature set required        → Istio sidecar
(canary, fault injection, JWT
authz, external auth, WASM)
```

### Step 2: Evaluate Resource Constraints

```bash
# Calculate estimated mesh overhead for your cluster

PODS=500
AVERAGE_RPS_PER_POD=100

# Istio sidecar cost
ISTIO_CPU_OVERHEAD=$((PODS * 30))   # ~30m per pod at 100 RPS
ISTIO_MEM_OVERHEAD=$((PODS * 80))   # ~80 MiB per pod
echo "Istio: ${ISTIO_CPU_OVERHEAD}m CPU, ${ISTIO_MEM_OVERHEAD} MiB memory"
# → 15,000m CPU (15 vCPU), 40,000 MiB (39 GiB)

# Linkerd cost
LINKERD_CPU_OVERHEAD=$((PODS * 5))  # ~5m per pod at 100 RPS
LINKERD_MEM_OVERHEAD=$((PODS * 15)) # ~15 MiB per pod
echo "Linkerd: ${LINKERD_CPU_OVERHEAD}m CPU, ${LINKERD_MEM_OVERHEAD} MiB memory"
# → 2,500m CPU (2.5 vCPU), 7,500 MiB (7.3 GiB)

# Cilium/Ambient (no per-pod overhead)
echo "Cilium/Ambient: 0m CPU, 0 MiB per-pod overhead (kernel-level)"
```

### Step 3: Recommendation Matrix

```
Team Profile                          Recommended Mesh
──────────────────────────────────────────────────────────────────────────
Small team (< 5 engineers)           Linkerd
  Needs mTLS + basic observability   (simplest ops, lowest overhead)
  No dedicated platform team

Medium team (5-20 engineers)         Cilium Service Mesh
  Already running Cilium CNI          (zero marginal overhead,
  Performance-sensitive workloads     excellent observability via Hubble)

Large enterprise platform team       Istio sidecar
  Needs full Istio feature set        (maximum capabilities,
  (JWT, WASM, ext-authz, etc.)        large ecosystem, CNCF graduated)
  Has dedicated mesh operators

Enterprise, sidecar-averse           Istio Ambient Mode
  Wants Istio features without        (L4 free with ztunnel,
  per-pod overhead                    L7 on-demand via waypoint)

Mixed requirements                   Istio sidecar with selective
  Some high-throughput services       injection exclusion:
  alongside policy-heavy services     kubectl annotate pod high-throughput-pod
                                      sidecar.istio.io/inject=false
```

## Operational Considerations

### Certificate Rotation

All meshes auto-rotate workload certificates. Validate rotation is working:

```bash
# Istio: Check certificate expiry
istioctl proxy-config secret deploy/orders-service -n orders \
  | grep -A3 "CERTIFICATE"

# Linkerd: Check certificate validity
linkerd check --proxy

# Cilium: Check SPIRE certificate status (if using SPIRE)
kubectl exec -n spire \
  $(kubectl get pod -n spire -l app=spire-server -o jsonpath='{.items[0].metadata.name}') \
  -- /opt/spire/bin/spire-server entry show
```

### Upgrade Procedures

```bash
# ─── Istio Upgrade ───────────────────────────────────────────
# Install new control plane alongside old (canary upgrade)
istioctl install \
  --set revision=1-22 \
  --set profile=default \
  -y

# Migrate namespace to new control plane
kubectl label namespace production \
  istio.io/rev=1-22 \
  istio-injection-

# Restart pods to get new sidecar version
kubectl rollout restart deployment -n production

# Remove old control plane after validation
istioctl uninstall --revision 1-21 -y

# ─── Linkerd Upgrade ─────────────────────────────────────────
linkerd upgrade | kubectl apply -f -
linkerd check

# Restart data plane pods to get new proxy
kubectl rollout restart deployment -n production

# ─── Cilium Upgrade ──────────────────────────────────────────
helm upgrade cilium cilium/cilium \
  --namespace kube-system \
  --version 1.17.0 \
  --reuse-values \
  --set upgradeCompatibility=1.16 \
  --wait
```

### Mesh Observability Stack

```yaml
# Prometheus scrape config for all meshes
# (add to prometheus.yml additional_scrape_configs)

# Istio
- job_name: 'istio-mesh'
  kubernetes_sd_configs:
  - role: endpoints
    namespaces:
      names:
      - istio-system
  relabel_configs:
  - source_labels: [__meta_kubernetes_service_name, __meta_kubernetes_endpoint_port_name]
    action: keep
    regex: istiod;http-monitoring

# Linkerd
- job_name: 'linkerd-controller'
  kubernetes_sd_configs:
  - role: pod
    namespaces:
      names:
      - linkerd
  relabel_configs:
  - source_labels: [__meta_kubernetes_pod_container_port_name]
    action: keep
    regex: admin-http

# Cilium / Hubble
- job_name: 'cilium-agent'
  kubernetes_sd_configs:
  - role: pod
    namespaces:
      names:
      - kube-system
  relabel_configs:
  - source_labels: [__meta_kubernetes_pod_label_k8s_app]
    action: keep
    regex: cilium
  - source_labels: [__meta_kubernetes_pod_container_port_name]
    action: keep
    regex: prometheus
```

### Service Mesh Alerting Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: service-mesh-alerts
  namespace: monitoring
spec:
  groups:
  - name: mesh.rules
    rules:
    # High error rate between any two services
    - alert: MeshHighErrorRate
      expr: |
        sum(rate(istio_requests_total{
          response_code=~"5.*",
          reporter="destination"
        }[5m])) by (source_workload, destination_workload, namespace)
        /
        sum(rate(istio_requests_total{
          reporter="destination"
        }[5m])) by (source_workload, destination_workload, namespace)
        > 0.05
      for: 2m
      labels:
        severity: warning
      annotations:
        summary: "High mesh error rate"
        description: >
          {{ $labels.source_workload }} → {{ $labels.destination_workload }}
          error rate: {{ $value | humanizePercentage }}

    # mTLS failure — indicates cert rotation issue or misconfiguration
    - alert: MeshMTLSFailure
      expr: |
        sum(rate(istio_requests_total{
          connection_security_policy="none",
          reporter="destination"
        }[5m])) by (namespace, destination_workload) > 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Unencrypted traffic detected in mesh"
        description: "{{ $labels.destination_workload }} is receiving non-mTLS traffic"

    # Linkerd-specific: proxy not running
    - alert: LinkerdProxyNotRunning
      expr: |
        up{job="linkerd-proxy"} == 0
      for: 3m
      labels:
        severity: warning
      annotations:
        summary: "Linkerd proxy not running"
        description: "Linkerd proxy is down in {{ $labels.namespace }}"
```

## Migration Paths

### Migrating from Istio Sidecar to Ambient Mode

```bash
# Step 1: Install Ambient components alongside existing Istio sidecar install
# (Use revision-based install to avoid conflicts)

# Step 2: For each namespace, migrate progressively
# Remove sidecar injection label, add ambient label
kubectl label namespace staging \
  istio-injection-    \
  istio.io/dataplane-mode=ambient

# Step 3: Restart pods in namespace to remove sidecars
kubectl rollout restart deployment -n staging

# Step 4: If L7 features needed, deploy waypoint
istioctl waypoint apply -n staging --enroll-namespace --wait

# Step 5: Validate telemetry and policies still work
istioctl proxy-status

# Step 6: Proceed with production namespaces after staging validation
```

### Migrating from Linkerd to Istio

```bash
# Step 1: Run Istio and Linkerd in parallel on different namespaces
# Step 2: Migrate non-critical namespaces first
kubectl annotate namespace non-critical \
  linkerd.io/inject-    # remove Linkerd annotation

kubectl label namespace non-critical \
  istio-injection=enabled

kubectl rollout restart deployment -n non-critical

# Step 3: Replicate AuthorizationPolicy from Linkerd ServerAuthorization
# (translate Server/ServerAuthorization → AuthorizationPolicy)

# Step 4: Validate telemetry
istioctl dashboard kiali

# Step 5: Remove Linkerd control plane only after all namespaces migrated
linkerd uninstall | kubectl delete -f -
```

Selecting a service mesh is not a one-size-fits-all decision. Teams running small clusters with straightforward mTLS requirements will find Linkerd's operational simplicity refreshing. Organizations already invested in Cilium gain service mesh capabilities at effectively zero marginal cost. Teams requiring the broadest feature set and willing to invest in operational expertise will find Istio sidecar still unmatched. Ambient Mode offers a compelling middle path as it matures—Istio's features without sidecar overhead—but production stability should be validated before adoption at scale.
