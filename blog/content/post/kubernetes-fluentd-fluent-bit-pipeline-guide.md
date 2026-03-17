---
title: "Kubernetes Fluentd and Fluent Bit Log Pipeline: Collection, Transformation, and Routing"
date: 2028-04-29T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Fluentd", "Fluent Bit", "Logging", "Log Pipeline"]
categories: ["Kubernetes", "Observability"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to building a Kubernetes log pipeline with Fluent Bit for collection and Fluentd for aggregation, covering configuration patterns, log routing, transformation, multi-destination output, and operational tuning."
more_link: "yes"
url: "/kubernetes-fluentd-fluent-bit-pipeline-guide/"
---

The Fluent Bit + Fluentd combination is the dominant log collection architecture in Kubernetes. Fluent Bit runs as a lightweight DaemonSet collecting logs from every node, then forwards them to Fluentd for aggregation, transformation, and routing to multiple backends. This guide covers the complete pipeline from collection through delivery with production-ready configurations.

<!--more-->

# Kubernetes Fluentd and Fluent Bit Log Pipeline: Collection, Transformation, and Routing

## Architecture Overview

The two-tier architecture divides log processing responsibility:

**Fluent Bit** (per node, ~450 KiB binary):
- Reads log files from `/var/log/containers/`
- Tails the Docker/containerd JSON log format
- Adds Kubernetes metadata (pod name, namespace, labels)
- Forwards compressed batches to Fluentd

**Fluentd** (Deployment or StatefulSet):
- Receives logs from all Fluent Bit agents
- Applies complex transformations and parsing
- Routes logs to multiple destinations based on namespace, labels, or content
- Handles buffering, retry, and backpressure

```
Node (x N)
├── Fluent Bit DaemonSet
│   ├── tail /var/log/containers/*.log
│   ├── add kubernetes metadata
│   └── forward → Fluentd:24224

Fluentd (Deployment, 2-3 replicas)
├── receive from all Fluent Bit agents
├── parse, transform, filter
└── route to:
    ├── Elasticsearch/OpenSearch
    ├── Loki
    ├── S3 (archive)
    └── Splunk (security)
```

## Fluent Bit Configuration

### Complete DaemonSet with ConfigMap

```yaml
# fluent-bit-namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: logging
  labels:
    name: logging
---
# fluent-bit-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: fluent-bit-config
  namespace: logging
data:
  fluent-bit.conf: |
    [SERVICE]
        Flush         5
        Log_Level     warning
        Daemon        off
        Parsers_File  parsers.conf
        HTTP_Server   On
        HTTP_Listen   0.0.0.0
        HTTP_Port     2020
        Health_Check  On
        # Store position to survive pod restarts
        storage.path              /var/log/flb-storage/
        storage.sync              normal
        storage.checksum          off
        storage.max_chunks_up     128
        storage.backlog.mem_limit 100M

    [INPUT]
        Name              tail
        Tag               kube.*
        Path              /var/log/containers/*.log
        # Exclude Fluent Bit's own logs to avoid loops
        Exclude_Path      /var/log/containers/fluent-bit*
        Parser            cri
        DB                /var/log/flb-storage/flb_kube.db
        Mem_Buf_Limit     50MB
        Skip_Long_Lines   On
        Refresh_Interval  10
        Rotate_Wait       30
        # Use inode-based file tracking
        DB.locking        true
        DB.journal_mode   WAL

    [INPUT]
        Name              systemd
        Tag               host.*
        Systemd_Filter    _SYSTEMD_UNIT=kubelet.service
        Systemd_Filter    _SYSTEMD_UNIT=containerd.service
        Read_From_Tail    On
        Strip_Underscores On

    [FILTER]
        Name                kubernetes
        Match               kube.*
        Kube_URL            https://kubernetes.default.svc:443
        Kube_CA_File        /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
        Kube_Token_File     /var/run/secrets/kubernetes.io/serviceaccount/token
        Kube_Tag_Prefix     kube.var.log.containers.
        Merge_Log           On
        Merge_Log_Key       log_processed
        K8S-Logging.Parser  On
        K8S-Logging.Exclude On
        Annotations         Off
        Labels              On
        # Cache kubernetes metadata for 300 seconds
        Kube_Meta_Cache_TTL 300s

    [FILTER]
        Name    modify
        Match   kube.*
        # Rename fields to match OTEL semantic conventions
        Rename  log message
        Rename  stream log.iostream
        # Add cluster identifier
        Add     kubernetes.cluster.name ${CLUSTER_NAME}

    [FILTER]
        Name   grep
        Match  kube.*
        # Drop health check and readiness probe logs
        Exclude log ^(GET /healthz|GET /readyz|GET /livez)

    [OUTPUT]
        Name            forward
        Match           kube.*
        Host            fluentd-aggregator.logging.svc.cluster.local
        Port            24224
        Require_ack_response  On
        Send_options    On
        Retry_Limit     5
        Workers         4
        # TLS for internal cluster traffic
        tls             Off
        # Compression reduces bandwidth
        Compress        gzip
        # Time-based chunking
        Time_as_Integer False

    [OUTPUT]
        Name            forward
        Match           host.*
        Host            fluentd-aggregator.logging.svc.cluster.local
        Port            24225
        Retry_Limit     5

  parsers.conf: |
    [PARSER]
        Name        cri
        Format      regex
        Regex       ^(?<time>[^ ]+) (?<stream>stdout|stderr) (?<logtag>[^ ]*) (?<log>.*)$
        Time_Key    time
        Time_Format %Y-%m-%dT%H:%M:%S.%L%z
        Time_Keep   On

    [PARSER]
        Name        docker
        Format      json
        Time_Key    time
        Time_Format %Y-%m-%dT%H:%M:%S.%L
        Time_Keep   On

    [PARSER]
        Name        syslog-rfc5424
        Format      regex
        Regex       ^\<(?<pri>[0-9]{1,5})\>1 (?<time>[^ ]+) (?<host>[^ ]+) (?<ident>[^ ]+) (?<pid>[-0-9]+) (?<msgid>[^ ]+) (?<extradata>(\[(.*)\]|-)) (?<message>.+)$
        Time_Key    time
        Time_Format %Y-%m-%dT%H:%M:%S.%L%z

    [PARSER]
        Name        json_structured
        Format      json
        Time_Key    timestamp
        Time_Format %Y-%m-%dT%H:%M:%S%z
```

### Fluent Bit DaemonSet

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: fluent-bit
  namespace: logging
  labels:
    app: fluent-bit
spec:
  selector:
    matchLabels:
      app: fluent-bit
  template:
    metadata:
      labels:
        app: fluent-bit
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "2020"
        prometheus.io/path: "/api/v1/metrics/prometheus"
    spec:
      serviceAccountName: fluent-bit
      tolerations:
        # Run on all nodes including control plane
        - key: node-role.kubernetes.io/control-plane
          operator: Exists
          effect: NoSchedule
        - operator: Exists
          effect: NoExecute
        - operator: Exists
          effect: NoSchedule
      containers:
        - name: fluent-bit
          image: fluent/fluent-bit:3.1.4
          imagePullPolicy: IfNotPresent
          ports:
            - containerPort: 2020
              name: http-metrics
          env:
            - name: CLUSTER_NAME
              valueFrom:
                configMapKeyRef:
                  name: cluster-info
                  key: cluster-name
            - name: NODE_NAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
          resources:
            requests:
              cpu: 50m
              memory: 100Mi
            limits:
              cpu: 200m
              memory: 256Mi
          volumeMounts:
            - name: varlog
              mountPath: /var/log
            - name: varlibdockercontainers
              mountPath: /var/lib/docker/containers
              readOnly: true
            - name: etcmachineid
              mountPath: /etc/machine-id
              readOnly: true
            - name: config
              mountPath: /fluent-bit/etc/
            - name: storage
              mountPath: /var/log/flb-storage/
          readinessProbe:
            httpGet:
              path: /api/v1/health
              port: 2020
            initialDelaySeconds: 10
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /
              port: 2020
            initialDelaySeconds: 30
            periodSeconds: 30
      terminationGracePeriodSeconds: 30
      volumes:
        - name: varlog
          hostPath:
            path: /var/log
        - name: varlibdockercontainers
          hostPath:
            path: /var/lib/docker/containers
        - name: etcmachineid
          hostPath:
            path: /etc/machine-id
            type: File
        - name: config
          configMap:
            name: fluent-bit-config
        - name: storage
          hostPath:
            path: /var/log/flb-storage/
            type: DirectoryOrCreate
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
```

### RBAC for Fluent Bit

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: fluent-bit
  namespace: logging
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: fluent-bit
rules:
  - apiGroups: [""]
    resources: ["namespaces", "pods", "nodes", "nodes/proxy"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: fluent-bit
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: fluent-bit
subjects:
  - kind: ServiceAccount
    name: fluent-bit
    namespace: logging
```

## Fluentd Aggregator Configuration

### Fluentd ConfigMap with Routing

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: fluentd-config
  namespace: logging
data:
  fluent.conf: |
    # Accept forwarded logs from Fluent Bit agents
    <source>
      @type forward
      port 24224
      bind 0.0.0.0
      <security>
        self_hostname fluentd-aggregator
        shared_key    ${FLUENTD_SHARED_KEY}
      </security>
    </source>

    # Systemd/host logs
    <source>
      @type forward
      port 24225
      bind 0.0.0.0
    </source>

    # Health check endpoint
    <source>
      @type http
      port 9880
      bind 0.0.0.0
      body_size_limit  32m
      keepalive_timeout 10s
    </source>

    # ==== PARSING ====

    # Parse JSON structured logs
    <filter kube.**>
      @type parser
      key_name message
      reserve_data true
      remove_key_name_field false
      emit_invalid_record_to_error true
      <parse>
        @type multi_format
        <pattern>
          format json
          time_key timestamp
          time_format %Y-%m-%dT%H:%M:%S%z
          keep_time_key true
        </pattern>
        <pattern>
          format none
        </pattern>
      </parse>
    </filter>

    # Enrich with standard severity field
    <filter kube.**>
      @type record_transformer
      enable_ruby true
      <record>
        severity ${
          level = record.dig("level") || record.dig("severity") || record.dig("lvl")
          case level&.downcase
          when "debug", "trace"  then "DEBUG"
          when "info"            then "INFO"
          when "warn", "warning" then "WARNING"
          when "error", "err"    then "ERROR"
          when "fatal", "panic"  then "CRITICAL"
          else                        "DEFAULT"
          end
        }
        cluster_name "#{ENV['CLUSTER_NAME']}"
        fluentd_host "#{Socket.gethostname}"
      </record>
    </filter>

    # ==== ROUTING ====

    # Route security-sensitive namespaces to Splunk
    <match kube.**>
      @type route
      <route **>
        # Send all to Elasticsearch
        @label @elasticsearch
        copy true
      </route>
      <route kube.security-**.** kube.payment-**.**>
        # Also send security/payment namespaces to Splunk
        @label @splunk
        copy true
      </match>
    </match>

    # ==== OUTPUT: ELASTICSEARCH ====
    <label @elasticsearch>
      # Separate buffers per tag for independent retry
      <match kube.**>
        @type elasticsearch
        host "#{ENV['ES_HOST']}"
        port 9200
        user "#{ENV['ES_USER']}"
        password "#{ENV['ES_PASSWORD']}"
        scheme https
        ssl_verify true
        ssl_version TLSv1_2

        # Index naming: kubernetes-YYYY.MM.DD
        index_name kubernetes
        logstash_format true
        logstash_prefix kubernetes
        logstash_dateformat %Y.%m.%d

        # ILM policy management
        index_date_pattern %Y.%m.%d
        ilm_policy_id kubernetes-default
        ilm_policy_overwrite false

        # Type mapping
        type_name _doc

        # Bulk upload settings
        bulk_message_request_threshold 20MB
        request_timeout 30s

        # Reconnect on error
        reconnect_on_error true

        <buffer tag, time>
          @type file
          path /var/log/fluentd-buffers/elasticsearch
          flush_mode interval
          retry_type exponential_backoff
          flush_thread_count 4
          flush_interval 5s
          retry_forever true
          retry_max_interval 30
          chunk_limit_size 8MB
          queue_limit_length 32
          overflow_action block
        </buffer>
      </match>
    </label>

    # ==== OUTPUT: LOKI ====
    <label @loki>
      <match kube.**>
        @type loki
        url "#{ENV['LOKI_URL']}"
        username "#{ENV['LOKI_USER']}"
        password "#{ENV['LOKI_PASSWORD']}"

        # Labels to extract from log records
        <label>
          app         $.kubernetes.labels.app
          namespace   $.kubernetes.namespace_name
          pod         $.kubernetes.pod_name
          container   $.kubernetes.container_name
          cluster     $.cluster_name
          environment $.kubernetes.labels.environment
        </label>

        # Remove fields used as labels to avoid duplication
        remove_keys kubernetes,docker,stream

        # Loki has strict label cardinality rules - limit dynamic labels
        <buffer>
          @type file
          path /var/log/fluentd-buffers/loki
          flush_interval 5s
          chunk_limit_size 4MB
          queue_limit_length 16
          retry_max_interval 60
          retry_forever true
        </buffer>
      </match>
    </label>

    # ==== OUTPUT: S3 ARCHIVE ====
    <label @s3>
      <match kube.**>
        @type s3
        s3_bucket "#{ENV['S3_BUCKET']}"
        s3_region "#{ENV['AWS_REGION']}"
        path logs/%Y/%m/%d/

        # File format: GZIP compressed JSON
        store_as gzip
        <format>
          @type json
        </format>

        # S3 object naming
        s3_object_key_format %{path}%{time_slice}_%{uuid_hash}_%{index}.%{file_extension}
        time_slice_format %Y%m%d-%H

        # IAM role via IRSA (no explicit credentials needed)
        instance_profile_credentials_retries 3
        instance_profile_credentials_ip 169.254.169.254

        <buffer time>
          @type file
          path /var/log/fluentd-buffers/s3
          timekey 3600         # 1 hour slices
          timekey_wait 10m     # Wait 10 minutes before closing a slice
          timekey_use_utc true
          chunk_limit_size 256MB
          retry_forever true
        </buffer>
      </match>
    </label>

    # ==== ERROR HANDLING ====
    <label @ERROR>
      <match **>
        @type file
        path /var/log/fluentd-errors
        <buffer>
          @type memory
          flush_mode immediate
        </buffer>
        <format>
          @type json
        </format>
      </match>
    </label>
```

### Fluentd Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: fluentd-aggregator
  namespace: logging
  labels:
    app: fluentd-aggregator
spec:
  replicas: 2
  selector:
    matchLabels:
      app: fluentd-aggregator
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0  # Never have zero aggregators
  template:
    metadata:
      labels:
        app: fluentd-aggregator
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "24231"
        prometheus.io/path: "/metrics"
    spec:
      serviceAccountName: fluentd-aggregator
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  app: fluentd-aggregator
              topologyKey: kubernetes.io/hostname
      initContainers:
        # Create buffer directories
        - name: init-buffers
          image: busybox:1.36
          command: ["mkdir", "-p",
            "/var/log/fluentd-buffers/elasticsearch",
            "/var/log/fluentd-buffers/loki",
            "/var/log/fluentd-buffers/s3"]
          volumeMounts:
            - name: buffers
              mountPath: /var/log/fluentd-buffers
      containers:
        - name: fluentd
          image: fluent/fluentd-kubernetes-daemonset:v1.17-debian-elasticsearch8-1
          env:
            - name: FLUENTD_SHARED_KEY
              valueFrom:
                secretKeyRef:
                  name: fluentd-secret
                  key: shared-key
            - name: ES_HOST
              valueFrom:
                secretKeyRef:
                  name: elasticsearch-credentials
                  key: host
            - name: ES_USER
              valueFrom:
                secretKeyRef:
                  name: elasticsearch-credentials
                  key: username
            - name: ES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: elasticsearch-credentials
                  key: password
            - name: LOKI_URL
              value: "http://loki.monitoring.svc.cluster.local:3100"
            - name: S3_BUCKET
              value: "company-logs-archive"
            - name: AWS_REGION
              value: "us-east-1"
            - name: CLUSTER_NAME
              valueFrom:
                configMapKeyRef:
                  name: cluster-info
                  key: cluster-name
            # Ruby GC tuning for memory efficiency
            - name: RUBY_GC_HEAP_INIT_SLOTS
              value: "800000"
            - name: RUBY_GC_HEAP_FREE_SLOTS
              value: "800000"
            - name: RUBY_GC_HEAP_GROWTH_FACTOR
              value: "1.25"
          ports:
            - containerPort: 24224
              name: forward
            - containerPort: 24225
              name: forward-host
            - containerPort: 9880
              name: http
            - containerPort: 24231
              name: metrics
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: 2
              memory: 2Gi
          volumeMounts:
            - name: config
              mountPath: /fluentd/etc/
            - name: buffers
              mountPath: /var/log/fluentd-buffers
          readinessProbe:
            httpGet:
              path: /api/plugins.json
              port: 9880
            initialDelaySeconds: 30
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /api/plugins.json
              port: 9880
            initialDelaySeconds: 60
            periodSeconds: 30
      volumes:
        - name: config
          configMap:
            name: fluentd-config
        - name: buffers
          persistentVolumeClaim:
            claimName: fluentd-buffers-pvc
---
apiVersion: v1
kind: Service
metadata:
  name: fluentd-aggregator
  namespace: logging
spec:
  selector:
    app: fluentd-aggregator
  ports:
    - port: 24224
      name: forward
    - port: 24225
      name: forward-host
    - port: 9880
      name: http
  type: ClusterIP
```

## Advanced Filtering Patterns

### Redacting Sensitive Data

```yaml
# Add to Fluentd config
<filter kube.**>
  @type record_transformer
  enable_ruby true
  <record>
    # Redact credit card numbers
    message ${
      record["message"].to_s
        .gsub(/\b(?:\d{4}[-\s]?){3}\d{4}\b/, "[REDACTED-CC]")
        .gsub(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/, "[REDACTED-EMAIL]")
        .gsub(/\b(?:\d{3}[-.\s]?)?\d{3}[-.\s]?\d{4}\b/, "[REDACTED-PHONE]")
        .gsub(/Bearer\s+[A-Za-z0-9\-._~+\/]+=*/, "Bearer [REDACTED]")
    }
  </record>
</filter>
```

### Log Sampling for High-Volume Namespaces

```yaml
# Sample debug logs at 1% to reduce volume
<filter kube.**>
  @type sampling
  # Only sample DEBUG level logs
  sample_unit minute
  <pattern>
    tag kube.high-volume-ns.**
    pattern severity DEBUG
    # Keep 1% of debug logs
    interval 100
  </pattern>
</filter>
```

### Multi-Line Log Assembly

Applications that split stack traces across multiple log lines require assembly:

```yaml
# Fluent Bit: multiline parser for Java stack traces
[FILTER]
    Name          multiline
    Match         kube.*
    multiline.key_content log
    multiline.parser  java, python, go, ruby
    mode          partial_message
    flush_timeout 5000
```

```conf
# Custom multiline parser for application-specific format
[MULTILINE_PARSER]
    name          exception-parser
    type          regex
    flush_timeout 5000
    rule          "start_state"   "/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/"  "cont"
    rule          "cont"          "/^\s+at /"                                    "cont"
    rule          "cont"          "/^\s+\.\.\. \d+ more/"                       "cont"
    rule          "cont"          "/^Caused by:/"                                "cont"
```

### Namespace-Based Routing with Match Conditions

```yaml
# Fluentd: route by namespace with complex conditions
<match kube.**>
  @type rewrite_tag_filter
  <rule>
    key $.kubernetes.namespace_name
    pattern ^production$
    tag production.${tag}
  </rule>
  <rule>
    key $.kubernetes.namespace_name
    pattern ^(staging|qa|dev)$
    tag nonprod.${tag}
  </rule>
  <rule>
    key $.kubernetes.namespace_name
    pattern ^(security|audit|compliance)$
    tag security.${tag}
  </rule>
</match>

<match production.**>
  @type copy
  <store>
    @type elasticsearch
    # Production ES cluster
  </store>
  <store>
    @type s3
    # Long-term archival
  </store>
</match>

<match nonprod.**>
  @type elasticsearch
  # Non-production ES cluster (cheaper)
</match>

<match security.**>
  @type copy
  <store>
    @type elasticsearch
  </store>
  <store>
    @type splunk_hec
    # Splunk for SIEM
  </store>
</match>
```

## Monitoring the Log Pipeline

### Fluent Bit Prometheus Metrics

```yaml
# Fluent Bit exposes Prometheus metrics at :2020/api/v1/metrics/prometheus
# Key metrics to alert on:

# Records dropped (data loss)
fluentbit_output_dropped_records_total > 0

# Buffer queue filling up
fluentbit_storage_chunks_fs_up / fluentbit_storage_chunks_total > 0.8

# High retry rate indicates backend issues
fluentbit_output_retries_total{name="forward"} > 100

# Input lag - logs are accumulating
fluentbit_input_records_total - fluentbit_output_records_total > 10000
```

### Fluentd Prometheus Metrics

```ruby
# Add to Fluentd config to enable metrics endpoint
<source>
  @type prometheus
  port 24231
  metrics_path /metrics
</source>

<source>
  @type prometheus_monitor
</source>

<source>
  @type prometheus_output_monitor
</source>
```

```yaml
# Prometheus alerts
groups:
  - name: fluentd
    rules:
      - alert: FluentdOutputError
        expr: |
          rate(fluentd_output_status_num_errors[5m]) > 0
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Fluentd output errors for {{ $labels.plugin_id }}"

      - alert: FluentdBufferQueueFull
        expr: |
          fluentd_output_status_buffer_queue_length /
          fluentd_output_status_buffer_queue_byte_size > 0.9
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Fluentd buffer queue nearly full"

      - alert: FluentdRetryCountHigh
        expr: |
          rate(fluentd_output_status_retry_count[5m]) > 10
        for: 3m
        labels:
          severity: warning
        annotations:
          summary: "Fluentd retry count elevated for {{ $labels.plugin_id }}"
```

## Performance Tuning

### Fluent Bit Tuning for High-Volume Nodes

```conf
[SERVICE]
    # Flush more frequently to reduce latency
    Flush          2
    # Increase worker threads for parallel output
    Workers        4
    # Larger in-memory buffer before falling back to disk
    storage.max_chunks_up  256

[INPUT]
    Name          tail
    # Reduce polling interval
    Refresh_Interval  5
    # Large read size per poll
    Read_From_Head false
    # Limit memory buffer per input
    Mem_Buf_Limit  100MB

[OUTPUT]
    Name     forward
    Workers  4
    # Batch more records per send
    Batch_Size    512
    Batch_Flush_Interval  2s
```

### Fluentd Worker Tuning

```yaml
# Number of worker processes
<system>
  workers 4
  worker_id ${worker_id}
  root_dir /tmp/fluentd_buffers
</system>

# Per-worker buffer configuration
<match kube.**>
  @type elasticsearch
  <buffer tag>
    @type file
    path /var/log/fluentd-buffers/es.${worker_id}
    flush_thread_count 4
    flush_mode interval
    flush_interval 5s
    chunk_limit_size 16MB
    queue_limit_length 128
    retry_type exponential_backoff
    retry_max_interval 60
    retry_forever true
    overflow_action block
  </buffer>
</match>
```

## Log Retention and Lifecycle Policies

### Elasticsearch ILM Policy

```json
PUT _ilm/policy/kubernetes-logs
{
  "policy": {
    "phases": {
      "hot": {
        "min_age": "0ms",
        "actions": {
          "rollover": {
            "max_age": "1d",
            "max_size": "50gb"
          },
          "set_priority": {
            "priority": 100
          }
        }
      },
      "warm": {
        "min_age": "7d",
        "actions": {
          "allocate": {
            "number_of_replicas": 0,
            "require": {
              "data": "warm"
            }
          },
          "forcemerge": {
            "max_num_segments": 1
          },
          "set_priority": {
            "priority": 50
          }
        }
      },
      "cold": {
        "min_age": "30d",
        "actions": {
          "allocate": {
            "require": {
              "data": "cold"
            }
          }
        }
      },
      "delete": {
        "min_age": "90d",
        "actions": {
          "delete": {}
        }
      }
    }
  }
}
```

## Troubleshooting

### No Logs Reaching Fluentd

```bash
# Check Fluent Bit is running and healthy on all nodes
kubectl get pods -n logging -l app=fluent-bit

# Check Fluent Bit metrics for drop counts
kubectl port-forward -n logging daemonset/fluent-bit 2020:2020
curl -s http://localhost:2020/api/v1/metrics/prometheus | \
  grep "fluentbit_output_dropped"

# Check Fluent Bit logs for connection errors
kubectl logs -n logging -l app=fluent-bit --since=5m | grep -i "error\|warn"

# Verify Fluentd is reachable from Fluent Bit
kubectl exec -n logging -it ds/fluent-bit -- \
  nc -zv fluentd-aggregator.logging.svc.cluster.local 24224
```

### High Memory Usage in Fluentd

```bash
# Check buffer sizes
kubectl exec -n logging fluentd-aggregator-xxx -- \
  ls -la /var/log/fluentd-buffers/*/

# Check buffer queue length via metrics
curl -s http://localhost:24231/metrics | \
  grep fluentd_output_status_buffer_queue_length

# If buffers are full due to backend outage, temporarily increase queue
# and enable overflow_action drop_oldest (data loss!) as emergency measure

# Restart Fluentd gracefully (drains buffers before exiting)
kubectl delete pod fluentd-aggregator-xxx --grace-period=60
```

### Parsing Failures

```bash
# Check Fluentd error log output
kubectl logs -n logging fluentd-aggregator-xxx | \
  grep -i "parse error\|Fluent::MessagePackError"

# Test parser with fluent-cat
echo '{"time":"2028-04-29T10:00:00Z","level":"info","message":"test"}' | \
  kubectl exec -n logging fluentd-aggregator-xxx -i -- \
  fluent-cat --json test.parsing

# Use Fluent Bit dry-run mode
kubectl exec -n logging -it ds/fluent-bit -- \
  /fluent-bit/bin/fluent-bit -c /fluent-bit/etc/fluent-bit.conf --dry-run
```

## Summary

The Fluent Bit + Fluentd pipeline provides a robust, scalable log collection architecture:

- Fluent Bit's minimal footprint (50-200 MiB per node) makes it ideal for the DaemonSet tier
- Fluentd's rich plugin ecosystem handles complex transformations and multi-destination routing
- File-backed buffers ensure no log loss during backend outages or Fluentd restarts
- The shared key between Fluent Bit and Fluentd prevents unauthorized log injection
- Prometheus metrics from both components enable proactive capacity management

Operational discipline matters as much as configuration: monitor buffer depths and retry rates, set `retry_forever true` for durability, and use `overflow_action block` rather than drop to preserve log integrity under pressure.
