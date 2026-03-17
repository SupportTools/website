---
title: "Kubernetes Cilium Hubble: Network Flow Observability and Policy Visualization"
date: 2030-11-01T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Cilium", "Hubble", "eBPF", "Network Observability", "Network Policy", "Prometheus"]
categories:
- Kubernetes
- Networking
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide to Hubble network flow observability: Hubble UI deployment, CLI flow inspection, DNS query monitoring, L7 protocol visibility for HTTP, gRPC, and Kafka, Hubble Relay for multi-cluster flows, Prometheus metrics export, and building production network dashboards."
more_link: "yes"
url: "/kubernetes-cilium-hubble-network-flow-observability-policy-visualization/"
---

Hubble is the observability layer built on top of Cilium, providing deep visibility into network flows, DNS queries, and L7 protocol interactions across Kubernetes clusters. Unlike traditional network monitoring tools that operate at the packet level or rely on sidecar proxies, Hubble leverages eBPF to observe network events directly in the Linux kernel without modifying application workloads. This guide covers enterprise-grade Hubble deployment, from initial configuration through production dashboards, covering every major capability relevant to security, compliance, and operational teams.

<!--more-->

## Architecture Overview

Hubble integrates with Cilium through three primary components: the Hubble Observer embedded in each Cilium agent, the Hubble Relay that aggregates flows across nodes, and the Hubble UI that visualizes the service dependency graph.

```
┌─────────────────────────────────────────────────────────┐
│                   Kubernetes Node                        │
│  ┌──────────────────────────────────────────────────┐   │
│  │              Cilium Agent (DaemonSet)             │   │
│  │  ┌─────────────────┐  ┌──────────────────────┐   │   │
│  │  │  eBPF Programs  │  │  Hubble Observer     │   │   │
│  │  │  (kprobe/tc)    │──│  (ring buffer 4096)  │   │   │
│  │  └─────────────────┘  └──────────────────────┘   │   │
│  │                              │ gRPC :4244          │   │
│  └──────────────────────────────┼──────────────────┘   │
└─────────────────────────────────┼───────────────────────┘
                                  │
                    ┌─────────────▼──────────────┐
                    │      Hubble Relay           │
                    │  (Deployment, :4245)        │
                    └─────────────┬──────────────┘
                                  │
               ┌──────────────────┴──────────────────┐
               │                                     │
    ┌──────────▼──────────┐               ┌──────────▼──────────┐
    │    Hubble UI         │               │   hubble CLI /       │
    │  (Deployment, :8081) │               │   Prometheus metrics │
    └─────────────────────┘               └─────────────────────┘
```

Each Cilium agent maintains a ring buffer that stores the most recent network flows observed by the eBPF programs. The default ring buffer size is 4096 flows per node. For high-traffic environments, this value requires tuning.

## Installing Hubble with Cilium via Helm

### Cilium Helm Values for Hubble

The following Helm values enable Hubble with all enterprise-relevant features:

```yaml
# cilium-values.yaml
cilium:
  hubble:
    enabled: true

    # Ring buffer size per node — increase for high-traffic environments
    # Each flow entry is approximately 400 bytes
    # 65536 flows ≈ 26 MB per node
    ringBufferSize: 65536

    # Enable Hubble metrics export to Prometheus
    metrics:
      enabled:
        - dns:query;ignoreAAAA
        - drop
        - tcp
        - flow
        - icmp
        - http
        - "flow:sourceContext=workload-name|reserved-identity;destinationContext=workload-name|reserved-identity"
      serviceMonitor:
        enabled: true
        labels:
          release: prometheus
      dashboards:
        enabled: true
        namespace: monitoring

    # Enable Hubble Relay for multi-node flow aggregation
    relay:
      enabled: true
      replicas: 2
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchLabels:
                  app.kubernetes.io/name: hubble-relay
              topologyKey: kubernetes.io/hostname
      resources:
        requests:
          cpu: 100m
          memory: 64Mi
        limits:
          cpu: 500m
          memory: 256Mi
      tls:
        server:
          enabled: true
        client:
          enabled: true

    # Enable Hubble UI
    ui:
      enabled: true
      replicas: 1
      resources:
        requests:
          cpu: 50m
          memory: 64Mi
        limits:
          cpu: 200m
          memory: 256Mi
      ingress:
        enabled: true
        annotations:
          kubernetes.io/ingress.class: nginx
          nginx.ingress.kubernetes.io/auth-type: basic
          nginx.ingress.kubernetes.io/auth-secret: hubble-basic-auth
        hosts:
          - host: hubble.internal.example.com
            paths:
              - path: /
                pathType: Prefix

    # Listener configuration
    listenAddress: ":4244"

    # Export events
    export:
      static:
        enabled: true
        filePath: /var/run/cilium/hubble/events.log
        fieldMask:
          - time
          - source
          - destination
          - verdict
          - drop_reason
          - l4
          - source.namespace
          - destination.namespace
          - is_reply
          - event_type
          - source.workloads
          - destination.workloads
          - traffic_direction
```

Apply the Helm upgrade:

```bash
helm upgrade cilium cilium/cilium \
  --namespace kube-system \
  --reuse-values \
  --values cilium-values.yaml \
  --version 1.16.0
```

### Verifying the Installation

```bash
# Check Hubble components are running
kubectl get pods -n kube-system -l app.kubernetes.io/name=hubble-relay
kubectl get pods -n kube-system -l app.kubernetes.io/name=hubble-ui

# Verify Cilium agents have Hubble enabled
kubectl exec -n kube-system ds/cilium -- cilium status | grep -A5 Hubble

# Expected output
# Hubble:        Ok   Current/Max Flows: 4095/4096 (99.98%), Flows/s: 487.23, Metrics: Ok
```

## Hubble CLI: Flow Inspection

### Installing the Hubble CLI

```bash
# Download the hubble CLI (match version to your Cilium deployment)
HUBBLE_VERSION="v1.16.0"
HUBBLE_ARCH=amd64

curl -L --remote-name-all \
  "https://github.com/cilium/hubble/releases/download/${HUBBLE_VERSION}/hubble-linux-${HUBBLE_ARCH}.tar.gz"

tar xzvf "hubble-linux-${HUBBLE_ARCH}.tar.gz"
sudo install hubble /usr/local/bin/hubble

# Configure the CLI to use the Relay
kubectl port-forward -n kube-system svc/hubble-relay 4245:443 &
hubble config set server localhost:4245
hubble config set tls true
hubble config set tls-server-name hubble-relay.kube-system.svc.cluster.local

# Retrieve CA and client certificates generated by Cilium
kubectl get secret -n kube-system hubble-relay-client-certs \
  -o jsonpath='{.data.ca\.crt}' | base64 -d > /tmp/hubble-ca.crt
kubectl get secret -n kube-system hubble-relay-client-certs \
  -o jsonpath='{.data.tls\.crt}' | base64 -d > /tmp/hubble-client.crt
kubectl get secret -n kube-system hubble-relay-client-certs \
  -o jsonpath='{.data.tls\.key}' | base64 -d > /tmp/hubble-client.key

hubble config set tls-ca-cert-files /tmp/hubble-ca.crt
hubble config set tls-client-cert-file /tmp/hubble-client.crt
hubble config set tls-client-key-file /tmp/hubble-client.key

# Verify connectivity
hubble status
```

### Common Flow Inspection Commands

```bash
# Observe all flows in real time
hubble observe

# Filter by namespace
hubble observe --namespace production

# Filter by source or destination workload
hubble observe --from-label app=frontend
hubble observe --to-label app=postgres

# Show only dropped flows (policy violations)
hubble observe --verdict DROPPED

# Show HTTP flows with full URL details
hubble observe --protocol http --print-raw-filters

# Show DNS flows and queries
hubble observe --protocol dns

# Show flows between two specific pods
hubble observe \
  --from-pod production/frontend-7d8f9-xyz \
  --to-pod production/backend-5c6d7-abc

# Show flows with L7 details (requires L7 visibility enabled)
hubble observe --to-label app=api-server --type l7

# Count flows per source workload over a 30-second window
hubble observe --last 30s --output json | \
  jq -r '.flow.source.workloads[]?.name' | \
  sort | uniq -c | sort -rn | head -20

# Show flows that were forwarded to the proxy
hubble observe --type trace --sub-type to-proxy

# Export flows in JSON for offline analysis
hubble observe --last 1h --output json > /tmp/flows-$(date +%Y%m%d-%H%M%S).json
```

### Interpreting Flow Output

```bash
# Example output from: hubble observe --namespace production --protocol http
Jul  4 14:23:01.234 [production] to-endpoint FORWARDED (TCP Flags: ACK)
  frontend-7d8f9-xyz:54312 -> backend-5c6d7-abc:8080
  HTTP GET /api/v1/users 200 1.234ms

Jul  4 14:23:01.891 [production] to-endpoint DROPPED Policy denied
  unknown:0 -> backend-5c6d7-abc:8080
  TCP Flags: SYN

Jul  4 14:23:02.001 [production] to-endpoint FORWARDED
  backend-5c6d7-abc:48210 -> postgres-6e7f8-def:5432
  TCP Flags: ACK
```

The verdict field (`FORWARDED`, `DROPPED`, `ERROR`, `AUDIT`) is the critical field for policy enforcement validation.

## DNS Query Monitoring

DNS visibility is one of Hubble's most operationally valuable features. Every DNS query and response is captured at the kernel level.

### Enabling DNS Visibility

DNS visibility is enabled per-namespace via CiliumNetworkPolicy annotations or through the Hubble metrics configuration:

```yaml
# Enable DNS visibility for all pods in a namespace
# Apply to CiliumClusterwideNetworkPolicy or namespace-scoped CiliumNetworkPolicy
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: dns-visibility
  namespace: production
spec:
  endpointSelector:
    matchLabels: {}
  egress:
  - toEndpoints:
    - matchLabels:
        k8s:io.kubernetes.pod.namespace: kube-system
        k8s:k8s-app: kube-dns
    toPorts:
    - ports:
      - port: "53"
        protocol: UDP
      rules:
        dns:
        - matchPattern: "*"
```

### Querying DNS Flows

```bash
# Monitor all DNS queries from the production namespace
hubble observe --namespace production --protocol dns

# Example output:
# Jul  4 14:30:01 [production] to-endpoint FORWARDED
#   frontend-7d8f9-xyz:52341 -> kube-dns:53
#   DNS Query: api.external-service.com A
#
# Jul  4 14:30:01 [production] to-endpoint FORWARDED
#   kube-dns:53 -> frontend-7d8f9-xyz:52341
#   DNS Answer: api.external-service.com A 203.0.113.45 TTL: 300

# Find pods making DNS queries to external domains
hubble observe --namespace production --protocol dns --output json | \
  jq -r 'select(.flow.l7.dns.qtypes[] == "A") |
         "\(.flow.source.workloads[0].name) -> \(.flow.l7.dns.query)"' | \
  sort | uniq -c | sort -rn

# Detect DNS query failures (NXDOMAIN responses)
hubble observe --protocol dns --output json | \
  jq 'select(.flow.l7.dns.rcode == 3)' | \
  jq -r '"NXDOMAIN: \(.flow.l7.dns.query) from \(.flow.source.workloads[0].name)"'

# Find misconfigured service discovery (queries for nonexistent services)
hubble observe --protocol dns --output json | \
  jq -r 'select(.flow.l7.dns.rcode != 0) |
         .flow.l7.dns.query' | \
  sort | uniq -c | sort -rn | head -20
```

### DNS Policy Enforcement

```yaml
# Restrict DNS resolution to only approved domains
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: restrict-dns-egress
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: frontend
  egress:
  - toEndpoints:
    - matchLabels:
        k8s:io.kubernetes.pod.namespace: kube-system
        k8s:k8s-app: kube-dns
    toPorts:
    - ports:
      - port: "53"
        protocol: UDP
      rules:
        dns:
        - matchPattern: "*.svc.cluster.local"
        - matchPattern: "*.internal.example.com"
        - matchName: "api.approved-vendor.com"
```

## L7 Protocol Visibility

### HTTP Visibility

L7 visibility for HTTP requires that Cilium redirect traffic through its Envoy proxy. This is configured either globally or per-policy:

```yaml
# Enable HTTP L7 visibility for specific pods
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: http-visibility
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: api-server
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
          path: "/api/v1/.*"
        - method: "POST"
          path: "/api/v1/.*"
          headers:
          - "Content-Type: application/json"
```

Observe HTTP flows with full request/response details:

```bash
# Watch HTTP flows with method and path
hubble observe --to-label app=api-server --type l7 --output json | \
  jq -r '"\(.flow.l7.http.method) \(.flow.l7.http.url.path) -> \(.flow.l7.http.code) [\(.flow.l7.latency_ns / 1000000 | floor)ms]"'

# Find slow HTTP responses (> 1000ms)
hubble observe --type l7 --output json | \
  jq 'select(.flow.l7.type == "RESPONSE" and .flow.l7.latency_ns > 1000000000)' | \
  jq -r '"\(.flow.destination.workloads[0].name): \(.flow.l7.http.method) \(.flow.l7.http.url.path) \(.flow.l7.latency_ns / 1000000 | floor)ms"'

# Count HTTP status codes per service
hubble observe --type l7 --output json | \
  jq -r 'select(.flow.l7.http.code != null) |
         "\(.flow.destination.workloads[0].name) \(.flow.l7.http.code)"' | \
  sort | uniq -c | sort -rn
```

### gRPC Visibility

gRPC over HTTP/2 is visible when L7 visibility is enabled. Cilium parses gRPC method names from the HTTP/2 path header:

```yaml
# Policy with gRPC method-level control
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: grpc-visibility
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: grpc-server
  ingress:
  - fromEndpoints:
    - matchLabels:
        app: grpc-client
    toPorts:
    - ports:
      - port: "9090"
        protocol: TCP
      rules:
        http:
        - method: "POST"
          path: "/com.example.UserService/GetUser"
        - method: "POST"
          path: "/com.example.UserService/ListUsers"
```

```bash
# Observe gRPC flows
hubble observe --to-label app=grpc-server --type l7 --output json | \
  jq -r 'select(.flow.l7.http.url.path != null) |
         "\(.flow.source.workloads[0].name) -> \(.flow.l7.http.url.path) [\(.flow.l7.http.code)]"'
```

### Kafka Visibility

Cilium supports Kafka protocol parsing for topic-level access control and visibility:

```yaml
# Kafka L7 policy
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: kafka-visibility
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: kafka-consumer
  egress:
  - toEndpoints:
    - matchLabels:
        app: kafka
    toPorts:
    - ports:
      - port: "9092"
        protocol: TCP
      rules:
        kafka:
        - role: consume
          topic: orders
        - role: consume
          topic: inventory
```

```bash
# Observe Kafka flows
hubble observe --to-label app=kafka --type l7 --output json | \
  jq -r 'select(.flow.l7.kafka != null) |
         "\(.flow.source.workloads[0].name) \(.flow.l7.kafka.api_version) \(.flow.l7.kafka.api_key) topic:\(.flow.l7.kafka.topic.topic)"'
```

## Hubble Relay: Multi-Cluster Flow Aggregation

In multi-cluster Cilium deployments using Cluster Mesh, each cluster runs its own Hubble Relay. Cross-cluster visibility requires configuring the CLI to query multiple relays.

### Cluster Mesh Hubble Configuration

```yaml
# In the primary cluster's Cilium values
cilium:
  clustermesh:
    useAPIServer: true
    apiserver:
      replicas: 2

  hubble:
    relay:
      enabled: true
      # Relay must be accessible from other clusters
      service:
        type: LoadBalancer
        annotations:
          service.beta.kubernetes.io/aws-load-balancer-type: nlb
          service.beta.kubernetes.io/aws-load-balancer-internal: "true"
```

```bash
# Configure hubble CLI to query both clusters
hubble config set server relay-cluster-a.internal.example.com:4245,relay-cluster-b.internal.example.com:4245

# Observe flows across both clusters
hubble observe --all-namespaces

# Find cross-cluster connections
hubble observe --output json | \
  jq 'select(.flow.source.cluster != .flow.destination.cluster)' | \
  jq -r '"\(.flow.source.cluster)/\(.flow.source.namespace)/\(.flow.source.workloads[0].name) -> \(.flow.destination.cluster)/\(.flow.destination.namespace)/\(.flow.destination.workloads[0].name)"'
```

### Hubble Relay High Availability

```yaml
# relay-deployment-patch.yaml — production HA configuration
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hubble-relay
  namespace: kube-system
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
      maxSurge: 1
  template:
    spec:
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app.kubernetes.io/name: hubble-relay
      containers:
      - name: hubble-relay
        resources:
          requests:
            cpu: 200m
            memory: 128Mi
          limits:
            cpu: 1000m
            memory: 512Mi
        env:
        - name: HUBBLE_RELAY_METRICS_LISTEN_ADDRESS
          value: ":9966"
```

## Prometheus Metrics Export

Hubble exports a rich set of network metrics to Prometheus. Understanding the available metrics is essential for building meaningful dashboards.

### Key Hubble Metrics

```
# Flow-level metrics
hubble_flows_processed_total{node, protocol, verdict, type, reason}
hubble_drop_total{namespace, direction, reason, protocol}
hubble_tcp_flags_total{namespace, family, flag, direction}

# DNS metrics
hubble_dns_queries_total{namespace, qtypes, rcode}
hubble_dns_responses_total{namespace, qtypes, rcode}
hubble_dns_response_types_total{namespace, type, qtypes}

# HTTP metrics
hubble_http_requests_total{namespace, status, method, reporter, protocol}
hubble_http_request_duration_seconds{namespace, method, reporter, protocol, status}

# Policy metrics
hubble_policy_verdict_total{namespace, direction, match_type, source, destination}
```

### ServiceMonitor for Prometheus Operator

```yaml
# hubble-servicemonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: hubble
  namespace: monitoring
  labels:
    release: prometheus
spec:
  namespaceSelector:
    matchNames:
    - kube-system
  selector:
    matchLabels:
      app.kubernetes.io/name: hubble
  endpoints:
  - port: hubble-metrics
    interval: 30s
    path: /metrics
    honorLabels: true
    relabelings:
    - sourceLabels: [__meta_kubernetes_pod_node_name]
      targetLabel: node
    - sourceLabels: [__meta_kubernetes_namespace]
      targetLabel: kubernetes_namespace
```

### PrometheusRule for Alerting

```yaml
# hubble-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: hubble-alerts
  namespace: monitoring
  labels:
    release: prometheus
spec:
  groups:
  - name: hubble.network
    interval: 30s
    rules:

    # Alert on sustained high drop rate (potential policy misconfiguration or attack)
    - alert: HubbleHighDropRate
      expr: |
        sum by (namespace, reason) (
          rate(hubble_drop_total[5m])
        ) > 50
      for: 5m
      labels:
        severity: warning
        team: platform
      annotations:
        summary: "High network drop rate in namespace {{ $labels.namespace }}"
        description: "Drop rate for reason {{ $labels.reason }} in {{ $labels.namespace }} is {{ $value | humanize }} drops/s"

    # Alert on DNS failure rate spike
    - alert: HubbleDNSFailureRate
      expr: |
        sum by (namespace) (
          rate(hubble_dns_queries_total{rcode="Non-Existent Domain"}[5m])
        ) / sum by (namespace) (
          rate(hubble_dns_queries_total[5m])
        ) > 0.1
      for: 5m
      labels:
        severity: warning
        team: platform
      annotations:
        summary: "High DNS NXDOMAIN rate in {{ $labels.namespace }}"
        description: "DNS failure rate in {{ $labels.namespace }} is {{ $value | humanizePercentage }}"

    # Alert on HTTP 5xx error rate
    - alert: HubbleHTTP5xxRate
      expr: |
        sum by (namespace, destination) (
          rate(hubble_http_requests_total{status=~"5.."}[5m])
        ) / sum by (namespace, destination) (
          rate(hubble_http_requests_total[5m])
        ) > 0.05
      for: 3m
      labels:
        severity: warning
        team: application
      annotations:
        summary: "HTTP 5xx error rate above 5% in {{ $labels.namespace }}"
        description: "Service {{ $labels.destination }} in {{ $labels.namespace }} has {{ $value | humanizePercentage }} 5xx rate"

    # Alert on policy verdict changes (unexpected traffic patterns)
    - alert: HubblePolicyDeniedSpike
      expr: |
        sum by (namespace, direction) (
          rate(hubble_policy_verdict_total{match_type="deny"}[5m])
        ) > 10
      for: 2m
      labels:
        severity: warning
        team: security
      annotations:
        summary: "Policy denied traffic spike in {{ $labels.namespace }}"
        description: "{{ $value | humanize }} policy-denied flows/s in {{ $labels.namespace }} direction {{ $labels.direction }}"
```

## Building Network Dashboards

### Grafana Dashboard JSON Structure

The following describes a production-ready Hubble dashboard configuration:

```yaml
# grafana-dashboard-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: hubble-network-overview
  namespace: monitoring
  labels:
    grafana_dashboard: "1"
data:
  hubble-network-overview.json: |
    {
      "title": "Hubble Network Overview",
      "uid": "hubble-net-001",
      "tags": ["hubble", "cilium", "network"],
      "time": {"from": "now-1h", "to": "now"},
      "refresh": "30s",
      "panels": [
        {
          "title": "Total Flow Rate by Namespace",
          "type": "timeseries",
          "gridPos": {"h": 8, "w": 12, "x": 0, "y": 0},
          "targets": [
            {
              "expr": "sum by (namespace) (rate(hubble_flows_processed_total{verdict=\"FORWARDED\"}[2m]))",
              "legendFormat": "{{ namespace }}"
            }
          ]
        },
        {
          "title": "Drop Rate by Reason",
          "type": "timeseries",
          "gridPos": {"h": 8, "w": 12, "x": 12, "y": 0},
          "targets": [
            {
              "expr": "sum by (reason, namespace) (rate(hubble_drop_total[2m]))",
              "legendFormat": "{{ namespace }}/{{ reason }}"
            }
          ]
        },
        {
          "title": "HTTP Request Rate by Status Code",
          "type": "timeseries",
          "gridPos": {"h": 8, "w": 12, "x": 0, "y": 8},
          "targets": [
            {
              "expr": "sum by (status, namespace) (rate(hubble_http_requests_total[2m]))",
              "legendFormat": "{{ namespace }} HTTP {{ status }}"
            }
          ]
        },
        {
          "title": "HTTP P99 Latency by Namespace",
          "type": "timeseries",
          "gridPos": {"h": 8, "w": 12, "x": 12, "y": 8},
          "targets": [
            {
              "expr": "histogram_quantile(0.99, sum by (namespace, le) (rate(hubble_http_request_duration_seconds_bucket[5m])))",
              "legendFormat": "{{ namespace }} p99"
            }
          ]
        },
        {
          "title": "DNS NXDOMAIN Rate by Namespace",
          "type": "timeseries",
          "gridPos": {"h": 8, "w": 24, "x": 0, "y": 16},
          "targets": [
            {
              "expr": "sum by (namespace) (rate(hubble_dns_queries_total{rcode=\"Non-Existent Domain\"}[5m]))",
              "legendFormat": "{{ namespace }} NXDOMAIN"
            }
          ]
        }
      ]
    }
```

### Policy Compliance Dashboard Queries

```promql
# Policy enforcement ratio (higher = more traffic matches explicit policies)
sum(rate(hubble_policy_verdict_total{match_type=~"allow|deny"}[5m]))
  /
sum(rate(hubble_flows_processed_total[5m]))

# Namespaces with highest drop rates (sorted)
topk(10,
  sum by (namespace) (rate(hubble_drop_total[5m]))
)

# Services generating the most DROPPED flows (potential attack sources)
topk(10,
  sum by (source, namespace) (
    rate(hubble_policy_verdict_total{match_type="deny"}[5m])
  )
)

# Network traffic heatmap — identify chatty services
sum by (source, destination) (
  increase(hubble_flows_processed_total{verdict="FORWARDED"}[1h])
)
```

## Troubleshooting Common Issues

### Hubble Observer Ring Buffer Overflow

```bash
# Check if flows are being dropped due to ring buffer overflow
kubectl exec -n kube-system ds/cilium -- \
  cilium-dbg monitor --type drop | grep -i "ring buffer"

# Check current ring buffer utilization
kubectl exec -n kube-system ds/cilium -- \
  cilium status --verbose | grep -A3 "Hubble"

# If overflow is occurring, increase the ring buffer:
# In Helm values: hubble.ringBufferSize: 131072
# Note: Each entry is ~400 bytes, so 131072 entries ≈ 52MB per node
```

### Hubble Relay Connection Issues

```bash
# Check relay pod logs for connection errors
kubectl logs -n kube-system deployment/hubble-relay --tail=100

# Common error: TLS certificate mismatch
# Regenerate certificates:
kubectl delete secret -n kube-system hubble-relay-client-certs hubble-server-certs
kubectl rollout restart -n kube-system deployment/hubble-relay

# Verify relay can reach all Cilium agents
kubectl exec -n kube-system deployment/hubble-relay -- \
  /usr/bin/hubble-relay status

# Check agent connectivity from relay perspective
kubectl exec -n kube-system deployment/hubble-relay -- \
  hubble status --all-nodes
```

### Missing L7 Flows

```bash
# Verify Envoy proxy is handling traffic for the target service
kubectl exec -n kube-system ds/cilium -- \
  cilium-dbg proxy-statistics

# Check if L7 visibility annotations are set
kubectl get ciliumnetworkpolicies -n production -o yaml | \
  grep -A5 "toPorts"

# Confirm Cilium proxy is redirecting traffic
kubectl exec -n kube-system ds/cilium -- \
  cilium-dbg bpf proxy list

# Enable debug logging for proxy traffic
kubectl exec -n kube-system ds/cilium -- \
  cilium-dbg config Debug=true ProxyConnectTimeout=10
```

### Performance Impact Assessment

```bash
# Measure eBPF overhead with Hubble enabled vs disabled
# Use the Cilium benchmark tool
kubectl exec -n kube-system ds/cilium -- \
  cilium-dbg perf list | grep hubble

# Check CPU usage of Cilium agent with Hubble enabled
kubectl top pod -n kube-system -l k8s-app=cilium --containers

# Monitor ring buffer lock contention
kubectl exec -n kube-system ds/cilium -- \
  cat /sys/kernel/debug/tracing/trace_pipe | grep hubble_ring
```

## Production Best Practices

### Flow Retention and Archival

For compliance and forensic purposes, Hubble flows should be archived to long-term storage:

```yaml
# hubble-export-daemonset.yaml — Fluent Bit sidecar for flow archival
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: hubble-flow-archiver
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: hubble-flow-archiver
  template:
    metadata:
      labels:
        app: hubble-flow-archiver
    spec:
      hostNetwork: true
      containers:
      - name: flow-archiver
        image: fluent/fluent-bit:3.1
        volumeMounts:
        - name: hubble-flows
          mountPath: /var/run/cilium/hubble
          readOnly: true
        - name: fluent-bit-config
          mountPath: /fluent-bit/etc
      volumes:
      - name: hubble-flows
        hostPath:
          path: /var/run/cilium/hubble
      - name: fluent-bit-config
        configMap:
          name: hubble-flow-archiver-config
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: hubble-flow-archiver-config
  namespace: kube-system
data:
  fluent-bit.conf: |
    [SERVICE]
        Flush         5
        Log_Level     info

    [INPUT]
        Name          tail
        Path          /var/run/cilium/hubble/events.log
        Tag           hubble.flows
        Parser        json

    [OUTPUT]
        Name          s3
        Match         hubble.flows
        bucket        company-network-flows
        region        us-east-1
        s3_key_format /hubble/flows/%Y/%m/%d/%H/%M-%S-${HOSTNAME}.json.gz
        compression   gzip
        upload_timeout 60s
```

### Network Policy Testing Workflow

```bash
# 1. Deploy a policy in audit mode first
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: restrict-db-access
  namespace: production
  annotations:
    policy.cilium.io/mode: "audit"  # Audit mode: log but don't drop
spec:
  endpointSelector:
    matchLabels:
      app: postgres
  ingress:
  - fromEndpoints:
    - matchLabels:
        app: backend

# 2. Monitor audit drops for 24-48 hours
hubble observe --namespace production --verdict AUDIT --output json | \
  jq -r '.flow.source.workloads[0].name' | \
  sort | uniq -c | sort -rn

# 3. Verify expected traffic patterns match policy
# 4. Switch from audit to enforce mode
kubectl annotate ciliumnetworkpolicy -n production restrict-db-access \
  policy.cilium.io/mode-

# 5. Monitor for 15 minutes after policy activation
watch -n5 'hubble observe --namespace production --to-label app=postgres --verdict DROPPED --last 5m | wc -l'
```

## Summary

Hubble transforms Cilium from a network policy engine into a full observability platform. The key operational capabilities covered in this guide are:

- **Flow inspection**: Real-time and historical network flow analysis via CLI and Prometheus metrics
- **DNS monitoring**: Complete visibility into DNS query patterns for service discovery debugging and security analysis
- **L7 visibility**: HTTP, gRPC, and Kafka protocol-level observability with request/response details and latency tracking
- **Multi-cluster flows**: Hubble Relay aggregation across Cluster Mesh deployments
- **Alerting**: PrometheusRule-based alerting on drop rates, DNS failures, HTTP error rates, and policy violations
- **Compliance archival**: Automated flow export to long-term storage for audit requirements

The combination of zero-overhead eBPF instrumentation and rich L7 protocol visibility makes Hubble the most capable network observability tool available for Kubernetes without requiring application changes or sidecar injection.
