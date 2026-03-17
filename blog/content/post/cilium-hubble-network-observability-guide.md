---
title: "Cilium Hubble: Deep Network Observability for Kubernetes"
date: 2027-11-08T00:00:00-05:00
draft: false
tags: ["Cilium", "Hubble", "eBPF", "Network Observability", "Kubernetes"]
categories:
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to deploying Cilium Hubble for deep network observability, covering flow visibility, L7 protocol inspection, service maps, flow export, and production monitoring integration."
more_link: "yes"
url: "/cilium-hubble-network-observability-guide/"
---

Cilium Hubble provides kernel-level network observability for Kubernetes without any application instrumentation. Built on eBPF, Hubble captures every network flow at the Linux kernel level, providing visibility into L3/L4 traffic, L7 protocol details for HTTP and gRPC, DNS queries, and service-to-service communication patterns. For production teams troubleshooting network issues, enforcing policies, or auditing traffic, Hubble eliminates the guesswork.

This guide covers Hubble deployment with Cilium, flow visibility configuration, L7 protocol inspection, service map usage, CLI and UI operations, flow export to external systems, and production integration patterns.

<!--more-->

# Cilium Hubble: Deep Network Observability for Kubernetes

## Architecture Overview

Hubble operates through three components:

**Hubble per-node observer**: Runs inside each Cilium agent pod, capturing flows from the eBPF datapath and exposing them over a local gRPC API.

**Hubble Relay**: Aggregates flows from all per-node observers, providing a cluster-wide flow query endpoint.

**Hubble UI**: Web interface for visualizing the service map and exploring flows.

```
┌─────────────────────────────────────────────────────────┐
│  Node 1                                                 │
│  ┌─────────────────────────────────────────────────┐   │
│  │  Cilium Agent                                   │   │
│  │  ┌───────────────┐   ┌─────────────────────┐   │   │
│  │  │  eBPF Programs│──►│  Hubble Observer     │   │   │
│  │  │  (TC, XDP)    │   │  (ring buffer)       │   │   │
│  │  └───────────────┘   └──────────┬──────────┘   │   │
│  └──────────────────────────────── │ ──────────────┘   │
│                                    │ gRPC               │
│                          ┌─────────▼──────────┐        │
│                          │  Hubble Relay       │        │
│                          │  (aggregates all   │        │
│                          │   node observers)  │        │
│                          └─────────┬──────────┘        │
│                                    │                    │
│                          ┌─────────▼──────────┐        │
│                          │  hubble-ui          │        │
│                          │  CLI / API clients  │        │
│                          └────────────────────┘        │
└─────────────────────────────────────────────────────────┘
```

## Installing Cilium with Hubble

### Prerequisites

```bash
# Verify kernel version (5.4+ recommended, 4.9+ minimum)
uname -r

# Check Cilium CLI is installed
cilium version

# If not installed:
CILIUM_CLI_VERSION=$(curl -s https://raw.githubusercontent.com/cilium/cilium-cli/main/stable.txt)
curl -L --remote-name-all \
  https://github.com/cilium/cilium-cli/releases/download/${CILIUM_CLI_VERSION}/cilium-linux-amd64.tar.gz
tar xzf cilium-linux-amd64.tar.gz
sudo mv cilium /usr/local/bin/
```

### Helm Installation with Hubble Enabled

```yaml
# cilium-values.yaml
kubeProxyReplacement: true
k8sServiceHost: api.prod-cluster.company.internal
k8sServicePort: 6443

ipam:
  mode: kubernetes

tunnel: disabled

nativeRoutingCIDR: 10.0.0.0/16

bpf:
  masquerade: true

autoDirectNodeRoutes: true

hubble:
  enabled: true
  relay:
    enabled: true
    replicas: 2
    resources:
      requests:
        cpu: 100m
        memory: 128Mi
      limits:
        cpu: 1000m
        memory: 512Mi
  ui:
    enabled: true
    replicas: 1
    resources:
      requests:
        cpu: 50m
        memory: 64Mi
  tls:
    enabled: true
    auto:
      enabled: true
      method: helm
  metrics:
    enableOpenMetrics: true
    enabled:
    - dns:query;ignoreAAAA
    - drop
    - tcp
    - flow
    - icmp
    - http
    serviceMonitor:
      enabled: true
  export:
    static:
      enabled: true
      filePath: /var/run/cilium/hubble/events.log
      fieldMask: []
      allowList:
      - type: ["L7"]
      denyList: []
    dynamic:
      enabled: false

operator:
  replicas: 2
  resources:
    requests:
      cpu: 100m
      memory: 128Mi

resources:
  requests:
    cpu: 200m
    memory: 512Mi
  limits:
    cpu: 4000m
    memory: 4Gi
```

```bash
# Install Cilium with Hubble
helm repo add cilium https://helm.cilium.io/
helm repo update

helm install cilium cilium/cilium \
  --version 1.16.0 \
  --namespace kube-system \
  --values cilium-values.yaml

# Verify installation
cilium status --wait
cilium hubble port-forward &
hubble status
```

## Hubble CLI Usage

### Installing the Hubble CLI

```bash
# Install hubble CLI
HUBBLE_VERSION=$(curl -s https://raw.githubusercontent.com/cilium/hubble/master/stable.txt)
curl -L --remote-name-all \
  https://github.com/cilium/hubble/releases/download/${HUBBLE_VERSION}/hubble-linux-amd64.tar.gz
tar xzf hubble-linux-amd64.tar.gz
sudo mv hubble /usr/local/bin/

# Enable port-forward to Hubble Relay
cilium hubble port-forward &
hubble status
```

### Observing Flows

```bash
# Watch all flows in real time
hubble observe --follow

# Filter by namespace
hubble observe --namespace production --follow

# Filter by specific pod
hubble observe --pod production/payments-6d4f9b8c7-x2k9m --follow

# Filter by service
hubble observe --service production/payments --follow

# Show only dropped flows
hubble observe --verdict DROPPED --follow

# Show only forwarded flows
hubble observe --verdict FORWARDED --follow

# Filter by protocol
hubble observe --protocol tcp --follow
hubble observe --protocol http --follow

# Filter by destination port
hubble observe --to-port 5432 --follow

# Show flows from a specific source to destination
hubble observe \
  --from-pod production/frontend \
  --to-pod production/backend \
  --follow

# Historical flows (last N flows)
hubble observe --last 1000

# JSON output for processing
hubble observe --output json --last 100 | jq '.flow | {
  time: .time,
  source: .source.pod_name,
  destination: .destination.pod_name,
  verdict: .verdict,
  protocol: .l4
}'
```

### L7 Protocol Visibility

```bash
# Observe HTTP flows with request details
hubble observe --protocol http --follow \
  --output json | jq 'select(.flow.l7.http) | {
    source: .flow.source.pod_name,
    dest: .flow.destination.pod_name,
    method: .flow.l7.http.method,
    url: .flow.l7.http.url,
    status: .flow.l7.http.code,
    latency: .flow.l7.http.headers
  }'

# Observe DNS queries
hubble observe --protocol dns --follow

# Filter DNS for specific queries
hubble observe --protocol dns --follow \
  --output json | jq 'select(.flow.l7.dns) | {
    pod: .flow.source.pod_name,
    query: .flow.l7.dns.query,
    response: .flow.l7.dns.rcode,
    ips: .flow.l7.dns.ips
  }'

# Observe gRPC flows
hubble observe --protocol grpc --follow

# Observe Kafka flows (requires Kafka parser enabled)
hubble observe --protocol kafka --follow
```

## Enabling L7 Visibility

By default, Cilium captures L3/L4 flows. L7 visibility requires explicit configuration.

### CiliumNetworkPolicy L7 Rules

L7 visibility is activated when a CiliumNetworkPolicy includes L7 rules:

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: payments-l7-visibility
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: payments
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
        - method: GET
          path: /payments/.*
        - method: POST
          path: /payments/process
  egress:
  - toEndpoints:
    - matchLabels:
        app: postgres
    toPorts:
    - ports:
      - port: "5432"
        protocol: TCP
      rules:
        # Enable DNS visibility for all egress
  - toEndpoints: []
    toPorts:
    - ports:
      - port: "53"
        protocol: UDP
      rules:
        dns:
        - matchPattern: "*.production.svc.cluster.local"
        - matchPattern: "*.amazonaws.com"
```

### Visibility Annotations (Non-Policy Method)

For visibility without policy enforcement:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: payments-pod
  namespace: production
  annotations:
    # Enable L7 visibility for ingress HTTP traffic
    policy.cilium.io/proxy-visibility: "<Ingress/8080/TCP/HTTP>"
spec:
  containers:
  - name: payments
    image: registry.company.com/payments:3.2.1
```

Or via namespace annotation:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: production
  annotations:
    policy.cilium.io/proxy-visibility: "<Ingress/8080/TCP/HTTP>,<Egress/53/UDP/DNS>"
```

### DNS Tracking Configuration

```yaml
# In Cilium ConfigMap or Helm values
dnsProxy:
  enableDnsCompression: true
  dnsMaxDeferredConnectionDeletes: 10000
  dnsFQDNRejectResponse: nameError
  dnsFQDNProxyResponseMaxDelay: 100ms
```

## Hubble UI and Service Map

### Accessing Hubble UI

```bash
# Port-forward to Hubble UI
kubectl port-forward -n kube-system svc/hubble-ui 12000:80 &

# Or expose via Ingress
kubectl apply -f - <<'EOF'
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: hubble-ui
  namespace: kube-system
  annotations:
    nginx.ingress.kubernetes.io/auth-type: basic
    nginx.ingress.kubernetes.io/auth-secret: hubble-ui-auth
    nginx.ingress.kubernetes.io/auth-realm: "Hubble Network Observability"
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - hubble.internal.company.com
    secretName: hubble-ui-tls
  rules:
  - host: hubble.internal.company.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: hubble-ui
            port:
              number: 80
EOF
```

### Service Map Namespace Filtering

The Hubble UI service map shows namespace-scoped traffic by default. For cross-namespace visibility, configure RBAC:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: hubble-ui-observer
rules:
- apiGroups:
  - networking.k8s.io
  resources:
  - networkpolicies
  verbs:
  - get
  - list
  - watch
- apiGroups:
  - ""
  resources:
  - componentstatuses
  - endpoints
  - namespaces
  - nodes
  - pods
  - services
  verbs:
  - get
  - list
  - watch
- apiGroups:
  - apiextensions.k8s.io
  resources:
  - customresourcedefinitions
  verbs:
  - get
  - list
  - watch
- apiGroups:
  - cilium.io
  resources:
  - "*"
  verbs:
  - get
  - list
  - watch
```

## Flow Export to External Systems

### Export to Kafka

```yaml
# Update Cilium Helm values
hubble:
  export:
    dynamic:
      enabled: true
      config:
        enabled: true
        createConfigMap: true
        content:
        - name: kafka-export
          fieldMask:
          - time
          - source
          - destination
          - verdict
          - l4
          - l7
          - traffic_direction
          allowList:
          - type: ["L7"]
          - verdict: ["DROPPED"]
          sinks:
          - type: Kafka
            kafka:
              brokers:
              - kafka.messaging.svc.cluster.local:9092
              topic: hubble-flows
              tls:
                enabled: false
```

### Export to Elasticsearch

Deploy a Hubble flow exporter:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hubble-exporter
  namespace: monitoring
spec:
  replicas: 2
  selector:
    matchLabels:
      app: hubble-exporter
  template:
    metadata:
      labels:
        app: hubble-exporter
    spec:
      containers:
      - name: hubble-exporter
        image: registry.company.com/hubble-exporter:1.2.0
        env:
        - name: HUBBLE_RELAY_ADDRESS
          value: hubble-relay.kube-system.svc.cluster.local:80
        - name: ELASTICSEARCH_URL
          value: https://elasticsearch.monitoring.svc.cluster.local:9200
        - name: ELASTICSEARCH_INDEX
          value: hubble-flows
        - name: FOLLOW_FLOWS
          value: "true"
        - name: NAMESPACE_FILTER
          value: production,staging
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 512Mi
```

### Custom Flow Export Script

For custom backends, use the hubble CLI with JSON output:

```bash
#!/bin/bash
# hubble-export-to-loki.sh
# Exports Hubble flows to Loki via the push API

LOKI_URL="http://loki.monitoring.svc.cluster.local:3100"
NAMESPACE=$1

hubble observe \
  --namespace "$NAMESPACE" \
  --output json \
  --follow 2>/dev/null | \
while IFS= read -r line; do
  TIMESTAMP=$(echo "$line" | python3 -c "
import json, sys
data = json.load(sys.stdin)
t = data.get('flow', {}).get('time', '')
# Convert to nanoseconds for Loki
import datetime
if t:
    dt = datetime.datetime.fromisoformat(t.replace('Z', '+00:00'))
    print(int(dt.timestamp() * 1e9))
else:
    import time
    print(int(time.time() * 1e9))
")

  PAYLOAD=$(python3 -c "
import json, sys
data = json.loads('$line')
flow = data.get('flow', {})
log_line = json.dumps({
    'verdict': flow.get('verdict', ''),
    'source': flow.get('source', {}).get('pod_name', ''),
    'dest': flow.get('destination', {}).get('pod_name', ''),
    'protocol': str(flow.get('l4', {})),
    'l7': str(flow.get('l7', {})),
})
print(json.dumps({
    'streams': [{
        'stream': {
            'job': 'hubble',
            'namespace': '$NAMESPACE'
        },
        'values': [['$TIMESTAMP', log_line]]
    }]
}))
")

  curl -s -X POST "$LOKI_URL/loki/api/v1/push" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" > /dev/null
done
```

## Hubble Metrics Integration

### Prometheus Metrics

Hubble exposes rich metrics through Cilium agents:

```yaml
# Verify metrics are enabled
kubectl exec -n kube-system ds/cilium -- \
  curl -s localhost:9965/metrics | grep hubble | head -30
```

Key Hubble metrics:

```promql
# Total flows by verdict
sum(rate(hubble_flows_processed_total[5m])) by (verdict)

# Drop reasons
sum(rate(hubble_drop_total[5m])) by (reason, namespace)

# HTTP request rate by service
sum(rate(hubble_http_requests_total[5m])) by (service, method, protocol)

# HTTP error rate
sum(rate(hubble_http_requests_total{status=~"5.."}[5m])) by (service)
/ sum(rate(hubble_http_requests_total[5m])) by (service)

# DNS query success rate
sum(rate(hubble_dns_queries_total{rcode="No Error"}[5m])) by (namespace)
/ sum(rate(hubble_dns_queries_total[5m])) by (namespace)

# TCP retransmissions
rate(hubble_tcp_flags_total{flags="SYN"}[5m])

# Dropped connections per namespace
sum(rate(hubble_drop_total[5m])) by (namespace) > 0
```

### ServiceMonitor Configuration

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: cilium-hubble
  namespace: monitoring
spec:
  selector:
    matchLabels:
      k8s-app: cilium
  namespaceSelector:
    matchNames:
    - kube-system
  endpoints:
  - port: hubble-metrics
    interval: 30s
    scrapeTimeout: 10s
    path: /metrics
    relabelings:
    - sourceLabels: [__meta_kubernetes_pod_node_name]
      targetLabel: node
    - sourceLabels: [__meta_kubernetes_pod_name]
      targetLabel: pod
```

## Custom Flow Policies

### Deny and Alert on Unexpected Traffic

```yaml
apiVersion: cilium.io/v2
kind: CiliumClusterwideNetworkPolicy
metadata:
  name: alert-on-direct-db-access
spec:
  endpointSelector:
    matchLabels:
      tier: database
  ingress:
  - fromEndpoints:
    - matchLabels:
        tier: application
  # Implicit deny of everything else will show in Hubble as DROPPED
  # with reason "Policy denied"
```

### Track Data Exfiltration Patterns

```bash
# Monitor large outbound data transfers
hubble observe \
  --output json \
  --follow \
  --verdict FORWARDED | \
  python3 -c "
import json, sys
threshold_bytes = 1048576  # 1MB
for line in sys.stdin:
    try:
        data = json.loads(line)
        flow = data.get('flow', {})
        traffic_dir = flow.get('traffic_direction', '')
        if traffic_dir == 'EGRESS':
            src = flow.get('source', {})
            dest = flow.get('destination', {})
            if src.get('namespace') in ['production', 'staging']:
                print(f'EGRESS: {src.get(\"pod_name\")} -> {dest.get(\"ip\", \"\")}: {dest.get(\"port\", \"\")}')
    except:
        pass
"
```

### Policy Compliance Monitoring

```bash
# Report on all policy denials per hour
hubble observe \
  --verdict DROPPED \
  --output json \
  --last 10000 | \
  python3 -c "
import json, sys
from collections import defaultdict
denials = defaultdict(int)
for line in sys.stdin:
    try:
        data = json.loads(line)
        flow = data.get('flow', {})
        if flow.get('verdict') == 'DROPPED':
            src_ns = flow.get('source', {}).get('namespace', 'unknown')
            dst_ns = flow.get('destination', {}).get('namespace', 'unknown')
            src_pod = flow.get('source', {}).get('pod_name', 'unknown')
            reason = flow.get('drop_reason_desc', 'unknown')
            denials[f'{src_ns}/{src_pod} -> {dst_ns}: {reason}'] += 1
    except:
        pass

for key, count in sorted(denials.items(), key=lambda x: -x[1])[:20]:
    print(f'{count:5d}  {key}')
"
```

## Advanced Hubble Configuration

### Multi-Cluster Hubble

For multi-cluster Cilium Cluster Mesh deployments:

```yaml
# Cluster 1 configuration
clustermesh:
  useAPIServer: true
  apiserver:
    replicas: 2
    resources:
      requests:
        cpu: 100m
        memory: 128Mi
  config:
    clusters:
    - name: cluster-west
      address: clustermesh-apiserver.kube-system.svc.cluster.local
      port: 2379
      ips:
      - 10.20.0.50
```

```bash
# Connect clusters to cluster mesh
cilium clustermesh enable --context kind-cluster-east
cilium clustermesh enable --context kind-cluster-west
cilium clustermesh connect \
  --context kind-cluster-east \
  --destination-context kind-cluster-west

# Verify cross-cluster connectivity
cilium clustermesh status

# Hubble observe now shows cross-cluster flows
hubble observe --cluster cluster-west --namespace production --follow
```

### Flow Ringbuffer Tuning

```yaml
# Increase the flow ringbuffer for higher-traffic environments
hubble:
  eventBufferCapacity: 65535
  eventQueueSize: 65535

# For very high traffic (1M+ flows/second per node)
hubble:
  eventBufferCapacity: 131072
  eventQueueSize: 131072
```

### Hubble TLS Configuration

```yaml
# Production TLS configuration for Hubble Relay
hubble:
  tls:
    enabled: true
    auto:
      enabled: true
      method: certmanager
      certManagerIssuerRef:
        group: cert-manager.io
        kind: ClusterIssuer
        name: internal-ca
  relay:
    tls:
      server:
        enabled: true
      client:
        enabled: true
```

## Production Alerting Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: hubble-network-alerts
  namespace: monitoring
spec:
  groups:
  - name: hubble.network
    rules:
    - alert: HighPacketDropRate
      expr: |
        sum(rate(hubble_drop_total[5m])) by (namespace) > 100
      for: 2m
      labels:
        severity: warning
      annotations:
        summary: "High packet drop rate in namespace {{ $labels.namespace }}"
        description: "{{ $value | humanize }} packets/s being dropped in {{ $labels.namespace }}"

    - alert: UnauthorizedAccessAttempts
      expr: |
        sum(rate(hubble_drop_total{reason="Policy denied"}[1m])) by (namespace) > 10
      for: 1m
      labels:
        severity: warning
      annotations:
        summary: "Policy violations detected in {{ $labels.namespace }}"
        description: "{{ $value | humanize }} policy-denied flows/s in {{ $labels.namespace }}"

    - alert: HTTP5xxErrorSpike
      expr: |
        sum(rate(hubble_http_requests_total{status=~"5.."}[5m])) by (service, namespace)
        / sum(rate(hubble_http_requests_total[5m])) by (service, namespace)
        > 0.05
      for: 2m
      labels:
        severity: critical
      annotations:
        summary: "HTTP 5xx error rate above 5% for {{ $labels.service }}"
        description: "Error rate: {{ $value | humanizePercentage }}"

    - alert: DNSResolutionFailures
      expr: |
        sum(rate(hubble_dns_queries_total{rcode!="No Error"}[5m])) by (namespace) > 10
      for: 2m
      labels:
        severity: warning
      annotations:
        summary: "DNS resolution failures in {{ $labels.namespace }}"
        description: "{{ $value | humanize }} DNS failures/s"

    - alert: HubbleRelayDown
      expr: |
        up{job="hubble-relay"} == 0
      for: 1m
      labels:
        severity: critical
      annotations:
        summary: "Hubble Relay is down"
        description: "Network observability is impaired"
```

## Grafana Dashboard Configuration

```bash
# Import Cilium/Hubble dashboards from Grafana catalog
# Dashboard IDs:
# 16611 - Cilium Agent Metrics
# 16612 - Cilium Operator Metrics
# 16613 - Hubble DNS
# 16614 - Hubble HTTP/HTTPS
# 16615 - Hubble Network Overview

# Or apply via ConfigMap
kubectl create configmap hubble-dashboards \
  --namespace monitoring \
  --from-file=hubble-network.json=dashboards/hubble-network.json \
  -o yaml --dry-run=client | \
  kubectl label --local -f - \
  grafana_dashboard=1 \
  -o yaml | kubectl apply -f -
```

### Key Dashboard Panels

```json
{
  "panels": [
    {
      "title": "Network Flow Rate by Namespace",
      "type": "timeseries",
      "targets": [
        {
          "expr": "sum(rate(hubble_flows_processed_total[5m])) by (namespace)",
          "legendFormat": "{{namespace}}"
        }
      ]
    },
    {
      "title": "Top Drop Reasons",
      "type": "bar",
      "targets": [
        {
          "expr": "topk(10, sum(rate(hubble_drop_total[5m])) by (reason))",
          "legendFormat": "{{reason}}"
        }
      ]
    },
    {
      "title": "Service HTTP Error Rate",
      "type": "table",
      "targets": [
        {
          "expr": "sum(rate(hubble_http_requests_total{status=~\"5..\"}[5m])) by (service) / sum(rate(hubble_http_requests_total[5m])) by (service)",
          "legendFormat": "{{service}}"
        }
      ]
    }
  ]
}
```

## Troubleshooting with Hubble

### Debugging Connection Issues

```bash
# Check why a specific connection is being dropped
hubble observe \
  --from-pod production/frontend \
  --to-pod production/payments \
  --verdict DROPPED \
  --output json | \
  jq '.flow | {
    source: .source.pod_name,
    dest: .destination.pod_name,
    reason: .drop_reason_desc,
    policy: .policy_match_direction
  }'

# Check if NetworkPolicy is causing drops
hubble observe \
  --namespace production \
  --verdict DROPPED \
  --output json | \
  jq 'select(.flow.drop_reason_desc == "Policy denied") | .flow | {
    src: .source.pod_name,
    src_labels: .source.labels,
    dst: .destination.pod_name,
    dst_labels: .destination.labels,
    dst_port: .l4.TCP.destination_port
  }'

# Verify DNS resolution is working
hubble observe \
  --protocol dns \
  --pod production/payments \
  --output json | \
  jq '.flow.l7.dns | {
    query: .query,
    response: .rcode,
    ips: .ips,
    ttl: .cname
  }'
```

### Identifying Noisy Pods

```bash
# Find the top talkers in a namespace
hubble observe \
  --namespace production \
  --output json \
  --last 50000 | \
  python3 -c "
import json, sys
from collections import Counter
sources = Counter()
for line in sys.stdin:
    try:
        data = json.loads(line)
        src = data.get('flow', {}).get('source', {}).get('pod_name', 'external')
        if src:
            sources[src] += 1
    except:
        pass
for pod, count in sources.most_common(10):
    print(f'{count:8d} {pod}')
"
```

### Debugging Service Mesh Issues

```bash
# If using Cilium with service mesh (without Istio)
# Check L7 proxy is active for a pod
kubectl exec -n kube-system ds/cilium -- \
  cilium-dbg endpoint list | grep -E "PROXY|L7"

# Verify L7 rules are being applied
kubectl exec -n kube-system ds/cilium -- \
  cilium-dbg policy selectors

# Check for L7 parse failures
hubble observe \
  --verdict DROPPED \
  --output json | \
  jq 'select(.flow.drop_reason_desc | test("Parse")) | .flow'
```

## Summary

Cilium Hubble provides unparalleled network visibility in Kubernetes through eBPF-based flow capture. The key operational capabilities covered in this guide are:

**Deployment**: Hubble is enabled via Helm values alongside Cilium. The relay aggregates per-node observers for cluster-wide queries. TLS should be enabled for production deployments.

**L7 visibility**: Requires either CiliumNetworkPolicy with L7 rules or visibility annotations. HTTP, DNS, gRPC, and Kafka flows expose request-level detail including methods, paths, status codes, and query details.

**Flow export**: Static file export and dynamic Kafka/Elasticsearch export enable integration with SIEM systems and long-term storage. The hubble CLI with JSON output enables custom export pipelines.

**Metrics integration**: Hubble's Prometheus metrics provide pre-aggregated flow statistics, HTTP error rates, DNS success rates, and drop reason breakdowns for alerting and dashboards.

**Troubleshooting**: The `hubble observe` command is the primary tool for diagnosing connectivity issues, policy violations, and unexpected traffic patterns. JSON output enables powerful filter pipelines.

Hubble replaces the need for network-level packet capture in most troubleshooting scenarios, providing structured, queryable flow data at kernel speed with zero application instrumentation required.
