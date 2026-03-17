---
title: "Kubernetes Monitoring with Pixie: eBPF-Based No-Instrumentation Observability"
date: 2030-10-12T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Pixie", "eBPF", "Observability", "Monitoring", "OpenTelemetry", "Grafana"]
categories:
- Kubernetes
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Pixie auto-telemetry with eBPF: PxL scripting, service map generation, SQL query tracing, HTTP/gRPC latency analysis, and Grafana/OpenTelemetry integration."
more_link: "yes"
url: "/kubernetes-monitoring-pixie-ebpf-no-instrumentation-observability/"
---

Pixie brings a fundamentally different approach to Kubernetes observability by using eBPF kernel probes to capture telemetry data without modifying application code, injecting sidecar containers, or configuring language-specific agents. For platform teams supporting dozens of development squads, this means achieving production-grade observability across polyglot microservice fleets in minutes rather than weeks.

<!--more-->

## Architecture Overview

Pixie's architecture consists of three primary components deployed inside the monitored cluster alongside a control plane hosted by New Relic (or optionally self-hosted via the Pixie OSS distribution).

### Vizier: In-Cluster Data Plane

The Vizier is the in-cluster agent responsible for eBPF probe management, data collection, and query execution. It runs as a DaemonSet on every node, attaching kernel-level probes that intercept system calls and network events without requiring application changes.

```
┌─────────────────────────────────────────────────┐
│                 Kubernetes Node                  │
│  ┌──────────────────────────────────────────┐   │
│  │            Vizier PEM (DaemonSet)         │   │
│  │  ┌─────────────┐  ┌──────────────────┐   │   │
│  │  │  eBPF Probes │  │  Data Collectors  │   │   │
│  │  │  - kprobes   │  │  - HTTP/gRPC      │   │   │
│  │  │  - uprobes   │  │  - DNS           │   │   │
│  │  │  - tracepoints│  │  - MySQL/Postgres │   │   │
│  │  └─────────────┘  └──────────────────┘   │   │
│  └──────────────────────────────────────────┘   │
│                                                  │
│  ┌──────────────────────────────────────────┐   │
│  │     Application Pods (unmodified)         │   │
│  │  pod-a  pod-b  pod-c  pod-d               │   │
│  └──────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

### Control Plane Components

The Vizier communicates with three control plane services:

- **Pixie Cloud / Self-hosted Cloud**: Stores metadata, manages scripts, handles authentication
- **Kelvin**: Aggregates data from multiple PEM instances within a cluster
- **Query Broker**: Routes PxL queries to the appropriate Vizier

## Installation

### Prerequisites

Pixie requires kernel version 4.14 or later and a cluster with at least 1 GB of memory per node allocated for the DaemonSet. Verify kernel compatibility before proceeding.

```bash
# Check kernel version on each node
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.nodeInfo.kernelVersion}{"\n"}{end}'

# Verify eBPF support
kubectl debug node/worker-1 -it --image=ubuntu -- bash -c "cat /proc/config.gz | gunzip | grep CONFIG_BPF"
```

### Deploying Pixie with Helm

```bash
# Add the Pixie Helm repository
helm repo add pixie https://pixie-operator-charts.storage.googleapis.com
helm repo update

# Create the namespace
kubectl create namespace pl

# Deploy Pixie operator
helm install pixie-operator pixie/pixie-operator-chart \
  --namespace pl \
  --set deployKey=<pixie-deploy-key> \
  --set clusterName=production-us-east-1

# Deploy Vizier
cat <<EOF | kubectl apply -f -
apiVersion: px.dev/v1alpha1
kind: Vizier
metadata:
  name: vizier
  namespace: pl
spec:
  cloudAddr: withpixie.ai:443
  clusterName: production-us-east-1
  deployKey:
    name: deploy-key
  pemMemoryLimit: "2Gi"
  pemMemoryRequest: "1Gi"
  dataAccess: Full
  useEtcdOperator: false
  patches:
    vizier-pem:
      spec:
        tolerations:
        - key: node-role.kubernetes.io/master
          operator: Exists
          effect: NoSchedule
        - key: dedicated
          operator: Equal
          value: monitoring
          effect: NoSchedule
EOF
```

### Self-Hosted Pixie Cloud Installation

For air-gapped or compliance-sensitive environments, deploy the Pixie Cloud components within the cluster:

```bash
# Clone the Pixie OSS repository
git clone https://github.com/pixie-io/pixie.git
cd pixie

# Deploy self-hosted cloud
helm install pixie-cloud pixie/pixie-cloud-chart \
  --namespace plc \
  --create-namespace \
  --set global.cloudAddr=pixie.internal.company.com:443 \
  --set tls.enabled=true \
  --set tls.secretName=pixie-cloud-tls

# Connect the Vizier to the self-hosted cloud
helm install pixie-operator pixie/pixie-operator-chart \
  --namespace pl \
  --create-namespace \
  --set cloudAddr=pixie.internal.company.com:443 \
  --set deployKey=<pixie-deploy-key>
```

## PxL Scripting Language

PxL (Pixie Language) is a Python-like DSL built on top of a dataframe API. All Pixie queries are written in PxL and executed against live in-cluster data.

### Basic HTTP Latency Query

```python
# http_latency_by_service.pxl
import px

def http_latency_by_service(start_time: str, percentile: float):
    """
    Compute HTTP request latency percentiles grouped by service.
    """
    df = px.DataFrame(
        table='http_events',
        start_time=start_time
    )

    # Filter out health check endpoints
    df = df[df.req_path != '/healthz']
    df = df[df.req_path != '/readyz']
    df = df[df.req_path != '/metrics']

    # Annotate with Kubernetes metadata
    df.service = df.ctx['service']
    df.namespace = df.ctx['namespace']
    df.node = df.ctx['node']

    # Compute latency statistics
    df = df.groupby(['service', 'namespace']).agg(
        latency_p50=('latency', px.quantiles(0.5)),
        latency_p95=('latency', px.quantiles(0.95)),
        latency_p99=('latency', px.quantiles(0.99)),
        throughput=('latency', px.count),
        error_count=('resp_status', lambda s: px.sum((s >= 500).astype(int)))
    )

    df.error_rate = df.error_count / df.throughput
    df.throughput_per_sec = df.throughput / px.parse_duration(start_time)

    return df

px.display(
    http_latency_by_service('-15m', 0.99),
    'HTTP Latency by Service'
)
```

### SQL Query Analysis Script

```python
# sql_query_analysis.pxl
import px

def analyze_sql_queries(start_time: str, db_addr: str):
    """
    Trace and analyze SQL queries hitting a specific database endpoint.
    """
    df = px.DataFrame(
        table='mysql_events',
        start_time=start_time
    )

    # Filter to the target database
    df = df[df.remote_addr == db_addr]

    # Annotate source service
    df.source_service = df.ctx['service']
    df.source_pod = df.ctx['pod']

    # Classify query types
    df.query_type = px.substring(df.req_body, 0, 6)

    # Aggregate by normalized query prefix (first 100 chars)
    df.query_prefix = px.substring(df.req_body, 0, 100)

    df = df.groupby(['source_service', 'query_type', 'query_prefix']).agg(
        call_count=('latency', px.count),
        p50_latency_ms=('latency', px.quantiles(0.5)),
        p99_latency_ms=('latency', px.quantiles(0.99)),
        max_latency_ms=('latency', px.max),
        total_bytes_recv=('resp_body_size', px.sum),
        error_count=('resp_status', lambda s: px.sum((s != 0).astype(int)))
    )

    # Flag slow queries (P99 > 100ms)
    df.slow_query = df.p99_latency_ms > 100000  # nanoseconds

    df = df[df.call_count > 10]  # Filter noise
    df = df.sort('p99_latency_ms', ascending=False)

    return df

px.display(
    analyze_sql_queries('-30m', '10.0.1.45:3306'),
    'SQL Query Analysis'
)
```

### gRPC Latency Analysis

```python
# grpc_latency_analysis.pxl
import px

def grpc_service_map(start_time: str):
    """
    Build a service-to-service call map with gRPC latency metrics.
    """
    df = px.DataFrame(
        table='grpc_events',
        start_time=start_time
    )

    # Resolve service names from pod context
    df.requestor_service = df.ctx['service']
    df.requestor_pod = df.ctx['pod']
    df.requestor_namespace = df.ctx['namespace']

    # Extract gRPC method from path
    df.grpc_service = px.regex_match('/([^/]+)/[^/]+$', df.req_path, 1)
    df.grpc_method = px.regex_match('/[^/]+/([^/]+)$', df.req_path, 1)

    df = df.groupby([
        'requestor_service',
        'requestor_namespace',
        'remote_addr',
        'grpc_service',
        'grpc_method'
    ]).agg(
        call_count=('latency', px.count),
        p50_ms=('latency', px.quantiles(0.5)),
        p99_ms=('latency', px.quantiles(0.99)),
        error_count=('resp_status', lambda s: px.sum((s != 0).astype(int)))
    )

    df.error_rate_pct = (df.error_count / df.call_count) * 100
    df.calls_per_sec = df.call_count / px.parse_duration(start_time)

    return df

px.display(grpc_service_map('-10m'), 'gRPC Service Map')
```

## Service Map Generation

Pixie generates live service maps by correlating eBPF network events with Kubernetes metadata. The following PxL script produces a service graph compatible with visualization tools.

```python
# service_graph.pxl
import px

def service_graph(start_time: str, namespace_filter: str):
    """
    Generate a directed service dependency graph with SLI metrics.
    """
    df = px.DataFrame(table='http_events', start_time=start_time)

    # Resolve caller and callee service identities
    df.requestor = df.ctx['service']
    df.requestor_ns = df.ctx['namespace']

    # Build edge key
    df.edge = df.requestor + ' -> ' + df.remote_addr

    df = df.groupby(['requestor', 'requestor_ns', 'remote_addr']).agg(
        request_throughput=('latency', px.count),
        p99_latency=('latency', px.quantiles(0.99)),
        inbound_bytes=('req_body_size', px.sum),
        outbound_bytes=('resp_body_size', px.sum),
        http_errors=('resp_status', lambda s: px.sum((s >= 500).astype(int)))
    )

    # Filter to namespace if specified
    if namespace_filter != '':
        df = df[df.requestor_ns == namespace_filter]

    df.error_rate = df.http_errors / df.request_throughput
    df.throughput_per_sec = df.request_throughput / px.parse_duration(start_time)

    # Classify edge health
    df.edge_status = px.select(
        df.error_rate > 0.05, 'critical',
        px.select(df.error_rate > 0.01, 'warning', 'healthy')
    )

    return df

px.display(
    service_graph('-5m', 'production'),
    'Service Dependency Graph'
)
```

## Integrating Pixie with OpenTelemetry

Pixie's OpenTelemetry export plugin forwards eBPF-captured telemetry to any OTLP-compatible backend, enabling correlation with traces generated by application-level instrumentation.

### Configuring the OTLP Export Plugin

```yaml
# pixie-otel-export-plugin.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: pixie-plugin-otel-config
  namespace: pl
data:
  config.yaml: |
    customExportURL: "http://otel-collector.observability.svc.cluster.local:4317"
    insecureSkipVerify: false

    exportScripts:
      - name: "http_metrics_export"
        script: |
          import px
          import pxtrace

          df = px.DataFrame(table='http_events', start_time='-30s')
          df.service = df.ctx['service']
          df.namespace = df.ctx['namespace']

          df = df.groupby(['service', 'namespace', 'req_path', 'resp_status']).agg(
              latency_ns=('latency', px.quantiles(0.99)),
              count=('latency', px.count)
          )

          px.export(
              df,
              px.otel.Data(
                  resource=px.otel.Resource(
                      attrs={
                          'service.name': df.service,
                          'k8s.namespace.name': df.namespace,
                          'telemetry.sdk.name': 'pixie'
                      }
                  ),
                  data=[
                      px.otel.metric.Gauge(
                          name='http.server.latency.p99',
                          description='HTTP server latency at p99',
                          value=df.latency_ns,
                          attributes={
                              'http.target': df.req_path,
                              'http.status_code': df.resp_status
                          }
                      ),
                      px.otel.metric.Summary(
                          name='http.server.request.count',
                          description='HTTP request count',
                          count=df.count
                      )
                  ]
              )
          )
        intervalSec: 30

      - name: "grpc_span_export"
        script: |
          import px

          df = px.DataFrame(table='grpc_events', start_time='-30s')
          df.service = df.ctx['service']
          df.pod = df.ctx['pod']
          df.namespace = df.ctx['namespace']

          px.export(
              df,
              px.otel.Data(
                  resource=px.otel.Resource(
                      attrs={
                          'service.name': df.service,
                          'k8s.pod.name': df.pod,
                          'k8s.namespace.name': df.namespace
                      }
                  ),
                  data=[
                      px.otel.trace.Span(
                          name=df.req_path,
                          startTimeUnixNano=df.time_,
                          endTimeUnixNano=df.time_ + df.latency,
                          attributes={
                              'rpc.method': df.req_path,
                              'rpc.grpc.status_code': df.resp_status
                          }
                      )
                  ]
              )
          )
        intervalSec: 30
```

### OpenTelemetry Collector Configuration

```yaml
# otel-collector-pixie-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: otel-collector-config
  namespace: observability
data:
  otel-collector-config.yaml: |
    receivers:
      otlp:
        protocols:
          grpc:
            endpoint: 0.0.0.0:4317
          http:
            endpoint: 0.0.0.0:4318

    processors:
      batch:
        timeout: 10s
        send_batch_size: 1024

      attributes/pixie_source:
        actions:
          - key: telemetry.source
            value: pixie-ebpf
            action: insert

      resource:
        attributes:
          - key: cluster.name
            value: production-us-east-1
            action: insert

    exporters:
      prometheusremotewrite:
        endpoint: "http://prometheus.monitoring.svc.cluster.local:9090/api/v1/write"

      loki:
        endpoint: "http://loki.monitoring.svc.cluster.local:3100/loki/api/v1/push"

      jaeger:
        endpoint: "jaeger-collector.observability.svc.cluster.local:14250"
        tls:
          insecure: true

    service:
      pipelines:
        metrics:
          receivers: [otlp]
          processors: [batch, attributes/pixie_source, resource]
          exporters: [prometheusremotewrite]
        traces:
          receivers: [otlp]
          processors: [batch, attributes/pixie_source, resource]
          exporters: [jaeger]
```

## Grafana Integration

### Pixie Grafana Data Source Plugin

Pixie provides a native Grafana data source plugin that executes PxL queries directly from Grafana dashboards.

```bash
# Install Pixie Grafana plugin
grafana-cli plugins install pixie-grafana-datasource

# Or via Helm values for grafana-operator deployment
cat <<EOF >> grafana-values.yaml
grafana.ini:
  plugins:
    allow_loading_unsigned_plugins: pixie-grafana-datasource

plugins:
  - pixie-grafana-datasource
EOF
```

### Grafana Dashboard Provisioning

```yaml
# pixie-dashboard-provisioning.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: pixie-grafana-dashboard
  namespace: monitoring
  labels:
    grafana_dashboard: "1"
data:
  pixie-http-overview.json: |
    {
      "title": "Pixie HTTP Overview",
      "uid": "pixie-http-overview",
      "panels": [
        {
          "title": "HTTP Request Rate by Service",
          "type": "timeseries",
          "datasource": "Pixie",
          "targets": [
            {
              "pxlScript": "import px\ndf = px.DataFrame('http_events', start_time=px.plugin.start_time)\ndf.service = df.ctx['service']\ndf = df.groupby(['time_', 'service']).agg(count=('latency', px.count))\npx.display(df)",
              "timeColumn": "time_",
              "valueColumns": ["count"],
              "legendColumn": "service"
            }
          ],
          "fieldConfig": {
            "defaults": {
              "unit": "reqps",
              "custom": {
                "lineWidth": 2
              }
            }
          }
        },
        {
          "title": "P99 Latency by Service",
          "type": "timeseries",
          "datasource": "Pixie",
          "targets": [
            {
              "pxlScript": "import px\ndf = px.DataFrame('http_events', start_time=px.plugin.start_time)\ndf.service = df.ctx['service']\ndf = df.groupby(['time_', 'service']).agg(p99=('latency', px.quantiles(0.99)))\ndf.p99_ms = df.p99 / 1e6\npx.display(df)",
              "timeColumn": "time_",
              "valueColumns": ["p99_ms"],
              "legendColumn": "service"
            }
          ],
          "fieldConfig": {
            "defaults": {
              "unit": "ms",
              "thresholds": {
                "steps": [
                  {"value": 0, "color": "green"},
                  {"value": 100, "color": "yellow"},
                  {"value": 500, "color": "red"}
                ]
              }
            }
          }
        }
      ],
      "time": {"from": "now-1h", "to": "now"},
      "refresh": "30s"
    }
```

## Custom PxL Scripts for Production Use Cases

### Network Connection Tracking

```python
# network_connections.pxl
import px

def connection_tracker(start_time: str, pod_name: str):
    """
    Track all TCP connections made by a specific pod.
    Useful for security auditing and anomaly detection.
    """
    df = px.DataFrame(table='conn_stats', start_time=start_time)

    # Filter to target pod
    df = df[df.ctx['pod'] == pod_name]

    df.local_addr = df.local_addr
    df.remote_addr = df.remote_addr
    df.protocol = df.traffic_class

    df = df.groupby(['local_addr', 'remote_addr', 'protocol']).agg(
        bytes_sent=('bytes_sent', px.sum),
        bytes_recv=('bytes_recv', px.sum),
        conn_open=('conn_open', px.sum),
        conn_close=('conn_close', px.sum),
        first_seen=('time_', px.min),
        last_seen=('time_', px.max)
    )

    df.active = df.conn_open > df.conn_close
    df.duration_sec = (df.last_seen - df.first_seen) / 1e9

    return df

px.display(
    connection_tracker('-1h', 'payment-service-7d9f8b-xkpqr'),
    'Pod Connection Tracker'
)
```

### DNS Request Analysis

```python
# dns_analysis.pxl
import px

def dns_failure_analysis(start_time: str):
    """
    Identify failing DNS queries and correlate with service outages.
    """
    df = px.DataFrame(table='dns_events', start_time=start_time)

    df.source_service = df.ctx['service']
    df.source_namespace = df.ctx['namespace']

    # Filter to failed responses
    df_failed = df[df.resp_status != 0]  # 0 = NOERROR

    df_failed = df_failed.groupby([
        'source_service',
        'source_namespace',
        'req_query',
        'resp_status'
    ]).agg(
        failure_count=('time_', px.count),
        first_failure=('time_', px.min),
        last_failure=('time_', px.max),
        avg_latency_ms=('latency', px.mean)
    )

    df_failed = df_failed.sort('failure_count', ascending=False)

    return df_failed

px.display(dns_failure_analysis('-30m'), 'DNS Failure Analysis')
```

## Performance Tuning and Resource Management

### PEM Memory Configuration

The Pixie Edge Module (PEM) stores captured data in a ring buffer. Configure memory limits based on your cluster's telemetry volume:

```yaml
# vizier-pem-tuning.yaml
apiVersion: px.dev/v1alpha1
kind: Vizier
metadata:
  name: vizier
  namespace: pl
spec:
  pemMemoryLimit: "4Gi"
  pemMemoryRequest: "2Gi"

  patches:
    vizier-pem:
      spec:
        containers:
        - name: pem
          env:
          - name: PL_TABLE_STORE_DATA_LIMIT_MB
            value: "1024"
          - name: PL_TABLE_STORE_HTTP_EVENTS_PERCENT
            value: "40"
          - name: PL_TABLE_STORE_GRPC_EVENTS_PERCENT
            value: "20"
          - name: PL_TABLE_STORE_MYSQL_EVENTS_PERCENT
            value: "10"
          - name: PL_TABLE_STORE_POSTGRES_EVENTS_PERCENT
            value: "10"
          - name: PL_TABLE_STORE_DNS_EVENTS_PERCENT
            value: "10"
          - name: PL_TABLE_STORE_CONN_STATS_PERCENT
            value: "10"
          resources:
            requests:
              cpu: "200m"
              memory: "2Gi"
            limits:
              cpu: "1000m"
              memory: "4Gi"
```

### Reducing Overhead on High-Traffic Nodes

```bash
# Tune eBPF sampling rate for high-throughput services
kubectl set env daemonset/vizier-pem -n pl \
  PL_STIRLING_SAMPLING_PERIOD=200ms \
  PL_HTTP_BODY_LIMIT_BYTES=256 \
  PL_GRPC_BODY_LIMIT_BYTES=128

# Exclude specific namespaces from data collection
kubectl annotate namespace istio-system \
  px.dev/disabled=true

# Exclude system pods from profiling
kubectl annotate pod kube-proxy-xxxxx -n kube-system \
  px.dev/sampling=disabled
```

## AlertManager Integration via Pixie's Plugin API

```python
# alert_on_high_error_rate.pxl
import px
import pxviews

# This script runs on the Pixie plugin interval
df = px.DataFrame(table='http_events', start_time='-5m')
df.service = df.ctx['service']
df.namespace = df.ctx['namespace']

df = df.groupby(['service', 'namespace']).agg(
    total=('resp_status', px.count),
    errors=('resp_status', lambda s: px.sum((s >= 500).astype(int)))
)

df.error_rate = df.errors / df.total
df.alert = df.error_rate > 0.05

# Only surface services with meaningful traffic
df = df[df.total > 100]
df = df[df.alert == True]

px.display(df, 'High Error Rate Alert')
```

## Troubleshooting Common Issues

### PEM Pods in CrashLoopBackOff

```bash
# Check PEM logs for eBPF probe failures
kubectl logs -n pl -l app=vizier-pem --tail=100 | grep -E "ERROR|WARN|probe"

# Verify BTF (BPF Type Format) availability
kubectl exec -n pl -it $(kubectl get pod -n pl -l app=vizier-pem -o name | head -1) \
  -- ls /sys/kernel/btf/vmlinux

# Check if kernel modules are loaded
kubectl exec -n pl -it $(kubectl get pod -n pl -l app=vizier-pem -o name | head -1) \
  -- lsmod | grep -E "bpf|kprobe"

# Diagnose eBPF permission issues
kubectl get clusterrolebinding -l app.kubernetes.io/component=pem
kubectl describe clusterrole pixie-pem-role
```

### Query Timeout Issues

```bash
# Increase query timeout for complex PxL scripts
px run -f complex_analysis.pxl \
  --query-timeout=120s \
  --cluster production-us-east-1

# Check Kelvin memory usage
kubectl top pod -n pl -l app=kelvin

# Scale Kelvin for large clusters
kubectl scale deployment kelvin -n pl --replicas=3
```

### Missing Data for Specific Protocols

```bash
# Verify protocol detection is enabled
kubectl exec -n pl -it $(kubectl get pod -n pl -l app=vizier-pem -o name | head -1) \
  -- cat /proc/$(pgrep pem)/environ | tr '\0' '\n' | grep PL_ENABLE

# Enable PostgreSQL tracing explicitly
kubectl set env daemonset/vizier-pem -n pl \
  PL_STIRLING_ENABLE_PGSQL=true \
  PL_STIRLING_ENABLE_REDIS=true \
  PL_STIRLING_ENABLE_AMQP=true
```

## Security Considerations

### Data Sensitivity in eBPF Captures

Pixie captures raw HTTP and gRPC bodies by default. In production environments handling PII or PCI-scoped data, configure body scrubbing:

```yaml
# body-scrubbing-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: pem-data-config
  namespace: pl
data:
  config.yaml: |
    protocol_configs:
      http:
        body_limit_bytes: 0  # Disable body capture
        headers_enabled: true
      grpc:
        body_limit_bytes: 0  # Disable body capture
      mysql:
        query_enabled: true
        response_body_enabled: false
```

### RBAC for Pixie Access

```yaml
# pixie-user-rbac.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: pixie-viewer
rules:
- apiGroups: ["px.dev"]
  resources: ["viziers"]
  verbs: ["get", "list"]
- apiGroups: [""]
  resources: ["pods", "services", "namespaces"]
  verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: pixie-viewer-binding
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: pixie-viewer
subjects:
- kind: ServiceAccount
  name: grafana
  namespace: monitoring
```

## Production Deployment Checklist

```bash
#!/bin/bash
# pixie-pre-deploy-check.sh

set -euo pipefail

echo "=== Pixie Pre-Deployment Checks ==="

# Check kernel version
echo -n "Kernel version: "
uname -r

# Verify cluster has sufficient resources
echo -n "Node memory check (min 1GB per node): "
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{": "}{.status.allocatable.memory}{"\n"}{end}'

# Verify eBPF syscalls not blocked by seccomp
echo "Checking seccomp profiles..."
kubectl get pods -A -o jsonpath='{range .items[*]}{.metadata.name}{": "}{.spec.securityContext.seccompProfile}{"\n"}{end}' \
  | grep -v "null" | head -20

# Check Cilium/Calico compatibility
echo "Checking CNI compatibility..."
kubectl get pods -n kube-system -l k8s-app=cilium -o name | head -5

# Verify storage is available for persistent journal
echo "PVC storage check..."
kubectl get pvc -n pl 2>/dev/null || echo "No PVCs yet (expected pre-install)"

echo "=== Pre-Deployment Checks Complete ==="
```

Pixie provides exceptional value in environments where instrumentation overhead is unacceptable or where development teams cannot be required to modify application code. The combination of zero-instrumentation telemetry, PxL's expressive query API, and native OpenTelemetry export makes Pixie a compelling addition to any Kubernetes observability stack alongside Prometheus and distributed tracing solutions.
