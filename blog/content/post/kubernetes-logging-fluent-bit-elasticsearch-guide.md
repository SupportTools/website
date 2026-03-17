---
title: "Kubernetes Logging Architecture: Fluent Bit DaemonSet, Log Aggregation to Elasticsearch, and Structured Log Parsing"
date: 2028-09-01T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Logging", "Fluent Bit", "Elasticsearch", "Observability"]
categories:
- Kubernetes
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "Build a production-grade Kubernetes logging pipeline using Fluent Bit DaemonSets, Elasticsearch, and Kibana. Covers structured log parsing, multiline handling, filtering, routing, and Helm-based deployment."
more_link: "yes"
url: "/kubernetes-logging-fluent-bit-elasticsearch-guide/"
---

Effective observability in Kubernetes begins with reliable log collection. Fluent Bit — a lightweight, high-performance log processor — is the de-facto standard for node-level log collection in Kubernetes clusters. Combined with Elasticsearch and Kibana (the EK stack), it provides powerful full-text search, dashboards, and alerting. This guide covers every layer of the pipeline, from Fluent Bit DaemonSet configuration to structured log parsing, multiline handling, Elasticsearch index templates, and production tuning.

<!--more-->

# Kubernetes Logging Architecture: Fluent Bit DaemonSet, Log Aggregation to Elasticsearch, and Structured Log Parsing

## Section 1: Logging Architecture Overview

Kubernetes logging follows a node-level pattern. Each node writes container stdout/stderr to files under `/var/log/containers/`. Fluent Bit runs as a DaemonSet with host volume mounts to tail these files, parse, enrich, and forward them.

```
┌──────────────────────────────────────────────┐
│  Node                                        │
│  ┌──────────────┐     ┌────────────────────┐ │
│  │  Container   │────▶│ /var/log/containers│ │
│  └──────────────┘     └────────┬───────────┘ │
│                                │              │
│  ┌─────────────────────────────▼───────────┐  │
│  │  Fluent Bit DaemonSet Pod               │  │
│  │  INPUT: tail                            │  │
│  │  FILTER: kubernetes metadata            │  │
│  │  FILTER: parser (JSON/regex)            │  │
│  │  FILTER: modify/nest                    │  │
│  │  OUTPUT: es / http / stdout             │  │
│  └─────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘
            │
            ▼
┌───────────────────────┐     ┌──────────┐
│  Elasticsearch        │────▶│  Kibana  │
│  (index per namespace)│     └──────────┘
└───────────────────────┘
```

Key design decisions:
- **No intermediate aggregator** for small clusters; add Fluentd/Vector as aggregator for large-scale filtering
- **One index per namespace** balances search performance and access control
- **Structured JSON** from applications avoids expensive regex parsing
- **Backpressure handling** through Fluent Bit's storage layer prevents OOM

## Section 2: Namespace and RBAC Setup

```yaml
# fluent-bit-namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: logging
  labels:
    app.kubernetes.io/managed-by: helm
    pod-security.kubernetes.io/enforce: privileged
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: fluent-bit
  namespace: logging
  labels:
    app.kubernetes.io/name: fluent-bit
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: fluent-bit
  labels:
    app.kubernetes.io/name: fluent-bit
rules:
  - apiGroups: [""]
    resources:
      - pods
      - namespaces
      - nodes
      - nodes/proxy
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["replicasets"]
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

## Section 3: Fluent Bit ConfigMap — Core Configuration

The main configuration file controls pipeline behavior:

```yaml
# fluent-bit-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: fluent-bit-config
  namespace: logging
  labels:
    app.kubernetes.io/name: fluent-bit
data:
  fluent-bit.conf: |
    [SERVICE]
        Flush         5
        Daemon        Off
        Log_Level     info
        Parsers_File  parsers.conf
        Parsers_File  custom_parsers.conf
        HTTP_Server   On
        HTTP_Listen   0.0.0.0
        HTTP_Port     2020
        storage.path              /var/fluent-bit/state/flb-storage/
        storage.sync              normal
        storage.checksum          off
        storage.backlog.mem_limit 5M

    [INPUT]
        Name              tail
        Tag               kube.*
        Path              /var/log/containers/*.log
        multiline.parser  docker, cri
        DB                /var/fluent-bit/state/flb_kube.db
        Mem_Buf_Limit     50MB
        Skip_Long_Lines   On
        Refresh_Interval  10
        Rotate_Wait       30
        storage.type      filesystem
        Read_from_Head    False

    # Exclude Fluent Bit's own logs to avoid recursion
    [FILTER]
        Name    grep
        Match   kube.*
        Exclude $kubernetes['container_name'] fluent-bit

    # Kubernetes metadata enrichment
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
        K8S-Logging.Exclude Off
        Labels              On
        Annotations         Off
        Buffer_Size         0

    # Lift nested log_processed fields to top level
    [FILTER]
        Name    nest
        Match   kube.*
        Operation lift
        Nested_under log_processed
        Add_prefix   parsed_

    # Add cluster metadata
    [FILTER]
        Name    modify
        Match   kube.*
        Add     cluster production-us-east-1
        Add     log_pipeline fluent-bit

    # Route to Elasticsearch
    [OUTPUT]
        Name            es
        Match           kube.*
        Host            elasticsearch-master.logging.svc.cluster.local
        Port            9200
        HTTP_User       ${ES_USERNAME}
        HTTP_Passwd     ${ES_PASSWORD}
        tls             On
        tls.verify      Off
        Logstash_Format On
        Logstash_Prefix kube
        Logstash_DateFormat %Y.%m.%d
        Retry_Limit     6
        Replace_Dots    On
        Trace_Error     On
        storage.total_limit_size 1G
        Compress        gzip

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
        Time_Keep   On

    [PARSER]
        Name        syslog-rfc5424
        Format      regex
        Regex       ^\<(?<pri>[0-9]{1,5})\>1 (?<time>[^ ]+) (?<host>[^ ]+) (?<ident>[^ ]+) (?<pid>[-0-9]+) (?<msgid>[^ ]+) (?<extradata>(\[(.*)\]|-)) (?<message>.+)$
        Time_Key    time
        Time_Format %Y-%m-%dT%H:%M:%S.%L%z

    [PARSER]
        Name        nginx-access
        Format      regex
        Regex       ^(?<remote>[^ ]*) (?<host>[^ ]*) (?<user>[^ ]*) \[(?<time>[^\]]*)\] "(?<method>\S+)(?: +(?<path>[^\"]*?)(?:\s+\S*)?)?" (?<code>[^ ]*) (?<size>[^ ]*)(?: "(?<referer>[^\"]*)" "(?<agent>[^\"]*)")?$
        Time_Key    time
        Time_Format %d/%b/%Y:%H:%M:%S %z

    [PARSER]
        Name        json-log
        Format      json
        Time_Key    timestamp
        Time_Format %Y-%m-%dT%H:%M:%S.%LZ

  custom_parsers.conf: |
    # Go structured log (zap / zerolog)
    [PARSER]
        Name        go-zap
        Format      json
        Time_Key    ts
        Time_Format %s.%L

    # Spring Boot / Java logback JSON
    [PARSER]
        Name        logback-json
        Format      json
        Time_Key    @timestamp
        Time_Format %Y-%m-%dT%H:%M:%S.%L%z

    # Python structlog
    [PARSER]
        Name        python-structlog
        Format      json
        Time_Key    timestamp
        Time_Format %Y-%m-%dT%H:%M:%S.%f%z
```

## Section 4: Multiline Log Handling

Multiline logs (Java stack traces, Go panics) require special handling:

```yaml
  fluent-bit-multiline.conf: |
    [MULTILINE_PARSER]
        name          java_multiline
        type          regex
        flush_timeout 2000
        # Stack trace starts with tab or "Caused by:"
        rule          "start_state"   "/^\d{4}-\d{2}-\d{2}/"  "java_after_first"
        rule          "java_after_first" "/^(\s+at |Caused by: |\.{3} \d+ more)/" "java_after_first"

    [MULTILINE_PARSER]
        name          go_panic
        type          regex
        flush_timeout 2000
        rule          "start_state"   "/^goroutine \d+ \[/"   "go_panic_body"
        rule          "go_panic_body" "/^(\s+|goroutine \d+|panic:)/" "go_panic_body"

    [INPUT]
        Name              tail
        Tag               kube.java.*
        Path              /var/log/containers/*java*.log
        multiline.parser  java_multiline
        DB                /var/fluent-bit/state/flb_java.db
        Mem_Buf_Limit     50MB
        storage.type      filesystem
```

## Section 5: DaemonSet Manifest

```yaml
# fluent-bit-daemonset.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: fluent-bit
  namespace: logging
  labels:
    app.kubernetes.io/name: fluent-bit
    app.kubernetes.io/version: "3.1.9"
  annotations:
    prometheus.io/scrape: "true"
    prometheus.io/port: "2020"
    prometheus.io/path: /api/v1/metrics/prometheus
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: fluent-bit
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
  template:
    metadata:
      labels:
        app.kubernetes.io/name: fluent-bit
        app.kubernetes.io/version: "3.1.9"
      annotations:
        checksum/config: "{{ include (print $.Template.BasePath \"/configmap.yaml\") . | sha256sum }}"
    spec:
      serviceAccountName: fluent-bit
      hostNetwork: false
      dnsPolicy: ClusterFirst
      terminationGracePeriodSeconds: 30

      # Tolerate all nodes including masters and tainted nodes
      tolerations:
        - key: node-role.kubernetes.io/master
          effect: NoSchedule
        - key: node-role.kubernetes.io/control-plane
          effect: NoSchedule
        - operator: Exists
          effect: NoExecute
        - operator: Exists
          effect: NoSchedule

      priorityClassName: system-node-critical

      containers:
        - name: fluent-bit
          image: cr.fluentbit.io/fluent/fluent-bit:3.1.9
          imagePullPolicy: IfNotPresent

          ports:
            - name: http
              containerPort: 2020
              protocol: TCP

          env:
            - name: ES_USERNAME
              valueFrom:
                secretKeyRef:
                  name: elasticsearch-credentials
                  key: username
            - name: ES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: elasticsearch-credentials
                  key: password
            - name: NODE_NAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
            - name: HOST_IP
              valueFrom:
                fieldRef:
                  fieldPath: status.hostIP

          resources:
            requests:
              cpu: 50m
              memory: 50Mi
            limits:
              cpu: 500m
              memory: 200Mi

          livenessProbe:
            httpGet:
              path: /
              port: http
            initialDelaySeconds: 10
            periodSeconds: 30
            failureThreshold: 3

          readinessProbe:
            httpGet:
              path: /api/v1/health
              port: http
            initialDelaySeconds: 10
            periodSeconds: 10
            failureThreshold: 3

          volumeMounts:
            - name: config
              mountPath: /fluent-bit/etc/
            - name: varlog
              mountPath: /var/log
              readOnly: true
            - name: varlibdockercontainers
              mountPath: /var/lib/docker/containers
              readOnly: true
            - name: etcmachineid
              mountPath: /etc/machine-id
              readOnly: true
            - name: fluent-bit-state
              mountPath: /var/fluent-bit/state

      volumes:
        - name: config
          configMap:
            name: fluent-bit-config
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
        - name: fluent-bit-state
          hostPath:
            path: /var/fluent-bit/state
            type: DirectoryOrCreate
---
apiVersion: v1
kind: Service
metadata:
  name: fluent-bit
  namespace: logging
  labels:
    app.kubernetes.io/name: fluent-bit
spec:
  selector:
    app.kubernetes.io/name: fluent-bit
  ports:
    - name: http
      port: 2020
      targetPort: http
---
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: fluent-bit
  namespace: logging
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: fluent-bit
  endpoints:
    - port: http
      path: /api/v1/metrics/prometheus
      interval: 30s
```

## Section 6: Elasticsearch Deployment with ECK

Using the Elastic Cloud on Kubernetes (ECK) operator:

```bash
# Install ECK operator
kubectl create -f https://download.elastic.co/downloads/eck/2.13.0/crds.yaml
kubectl apply -f https://download.elastic.co/downloads/eck/2.13.0/operator.yaml
```

```yaml
# elasticsearch-cluster.yaml
apiVersion: elasticsearch.k8s.elastic.co/v1
kind: Elasticsearch
metadata:
  name: logging
  namespace: logging
spec:
  version: 8.14.1
  nodeSets:
    - name: masters
      count: 3
      config:
        node.roles: ["master"]
        xpack.security.enabled: true
        xpack.security.http.ssl.enabled: true
        xpack.security.transport.ssl.enabled: true
      podTemplate:
        spec:
          initContainers:
            - name: sysctl
              securityContext:
                privileged: true
                runAsUser: 0
              command: ["sh", "-c", "sysctl -w vm.max_map_count=262144"]
          containers:
            - name: elasticsearch
              resources:
                requests:
                  memory: 2Gi
                  cpu: 500m
                limits:
                  memory: 2Gi
                  cpu: 2
              env:
                - name: ES_JAVA_OPTS
                  value: "-Xms1g -Xmx1g"
      volumeClaimTemplates:
        - metadata:
            name: elasticsearch-data
          spec:
            accessModes:
              - ReadWriteOnce
            resources:
              requests:
                storage: 10Gi
            storageClassName: gp3

    - name: data-hot
      count: 3
      config:
        node.roles: ["data_hot", "data_content", "ingest"]
        xpack.security.enabled: true
      podTemplate:
        spec:
          initContainers:
            - name: sysctl
              securityContext:
                privileged: true
                runAsUser: 0
              command: ["sh", "-c", "sysctl -w vm.max_map_count=262144"]
          containers:
            - name: elasticsearch
              resources:
                requests:
                  memory: 8Gi
                  cpu: 2
                limits:
                  memory: 8Gi
                  cpu: 4
              env:
                - name: ES_JAVA_OPTS
                  value: "-Xms4g -Xmx4g"
      volumeClaimTemplates:
        - metadata:
            name: elasticsearch-data
          spec:
            accessModes:
              - ReadWriteOnce
            resources:
              requests:
                storage: 200Gi
            storageClassName: gp3

    - name: data-warm
      count: 2
      config:
        node.roles: ["data_warm"]
      podTemplate:
        spec:
          containers:
            - name: elasticsearch
              resources:
                requests:
                  memory: 4Gi
                  cpu: 1
                limits:
                  memory: 4Gi
                  cpu: 2
              env:
                - name: ES_JAVA_OPTS
                  value: "-Xms2g -Xmx2g"
      volumeClaimTemplates:
        - metadata:
            name: elasticsearch-data
          spec:
            accessModes:
              - ReadWriteOnce
            resources:
              requests:
                storage: 500Gi
            storageClassName: st1
---
apiVersion: kibana.k8s.elastic.co/v1
kind: Kibana
metadata:
  name: logging
  namespace: logging
spec:
  version: 8.14.1
  count: 1
  elasticsearchRef:
    name: logging
  config:
    xpack.fleet.enabled: false
  podTemplate:
    spec:
      containers:
        - name: kibana
          resources:
            requests:
              memory: 1Gi
              cpu: 500m
            limits:
              memory: 2Gi
              cpu: 1
```

## Section 7: Elasticsearch Index Template and ILM Policy

```bash
# Create ILM policy for log retention
cat << 'EOF' | curl -s -u elastic:${ES_PASSWORD} -X PUT \
  "https://localhost:9200/_ilm/policy/kubernetes-logs" \
  -H "Content-Type: application/json" -d @-
{
  "policy": {
    "phases": {
      "hot": {
        "min_age": "0ms",
        "actions": {
          "rollover": {
            "max_primary_shard_size": "50gb",
            "max_age": "1d"
          },
          "set_priority": { "priority": 100 }
        }
      },
      "warm": {
        "min_age": "2d",
        "actions": {
          "shrink": { "number_of_shards": 1 },
          "forcemerge": { "max_num_segments": 1 },
          "set_priority": { "priority": 50 }
        }
      },
      "cold": {
        "min_age": "7d",
        "actions": {
          "searchable_snapshot": {
            "snapshot_repository": "s3-logs"
          }
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
}
EOF

# Create index template
cat << 'EOF' | curl -s -u elastic:${ES_PASSWORD} -X PUT \
  "https://localhost:9200/_index_template/kubernetes-logs" \
  -H "Content-Type: application/json" -d @-
{
  "index_patterns": ["kube-*"],
  "template": {
    "settings": {
      "number_of_shards": 2,
      "number_of_replicas": 1,
      "index.lifecycle.name": "kubernetes-logs",
      "index.lifecycle.rollover_alias": "kube-logs",
      "index.routing.allocation.require._tier_preference": "data_hot,data_warm",
      "index.codec": "best_compression",
      "index.refresh_interval": "30s"
    },
    "mappings": {
      "dynamic_templates": [
        {
          "labels_as_keyword": {
            "path_match": "kubernetes.labels.*",
            "mapping": { "type": "keyword" }
          }
        },
        {
          "annotations_as_keyword": {
            "path_match": "kubernetes.annotations.*",
            "mapping": { "type": "keyword" }
          }
        }
      ],
      "properties": {
        "@timestamp": { "type": "date" },
        "log": { "type": "text" },
        "stream": { "type": "keyword" },
        "cluster": { "type": "keyword" },
        "kubernetes": {
          "properties": {
            "pod_name": { "type": "keyword" },
            "namespace_name": { "type": "keyword" },
            "container_name": { "type": "keyword" },
            "node_name": { "type": "keyword" },
            "pod_ip": { "type": "ip" },
            "host": { "type": "keyword" }
          }
        },
        "level": { "type": "keyword" },
        "message": { "type": "text", "analyzer": "standard" },
        "error": { "type": "text" },
        "duration_ms": { "type": "float" },
        "http_status": { "type": "short" },
        "trace_id": { "type": "keyword" },
        "span_id": { "type": "keyword" }
      }
    }
  },
  "priority": 500
}
EOF
```

## Section 8: Per-Namespace Log Routing

Route logs from different namespaces to separate indices for access control and cost allocation:

```ini
# Add to fluent-bit.conf

# Tag by namespace
[FILTER]
    Name    rewrite_tag
    Match   kube.*
    Rule    $kubernetes['namespace_name'] ^(production)$ prod.$TAG false
    Rule    $kubernetes['namespace_name'] ^(staging)$    stg.$TAG  false
    Rule    $kubernetes['namespace_name'] ^(kube-.*)$    sys.$TAG  false
    Emitter_Name re_emitted

# Production namespace output
[OUTPUT]
    Name            es
    Match           prod.*
    Host            elasticsearch-master.logging.svc.cluster.local
    Port            9200
    HTTP_User       ${ES_USERNAME}
    HTTP_Passwd     ${ES_PASSWORD}
    Logstash_Format On
    Logstash_Prefix prod-kube
    Logstash_DateFormat %Y.%m.%d
    storage.total_limit_size 2G

# Staging namespace output — separate index, lower retention
[OUTPUT]
    Name            es
    Match           stg.*
    Host            elasticsearch-master.logging.svc.cluster.local
    Port            9200
    HTTP_User       ${ES_USERNAME}
    HTTP_Passwd     ${ES_PASSWORD}
    Logstash_Format On
    Logstash_Prefix stg-kube
    Logstash_DateFormat %Y.%m.%d
    storage.total_limit_size 500M

# System namespace output
[OUTPUT]
    Name            es
    Match           sys.*
    Host            elasticsearch-master.logging.svc.cluster.local
    Port            9200
    HTTP_User       ${ES_USERNAME}
    HTTP_Passwd     ${ES_PASSWORD}
    Logstash_Format On
    Logstash_Prefix sys-kube
    Logstash_DateFormat %Y.%m.%d
    storage.total_limit_size 500M
```

## Section 9: Helm-Based Deployment

Use the official Fluent Bit Helm chart with custom values:

```bash
helm repo add fluent https://fluent.github.io/helm-charts
helm repo update
```

```yaml
# values-fluent-bit.yaml
image:
  repository: cr.fluentbit.io/fluent/fluent-bit
  tag: "3.1.9"
  pullPolicy: IfNotPresent

serviceAccount:
  create: true
  name: fluent-bit
  annotations:
    eks.amazonaws.com/role-arn: "arn:aws:iam::123456789012:role/fluent-bit-role"

rbac:
  create: true
  nodeAccess: true

podAnnotations:
  prometheus.io/scrape: "true"
  prometheus.io/port: "2020"
  prometheus.io/path: /api/v1/metrics/prometheus

tolerations:
  - operator: Exists

priorityClassName: system-node-critical

resources:
  requests:
    cpu: 50m
    memory: 50Mi
  limits:
    cpu: 500m
    memory: 200Mi

daemonSetVolumes:
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
  - name: fluent-bit-state
    hostPath:
      path: /var/fluent-bit/state
      type: DirectoryOrCreate

daemonSetVolumeMounts:
  - name: varlog
    mountPath: /var/log
    readOnly: true
  - name: varlibdockercontainers
    mountPath: /var/lib/docker/containers
    readOnly: true
  - name: etcmachineid
    mountPath: /etc/machine-id
    readOnly: true
  - name: fluent-bit-state
    mountPath: /var/fluent-bit/state

env:
  - name: ES_USERNAME
    valueFrom:
      secretKeyRef:
        name: elasticsearch-credentials
        key: username
  - name: ES_PASSWORD
    valueFrom:
      secretKeyRef:
        name: elasticsearch-credentials
        key: password

config:
  service: |
    [SERVICE]
        Flush         5
        Daemon        Off
        Log_Level     info
        Parsers_File  /fluent-bit/etc/parsers.conf
        HTTP_Server   On
        HTTP_Listen   0.0.0.0
        HTTP_Port     2020
        storage.path  /var/fluent-bit/state/flb-storage/

  inputs: |
    [INPUT]
        Name              tail
        Tag               kube.*
        Path              /var/log/containers/*.log
        multiline.parser  docker, cri
        DB                /var/fluent-bit/state/flb_kube.db
        Mem_Buf_Limit     50MB
        Skip_Long_Lines   On
        Refresh_Interval  10
        storage.type      filesystem

  filters: |
    [FILTER]
        Name    grep
        Match   kube.*
        Exclude $kubernetes['container_name'] fluent-bit

    [FILTER]
        Name                kubernetes
        Match               kube.*
        Kube_URL            https://kubernetes.default.svc:443
        Merge_Log           On
        Labels              On
        Annotations         Off

    [FILTER]
        Name    modify
        Match   kube.*
        Add     cluster production-us-east-1

  outputs: |
    [OUTPUT]
        Name            es
        Match           kube.*
        Host            elasticsearch-master.logging.svc.cluster.local
        Port            9200
        HTTP_User       ${ES_USERNAME}
        HTTP_Passwd     ${ES_PASSWORD}
        tls             On
        tls.verify      Off
        Logstash_Format On
        Logstash_Prefix kube
        Retry_Limit     6
        storage.total_limit_size 1G
        Compress        gzip

serviceMonitor:
  enabled: true
  namespace: logging
  interval: 30s
```

```bash
helm upgrade --install fluent-bit fluent/fluent-bit \
  --namespace logging \
  --create-namespace \
  --version 0.47.1 \
  -f values-fluent-bit.yaml
```

## Section 10: Structured Logging from Applications

Applications should emit structured JSON to maximize searchability without parsing overhead.

**Go (zerolog):**

```go
package main

import (
    "net/http"
    "os"
    "time"

    "github.com/rs/zerolog"
    "github.com/rs/zerolog/log"
)

func init() {
    zerolog.TimeFieldFormat = zerolog.TimeFormatUnix
    zerolog.SetGlobalLevel(zerolog.InfoLevel)
    // Write JSON to stdout for Fluent Bit to collect
    log.Logger = zerolog.New(os.Stdout).With().
        Timestamp().
        Str("service", "api-server").
        Str("version", "1.2.3").
        Logger()
}

func handler(w http.ResponseWriter, r *http.Request) {
    start := time.Now()
    // ... handle request ...
    log.Info().
        Str("method", r.Method).
        Str("path", r.URL.Path).
        Str("remote_addr", r.RemoteAddr).
        Str("trace_id", r.Header.Get("X-Trace-Id")).
        Int("status", http.StatusOK).
        Dur("duration_ms", time.Since(start)).
        Msg("request completed")
}
```

This produces logs like:

```json
{
  "level": "info",
  "service": "api-server",
  "version": "1.2.3",
  "time": 1725148800,
  "method": "GET",
  "path": "/api/v1/users",
  "remote_addr": "10.0.1.42:54312",
  "trace_id": "abc123def456",
  "status": 200,
  "duration_ms": 12.5,
  "message": "request completed"
}
```

Fluent Bit's `Merge_Log On` setting will automatically merge these fields into the Elasticsearch document without additional parser configuration.

## Section 11: Kibana Dashboard and Index Pattern Setup

```bash
# Create index pattern via Kibana API
curl -s -u elastic:${ES_PASSWORD} -X POST \
  "https://kibana.logging.svc.cluster.local:5601/api/saved_objects/index-pattern" \
  -H "Content-Type: application/json" \
  -H "kbn-xsrf: true" \
  -d '{
    "attributes": {
      "title": "kube-*",
      "timeFieldName": "@timestamp"
    }
  }'

# Create a dashboard for service error rates
cat << 'EOF' > dashboard.json
{
  "attributes": {
    "title": "Kubernetes Pod Errors",
    "panelsJSON": "[{\"type\":\"visualization\",\"gridData\":{\"x\":0,\"y\":0,\"w\":24,\"h\":15,\"i\":\"1\"},\"panelIndex\":\"1\",\"embeddableConfig\":{},\"panelRefName\":\"panel_0\"}]",
    "optionsJSON": "{\"hidePanelTitles\":false,\"useMargins\":true}",
    "timeRestore": false,
    "kibanaSavedObjectMeta": {
      "searchSourceJSON": "{\"query\":{\"query\":\"\",\"language\":\"kuery\"},\"filter\":[]}"
    }
  },
  "type": "dashboard",
  "references": []
}
EOF
```

## Section 12: Alerting on Log Patterns

Use Elasticsearch Watcher for critical log pattern alerting:

```json
PUT _watcher/watch/oom-killer-alert
{
  "trigger": {
    "schedule": { "interval": "1m" }
  },
  "input": {
    "search": {
      "request": {
        "indices": ["kube-*"],
        "body": {
          "query": {
            "bool": {
              "must": [
                { "match": { "log": "OOMKilled" } },
                { "range": { "@timestamp": { "gte": "now-5m" } } }
              ]
            }
          },
          "aggs": {
            "by_pod": {
              "terms": { "field": "kubernetes.pod_name", "size": 10 }
            }
          }
        }
      }
    }
  },
  "condition": {
    "compare": { "ctx.payload.hits.total.value": { "gt": 0 } }
  },
  "actions": {
    "send_slack": {
      "webhook": {
        "scheme": "https",
        "host": "hooks.slack.com",
        "port": 443,
        "method": "post",
        "path": "/services/YOUR/SLACK/WEBHOOK",
        "params": {},
        "headers": { "Content-Type": "application/json" },
        "body": "{\"text\": \"OOMKilled detected in {{ctx.payload.hits.total.value}} pods in last 5 minutes\"}"
      }
    }
  }
}
```

## Section 13: Performance Tuning and Troubleshooting

**Monitor Fluent Bit metrics:**

```bash
# Check Fluent Bit internal metrics
kubectl exec -n logging daemonset/fluent-bit -- \
  curl -s http://localhost:2020/api/v1/metrics | jq .

# Key metrics to watch:
# fluentbit_input_records_total   — records ingested
# fluentbit_output_retries_total  — output retry pressure
# fluentbit_output_dropped_records_total — data loss indicator
# fluentbit_filter_records_total  — filter processing

# Check for dropped records
kubectl exec -n logging daemonset/fluent-bit -- \
  curl -s http://localhost:2020/api/v1/metrics | \
  jq '.output[] | select(.dropped_records > 0)'
```

**Common issues and fixes:**

```bash
# Issue: Fluent Bit using too much memory — reduce buffer size
# In config: Mem_Buf_Limit 20MB (from 50MB)

# Issue: Slow Elasticsearch indexing — increase flush interval
# In config: Flush 10 (from 5)

# Issue: Log files rotating before reading — increase Rotate_Wait
# In config: Rotate_Wait 60

# Verify Elasticsearch connectivity from DaemonSet pod
kubectl exec -n logging daemonset/fluent-bit -- \
  curl -sk -u elastic:${ES_PASSWORD} \
  https://elasticsearch-master.logging.svc.cluster.local:9200/_cat/indices?v

# Check index sizes and document counts
kubectl exec -n logging -it deploy/elasticsearch-master -- \
  curl -sk -u elastic:${ES_PASSWORD} \
  "https://localhost:9200/_cat/indices/kube-*?v&s=docs.count:desc&h=index,docs.count,store.size"
```

**Storage layer for guaranteed delivery:**

```ini
[SERVICE]
    # Persist buffered data to disk to survive pod restarts
    storage.path              /var/fluent-bit/state/flb-storage/
    storage.sync              normal
    storage.checksum          off
    storage.backlog.mem_limit 50M

[INPUT]
    Name         tail
    storage.type filesystem   # filesystem > memory for durability
    ...

[OUTPUT]
    Name         es
    storage.total_limit_size 2G   # max disk used for retry buffer
    Retry_Limit  False            # retry indefinitely
```

This architecture provides a robust, scalable Kubernetes logging pipeline that handles structured and unstructured logs, routes by namespace, persists through pod restarts, and integrates with Elasticsearch for powerful querying and alerting.
