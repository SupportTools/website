---
title: "Kubernetes Logging Architecture: Collecting, Routing, and Storing Application Logs"
date: 2027-08-31T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Logging", "Observability", "Fluent Bit"]
categories:
- Kubernetes
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "Kubernetes logging architecture covering node-level logging with Fluent Bit, sidecar log shipping patterns, structured logging best practices, log routing to multiple backends, log retention, and sampling strategies for production clusters."
more_link: "yes"
url: "/kubernetes-logging-architecture-guide/"
---

Kubernetes produces logs at every layer of the stack: application stdout/stderr, kubelet system journal, audit logs, control plane component logs, and CNI/CSI plugin logs. Without a deliberate logging architecture, these streams remain siloed on nodes, lost when pods are evicted, and inaccessible during post-incident analysis. This guide covers the full logging pipeline from node-level collection through routing, storage, and retention, with production-ready configurations for Fluent Bit, Elasticsearch, Loki, and Splunk backends.

<!--more-->

## Section 1: Kubernetes Log Sources and Retention Model

### Container Log Lifecycle

Container stdout and stderr are captured by the container runtime (containerd/CRI-O) and written to files under `/var/log/pods/` on the node:

```
/var/log/pods/<namespace>_<pod-name>_<uid>/<container-name>/
  0.log          ← current log file
  0.log.gz       ← rotated (if configured)
```

The kubelet's `--container-log-max-size` and `--container-log-max-files` flags control log rotation:

```bash
# Check kubelet log rotation configuration
ps aux | grep kubelet | grep -o '\-\-container-log-max-[^ ]*'
# --container-log-max-size=10Mi
# --container-log-max-files=5

# Total on-node storage per container: 10Mi × 5 = 50Mi
# At 1000 containers per node: 50GB potential log storage
```

**Critical:** Without an external log collection agent, logs are lost when a pod is evicted or rescheduled. The `kubectl logs` command can only read logs that exist on the node.

### Log Formats

```bash
# containerd log format (CRI format)
cat /var/log/pods/production_web-abc123_uid123/web/0.log
# 2026-03-15T10:30:01.123456789Z stdout F {"level":"info","msg":"request received","method":"GET","path":"/api/v1/health","latency_ms":2}

# Log fields:
# [0] timestamp (RFC3339Nano)
# [1] stream (stdout/stderr)
# [2] flags (F=full line, P=partial)
# [3] log content
```

## Section 2: Node-Level Logging with Fluent Bit

Fluent Bit is the production standard for node-level log collection: it consumes ~20 MB of RAM per node and supports tail, systemd, and kernel log inputs.

### DaemonSet Deployment

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
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
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
      - operator: Exists       # Run on all nodes including control plane
      priorityClassName: system-node-critical
      hostNetwork: false
      dnsPolicy: ClusterFirstWithHostNet
      containers:
      - name: fluent-bit
        image: cr.fluentbit.io/fluent/fluent-bit:3.2.0
        resources:
          requests:
            cpu: 50m
            memory: 50Mi
          limits:
            cpu: 200m
            memory: 200Mi
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
          mountPath: /var/fluent-bit/state
        ports:
        - containerPort: 2020
          name: metrics
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
          path: /var/fluent-bit/state
          type: DirectoryOrCreate
```

### Fluent Bit Configuration

```ini
# fluent-bit.conf
[SERVICE]
    Flush         5
    Daemon        Off
    Log_Level     info
    HTTP_Server   On
    HTTP_Listen   0.0.0.0
    HTTP_Port     2020
    storage.type  filesystem
    storage.path  /var/fluent-bit/state/flb-storage/
    storage.sync  normal
    storage.checksum off
    storage.max_chunks_up 128

[INPUT]
    Name              tail
    Tag               kube.*
    Path              /var/log/pods/*/*/*.log
    Parser            cri
    DB                /var/fluent-bit/state/flb_kube.db
    Mem_Buf_Limit     50MB
    Skip_Long_Lines   On
    Refresh_Interval  10
    Rotate_Wait       30
    storage.type      filesystem

[INPUT]
    Name              systemd
    Tag               host.*
    Systemd_Filter    _SYSTEMD_UNIT=kubelet.service
    Systemd_Filter    _SYSTEMD_UNIT=containerd.service
    DB                /var/fluent-bit/state/flb_systemd.db
    Strip_Underscores On

[FILTER]
    Name                kubernetes
    Match               kube.*
    Kube_URL            https://kubernetes.default.svc:443
    Kube_CA_File        /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
    Kube_Token_File     /var/run/secrets/kubernetes.io/serviceaccount/token
    Kube_Tag_Prefix     kube.var.log.pods.
    Merge_Log           On
    Merge_Log_Trim      On
    Keep_Log            Off
    K8S-Logging.Parser  On
    K8S-Logging.Exclude Off
    Annotations         Off
    Labels              On
    Buffer_Size         32k

[FILTER]
    Name    record_modifier
    Match   kube.*
    Record  cluster_name ${CLUSTER_NAME}
    Record  environment ${ENVIRONMENT}

[FILTER]
    Name    grep
    Match   kube.*
    Exclude log ^$

[OUTPUT]
    Name                          es
    Match                         kube.*
    Host                          elasticsearch-master.logging.svc.cluster.local
    Port                          9200
    HTTP_User                     ${ES_USER}
    HTTP_Passwd                   ${ES_PASSWORD}
    tls                           On
    tls.verify                    On
    tls.ca_file                   /etc/ssl/certs/ca-bundle.crt
    Index                         kubernetes-logs
    Type                          _doc
    Logstash_Format               On
    Logstash_Prefix               kube-logs
    Logstash_DateFormat           %Y.%m.%d
    Replace_Dots                  On
    Retry_Limit                   False
    Buffer_Size                   5MB
    Compress                      gzip
    Workers                       2

[OUTPUT]
    Name  prometheus_exporter
    Match *
    Host  0.0.0.0
    Port  2020
```

### CRI Parser Definition

```ini
[PARSER]
    Name        cri
    Format      regex
    Regex       ^(?<time>[^ ]+) (?<stream>stdout|stderr) (?<logtag>[^ ]*) (?<log>.*)$
    Time_Key    time
    Time_Format %Y-%m-%dT%H:%M:%S.%L%z
    Time_Keep   On
```

## Section 3: Structured Logging Best Practices

Applications must emit structured logs (JSON) to enable reliable field extraction in downstream processors.

### Go Application Structured Logging

```go
package main

import (
    "log/slog"
    "net/http"
    "os"
    "time"
)

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level:     slog.LevelInfo,
        AddSource: true,
    }))
    slog.SetDefault(logger)

    http.HandleFunc("/api/v1/orders", func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()

        // Process request...

        slog.InfoContext(r.Context(), "request completed",
            slog.String("method", r.Method),
            slog.String("path", r.URL.Path),
            slog.String("remote_addr", r.RemoteAddr),
            slog.Int("status", 200),
            slog.Duration("latency", time.Since(start)),
            slog.String("trace_id", r.Header.Get("X-Trace-ID")),
        )
    })
}
```

Output format:
```json
{
  "time": "2026-03-15T10:30:01.123Z",
  "level": "INFO",
  "source": {"function": "main.handler", "file": "main.go", "line": 25},
  "msg": "request completed",
  "method": "GET",
  "path": "/api/v1/orders",
  "remote_addr": "10.0.0.5:52341",
  "status": 200,
  "latency": "2.1ms",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

### Fluent Bit JSON Parsing

```ini
[PARSER]
    Name        json_application
    Format      json
    Time_Key    time
    Time_Format %Y-%m-%dT%H:%M:%S.%LZ
    Time_Keep   On
    Decode_Field_As json log

[FILTER]
    Name    parser
    Match   kube.*
    Key_Name log
    Parser  json_application
    Reserve_Data On
    Preserve_Key Off
```

## Section 4: Sidecar Log Shipping Pattern

When an application writes logs to files rather than stdout (legacy apps, audit logs), use a sidecar container to ship logs from a shared volume.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: legacy-app
  namespace: production
spec:
  template:
    spec:
      volumes:
      - name: app-logs
        emptyDir: {}
      - name: fluent-bit-config
        configMap:
          name: sidecar-fluent-bit-config
      initContainers:
      - name: log-dir-init
        image: busybox:latest
        command: ["sh", "-c", "mkdir -p /logs && chmod 777 /logs"]
        volumeMounts:
        - name: app-logs
          mountPath: /logs
      containers:
      - name: app
        image: legacy-app:v1.0
        volumeMounts:
        - name: app-logs
          mountPath: /app/logs
        # App writes to /app/logs/application.log
      - name: log-shipper
        image: cr.fluentbit.io/fluent/fluent-bit:3.2.0
        resources:
          requests:
            cpu: 10m
            memory: 20Mi
          limits:
            cpu: 50m
            memory: 50Mi
        volumeMounts:
        - name: app-logs
          mountPath: /logs
          readOnly: true
        - name: fluent-bit-config
          mountPath: /fluent-bit/etc/
```

```ini
# sidecar fluent-bit.conf
[SERVICE]
    Flush     1
    Daemon    Off
    Log_Level warn

[INPUT]
    Name    tail
    Path    /logs/*.log
    Tag     sidecar.*
    DB      /tmp/flb_sidecar.db

[FILTER]
    Name    record_modifier
    Match   sidecar.*
    Record  pod_name ${POD_NAME}
    Record  namespace ${POD_NAMESPACE}
    Record  container legacy-app

[OUTPUT]
    Name   loki
    Match  sidecar.*
    Host   loki.logging.svc.cluster.local
    Port   3100
    Labels job=legacy-app,namespace=${POD_NAMESPACE}
```

## Section 5: Log Routing to Multiple Backends

### Multi-Output with Routing Tags

```ini
# Route error logs to PagerDuty/Splunk, all logs to Loki
[FILTER]
    Name    rewrite_tag
    Match   kube.*
    Rule    $level ^(error|fatal|critical)$ errors.$TAG false

[OUTPUT]
    Name    splunk
    Match   errors.*
    Host    splunk.example.com
    Port    8088
    Splunk_Token ${SPLUNK_HEC_TOKEN}
    Splunk_Send_Raw On
    TLS     On
    TLS.Verify On

[OUTPUT]
    Name   loki
    Match  kube.*
    Host   loki.logging.svc.cluster.local
    Port   3100
    Labels  job=kubernetes,cluster=${CLUSTER_NAME}
    Label_Keys  $kubernetes['namespace_name'],$kubernetes['pod_name'],$kubernetes['container_name']
    Auto_Kubernetes_Labels On
    Batch_Size  1048576
    Batch_Wait  1s
    Workers     4
```

### Elasticsearch Index Lifecycle Management

```bash
# Create ILM policy for log retention
curl -X PUT "https://elasticsearch:9200/_ilm/policy/kube-logs-policy" \
  -H "Content-Type: application/json" \
  -d '{
    "policy": {
      "phases": {
        "hot": {
          "min_age": "0ms",
          "actions": {
            "rollover": {
              "max_primary_shard_size": "50gb",
              "max_age": "1d"
            }
          }
        },
        "warm": {
          "min_age": "2d",
          "actions": {
            "shrink": {"number_of_shards": 1},
            "forcemerge": {"max_num_segments": 1}
          }
        },
        "cold": {
          "min_age": "7d",
          "actions": {
            "freeze": {}
          }
        },
        "delete": {
          "min_age": "30d",
          "actions": {
            "delete": {}
          }
        }
      }
    }
  }'
```

## Section 6: Loki Integration

Grafana Loki uses a label-based index (similar to Prometheus) to avoid the high cost of full-text indexing, making it 10x cheaper than Elasticsearch at scale.

### Loki Helm Deployment

```yaml
# loki-values.yaml
loki:
  auth_enabled: false
  commonConfig:
    replication_factor: 3
  storage:
    type: s3
    s3:
      endpoint: s3.us-east-1.amazonaws.com
      region: us-east-1
      bucketnames: example-loki-chunks
      # Use IAM role for authentication; no hardcoded keys
      s3ForcePathStyle: false
  schemaConfig:
    configs:
    - from: "2024-01-01"
      store: tsdb
      object_store: s3
      schema: v13
      index:
        prefix: loki_index_
        period: 24h
  limits_config:
    ingestion_rate_mb: 32
    ingestion_burst_size_mb: 64
    max_streams_per_user: 10000
    max_label_names_per_series: 30
    retention_period: 90d
    reject_old_samples: true
    reject_old_samples_max_age: 168h

singleBinary:
  replicas: 3

gateway:
  enabled: true
  replicas: 2
```

### LogQL Queries for Operations

```bash
# Show error logs from a specific service in the last hour
{namespace="production", app="api-service"} |= "level=error" | json | line_format "{{.msg}}"

# Count error rate by pod over 5m
sum by (pod) (rate({namespace="production", app="api-service"} | json | level="error" [5m]))

# Extract latency from structured logs and compute p99
{namespace="production"} | json | unwrap latency_ms | quantile_over_time(0.99, [5m]) by (pod)

# Find logs within a trace
{namespace="production"} | json | trace_id="4bf92f3577b34da6a3ce929d0e0e4736"

# Alert rule: high error rate in Grafana
- alert: HighErrorRate
  expr: |
    sum(rate({namespace="production"} | json | level="error" [5m])) by (app)
    /
    sum(rate({namespace="production"} [5m])) by (app)
    > 0.05
  for: 5m
  annotations:
    summary: "Error rate above 5% for {{ $labels.app }}"
```

## Section 7: Log Sampling Strategies

At high throughput (>100k lines/second), storing every log line becomes cost-prohibitive. Implement sampling to reduce volume without losing signal.

### Fluent Bit Sampling

```ini
# Sample 10% of info-level logs, keep all warnings and errors
[FILTER]
    Name    lua
    Match   kube.*
    Script  /fluent-bit/scripts/sample.lua
    Call    cb_sample
```

```lua
-- sample.lua
local counter = 0

function cb_sample(tag, timestamp, record)
    local level = record["level"] or ""
    -- Always keep warning/error/critical
    if level == "warning" or level == "error" or level == "critical" or level == "fatal" then
        return 1, timestamp, record
    end
    -- Sample 10% of info/debug
    counter = counter + 1
    if counter % 10 == 0 then
        return 1, timestamp, record
    end
    -- Drop this record
    return -1, timestamp, record
end
```

### Probabilistic Sampling with Throttle Filter

```ini
[FILTER]
    Name       throttle
    Match      kube.*
    Rate       10000      # Max 10000 records per window
    Window     10         # 10 second window
    Print_Status True
```

### Deduplication

```ini
[FILTER]
    Name    dedup
    Match   kube.*
    Key_Name log
    Keep_First On
```

## Section 8: Kubernetes Audit Logs

Kubernetes audit logs record every API server request. Configure the audit policy to capture security-relevant events without excessive volume.

```yaml
# audit-policy.yaml
apiVersion: audit.k8s.io/v1
kind: Policy
rules:
# Log pod exec/attach at RequestResponse level
- level: RequestResponse
  resources:
  - group: ""
    resources: ["pods/exec", "pods/attach", "pods/portforward"]

# Log Secret access at Metadata level (no content)
- level: Metadata
  resources:
  - group: ""
    resources: ["secrets", "configmaps"]

# Log RBAC changes
- level: RequestResponse
  resources:
  - group: "rbac.authorization.k8s.io"
    resources: ["roles", "clusterroles", "rolebindings", "clusterrolebindings"]

# Log namespace creation/deletion
- level: RequestResponse
  resources:
  - group: ""
    resources: ["namespaces"]
  verbs: ["create", "delete"]

# Skip health check noise
- level: None
  users: ["system:kube-proxy"]
  verbs: ["watch"]
  resources:
  - group: ""
    resources: ["endpoints", "services", "services/status"]

- level: None
  nonResourceURLs:
  - "/healthz*"
  - "/readyz*"
  - "/livez*"

# Default: log at Metadata
- level: Metadata
  omitStages:
  - "RequestReceived"
```

```bash
# Apply audit policy to API server
# Add to kube-apiserver manifest:
# --audit-policy-file=/etc/kubernetes/audit/audit-policy.yaml
# --audit-log-path=/var/log/kubernetes/audit.log
# --audit-log-maxage=7
# --audit-log-maxbackup=10
# --audit-log-maxsize=100

# Ship audit logs with a separate Fluent Bit input
```

## Section 9: Log Alerting

### Fluent Bit to Alertmanager via HTTP Output

```ini
[OUTPUT]
    Name    http
    Match   errors.*
    Host    alertmanager.monitoring.svc.cluster.local
    Port    9093
    URI     /api/v2/alerts
    Format  json
    Headers Content-Type application/json
```

### Loki Ruler for Log-Based Alerts

```yaml
# Loki ruler configuration
ruler:
  enabled: true
  storage:
    type: s3
    s3:
      bucketnames: example-loki-ruler
  rule_path: /rules
  alertmanager_url: http://alertmanager.monitoring.svc.cluster.local:9093
  ring:
    kvstore:
      store: memberlist
  enable_api: true
  enable_alertmanager_v2: true

# Alert rule (stored in ConfigMap mounted to ruler)
groups:
- name: kubernetes-logs
  interval: 1m
  rules:
  - alert: PodOOMKilled
    expr: |
      count_over_time(
        {namespace=~".+"}
        |= "OOMKilled"
        [5m]
      ) > 0
    annotations:
      summary: "OOM kill detected in {{ $labels.namespace }}"
```

## Section 10: Log Retention and Cost Management

### S3 Lifecycle Policy for Loki

```bash
aws s3api put-bucket-lifecycle-configuration \
  --bucket example-loki-chunks \
  --lifecycle-configuration '{
    "Rules": [
      {
        "ID": "LokiChunksRetention",
        "Status": "Enabled",
        "Filter": {"Prefix": ""},
        "Transitions": [
          {"Days": 30, "StorageClass": "STANDARD_IA"},
          {"Days": 90, "StorageClass": "GLACIER"}
        ],
        "Expiration": {"Days": 365}
      }
    ]
  }'
```

### Namespace-Level Log Volume Monitoring

```yaml
# Prometheus rule: alert on log ingestion rate exceeding quota
groups:
- name: logging-quotas
  rules:
  - alert: NamespaceLogVolumeExceeded
    expr: |
      sum by (namespace) (
        rate(fluentbit_output_proc_bytes_total{name="loki"}[5m])
      ) > 10485760   # 10 MB/s per namespace
    for: 10m
    labels:
      severity: warning
    annotations:
      summary: "Namespace {{ $labels.namespace }} exceeding log volume quota"
      description: "Log ingestion rate is {{ $value | humanize }}B/s"
```

## Summary

A production Kubernetes logging architecture requires node-level Fluent Bit DaemonSets for low-overhead collection, structured JSON logging from applications to enable field extraction, and routing to cost-appropriate backends: Elasticsearch for full-text search, Loki for label-based querying at reduced cost, and Splunk for enterprise security and compliance. Implement sampling for high-volume debug logs, retain audit logs with strict access controls, and establish namespace-level cost quotas to prevent logging runaway from consuming disproportionate storage.
