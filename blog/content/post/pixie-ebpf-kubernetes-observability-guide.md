---
title: "Pixie: eBPF-Based Kubernetes Observability Without Instrumentation"
date: 2027-04-24T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Pixie", "eBPF", "Observability", "Tracing", "Performance"]
categories: ["Kubernetes", "Observability"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Guide to deploying Pixie for automatic Kubernetes observability using eBPF, capturing protocol-level telemetry without code instrumentation, writing PxL scripts, and integrating with existing monitoring stacks."
more_link: "yes"
url: "/pixie-ebpf-kubernetes-observability-guide/"
---

Pixie provides automatic, deep observability of Kubernetes applications using eBPF to capture protocol-level telemetry — HTTP/2, gRPC, MySQL, PostgreSQL, Redis, Kafka, DNS, and TLS — without requiring any application code changes or sidecar injection. Platform teams gain instant visibility into service latency, error rates, SQL queries, and network topology the moment Pixie is deployed. This guide covers Pixie's architecture, deployment, PxL scripting, protocol tracing, integration with Grafana and OpenTelemetry, and operational considerations including resource overhead and data retention.

<!--more-->

## Pixie Architecture

Pixie collects telemetry at the kernel level using eBPF probes attached to Linux kernel functions, syscalls, and userspace library functions.

```
┌──────────────────────────────────────────────────────────────────────┐
│                        Pixie Architecture                            │
│                                                                      │
│  Application Layer (no instrumentation required)                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐           │
│  │  HTTP/2  │  │  gRPC    │  │  MySQL   │  │  Redis   │           │
│  │  Service │  │  Service │  │  Server  │  │  Client  │           │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘           │
│       │              │              │              │                 │
│  ─────┼──────────────┼──────────────┼──────────────┼─── Kernel ─── │
│       ▼              ▼              ▼              ▼                 │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │               eBPF Probes (Pixie vizier-pem)                │   │
│  │  kprobes: connect/accept/read/write syscalls                 │   │
│  │  uprobes: Go, OpenSSL, BoringSSL (TLS decryption)           │   │
│  │  sock_ops: TCP connection events                             │   │
│  │  skb_ops: Network packet metadata                           │   │
│  └────────────────────────────┬─────────────────────────────────┘   │
│                               │ perf buffers / ring buffers          │
│  ┌────────────────────────────▼─────────────────────────────────┐   │
│  │              Pixie Data Tables (in-memory)                   │   │
│  │  http_events, grpc_data, mysql_events, pgsql_events          │   │
│  │  redis_events, kafka_events, dns_events, tcp_stats           │   │
│  │  process_stats, jvm_stats, network_stats                     │   │
│  └────────────────────────────┬─────────────────────────────────┘   │
│                               │                                     │
│  ┌────────────────────────────▼─────────────────────────────────┐   │
│  │              Pixie Cloud / Self-hosted Control Plane         │   │
│  │  - PxL script execution engine                               │   │
│  │  - Query routing to vizier-query-broker                      │   │
│  │  - API for Grafana, CLI, custom integrations                 │   │
│  └──────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

### Key Components

- **vizier-pem** (Pod Edge Module): DaemonSet running on every node that attaches eBPF probes and collects raw telemetry
- **vizier-query-broker**: Routes PxL queries to the appropriate pem pods
- **vizier-metadata**: Stores Kubernetes metadata (pod names, namespaces, services) used to enrich eBPF data
- **vizier-cloud-connector**: Maintains connection to Pixie Cloud or self-hosted control plane
- **Pixie Cloud / OLM**: Control plane for script execution, UI, and API access

## Installing Pixie

### Prerequisites

```bash
# Check kernel version (4.14+ required, 5.8+ recommended for full TLS support)
uname -r

# Verify eBPF is available
ls /sys/kernel/debug/tracing

# Check BPF JIT is enabled (improves performance)
sysctl net.core.bpf_jit_enable

# Required kernel config (check if enabled)
zcat /proc/config.gz 2>/dev/null || cat /boot/config-$(uname -r) | \
  grep -E "CONFIG_BPF|CONFIG_KPROBE|CONFIG_UPROBE|CONFIG_TRACING"
```

### Deploy via Helm (Self-Hosted)

```bash
# Add Pixie Helm repository
helm repo add pixie-operator https://pixie-operator-charts.storage.googleapis.com
helm repo update

# Deploy Pixie Operator
helm upgrade --install pixie-operator pixie-operator/pixie-operator \
  --namespace pl \
  --create-namespace \
  --version 0.1.6 \
  --wait

# Generate a deploy key from Pixie Cloud
# Visit: https://work.withpixie.ai/admin/keys/deploy
# Or use the self-hosted Pixie control plane

# Deploy Vizier (the Pixie data collector) using the deploy key
kubectl apply -f - <<'EOF'
apiVersion: px.dev/v1alpha1
kind: Vizier
metadata:
  name: pixie
  namespace: pl
spec:
  deployKey: EXAMPLE_TOKEN_REPLACE_ME
  clusterName: production-us-east-1
  pemMemoryRequest: "2Gi"
  pemMemoryLimit: "4Gi"
  dataAccess: Full
  disableAutoUpdate: false
  useEtcdOperator: false
  pod:
    resources:
      limits:
        cpu: "2"
        memory: 4Gi
      requests:
        cpu: 250m
        memory: 2Gi
EOF

# Watch deployment
kubectl -n pl get pods -w
```

```yaml
# vizier-full-config.yaml
apiVersion: px.dev/v1alpha1
kind: Vizier
metadata:
  name: pixie
  namespace: pl
spec:
  deployKey: EXAMPLE_TOKEN_REPLACE_ME
  clusterName: production-us-east-1

  # Resource limits for PEM (main data collection daemon)
  pemMemoryRequest: "2Gi"
  pemMemoryLimit: "4Gi"

  # Full data access enables protocol tracing and TLS decryption
  dataAccess: Full

  # Customize data collection settings
  customDeployParameters:
    PL_TABLE_STORE_DATA_LIMIT_MB: "1024"    # Per-table data limit
    PL_TABLE_STORE_HTTP_EVENTS_PERCENT: "40"
    PL_TABLE_STORE_STIRLING_ERROR_LIMIT: "0"
    PEM_CLOCK_CONVERGENCE_THRESHOLD_NS: "1000000"

  # Control which namespaces Pixie traces
  registry:
    image: ghcr.io/pixie-io/pixie-oss

  pod:
    annotations:
      cluster-autoscaler.kubernetes.io/safe-to-evict: "false"
    nodeSelector:
      kubernetes.io/os: linux
    tolerations:
      - effect: NoSchedule
        operator: Exists   # Run on all node types including tainted ones
    resources:
      limits:
        cpu: "2"
        memory: 4Gi
      requests:
        cpu: 250m
        memory: 2Gi

  disableAutoUpdate: false
  useEtcdOperator: false
```

### Installing the Pixie CLI (px)

```bash
# Install Pixie CLI
bash -c "$(curl -fsSL https://withpixie.ai/install.sh)"

# Or download binary directly
curl -L https://github.com/pixie-io/pixie/releases/download/release/cli_0.8.4/cli_linux_amd64 \
  -o /usr/local/bin/px
chmod +x /usr/local/bin/px

# Authenticate
px auth login

# List available clusters
px get viziers

# Select a cluster context
px config set-cluster production-us-east-1

# Quick health check
px run px/cluster
```

## PxL: Pixie Query Language

PxL is a Python-based domain-specific language used to query and transform data collected by Pixie's eBPF probes.

### Basic PxL Script Structure

```python
# basic-http-stats.pxl
import px

# Query HTTP events from the last 5 minutes
df = px.DataFrame(table='http_events', start_time='-5m')

# Enrich with Kubernetes metadata
df.service = df.ctx['service']
df.namespace = df.ctx['namespace']
df.pod = df.ctx['pod']

# Filter to a specific namespace
df = df[df.namespace == 'production']

# Aggregate request rates and error rates by service
df.status_code_class = px.normalize_status_code(df.resp_status)
df = df.groupby(['service', 'status_code_class']).agg(
    request_count=('latency_ns', px.count),
    p50_latency_ms=('latency_ns', px.median),
    p99_latency_ms=('latency_ns', px.quantiles(0.99)),
)

df.p50_latency_ms = df.p50_latency_ms / 1e6
df.p99_latency_ms = df.p99_latency_ms / 1e6

px.display(df, 'http_service_stats')
```

```bash
# Run the script
px run -f basic-http-stats.pxl

# Run a built-in script
px run px/http_data

# Run with arguments
px run px/http_data_filtered_by_pod -- --start_time '-10m' --pod 'payments-pod-abc123'
```

### SQL Query Tracing

```python
# mysql-query-stats.pxl
import px

# Get MySQL queries from the last 10 minutes
df = px.DataFrame(table='mysql_events', start_time='-10m')

# Enrich with Kubernetes context
df.service = df.ctx['service']
df.namespace = df.ctx['namespace']
df.pod = df.ctx['pod']

# Filter to production MySQL traffic
df = df[df.namespace == 'production']

# Normalize SQL queries to remove literal values
df.normalized_query = px.normalize_query(df.req_body)

# Aggregate by query pattern
df = df.groupby(['service', 'normalized_query']).agg(
    execution_count=('latency_ns', px.count),
    mean_latency_ms=('latency_ns', px.mean),
    p99_latency_ms=('latency_ns', px.quantiles(0.99)),
    total_bytes=('req_body', px.sum_bytes),
)

df.mean_latency_ms = df.mean_latency_ms / 1e6
df.p99_latency_ms = df.p99_latency_ms / 1e6

# Show top 20 slowest query patterns
df = df.sort_values(by='p99_latency_ms', ascending=False)
df = df.head(20)

px.display(df, 'slow_mysql_queries')
```

### Network Service Map

```python
# service-map.pxl
import px

# Get all network connections between services
df = px.DataFrame(table='http_events', start_time='-5m')

df.source_service = df.ctx['service']
df.destination_service = px.pod_id_to_service_name(df.remote_addr)
df.namespace = df.ctx['namespace']

# Remove intra-service connections
df = df[df.source_service != df.destination_service]

# Aggregate connection stats
df = df.groupby(['source_service', 'destination_service', 'namespace']).agg(
    request_count=('latency_ns', px.count),
    error_count=('resp_status', lambda s: px.sum(s >= 400)),
    p99_latency_ms=('latency_ns', px.quantiles(0.99)),
)

df.p99_latency_ms = df.p99_latency_ms / 1e6
df.error_rate = df.error_count / df.request_count

px.display(df, 'service_map')
```

### gRPC Tracing

```python
# grpc-stats.pxl
import px

df = px.DataFrame(table='grpc_data', start_time='-5m')

df.service = df.ctx['service']
df.namespace = df.ctx['namespace']
df.pod = df.ctx['pod']

# Filter out health check calls
df = df[df.req_method != '/grpc.health.v1.Health/Check']

# Aggregate per gRPC method
df = df.groupby(['service', 'req_method']).agg(
    call_count=('latency_ns', px.count),
    p50_latency_ms=('latency_ns', px.median),
    p95_latency_ms=('latency_ns', px.quantiles(0.95)),
    p99_latency_ms=('latency_ns', px.quantiles(0.99)),
    error_count=('resp_status', lambda s: px.sum(s != 0)),
)

df.p50_latency_ms = df.p50_latency_ms / 1e6
df.p95_latency_ms = df.p95_latency_ms / 1e6
df.p99_latency_ms = df.p99_latency_ms / 1e6
df.error_rate = df.error_count / df.call_count

px.display(df, 'grpc_method_stats')
```

### Redis Command Analysis

```python
# redis-stats.pxl
import px

df = px.DataFrame(table='redis_events', start_time='-10m')

df.service = df.ctx['service']
df.namespace = df.ctx['namespace']

# Aggregate by Redis command type
df = df.groupby(['service', 'req_cmd']).agg(
    command_count=('latency_ns', px.count),
    mean_latency_us=('latency_ns', px.mean),
    p99_latency_us=('latency_ns', px.quantiles(0.99)),
)

df.mean_latency_us = df.mean_latency_us / 1e3
df.p99_latency_us = df.p99_latency_us / 1e3

# Find slow commands
df = df[df.p99_latency_us > 1000]  # commands slower than 1ms p99

px.display(df, 'slow_redis_commands')
```

### Process CPU and Memory Stats

```python
# pod-resource-stats.pxl
import px

df = px.DataFrame(table='process_stats', start_time='-5m')

df.pod = df.ctx['pod']
df.namespace = df.ctx['namespace']
df.service = df.ctx['service']
df.node = df.ctx['node']

# Aggregate to pod level
df = df.groupby(['pod', 'namespace', 'service', 'node']).agg(
    cpu_usage_pct=('cpu_usage_ns', px.mean),
    vsize_mb=('vsize_bytes', px.mean),
    rss_mb=('rss_bytes', px.mean),
    num_threads=('num_threads', px.mean),
)

df.cpu_usage_pct = df.cpu_usage_pct / 1e9 * 100
df.vsize_mb = df.vsize_mb / 1e6
df.rss_mb = df.rss_mb / 1e6

# Sort by CPU usage
df = df.sort_values(by='cpu_usage_pct', ascending=False)

px.display(df, 'pod_cpu_memory_stats')
```

### Kafka Consumer Lag Visibility

```python
# kafka-stats.pxl
import px

df = px.DataFrame(table='kafka_events', start_time='-5m')

df.service = df.ctx['service']
df.namespace = df.ctx['namespace']

# Distinguish producers from consumers
df.is_producer = df.req_api_key == 0   # Produce API key
df.is_consumer = df.req_api_key == 1   # Fetch API key

df_produce = df[df.is_producer]
df_fetch = df[df.is_consumer]

df_produce = df_produce.groupby(['service', 'req_client_id']).agg(
    produce_count=('latency_ns', px.count),
    p99_produce_latency_ms=('latency_ns', px.quantiles(0.99)),
)
df_produce.p99_produce_latency_ms = df_produce.p99_produce_latency_ms / 1e6

px.display(df_produce, 'kafka_producer_stats')
```

## Built-In Scripts Reference

```bash
# List all available built-in scripts
px get scripts

# Common built-in scripts:

# Cluster overview
px run px/cluster

# HTTP overview for a namespace
px run px/http_data -- --namespace production

# HTTP requests for a specific pod
px run px/http_data_filtered_by_pod -- --pod my-pod-abc123

# Database query stats (MySQL/Postgres)
px run px/mysql_data
px run px/pgsql_data

# Redis stats
px run px/redis_data

# Kubernetes network flow
px run px/net_flow_graph -- --namespace production

# JVM performance stats (Java apps)
px run px/jvm_stats -- --namespace production

# Node performance overview
px run px/node_stats

# DNS queries by pod
px run px/dns_data

# TCP stats
px run px/tcp_stats

# CPU and memory per pod
px run px/pod_stats

# Network map between services
px run px/net_flow_graph
```

## OpenTelemetry Export

Pixie can export traces to OpenTelemetry-compatible backends, integrating into existing distributed tracing stacks.

### OpenTelemetry Plugin Configuration

```yaml
# pixie-otel-plugin.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: pixie-otel-plugin
  namespace: pl
data:
  plugin-config.yaml: |
    otelEndpointConfig:
      url: otel-collector.observability.svc.cluster.local:4317
      headers:
        - key: "Authorization"
          value: "Bearer EXAMPLE_TOKEN_REPLACE_ME"
    spanConfig:
      - name: "http_server_spans"
        table: "http_events"
        spanNameColumn: "req_path"
        startTimeColumn: "time_"
        durationColumn: "latency_ns"
        attributes:
          - column: "resp_status"
            attribute: "http.status_code"
          - column: "req_method"
            attribute: "http.method"
          - column: "req_path"
            attribute: "http.target"
          - column: "ctx['service']"
            attribute: "service.name"
          - column: "ctx['namespace']"
            attribute: "k8s.namespace.name"
          - column: "ctx['pod']"
            attribute: "k8s.pod.name"
        statusConfig:
          okCode: 200
          errorMessage: "resp_status >= 400"
```

### Deploying OpenTelemetry Collector alongside Pixie

```yaml
# otel-collector-for-pixie.yaml
apiVersion: opentelemetry.io/v1alpha1
kind: OpenTelemetryCollector
metadata:
  name: pixie-export
  namespace: observability
spec:
  mode: Deployment
  replicas: 2
  config: |
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
        send_batch_size: 512
      memory_limiter:
        check_interval: 5s
        limit_mib: 512
        spike_limit_mib: 128
      resourcedetection:
        detectors:
          - env
          - k8snode
        timeout: 2s
      k8sattributes:
        filter:
          node_from_env_var: K8S_NODE_NAME
        extract:
          metadata:
            - k8s.pod.name
            - k8s.namespace.name
            - k8s.deployment.name
            - k8s.service.name

    exporters:
      jaeger:
        endpoint: jaeger-collector.observability.svc.cluster.local:14250
        tls:
          insecure: true
      otlp/tempo:
        endpoint: tempo.observability.svc.cluster.local:4317
        tls:
          insecure: true
      prometheus:
        endpoint: 0.0.0.0:8889
        namespace: pixie

    service:
      pipelines:
        traces:
          receivers:
            - otlp
          processors:
            - memory_limiter
            - k8sattributes
            - resourcedetection
            - batch
          exporters:
            - jaeger
            - otlp/tempo
        metrics:
          receivers:
            - otlp
          processors:
            - memory_limiter
            - batch
          exporters:
            - prometheus
```

## Grafana Integration

Pixie provides a Grafana data source plugin for building dashboards directly from PxL query results.

### Install Grafana Plugin

```bash
# Install via Grafana CLI
grafana-cli plugins install pixie-pixie-datasource

# Or add via Helm values
cat >> grafana-values.yaml <<'EOF'
plugins:
  - pixie-pixie-datasource

additionalDataSources:
  - name: Pixie
    type: pixie-pixie-datasource
    access: proxy
    jsonData:
      apiKey: EXAMPLE_TOKEN_REPLACE_ME
      clusterId: <cluster-uuid>
EOF
```

```yaml
# grafana-pixie-datasource-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-pixie-datasource
  namespace: monitoring
  labels:
    grafana_datasource: "1"
data:
  pixie-datasource.yaml: |
    apiVersion: 1
    datasources:
      - name: Pixie
        type: pixie-pixie-datasource
        access: proxy
        jsonData:
          apiKey: EXAMPLE_TOKEN_REPLACE_ME
          clusterId: EXAMPLE_CLUSTER_UUID_REPLACE_ME
          cloudAddr: withpixie.ai:443
```

### Grafana Dashboard Using PxL

```json
{
  "title": "Pixie HTTP Overview",
  "uid": "pixie-http",
  "panels": [
    {
      "title": "HTTP Request Rate by Service",
      "type": "timeseries",
      "datasource": "Pixie",
      "targets": [
        {
          "pxlScript": "import px\ndf = px.DataFrame(table='http_events', start_time='-${__from:date:iso}', end_time='-${__to:date:iso}')\ndf.service = df.ctx['service']\ndf = df.groupby(['time_', 'service']).agg(request_rate=('latency_ns', px.count))\npx.display(df)",
          "timeColumn": "time_",
          "valueColumns": ["request_rate"],
          "groupByColumns": ["service"]
        }
      ]
    },
    {
      "title": "P99 HTTP Latency by Service",
      "type": "timeseries",
      "datasource": "Pixie",
      "targets": [
        {
          "pxlScript": "import px\ndf = px.DataFrame(table='http_events', start_time='-5m')\ndf.service = df.ctx['service']\ndf = df.groupby(['time_', 'service']).agg(p99_ms=('latency_ns', px.quantiles(0.99)))\ndf.p99_ms = df.p99_ms / 1e6\npx.display(df)",
          "timeColumn": "time_",
          "valueColumns": ["p99_ms"],
          "groupByColumns": ["service"]
        }
      ]
    }
  ]
}
```

## Resource Overhead and Performance Impact

Understanding Pixie's resource consumption is critical for capacity planning.

```
┌─────────────────────────────────────────────────────────────────────┐
│              Pixie Resource Consumption Estimates                   │
├──────────────────────┬──────────────────────────────────────────────┤
│ Component            │ Typical Resource Usage                       │
├──────────────────────┼──────────────────────────────────────────────┤
│ vizier-pem           │ 1-4 CPU cores, 2-4 GB RAM per node          │
│                      │ (depends on traffic volume)                  │
│ vizier-query-broker  │ 100m CPU, 128 MB RAM                        │
│ vizier-metadata      │ 100m CPU, 256 MB RAM                        │
│ vizier-cloud-connector│ 50m CPU, 64 MB RAM                         │
│ eBPF CPU overhead    │ 1-5% of node CPU for active tracing         │
│ Data storage         │ In-memory only, configurable per-table limits│
│                      │ Default: ~2 GB total per node               │
├──────────────────────┴──────────────────────────────────────────────┤
│ Data Retention: Default 24 hours (in-memory, non-persistent)        │
│ For longer retention: export via OTel to external stores            │
└─────────────────────────────────────────────────────────────────────┘
```

### Tuning PEM Memory Limits

```yaml
# vizier-pem-tuning.yaml
apiVersion: px.dev/v1alpha1
kind: Vizier
metadata:
  name: pixie
  namespace: pl
spec:
  deployKey: EXAMPLE_TOKEN_REPLACE_ME
  clusterName: production-us-east-1
  pemMemoryRequest: "2Gi"
  pemMemoryLimit: "3Gi"   # Reduce if nodes are memory-constrained
  customDeployParameters:
    # Reduce data table sizes for constrained environments
    PL_TABLE_STORE_DATA_LIMIT_MB: "512"
    # Reduce HTTP events table percentage allocation
    PL_TABLE_STORE_HTTP_EVENTS_PERCENT: "30"
    # Disable TLS tracing to reduce CPU overhead
    PL_DISABLE_SSL_TRACING: "false"
    # Reduce eBPF perf buffer size
    PEM_PERF_BUFFER_SIZE_BYTES: "1048576"  # 1MB
```

## Protocol Coverage and Limitations

```
┌─────────────────────────────────────────────────────────────────────┐
│                   Pixie Protocol Support Matrix                     │
├──────────────────────┬────────────────────┬────────────────────────┤
│ Protocol             │ Support Level      │ Notes                  │
├──────────────────────┼────────────────────┼────────────────────────┤
│ HTTP/1.x             │ Full               │ Headers, body, latency │
│ HTTP/2               │ Full               │ gRPC streams included  │
│ gRPC                 │ Full               │ Method, status, latency│
│ MySQL                │ Full               │ Query text, latency    │
│ PostgreSQL           │ Full               │ Query text, latency    │
│ Redis                │ Full               │ Command, key, latency  │
│ Kafka                │ Full               │ Topic, produce/consume │
│ DNS                  │ Full               │ Query, response, rcode │
│ TLS (OpenSSL)        │ Full               │ Kernel 5.2+, uprobe    │
│ TLS (BoringSSL)      │ Full               │ Go apps, Envoy         │
│ MongoDB              │ Partial            │ Wire protocol          │
│ AMQP (RabbitMQ)      │ Partial            │ Basic ops              │
│ NATS                 │ Limited            │ Pub/sub ops            │
│ UDP protocols        │ No                 │ eBPF limitation        │
│ QUIC/HTTP3           │ Experimental       │ Kernel 5.10+           │
└──────────────────────┴────────────────────┴────────────────────────┘
```

## Monitoring Pixie Health

```bash
# Check Vizier component status
kubectl -n pl get vizier pixie -o yaml | yq '.status'

# Check PEM pod health
kubectl -n pl get pods -l name=vizier-pem
kubectl -n pl logs -l name=vizier-pem --tail=50 | \
  grep -E "ERROR|WARN|failed"

# Check query broker
kubectl -n pl logs deploy/vizier-query-broker --tail=50

# Verify eBPF probes are loading
kubectl -n pl exec -it $(kubectl -n pl get pod -l name=vizier-pem -o name | head -1) -- \
  ls /sys/kernel/debug/tracing/uprobe_events 2>/dev/null | wc -l

# Check PEM data table utilization
px run px/vizier_stats

# Check data collection rates via CLI
px run px/data_collection_stats

# Check for dropped data
kubectl -n pl exec -it $(kubectl -n pl get pod -l name=vizier-pem -o name | head -1) -- \
  cat /proc/$(pgrep pem)/status | grep -E "VmRSS|VmSize"
```

## Excluding Namespaces from Tracing

```bash
# Label namespaces to exclude from Pixie tracing
kubectl label namespace kube-system px/enabled=false
kubectl label namespace cert-manager px/enabled=false
kubectl label namespace monitoring px/enabled=false

# Verify Pixie respects the exclusion
px run px/namespaces
```

## Security Considerations

```
eBPF security model for Pixie:

1. Root privilege requirement:
   - vizier-pem runs as a privileged container
   - Requires CAP_SYS_ADMIN and CAP_BPF for eBPF program loading
   - Consider using OPA/Kyverno to restrict PEM to monitoring nodes only

2. Data sensitivity:
   - Pixie can capture HTTP request/response bodies (configurable)
   - TLS decryption means plaintext credentials may appear in traces
   - Use PxL query access controls to restrict who can query sensitive data
   - Do NOT enable body capture on payment or auth services

3. Network egress:
   - By default, Pixie Cloud receives cluster telemetry metadata
   - For air-gapped environments: deploy self-hosted Pixie control plane

4. RBAC for PxL queries:
   - Pixie Cloud provides RBAC with viewer/editor/admin roles
   - Restrict script execution permissions per-team
```

```yaml
# pixie-network-policy.yaml
# Restrict PEM egress to only required endpoints
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: vizier-pem-egress
  namespace: pl
spec:
  podSelector:
    matchLabels:
      name: vizier-pem
  policyTypes:
    - Egress
  egress:
    # Allow communication with vizier components
    - to:
        - podSelector:
            matchLabels:
              app.kubernetes.io/managed-by: pixie
      ports:
        - protocol: TCP
          port: 50300
    # Allow Kubernetes API access for metadata
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
      ports:
        - protocol: TCP
          port: 443
    # Allow Pixie Cloud (or self-hosted) access
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
      ports:
        - protocol: TCP
          port: 443
```

## Upgrading Pixie

```bash
# Check current Pixie version
kubectl -n pl get vizier pixie -o jsonpath='{.status.version}'

# Update Pixie operator
helm upgrade pixie-operator pixie-operator/pixie-operator \
  --namespace pl \
  --reuse-values

# Pixie Vizier auto-updates when the operator is upgraded
# To pin a specific version:
kubectl -n pl patch vizier pixie \
  --type merge \
  -p '{"spec":{"disableAutoUpdate":true}}'

# Force an immediate version check
kubectl -n pl delete pod -l app.kubernetes.io/managed-by=pixie,name=vizier-cloud-connector
```

## Troubleshooting Common Issues

### PEM Pods Not Starting

```bash
# Check if eBPF is available on nodes
kubectl -n pl describe pod -l name=vizier-pem | grep -A 10 "Events"

# Common issue: kernel version too old
kubectl -n pl logs -l name=vizier-pem | grep -E "kernel|eBPF|BTF"

# Check if debugfs is mounted
kubectl -n pl exec -it $(kubectl -n pl get pod -l name=vizier-pem -o name | head -1) -- \
  ls /sys/kernel/debug/tracing 2>&1

# For nodes without debugfs, mount it
# (Add to node startup script or DaemonSet initContainer)
# mount -t debugfs debugfs /sys/kernel/debug
```

### No Data for a Specific Protocol

```bash
# Verify the protocol is enabled in PEM
px run px/vizier_data_stats

# Check if the service uses a non-standard port
# Pixie autodetects protocols, but may need port hints
kubectl -n pl exec -it $(kubectl -n pl get pod -l name=vizier-pem -o name | head -1) -- \
  /app/pem --print_debug_info 2>&1 | grep "protocol"

# Check for TLS issues (for encrypted traffic)
# Verify OpenSSL/BoringSSL uprobes are attached
kubectl -n pl logs -l name=vizier-pem | grep -E "uprobe|openssl|boring"
```

### High Memory Usage

```bash
# Check per-table memory usage via PxL
px run - <<'EOF'
import px
df = px.DataFrame(table='process_stats', start_time='-1m')
df = df[df.ctx['namespace'] == 'pl']
df = df.groupby(['pod', 'cmdline']).agg(rss_mb=('rss_bytes', px.mean))
df.rss_mb = df.rss_mb / 1e6
df = df.sort_values(by='rss_mb', ascending=False)
px.display(df)
EOF

# Reduce PEM memory limit if needed
kubectl -n pl patch vizier pixie --type merge \
  -p '{"spec":{"pemMemoryLimit":"2Gi","customDeployParameters":{"PL_TABLE_STORE_DATA_LIMIT_MB":"256"}}}'
```

## Summary

Pixie delivers zero-instrumentation observability for Kubernetes workloads through eBPF kernel probes, providing protocol-level visibility that normally requires agents, sidecars, or library instrumentation. The combination of automatic HTTP, gRPC, SQL, and Redis tracing with the PxL scripting language enables rapid root-cause analysis without any application changes. Key operational considerations include: ensuring kernel 4.14+ (5.8+ for TLS decryption) on all nodes; sizing PEM memory limits based on traffic volume and table retention needs; restricting body capture on sensitive endpoints; and using the OpenTelemetry export path to preserve traces beyond Pixie's 24-hour in-memory retention window. Pixie complements rather than replaces Prometheus-based metrics collection — the two work together to provide full-stack observability.
