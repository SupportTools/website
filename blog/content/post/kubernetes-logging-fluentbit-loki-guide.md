---
title: "Kubernetes Logging Architecture: Fluent Bit to Loki Production Setup"
date: 2028-01-12T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Logging", "Fluent Bit", "Loki", "Grafana", "Observability", "Production"]
categories:
- Kubernetes
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive production guide to Kubernetes logging with Fluent Bit and Loki covering DaemonSet configuration, label cardinality optimization, Lua parsing, multi-line log handling, Kubernetes metadata enrichment, log rotation, retention policies, and LogQL alert rules."
more_link: "yes"
url: "/kubernetes-logging-fluentbit-loki-guide/"
---

Kubernetes logging at production scale requires careful design to avoid two common failure modes: log loss during high-throughput periods and storage explosion from careless label cardinality. Fluent Bit, with its C-based implementation and minimal memory footprint, is the industry standard log collector for Kubernetes. Loki, with its label-indexed architecture that avoids full-text indexing, provides cost-effective log storage that integrates directly into Grafana dashboards. This guide covers the production deployment of the complete Fluent Bit to Loki pipeline, from DaemonSet configuration through Lua parsing, multi-line handling, and LogQL alerting.

<!--more-->

# Kubernetes Logging Architecture: Fluent Bit to Loki Production Setup

## Section 1: Architecture Overview

### Log Flow in Kubernetes

```
┌──────────────────────────────────────────────────────────┐
│                     Kubernetes Node                       │
│                                                           │
│  ┌─────────────┐  stdout/stderr  ┌────────────────────┐  │
│  │  Container  │────────────────▶│  containerd        │  │
│  └─────────────┘                 │  /var/log/pods/    │  │
│                                  └─────────┬──────────┘  │
│                                            │ tail        │
│  ┌─────────────────────────────────────────▼──────────┐  │
│  │         Fluent Bit (DaemonSet)                     │  │
│  │  Input: tail  →  Filter  →  Output: loki           │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
                              │ HTTP (push)
                    ┌─────────▼─────────┐
                    │    Loki           │
                    │  (StatefulSet)    │
                    └─────────┬─────────┘
                              │
                    ┌─────────▼─────────┐
                    │  Grafana          │
                    │  (LogQL queries)  │
                    └───────────────────┘
```

### Key Design Decisions

**Label cardinality**: Loki indexes labels and stores chunks per unique label combination. High-cardinality labels (pod name, IP address, request ID) create millions of streams and degrade performance. Only use low-cardinality labels: namespace, app, environment, cluster.

**Chunk size**: Loki groups log lines into chunks before storing. Larger chunks are more efficient but introduce latency. The default is 256KB with a flush interval of 1 minute.

**Ordering**: Loki requires log lines within a stream to be in non-decreasing timestamp order. Out-of-order logs within the same stream cause ingestion errors.

## Section 2: Loki Installation and Configuration

### Loki Helm Deployment (Distributed Mode)

```bash
helm repo add grafana https://grafana.github.io/helm-charts
helm repo update

helm install loki grafana/loki \
  --namespace logging \
  --create-namespace \
  --version 5.41.0 \
  --values loki-values.yaml
```

```yaml
# loki-values.yaml
loki:
  auth_enabled: false  # Enable in multi-tenant deployments

  commonConfig:
    replication_factor: 3

  storage:
    type: s3
    bucketNames:
      chunks: loki-chunks-prod
      ruler: loki-ruler-prod
      admin: loki-admin-prod
    s3:
      region: us-east-1
      # Use IAM role via IRSA, not static credentials
      sse_encryption: true

  schemaConfig:
    configs:
    - from: 2024-01-01
      store: tsdb
      object_store: s3
      schema: v13
      index:
        prefix: loki_index_
        period: 24h

  ingester:
    chunk_encoding: snappy
    chunk_idle_period: 30m
    chunk_block_size: 262144   # 256KB
    max_chunk_age: 2h
    chunk_retain_period: 1m
    wal:
      enabled: true
      dir: /var/loki/wal
      flush_on_shutdown: true

  querier:
    max_concurrent: 20
    engine:
      max_look_back_period: 30m

  query_range:
    results_cache:
      cache:
        redis:
          endpoint: redis.logging.svc:6379

  limits_config:
    # Max ingestion rate per tenant
    ingestion_rate_mb: 32
    ingestion_burst_size_mb: 64
    # Max label count per log line
    max_label_names_per_series: 15
    # Max log line length
    max_line_size: 65536
    # Retention
    retention_period: 30d
    # Query limits
    max_query_time_range: 721h  # 30 days
    max_entries_limit_per_query: 10000

  rulerConfig:
    storage:
      type: s3
      s3:
        bucketnames: loki-ruler-prod
        region: us-east-1
    rule_path: /tmp/loki/scratch
    alertmanager_url: http://alertmanager.monitoring.svc:9093

  compactor:
    working_directory: /var/loki/boltdb-cache
    retention_enabled: true
    retention_delete_delay: 2h
    retention_delete_worker_count: 150

serviceAccount:
  annotations:
    # IRSA for S3 access (AWS)
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/loki-s3-role

read:
  replicas: 3
  resources:
    requests:
      cpu: 500m
      memory: 1Gi
    limits:
      cpu: 2
      memory: 4Gi

write:
  replicas: 3
  resources:
    requests:
      cpu: 500m
      memory: 2Gi
    limits:
      cpu: 2
      memory: 4Gi

backend:
  replicas: 3
  persistence:
    size: 50Gi
    storageClass: gp3
```

## Section 3: Fluent Bit DaemonSet Configuration

### Helm-Based Fluent Bit Deployment

```bash
helm repo add fluent https://fluent.github.io/helm-charts
helm repo update

helm install fluent-bit fluent/fluent-bit \
  --namespace logging \
  --values fluent-bit-values.yaml
```

```yaml
# fluent-bit-values.yaml
image:
  repository: cr.fluentbit.io/fluent/fluent-bit
  tag: "3.0.4"

tolerations:
- operator: Exists

resources:
  requests:
    cpu: 100m
    memory: 64Mi
  limits:
    cpu: 500m
    memory: 256Mi

podAnnotations:
  prometheus.io/scrape: "true"
  prometheus.io/port: "2020"

service:
  type: ClusterIP
  port: 2020

serviceMonitor:
  enabled: true
  namespace: monitoring

# Reference the main config from a ConfigMap
config:
  service: |
    [SERVICE]
        Daemon           Off
        Flush            5
        Log_Level        warn
        Parsers_File     /fluent-bit/etc/parsers.conf
        Parsers_File     /fluent-bit/etc/conf/custom_parsers.conf
        HTTP_Server      On
        HTTP_Listen      0.0.0.0
        HTTP_Port        2020
        storage.metrics  On
        storage.path     /var/fluent-bit/state/flb-storage/
        storage.sync     normal
        storage.checksum off
        storage.backlog.mem_limit 50M
        Health_Check     On

  inputs: |
    [INPUT]
        Name              tail
        Path              /var/log/containers/*.log
        # Exclude infrastructure namespaces from high-volume collection
        Exclude_Path      /var/log/containers/*_kube-system_*.log,/var/log/containers/*_kube-public_*.log
        Tag               kube.<namespace_name>.<pod_name>.<container_name>
        Tag_Regex         (?<pod_name>[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*)_(?<namespace_name>[^_]+)_(?<container_name>.+)-(?<docker_id>[a-z0-9]{64}).log
        Read_from_Head    false
        Refresh_Interval  5
        Rotate_Wait       30
        Mem_Buf_Limit     50MB
        Skip_Long_Lines   On
        DB                /var/fluent-bit/state/flb_kube.db
        DB.Sync           Normal

    # Capture kube-system separately for debugging
    [INPUT]
        Name              tail
        Path              /var/log/containers/*_kube-system_*.log
        Exclude_Path      /var/log/containers/fluent-bit*.log
        Tag               kube.kube-system.<pod_name>.<container_name>
        Tag_Regex         (?<pod_name>[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*)_(?<namespace_name>[^_]+)_(?<container_name>.+)-(?<docker_id>[a-z0-9]{64}).log
        Read_from_Head    false
        Refresh_Interval  10
        Mem_Buf_Limit     10MB
        Skip_Long_Lines   On
        DB                /var/fluent-bit/state/flb_kube_system.db
        DB.Sync           Normal

  filters: |
    # Parse the CRI log format (containerd)
    [FILTER]
        Name             parser
        Match            kube.*
        Key_Name         log
        Parser           cri
        Reserve_Data     On
        Preserve_Key     On

    # Enrich with Kubernetes metadata
    [FILTER]
        Name             kubernetes
        Match            kube.*
        Kube_URL         https://kubernetes.default.svc:443
        Kube_CA_File     /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
        Kube_Token_File  /var/run/secrets/kubernetes.io/serviceaccount/token
        Kube_Tag_Prefix  kube.
        Merge_Log        On
        Merge_Log_Key    log_processed
        Keep_Log         Off
        K8S-Logging.Parser  On
        K8S-Logging.Exclude Off
        Annotations      Off
        Labels           On
        # Only include specific labels to reduce cardinality
        # (label_include requires Fluent Bit 3.0+)
        label_include    app,version,component

    # Apply Lua transformation for structured log parsing
    [FILTER]
        Name  lua
        Match kube.*
        script /fluent-bit/scripts/normalize.lua
        call   normalize_log

    # Drop debug logs in production
    [FILTER]
        Name   grep
        Match  kube.*
        Exclude level debug

    # Throttle to prevent log floods (10000 records/minute per tag)
    [FILTER]
        Name          throttle
        Match         kube.*
        Rate          10000
        Window        60
        Print_Status  true

  outputs: |
    [OUTPUT]
        Name                  loki
        Match                 kube.*
        Host                  loki-gateway.logging.svc
        Port                  80
        Labels                job=fluent-bit, cluster=prod-us-east, namespace=$kubernetes['namespace_name'], app=$kubernetes['labels']['app']
        Remove_Keys           kubernetes, docker_id, stream
        Auto_Kubernetes_Labels off
        Line_Format           json
        Log_Level             warn
        Workers               4
        # Buffer failed pushes in storage
        storage.total_limit_size 1G
        Retry_Limit           False
        # Batch settings
        Batch_Size            1048576
        Batch_Wait            0.5

    # Also forward error logs to an alerting system
    [OUTPUT]
        Name    forward
        Match   kube.*
        Host    fluentd-aggregator.logging.svc
        Port    24224
        # Only forward error-level logs
        # (filter applied above via grep)

  customParsers: |
    [PARSER]
        Name        cri
        Format      regex
        Regex       ^(?<time>[^ ]+) (?<stream>stdout|stderr) (?<logtag>[^ ]*) (?<log>.*)$
        Time_Key    time
        Time_Format %Y-%m-%dT%H:%M:%S.%L%z

    [PARSER]
        Name        json_log
        Format      json
        Time_Key    time
        Time_Format %Y-%m-%dT%H:%M:%S.%LZ
        Time_Keep   On

    [PARSER]
        Name        logfmt
        Format      logfmt
        Time_Key    time
        Time_Format %Y-%m-%dT%H:%M:%S.%LZ

  extraVolumes:
  - name: fluent-bit-scripts
    configMap:
      name: fluent-bit-scripts
  - name: fluent-bit-state
    hostPath:
      path: /var/fluent-bit/state
      type: DirectoryOrCreate
  - name: varlog
    hostPath:
      path: /var/log

  extraVolumeMounts:
  - name: fluent-bit-scripts
    mountPath: /fluent-bit/scripts
  - name: fluent-bit-state
    mountPath: /var/fluent-bit/state
  - name: varlog
    mountPath: /var/log
    readOnly: true
```

## Section 4: Lua Log Parsing

Lua scripts in Fluent Bit enable complex transformations that cannot be expressed with the built-in filter plugins.

### Normalize Log Format

```lua
-- normalize.lua
-- Normalizes log entries from multiple formats into a consistent structure

function normalize_log(tag, timestamp, record)
    -- Skip empty logs
    if record["log"] == nil or record["log"] == "" then
        return -1, timestamp, record  -- -1 = drop record
    end

    local log = record["log"]

    -- Try to detect and parse structured JSON logs
    local json_match = log:match("^%s*{")
    if json_match then
        -- JSON log detected; Fluent Bit's Merge_Log handles parsing
        -- Just add normalization metadata
        record["log_format"] = "json"
    else
        -- Parse common unstructured formats

        -- Detect Go log format: "2024/01/06 10:00:00 message"
        local ts, msg = log:match("^(%d%d%d%d/%d%d/%d%d %d%d:%d%d:%d%d) (.+)$")
        if ts ~= nil then
            record["log_format"] = "go_std"
            record["message"] = msg
        end

        -- Detect logfmt: key=value pairs
        if log:match("^%a+=%S+") then
            record["log_format"] = "logfmt"
            -- Extract level if present
            local level = log:match("level=(%a+)")
            if level ~= nil then
                record["level"] = level:lower()
            end
            local msg_match = log:match('msg="([^"]+)"') or log:match("msg=(%S+)")
            if msg_match ~= nil then
                record["message"] = msg_match
            end
        end
    end

    -- Normalize log level field names
    local level = record["level"] or record["severity"] or record["lvl"]
    if level ~= nil then
        record["level"] = level:lower()
        -- Remove duplicate fields
        record["severity"] = nil
        record["lvl"] = nil
    end

    -- Add cluster label from environment
    if record["cluster"] == nil then
        record["cluster"] = os.getenv("CLUSTER_NAME") or "unknown"
    end

    -- Truncate very long log lines (Loki max line size protection)
    if #record["log"] > 16384 then
        record["log"] = record["log"]:sub(1, 16384) .. " [TRUNCATED]"
        record["truncated"] = "true"
    end

    return 1, timestamp, record  -- 1 = modify record
end

-- Extract trace IDs from logs for correlation
function extract_trace_id(tag, timestamp, record)
    local log = record["log"] or ""

    -- OpenTelemetry trace ID format
    local trace_id = log:match("trace_id=([a-f0-9]+)")
                  or log:match('"trace_id":"([a-f0-9]+)"')
                  or log:match('"traceId":"([a-f0-9]+)"')

    if trace_id ~= nil then
        record["trace_id"] = trace_id
    end

    local span_id = log:match("span_id=([a-f0-9]+)")
                 or log:match('"span_id":"([a-f0-9]+)"')

    if span_id ~= nil then
        record["span_id"] = span_id
    end

    return 1, timestamp, record
end
```

```yaml
# fluent-bit-scripts-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: fluent-bit-scripts
  namespace: logging
data:
  normalize.lua: |
    -- (Lua script content from above)
```

## Section 5: Multi-Line Log Handling

Applications that produce stack traces or multi-line JSON blobs require special handling to prevent Fluent Bit from splitting them into separate log entries.

### Multi-Line Parser Configuration

```yaml
# multi-line parser in fluent-bit config
customParsers: |
  # Java exception stack trace parser
  [MULTILINE_PARSER]
      Name         java_multiline
      Type         regex
      Flush_Timeout 1000
      # First line starts with a date
      Rule         "start_state"   "/(^[12]\d{3}-(0[1-9]|1[0-2])-\d{2}[ T]\d{2}:\d{2}:\d{2})/" "java_after_date"
      # Any line starting with whitespace or "Caused by" or "at " is a continuation
      Rule         "java_after_date" "/(\s+at |Caused by:|\.{3})/" "java_after_date"

  # Python traceback parser
  [MULTILINE_PARSER]
      Name         python_traceback
      Type         regex
      Flush_Timeout 1000
      Rule         "start_state"   "/^Traceback \(most recent call last\):$/" "python_in_traceback"
      Rule         "python_in_traceback" "/^  File/" "python_in_traceback"
      Rule         "python_in_traceback" "/^\w+Error:/" "python_end"
      Rule         "python_end"    "/^$/" "start_state"

  # Go panic parser
  [MULTILINE_PARSER]
      Name         go_panic
      Type         regex
      Flush_Timeout 500
      Rule         "start_state"   "/^goroutine \d+ \[/" "go_in_panic"
      Rule         "go_in_panic"   "/^(goroutine|\t|created by|\s)/" "go_in_panic"
```

### Multi-Line Input Configuration

```yaml
inputs: |
  [INPUT]
      Name              tail
      Path              /var/log/containers/*_production_*.log
      Tag               kube.production.<pod_name>.<container_name>
      Tag_Regex         (?<pod_name>[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*)_(?<namespace_name>[^_]+)_(?<container_name>.+)-(?<docker_id>[a-z0-9]{64}).log
      multiline.parser  java_multiline,python_traceback,go_panic,docker,cri
      Read_from_Head    false
      Mem_Buf_Limit     100MB
      Skip_Long_Lines   On
      DB                /var/fluent-bit/state/flb_production.db
```

## Section 6: Kubernetes Metadata Enrichment

The `kubernetes` filter enriches log records with pod metadata from the Kubernetes API.

### Optimizing Kubernetes Filter Performance

```yaml
filters: |
  [FILTER]
      Name             kubernetes
      Match            kube.*
      Kube_URL         https://kubernetes.default.svc:443
      Kube_CA_File     /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
      Kube_Token_File  /var/run/secrets/kubernetes.io/serviceaccount/token
      Kube_Tag_Prefix  kube.
      Merge_Log        On
      Merge_Log_Key    log_processed
      Merge_Log_Trim   On
      Keep_Log         Off
      K8S-Logging.Parser  On
      K8S-Logging.Exclude Off

      # Cache pod metadata to reduce API server load
      # Default: 0 (no cache); set to reduce API calls
      Use_Kubelet      Off
      Kube_Meta_Preload_Cache_Dir  /tmp/flb-metadata-cache

      # What to include (reducing labels reduces cardinality)
      Annotations      Off
      Labels           On

      # Buffer for API responses
      Buffer_Size      0  # 0 = unlimited (use with care)
```

### RBAC for Fluent Bit

```yaml
# fluent-bit-rbac.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: fluent-bit
  namespace: logging
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: fluent-bit-read
rules:
- apiGroups: [""]
  resources:
  - namespaces
  - pods
  - nodes
  - nodes/proxy
  verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: fluent-bit-read
subjects:
- kind: ServiceAccount
  name: fluent-bit
  namespace: logging
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: fluent-bit-read
```

## Section 7: Log Rotation and Retention

### Fluent Bit Storage Configuration

```yaml
# Service section with persistent storage for durability
config:
  service: |
    [SERVICE]
        storage.path              /var/fluent-bit/state/flb-storage/
        storage.sync              normal
        storage.checksum          off
        # Limit total storage for buffered logs
        storage.backlog.mem_limit 512M
        storage.max_chunks_up     128
```

### Loki Retention via Compactor

```yaml
# loki-values.yaml retention section
loki:
  limits_config:
    # Global default retention
    retention_period: 30d
    # Per-stream retention via label matchers is set in ruler config

  compactor:
    retention_enabled: true
    # Only delete after this delay (allows query during deletion)
    retention_delete_delay: 2h
    # How many workers perform deletion
    retention_delete_worker_count: 150
    # How often compaction runs
    compaction_interval: 10m
```

### Per-Namespace Retention with Loki Ruler Rules

```yaml
# loki-retention-rules.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: loki-retention-rules
  namespace: logging
data:
  retention.yaml: |
    groups:
    - name: retention_rules
      interval: 24h
      rules:
      # Keep production logs for 90 days
      - record: "loki:retention_production"
        expr: |
          {namespace="production"} |= ""
        labels:
          __loki_retention_period__: 90d

      # Keep staging logs for 14 days
      - record: "loki:retention_staging"
        expr: |
          {namespace="staging"} |= ""
        labels:
          __loki_retention_period__: 14d

      # Keep debug logs (high volume) for only 3 days
      - record: "loki:retention_debug"
        expr: |
          {level="debug"} |= ""
        labels:
          __loki_retention_period__: 3d
```

## Section 8: LogQL Query Optimization

LogQL is Loki's query language. Understanding its execution model prevents expensive queries.

### LogQL Query Types

**Log queries**: Return matching log lines. Always start with a stream selector (label matcher):
```
{namespace="production", app="api-server"}
```

**Metric queries**: Return time series from log data:
```
rate({namespace="production"} |= "error" [5m])
```

### Performance-Optimized Queries

```logql
# SLOW: Regex on large stream
{namespace="production"} |~ "ERROR.*database.*timeout"

# FAST: Add more label selectors first to narrow the stream
{namespace="production", app="api-server"} |~ "ERROR.*database.*timeout"

# FAST: Use |= (string match) before |~ (regex) when possible
{namespace="production", app="api-server"} |= "ERROR" |= "database" |~ "timeout"

# Counting error rate per service
sum by (app) (
  rate(
    {namespace="production"} |= "ERROR" [5m]
  )
)

# Parsing JSON logs and filtering on parsed fields
{namespace="production", app="api-server"}
| json
| status_code >= 500
| line_format "{{.method}} {{.path}} {{.status_code}} {{.duration}}"

# Extracting metrics from logs (latency histogram)
{namespace="production", app="api-server"}
| logfmt
| duration > 1s
| unwrap duration [5m]
| quantile_over_time(0.99, [5m]) by (path)

# Top 10 slowest endpoints
topk(10,
  avg_over_time(
    {namespace="production", app="api-server"}
    | logfmt
    | unwrap duration [5m]
  ) by (path)
)
```

### Loki Recording Rules for Performance

Pre-compute expensive LogQL queries as recording rules:

```yaml
# loki-recording-rules.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: loki-recording-rules
  namespace: logging
data:
  rules.yaml: |
    groups:
    - name: service_error_rates
      interval: 1m
      rules:
      - record: service:log_error_rate:5m
        expr: |
          sum by (namespace, app) (
            rate({namespace=~"production|staging"} |= "level=error" [5m])
          )

      - record: service:log_total_rate:5m
        expr: |
          sum by (namespace, app) (
            rate({namespace=~"production|staging"} [5m])
          )
```

## Section 9: Alerting on Logs with Loki Ruler

### LogQL Alert Rules

```yaml
# loki-alert-rules.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: loki-alert-rules
  namespace: logging
data:
  alerts.yaml: |
    groups:
    - name: application_log_alerts
      interval: 1m
      rules:
      # Alert on sustained high error rate
      - alert: HighLogErrorRate
        expr: |
          sum by (namespace, app) (
            rate(
              {namespace=~"production|staging"} |= "level=error" [5m]
            )
          ) > 1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High error log rate for {{ $labels.app }}"
          description: "{{ $labels.app }} in {{ $labels.namespace }} is logging {{ $value | humanize }} errors/second."
          runbook_url: "https://runbooks.example.com/high-error-log-rate"

      # Alert on OOM kill events
      - alert: ContainerOOMKill
        expr: |
          count_over_time(
            {namespace="production"}
            |= "OOMKilled"
            [10m]
          ) > 0
        labels:
          severity: critical
        annotations:
          summary: "Container OOMKilled in production"
          description: "A container was OOM killed in the last 10 minutes."

      # Alert on panic events in Go services
      - alert: GoPanic
        expr: |
          count_over_time(
            {namespace="production"}
            |= "panic:"
            [5m]
          ) > 0
        labels:
          severity: critical
        annotations:
          summary: "Go panic detected in {{ $labels.app }}"
          description: "A panic was logged in {{ $labels.app }}. Immediate investigation required."

      # Alert on certificate expiry warnings
      - alert: CertificateExpiryWarning
        expr: |
          count_over_time(
            {namespace=~".*"}
            |= "certificate"
            |= "expir"
            [1h]
          ) > 0
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Certificate expiry warning in logs"
          description: "Certificate expiry warning detected in logs. Check TLS certificates."

      # Alert on database connection failures
      - alert: DatabaseConnectionFailure
        expr: |
          count_over_time(
            {namespace="production", app="api-server"}
            |= "connection refused"
            |= "postgres"
            [5m]
          ) > 5
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Database connection failures for api-server"
          description: "{{ $value }} database connection failures in the last 5 minutes."
```

## Section 10: Grafana Dashboard for Log Analysis

### Dashboard-as-Code

```json
{
  "title": "Kubernetes Application Logs",
  "uid": "k8s-app-logs",
  "panels": [
    {
      "title": "Log Volume by Namespace",
      "type": "timeseries",
      "targets": [
        {
          "datasource": "Loki",
          "expr": "sum by (namespace) (rate({cluster=\"prod-us-east\"} [5m]))",
          "legendFormat": "{{namespace}}"
        }
      ]
    },
    {
      "title": "Error Rate by Service",
      "type": "timeseries",
      "targets": [
        {
          "datasource": "Loki",
          "expr": "sum by (app) (rate({namespace=\"production\"} |= \"level=error\" [5m]))",
          "legendFormat": "{{app}}"
        }
      ]
    },
    {
      "title": "Log Stream",
      "type": "logs",
      "targets": [
        {
          "datasource": "Loki",
          "expr": "{namespace=\"$namespace\", app=\"$app\"} |= \"$search\"",
          "maxLines": 1000
        }
      ]
    }
  ],
  "templating": {
    "list": [
      {
        "name": "namespace",
        "type": "query",
        "datasource": "Loki",
        "query": "label_values({cluster=\"prod-us-east\"}, namespace)"
      },
      {
        "name": "app",
        "type": "query",
        "datasource": "Loki",
        "query": "label_values({namespace=\"$namespace\"}, app)"
      },
      {
        "name": "search",
        "type": "textbox",
        "label": "Search"
      }
    ]
  }
}
```

## Section 11: Troubleshooting Common Issues

### Diagnosing Fluent Bit Problems

```bash
# Check Fluent Bit pod logs
kubectl logs -n logging daemonset/fluent-bit --since=5m

# Check storage buffer usage
kubectl exec -n logging daemonset/fluent-bit -- \
  curl -s localhost:2020/api/v1/storage | jq '.'

# Check plugin metrics
kubectl exec -n logging daemonset/fluent-bit -- \
  curl -s localhost:2020/api/v1/metrics | jq '.output'

# Typical output showing success/retry/error counts per output plugin:
# {
#   "loki.0": {
#     "proc_records": 1523456,
#     "proc_bytes":   45231789,
#     "errors":       0,
#     "retries":      12,
#     "retries_failed": 0,
#     "dropped_records": 0
#   }
# }

# Test Loki connectivity from Fluent Bit pod
kubectl exec -n logging daemonset/fluent-bit -- \
  curl -s "http://loki-gateway.logging.svc:80/loki/api/v1/labels" | jq '.status'

# Check Loki ingestion rate
kubectl exec -n logging statefulset/loki-write -- \
  curl -s "http://localhost:3100/metrics" \
  | grep "loki_distributor_ingested_samples"
```

### High-Cardinality Label Detection

```bash
# Check label cardinality via Loki API
curl -s "http://loki-gateway.logging.svc:80/loki/api/v1/label/pod/values" \
  | jq '.data | length'

# If pod is used as a label, this returns a huge number
# Solution: remove pod from labels, use pod_name only in log content
```

### Loki Out-of-Order Timestamp Errors

```bash
# Check Loki distributor errors
kubectl logs -n logging statefulset/loki-write \
  | grep "entry out of order"

# Solution: Enable accept_out_of_order_writes in Loki config
# loki.limits_config.unordered_writes: true
```

## Conclusion

A production-grade Kubernetes logging pipeline with Fluent Bit and Loki requires discipline in three areas: label cardinality management, which determines storage efficiency and query performance; resource allocation for Fluent Bit, which is memory-bounded by the in-memory buffer and must not be oversized relative to the node; and LogQL query design, which determines whether dashboards respond in milliseconds or minutes.

The Lua scripting capability in Fluent Bit provides the flexibility to handle the diverse log formats that real-world applications produce, normalizing them into a consistent structure that makes Loki label selection effective. Combined with Loki ruler-based alerting that operates directly on log streams, this stack provides observability depth comparable to full-text search systems at a fraction of the storage cost.
