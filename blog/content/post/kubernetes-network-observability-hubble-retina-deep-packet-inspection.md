---
title: "Kubernetes Network Observability: Hubble, Retina, and Deep Packet Inspection at Scale"
date: 2030-01-13T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Hubble", "Cilium", "Retina", "Network Observability", "eBPF", "Network Policy"]
categories: ["Kubernetes", "Observability", "Networking"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Network observability with Cilium Hubble, Microsoft Retina, flow monitoring, L7 visibility, network policy debugging, and distributed packet capture at scale in Kubernetes environments."
more_link: "yes"
url: "/kubernetes-network-observability-hubble-retina-deep-packet-inspection/"
---

Kubernetes network visibility has historically been a black box. Traffic flows between pods through virtual interfaces and overlay networks, making it extremely difficult to answer simple questions like "why did this connection time out?" or "which services are talking to each other?" Traditional tools like tcpdump capture traffic at the node level but cannot associate packets with Kubernetes constructs like pods, namespaces, or services.

Hubble (part of the Cilium project) and Microsoft Retina solve this by using eBPF to intercept network flows at the kernel level and correlate them with Kubernetes metadata. The result is network observability that understands your workloads: you can see flows by pod name, namespace, service, and even HTTP method and URL.

<!--more-->

# Kubernetes Network Observability: Hubble, Retina, and Deep Packet Inspection at Scale

## The Network Observability Problem

Consider a scenario where your checkout service occasionally times out. Without proper network observability, debugging requires:

1. Finding which pod is failing
2. SSH-ing to the node
3. Identifying the correct network namespace
4. Running tcpdump with the right filters
5. Correlating raw IP addresses with Kubernetes service names

This process takes 30-60 minutes for experienced operators. With Hubble or Retina, you can answer "what is the error rate between checkout and payment-service in the last 5 minutes?" in 30 seconds from a single command.

## Part 1: Cilium Hubble

Hubble is the observability layer of Cilium. It operates by processing the same eBPF events that Cilium uses for policy enforcement, providing a zero-overhead way to observe network flows.

### Installing Cilium with Hubble

```bash
# Install Cilium with Hubble and Hubble UI
helm repo add cilium https://helm.cilium.io/
helm repo update

helm install cilium cilium/cilium \
    --namespace kube-system \
    --version 1.15.3 \
    --set hubble.enabled=true \
    --set hubble.relay.enabled=true \
    --set hubble.ui.enabled=true \
    --set hubble.ui.service.type=ClusterIP \
    --set hubble.metrics.enableOpenMetrics=true \
    --set hubble.metrics.enabled="{dns,drop,tcp,flow,icmp,http}" \
    --set hubble.export.static.enabled=true \
    --set hubble.export.static.filePath=/var/run/cilium/hubble/events.log \
    --set prometheus.enabled=true \
    --set operator.prometheus.enabled=true \
    --set bpf.masquerade=true \
    --set ipam.mode=kubernetes \
    --wait

# Verify Cilium and Hubble are running
cilium status --wait
kubectl get pods -n kube-system -l k8s-app=cilium

# Check Hubble relay
kubectl get pods -n kube-system -l k8s-app=hubble-relay
```

### Installing the Hubble CLI

```bash
# Install hubble CLI
HUBBLE_VERSION=$(curl -s https://raw.githubusercontent.com/cilium/hubble/master/stable.txt)
curl -L --remote-name-all \
    "https://github.com/cilium/hubble/releases/download/$HUBBLE_VERSION/hubble-linux-amd64.tar.gz"
tar xzvf hubble-linux-amd64.tar.gz
mv hubble /usr/local/bin/

# Port-forward to Hubble relay
kubectl port-forward -n kube-system svc/hubble-relay 4245:80 &

# Configure hubble CLI
hubble config set server localhost:4245

# Test connectivity
hubble status
# Should show: Healthcheck (via localhost:4245): Ok
```

### Basic Flow Observation

```bash
# Observe all flows in real-time
hubble observe --follow

# Filter by namespace
hubble observe --namespace production --follow

# Filter by specific pod
hubble observe --from-pod production/checkout-7f9b4d6b5-xk2mj --follow

# Filter to a specific destination service
hubble observe --to-service payment-service --namespace production

# Show only dropped flows (policy violations)
hubble observe --verdict DROPPED --follow

# Show L7 HTTP flows
hubble observe --type l7 --protocol http --follow

# Filter by HTTP status codes
hubble observe --type l7 --http-status-code 5.. --follow

# Show DNS flows
hubble observe --type l7 --protocol dns --follow

# Show flows with specific label
hubble observe --from-label app=checkout --follow
```

### Advanced Flow Queries

```bash
# Find all services that checkout communicates with
hubble observe \
    --from-label app=checkout \
    --last 10000 \
    | awk '{print $9}' | sort | uniq -c | sort -rn

# Check error rate between two services
hubble observe \
    --from-pod production/checkout \
    --to-service payment-service \
    --verdict DROPPED \
    --last 1000 | wc -l

# Find network policy violations in the last hour
hubble observe \
    --verdict DROPPED \
    --verdict AUDIT \
    --since 1h \
    | grep "Policy"

# JSON output for programmatic processing
hubble observe \
    --namespace production \
    --type l7 \
    --last 100 \
    -o json | jq -r '
    select(.l7 != null) |
    "\(.source.pod_name) -> \(.destination.pod_name): \(.l7.http.method) \(.l7.http.url) (\(.l7.http.code))"
    '

# Trace a specific connection (source + destination)
hubble observe \
    --from-pod production/checkout-7f9b4d6b5-xk2mj \
    --to-pod production/payment-service-5b6d8f9b7-m4n3p \
    --follow
```

### Hubble Metrics and Prometheus Integration

Hubble exports Prometheus metrics for each flow category:

```bash
# Check available Hubble metrics
kubectl port-forward -n kube-system svc/hubble-metrics 9091:9091 &
curl http://localhost:9091/metrics | grep "^# HELP"

# Key metrics:
# hubble_flows_processed_total - Total flows processed by verdict
# hubble_drop_total - Dropped packets by reason
# hubble_http_requests_total - HTTP requests with method, status, service
# hubble_http_request_duration_seconds - HTTP latency histograms
# hubble_dns_queries_total - DNS query counts
```

Configure Prometheus scraping:

```yaml
# prometheusrule-hubble.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: hubble-metrics
  namespace: monitoring
spec:
  selector:
    matchLabels:
      k8s-app: hubble
  namespaceSelector:
    matchNames:
      - kube-system
  endpoints:
    - port: hubble-metrics
      interval: 15s
      path: /metrics
---
# Grafana Dashboard ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: hubble-network-dashboard
  namespace: monitoring
  labels:
    grafana_dashboard: "1"
data:
  hubble-overview.json: |
    {
      "title": "Hubble Network Flows",
      "uid": "hubble-flows",
      "panels": [
        {
          "title": "HTTP Request Rate by Service",
          "type": "timeseries",
          "targets": [
            {
              "expr": "sum(rate(hubble_http_requests_total[5m])) by (destination)",
              "legendFormat": "{{destination}}"
            }
          ]
        },
        {
          "title": "Network Policy Drops",
          "type": "timeseries",
          "targets": [
            {
              "expr": "sum(rate(hubble_drop_total[5m])) by (reason, namespace)",
              "legendFormat": "{{namespace}}/{{reason}}"
            }
          ]
        },
        {
          "title": "HTTP Error Rate by Service",
          "type": "timeseries",
          "targets": [
            {
              "expr": "sum(rate(hubble_http_requests_total{status_code=~\"5..\"}[5m])) by (destination) / sum(rate(hubble_http_requests_total[5m])) by (destination)",
              "legendFormat": "{{destination}}"
            }
          ]
        }
      ]
    }
```

### Hubble Network Policy Debugging

```bash
# Debug network policy enforcement
# Scenario: checkout cannot reach payment-service

# Step 1: Check if traffic is being dropped
hubble observe \
    --from-label app=checkout \
    --to-label app=payment-service \
    --verdict DROPPED \
    --last 100

# Step 2: Check what network policies exist
kubectl get networkpolicies -n production
kubectl get ciliumnetworkpolicies -n production

# Step 3: Check specific policy verdicts
hubble observe \
    --from-pod production/checkout-7f9b4d6b5-xk2mj \
    --to-pod production/payment-service-5b6d8f9b7-m4n3p \
    -o json | jq '.drop_reason_desc'

# Step 4: Check Cilium endpoint identity
cilium endpoint list | grep checkout
cilium endpoint get <endpoint-id>  # Shows policy enforcement status

# Step 5: Test policy with Cilium connectivity test
cilium connectivity test \
    --include-conn-disrupt-test \
    --namespace production
```

## Part 2: Microsoft Retina

Retina is an open-source Kubernetes network observability platform from Microsoft. It complements Hubble by focusing on metrics-based observability and multi-CNI support (it works with any CNI, not just Cilium).

### Installing Retina

```bash
# Add Retina Helm repository
helm repo add retina https://retina.sh
helm repo update

# Install Retina
helm install retina retina/retina \
    --namespace kube-system \
    --version v0.0.10 \
    --set image.tag=v0.0.10 \
    --set operator.tag=v0.0.10 \
    --set logLevel=info \
    --set os.windows=false \
    --set operator.enabled=true \
    --set enabledPlugin_linux="\[dropreason\,packetforward\,linuxutil\,dns\]" \
    --set enablePodLevel=true \
    --set enableAnnotations=true \
    --wait

# Verify Retina DaemonSet
kubectl get pods -n kube-system -l app=retina
```

### Retina Metric Plugins

Retina is plugin-based, with each plugin providing a different set of metrics:

```yaml
# retina-configmap.yaml
# Configure which metrics plugins to enable
apiVersion: v1
kind: ConfigMap
metadata:
  name: retina-config
  namespace: kube-system
data:
  config.yaml: |
    apiServer:
      host: "0.0.0.0"
      port: 10093
    logLevel: info
    enabledPlugin:
      - dropreason      # Packet drop reasons with source/destination
      - packetforward   # Forwarded packet counts
      - linuxutil       # TCP stats (retransmits, connection states)
      - dns             # DNS query/response metrics
      - packetparser    # Deep packet inspection (L3-L7)
    enablePodLevel: true
    bypassLookupIPOfInterest: true
    enableAnnotations: true
    dataAggregationLevel: pod  # or: node, namespace

    # DNS metrics configuration
    dnsCacheSizeCnt: 1000

    # Packet parser configuration (for L7 visibility)
    enableHTTP: true
    enableHTTPS: false  # Requires TLS termination or mTLS intercept

    # Metric labels to include
    includeLabels:
      - app
      - version
      - team
```

### Retina Metrics

```bash
# Check Retina metrics endpoint
kubectl port-forward -n kube-system svc/retina-agent 10093:10093 &
curl http://localhost:10093/metrics | grep "^# HELP"

# Key Retina metrics:
# networkobservability_forward_bytes_total - Forwarded bytes
# networkobservability_forward_count_total - Forwarded packet count
# networkobservability_drop_bytes_total - Dropped bytes with reason
# networkobservability_drop_count_total - Dropped packets with reason
# networkobservability_tcp_state - TCP connection state counts
# networkobservability_tcp_connection_remote_count - Remote TCP connections
# networkobservability_dns_request_count_total - DNS requests
# networkobservability_dns_response_count_total - DNS responses with RCODE

# Example queries
curl -s http://localhost:10093/metrics | \
    grep "networkobservability_drop" | head -20
```

### Retina Capture (Distributed Packet Capture)

Retina's Capture feature enables distributed packet capture across multiple pods simultaneously, captured to a centralized location:

```yaml
# retina-capture.yaml
apiVersion: retina.sh/v1alpha1
kind: Capture
metadata:
  name: capture-checkout-errors
  namespace: production
spec:
  captureConfiguration:
    captureOption:
      duration: 30s
      maxCaptureSize: 100           # MB per node
      packetSize: 96                # Snap length in bytes
    captureTarget:
      podSelector:
        matchLabels:
          app: checkout
      namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: production
    filters:
      include:
        - "tcp port 8080 and (tcp[tcpflags] & tcp-rst != 0)"  # TCP resets
        - "tcp port 8080 and (tcp[tcpflags] & tcp-fin != 0)"  # TCP fins
  outputConfiguration:
    blobUpload: ""       # Azure Blob Storage URI (optional)
    hostPath:
      nodePath: /tmp/retina-captures
    nodeSelector: {}
    pvc:
      claimName: retina-captures-pvc
```

```bash
# Apply capture
kubectl apply -f retina-capture.yaml

# Monitor capture progress
kubectl get captures -n production -w

# Check capture status
kubectl describe capture capture-checkout-errors -n production

# List captured files
kubectl exec -n production -it $(kubectl get pods -n production -l app=retina \
    -o jsonpath='{.items[0].metadata.name}') -- \
    ls /tmp/retina-captures/

# Copy capture to local machine
kubectl cp production/retina-agent-xxx:/tmp/retina-captures/capture.pcap \
    ./capture.pcap

# Analyze with Wireshark or tcpdump
tcpdump -r capture.pcap -n
wireshark capture.pcap &
```

### Retina Dashboard in Grafana

```bash
# Import Retina Grafana dashboards
kubectl apply -f https://raw.githubusercontent.com/microsoft/retina/main/deploy/grafana/dashboards/

# Or manually import dashboard IDs:
# Retina Overview: grafana.com/grafana/dashboards/18814
# Retina Node: grafana.com/grafana/dashboards/18815
# Retina Pod: grafana.com/grafana/dashboards/18816
```

## Part 3: L7 Visibility and HTTP Observability

### Enabling Cilium L7 Visibility Policies

```yaml
# cilium-l7-visibility.yaml
# This enables L7 inspection for specific workloads
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: checkout-l7-visibility
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: checkout
  ingress:
    - fromEndpoints:
        - matchLabels:
            k8s:app: api-gateway
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP
          rules:
            http:
              - method: ".*"  # Match all HTTP methods
                # Can restrict to specific paths:
                # path: "^/api/v1/.*"
  egress:
    - toEndpoints:
        - matchLabels:
            app: payment-service
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP
          rules:
            http:
              - method: "POST"
                path: "^/v1/payments.*"
```

After applying L7 policies, Hubble flows include HTTP details:

```bash
# Now flows show HTTP metadata
hubble observe \
    --from-label app=checkout \
    --to-label app=payment-service \
    --type l7 \
    -o json | jq -r '
    "\(.source.pod_name) -> \(.destination.pod_name):
     Method: \(.l7.http.method)
     URL: \(.l7.http.url)
     Status: \(.l7.http.code)
     Duration: \(.l7.http.summary)"
    '
```

### gRPC L7 Visibility

```yaml
# cilium-grpc-visibility.yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: grpc-visibility
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      protocol: grpc
  egress:
    - toEndpoints:
        - {}
      toPorts:
        - ports:
            - port: "50051"
              protocol: TCP
          rules:
            # gRPC uses HTTP/2 under the hood
            # Cilium can parse gRPC method names
            http:
              - method: POST
```

## Part 4: Network Policy Debugging at Scale

### Systematic Policy Debugging Workflow

```bash
#!/bin/bash
# debug-network-policy.sh - Systematically debug network connectivity issues

SOURCE_POD="${1:-}"
DEST_SERVICE="${2:-}"
NAMESPACE="${3:-production}"

if [[ -z "$SOURCE_POD" || -z "$DEST_SERVICE" ]]; then
    echo "Usage: $0 <source-pod> <destination-service> [namespace]"
    echo "Example: $0 checkout-7f9b4d6b5-xk2mj payment-service production"
    exit 1
fi

echo "=== Network Policy Debug: $SOURCE_POD → $DEST_SERVICE ==="
echo ""

# Step 1: Check if pods can resolve DNS
echo "--- Step 1: DNS Resolution ---"
kubectl exec -n "$NAMESPACE" "$SOURCE_POD" -- \
    nslookup "$DEST_SERVICE.$NAMESPACE.svc.cluster.local" 2>/dev/null | \
    grep -E "Address:|^Name:"

# Step 2: Check TCP connectivity
echo "--- Step 2: TCP Connectivity ---"
DEST_IP=$(kubectl get svc "$DEST_SERVICE" -n "$NAMESPACE" \
    -o jsonpath='{.spec.clusterIP}')
DEST_PORT=$(kubectl get svc "$DEST_SERVICE" -n "$NAMESPACE" \
    -o jsonpath='{.spec.ports[0].port}')
echo "Destination: $DEST_IP:$DEST_PORT"

kubectl exec -n "$NAMESPACE" "$SOURCE_POD" -- \
    nc -zv -w3 "$DEST_IP" "$DEST_PORT" 2>&1

# Step 3: Check Hubble for dropped flows
echo "--- Step 3: Hubble Dropped Flows (last 5 minutes) ---"
hubble observe \
    --from-pod "$NAMESPACE/$SOURCE_POD" \
    --verdict DROPPED \
    --since 5m \
    --last 100

# Step 4: Check existing network policies
echo "--- Step 4: Network Policies in $NAMESPACE ---"
kubectl get networkpolicies,ciliumnetworkpolicies -n "$NAMESPACE"

# Step 5: Check Cilium endpoint status
echo "--- Step 5: Cilium Endpoint Status ---"
SOURCE_POD_IP=$(kubectl get pod -n "$NAMESPACE" "$SOURCE_POD" \
    -o jsonpath='{.status.podIP}')
cilium endpoint list | grep "$SOURCE_POD_IP"

# Step 6: Generate policy verdict using Cilium's policy check
echo "--- Step 6: Cilium Policy Verdict ---"
SOURCE_IDENTITY=$(cilium endpoint list | grep "$SOURCE_POD_IP" | \
    awk '{print $3}')
DEST_IDENTITY=$(kubectl get svc "$DEST_SERVICE" -n "$NAMESPACE" \
    -o jsonpath='{.metadata.labels.app}')

echo "Source identity: $SOURCE_IDENTITY"
echo "Run: cilium policy verdict --src-identity $SOURCE_IDENTITY --dst <identity>"
```

### Hubble Flow Export for Security Analysis

```yaml
# hubble-flow-export.yaml
# Export all flows to a SIEM or log aggregation system
apiVersion: v1
kind: ConfigMap
metadata:
  name: hubble-flow-export-config
  namespace: kube-system
data:
  config.yaml: |
    exporters:
      - name: kafka-exporter
        type: kafka
        config:
          brokers:
            - kafka.monitoring.svc.cluster.local:9092
          topic: kubernetes-network-flows
          batching:
            maxItems: 1000
            timeout: 5s
          filters:
            - verdict:
                - DROPPED
                - AUDIT
            # Also export L7 HTTP flows for API monitoring
            - l7: {}
      - name: s3-exporter
        type: s3
        config:
          bucket: network-flow-logs
          prefix: kubernetes/flows/
          region: us-east-1
          rotateInterval: 1h
```

## Part 5: Advanced Observability Patterns

### Service Map Generation

```bash
# Generate a service dependency map from Hubble flows
hubble observe \
    --namespace production \
    --type l7 \
    --last 50000 \
    -o json | \
jq -r '
    select(.source.namespace != null and .destination.namespace != null) |
    "\(.source.labels["k8s:app"]// .source.pod_name) -> \(.destination.labels["k8s:app"] // .destination.pod_name)"
    ' | \
sort | uniq -c | sort -rn | head -50

# Generate DOT format for Graphviz
hubble observe \
    --namespace production \
    --last 10000 \
    -o json | \
jq -r '
    select(.source.namespace == "production" and .destination.namespace == "production") |
    "  \"" + (.source.labels["k8s:app"] // "unknown") + "\" -> \"" +
    (.destination.labels["k8s:app"] // "unknown") + "\""
    ' | \
sort | uniq | \
awk 'BEGIN{print "digraph services {"} {print} END{print "}"}' > services.dot

dot -Tsvg services.dot > services.svg
```

### Anomaly Detection with Hubble Metrics

```yaml
# anomaly-detection-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: network-anomaly-detection
  namespace: monitoring
spec:
  groups:
    - name: network-anomalies
      rules:
        # Sudden spike in dropped packets
        - alert: NetworkPolicyViolationSpike
          expr: |
            sum(rate(hubble_drop_total[5m])) by (namespace)
            >
            2 * sum(rate(hubble_drop_total[1h])) by (namespace)
          for: 2m
          labels:
            severity: warning
          annotations:
            summary: "Network policy violations spiking in {{ $labels.namespace }}"
            description: "Drop rate is 2x higher than 1-hour baseline"

        # Unusual new connection patterns
        - alert: UnexpectedServiceCommunication
          expr: |
            increase(hubble_flows_processed_total{
              verdict="FORWARDED",
              direction="INGRESS"
            }[5m]) > 0
            unless on(source, destination)
            (hubble_flows_processed_total offset 1h > 0)
          for: 5m
          labels:
            severity: info
          annotations:
            summary: "New service communication detected"

        # High DNS failure rate
        - alert: DNSResolutionFailures
          expr: |
            sum(rate(hubble_dns_queries_total{rcode!="NOERROR"}[5m])) by (namespace) > 0.1
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High DNS failure rate in {{ $labels.namespace }}"

        # TCP reset spike (connection failures)
        - alert: TCPResetSpike
          expr: |
            rate(networkobservability_tcp_state{state="CLOSE_WAIT"}[5m])
            > rate(networkobservability_tcp_state{state="ESTABLISHED"}[5m]) * 0.1
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High TCP CLOSE_WAIT rate - possible connection handling issue"
```

### Compliance Audit with Flow Logs

```bash
#!/bin/bash
# compliance-network-audit.sh - Generate compliance evidence from network flows

NAMESPACE="${1:-production}"
START_DATE="${2:-$(date -d '30 days ago' -Idate)}"
END_DATE="${3:-$(date -Idate)}"
REPORT_FILE="network-audit-$START_DATE-to-$END_DATE.txt"

echo "=== Network Compliance Audit Report ===" > "$REPORT_FILE"
echo "Namespace: $NAMESPACE" >> "$REPORT_FILE"
echo "Period: $START_DATE to $END_DATE" >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"

echo "--- Services with Egress to Internet ---" >> "$REPORT_FILE"
hubble observe \
    --namespace "$NAMESPACE" \
    --verdict FORWARDED \
    -o json | \
jq -r 'select(.destination.namespace == "world") |
    "\(.source.pod_name) -> \(.destination_ip) (port \(.destination.port))"
    ' | sort | uniq >> "$REPORT_FILE"

echo "" >> "$REPORT_FILE"
echo "--- Network Policy Violations (Dropped Flows) ---" >> "$REPORT_FILE"
hubble observe \
    --namespace "$NAMESPACE" \
    --verdict DROPPED \
    -o json | \
jq -r '"\(.source.pod_name) -> \(.destination.pod_name // .destination_ip): \(.drop_reason_desc)"
    ' | sort | uniq -c | sort -rn >> "$REPORT_FILE"

echo "" >> "$REPORT_FILE"
echo "--- Services Exposing Unencrypted HTTP (Port 80) ---" >> "$REPORT_FILE"
hubble observe \
    --namespace "$NAMESPACE" \
    --type l7 \
    -o json | \
jq -r 'select(.l7 != null and (.destination.port == 80)) |
    "\(.source.pod_name) -> \(.destination.pod_name):80 (HTTP)"
    ' | sort | uniq >> "$REPORT_FILE"

cat "$REPORT_FILE"
```

## Part 6: Scaling Observability

### Hubble Multi-Cluster Federation

For multi-cluster deployments, Hubble can federate flows across clusters:

```yaml
# hubble-relay-multi-cluster.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: hubble-relay-config
  namespace: kube-system
data:
  config.yaml: |
    cluster-name: production-us-east
    peer-service: hubble-peer.kube-system.svc.cluster.local:443

    # TLS for peer communication
    tls:
      server:
        cert-file: /var/lib/hubble-relay/tls/server.crt
        key-file: /var/lib/hubble-relay/tls/server.key
      client:
        cert-file: /var/lib/hubble-relay/tls/client.crt
        key-file: /var/lib/hubble-relay/tls/client.key
        server-name: hubble-peer.kube-system.svc.cluster.local

    # Configure gRPC dial timeout for slow inter-cluster links
    dial-timeout: 5s
    retry-timeout: 30s

    # Sort buffer for cross-cluster flow ordering
    sort-buffer-len-max: 100
    sort-buffer-drain-timeout: 1s
```

### Flow Retention and Storage

```yaml
# hubble-timescape - Long-term flow storage
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hubble-timescape
  namespace: monitoring
spec:
  replicas: 1
  selector:
    matchLabels:
      app: hubble-timescape
  template:
    metadata:
      labels:
        app: hubble-timescape
    spec:
      containers:
        - name: timescape
          image: quay.io/cilium/hubble-timescape:v0.2.0
          args:
            - --hubble-addr=hubble-relay.kube-system.svc.cluster.local:80
            - --store-path=/var/lib/timescape
            - --retention=30d
          volumeMounts:
            - name: data
              mountPath: /var/lib/timescape
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: hubble-timescape-data
```

## Key Takeaways

Network observability in Kubernetes has matured from "run tcpdump on the node and hope" to structured, queryable flow data correlated with Kubernetes metadata.

**Hubble provides the deepest observability for Cilium deployments**: the integration between Cilium's eBPF data plane and Hubble's observability layer means you get L7 visibility (HTTP method, URL, status code) with zero application changes. The combination of network policy enforcement and observability in a single tool is powerful.

**Retina provides vendor-neutral metrics**: if you are not running Cilium or need observability that works across CNI plugins, Retina's plugin-based approach provides consistent metrics regardless of your CNI choice. Its distributed capture feature (taking packet captures across all pods matching a selector simultaneously) has no equivalent in Hubble.

**Service maps emerge from flow data**: by aggregating Hubble flows, you can automatically generate accurate service dependency graphs. These maps are more accurate than manually maintained documentation because they reflect actual traffic, not intended architecture.

**Network observability enables security use cases**: the same flow data that helps debug connectivity issues also provides evidence for compliance audits, anomaly detection, and forensic investigation. This dual-use justifies the operational overhead of running the observability stack.

**Start with metrics before capturing packets**: Hubble metrics (available via Prometheus) answer "is there a problem?" questions at low cost. Use packet capture (Retina Capture) only when you need to understand the specific bytes in a problematic connection. This staged approach avoids storage costs from capturing all traffic.
