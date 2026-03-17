---
title: "Kubernetes Hubble Network Observability: Flow Visibility, Prometheus Metrics, Grafana Dashboards, and DNS Monitoring"
date: 2032-02-26T00:00:00-05:00
draft: false
tags: ["Hubble", "Cilium", "Kubernetes", "Observability", "Networking", "eBPF", "Grafana"]
categories:
- Kubernetes
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Hubble, the eBPF-powered network observability platform for Cilium-based Kubernetes clusters, covering flow visibility, Prometheus metrics export, Grafana dashboard configuration, and DNS query monitoring."
more_link: "yes"
url: "/kubernetes-hubble-network-observability-flow-visibility-grafana/"
---

Hubble is the observability layer of Cilium, using eBPF programs running in the kernel to capture every network flow without modifying applications or injecting sidecars. In a cluster with hundreds of microservices, Hubble answers questions that are otherwise impossible to answer: which pods are communicating with each other, where connection failures are occurring, which DNS lookups are failing, and which network policies are blocking traffic. This guide covers deploying Hubble in production, extracting metrics to Prometheus, and building Grafana dashboards that surface actionable network intelligence.

<!--more-->

# Kubernetes Hubble Network Observability

## Architecture Overview

Hubble operates as a distributed system with components at three levels:

```
┌─────────────────────────────────────────────────────────┐
│  Kubernetes Node                                        │
│  ┌──────────────────────────────────────────────────┐   │
│  │  cilium-agent (DaemonSet)                        │   │
│  │    ├── eBPF programs (kernel)                    │   │
│  │    ├── Hubble observer (gRPC server :4244)       │   │
│  │    └── Flow ringbuffer (in-memory)               │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
           │                           │
           ▼                           ▼
┌──────────────────────┐   ┌──────────────────────────┐
│  Hubble Relay        │   │  Hubble UI               │
│  (aggregates flows   │   │  (web interface)         │
│   from all nodes)    │   └──────────────────────────┘
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐   ┌──────────────────────────┐
│  Prometheus          │   │  Grafana                 │
│  (metrics scrape)    │──►│  (dashboards)            │
└──────────────────────┘   └──────────────────────────┘
```

## Section 1: Installing Cilium with Hubble Enabled

### Helm Installation

```bash
# Add the Cilium Helm repository
helm repo add cilium https://helm.cilium.io/
helm repo update

# Install Cilium with Hubble enabled
helm upgrade --install cilium cilium/cilium \
  --version 1.16.3 \
  --namespace kube-system \
  --set hubble.enabled=true \
  --set hubble.relay.enabled=true \
  --set hubble.ui.enabled=true \
  --set hubble.metrics.enabled="{dns,drop,tcp,flow,port-distribution,icmp,httpV2:exemplars=true;labelsContext=source_ip\,source_namespace\,source_workload\,destination_ip\,destination_namespace\,destination_workload\,traffic_direction}" \
  --set hubble.metrics.serviceMonitor.enabled=true \
  --set hubble.metrics.serviceMonitor.labels.release=kube-prometheus-stack \
  --set prometheus.enabled=true \
  --set operator.prometheus.enabled=true \
  --set ipam.mode=kubernetes \
  --set kubeProxyReplacement=true \
  --set k8sServiceHost=$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}') \
  --set k8sServicePort=6443
```

### Hubble-Specific Helm Values

For complex production deployments, use a values file:

```yaml
# hubble-values.yaml
hubble:
  enabled: true

  # Ring buffer size per node (increase for high-traffic nodes)
  flowBufferSize: 65535

  # gRPC server on each Cilium agent
  listenAddress: ":4244"

  relay:
    enabled: true
    replicas: 2
    resources:
      requests:
        cpu: 100m
        memory: 128Mi
      limits:
        cpu: 500m
        memory: 512Mi
    affinity:
      podAntiAffinity:
        preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchLabels:
                  app.kubernetes.io/name: hubble-relay
              topologyKey: kubernetes.io/hostname
    tls:
      server:
        enabled: true

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
        nginx.ingress.kubernetes.io/auth-type: basic
        nginx.ingress.kubernetes.io/auth-secret: hubble-basic-auth
      hosts:
        - hubble.internal.example.com
      tls:
        - secretName: hubble-ui-tls
          hosts:
            - hubble.internal.example.com

  metrics:
    enabled:
      # DNS metrics with query labels
      - dns:query;ignoreAAAA
      # Drop reasons with direction labels
      - drop:sourceContext=namespace;destinationContext=namespace
      # TCP connection metrics
      - tcp
      # Full flow metrics
      - flow:sourceContext=workload-name;destinationContext=workload-name
      # Port distribution
      - port-distribution
      # ICMP metrics
      - icmp
      # HTTP metrics with exemplars
      - httpV2:exemplars=true;labelsContext=source_namespace,destination_namespace,traffic_direction

    # Expose Prometheus metrics
    port: 9965

    serviceMonitor:
      enabled: true
      labels:
        release: kube-prometheus-stack
      interval: 30s
      scrapeTimeout: 10s
```

```bash
helm upgrade --install cilium cilium/cilium \
  --version 1.16.3 \
  --namespace kube-system \
  -f hubble-values.yaml
```

## Section 2: Hubble CLI Usage

### Installation

```bash
# Linux (amd64)
HUBBLE_VERSION=$(curl -s https://raw.githubusercontent.com/cilium/hubble/master/stable.txt)
curl -L --remote-name-all \
  "https://github.com/cilium/hubble/releases/download/${HUBBLE_VERSION}/hubble-linux-amd64.tar.gz"
tar xzvf hubble-linux-amd64.tar.gz
sudo mv hubble /usr/local/bin/

# Configure Hubble CLI to use the relay
hubble config set server localhost:4245

# Port-forward for local access
kubectl -n kube-system port-forward svc/hubble-relay 4245:443 &
```

### Observing Flows

```bash
# Watch all flows in real time
hubble observe --follow

# Filter by namespace
hubble observe --namespace production --follow

# Filter by pod
hubble observe --from-pod production/api-server --follow

# Filter by destination
hubble observe --to-pod production/database --follow

# Show only dropped flows
hubble observe --verdict DROPPED --follow

# Show DNS flows
hubble observe --protocol DNS --follow

# Show HTTP flows with status codes
hubble observe --protocol HTTP --follow

# Combined: show dropped flows in the production namespace from the last 5 minutes
hubble observe \
  --namespace production \
  --verdict DROPPED \
  --since 5m \
  --output json \
  | jq '{
      time: .time,
      src: "\(.source.namespace)/\(.source.pod_name)",
      dst: "\(.destination.namespace)/\(.destination.pod_name)",
      reason: .drop_reason,
      policy: .drop_reason_desc
    }'

# Count flows by source/destination pair
hubble observe \
  --namespace production \
  --since 10m \
  --output json \
  | jq -r '[.source.pod_name, .destination.pod_name, .l4.TCP.destination_port] | @tsv' \
  | sort | uniq -c | sort -rn | head -20
```

### Network Policy Debugging

```bash
# Find which policy is blocking a connection
hubble observe \
  --from-pod production/api-server \
  --to-pod production/legacy-db \
  --verdict DROPPED \
  --output json \
  | jq '{
      time: .time,
      verdict: .verdict,
      drop_reason: .drop_reason,
      policy: .egress_allowed_by,
      denied_by: .policy_match_l3
    }'

# See all policy decisions for a pod
hubble observe \
  --from-pod production/api-server \
  --type policy-verdict \
  --since 5m \
  --output json \
  | jq '{src: .source.pod_name, dst: .destination.pod_name, verdict: .verdict, policy: .traffic_direction}'
```

## Section 3: Prometheus Metrics

### Available Metrics

Hubble exposes metrics at `/metrics` on port 9965 of each Cilium agent. Key metrics by category:

```promql
# ── Flow Metrics ─────────────────────────────────────────────────────────────

# Total flows observed (by verdict)
hubble_flows_processed_total{type="L3/L4", verdict="FORWARDED"}
hubble_flows_processed_total{type="L7", verdict="DROPPED"}

# ── Drop Metrics ─────────────────────────────────────────────────────────────

# Drops by reason and namespace
hubble_drop_total{reason="POLICY_DENIED", source="production", destination="monitoring"}
hubble_drop_total{reason="CONNECTION_RESET"}

# Drop rate
rate(hubble_drop_total[5m])

# ── DNS Metrics ───────────────────────────────────────────────────────────────

# DNS queries by query type and result
hubble_dns_queries_total{rcode="Non-Existent Domain"}
hubble_dns_queries_total{query_type="A", rcode="No Error"}

# DNS response types
hubble_dns_responses_total

# ── HTTP Metrics ─────────────────────────────────────────────────────────────

# HTTP request rate by method and response code
hubble_http_requests_total{method="GET", protocol="HTTP/1.1", reporter="client"}
rate(hubble_http_requests_total[5m])

# HTTP latency
histogram_quantile(0.99,
  rate(hubble_http_request_duration_seconds_bucket[5m])
)

# ── TCP Metrics ───────────────────────────────────────────────────────────────

# TCP flags (SYN, RST, FIN)
hubble_tcp_flags_total{flag="SYN"}
hubble_tcp_flags_total{flag="RST"}

# TCP reset rate (indicates connection failures)
rate(hubble_tcp_flags_total{flag="RST"}[5m])

# ── Port Distribution ─────────────────────────────────────────────────────────
hubble_port_distribution_total{port="443", protocol="TCP"}
```

### Recording Rules for Dashboards

```yaml
# hubble-recording-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: hubble-recording-rules
  namespace: monitoring
  labels:
    release: kube-prometheus-stack
spec:
  groups:
    - name: hubble.flows
      interval: 30s
      rules:
        - record: hubble:flow_rate:namespace:5m
          expr: |
            sum by (namespace, verdict) (
              rate(hubble_flows_processed_total[5m])
            )

        - record: hubble:drop_rate:namespace:5m
          expr: |
            sum by (source, destination, reason) (
              rate(hubble_drop_total[5m])
            )

        - record: hubble:http_error_rate:namespace:5m
          expr: |
            sum by (source_namespace, destination_namespace) (
              rate(hubble_http_requests_total{status_code=~"5.."}[5m])
            )
            /
            sum by (source_namespace, destination_namespace) (
              rate(hubble_http_requests_total[5m])
            )

        - record: hubble:dns_nxdomain_rate:5m
          expr: |
            sum by (source_namespace) (
              rate(hubble_dns_queries_total{rcode="Non-Existent Domain"}[5m])
            )

        - record: hubble:tcp_reset_rate:5m
          expr: |
            sum by (source, destination) (
              rate(hubble_tcp_flags_total{flag="RST"}[5m])
            )

    - name: hubble.alerts
      rules:
        - alert: HighNetworkDropRate
          expr: |
            sum by (source, destination) (
              rate(hubble_drop_total{reason="POLICY_DENIED"}[5m])
            ) > 10
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High policy drop rate between {{ $labels.source }} and {{ $labels.destination }}"
            description: "{{ $value | humanize }} drops/sec due to policy denial"

        - alert: HighDNSNXDomainRate
          expr: |
            sum by (source_namespace) (
              rate(hubble_dns_queries_total{rcode="Non-Existent Domain"}[5m])
            ) > 5
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "High DNS NXDOMAIN rate in {{ $labels.source_namespace }}"

        - alert: HighTCPResetRate
          expr: |
            sum by (source, destination) (
              rate(hubble_tcp_flags_total{flag="RST"}[5m])
            ) > 50
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High TCP reset rate between {{ $labels.source }} and {{ $labels.destination }}"

        - alert: HTTPErrorRateCrossNamespace
          expr: |
            hubble:http_error_rate:namespace:5m > 0.05
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "HTTP error rate >5% from {{ $labels.source_namespace }} to {{ $labels.destination_namespace }}"
```

## Section 4: Grafana Dashboards

### Network Overview Dashboard (JSON)

```json
{
  "title": "Hubble Network Overview",
  "uid": "hubble-overview",
  "panels": [
    {
      "id": 1,
      "title": "Total Flow Rate by Verdict",
      "type": "timeseries",
      "gridPos": {"h": 8, "w": 12, "x": 0, "y": 0},
      "targets": [
        {
          "expr": "sum by (verdict) (rate(hubble_flows_processed_total[5m]))",
          "legendFormat": "{{verdict}}"
        }
      ],
      "fieldConfig": {
        "defaults": {
          "unit": "reqps",
          "custom": {"lineWidth": 2}
        },
        "overrides": [
          {
            "matcher": {"id": "byName", "options": "DROPPED"},
            "properties": [{"id": "color", "value": {"mode": "fixed", "fixedColor": "red"}}]
          },
          {
            "matcher": {"id": "byName", "options": "FORWARDED"},
            "properties": [{"id": "color", "value": {"mode": "fixed", "fixedColor": "green"}}]
          }
        ]
      }
    },
    {
      "id": 2,
      "title": "Policy Drop Rate by Namespace",
      "type": "timeseries",
      "gridPos": {"h": 8, "w": 12, "x": 12, "y": 0},
      "targets": [
        {
          "expr": "topk(10, sum by (source, destination) (rate(hubble_drop_total{reason=\"POLICY_DENIED\"}[5m])))",
          "legendFormat": "{{source}} → {{destination}}"
        }
      ],
      "fieldConfig": {
        "defaults": {"unit": "reqps"}
      }
    },
    {
      "id": 3,
      "title": "DNS NXDOMAIN Rate by Namespace",
      "type": "timeseries",
      "gridPos": {"h": 8, "w": 12, "x": 0, "y": 8},
      "targets": [
        {
          "expr": "sum by (source_namespace) (rate(hubble_dns_queries_total{rcode=\"Non-Existent Domain\"}[5m]))",
          "legendFormat": "{{source_namespace}}"
        }
      ],
      "fieldConfig": {
        "defaults": {"unit": "reqps", "color": {"mode": "palette-classic"}}
      }
    },
    {
      "id": 4,
      "title": "HTTP P99 Latency by Service",
      "type": "timeseries",
      "gridPos": {"h": 8, "w": 12, "x": 12, "y": 8},
      "targets": [
        {
          "expr": "histogram_quantile(0.99, sum by (le, destination_namespace) (rate(hubble_http_request_duration_seconds_bucket[5m])))",
          "legendFormat": "{{destination_namespace}} p99"
        }
      ],
      "fieldConfig": {
        "defaults": {"unit": "s"}
      }
    },
    {
      "id": 5,
      "title": "TCP Reset Rate (Connection Failures)",
      "type": "timeseries",
      "gridPos": {"h": 8, "w": 24, "x": 0, "y": 16},
      "targets": [
        {
          "expr": "topk(10, sum by (source, destination) (rate(hubble_tcp_flags_total{flag=\"RST\"}[5m])))",
          "legendFormat": "{{source}} → {{destination}}"
        }
      ],
      "fieldConfig": {
        "defaults": {"unit": "reqps"}
      },
      "alert": {
        "name": "High TCP Reset Rate",
        "conditions": [
          {
            "type": "query",
            "query": {"params": ["A", "5m", "now"]},
            "reducer": {"type": "max"},
            "evaluator": {"type": "gt", "params": [50]}
          }
        ]
      }
    }
  ],
  "templating": {
    "list": [
      {
        "name": "namespace",
        "type": "query",
        "query": "label_values(hubble_flows_processed_total, source_namespace)",
        "multi": true,
        "includeAll": true
      },
      {
        "name": "interval",
        "type": "interval",
        "options": ["1m", "5m", "10m", "30m", "1h"],
        "current": "5m"
      }
    ]
  },
  "time": {"from": "now-1h", "to": "now"},
  "refresh": "30s"
}
```

### DNS Monitoring Dashboard

```json
{
  "title": "Hubble DNS Monitoring",
  "uid": "hubble-dns",
  "panels": [
    {
      "id": 1,
      "title": "DNS Query Rate by Record Type",
      "type": "timeseries",
      "gridPos": {"h": 8, "w": 12, "x": 0, "y": 0},
      "targets": [
        {
          "expr": "sum by (query_type) (rate(hubble_dns_queries_total{rcode=\"No Error\"}[$__rate_interval]))",
          "legendFormat": "{{query_type}}"
        }
      ]
    },
    {
      "id": 2,
      "title": "DNS Error Rate by Response Code",
      "type": "timeseries",
      "gridPos": {"h": 8, "w": 12, "x": 12, "y": 0},
      "targets": [
        {
          "expr": "sum by (rcode, source_namespace) (rate(hubble_dns_queries_total{rcode!=\"No Error\"}[$__rate_interval]))",
          "legendFormat": "{{source_namespace}}: {{rcode}}"
        }
      ]
    },
    {
      "id": 3,
      "title": "Top NXDOMAIN Queries",
      "type": "table",
      "gridPos": {"h": 8, "w": 24, "x": 0, "y": 8},
      "targets": [
        {
          "expr": "topk(25, sum by (query, source_namespace) (rate(hubble_dns_queries_total{rcode=\"Non-Existent Domain\"}[30m])))",
          "legendFormat": "",
          "instant": true
        }
      ],
      "transformations": [
        {"id": "sortBy", "options": {"fields": [{"displayName": "Value", "desc": true}]}}
      ]
    }
  ]
}
```

## Section 5: DNS Monitoring Deep Dive

### Using hubble observe for DNS Analysis

```bash
# Watch DNS queries in real time
hubble observe \
  --protocol DNS \
  --follow \
  --output json \
  | jq '{
      time: .time,
      src_ns: .source.namespace,
      src_pod: .source.pod_name,
      query: .l7.dns.query,
      response_code: .l7.dns.rcode,
      ips: .l7.dns.ips
    }'

# Find all NXDOMAIN responses
hubble observe \
  --protocol DNS \
  --since 30m \
  --output json \
  | jq 'select(.l7.dns.rcode == "Non-Existent Domain") | {
      src: "\(.source.namespace)/\(.source.pod_name)",
      query: .l7.dns.query,
      time: .time
    }'

# Aggregate DNS queries by source pod
hubble observe \
  --protocol DNS \
  --since 10m \
  --output json \
  | jq -r '[.source.namespace, .source.pod_name, .l7.dns.query] | @tsv' \
  | sort | uniq -c | sort -rn | head -30

# Find pods making excessive DNS queries (possible misconfiguration)
hubble observe \
  --protocol DNS \
  --since 1m \
  --output json \
  | jq -r '"\(.source.namespace)/\(.source.pod_name)"' \
  | sort | uniq -c | sort -rn | head -10
```

### DNS Policy Enforcement with Cilium

```yaml
# Restrict a pod to only resolve specific domains
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: restrict-dns-egress
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: api-server
  egress:
    # Allow DNS to cluster DNS only
    - toEndpoints:
        - matchLabels:
            io.kubernetes.pod.namespace: kube-system
            k8s-app: kube-dns
      toPorts:
        - ports:
            - port: "53"
              protocol: UDP
          rules:
            dns:
              # Allow resolution of cluster services
              - matchPattern: "*.cluster.local"
              # Allow resolution of specific external services
              - matchName: "api.stripe.com"
              - matchName: "api.sendgrid.com"
              - matchPattern: "*.amazonaws.com"
    # Allow HTTPS to allowed domains
    - toFQDNs:
        - matchName: "api.stripe.com"
        - matchName: "api.sendgrid.com"
        - matchPattern: "*.amazonaws.com"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP
```

### DNS Observability for Incident Response

```bash
# Script: DNS investigation for a service incident
#!/bin/bash
# dns-investigation.sh

NAMESPACE="${1:-production}"
POD="${2}"
DURATION="${3:-15m}"

echo "=== DNS Investigation for ${NAMESPACE}/${POD} ==="
echo "Duration: ${DURATION}"
echo ""

echo "--- All DNS queries ---"
if [[ -n "${POD}" ]]; then
  hubble observe \
    --from-pod "${NAMESPACE}/${POD}" \
    --protocol DNS \
    --since "${DURATION}" \
    --output json 2>/dev/null
else
  hubble observe \
    --namespace "${NAMESPACE}" \
    --protocol DNS \
    --since "${DURATION}" \
    --output json 2>/dev/null
fi | jq -r '[.time, "\(.source.namespace)/\(.source.pod_name)", .l7.dns.query, .l7.dns.rcode] | @tsv' \
  | column -t

echo ""
echo "--- NXDOMAIN responses ---"
hubble observe \
  --namespace "${NAMESPACE}" \
  --protocol DNS \
  --since "${DURATION}" \
  --output json 2>/dev/null \
  | jq 'select(.l7.dns.rcode == "Non-Existent Domain")' \
  | jq -r '[.time, "\(.source.namespace)/\(.source.pod_name)", .l7.dns.query] | @tsv' \
  | column -t

echo ""
echo "--- DNS query frequency (top 20) ---"
hubble observe \
  --namespace "${NAMESPACE}" \
  --protocol DNS \
  --since "${DURATION}" \
  --output json 2>/dev/null \
  | jq -r '"\(.source.pod_name) \(.l7.dns.query)"' \
  | sort | uniq -c | sort -rn | head -20
```

## Section 6: Service Map and Flow Visualization

### Exporting Flow Data to External Systems

```bash
# Export flows to JSON for SIEM integration
hubble observe \
  --since 1h \
  --output json \
  | gzip > flows-$(date +%Y%m%d-%H%M).json.gz

# Stream flows to Elasticsearch
hubble observe \
  --follow \
  --output json \
  | jq -c '. + {
      "@timestamp": .time,
      "cluster": env.CLUSTER_NAME
    }' \
  | while read line; do
      curl -s -X POST \
        "http://elasticsearch:9200/hubble-flows-$(date +%Y.%m.%d)/_doc" \
        -H "Content-Type: application/json" \
        -d "${line}"
    done
```

### Generating Service Topology

```bash
# Create a service dependency map from observed flows
hubble observe \
  --since 1h \
  --verdict FORWARDED \
  --output json \
  | jq -r 'select(.source.namespace != null and .destination.namespace != null) |
    "\(.source.namespace)/\(.source.workload_name // .source.pod_name) \(.destination.namespace)/\(.destination.workload_name // .destination.pod_name)"' \
  | sort | uniq -c | sort -rn \
  | awk '{printf "%s -> %s [label=\"%d/s\"]\n", $2, $3, $1}' \
  | sort -u > /tmp/service-graph.dot

# Render to PNG
echo "digraph {" > service-topology.dot
cat /tmp/service-graph.dot >> service-topology.dot
echo "}" >> service-topology.dot
dot -Tpng service-topology.dot -o service-topology.png
```

## Section 7: Performance Considerations

### Tuning the Flow Buffer

The flow ring buffer on each node is bounded. In high-throughput clusters, you need to increase it to avoid dropping observability data.

```bash
# Check current buffer size
cilium config get monitor-aggregation-level

# Check if flows are being dropped due to buffer overflow
cilium monitor --type drop 2>&1 | grep -i overflow

# Increase buffer size (requires Cilium restart)
helm upgrade cilium cilium/cilium \
  --reuse-values \
  --set hubble.flowBufferSize=131072
```

### Metrics Cardinality Management

Hubble metrics can have very high cardinality if pod labels are included. Restrict which labels appear in metrics:

```yaml
hubble:
  metrics:
    enabled:
      # Use workload-level labels instead of pod-level
      # This reduces cardinality from (pods^2) to (workloads^2)
      - flow:sourceContext=workload-name;destinationContext=workload-name
      # NOT: flow:sourceContext=pod;destinationContext=pod  (too high cardinality)
```

### Selective Monitoring

For clusters with >1000 pods, use Hubble policies to only collect flows for specific namespaces:

```yaml
# hubble-flow-filter.yaml
apiVersion: cilium.io/v2
kind: CiliumClusterwideNetworkPolicy
metadata:
  name: hubble-observe-production-only
spec:
  # This is a placeholder concept - actual implementation
  # uses the --whitelist-nodes flag on hubble-relay
```

```bash
# Limit relay to specific namespaces
helm upgrade cilium cilium/cilium \
  --reuse-values \
  --set hubble.relay.extraArgs[0]="--field-mask=source.namespace,destination.namespace,verdict"
```

## Section 8: Alerting on Network Anomalies

### Prometheus AlertManager Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: hubble-network-alerts
  namespace: monitoring
  labels:
    release: kube-prometheus-stack
spec:
  groups:
    - name: hubble.network
      rules:
        - alert: UnexpectedNetworkPath
          expr: |
            sum by (source_namespace, destination_namespace) (
              rate(hubble_drop_total{
                reason="POLICY_DENIED",
                source_namespace=~"production|staging",
                destination_namespace=~"production|staging"
              }[5m])
            ) > 0
          for: 2m
          labels:
            severity: info
          annotations:
            summary: "Unexpected cross-namespace connection attempt blocked"
            description: "{{ $labels.source_namespace }} attempted to connect to {{ $labels.destination_namespace }} but was blocked by policy"

        - alert: ExcessiveDNSFailures
          expr: |
            sum by (source_namespace) (
              rate(hubble_dns_queries_total{rcode=~"Server Failure|Non-Existent Domain"}[5m])
            ) > 10
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High DNS failure rate in {{ $labels.source_namespace }}"

        - alert: ServiceHTTPErrorSpike
          expr: |
            (
              sum by (destination_namespace) (
                rate(hubble_http_requests_total{status_code=~"5.."}[5m])
              )
              /
              sum by (destination_namespace) (
                rate(hubble_http_requests_total[5m])
              )
            ) > 0.1
          for: 3m
          labels:
            severity: critical
          annotations:
            summary: "HTTP error rate >10% in {{ $labels.destination_namespace }}"

        - alert: CiliumAgentNotReporting
          expr: |
            up{job="cilium-agent"} == 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Cilium agent not reporting on node {{ $labels.node }}"
```

## Conclusion

Hubble provides a fundamentally different approach to network observability compared to traditional packet capture or flow export tools. Because it operates at the eBPF layer in the kernel, it captures every flow without performance degradation or application modification. The combination of the Hubble CLI for incident investigation, Prometheus metrics for continuous monitoring, and Grafana dashboards for visualization creates a complete observability stack for Kubernetes network operations. DNS monitoring is particularly valuable because DNS failures are frequently the first symptom of network policy misconfiguration, service discovery issues, or exfiltration attempts.
