---
title: "Kubernetes Observability with Pixie: eBPF-Based No-Instrumentation Monitoring"
date: 2029-11-17T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Pixie", "eBPF", "Observability", "Monitoring", "OpenTelemetry"]
categories: ["Kubernetes", "Observability"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Pixie for Kubernetes observability: eBPF-based automatic protocol tracing, PxL scripting, flame graph generation, HTTP/gRPC/SQL monitoring, and OpenTelemetry integration without code instrumentation."
more_link: "yes"
url: "/kubernetes-observability-pixie-ebpf-no-instrumentation-monitoring/"
---

Modern Kubernetes observability has long required the same compromise: instrument every service with language-specific agents, add sidecars, or configure complex data collection pipelines. Pixie challenges this assumption by using eBPF to capture telemetry data directly from the Linux kernel — without modifying application code, deploying sidecars, or changing container images. This guide explores Pixie's architecture, its powerful PxL scripting language, automatic protocol tracing for HTTP, gRPC, and SQL, flame graph generation, and how to integrate Pixie's data stream with OpenTelemetry-compatible backends.

<!--more-->

# Kubernetes Observability with Pixie: eBPF-Based No-Instrumentation Monitoring

## Why No-Instrumentation Observability Matters

The traditional instrumentation model has fundamental limitations in large-scale Kubernetes environments:

**Deployment coupling**: Adding a tracing agent means updating every deployment manifest. Rolling out a new version of the agent across hundreds of services requires coordination.

**Language heterogeneity**: Polyglot environments (Go, Java, Python, Node.js, Rust) require separate agent libraries, each with different feature sets and maintenance burden.

**Cold start and legacy code**: Services you don't own, third-party software, and legacy applications can rarely be instrumented at all.

**Performance overhead**: JVM-based agents in particular carry significant overhead from bytecode instrumentation.

Pixie addresses these limitations by instrumenting at the kernel boundary rather than the application boundary.

## Pixie Architecture

### Components

**Vizier (per-cluster)**: Pixie's per-cluster agent, deployed as a DaemonSet. Vizier's components include:
- **PEM (Pixie Edge Module)**: DaemonSet pods that run eBPF programs and collect data
- **Metadata Service**: Tracks Kubernetes metadata (pod names, service names, namespaces)
- **Query Broker**: Coordinates query execution across PEM pods
- **Kelvin**: Aggregation layer that merges data from all PEM instances

**Cloud (or self-hosted) Control Plane**: Manages authentication, script distribution, and long-term storage.

**PxL Scripts**: Pixie's query language, executed on-demand against the Vizier's in-memory data store.

### Data Flow

```
Application (any language, no changes)
    |
    | System calls (read/write/sendmsg/recvmsg)
    |
[Linux Kernel]
    |
    | eBPF probes (attached by PEM pods)
    |
[Pixie PEM]
    |--- Protocol parsing (HTTP, gRPC, SQL, Redis, Kafka, ...)
    |--- Performance data (CPU, memory, network)
    |--- Function profiling (Go, Java, Python stack traces)
    |
[Kelvin aggregation]
    |
[PxL Query] <-- user writes scripts
    |
[Visualization / Export]
```

### Key Design Properties

**In-kernel processing**: eBPF programs run in the kernel's verified sandbox, reducing the amount of data that must be copied to userspace. Only processed, structured telemetry leaves the kernel.

**Short-term in-cluster storage**: Pixie stores data in-cluster (typically 24 hours of rolling window) at the node level. This allows PxL queries to run locally without egressing raw data, improving both privacy and performance.

**Scriptable**: All Pixie functionality is expressed through PxL scripts, making it fully programmable and extensible.

## Installing Pixie

### Prerequisites

```bash
# Minimum kernel version: 4.14+ (eBPF CO-RE requires 5.8+)
uname -r
# 5.15.0-91-generic  ✓

# Check eBPF support
ls /sys/kernel/debug/tracing/
# Should list available tracepoints

# Pixie requires privileged DaemonSet pods
# and the ability to load eBPF programs
```

### Helm Installation

```bash
# Install Pixie CLI
bash -c "$(curl -fsSL https://withpixie.ai/install.sh)"
# Or for air-gapped / custom install:
curl -Lo px https://github.com/pixie-io/pixie/releases/latest/download/cli_linux_amd64
chmod +x px && mv px /usr/local/bin/

# Authenticate (cloud-hosted)
px auth login

# Deploy Vizier to your cluster
px deploy

# Deploy with Helm for GitOps workflows
helm repo add pixie-operator https://pixie-operator-charts.storage.googleapis.com
helm repo update

helm install pixie-operator pixie-operator/pixie-operator-chart \
  --namespace pl \
  --create-namespace \
  --set deployKey="${PIXIE_DEPLOY_KEY}" \
  --set clusterName="production-us-east-1"
```

### Self-Hosted Deployment

```bash
# Deploy Pixie's cloud components on-premises
# (requires significant setup; use the open-source pixie repo)
git clone https://github.com/pixie-io/pixie.git
cd pixie

# Deploy cloud components to a separate "admin" cluster
skaffold run -p cloud

# Then deploy Vizier pointing to your self-hosted cloud
helm install pixie-operator pixie-operator/pixie-operator-chart \
  --set deployKey="${PIXIE_DEPLOY_KEY}" \
  --set cloudAddr="pixie-cloud.internal:443" \
  --set clusterName="production-us-east-1"
```

### Verify Installation

```bash
# Check Vizier components
kubectl get pods -n pl

# Expected output:
# NAME                              READY   STATUS    RESTARTS   AGE
# kelvin-7d9b4c8f5-xr2gj            1/1     Running   0          5m
# pl-nats-0                         2/2     Running   0          5m
# vizier-certmgr-6d5c9b7f4-kp8mn    1/1     Running   0          5m
# vizier-metadata-6b8d4c9f5-tj2lm   1/1     Running   0          5m
# vizier-proxy-7c5d8b9f6-wr3np      1/1     Running   0          5m
# vizier-query-broker-...           1/1     Running   0          5m
# vizier-pem-2xhk9                  1/1     Running   0          5m  (per node)
# vizier-pem-8rmkp                  1/1     Running   0          5m  (per node)
# vizier-pem-b9jws                  1/1     Running   0          5m  (per node)

# Run a quick health check
px debug pods
```

## PxL: Pixie's Query Language

PxL (Pixie Language) is a Python-like, dataframe-oriented query language. It is compiled and executed inside the Pixie cluster, with results streamed back to the client.

### Basic PxL Syntax

```python
# PxL is Python-inspired but has its own semantics
# Key operations: px.DataFrame, groupby, agg, join, display

import px

# Basic: Get all HTTP requests in the last 5 minutes
def http_requests():
    # px.DataFrame creates a dataframe from a built-in Pixie data source
    df = px.DataFrame(
        table='http_events',
        start_time='-5m'
    )

    # Add Kubernetes context
    df.pod = df.ctx['pod']
    df.service = df.ctx['service']
    df.namespace = df.ctx['namespace']

    # Filter and select columns
    df = df[df.resp_status >= 400]  # Only errors
    df = df[[
        'time_', 'pod', 'service', 'namespace',
        'req_method', 'req_path',
        'resp_status', 'resp_body',
        'latency'
    ]]

    return df

px.display(http_requests(), 'HTTP Errors')
```

### HTTP Monitoring Script

```python
# scripts/http_overview.pxl
import px

def http_overview(start_time: str = '-15m', namespace: str = ''):
    df = px.DataFrame(table='http_events', start_time=start_time)

    # Attach Kubernetes metadata
    df.pod = df.ctx['pod']
    df.service = df.ctx['service']
    df.namespace = df.ctx['namespace']
    df.node = df.ctx['node']

    # Filter by namespace if specified
    df = df[px.contains(df.namespace, namespace)]

    # Add computed columns
    df.is_error = df.resp_status >= 400
    df.latency_ms = df.latency / 1e6  # nanoseconds to milliseconds

    # Aggregate per service
    agg = df.groupby(['service', 'namespace']).agg(
        request_count=('latency', px.count),
        error_count=('is_error', px.sum),
        p50_latency_ms=('latency_ms', px.percentile(50)),
        p90_latency_ms=('latency_ms', px.percentile(90)),
        p99_latency_ms=('latency_ms', px.percentile(99)),
    )

    agg.error_rate = agg.error_count / agg.request_count
    agg.rps = agg.request_count / 15 / 60  # requests per second over 15 min

    agg = agg[['service', 'namespace', 'rps', 'error_rate',
                'p50_latency_ms', 'p90_latency_ms', 'p99_latency_ms']]

    return agg

px.display(http_overview(), 'HTTP Service Overview')
```

### gRPC Tracing

```python
# scripts/grpc_tracing.pxl
import px

def grpc_latency_breakdown(start_time: str = '-10m', service_filter: str = ''):
    # Pixie automatically decodes gRPC (HTTP/2) framing
    df = px.DataFrame(table='http_events', start_time=start_time)

    # gRPC requests use HTTP/2; filter by content-type
    df = df[px.contains(df.req_headers, 'application/grpc')]

    df.pod = df.ctx['pod']
    df.service = df.ctx['service']
    df.namespace = df.ctx['namespace']

    if service_filter:
        df = df[px.contains(df.service, service_filter)]

    # Extract gRPC method from path (/package.Service/Method)
    df.grpc_method = df.req_path

    # gRPC status is in trailers, not HTTP status
    # Pixie parses gRPC trailers automatically
    df.grpc_status = df.resp_status

    df.latency_ms = df.latency / 1e6

    agg = df.groupby(['service', 'grpc_method']).agg(
        count=('latency', px.count),
        p50=('latency_ms', px.percentile(50)),
        p95=('latency_ms', px.percentile(95)),
        p99=('latency_ms', px.percentile(99)),
        error_count=('grpc_status', lambda s: px.sum(s != 0)),
    )

    agg.error_rate = agg.error_count / agg.count

    return agg

px.display(grpc_latency_breakdown(), 'gRPC Method Latencies')
```

### SQL Query Tracing

```python
# scripts/sql_tracing.pxl
import px

def sql_query_analysis(start_time: str = '-10m', threshold_ms: float = 100.0):
    # Pixie traces PostgreSQL and MySQL wire protocols automatically
    df = px.DataFrame(table='mysql_events', start_time=start_time)

    df.pod = df.ctx['pod']
    df.service = df.ctx['service']

    df.latency_ms = df.latency / 1e6

    # Filter to slow queries
    df = df[df.latency_ms > threshold_ms]

    # Show the actual SQL text (Pixie captures query body)
    df = df[[
        'time_', 'service', 'pod',
        'req_body',      # Actual SQL query text
        'resp_body',     # Response (rows affected, error messages)
        'latency_ms',
    ]]

    df = df.sort('latency_ms', ascending=False)

    return df

# PostgreSQL version
def postgres_slow_queries(start_time: str = '-10m', threshold_ms: float = 50.0):
    df = px.DataFrame(table='pgsql_events', start_time=start_time)

    df.pod = df.ctx['pod']
    df.service = df.ctx['service']
    df.latency_ms = df.latency / 1e6

    df = df[df.latency_ms > threshold_ms]

    # Normalize queries (remove literal values) for aggregation
    agg = df.groupby(['req_body']).agg(
        count=('latency', px.count),
        avg_latency_ms=('latency_ms', px.mean),
        p99_latency_ms=('latency_ms', px.percentile(99)),
    )

    agg = agg.sort('avg_latency_ms', ascending=False)
    return agg

px.display(postgres_slow_queries(), 'Slow PostgreSQL Queries')
```

## Continuous Profiling: Flame Graphs

One of Pixie's most powerful features is continuous CPU profiling using eBPF perf events. Unlike sampling-based profilers that require process attachment, Pixie profiles all processes simultaneously with minimal overhead (~1% CPU).

### Running the Profiler

```python
# scripts/cpu_flamegraph.pxl
import px

def cpu_flamegraph(start_time: str = '-30s', node: str = ''):
    # Pixie's profiler captures stack traces every ~10ms via perf_event_open
    df = px.DataFrame(table='stack_traces.beta', start_time=start_time)

    df.pod = df.ctx['pod']
    df.service = df.ctx['service']
    df.namespace = df.ctx['namespace']
    df.node = df.ctx['node']

    if node:
        df = df[df.node == node]

    # The 'stack_trace' column contains the full stack as a string
    # suitable for flamegraph visualization
    df = df[['time_', 'pod', 'service', 'stack_trace', 'count']]

    return df

# Run with flamegraph visualization
px.display(cpu_flamegraph(), 'CPU Flame Graph')
```

### Language-Specific Profiling

Pixie uses different techniques depending on the language runtime:

```python
# scripts/go_profiling.pxl
import px

def go_function_latency(
    start_time: str = '-5m',
    namespace: str = 'production',
    pod_filter: str = '',
    func_name: str = '',
):
    # Pixie can trace Go function entry/exit via uprobes
    # Requires the binary to have debug symbols (or Pixie can use DWARF)
    df = px.DataFrame(table='go_http_server_funcs.beta', start_time=start_time)

    df.pod = df.ctx['pod']
    df.namespace = df.ctx['namespace']

    df = df[df.namespace == namespace]

    if pod_filter:
        df = df[px.contains(df.pod, pod_filter)]

    df.latency_ms = df.latency / 1e6

    agg = df.groupby(['pod', 'func']).agg(
        count=('latency', px.count),
        p50=('latency_ms', px.percentile(50)),
        p99=('latency_ms', px.percentile(99)),
    )

    return agg

px.display(go_function_latency(), 'Go Function Latencies')
```

## Service Map Generation

```python
# scripts/service_map.pxl
import px

def service_dependency_map(start_time: str = '-5m', namespace: str = ''):
    df = px.DataFrame(table='http_events', start_time=start_time)

    df.requestor_pod = df.ctx['pod']
    df.requestor_service = df.ctx['service']
    df.requestor_namespace = df.ctx['namespace']

    # Resolve the responding service from the remote IP
    df.responder_pod = px.pod_name_of_remote_ip(df.remote_addr)
    df.responder_service = px.service_name_of_remote_ip(df.remote_addr)

    if namespace:
        df = df[df.requestor_namespace == namespace]

    df.latency_ms = df.latency / 1e6

    # Build service graph edges
    edges = df.groupby(['requestor_service', 'responder_service']).agg(
        request_count=('latency', px.count),
        p99_latency_ms=('latency_ms', px.percentile(99)),
        error_rate=('resp_status', lambda s: px.sum(s >= 400) / px.count(s)),
    )

    # Filter out empty services (external traffic, etc.)
    edges = edges[edges.requestor_service != '' and edges.responder_service != '']

    return edges

px.display(service_dependency_map(), 'Service Map', 'graph')
```

## Running PxL Scripts via CLI

```bash
# Run a built-in script
px run px/http_data -- --start_time=-15m

# Run a custom script file
px run -f ./scripts/http_overview.pxl -- --namespace=production

# Run with JSON output (for piping to jq)
px run px/http_data --output json | jq '.[] | select(.resp_status >= 500)'

# List available built-in scripts
px scripts list

# Built-in script categories:
# px/         — General Kubernetes observability
# pxbeta/     — Beta features (profiling, language-specific tracing)
# px/net/     — Network-level analysis
```

## Integration with OpenTelemetry

Pixie can export data to any OpenTelemetry-compatible backend, enabling correlation with existing observability stacks.

### OpenTelemetry Plugin Configuration

```yaml
# pixie-otel-plugin.yaml
# Deploy as a ConfigMap that Pixie's OTel plugin reads

apiVersion: v1
kind: ConfigMap
metadata:
  name: otel-export-config
  namespace: pl
data:
  otel_export_addr: "otel-collector.monitoring.svc.cluster.local:4317"
  otel_export_insecure: "true"

  # PxL script that defines what data to export
  export_script: |
    import px
    import pxtrace

    # Export HTTP data to OTEL
    @pxtrace.probe("export_http_spans")
    def export_http_spans():
        df = px.DataFrame(table='http_events', start_time='-1m')

        df.pod = df.ctx['pod']
        df.service = df.ctx['service']
        df.namespace = df.ctx['namespace']

        df.latency_ms = df.latency / 1e6

        # Map to OTEL span attributes
        df.span_name = df.req_path
        df.span_kind = 'server'

        df = df[[
            'time_', 'pod', 'service', 'namespace',
            'span_name', 'span_kind',
            'req_method', 'req_path',
            'resp_status', 'latency_ms',
        ]]

        px.export(df, px.otel.Data(
            resource=px.otel.Resource({
                'service.name': df.service,
                'k8s.pod.name': df.pod,
                'k8s.namespace.name': df.namespace,
            }),
            data=[
                px.otel.Span(
                    name=df.span_name,
                    kind=df.span_kind,
                    start_time=df.time_,
                    end_time=df.time_ + px.DurationNanos(df.latency_ms * 1e6),
                    attributes={
                        'http.method': df.req_method,
                        'http.url': df.req_path,
                        'http.status_code': df.resp_status,
                    },
                )
            ],
        ))
```

### OpenTelemetry Collector Configuration

```yaml
# otel-collector-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: otel-collector-config
  namespace: monitoring
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
        timeout: 5s
        send_batch_size: 1000

      # Add cluster label to all spans from Pixie
      attributes:
        actions:
          - key: k8s.cluster.name
            value: production-us-east-1
            action: insert

    exporters:
      # Export to Jaeger for trace visualization
      jaeger:
        endpoint: jaeger-collector.monitoring.svc.cluster.local:14250
        tls:
          insecure: true

      # Export metrics to Prometheus
      prometheus:
        endpoint: 0.0.0.0:8889
        namespace: pixie

      # Export to Tempo (Grafana's trace backend)
      otlp/tempo:
        endpoint: tempo.monitoring.svc.cluster.local:4317
        tls:
          insecure: true

    service:
      pipelines:
        traces:
          receivers: [otlp]
          processors: [batch, attributes]
          exporters: [jaeger, otlp/tempo]
        metrics:
          receivers: [otlp]
          processors: [batch]
          exporters: [prometheus]
```

## Kubernetes Deployment for Production

```yaml
# vizier-values.yaml — Helm values for production Vizier
clusterName: production-us-east-1
deployKey: "${PIXIE_DEPLOY_KEY}"

# Resource limits for PEM DaemonSet
dataCollector:
  resources:
    limits:
      memory: 2Gi
      cpu: "2"
    requests:
      memory: 1Gi
      cpu: "500m"

  # Data retention per node (rolling window)
  # Larger = more history, more memory
  dataRetentionInHours: 24

  # Table sizes (tune based on traffic volume)
  customPEMFlags:
    PL_TABLE_STORE_DATA_LIMIT_MB: "1024"
    PL_STIRLING_HTTP_BODY_TRUNCATION_SIZE_BYTES: "512"

# Tolerate all nodes (including tainted nodes)
tolerations:
  - operator: "Exists"

# Node selector (deploy on all worker nodes)
nodeSelector: {}
```

## Network-Level Observability

```python
# scripts/network_connections.pxl
import px

def tcp_connections(start_time: str = '-5m', namespace: str = ''):
    # Pixie traces TCP connection state via eBPF sock ops
    df = px.DataFrame(table='conn_stats', start_time=start_time)

    df.pod = df.ctx['pod']
    df.service = df.ctx['service']
    df.namespace = df.ctx['namespace']

    if namespace:
        df = df[df.namespace == namespace]

    agg = df.groupby(['pod', 'service', 'remote_addr']).agg(
        bytes_sent=('bytes_sent', px.sum),
        bytes_recv=('bytes_recv', px.sum),
        conn_open=('conn_open', px.sum),
        conn_close=('conn_close', px.sum),
    )

    # Identify external connections (outside cluster)
    agg.is_external = ~px.has_service_name(agg.remote_addr)

    return agg

def tcp_drops(start_time: str = '-5m'):
    # Detect TCP retransmissions and drops
    df = px.DataFrame(table='network_metrics.beta', start_time=start_time)
    df.pod = df.ctx['pod']

    return df[['time_', 'pod', 'tcp_retransmits', 'tcp_drops', 'tcp_rto']]

px.display(tcp_drops(), 'TCP Issues')
```

## Automated Alerting with PxL

```python
# scripts/slo_monitor.pxl
import px

def check_slo_violations(
    start_time: str = '-5m',
    latency_p99_threshold_ms: float = 200.0,
    error_rate_threshold: float = 0.01,
):
    df = px.DataFrame(table='http_events', start_time=start_time)

    df.service = df.ctx['service']
    df.namespace = df.ctx['namespace']
    df.latency_ms = df.latency / 1e6
    df.is_error = df.resp_status >= 500

    agg = df.groupby(['service', 'namespace']).agg(
        count=('latency', px.count),
        p99_latency_ms=('latency_ms', px.percentile(99)),
        error_rate=('is_error', px.mean),
    )

    # Flag SLO violations
    agg.p99_violation = agg.p99_latency_ms > latency_p99_threshold_ms
    agg.error_rate_violation = agg.error_rate > error_rate_threshold
    agg.slo_violated = agg.p99_violation | agg.error_rate_violation

    violations = agg[agg.slo_violated]

    return violations

px.display(check_slo_violations(), 'SLO Violations')
```

## Pixie vs Traditional APM Comparison

| Capability | Pixie | Traditional APM (Datadog, Dynatrace) |
|------------|-------|--------------------------------------|
| Instrumentation | None (eBPF) | Agent per language |
| Protocol tracing | Automatic | Requires SDK integration |
| SQL query capture | Automatic | Requires DB integration |
| Flame graphs | Continuous, all processes | Opt-in, selected processes |
| Data retention | 24h in-cluster | Configurable (cloud) |
| Privacy | Data stays in cluster | Data egressed to vendor |
| Cost model | OSS (compute only) | Per-host or per-GB pricing |
| Custom queries | Full PxL scripting | Limited query languages |

## Troubleshooting Pixie

```bash
# Check PEM health on each node
kubectl logs -n pl -l component=vizier-pem --tail=50

# Common issues and resolutions:

# 1. eBPF program load failures (kernel version too old)
# Error: "Failed to load BPF program"
# Resolution: Upgrade kernel to 5.8+ for CO-RE support

# 2. Missing data for a protocol
# Check if protocol is supported:
kubectl exec -n pl -it $(kubectl get pod -n pl -l component=vizier-pem -o name | head -1) \
  -- px_probe_status

# 3. High PEM memory usage
# Reduce table store size:
kubectl patch daemonset -n pl vizier-pem --type=json \
  -p='[{"op":"add","path":"/spec/template/spec/containers/0/env/-","value":{"name":"PL_TABLE_STORE_DATA_LIMIT_MB","value":"512"}}]'

# 4. TLS-encrypted traffic not decoded
# Pixie can trace TLS by hooking OpenSSL/BoringSSL at the userspace boundary
# (before encryption). Check if the application uses system SSL libraries.
kubectl exec -n pl -it $(kubectl get pod -n pl -l component=vizier-pem -o name | head -1) \
  -- ls /proc/1/exe  # Check if target binary is accessible

# 5. Vizier disconnected from cloud
px debug vizier
px debug log --last=100
```

## Summary

Pixie represents a fundamentally different approach to Kubernetes observability — one that aligns with the zero-friction principle engineers increasingly demand. By exploiting eBPF's ability to instrument at the kernel level, Pixie provides automatic HTTP, gRPC, SQL, and Redis tracing; continuous CPU profiling; and TCP-level network visibility across every process in your cluster without touching a single line of application code. The PxL scripting language makes this data fully programmable. The OpenTelemetry export capability ensures Pixie data can flow into your existing observability infrastructure. For teams managing large, polyglot Kubernetes deployments, Pixie fills the observability gaps that traditional APM agents cannot reach.
