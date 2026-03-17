---
title: "Fluentd and Fluent Bit: Log Pipeline Architecture for Kubernetes at Scale"
date: 2030-07-03T00:00:00-05:00
draft: false
tags: ["Fluentd", "Fluent Bit", "Kubernetes", "Logging", "Elasticsearch", "Loki", "Observability"]
categories:
- Kubernetes
- Observability
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise log pipeline guide covering Fluent Bit DaemonSet configuration, Fluentd aggregation, routing and filtering, multi-destination outputs including Elasticsearch, S3, and Loki, backpressure handling, and performance tuning for large Kubernetes clusters."
more_link: "yes"
url: "/fluentd-fluent-bit-log-pipeline-kubernetes-scale/"
---

Building a reliable log pipeline for Kubernetes clusters at enterprise scale requires careful design choices across collection, aggregation, routing, and storage layers. Fluent Bit and Fluentd occupy distinct roles in this architecture: Fluent Bit handles high-throughput collection at the node level with minimal resource consumption, while Fluentd manages complex routing logic, transformation, and multi-destination fan-out. Understanding where each tool excels — and how they interact — is the foundation of a log pipeline that survives node failures, traffic spikes, and schema evolution without data loss.

<!--more-->

## Architecture Overview

A production Kubernetes log pipeline typically follows a two-tier model:

- **Tier 1 — Fluent Bit DaemonSet**: One pod per node, reading container log files from `/var/log/containers/`, enriching records with Kubernetes metadata, and forwarding to aggregators. Resource footprint: 20–50 MB RAM, <5% CPU per node.
- **Tier 2 — Fluentd Aggregators**: A StatefulSet or Deployment receiving forwarded logs, applying business logic (routing, redaction, enrichment), and writing to multiple backends.

This separation keeps node-level collection lightweight while centralizing complex routing decisions.

```
┌─────────────────────────────────────┐
│  Kubernetes Node                    │
│  ┌─────────────────────────────┐    │
│  │  Fluent Bit DaemonSet Pod   │    │
│  │  - tail /var/log/containers │    │
│  │  - kubernetes metadata      │    │
│  │  - basic filtering          │    │
│  └─────────────┬───────────────┘    │
└────────────────│────────────────────┘
                 │ Forward protocol
                 ▼
     ┌───────────────────────┐
     │  Fluentd Aggregators  │
     │  - routing rules      │
     │  - PII redaction      │
     │  - schema transform   │
     └───────┬───────┬───────┘
             │       │
     ┌───────┘       └────────┐
     ▼                        ▼
Elasticsearch              Amazon S3
+ Grafana Loki         (long-term archive)
```

## Fluent Bit DaemonSet Configuration

### Namespace and RBAC

Fluent Bit requires read access to pod metadata via the Kubernetes API:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: logging
---
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
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: fluent-bit-read
subjects:
  - kind: ServiceAccount
    name: fluent-bit
    namespace: logging
```

### ConfigMap — Core Configuration

The Fluent Bit configuration is split into functional sections within the ConfigMap. This example targets a 500-node cluster with mixed workloads:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: fluent-bit-config
  namespace: logging
data:
  fluent-bit.conf: |
    [SERVICE]
        Flush         5
        Daemon        Off
        Log_Level     info
        Parsers_File  parsers.conf
        HTTP_Server   On
        HTTP_Listen   0.0.0.0
        HTTP_Port     2020
        storage.path              /var/log/flb-storage/
        storage.sync              normal
        storage.checksum          off
        storage.max_chunks_up     256
        storage.backlog.mem_limit 50MB

    [INPUT]
        Name              tail
        Tag               kube.*
        Path              /var/log/containers/*.log
        Parser            docker
        DB                /var/log/flb_kube.db
        Mem_Buf_Limit     50MB
        Skip_Long_Lines   On
        Refresh_Interval  10
        Rotate_Wait       30
        storage.type      filesystem

    [INPUT]
        Name            systemd
        Tag             node.*
        Systemd_Filter  _SYSTEMD_UNIT=kubelet.service
        Systemd_Filter  _SYSTEMD_UNIT=containerd.service
        DB              /var/log/flb_systemd.db
        Max_Fields      200
        Max_Entries     1000
        storage.type    filesystem

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
        Buffer_Size         32KB

    [FILTER]
        Name    grep
        Match   kube.*
        Exclude $kubernetes['namespace_name'] ^(kube-system|kube-public)$

    [FILTER]
        Name         throttle
        Match        kube.*
        Rate         1000
        Window       5
        Print_Status On
        Interval     10s

    [OUTPUT]
        Name          forward
        Match         kube.*
        Host          fluentd-aggregator.logging.svc.cluster.local
        Port          24224
        Self_Hostname ${HOSTNAME}
        Shared_Key    ${FORWARD_SHARED_KEY}
        tls           on
        tls.verify    on
        tls.ca_file   /fluent-bit/certs/ca.crt
        Retry_Limit   False
        storage.total_limit_size 2G

    [OUTPUT]
        Name          forward
        Match         node.*
        Host          fluentd-aggregator.logging.svc.cluster.local
        Port          24224
        Self_Hostname ${HOSTNAME}
        Shared_Key    ${FORWARD_SHARED_KEY}
        tls           on
        tls.verify    on
        tls.ca_file   /fluent-bit/certs/ca.crt
        Retry_Limit   False

  parsers.conf: |
    [PARSER]
        Name        docker
        Format      json
        Time_Key    time
        Time_Format %Y-%m-%dT%H:%M:%S.%L
        Time_Keep   On

    [PARSER]
        Name        cri
        Format      regex
        Regex       ^(?<time>[^ ]+) (?<stream>stdout|stderr) (?<logtag>[^ ]*) (?<log>.*)$
        Time_Key    time
        Time_Format %Y-%m-%dT%H:%M:%S.%L%z

    [PARSER]
        Name        nginx
        Format      regex
        Regex       ^(?<remote>[^ ]*) (?<host>[^ ]*) (?<user>[^ ]*) \[(?<time>[^\]]*)\] "(?<method>\S+)(?: +(?<path>[^\"]*?)(?: +\S*)?)?" (?<code>[^ ]*) (?<size>[^ ]*)(?: "(?<referer>[^\"]*)" "(?<agent>[^\"]*)")?$
        Time_Key    time
        Time_Format %d/%b/%Y:%H:%M:%S %z

    [PARSER]
        Name        json_no_time
        Format      json
        Time_Key    __none__
```

### DaemonSet Manifest

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: fluent-bit
  namespace: logging
  labels:
    app: fluent-bit
    version: "2.2.3"
spec:
  selector:
    matchLabels:
      app: fluent-bit
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
  template:
    metadata:
      labels:
        app: fluent-bit
        version: "2.2.3"
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "2020"
        prometheus.io/path: "/api/v1/metrics/prometheus"
    spec:
      serviceAccountName: fluent-bit
      tolerations:
        - key: node-role.kubernetes.io/control-plane
          operator: Exists
          effect: NoSchedule
        - key: node-role.kubernetes.io/master
          operator: Exists
          effect: NoSchedule
      terminationGracePeriodSeconds: 30
      containers:
        - name: fluent-bit
          image: fluent/fluent-bit:2.2.3
          imagePullPolicy: IfNotPresent
          ports:
            - name: http
              containerPort: 2020
              protocol: TCP
          env:
            - name: HOSTNAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
            - name: FORWARD_SHARED_KEY
              valueFrom:
                secretKeyRef:
                  name: fluent-forward-secret
                  key: shared-key
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 256Mi
          livenessProbe:
            httpGet:
              path: /
              port: http
            initialDelaySeconds: 30
            periodSeconds: 30
            timeoutSeconds: 5
            failureThreshold: 3
          readinessProbe:
            httpGet:
              path: /api/v1/health
              port: http
            initialDelaySeconds: 10
            periodSeconds: 15
            timeoutSeconds: 5
            failureThreshold: 3
          volumeMounts:
            - name: varlog
              mountPath: /var/log
            - name: varlibdockercontainers
              mountPath: /var/lib/docker/containers
              readOnly: true
            - name: config
              mountPath: /fluent-bit/etc/
            - name: certs
              mountPath: /fluent-bit/certs/
              readOnly: true
            - name: storage
              mountPath: /var/log/flb-storage/
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
        - name: certs
          secret:
            secretName: fluent-bit-tls
        - name: storage
          hostPath:
            path: /var/log/flb-storage
            type: DirectoryOrCreate
      priorityClassName: system-node-critical
```

## Fluentd Aggregator Configuration

### StatefulSet for Stateful Buffer Management

Using a StatefulSet ensures each aggregator pod gets a dedicated persistent volume for its buffer — critical for preventing log loss during restarts:

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: fluentd-aggregator
  namespace: logging
spec:
  serviceName: fluentd-aggregator
  replicas: 3
  selector:
    matchLabels:
      app: fluentd-aggregator
  template:
    metadata:
      labels:
        app: fluentd-aggregator
    spec:
      terminationGracePeriodSeconds: 60
      containers:
        - name: fluentd
          image: fluent/fluentd-kubernetes-daemonset:v1.16.5-debian-forward-1.0
          imagePullPolicy: IfNotPresent
          ports:
            - name: forward
              containerPort: 24224
              protocol: TCP
            - name: metrics
              containerPort: 24231
              protocol: TCP
          env:
            - name: FORWARD_SHARED_KEY
              valueFrom:
                secretKeyRef:
                  name: fluent-forward-secret
                  key: shared-key
            - name: ELASTICSEARCH_HOST
              value: "elasticsearch-master.logging.svc.cluster.local"
            - name: ELASTICSEARCH_PORT
              value: "9200"
            - name: S3_BUCKET
              value: "company-logs-archive"
            - name: S3_REGION
              value: "us-east-1"
          resources:
            requests:
              cpu: 500m
              memory: 1Gi
            limits:
              cpu: 2000m
              memory: 4Gi
          volumeMounts:
            - name: config
              mountPath: /fluentd/etc/
            - name: buffer
              mountPath: /fluentd/buffer/
            - name: certs
              mountPath: /fluentd/certs/
              readOnly: true
      volumes:
        - name: config
          configMap:
            name: fluentd-aggregator-config
        - name: certs
          secret:
            secretName: fluentd-aggregator-tls
  volumeClaimTemplates:
    - metadata:
        name: buffer
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: gp3
        resources:
          requests:
            storage: 50Gi
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
    - name: forward
      port: 24224
      targetPort: 24224
    - name: metrics
      port: 24231
      targetPort: 24231
  clusterIP: None
```

### Fluentd Configuration with Multi-Destination Routing

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: fluentd-aggregator-config
  namespace: logging
data:
  fluent.conf: |
    # -------------------------------------------------------
    # INPUT: Accept from Fluent Bit forwarders
    # -------------------------------------------------------
    <source>
      @type forward
      port 24224
      bind 0.0.0.0
      <security>
        self_hostname "#{ENV['HOSTNAME']}"
        shared_key    "#{ENV['FORWARD_SHARED_KEY']}"
      </security>
      <transport tls>
        cert_path    /fluentd/certs/tls.crt
        private_key_path /fluentd/certs/tls.key
        ca_path      /fluentd/certs/ca.crt
        client_cert_auth true
      </transport>
    </source>

    # -------------------------------------------------------
    # INPUT: Prometheus metrics
    # -------------------------------------------------------
    <source>
      @type prometheus
      bind  0.0.0.0
      port  24231
    </source>
    <source>
      @type prometheus_output_monitor
    </source>
    <source>
      @type prometheus_monitor
    </source>

    # -------------------------------------------------------
    # FILTER: Add aggregator metadata
    # -------------------------------------------------------
    <filter kube.**>
      @type record_transformer
      enable_ruby true
      <record>
        aggregator_host  "#{Socket.gethostname}"
        pipeline_version "2.0"
        received_at      ${time.strftime('%Y-%m-%dT%H:%M:%S.%NZ')}
      </record>
    </filter>

    # -------------------------------------------------------
    # FILTER: PII redaction — credit cards, SSN, emails
    # -------------------------------------------------------
    <filter kube.**>
      @type record_transformer
      enable_ruby true
      <record>
        log ${record["log"].to_s
              .gsub(/\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/, '[CARD-REDACTED]')
              .gsub(/\b\d{3}-\d{2}-\d{4}\b/, '[SSN-REDACTED]')
              .gsub(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/, '[EMAIL-REDACTED]')}
      </record>
    </filter>

    # -------------------------------------------------------
    # FILTER: Parse JSON logs from application containers
    # -------------------------------------------------------
    <filter kube.**>
      @type parser
      key_name log
      reserve_data true
      reserve_time true
      remove_key_name_field false
      emit_invalid_record_to_error false
      <parse>
        @type multi_format
        <pattern>
          format json
        </pattern>
        <pattern>
          format none
        </pattern>
      </parse>
    </filter>

    # -------------------------------------------------------
    # ROUTING: Tag rewriting based on namespace
    # -------------------------------------------------------
    <match kube.**>
      @type rewrite_tag_filter
      <rule>
        key     $.kubernetes.namespace_name
        pattern ^(production|prod-.*)$
        tag     routed.production.${tag}
      </rule>
      <rule>
        key     $.kubernetes.namespace_name
        pattern ^(staging|stg-.*)$
        tag     routed.staging.${tag}
      </rule>
      <rule>
        key     $.kubernetes.namespace_name
        pattern ^(.*audit.*)$
        tag     routed.audit.${tag}
      </rule>
      <rule>
        key     $.kubernetes.namespace_name
        pattern ^(.*)$
        tag     routed.default.${tag}
      </rule>
    </match>

    # -------------------------------------------------------
    # OUTPUT: Production logs → Elasticsearch + S3
    # -------------------------------------------------------
    <match routed.production.**>
      @type copy

      <store>
        @type elasticsearch
        host   "#{ENV['ELASTICSEARCH_HOST']}"
        port   "#{ENV['ELASTICSEARCH_PORT']}"
        scheme https
        ssl_verify true
        ssl_version TLSv1_2
        user   fluentd
        password "#{ENV['ELASTICSEARCH_PASSWORD']}"
        logstash_format    true
        logstash_prefix    k8s-production
        logstash_dateformat %Y.%m.%d
        include_tag_key    true
        tag_key            fluentd_tag
        request_timeout    30s
        reconnect_on_error true
        reload_on_failure  true
        reload_connections false
        <buffer tag,time>
          @type file
          path  /fluentd/buffer/es-production
          timekey      1h
          timekey_wait 5m
          chunk_limit_size  8MB
          total_limit_size  20GB
          flush_mode        interval
          flush_interval    30s
          flush_thread_count 4
          retry_type        exponential_backoff
          retry_wait        1s
          retry_max_interval 30s
          retry_timeout     1h
          overflow_action   block
        </buffer>
      </store>

      <store>
        @type s3
        aws_key_id  "#{ENV['AWS_ACCESS_KEY_ID']}"
        aws_sec_key "#{ENV['AWS_SECRET_ACCESS_KEY']}"
        s3_bucket   "#{ENV['S3_BUCKET']}"
        s3_region   "#{ENV['S3_REGION']}"
        s3_object_key_format "%{path}%{time_slice}_%{index}.%{file_extension}"
        path        logs/production/%Y/%m/%d/
        time_slice_format %Y%m%d%H
        store_as    gzip
        <buffer tag,time>
          @type file
          path /fluentd/buffer/s3-production
          timekey      1h
          timekey_wait 10m
          chunk_limit_size  256MB
          total_limit_size  10GB
          flush_mode        interval
          flush_interval    5m
          retry_type        exponential_backoff
          retry_max_interval 60s
          overflow_action   block
        </buffer>
      </store>
    </match>

    # -------------------------------------------------------
    # OUTPUT: Staging logs → Loki only
    # -------------------------------------------------------
    <match routed.staging.**>
      @type loki
      url "http://loki.logging.svc.cluster.local:3100"
      extra_labels {"env":"staging","cluster":"k8s-prod-01"}
      line_format json
      <label>
        namespace $.kubernetes.namespace_name
        app       $.kubernetes.labels.app
        pod       $.kubernetes.pod_name
      </label>
      <buffer>
        @type file
        path /fluentd/buffer/loki-staging
        flush_interval 10s
        chunk_limit_size 4MB
        total_limit_size 5GB
        overflow_action  drop_oldest_chunk
      </buffer>
    </match>

    # -------------------------------------------------------
    # OUTPUT: Audit logs → Elasticsearch audit index + S3
    # -------------------------------------------------------
    <match routed.audit.**>
      @type copy
      <store>
        @type elasticsearch
        host   "#{ENV['ELASTICSEARCH_HOST']}"
        port   "#{ENV['ELASTICSEARCH_PORT']}"
        scheme https
        ssl_verify true
        user   fluentd
        password "#{ENV['ELASTICSEARCH_PASSWORD']}"
        logstash_format    true
        logstash_prefix    k8s-audit
        logstash_dateformat %Y.%m.%d
        <buffer tag,time>
          @type file
          path  /fluentd/buffer/es-audit
          timekey      1h
          timekey_wait 5m
          chunk_limit_size  8MB
          total_limit_size  10GB
          flush_interval    10s
          overflow_action   block
        </buffer>
      </store>
      <store>
        @type s3
        aws_key_id  "#{ENV['AWS_ACCESS_KEY_ID']}"
        aws_sec_key "#{ENV['AWS_SECRET_ACCESS_KEY']}"
        s3_bucket   "#{ENV['S3_BUCKET']}"
        s3_region   "#{ENV['S3_REGION']}"
        s3_object_key_format "%{path}%{time_slice}_%{index}.%{file_extension}"
        path        logs/audit/%Y/%m/%d/
        time_slice_format %Y%m%d%H
        store_as    gzip
        <buffer tag,time>
          @type file
          path /fluentd/buffer/s3-audit
          timekey      1h
          timekey_wait 10m
          chunk_limit_size  256MB
          total_limit_size  5GB
          overflow_action   block
        </buffer>
      </store>
    </match>

    # -------------------------------------------------------
    # OUTPUT: Default → Loki
    # -------------------------------------------------------
    <match routed.default.**>
      @type loki
      url "http://loki.logging.svc.cluster.local:3100"
      extra_labels {"env":"default","cluster":"k8s-prod-01"}
      line_format json
      <label>
        namespace $.kubernetes.namespace_name
        app       $.kubernetes.labels.app
      </label>
      <buffer>
        @type memory
        flush_interval 15s
        chunk_limit_size 2MB
        total_limit_size 1GB
        overflow_action drop_oldest_chunk
      </buffer>
    </match>

    # -------------------------------------------------------
    # OUTPUT: node.* → Elasticsearch node index
    # -------------------------------------------------------
    <match node.**>
      @type elasticsearch
      host   "#{ENV['ELASTICSEARCH_HOST']}"
      port   "#{ENV['ELASTICSEARCH_PORT']}"
      scheme https
      ssl_verify true
      user   fluentd
      password "#{ENV['ELASTICSEARCH_PASSWORD']}"
      logstash_format    true
      logstash_prefix    k8s-node
      logstash_dateformat %Y.%m.%d
      <buffer tag,time>
        @type file
        path  /fluentd/buffer/es-node
        timekey      1h
        timekey_wait 5m
        chunk_limit_size  8MB
        total_limit_size  5GB
        flush_interval    60s
        overflow_action   block
      </buffer>
    </match>
```

## Backpressure Handling

### Understanding the Backpressure Chain

Backpressure propagates from slow outputs upstream through the buffer and eventually to Fluent Bit's tail input. Without proper configuration, this causes log loss or excessive memory consumption.

The key principle: **file-backed buffers at every critical output** combined with `overflow_action: block` for must-not-lose destinations, and `overflow_action: drop_oldest_chunk` for best-effort destinations.

```
Fluent Bit tail input
    │
    │ Mem_Buf_Limit 50MB   ← primary backpressure signal
    │ storage.type filesystem ← spills to disk when mem full
    │
    ▼
Fluent Bit forward OUTPUT
    │
    │ storage.total_limit_size 2G ← disk buffer cap
    │ Retry_Limit False           ← never drop, keep retrying
    │
    ▼
Fluentd forward INPUT (TCP)
    │
    ▼
Fluentd buffer (file type)
    │
    │ overflow_action block  ← stalls forward input
    │                          which stalls Fluent Bit
    ▼
Elasticsearch / S3 / Loki
```

### Monitoring Buffer Utilization

Deploy a Prometheus rule to alert on buffer saturation before it causes data loss:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: fluentd-buffer-alerts
  namespace: logging
spec:
  groups:
    - name: fluentd.buffer
      interval: 60s
      rules:
        - alert: FluentdBufferHighUtilization
          expr: |
            (
              fluentd_output_status_buffer_total_bytes
              / fluentd_output_status_buffer_total_size_limit
            ) > 0.80
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Fluentd buffer utilization above 80%"
            description: "Plugin {{ $labels.plugin_id }} buffer is {{ $value | humanizePercentage }} full"

        - alert: FluentdBufferCritical
          expr: |
            (
              fluentd_output_status_buffer_total_bytes
              / fluentd_output_status_buffer_total_size_limit
            ) > 0.95
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "Fluentd buffer near capacity — risk of data loss"

        - alert: FluentdRetryCount
          expr: fluentd_output_status_retry_count > 100
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Fluentd output retrying frequently"

        - alert: FluentBitMemBufLimit
          expr: |
            fluentbit_input_storage_overlimit == 1
          for: 1m
          labels:
            severity: warning
          annotations:
            summary: "Fluent Bit input exceeded Mem_Buf_Limit, using filesystem buffer"
```

## Performance Tuning

### Fluent Bit Throughput Optimization

For nodes generating more than 50,000 log lines per second, increase parallelism and adjust buffer parameters:

```ini
[SERVICE]
    Flush         1
    Workers       4
    storage.path              /var/log/flb-storage/
    storage.sync              full
    storage.max_chunks_up     512
    storage.backlog.mem_limit 100MB

[INPUT]
    Name              tail
    Tag               kube.*
    Path              /var/log/containers/*.log
    Parser            docker
    DB                /var/log/flb_kube.db
    DB.locking        true
    Mem_Buf_Limit     100MB
    Buffer_Chunk_Size 32KB
    Buffer_Max_Size   64KB
    Skip_Long_Lines   On
    Refresh_Interval  5
    Read_from_Head    False
    storage.type      filesystem

[OUTPUT]
    Name          forward
    Match         kube.*
    Host          fluentd-aggregator.logging.svc.cluster.local
    Port          24224
    Shared_Key    ${FORWARD_SHARED_KEY}
    tls           on
    tls.verify    on
    Workers       4
    Compress      gzip
```

### Fluentd Worker Thread Tuning

```ruby
# In fluent.conf
<system>
  workers           4
  root_dir          /fluentd/buffer
  log_level         info
  <log>
    format json
    time_format %Y-%m-%dT%H:%M:%S.%NZ
  </log>
</system>
```

### Elasticsearch Index Template for Log Data

Create an optimized index template before ingesting logs to control shard count and disable expensive features on log fields:

```json
{
  "index_patterns": ["k8s-production-*", "k8s-staging-*"],
  "template": {
    "settings": {
      "number_of_shards": 3,
      "number_of_replicas": 1,
      "refresh_interval": "30s",
      "codec": "best_compression",
      "index.mapping.total_fields.limit": 2000,
      "index.mapping.depth.limit": 10
    },
    "mappings": {
      "dynamic_templates": [
        {
          "strings_as_keyword": {
            "match_mapping_type": "string",
            "mapping": {
              "type": "keyword",
              "ignore_above": 1024
            }
          }
        },
        {
          "log_body": {
            "path_match": "log",
            "mapping": {
              "type": "text",
              "norms": false,
              "fields": {
                "keyword": {
                  "type": "keyword",
                  "ignore_above": 256
                }
              }
            }
          }
        }
      ]
    }
  }
}
```

## Log Exclusion and Noise Reduction

High-volume applications often emit debug logs that have no operational value and consume significant storage. Use Kubernetes pod annotations for per-pod exclusion:

```yaml
# Pod annotation to exclude container from log collection
metadata:
  annotations:
    fluentbit.io/exclude: "true"

# Or exclude only specific containers in a multi-container pod
metadata:
  annotations:
    fluentbit.io/exclude-container: "sidecar-healthcheck"
```

For regex-based filtering at the Fluentd aggregator level:

```xml
<filter kube.**>
  @type grep
  <exclude>
    key     log
    pattern /^\s*$/
  </exclude>
  <exclude>
    key     log
    pattern /Health check OK|readinessProbe|livenessProbe/
  </exclude>
  <and>
    <exclude>
      key     $.kubernetes.labels.app
      pattern /^batch-job-/
    </exclude>
    <exclude>
      key     log_level
      pattern /^(DEBUG|TRACE)$/
    </exclude>
  </and>
</filter>
```

## Multi-Cluster Log Aggregation

When operating multiple Kubernetes clusters, deploy a global Fluentd tier that receives from per-cluster aggregators:

```
Cluster A Fluentd Aggregators ──┐
Cluster B Fluentd Aggregators ──┼──► Global Fluentd ──► Central Elasticsearch
Cluster C Fluentd Aggregators ──┘         │
                                          └──► S3 Archive
```

The per-cluster Fluentd adds cluster identification before forwarding:

```xml
<filter **>
  @type record_transformer
  <record>
    cluster_name  "k8s-prod-us-east-1"
    cluster_region "us-east-1"
    cluster_env    "production"
  </record>
</filter>

<match **>
  @type forward
  <server>
    host global-fluentd.logging.company.internal
    port 24224
  </server>
  <security>
    shared_key "#{ENV['GLOBAL_FORWARD_SHARED_KEY']}"
    self_hostname "#{ENV['HOSTNAME']}"
  </security>
  <buffer>
    @type file
    path /fluentd/buffer/global
    flush_interval 30s
    chunk_limit_size 8MB
    total_limit_size 20GB
    overflow_action  block
  </buffer>
</match>
```

## Operational Runbook

### Checking Pipeline Health

```bash
# Fluent Bit metrics
kubectl port-forward -n logging daemonset/fluent-bit 2020:2020
curl -s http://localhost:2020/api/v1/metrics/prometheus | grep fluentbit

# Fluentd buffer status
kubectl exec -n logging fluentd-aggregator-0 -- \
  fluent-ctl api plugins.flushBuffers

# Check for dropped records
kubectl exec -n logging fluentd-aggregator-0 -- \
  fluentd --dry-run -c /fluentd/etc/fluent.conf

# View Fluentd buffer files
kubectl exec -n logging fluentd-aggregator-0 -- \
  du -sh /fluentd/buffer/*/

# Tail Fluentd logs for errors
kubectl logs -n logging fluentd-aggregator-0 --since=1h | grep -E 'error|warn|retry'
```

### Recovering from a Failed Output

When an Elasticsearch output is unavailable, the file buffer accumulates chunks. After Elasticsearch recovers:

```bash
# Check buffer size
kubectl exec -n logging fluentd-aggregator-0 -- \
  find /fluentd/buffer/es-production -name '*.chunk' | wc -l

# Monitor flush rate after recovery
kubectl exec -n logging fluentd-aggregator-0 -- \
  watch -n5 "ls -la /fluentd/buffer/es-production/ | tail -5"

# If buffer is stuck, force flush
kubectl exec -n logging fluentd-aggregator-0 -- \
  kill -USR1 1
```

### Scaling the Aggregator Tier

Scale horizontally when buffer utilization exceeds 60% consistently:

```bash
kubectl scale statefulset fluentd-aggregator -n logging --replicas=6
```

Fluent Bit automatically distributes connections across aggregator pods via the headless Service DNS round-robin. For weighted distribution, use a ClusterIP Service with session affinity disabled.

## Summary

A production-grade Kubernetes log pipeline built on Fluent Bit and Fluentd delivers:

- **Zero-loss collection** through filesystem-backed buffers at both tiers
- **Flexible routing** based on namespace, label, and log content
- **PII protection** through aggregator-level redaction filters
- **Multi-destination output** to hot (Elasticsearch/Loki) and cold (S3) storage
- **Backpressure propagation** preventing silent drops under sustained load
- **Operational visibility** through Prometheus metrics and alert rules

The separation between lightweight node-level collection (Fluent Bit) and stateful aggregation (Fluentd) allows each tier to be sized, scaled, and updated independently — a critical property when managing logging infrastructure across hundreds of nodes and dozens of application teams.
