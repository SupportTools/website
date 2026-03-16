---
title: "Grafana Alloy: The Unified Observability Pipeline for Kubernetes"
date: 2027-01-06T00:00:00-05:00
draft: false
tags: ["Grafana Alloy", "Kubernetes", "Observability", "OpenTelemetry", "Metrics", "Logs"]
categories:
- Kubernetes
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Grafana Alloy as a unified observability pipeline for collecting metrics, logs, traces, and profiles on Kubernetes with the River configuration language."
more_link: "yes"
url: "/grafana-alloy-observability-pipeline-kubernetes-guide/"
---

Production observability stacks often evolve into a collection of specialized agents: Prometheus node-exporter for hardware metrics, Prometheus for scraping application metrics, Fluent Bit or Fluentd for log shipping, OpenTelemetry Collector for traces, and now Pyroscope agents for profiling. Each agent requires its own DaemonSet or Deployment, separate configuration management, independent upgrade cycles, and separate resource budgets. **Grafana Alloy** replaces this sprawl with a single, unified observability pipeline agent that handles metrics, logs, traces, and profiles using a composable pipeline model.

Alloy is the successor to **Grafana Agent** (now in maintenance mode), inheriting Agent's battle-tested collection capabilities while introducing the **River configuration language** — a structured, typed language with module support that replaces Agent's YAML-based configuration. River configurations are composable, referenceable, and statically analyzable, which makes large observability configurations manageable without the YAML anchors and repetition that plague multi-thousand-line agent configurations.

This guide covers a complete production Alloy deployment on Kubernetes including metrics collection with remote write, log collection to Loki, trace forwarding to Tempo, profile collection for Pyroscope, Kubernetes workload auto-discovery, and the clustering mode that enables stateful collection with horizontal scaling.

<!--more-->

## Alloy vs Grafana Agent vs Prometheus

The Grafana observability agent landscape has undergone significant consolidation:

**Prometheus** (with `prometheus-operator`) is the canonical metrics system for Kubernetes. It provides excellent service discovery, a rich query language, and a well-understood operational model. However, Prometheus is designed as a pull-based metrics system with persistent state — it is not a general-purpose telemetry pipeline. Using it to forward logs or traces requires separate agents.

**Grafana Agent** (the predecessor to Alloy) was introduced to provide a lower-footprint Prometheus-compatible scraper with additional support for logs and traces. Agent's YAML configuration was directly compatible with Prometheus configuration, which simplified migration but inherited Prometheus's configuration verbosity.

**Grafana Alloy** introduces River as a first-class configuration language, native OpenTelemetry support as a peer to Prometheus (not an afterthought), and a module system that enables configuration reuse at scale. Alloy also supports the OpenTelemetry Collector's full component ecosystem via the `otelcol.*` component family, positioning it as an OTEL Collector replacement as well.

The migration path: existing Grafana Agent deployments can run Alloy in Agent compatibility mode (`alloy run --stability.level experimental config.agent`) before migrating to River.

Key capability comparison:

| Capability | Prometheus+Exporters | Grafana Agent | Grafana Alloy |
|---|---|---|---|
| Metrics collection | Yes (native) | Yes | Yes |
| Log collection | No | Yes (Loki) | Yes (Loki, OTLP) |
| Trace collection | No | Yes (Tempo) | Yes (Tempo, OTLP) |
| Profile collection | No | Partial | Yes (Pyroscope) |
| OpenTelemetry native | No | Partial | Yes (full OTel) |
| River config language | No | No | Yes |
| Module system | No | No | Yes |
| Clustering/HA | No (federation) | Partial | Yes (native) |
| Stateful collection | Per-instance | Per-instance | Shared (clustered) |

## River Configuration Language Fundamentals

**River** (now called Alloy configuration language in v1.0+) is a declarative, flow-based configuration language where the unit of composition is a **component**. Each component has a type (e.g., `prometheus.scrape`), a label (e.g., `kubernetes_pods`), arguments that configure its behavior, and exports that other components can reference.

Components are connected by passing exports from one component as arguments to another, forming a directed acyclic graph that represents the data flow pipeline:

```hcl
// Basic River component structure
COMPONENT_TYPE "LABEL" {
  // Arguments (inputs to this component)
  argument_name = value_or_reference

  // Block arguments
  block_argument {
    nested_key = "nested_value"
  }
}

// Reference another component's exports
prometheus.scrape "app_metrics" {
  targets    = discovery.kubernetes.pods.targets   // Reference exports from discovery.kubernetes
  forward_to = [prometheus.remote_write.mimir.receiver]  // Forward to remote_write receiver
}
```

River's type system prevents common YAML misconfiguration errors at startup rather than at runtime:

```hcl
// Type examples
string_arg     = "literal string"
number_arg     = 42
bool_arg       = true
duration_arg   = "30s"        // time.Duration
array_arg      = ["a", "b"]   // []string
map_arg        = {"key": "value"}

// Component references are typed — the compiler catches type mismatches
forward_to = [prometheus.remote_write.default.receiver]
//            ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
//            Type: []prometheus.Appendable
```

## Helm Deployment (DaemonSet + StatefulSet)

A production Alloy deployment uses two separate instances:

1. **DaemonSet** (one pod per node): Collects node-level metrics, container logs, and node-level profiles
2. **StatefulSet** (one or more pods): Collects cluster-level metrics (kube-state-metrics, API server) and provides a persistent scrape cache for large clusters

```bash
helm repo add grafana https://grafana.github.io/helm-charts
helm repo update
kubectl create namespace monitoring
```

Create the Alloy DaemonSet configuration (`alloy-daemonset-values.yaml`):

```yaml
# alloy-daemonset-values.yaml
nameOverride: alloy-daemonset

alloy:
  configMap:
    name: alloy-daemonset-config
    key: config.alloy

  # Enable clustering for DaemonSet
  clustering:
    enabled: false    # DaemonSets don't use clustering — each node is independent

  # Security context required for log collection and eBPF
  securityContext:
    privileged: false
    capabilities:
      add:
        - SYS_PTRACE    # For profiling

  podSecurityContext:
    runAsUser: 0        # Required for log file access on the host

  mounts:
    varlog:
      enabled: true     # Mount /var/log for container log collection
      hostPath: /var/log
    dockercontainers:
      enabled: true

controller:
  type: daemonset

  tolerations:
    - effect: NoSchedule
      operator: Exists
    - effect: NoExecute
      operator: Exists

  resources:
    requests:
      cpu: 100m
      memory: 256Mi
    limits:
      cpu: 500m
      memory: 512Mi

serviceAccount:
  create: true
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/alloy-daemonset-role

service:
  enabled: true
  type: ClusterIP

serviceMonitor:
  enabled: true
  namespace: monitoring
```

```bash
helm upgrade --install alloy-daemonset grafana/alloy \
  --namespace monitoring \
  --version 0.9.0 \
  --values alloy-daemonset-values.yaml \
  --set-file alloy.configMap.content=alloy-daemonset-config.alloy \
  --wait
```

## Metrics Collection (Prometheus Remote Write)

The metrics pipeline uses `discovery.kubernetes` to find scrape targets and `prometheus.remote_write` to forward them to Grafana Mimir or any Prometheus-compatible remote write endpoint:

```hcl
// alloy-metrics.alloy — Metrics collection pipeline

// ──────────────────────────────────────────────────────────────────
// Remote Write Destination
// ──────────────────────────────────────────────────────────────────
prometheus.remote_write "mimir" {
  endpoint {
    url = "https://mimir.monitoring.svc.cluster.local:9090/api/v1/push"

    basic_auth {
      username = "alloy"
      password = env("MIMIR_PASSWORD")
    }

    queue_config {
      capacity             = 10000
      max_shards           = 50
      min_shards           = 1
      max_samples_per_send = 2000
      batch_send_deadline  = "5s"
    }

    metadata_config {
      send              = true
      send_interval     = "1m"
      max_samples_per_send = 500
    }
  }

  wal {
    truncate_frequency = "2h"
    max_wal_time       = "4h"
    min_wal_time       = "5m"
  }

  external_labels = {
    cluster     = "prod-us-east-1",
    environment = "production",
    region      = "us-east-1",
  }
}

// ──────────────────────────────────────────────────────────────────
// Node Metrics — collected by DaemonSet instance
// ──────────────────────────────────────────────────────────────────
prometheus.exporter.unix "node" {
  enable_collectors = ["cpu", "diskstats", "filesystem", "loadavg",
                       "meminfo", "netdev", "stat", "time", "uname",
                       "vmstat", "netstat"]
}

prometheus.scrape "node_exporter" {
  targets    = prometheus.exporter.unix.node.targets
  forward_to = [prometheus.remote_write.mimir.receiver]
  scrape_interval = "30s"

  // Add node-identifying labels
  rule {
    action       = "replace"
    target_label = "node"
    replacement  = env("NODE_NAME")
  }
}

// ──────────────────────────────────────────────────────────────────
// Kubernetes Pod Metrics Discovery
// ──────────────────────────────────────────────────────────────────
discovery.kubernetes "pods" {
  role = "pod"

  namespaces {
    own_namespace = false
    names         = []    // Empty = all namespaces
  }
}

discovery.relabel "pods_scrape_targets" {
  targets = discovery.kubernetes.pods.targets

  // Only scrape pods that have opted in via annotation
  rule {
    source_labels = ["__meta_kubernetes_pod_annotation_prometheus_io_scrape"]
    regex         = "true"
    action        = "keep"
  }

  // Support custom metrics path annotation
  rule {
    source_labels = ["__meta_kubernetes_pod_annotation_prometheus_io_path"]
    target_label  = "__metrics_path__"
    regex         = "(.+)"
  }

  // Support custom port annotation
  rule {
    source_labels = ["__meta_kubernetes_pod_annotation_prometheus_io_port",
                     "__meta_kubernetes_pod_ip"]
    target_label  = "__address__"
    regex         = "(\\d+);(.*)"
    replacement   = "$2:$1"
  }

  // Extract pod metadata as labels
  rule {
    source_labels = ["__meta_kubernetes_namespace"]
    target_label  = "namespace"
  }
  rule {
    source_labels = ["__meta_kubernetes_pod_name"]
    target_label  = "pod"
  }
  rule {
    source_labels = ["__meta_kubernetes_pod_label_app"]
    target_label  = "app"
  }
  rule {
    source_labels = ["__meta_kubernetes_pod_label_version"]
    target_label  = "version"
  }

  // Drop high-cardinality labels that inflate storage
  rule {
    regex  = "__meta_kubernetes_pod_label_pod_template_hash"
    action = "labeldrop"
  }
}

prometheus.scrape "kubernetes_pods" {
  targets         = discovery.relabel.pods_scrape_targets.output
  forward_to      = [prometheus.remote_write.mimir.receiver]
  scrape_interval = "30s"
  scrape_timeout  = "10s"
}
```

## Log Collection (Loki)

The log pipeline collects container logs from the host filesystem, parses structured JSON logs, and ships to Loki:

```hcl
// alloy-logs.alloy — Log collection pipeline

// ──────────────────────────────────────────────────────────────────
// Loki Write Destination
// ──────────────────────────────────────────────────────────────────
loki.write "default" {
  endpoint {
    url = "https://loki.monitoring.svc.cluster.local:3100/loki/api/v1/push"

    basic_auth {
      username = "alloy"
      password = env("LOKI_PASSWORD")
    }
  }

  external_labels = {
    cluster     = "prod-us-east-1",
    environment = "production",
  }
}

// ──────────────────────────────────────────────────────────────────
// Kubernetes Pod Log Discovery
// ──────────────────────────────────────────────────────────────────
discovery.kubernetes "pod_logs" {
  role = "pod"
}

discovery.relabel "pod_logs" {
  targets = discovery.kubernetes.pod_logs.targets

  // Drop pods in completed/failed state
  rule {
    source_labels = ["__meta_kubernetes_pod_phase"]
    regex         = "Succeeded|Failed"
    action        = "drop"
  }

  // Set the log file path from the pod UID and container name
  rule {
    source_labels = ["__meta_kubernetes_pod_uid",
                     "__meta_kubernetes_pod_container_name"]
    target_label  = "__path__"
    separator     = "/"
    replacement   = "/var/log/pods/*$1/*.log"
  }

  // Extract metadata for log labels
  rule {
    source_labels = ["__meta_kubernetes_namespace"]
    target_label  = "namespace"
  }
  rule {
    source_labels = ["__meta_kubernetes_pod_name"]
    target_label  = "pod"
  }
  rule {
    source_labels = ["__meta_kubernetes_pod_container_name"]
    target_label  = "container"
  }
  rule {
    source_labels = ["__meta_kubernetes_pod_label_app"]
    target_label  = "app"
  }
  rule {
    source_labels = ["__meta_kubernetes_pod_node_name"]
    target_label  = "node"
  }
}

// ──────────────────────────────────────────────────────────────────
// Log File Tailing and Processing
// ──────────────────────────────────────────────────────────────────
loki.source.file "pod_logs" {
  targets    = discovery.relabel.pod_logs.output
  forward_to = [loki.process.pod_logs.receiver]
}

loki.process "pod_logs" {
  forward_to = [loki.write.default.receiver]

  // Stage 1: Parse the containerd/docker log format wrapper
  stage.cri {}

  // Stage 2: Try to parse the log body as JSON
  stage.json {
    expressions = {
      level      = "level",
      msg        = "msg",
      timestamp  = "time",
      trace_id   = "traceID",
      span_id    = "spanID",
      error      = "error",
    }
  }

  // Stage 3: Extract structured log fields as labels (only low-cardinality fields)
  stage.labels {
    values = {
      level = "",   // Use extracted "level" value
    }
  }

  // Stage 4: Drop DEBUG logs from non-critical services in production
  stage.drop {
    source    = "level"
    value     = "debug"
    drop_counter_reason = "debug_log_dropped"
  }

  // Stage 5: Add trace correlation label if present
  stage.label_keep {
    values = ["namespace", "pod", "container", "app", "node", "level"]
  }

  // Stage 6: Set timestamp from log record if available
  stage.timestamp {
    source = "timestamp"
    format = "RFC3339"
    fallback_formats = ["2006-01-02T15:04:05.999999999Z07:00"]
  }
}
```

## Trace Collection (Tempo via OTLP)

The trace pipeline receives spans via OTLP from instrumented services and forwards to Grafana Tempo:

```hcl
// alloy-traces.alloy — Trace collection pipeline

// ──────────────────────────────────────────────────────────────────
// OTLP Receiver — accepts traces from services
// ──────────────────────────────────────────────────────────────────
otelcol.receiver.otlp "default" {
  grpc {
    endpoint = "0.0.0.0:4317"
  }
  http {
    endpoint = "0.0.0.0:4318"
  }
  output {
    traces = [otelcol.processor.batch.default.input]
  }
}

// ──────────────────────────────────────────────────────────────────
// Batch Processor — reduces number of export requests
// ──────────────────────────────────────────────────────────────────
otelcol.processor.batch "default" {
  timeout              = "5s"
  send_batch_size      = 10000
  send_batch_max_size  = 20000

  output {
    traces = [otelcol.processor.attributes.default.input]
  }
}

// ──────────────────────────────────────────────────────────────────
// Attributes Processor — enrich spans with cluster metadata
// ──────────────────────────────────────────────────────────────────
otelcol.processor.attributes "default" {
  action {
    key    = "k8s.cluster.name"
    value  = "prod-us-east-1"
    action = "insert"
  }
  action {
    key    = "deployment.environment"
    value  = "production"
    action = "insert"
  }

  output {
    traces = [otelcol.exporter.otlphttp.tempo.input]
  }
}

// ──────────────────────────────────────────────────────────────────
// Tempo Exporter
// ──────────────────────────────────────────────────────────────────
otelcol.exporter.otlphttp "tempo" {
  client {
    endpoint = "http://tempo-distributor.monitoring.svc.cluster.local:4318"
    tls {
      insecure = true
    }
    retry_on_failure {
      enabled         = true
      initial_interval = "5s"
      max_interval    = "30s"
      max_elapsed_time = "300s"
    }
    sending_queue {
      enabled    = true
      num_consumers = 10
      queue_size = 5000
    }
  }
}

// ──────────────────────────────────────────────────────────────────
// Span Metrics — generate RED metrics from traces
// ──────────────────────────────────────────────────────────────────
otelcol.connector.spanmetrics "default" {
  namespace     = "traces_spanmetrics"
  histogram {
    explicit {
      buckets = ["2ms", "4ms", "6ms", "8ms", "10ms", "50ms",
                 "100ms", "200ms", "400ms", "800ms", "1s", "1400ms",
                 "2s", "5s", "10s", "15s"]
    }
  }
  dimensions = [
    { name = "http.method" },
    { name = "http.status_code" },
    { name = "rpc.method" },
    { name = "rpc.service" },
    { name = "db.system" },
  ]
  output {
    metrics = [otelcol.exporter.prometheus.span_metrics.input]
  }
}

otelcol.exporter.prometheus "span_metrics" {
  forward_to = [prometheus.remote_write.mimir.receiver]
}
```

## Profile Collection (Pyroscope)

Alloy's profiling components collect CPU profiles via eBPF and language-specific profilers:

```hcl
// alloy-profiles.alloy — Profile collection pipeline

// ──────────────────────────────────────────────────────────────────
// eBPF-based CPU profiling — zero code changes required
// ──────────────────────────────────────────────────────────────────
discovery.kubernetes "profiling_pods" {
  role = "pod"
}

discovery.relabel "profiling_targets" {
  targets = discovery.kubernetes.profiling_pods.targets

  // Skip pods that opt out of profiling
  rule {
    source_labels = ["__meta_kubernetes_pod_annotation_pyroscope_io_scrape"]
    regex         = "false"
    action        = "drop"
  }

  rule {
    source_labels = ["__meta_kubernetes_namespace"]
    target_label  = "namespace"
  }
  rule {
    source_labels = ["__meta_kubernetes_pod_name"]
    target_label  = "pod"
  }
  rule {
    source_labels = ["__meta_kubernetes_pod_label_app"]
    target_label  = "app"
  }
  rule {
    source_labels = ["__meta_kubernetes_pod_node_name"]
    target_label  = "node"
  }
}

pyroscope.ebpf "cpu_profiles" {
  targets        = discovery.relabel.profiling_targets.output
  forward_to     = [pyroscope.write.default.receiver]
  demangle       = "full"
  python_enabled = true
}

pyroscope.java "jvm_profiles" {
  targets    = discovery.relabel.profiling_targets.output
  forward_to = [pyroscope.write.default.receiver]

  profiling_config {
    interval    = "60s"
    cpu         = true
    alloc       = "512k"
    lock        = "10ms"
    sample_rate = 100
  }
}

pyroscope.write "default" {
  endpoint {
    url = "http://pyroscope-query-frontend.pyroscope.svc.cluster.local:4040"
  }

  external_labels = {
    cluster     = "prod-us-east-1",
    environment = "production",
  }
}
```

## Auto-Discovery of Kubernetes Workloads

Alloy's `discovery.kubernetes` supports all Kubernetes resource roles. For operator-managed scraping (like `ServiceMonitor` resources), use the `prometheus.operator.*` components:

```hcl
// alloy-autodiscovery.alloy — Operator CRD-based discovery

// ──────────────────────────────────────────────────────────────────
// ServiceMonitor-based discovery (Prometheus Operator compatibility)
// ──────────────────────────────────────────────────────────────────
prometheus.operator.servicemonitors "default" {
  namespaces = []    // Empty = all namespaces

  // Restrict to ServiceMonitors in specific namespaces
  selector {
    match_labels = {
      "prometheus.io/monitor" = "true",
    }
  }

  forward_to = [prometheus.remote_write.mimir.receiver]

  scrape {
    default_scrape_interval = "30s"
    default_scrape_timeout  = "10s"
  }
}

// ──────────────────────────────────────────────────────────────────
// PodMonitor-based discovery
// ──────────────────────────────────────────────────────────────────
prometheus.operator.podmonitors "default" {
  namespaces = []
  forward_to = [prometheus.remote_write.mimir.receiver]
}

// ──────────────────────────────────────────────────────────────────
// kube-state-metrics — cluster object state metrics
// ──────────────────────────────────────────────────────────────────
discovery.kubernetes "kube_state_metrics" {
  role = "endpoints"
  namespaces {
    names = ["monitoring"]
  }
  selectors {
    role  = "endpoints"
    label = "app.kubernetes.io/name=kube-state-metrics"
  }
}

prometheus.scrape "kube_state_metrics" {
  targets         = discovery.kubernetes.kube_state_metrics.targets
  forward_to      = [prometheus.remote_write.mimir.receiver]
  scrape_interval = "30s"
  honor_labels    = true    // Preserve labels set by kube-state-metrics
}

// ──────────────────────────────────────────────────────────────────
// Kubernetes API server metrics
// ──────────────────────────────────────────────────────────────────
discovery.kubernetes "apiserver" {
  role = "endpoints"
  namespaces {
    names = ["default"]
  }
  selectors {
    role  = "endpoints"
    label = "component=apiserver,provider=kubernetes"
  }
}

prometheus.scrape "apiserver" {
  targets         = discovery.kubernetes.apiserver.targets
  forward_to      = [prometheus.remote_write.mimir.receiver]
  scrape_interval = "30s"
  scheme          = "https"
  bearer_token_file = "/var/run/secrets/kubernetes.io/serviceaccount/token"

  tls_config {
    ca_file = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
  }
}
```

## Processing Pipelines (Relabeling, Filtering)

Production-scale clusters generate enormous metric volumes. Processing pipelines reduce cardinality and costs:

```hcl
// alloy-processing.alloy — Metric filtering and relabeling

// ──────────────────────────────────────────────────────────────────
// Drop high-cardinality metrics not used in any dashboard or alert
// ──────────────────────────────────────────────────────────────────
prometheus.relabel "drop_unused_metrics" {
  forward_to = [prometheus.remote_write.mimir.receiver]

  // Drop go runtime internal metrics (too fine-grained, available via profiling)
  rule {
    source_labels = ["__name__"]
    regex         = "go_gc_duration_seconds_.*"
    action        = "drop"
  }

  // Drop per-path HTTP metrics that create high cardinality
  // Keep only the aggregate without path label
  rule {
    source_labels = ["__name__", "path"]
    regex         = "http_request_duration_seconds_.+;/api/v1/users/\\d+"
    action        = "drop"
  }

  // Normalize path label by dropping user IDs
  rule {
    source_labels = ["path"]
    target_label  = "path"
    regex         = "(/api/v[0-9]+/users)/[0-9]+(.*)"
    replacement   = "$1/:id$2"
  }

  // Drop metrics from test namespaces in production remote_write
  rule {
    source_labels = ["namespace"]
    regex         = "test-.*|dev-.*|qa-.*"
    action        = "drop"
  }
}

// ──────────────────────────────────────────────────────────────────
// Metric aggregation — reduce series count for high-volume metrics
// ──────────────────────────────────────────────────────────────────
prometheus.relabel "aggregate_per_pod_metrics" {
  forward_to = [prometheus.remote_write.mimir.receiver]

  // For per-container resource metrics, drop the pod label to aggregate
  // at the Deployment level (handled in Grafana via app label instead)
  rule {
    source_labels = ["__name__"]
    regex         = "container_cpu_usage_seconds_total|container_memory_working_set_bytes"
    target_label  = "__tmp_high_cardinality"
    replacement   = "true"
  }

  // Drop the specific container_id label for high-cardinality metrics
  rule {
    source_labels = ["__tmp_high_cardinality", "container_id"]
    regex         = "true;.+"
    target_label  = "container_id"
    replacement   = ""
  }
}
```

## Clustering Mode for High Availability

Alloy's **clustering mode** allows multiple Alloy instances to share scrape targets, preventing duplicate collection and enabling horizontal scaling. This is particularly valuable for clusters with thousands of scrape targets.

```yaml
# alloy-statefulset-values.yaml — StatefulSet for clustered mode
nameOverride: alloy-cluster

alloy:
  clustering:
    enabled: true
    name: alloy-cluster

  stabilityLevel: generally-available

controller:
  type: statefulset
  replicas: 3

  podAnnotations:
    cluster-autoscaler.kubernetes.io/safe-to-evict: "false"

  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              app.kubernetes.io/name: alloy-cluster
          topologyKey: kubernetes.io/hostname

  resources:
    requests:
      cpu: 500m
      memory: 1Gi
    limits:
      cpu: 2000m
      memory: 4Gi

  persistentVolumeClaimRetentionPolicy:
    whenDeleted: Retain
    whenScaled: Retain

  volumeClaimTemplates:
    - apiVersion: v1
      kind: PersistentVolumeClaim
      metadata:
        name: alloy-wal
      spec:
        accessModes: [ReadWriteOnce]
        storageClassName: gp3
        resources:
          requests:
            storage: 20Gi
```

Configure clustering in the River config:

```hcl
// alloy-cluster-config.alloy — Clustered Alloy configuration

// Enable clustering — Alloy instances automatically discover peers via DNS
clustering {
  enabled = true
}

// With clustering enabled, discovery components automatically shard targets
// across cluster members. Each instance only scrapes its assigned targets.
prometheus.scrape "kubernetes_pods_clustered" {
  targets    = discovery.relabel.pods_scrape_targets.output
  forward_to = [prometheus.remote_write.mimir.receiver]

  // Clustering shards this target list automatically
  clustering {
    enabled = true
  }
}

// ──────────────────────────────────────────────────────────────────
// Self-monitoring — Alloy scrapes its own metrics
// ──────────────────────────────────────────────────────────────────
prometheus.scrape "alloy_self" {
  targets = [{
    __address__ = "localhost:12345",
    job         = "alloy",
    cluster     = "prod-us-east-1",
  }]
  forward_to      = [prometheus.remote_write.mimir.receiver]
  scrape_interval = "15s"
}
```

Verify cluster formation:

```bash
# Check cluster member status
kubectl exec -n monitoring alloy-cluster-0 -- \
  alloy cluster --server.http.listen-addr=localhost:12345

# View clustering debug information
kubectl port-forward -n monitoring svc/alloy-cluster 12345:12345
curl -s http://localhost:12345/api/v0/web/metrics | grep alloy_cluster
```

## Grafana Alloy UI and Debugging

Alloy exposes a built-in web UI for debugging the component graph and inspecting pipeline state:

```bash
# Port-forward to access the Alloy UI
kubectl port-forward -n monitoring svc/alloy-daemonset 12345:12345

# Open in browser: http://localhost:12345
# The UI shows:
# - Component graph visualization
# - Component health status
# - Export values from each component
# - Live metric values
```

Common debugging patterns:

```bash
# Check if a specific component is healthy
curl -s http://localhost:12345/api/v0/component/prometheus.scrape/kubernetes_pods | \
  jq '.health'

# View active scrape targets
curl -s http://localhost:12345/api/v0/component/prometheus.scrape/kubernetes_pods | \
  jq '.component_health.health_message'

# Check WAL status
curl -s http://localhost:12345/api/v0/component/prometheus.remote_write/mimir | \
  jq '.data.exports'

# Reload configuration without restart
curl -X POST http://localhost:12345/api/v0/ready
```

PrometheusRule for Alloy health monitoring:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: alloy-health-alerts
  namespace: monitoring
spec:
  groups:
    - name: alloy.health
      interval: 30s
      rules:
        - alert: AlloyComponentUnhealthy
          expr: |
            alloy_component_controller_running_components{health_type!="healthy"} > 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "{{ $value }} Alloy components are unhealthy on {{ $labels.instance }}"
            description: "Alloy component health check failed. Telemetry collection may be disrupted."

        - alert: AlloyRemoteWriteBacklogged
          expr: |
            prometheus_remote_storage_pending_samples{job="alloy"} > 100000
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "Alloy remote write queue has more than 100,000 pending samples"
            description: "{{ $value }} samples pending. Remote write endpoint may be slow or unavailable."

        - alert: AlloyLokiSendFailures
          expr: |
            rate(loki_write_sent_entries_total{status="fail"}[5m]) > 0
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Alloy is failing to send log entries to Loki"
            description: "Failure rate: {{ $value | humanize }} entries/sec. Check Loki connectivity."
```

## Conclusion

Grafana Alloy provides a unified, composable observability pipeline that eliminates the operational burden of maintaining separate agents for metrics, logs, traces, and profiles. Key takeaways from this guide:

- The River configuration language's typed component model makes large observability configurations maintainable; component references are statically validated at startup, catching errors before they cause silent data loss
- Deploy a DaemonSet for node-level collection (container logs, node metrics, eBPF profiles) and a StatefulSet in clustering mode for cluster-level collection (kube-state-metrics, API server) — these have different resource profiles and failure characteristics
- Alloy's `prometheus.operator.servicemonitors` and `prometheus.operator.podmonitors` components provide Prometheus Operator compatibility without running a full Prometheus instance, enabling migration from large Prometheus deployments to Alloy as a remote-write proxy
- Processing pipelines (metric relabeling, log filtering) belong in Alloy rather than in the backend (Mimir, Loki) — reducing volume at the pipeline edge is far cheaper than storing and then ignoring high-cardinality data
- Clustering mode is not optional for production clusters with more than a few hundred scrape targets; without it, independent Alloy instances scrape all targets, multiplying costs and creating inconsistent retention across the cluster
