---
title: "Kubernetes Fluentd vs Fluent Bit: Log Routing Architecture for Enterprise Scale"
date: 2031-01-09T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Fluentd", "Fluent Bit", "Logging", "Observability", "Log Routing", "OpenTelemetry", "ELK", "Loki"]
categories:
- Kubernetes
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide comparing Fluentd and Fluent Bit for Kubernetes log routing, covering plugin chains, multi-destination routing, buffer configuration, metadata enrichment, and OpenTelemetry log migration."
more_link: "yes"
url: "/kubernetes-fluentd-fluent-bit-log-routing-enterprise-scale/"
---

Every container in a Kubernetes cluster generates a stream of log lines. At 1,000 pods across 20 nodes, this is easily 100,000 lines per second — and all of it needs to be collected, enriched with pod metadata, routed to the right destinations, and buffered reliably so nothing is lost during downstream outages. Fluentd and Fluent Bit are the two dominant Kubernetes logging agents. This guide covers their architectural trade-offs, filter and parser plugin chains, multi-destination routing, buffer configuration for reliability, Kubernetes metadata enrichment, and the migration path to OpenTelemetry log pipelines.

<!--more-->

# Kubernetes Fluentd vs Fluent Bit: Log Routing Architecture for Enterprise Scale

## Section 1: Fluentd vs Fluent Bit — The Core Trade-off

### Fluent Bit
- **Language**: C
- **Memory footprint**: ~1-2 MB (vs Fluentd's 40-60 MB)
- **CPU**: Significantly lower
- **Plugin ecosystem**: Smaller but sufficient for most use cases
- **Threading model**: Event-driven, single-threaded with coroutines
- **Best for**: Node-level DaemonSet collector, high-volume forwarding, edge/embedded

### Fluentd
- **Language**: Ruby (with C extensions for hot paths)
- **Memory footprint**: 40-60 MB per instance
- **CPU**: Higher overhead, especially with Ruby GC
- **Plugin ecosystem**: 800+ community plugins (kafka, S3, Splunk, Bigquery, etc.)
- **Threading model**: Multi-threaded, more complex concurrency
- **Best for**: Aggregation tier, complex routing logic, plugin-heavy pipelines

### The Production Architecture

The enterprise pattern combines both:

```
Kubernetes Nodes
├── Pod A → stdout → /var/log/containers/
├── Pod B → stdout → /var/log/containers/
└── Pod C → stdout → /var/log/containers/
        ↓
[Fluent Bit DaemonSet] (one per node)
    - Tail container logs
    - Parse JSON
    - Add K8s metadata
    - Forward to aggregator
        ↓ (TCP/TLS)
[Fluentd Deployment] (2-3 replicas)
    - Route by namespace/label
    - Apply business logic transforms
    - Multi-destination output
    - Buffering and retry
        ↓           ↓           ↓
[Elasticsearch] [Splunk]   [S3/GCS]
```

Fluent Bit handles the high-volume, low-overhead collection at the edge. Fluentd handles complex routing, transformation, and multi-destination delivery at the aggregation tier.

## Section 2: Fluent Bit Configuration for Kubernetes

### 2.1 Fluent Bit as a DaemonSet

```yaml
# fluent-bit-daemonset.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: fluent-bit
  namespace: logging
  labels:
    app.kubernetes.io/name: fluent-bit
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: fluent-bit
  template:
    metadata:
      labels:
        app.kubernetes.io/name: fluent-bit
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "2020"
        prometheus.io/path: "/api/v1/metrics/prometheus"
    spec:
      serviceAccountName: fluent-bit
      tolerations:
      - operator: Exists
        effect: NoSchedule
      - operator: Exists
        effect: NoExecute
      priorityClassName: system-node-critical
      containers:
      - name: fluent-bit
        image: cr.fluentbit.io/fluent/fluent-bit:3.0.4
        ports:
        - containerPort: 2020
          name: metrics
        resources:
          requests:
            cpu: 50m
            memory: 64Mi
          limits:
            cpu: 500m
            memory: 256Mi
        volumeMounts:
        - name: varlog
          mountPath: /var/log
          readOnly: true
        - name: varlibdockercontainers
          mountPath: /var/lib/docker/containers
          readOnly: true
        - name: config
          mountPath: /fluent-bit/etc/
        - name: positions
          mountPath: /fluent-bit/tail/
        securityContext:
          runAsNonRoot: false  # needs root to read container logs
          readOnlyRootFilesystem: true
      volumes:
      - name: varlog
        hostPath:
          path: /var/log
      - name: varlibdockercontainers
        hostPath:
          path: /var/lib/docker/containers
      - name: config
        configMap:
          name: fluent-bit-config
      - name: positions
        hostPath:
          path: /var/lib/fluent-bit-positions
          type: DirectoryOrCreate
```

### 2.2 Fluent Bit Core Configuration

```yaml
# fluent-bit-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: fluent-bit-config
  namespace: logging
data:
  fluent-bit.conf: |
    [SERVICE]
        # Flush interval in seconds
        Flush                    5
        # Log level: off, error, warn, info, debug, trace
        Log_Level                info
        # Daemon mode
        Daemon                   off
        # Parser configuration file
        Parsers_File             /fluent-bit/etc/parsers.conf
        # Plugin configuration file
        Plugins_File             /fluent-bit/etc/plugins.conf
        # HTTP server for metrics and health checks
        HTTP_Server              On
        HTTP_Listen              0.0.0.0
        HTTP_Port                2020
        # Storage settings for buffering on disk
        storage.path             /fluent-bit/tail/
        storage.sync             normal
        storage.checksum         off
        storage.max_chunks_up    128

    # ─── INPUT: Container logs via tail ────────────────────────────────────────
    [INPUT]
        Name                     tail
        # Read all container log files
        Path                     /var/log/containers/*.log
        # Exclude fluent-bit's own logs to prevent recursion
        Exclude_Path             /var/log/containers/fluent-bit*
        Parser                   cri
        Tag                      kube.*
        Refresh_Interval         10
        Rotate_Wait              30
        Mem_Buf_Limit            50MB
        # Store read offsets (positions) for crash recovery
        DB                       /fluent-bit/tail/tail-db.db
        DB.Sync                  Normal
        # Skip log lines longer than 32KB
        Skip_Long_Lines          On
        # Use filesystem-backed buffer for reliability
        storage.type             filesystem

    # ─── INPUT: Node-level systemd logs ────────────────────────────────────────
    [INPUT]
        Name                     systemd
        Tag                      node.*
        Systemd_Filter           _SYSTEMD_UNIT=kubelet.service
        Systemd_Filter           _SYSTEMD_UNIT=containerd.service
        Read_From_Tail           On
        DB                       /fluent-bit/tail/systemd.db
        storage.type             filesystem

    # ─── FILTER: Kubernetes metadata enrichment ────────────────────────────────
    [FILTER]
        Name                     kubernetes
        Match                    kube.*
        # Kubernetes API server
        Kube_URL                 https://kubernetes.default.svc:443
        Kube_CA_File             /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
        Kube_Token_File          /var/run/secrets/kubernetes.io/serviceaccount/token
        # Merge the parsed log into the root record
        Merge_Log                On
        Merge_Log_Key            log_processed
        # Keep the original log field
        Keep_Log                 Off
        # If a pod annotation declares a parser, use it
        K8S-Logging.Parser       On
        # If a pod annotation disables logging, skip it
        K8S-Logging.Exclude      On
        # Annotate logs with labels from the pod
        Labels                   On
        Annotations              Off
        # Buffer for metadata cache
        Kube_Meta_Cache_TTL      300s

    # ─── FILTER: Parse inner JSON logs from Go/Java services ───────────────────
    [FILTER]
        Name                     parser
        Match                    kube.*
        Key_Name                 log_processed
        Parser                   json_log
        Reserve_Data             On
        Preserve_Key             Off

    # ─── FILTER: Add cluster identification ────────────────────────────────────
    [FILTER]
        Name                     record_modifier
        Match                    *
        Record                   cluster production-us-east-1
        Record                   environment production

    # ─── FILTER: Lua script for custom routing tags ────────────────────────────
    [FILTER]
        Name                     lua
        Match                    kube.*
        script                   /fluent-bit/etc/routing.lua
        call                     set_routing_tag

    # ─── OUTPUT: Forward to Fluentd aggregator ─────────────────────────────────
    [OUTPUT]
        Name                     forward
        Match                    *
        Host                     fluentd-aggregator.logging.svc.cluster.local
        Port                     24224
        # TLS for in-cluster transport (recommended for multi-tenant clusters)
        # tls                      On
        # tls.verify               On
        # Retry behavior
        Retry_Limit              5
        # Health check timeout
        Send_Options             On
        # Compression
        compress                 gzip
        # Use shared key for authentication
        Shared_Key               <fluentd-shared-key>

  parsers.conf: |
    [PARSER]
        Name                     cri
        Format                   regex
        Regex                    ^(?<time>[^ ]+) (?<stream>stdout|stderr) (?<logtag>[^ ]*) (?<log>.*)$
        Time_Key                 time
        Time_Format              %Y-%m-%dT%H:%M:%S.%L%z

    [PARSER]
        Name                     docker
        Format                   json
        Time_Key                 time
        Time_Format              %Y-%m-%dT%H:%M:%S.%L
        Time_Keep                On

    [PARSER]
        Name                     json_log
        Format                   json
        Time_Key                 timestamp
        Time_Format              %Y-%m-%dT%H:%M:%S.%LZ
        Time_Keep                On

    [PARSER]
        Name                     nginx_access
        Format                   regex
        Regex                    ^(?<remote>[^ ]*) (?<host>[^ ]*) (?<user>[^ ]*) \[(?<time>[^\]]*)\] "(?<method>\S+)(?: +(?<path>[^\"]*?)(?: +\S*)?)?" (?<code>[^ ]*) (?<size>[^ ]*)(?: "(?<referer>[^\"]*)" "(?<agent>[^\"]*)")?$
        Time_Key                 time
        Time_Format              %d/%b/%Y:%H:%M:%S %z

  routing.lua: |
    -- Set a routing tag based on namespace and severity
    function set_routing_tag(tag, timestamp, record)
        local namespace = ""
        if record["kubernetes"] and record["kubernetes"]["namespace_name"] then
            namespace = record["kubernetes"]["namespace_name"]
        end

        local level = record["level"] or record["severity"] or ""

        -- Critical namespaces route to high-priority destination
        if namespace == "production" or namespace == "fintech" then
            record["routing_destination"] = "high-priority"
        elseif level == "error" or level == "fatal" or level == "critical" then
            record["routing_destination"] = "errors"
        else
            record["routing_destination"] = "standard"
        end

        return 1, timestamp, record
    end
```

## Section 3: Fluentd Aggregator Configuration

### 3.1 Fluentd Deployment

```yaml
# fluentd-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: fluentd-aggregator
  namespace: logging
spec:
  replicas: 3
  selector:
    matchLabels:
      app: fluentd-aggregator
  template:
    metadata:
      labels:
        app: fluentd-aggregator
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchExpressions:
              - key: app
                operator: In
                values: ["fluentd-aggregator"]
            topologyKey: kubernetes.io/hostname
      containers:
      - name: fluentd
        image: fluent/fluentd-kubernetes-daemonset:v1.17-debian-elasticsearch8-1
        resources:
          requests:
            cpu: 500m
            memory: 512Mi
          limits:
            cpu: "2"
            memory: 2Gi
        ports:
        - containerPort: 24224
          name: forward
        - containerPort: 24231
          name: metrics
        volumeMounts:
        - name: config
          mountPath: /fluentd/etc/
        - name: buffer
          mountPath: /fluentd/buffer/
      volumes:
      - name: config
        configMap:
          name: fluentd-aggregator-config
      - name: buffer
        persistentVolumeClaim:
          claimName: fluentd-buffer
---
# Buffer PVC for reliable delivery
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: fluentd-buffer
  namespace: logging
spec:
  accessModes:
  - ReadWriteOnce
  storageClassName: fast-ssd
  resources:
    requests:
      storage: 20Gi
```

### 3.2 Fluentd Configuration

```ruby
# fluentd.conf — Aggregator configuration
# This is a multi-destination routing configuration

# ─── SOURCE: Receive from Fluent Bit DaemonSets ──────────────────────────────
<source>
  @type forward
  port 24224
  bind 0.0.0.0
  shared_key "#{ENV['FLUENTD_SHARED_KEY']}"

  # TLS configuration
  # <transport tls>
  #   cert_path /fluentd/certs/server.crt
  #   private_key_path /fluentd/certs/server.key
  #   ca_path /fluentd/certs/ca.crt
  #   client_cert_auth true
  # </transport>
</source>

# ─── SOURCE: Prometheus metrics ──────────────────────────────────────────────
<source>
  @type prometheus
  bind 0.0.0.0
  port 24231
  metrics_path /metrics
</source>

<source>
  @type prometheus_monitor
  <labels>
    host ${hostname}
  </labels>
</source>

# ─── FILTER: Parse timestamps consistently ───────────────────────────────────
<filter **>
  @type record_transformer
  enable_ruby true
  <record>
    # Normalize timestamp to ISO8601
    @timestamp ${time.strftime('%Y-%m-%dT%H:%M:%S.%L%z')}
    # Add aggregator hostname for debugging
    log_aggregator ${hostname}
  </record>
</filter>

# ─── FILTER: Mask sensitive fields ───────────────────────────────────────────
<filter kube.**>
  @type record_transformer
  <record>
    # Replace credit card numbers
    message ${record['message'].to_s.gsub(/\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/, '[REDACTED-CC]')}
    # Replace potential SSNs
    message ${record['message'].to_s.gsub(/\b\d{3}-\d{2}-\d{4}\b/, '[REDACTED-SSN]')}
  </record>
</filter>

# ─── FILTER: Kubernetes metadata normalization ───────────────────────────────
<filter kube.**>
  @type record_transformer
  <record>
    # Flatten commonly accessed Kubernetes metadata
    k8s_namespace    ${record.dig('kubernetes', 'namespace_name')}
    k8s_pod          ${record.dig('kubernetes', 'pod_name')}
    k8s_container    ${record.dig('kubernetes', 'container_name')}
    k8s_node         ${record.dig('kubernetes', 'host')}
    k8s_app          ${record.dig('kubernetes', 'labels', 'app') || record.dig('kubernetes', 'labels', 'app.kubernetes.io/name')}
    k8s_version      ${record.dig('kubernetes', 'labels', 'version')}
  </record>
</filter>

# ─── ROUTING: High-priority namespaces → Elasticsearch primary cluster ────────
<match kube.**>
  @type copy

  # Route based on routing_destination set by Fluent Bit Lua
  <store>
    @type elasticsearch
    @id elasticsearch-high-priority
    host elasticsearch-hot.logging.svc.cluster.local
    port 9200
    scheme https
    user elastic
    password "#{ENV['ELASTICSEARCH_PASSWORD']}"

    # Index template (YYYY.MM.DD suffix for daily rotation)
    index_name fluentd.${record['k8s_namespace']}.%Y.%m.%d
    type_name _doc

    # Use ILM for index lifecycle management
    enable_ilm true
    ilm_policy_id logs-default

    # Bulk write settings
    flush_interval 5s
    bulk_message_request_threshold 20MB

    # Retry configuration
    max_retry_wait 30s
    disable_retry_limit false

    # Buffer for reliability
    <buffer time,tag>
      @type file
      path /fluentd/buffer/elasticsearch-hp
      timekey 1m
      timekey_use_utc true
      timekey_wait 1m
      flush_mode interval
      flush_interval 5s
      flush_thread_count 4
      chunk_limit_size 16M
      queue_limit_length 512
      retry_type exponential_backoff
      retry_wait 1s
      retry_max_interval 120s
      retry_forever false
      retry_max_times 30
      overflow_action drop_oldest_chunk  # drop oldest on buffer full
    </buffer>
  </store>

  # Simultaneously route to Loki for dashboard team
  <store>
    @type loki
    @id loki-all
    url http://loki.monitoring.svc.cluster.local:3100

    # Extract labels for Loki (minimize label cardinality!)
    <label>
      namespace    $.k8s_namespace
      app          $.k8s_app
      level        $.level
      cluster      $.cluster
    </label>

    # Loki doesn't support high-cardinality labels —
    # pod name and container go in structured metadata, not labels
    extra_labels {"env":"production"}

    line_format json
    remove_keys kubernetes,stream,logtag

    <buffer>
      @type file
      path /fluentd/buffer/loki-all
      flush_interval 10s
      chunk_limit_size 4M
      queue_limit_length 256
      retry_forever false
      retry_max_times 20
    </buffer>
  </store>
</match>

# ─── ROUTING: Node-level logs → Separate index ───────────────────────────────
<match node.**>
  @type elasticsearch
  host elasticsearch-hot.logging.svc.cluster.local
  port 9200
  scheme https
  user elastic
  password "#{ENV['ELASTICSEARCH_PASSWORD']}"
  index_name node-logs.%Y.%m.%d

  <buffer time>
    @type file
    path /fluentd/buffer/es-node
    timekey 1h
    timekey_wait 5m
    flush_interval 30s
    chunk_limit_size 16M
  </buffer>
</match>

# ─── ROUTING: Security namespaces → Splunk (compliance) ─────────────────────
<filter kube.{fintech,payment,compliance}.**>
  @type record_transformer
  <record>
    # Add splunk-specific metadata
    splunk_source kubernetes
    splunk_sourcetype k8s:application
  </record>
</filter>

<match kube.{fintech,payment,compliance}.**>
  @type splunk_hec
  hec_host splunk.corp.example.com
  hec_port 8088
  hec_token "#{ENV['SPLUNK_HEC_TOKEN']}"
  hec_use_ssl true

  # Use index based on namespace
  default_index kubernetes

  source kubernetes
  sourcetype _json

  # Content of the 'message' field goes to Splunk's _raw
  fields_under_root false

  <buffer>
    @type file
    path /fluentd/buffer/splunk
    flush_interval 5s
    chunk_limit_size 5MB
    retry_max_times 20
    retry_wait 1s
    retry_max_interval 60s
  </buffer>
</match>

# ─── ROUTING: Archive all logs to S3 ─────────────────────────────────────────
<match **>
  @type s3
  aws_key_id "#{ENV['AWS_ACCESS_KEY_ID']}"
  aws_sec_key "#{ENV['AWS_SECRET_ACCESS_KEY']}"
  s3_bucket my-company-logs-archive
  s3_region us-east-1

  # Path format: year/month/day/hour/cluster/namespace/filename
  path logs/%Y/%m/%d/%H/${tag}/
  s3_object_key_format %{path}%{time_slice}_%{index}.%{file_extension}

  # Gzip before storing
  store_as gzip

  time_slice_format %Y%m%d%H
  time_slice_wait 10m

  <buffer time,tag>
    @type file
    path /fluentd/buffer/s3
    timekey 1h
    timekey_wait 10m
    timekey_use_utc true
    chunk_limit_size 256MB
    queue_limit_length 128
    flush_thread_count 2
    retry_max_times 40
    overflow_action drop_oldest_chunk
  </buffer>
</match>
```

## Section 4: Buffer Configuration for Reliability

### 4.1 Buffer Types

| Buffer Type | Use Case | Durability |
|---|---|---|
| `memory` | Low-latency, high-throughput; acceptable to lose data on crash | Low |
| `file` | Durable across restarts; survives fluentd crashes | High |
| `file_chunk` | Exactly-once delivery with chunk lifecycle tracking | Highest |

### 4.2 Buffer Tuning for High Volume

```ruby
# Production buffer configuration for 50,000 events/second
<buffer time,tag>
  @type file
  path /fluentd/buffer/es-main

  # Chunk size: larger chunks = fewer I/O operations = higher throughput
  # But: larger chunks = more data at risk if chunk is dropped
  chunk_limit_size 64M     # max size of a single chunk
  total_limit_size 4GB     # max total buffer size on disk

  # Flush behavior
  flush_mode interval
  flush_interval 5s        # flush every 5 seconds
  flush_thread_count 8     # parallel flush workers

  # Time-based partitioning (for time-series outputs like Elasticsearch)
  timekey 1m               # create one chunk per minute
  timekey_wait 30s         # wait 30s after timekey boundary before flushing

  # Retry configuration
  retry_type exponential_backoff
  retry_wait 1s            # initial wait
  retry_max_interval 60s   # maximum wait between retries
  retry_forever false      # don't retry forever
  retry_max_times 30       # give up after 30 retries
  retry_secondary_threshold 0.8  # use secondary output after 80% retries

  # When buffer is full:
  # block: slow down input (backpressure)
  # drop_oldest_chunk: drop oldest data (prefer for real-time logs)
  # throw_exception: raise error
  overflow_action drop_oldest_chunk
</buffer>
```

### 4.3 Secondary Output (Fallback)

```ruby
# Primary output with S3 fallback
<match kube.**>
  @type copy
  <store>
    @type elasticsearch
    # ... primary config ...
    <secondary>
      # If Elasticsearch is unavailable and buffer exhausted,
      # write to S3 as fallback
      @type s3
      s3_bucket company-log-fallback
      s3_region us-east-1
      path failed-delivery/%Y/%m/%d/
      store_as gzip
      <buffer time>
        @type file
        path /fluentd/buffer/es-secondary-s3
        timekey 1h
        timekey_wait 5m
      </buffer>
    </secondary>
  </store>
</match>
```

## Section 5: Kubernetes Metadata Enrichment

### 5.1 Pod Annotation-Based Parser Selection

Fluent Bit can use pod annotations to select parsers per workload:

```yaml
# Annotate a pod to use nginx parser
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx
spec:
  template:
    metadata:
      annotations:
        # Tell Fluent Bit to use the nginx_access parser for this pod's logs
        fluentbit.io/parser: "nginx_access"
        # Tell Fluent Bit to exclude this pod's logs entirely
        # fluentbit.io/exclude: "true"
```

```yaml
# Annotate a pod to use multi-line parsing (e.g., Java stack traces)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: java-service
spec:
  template:
    metadata:
      annotations:
        # Custom multiline parser for Java exceptions
        fluentbit.io/parser-java-service: "java_multiline"
```

### 5.2 Multi-Line Log Handling

Java stack traces and Go panic outputs span multiple log lines. Fluent Bit handles this with the multiline filter:

```yaml
  fluent-bit.conf: |
    # ─── FILTER: Merge Java stack traces ──────────────────────────────────────
    [FILTER]
        Name                multiline
        Match               kube.*
        multiline.key_content log
        multiline.parser    java, go, python
        # Buffer multi-line records for this long before flushing
        # (prevents holding records too long when trace ends)
        buffer_size         256K
        flush_ms            2000
```

```yaml
  parsers.conf: |
    # Multiline parser for Go panics
    [MULTILINE_PARSER]
        name          go
        type          regex
        flush_timeout 1000
        # Start of a Go panic
        rule          "start_state"  "/goroutine \d+ \[/" "go_continuation"
        rule          "go_continuation" "/(^\s+.*\.go:\d+$|^goroutine)/" "go_continuation"
```

## Section 6: Multi-Destination Routing Patterns

### 6.1 Routing by Namespace

```ruby
# Route production namespace logs to primary Elasticsearch cluster
<match kube.**>
  @type rewrite_tag_filter
  <rule>
    key    k8s_namespace
    pattern ^production$
    tag    prod.${tag}
  </rule>
  <rule>
    key    k8s_namespace
    pattern ^staging$
    tag    staging.${tag}
  </rule>
  <rule>
    key    k8s_namespace
    pattern .*
    tag    dev.${tag}
  </rule>
</match>

<match prod.**>
  @type elasticsearch
  host elasticsearch-prod.logging.svc.cluster.local
  # ... high-SLA configuration ...
</match>

<match staging.**>
  @type elasticsearch
  host elasticsearch-dev.logging.svc.cluster.local
  # ... lower-priority configuration ...
</match>

<match dev.**>
  # Dev logs: shorter retention, lower priority
  @type elasticsearch
  host elasticsearch-dev.logging.svc.cluster.local
  index_name dev-logs.%Y.%m.%d
  # ... dev configuration ...
</match>
```

### 6.2 Routing by Log Level (Error Amplification)

```ruby
# Send ALL error/fatal logs to PagerDuty and a dedicated error index
<filter kube.**>
  @type grep
  <regexp>
    key level
    pattern ^(error|fatal|critical|ERROR|FATAL|CRITICAL)$
  </regexp>
</filter>

<match kube.errors.**>
  @type copy
  # Store in dedicated Elasticsearch errors index
  <store>
    @type elasticsearch
    index_name errors.%Y.%m.%d
    host elasticsearch-hot.logging.svc.cluster.local
    # ...
  </store>
  # Also send to alerting webhook
  <store>
    @type http
    endpoint https://alerts.corp.example.com/api/v1/logs
    open_timeout 5
    http_method post
    content_type application/json
    <format>
      @type json
    </format>
    <buffer>
      @type memory
      flush_interval 1s
      chunk_limit_size 1MB
    </buffer>
  </store>
</match>
```

## Section 7: OpenTelemetry Log Migration

OpenTelemetry is standardizing observability signals. For teams adopting OTel, Fluent Bit and Fluentd both support OTLP output, enabling a migration path from traditional log routing to OTel-native pipelines.

### 7.1 Fluent Bit → OTLP Output

```yaml
  fluent-bit.conf: |
    # ─── OUTPUT: Send to OpenTelemetry Collector ──────────────────────────────
    [OUTPUT]
        Name                   opentelemetry
        Match                  kube.*
        Host                   otel-collector.observability.svc.cluster.local
        Port                   4318
        # gRPC (port 4317) or HTTP (port 4318)
        Logs_uri               /v1/logs
        # Map Fluent Bit fields to OTel log body and attributes
        header                 X-Source fluent-bit
        # Resource attributes (applied to all logs from this DaemonSet)
        add_label              cluster production
        add_label              k8s.node.name ${NODENAME}
        # Retry
        Retry_Limit            5
```

### 7.2 OpenTelemetry Collector Configuration

```yaml
# otel-collector-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: otel-collector-config
  namespace: observability
data:
  config.yaml: |
    receivers:
      otlp:
        protocols:
          grpc:
            endpoint: 0.0.0.0:4317
          http:
            endpoint: 0.0.0.0:4318
      # Also receive from Fluentd
      fluentforward:
        endpoint: 0.0.0.0:8006

    processors:
      # Batch logs before sending to reduce API calls
      batch:
        timeout: 5s
        send_batch_size: 1000
        send_batch_max_size: 5000

      # Add resource attributes
      resource:
        attributes:
        - action: upsert
          key: deployment.environment
          value: production
        - action: upsert
          key: service.namespace
          from_attribute: k8s.namespace.name

      # Filter out health check logs
      filter/health_checks:
        logs:
          exclude:
            match_type: regexp
            bodies:
            - ".*GET /healthz.*200.*"
            - ".*GET /readyz.*200.*"

      # Transform log body to match OTel semantic conventions
      transform/semconv:
        log_statements:
        - context: log
          statements:
          # Map 'level' to OTel severity
          - set(severity_text, attributes["level"])
          - set(severity_number, 9) where attributes["level"] == "info"
          - set(severity_number, 13) where attributes["level"] == "warn"
          - set(severity_number, 17) where attributes["level"] == "error"
          - set(severity_number, 21) where attributes["level"] == "fatal"
          # Map trace context
          - set(trace_id.string, attributes["trace_id"])
          - set(span_id.string, attributes["span_id"])

      # Memory limiter to prevent OOM
      memory_limiter:
        limit_mib: 400
        spike_limit_mib: 100
        check_interval: 5s

    exporters:
      # Loki exporter (OTel → Loki via native OTLP)
      loki:
        endpoint: http://loki.monitoring.svc.cluster.local:3100/loki/api/v1/push
        default_labels_enabled:
          exporter: false
          job: true
          level: true

      # Elasticsearch exporter (OTel → Elasticsearch)
      elasticsearch/main:
        endpoint: https://elasticsearch:9200
        user: elastic
        password: ${ELASTICSEARCH_PASSWORD}
        index: otel-logs-%{+yyyy.MM.dd}
        mapping:
          mode: otel

      # Debug: log to stdout (disable in production)
      # debug:
      #   verbosity: detailed

    service:
      pipelines:
        logs:
          receivers: [otlp, fluentforward]
          processors:
            - memory_limiter
            - batch
            - resource
            - filter/health_checks
            - transform/semconv
          exporters: [loki, elasticsearch/main]
```

### 7.3 Migration Strategy

The migration from Fluentd/Fluent Bit to pure OTel logs should be incremental:

```
Phase 1 (Now): Fluent Bit → Fluentd → Elasticsearch
    Add OTel Collector as a NEW destination from Fluentd
    Run both pipelines in parallel

Phase 2 (Month 2): Validate OTel data quality
    Confirm all required metadata is present in OTel pipeline
    Tune OTel Collector processors to match Fluentd transforms

Phase 3 (Month 3): Application teams migrate to OTel SDK logging
    Go services use slog/zap → OTel bridge
    Java services use Log4j2 OTel appender
    These logs bypass Fluent Bit entirely → go direct to OTel Collector

Phase 4 (Month 6): Retire Fluentd, keep Fluent Bit for non-OTel logs
    Fluent Bit → OTel Collector (OTLP output)
    OTel Collector handles all routing and transformation
```

## Section 8: Operational Monitoring

### 8.1 Fluent Bit Metrics

```yaml
# prometheusrule-fluentbit.yaml
groups:
- name: fluent-bit
  rules:
  - alert: FluentBitInputDropped
    expr: |
      rate(fluentbit_input_records_total{name=~".*dropped.*"}[5m]) > 0
    for: 1m
    labels:
      severity: warning
    annotations:
      summary: "Fluent Bit on {{ $labels.node }} is dropping input records"

  - alert: FluentBitOutputError
    expr: |
      rate(fluentbit_output_errors_total[5m]) > 0.1
    for: 5m
    labels:
      severity: critical
    annotations:
      summary: "Fluent Bit on {{ $labels.node }} has output errors"
      description: "{{ $value | humanize }} errors/sec on {{ $labels.name }}"

  - alert: FluentBitHighRetryCount
    expr: |
      rate(fluentbit_output_retries_total[5m]) > 1
    for: 10m
    labels:
      severity: warning
    annotations:
      summary: "Fluent Bit is retrying output — downstream may be degraded"
```

### 8.2 Fluentd Metrics

```yaml
groups:
- name: fluentd
  rules:
  - alert: FluentdBufferFull
    expr: |
      fluentd_output_status_buffer_queue_length /
      fluentd_output_status_buffer_queue_max_size > 0.8
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "Fluentd buffer for {{ $labels.plugin_id }} is 80%+ full"

  - alert: FluentdOutputRetrying
    expr: |
      fluentd_output_status_retry_count > 10
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "Fluentd output {{ $labels.plugin_id }} has been retrying for 5m"
```

## Section 9: Cost Optimization

### 9.1 Log Sampling for High-Volume Services

For services logging at extreme rates (10,000+ lines/second), sampling reduces storage costs without losing important signals:

```yaml
  fluent-bit.conf: |
    # ─── FILTER: Sample debug/info logs at 10% ────────────────────────────────
    [FILTER]
        Name                sampling
        Match               kube.*
        Rate                10        # keep 10% of matching records
        Condition           Key_Value_Matches level ^(debug|trace)$
```

### 9.2 Log Dropping Rules

```ruby
# Fluentd: drop known-noisy, low-value logs
<filter kube.**>
  @type grep
  # Drop health check logs (usually > 50% of all logs in many clusters)
  <exclude>
    key     message
    pattern /GET \/healthz|GET \/readyz|GET \/metrics/
  </exclude>
  # Drop Kubernetes internal logs (already in k8s audit log)
  <exclude>
    key     k8s_namespace
    pattern /^kube-system$/
  </exclude>
</filter>

# Drop empty log lines
<filter **>
  @type grep
  <and>
    <regexp>
      key log
      pattern /.+/
    </regexp>
  </and>
</filter>
```

## Summary

Kubernetes log routing at enterprise scale requires a two-tier architecture. Fluent Bit at the node level provides low-overhead collection with minimal resource impact on workload pods. Fluentd at the aggregation tier handles complex routing, multi-destination delivery, buffer management, and plugin-based transformations that would be resource-prohibitive in the node-level agent.

Key operational principles:

1. **Buffer everything to disk** in the aggregation tier — memory buffers lose data on restarts.
2. **Minimize label cardinality in Loki** — use structured metadata (not labels) for pod name, container, trace ID.
3. **Route by namespace, not by pod** — pod names are ephemeral; namespace-based routing is stable.
4. **Sample or drop health check logs** — they typically comprise 40-60% of cluster log volume with zero signal value.
5. **Plan the OTel migration early** — the OTel log specification is now stable, and all major vendors support OTLP. Starting with an OTel Collector in the pipeline today simplifies the future migration from Fluentd to pure OTel without re-architecting.
