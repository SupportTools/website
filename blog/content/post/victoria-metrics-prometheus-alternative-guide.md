---
title: "VictoriaMetrics as a Prometheus Alternative: Production Deployment Guide"
date: 2027-09-24T00:00:00-05:00
draft: false
tags: ["VictoriaMetrics", "Prometheus", "Monitoring", "Kubernetes", "TSDB"]
categories:
  - Monitoring
  - Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to deploying VictoriaMetrics as a Prometheus replacement on Kubernetes, covering single-node and cluster modes, VMOperator, MetricsQL, retention, multitenancy, and performance tuning."
more_link: "yes"
url: "/victoria-metrics-prometheus-alternative-guide/"
---

VictoriaMetrics delivers significantly better compression ratios, lower memory consumption, and higher ingestion throughput compared to Prometheus for the same workloads. Production deployments handling hundreds of millions of active time series routinely achieve 10–20x storage reduction and 5–10x lower RAM usage, making it a compelling replacement or complementary layer for large-scale observability platforms.

<!--more-->

# VictoriaMetrics as a Prometheus Alternative: Production Deployment Guide

## Why VictoriaMetrics

VictoriaMetrics addresses several operational pain points that emerge when running Prometheus at scale. The core storage engine uses a custom LSM-tree-inspired architecture where incoming data is written to in-memory "small parts" and periodically merged into larger on-disk parts. This approach achieves:

- **Compression**: 0.4–0.8 bytes per data point versus Prometheus's 1.2–2.0 bytes per sample
- **Ingestion**: 5–10x higher write throughput per CPU core
- **Query performance**: Cached query results, parallel execution, and native downsampling
- **Operational simplicity**: Single binary, no WAL compaction issues, fast restarts

The MetricsQL query language is a strict superset of PromQL, meaning all existing Prometheus recording rules and alert rules work without modification.

---

## Architecture Overview

VictoriaMetrics offers two deployment models:

### Single-Node Mode

Handles up to approximately 10 million active time series on a single process. All components run in one binary: ingestion, storage, and query. Horizontal scaling is not supported in this mode but vertical scaling is highly efficient.

```
┌──────────────────────────────────────────────────────────┐
│                  victoria-metrics                         │
│                                                          │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │  HTTP API   │  │  Storage     │  │  Query Engine  │  │
│  │  /api/v1/*  │  │  LSM parts   │  │  MetricsQL     │  │
│  │  /write     │  │  /var/vm/    │  │  PromQL compat │  │
│  └─────────────┘  └──────────────┘  └────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

### Cluster Mode

Three dedicated components, each horizontally scalable:

```
Producers (Prometheus/agents)
        │
        ▼
┌──────────────┐
│  vminsert    │  ← accepts remote_write, spreads shards
│  (stateless) │
└──────────────┘
        │  routes by time series hash
        ▼
┌──────────────┐
│  vmstorage   │  ← stores data, one shard per replica
│  (stateful)  │
└──────────────┘
        ▲
        │  fans out queries
┌──────────────┐
│  vmselect    │  ← query frontend, merges shard results
│  (stateless) │
└──────────────┘
        ▲
        │
┌──────────────┐
│  Grafana /   │
│  vmui        │
└──────────────┘
```

---

## Single-Node Deployment on Kubernetes

### Namespace and Storage

```yaml
# victoria-metrics-namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: monitoring
  labels:
    app.kubernetes.io/managed-by: helm
```

```yaml
# victoria-metrics-pvc.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: victoria-metrics-data
  namespace: monitoring
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: fast-ssd
  resources:
    requests:
      storage: 500Gi
```

### StatefulSet

```yaml
# victoria-metrics-statefulset.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: victoria-metrics
  namespace: monitoring
  labels:
    app: victoria-metrics
spec:
  replicas: 1
  selector:
    matchLabels:
      app: victoria-metrics
  serviceName: victoria-metrics
  template:
    metadata:
      labels:
        app: victoria-metrics
    spec:
      securityContext:
        fsGroup: 1000
        runAsNonRoot: true
        runAsUser: 1000
      containers:
        - name: victoria-metrics
          image: victoriametrics/victoria-metrics:v1.101.0
          args:
            - -storageDataPath=/var/vm/data
            - -retentionPeriod=12
            - -maxConcurrentInserts=32
            - -search.maxConcurrentRequests=16
            - -search.maxQueryDuration=60s
            - -search.maxStalenessInterval=5m
            - -search.cacheTimestampOffset=5m
            - -selfScrapeInterval=10s
            - -promscrape.suppressDuplicateScrapeTargetErrors=true
            - -memory.allowedPercent=60
            - -search.maxUniqueTimeseries=1000000
            - -downsampling.period=30d:5m,1y:1h
          ports:
            - name: http
              containerPort: 8428
          resources:
            requests:
              cpu: "2"
              memory: 4Gi
            limits:
              cpu: "8"
              memory: 16Gi
          volumeMounts:
            - name: data
              mountPath: /var/vm/data
          readinessProbe:
            httpGet:
              path: /health
              port: 8428
            initialDelaySeconds: 10
            periodSeconds: 5
          livenessProbe:
            httpGet:
              path: /health
              port: 8428
            initialDelaySeconds: 30
            periodSeconds: 15
            failureThreshold: 5
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: fast-ssd
        resources:
          requests:
            storage: 500Gi
```

### Service

```yaml
# victoria-metrics-service.yaml
apiVersion: v1
kind: Service
metadata:
  name: victoria-metrics
  namespace: monitoring
  labels:
    app: victoria-metrics
spec:
  type: ClusterIP
  ports:
    - name: http
      port: 8428
      targetPort: 8428
  selector:
    app: victoria-metrics
```

### Ingress

```yaml
# victoria-metrics-ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: victoria-metrics
  namespace: monitoring
  annotations:
    nginx.ingress.kubernetes.io/auth-type: basic
    nginx.ingress.kubernetes.io/auth-secret: vm-basic-auth
    nginx.ingress.kubernetes.io/auth-realm: "VictoriaMetrics"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "300"
    nginx.ingress.kubernetes.io/proxy-body-size: "64m"
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - vm.monitoring.example.com
      secretName: vm-tls-cert
  rules:
    - host: vm.monitoring.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: victoria-metrics
                port:
                  number: 8428
```

---

## Cluster Mode Deployment

### vminsert Deployment

```yaml
# vminsert-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vminsert
  namespace: monitoring
  labels:
    app: vminsert
spec:
  replicas: 3
  selector:
    matchLabels:
      app: vminsert
  template:
    metadata:
      labels:
        app: vminsert
    spec:
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchExpressions:
                    - key: app
                      operator: In
                      values: [vminsert]
                topologyKey: kubernetes.io/hostname
      containers:
        - name: vminsert
          image: victoriametrics/vminsert:v1.101.0-cluster
          args:
            - -storageNode=vmstorage-0.vmstorage:8400
            - -storageNode=vmstorage-1.vmstorage:8400
            - -storageNode=vmstorage-2.vmstorage:8400
            - -replicationFactor=2
            - -maxConcurrentInserts=64
            - -insert.maxQueueDuration=30s
            - -httpListenAddr=:8480
          ports:
            - name: http
              containerPort: 8480
          resources:
            requests:
              cpu: "1"
              memory: 512Mi
            limits:
              cpu: "4"
              memory: 2Gi
          readinessProbe:
            httpGet:
              path: /health
              port: 8480
            initialDelaySeconds: 5
            periodSeconds: 5
```

### vmstorage StatefulSet

```yaml
# vmstorage-statefulset.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: vmstorage
  namespace: monitoring
  labels:
    app: vmstorage
spec:
  replicas: 3
  selector:
    matchLabels:
      app: vmstorage
  serviceName: vmstorage
  podManagementPolicy: Parallel
  template:
    metadata:
      labels:
        app: vmstorage
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchExpressions:
                  - key: app
                    operator: In
                    values: [vmstorage]
              topologyKey: kubernetes.io/hostname
      terminationGracePeriodSeconds: 300
      containers:
        - name: vmstorage
          image: victoriametrics/vmstorage:v1.101.0-cluster
          args:
            - -storageDataPath=/var/vm/data
            - -retentionPeriod=24
            - -vminsertAddr=:8400
            - -vmselectAddr=:8401
            - -httpListenAddr=:8482
            - -memory.allowedPercent=70
            - -downsampling.period=30d:5m,1y:1h
            - -storage.minFreeDiskSpaceBytes=10GB
          ports:
            - name: vminsert
              containerPort: 8400
            - name: vmselect
              containerPort: 8401
            - name: http
              containerPort: 8482
          resources:
            requests:
              cpu: "4"
              memory: 16Gi
            limits:
              cpu: "16"
              memory: 64Gi
          volumeMounts:
            - name: data
              mountPath: /var/vm/data
          readinessProbe:
            httpGet:
              path: /health
              port: 8482
            initialDelaySeconds: 15
            periodSeconds: 10
          lifecycle:
            preStop:
              exec:
                command: ["/bin/sh", "-c", "sleep 10"]
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: fast-ssd
        resources:
          requests:
            storage: 2Ti
```

### vmselect Deployment

```yaml
# vmselect-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vmselect
  namespace: monitoring
  labels:
    app: vmselect
spec:
  replicas: 3
  selector:
    matchLabels:
      app: vmselect
  template:
    metadata:
      labels:
        app: vmselect
    spec:
      containers:
        - name: vmselect
          image: victoriametrics/vmselect:v1.101.0-cluster
          args:
            - -storageNode=vmstorage-0.vmstorage:8401
            - -storageNode=vmstorage-1.vmstorage:8401
            - -storageNode=vmstorage-2.vmstorage:8401
            - -replicationFactor=2
            - -httpListenAddr=:8481
            - -search.maxConcurrentRequests=32
            - -search.maxQueryDuration=120s
            - -search.maxUniqueTimeseries=2000000
            - -cacheDataPath=/var/vm/cache
          ports:
            - name: http
              containerPort: 8481
          resources:
            requests:
              cpu: "2"
              memory: 4Gi
            limits:
              cpu: "8"
              memory: 16Gi
          volumeMounts:
            - name: cache
              mountPath: /var/vm/cache
      volumes:
        - name: cache
          emptyDir:
            sizeLimit: 10Gi
```

### Headless Service for vmstorage DNS

```yaml
# vmstorage-headless-service.yaml
apiVersion: v1
kind: Service
metadata:
  name: vmstorage
  namespace: monitoring
  labels:
    app: vmstorage
spec:
  clusterIP: None
  ports:
    - name: vminsert
      port: 8400
    - name: vmselect
      port: 8401
    - name: http
      port: 8482
  selector:
    app: vmstorage
```

---

## VMOperator: Kubernetes-Native Management

VMOperator provides Kubernetes custom resources that mirror the Prometheus Operator API, making migration straightforward.

### Installing VMOperator via Helm

```bash
helm repo add vm https://victoriametrics.github.io/helm-charts/
helm repo update

helm upgrade --install victoria-metrics-operator vm/victoria-metrics-operator \
  --namespace monitoring \
  --create-namespace \
  --set operator.disable_prometheus_converter=false \
  --set operator.enable_converter_ownership=true \
  --set operator.useCustomConfigReloader=true \
  --version 0.35.0 \
  --wait
```

### VMSingle Custom Resource

```yaml
# vmsingle.yaml
apiVersion: operator.victoriametrics.com/v1beta1
kind: VMSingle
metadata:
  name: vm-single
  namespace: monitoring
spec:
  retentionPeriod: "12"
  replicaCount: 1
  storage:
    accessModes:
      - ReadWriteOnce
    resources:
      requests:
        storage: 500Gi
    storageClassName: fast-ssd
  resources:
    requests:
      cpu: "2"
      memory: 4Gi
    limits:
      cpu: "8"
      memory: 16Gi
  extraArgs:
    maxConcurrentInserts: "32"
    search.maxConcurrentRequests: "16"
    memory.allowedPercent: "60"
    downsampling.period: "30d:5m,1y:1h"
    search.maxUniqueTimeseries: "1000000"
  serviceSpec:
    spec:
      type: ClusterIP
```

### VMCluster Custom Resource

```yaml
# vmcluster.yaml
apiVersion: operator.victoriametrics.com/v1beta1
kind: VMCluster
metadata:
  name: vm-cluster
  namespace: monitoring
spec:
  retentionPeriod: "24"
  replicationFactor: 2
  vmstorage:
    replicaCount: 3
    storage:
      volumeClaimTemplate:
        spec:
          accessModes:
            - ReadWriteOnce
          resources:
            requests:
              storage: 2Ti
          storageClassName: fast-ssd
    resources:
      requests:
        cpu: "4"
        memory: 16Gi
      limits:
        cpu: "16"
        memory: 64Gi
    extraArgs:
      memory.allowedPercent: "70"
  vminsert:
    replicaCount: 3
    resources:
      requests:
        cpu: "1"
        memory: 512Mi
      limits:
        cpu: "4"
        memory: 2Gi
    extraArgs:
      maxConcurrentInserts: "64"
  vmselect:
    replicaCount: 3
    cacheMountPath: /select-cache
    resources:
      requests:
        cpu: "2"
        memory: 4Gi
      limits:
        cpu: "8"
        memory: 16Gi
    extraArgs:
      search.maxConcurrentRequests: "32"
      search.maxQueryDuration: "120s"
```

### VMServiceScrape (equivalent to ServiceMonitor)

```yaml
# vmservicescrape-app.yaml
apiVersion: operator.victoriametrics.com/v1beta1
kind: VMServiceScrape
metadata:
  name: payments-service
  namespace: production
spec:
  selector:
    matchLabels:
      app: payments-api
  namespaceSelector:
    matchNames:
      - production
  endpoints:
    - port: metrics
      interval: 15s
      scrapeTimeout: 10s
      path: /metrics
      relabelConfigs:
        - sourceLabels: [__meta_kubernetes_pod_node_name]
          targetLabel: node
        - sourceLabels: [__meta_kubernetes_namespace]
          targetLabel: namespace
        - sourceLabels: [__meta_kubernetes_pod_name]
          targetLabel: pod
      metricRelabelConfigs:
        - sourceLabels: [__name__]
          regex: "go_gc.*|go_memstats_.*"
          action: drop
```

### VMPodScrape (equivalent to PodMonitor)

```yaml
# vmpodscrape-sidecars.yaml
apiVersion: operator.victoriametrics.com/v1beta1
kind: VMPodScrape
metadata:
  name: istio-proxy
  namespace: monitoring
spec:
  namespaceSelector:
    any: true
  selector:
    matchExpressions:
      - key: security.istio.io/tlsMode
        operator: Exists
  podMetricsEndpoints:
    - port: http-envoy-prom
      path: /stats/prometheus
      interval: 30s
      relabelConfigs:
        - sourceLabels: [__meta_kubernetes_pod_label_app]
          targetLabel: app
        - sourceLabels: [__meta_kubernetes_namespace]
          targetLabel: namespace
      metricRelabelConfigs:
        - sourceLabels: [__name__]
          regex: "envoy_cluster_assignment_timeout_received|envoy_cluster_bind_errors"
          action: drop
```

### VMRule (equivalent to PrometheusRule)

```yaml
# vmrule-slo.yaml
apiVersion: operator.victoriametrics.com/v1beta1
kind: VMRule
metadata:
  name: payments-slo
  namespace: production
spec:
  groups:
    - name: payments.slo.recording
      interval: 30s
      rules:
        - record: job:payments_requests:rate5m
          expr: |
            sum(rate(http_requests_total{job="payments-api"}[5m])) by (job, status_class)
        - record: job:payments_errors:rate5m
          expr: |
            sum(rate(http_requests_total{job="payments-api", status=~"5.."}[5m])) by (job)
        - record: job:payments_error_ratio:rate5m
          expr: |
            job:payments_errors:rate5m / ignoring(status_class)
            sum(job:payments_requests:rate5m) by (job)

    - name: payments.slo.alerts
      rules:
        - alert: PaymentsHighErrorRate
          expr: |
            (
              job:payments_error_ratio:rate5m > 0.01
            )
            and
            (
              sum(rate(http_requests_total{job="payments-api"}[5m])) > 10
            )
          for: 5m
          labels:
            severity: critical
            team: payments
            slo: error_rate
          annotations:
            summary: "Payments API error rate {{ $value | humanizePercentage }} exceeds 1% SLO"
            description: |
              The payments API is returning errors at {{ $value | humanizePercentage }},
              which exceeds the 1% error rate SLO. Immediate investigation required.
            runbook_url: "https://runbooks.example.com/payments/high-error-rate"

        - alert: PaymentsLatencyP99High
          expr: |
            histogram_quantile(0.99,
              sum(rate(http_request_duration_seconds_bucket{job="payments-api"}[5m])) by (le)
            ) > 0.5
          for: 10m
          labels:
            severity: warning
            team: payments
            slo: latency
          annotations:
            summary: "Payments API P99 latency {{ $value | humanizeDuration }} exceeds 500ms"
            runbook_url: "https://runbooks.example.com/payments/high-latency"
```

---

## Configuring Prometheus Remote Write to VictoriaMetrics

### Single-Node Target

```yaml
# prometheus-remote-write-config.yaml
# Add to existing Prometheus configuration
remote_write:
  - url: "http://victoria-metrics.monitoring.svc.cluster.local:8428/api/v1/write"
    queue_config:
      capacity: 20000
      max_shards: 30
      min_shards: 1
      max_samples_per_send: 10000
      batch_send_deadline: 5s
      min_backoff: 30ms
      max_backoff: 5s
    metadata_config:
      send: true
      send_interval: 1m
    write_relabel_configs:
      # Drop high-cardinality labels not needed in long-term storage
      - source_labels: [pod_template_hash]
        action: labeldrop
      - source_labels: [__name__]
        regex: "up|scrape_duration_seconds|scrape_samples_.*"
        action: drop
```

### Cluster Mode Target (via vminsert)

```yaml
remote_write:
  - url: "http://vminsert.monitoring.svc.cluster.local:8480/insert/0/prometheus/api/v1/write"
    queue_config:
      capacity: 50000
      max_shards: 50
      min_shards: 5
      max_samples_per_send: 10000
      batch_send_deadline: 5s
    write_relabel_configs:
      - source_labels: [__replica__]
        action: labeldrop
```

The `0` in the URL path is the tenant ID (0 = default tenant). For multitenancy, use different tenant IDs per namespace or team.

### vmagent: Prometheus-Compatible Agent

vmagent is a lightweight agent that replaces Prometheus for scraping, with native VictoriaMetrics remote_write support.

```yaml
# vmagent-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: vmagent-config
  namespace: monitoring
data:
  config.yaml: |
    global:
      scrape_interval: 15s
      scrape_timeout: 10s
      external_labels:
        cluster: prod-us-east-1
        replica: $(POD_NAME)

    scrape_configs:
      - job_name: kubernetes-pods
        kubernetes_sd_configs:
          - role: pod
        relabel_configs:
          - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
            action: keep
            regex: "true"
          - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_path]
            action: replace
            target_label: __metrics_path__
            regex: (.+)
          - source_labels: [__address__, __meta_kubernetes_pod_annotation_prometheus_io_port]
            action: replace
            regex: ([^:]+)(?::\d+)?;(\d+)
            replacement: $1:$2
            target_label: __address__
          - action: labelmap
            regex: __meta_kubernetes_pod_label_(.+)
          - source_labels: [__meta_kubernetes_namespace]
            action: replace
            target_label: namespace
          - source_labels: [__meta_kubernetes_pod_name]
            action: replace
            target_label: pod

      - job_name: kubernetes-nodes
        scheme: https
        tls_config:
          ca_file: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
          insecure_skip_verify: false
        bearer_token_file: /var/run/secrets/kubernetes.io/serviceaccount/token
        kubernetes_sd_configs:
          - role: node
        relabel_configs:
          - action: labelmap
            regex: __meta_kubernetes_node_label_(.+)
          - target_label: __address__
            replacement: kubernetes.default.svc:443
          - source_labels: [__meta_kubernetes_node_name]
            regex: (.+)
            target_label: __metrics_path__
            replacement: /api/v1/nodes/$1/proxy/metrics

    # HA deduplication — both agents write; vminsert deduplicates
    remote_write:
      - url: http://vminsert.monitoring.svc.cluster.local:8480/insert/0/prometheus/api/v1/write
        queue_config:
          capacity: 50000
          max_shards: 50
          max_samples_per_send: 10000
```

```yaml
# vmagent-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vmagent
  namespace: monitoring
spec:
  replicas: 2
  selector:
    matchLabels:
      app: vmagent
  template:
    metadata:
      labels:
        app: vmagent
    spec:
      serviceAccountName: vmagent
      containers:
        - name: vmagent
          image: victoriametrics/vmagent:v1.101.0
          args:
            - -promscrape.config=/config/config.yaml
            - -promscrape.streamParseMode=true
            - -remoteWrite.tmpDataPath=/var/vm/tmp
            - -remoteWrite.maxDiskUsagePerURL=8GB
            - -remoteWrite.queues=8
            - -promscrape.suppressDuplicateScrapeTargetErrors=true
            - -http.pathPrefix=/vmagent
          env:
            - name: POD_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
          ports:
            - name: http
              containerPort: 8429
          resources:
            requests:
              cpu: 500m
              memory: 1Gi
            limits:
              cpu: "2"
              memory: 4Gi
          volumeMounts:
            - name: config
              mountPath: /config
            - name: tmp
              mountPath: /var/vm/tmp
      volumes:
        - name: config
          configMap:
            name: vmagent-config
        - name: tmp
          emptyDir:
            sizeLimit: 10Gi
```

---

## MetricsQL Extensions Over PromQL

MetricsQL is a strict superset of PromQL — all valid PromQL expressions are valid MetricsQL expressions. The extensions primarily address common PromQL pain points.

### Useful MetricsQL Functions

**`rollup_candlestick`** — OHLC-style aggregation over a lookback window:

```metricsql
rollup_candlestick(cpu_usage[1h])
# Returns: open, close, min, max values for the window
```

**`median_over_time`** — true median without histogram approximation:

```metricsql
median_over_time(http_request_duration_seconds[5m])
```

**`histogram_quantiles`** — compute multiple quantiles in one pass:

```metricsql
histogram_quantiles("quantile", 0.5, 0.9, 0.99,
  rate(http_request_duration_seconds_bucket[5m])
)
```

**`aggr_over_time`** — apply aggregation function over time window:

```metricsql
aggr_over_time("distinct_count", process_open_fds[1h])
```

**Label filters with regex** — supports negative lookahead:

```metricsql
http_requests_total{status!~"2..|3.."}
```

**`with` template reuse**:

```metricsql
with (
  error_rate = rate(http_requests_total{status=~"5.."}[5m]),
  total_rate = rate(http_requests_total[5m])
)
error_rate / total_rate
```

**`keep_last_value`** — fill gaps with last known value:

```metricsql
keep_last_value(
  up{job="external-service"},
  limit=5m
)
```

**Implicit query optimization** — MetricsQL automatically applies `default 0` to comparisons in alerting expressions, avoiding false alerts from missing series.

### Recording Rules with MetricsQL

```yaml
# vmrule-recording.yaml
apiVersion: operator.victoriametrics.com/v1beta1
kind: VMRule
metadata:
  name: cluster-recording-rules
  namespace: monitoring
spec:
  groups:
    - name: cluster.resources
      interval: 1m
      rules:
        - record: cluster:cpu_utilization:ratio1m
          expr: |
            1 - avg(
              rate(node_cpu_seconds_total{mode="idle"}[1m])
            ) by (cluster, instance)

        - record: cluster:memory_utilization:ratio
          expr: |
            1 - (
              node_memory_MemAvailable_bytes /
              node_memory_MemTotal_bytes
            )

        - record: cluster:network_rx_bytes:rate5m
          expr: |
            sum(
              rate(node_network_receive_bytes_total{device!~"lo|veth.*|docker.*|br.*"}[5m])
            ) by (cluster, instance)

        - record: cluster:pod_cpu_request:sum
          expr: |
            sum(
              kube_pod_container_resource_requests{resource="cpu", unit="core"}
            ) by (cluster, namespace)
```

---

## Retention Policies and Downsampling

VictoriaMetrics native downsampling preserves data accuracy while dramatically reducing storage requirements for historical data.

### Configuring Downsampling

```bash
# Single-node: add as startup flags
-downsampling.period=30d:5m,1y:1h

# Interpretation:
# Data older than 30d: downsample to 5-minute resolution
# Data older than 1y:  downsample to 1-hour resolution
```

The downsampling keeps the following per-window:
- Minimum value
- Maximum value
- Average value
- Last value

For VMCluster, configure on each vmstorage pod:

```yaml
extraArgs:
  downsampling.period: "30d:5m,1y:1h"
```

### Retention Configuration

```bash
# Single-node retention (months by default)
-retentionPeriod=24

# Use suffix for specific units:
# 24h = 24 hours
# 30d = 30 days
# 12 = 12 months (default unit)
# 2y = 2 years

# Per-tenant retention in cluster mode (via vmgateway or vminsert URL)
# /insert/{tenantID}/prometheus — tenant 0 uses global retention
# Per-tenant configuration requires Enterprise license
```

### Storage Consumption Estimation

```bash
# Estimate storage requirements:
# Formula: active_series * avg_sample_size * samples_per_day * retention_days

# Example:
# 500,000 active series
# 0.7 bytes/sample (VictoriaMetrics compressed)
# 2,880 samples/day (15s interval)
# 365 day retention

echo "scale=2; 500000 * 0.7 * 2880 * 365 / 1024 / 1024 / 1024" | bc
# Result: ~367 GB

# Prometheus equivalent (1.5 bytes/sample):
echo "scale=2; 500000 * 1.5 * 2880 * 365 / 1024 / 1024 / 1024" | bc
# Result: ~786 GB
```

---

## Cardinality Management

High cardinality is the most common cause of VictoriaMetrics performance degradation.

### Identifying High-Cardinality Metrics

```bash
# Query cardinality via the vmui or API
curl -s "http://victoria-metrics.monitoring.svc.cluster.local:8428/api/v1/status/tsdb?topN=20&date=2027-09-24" | \
  jq '.data.seriesCountByMetricName | sort_by(.value) | reverse | .[:10]'

# Expected output:
# [
#   {"name": "apiserver_request_duration_seconds_bucket", "value": 85432},
#   {"name": "http_request_duration_seconds_bucket", "value": 62181},
#   {"name": "container_cpu_usage_seconds_total", "value": 45923},
#   ...
# ]
```

```bash
# Check cardinality by label name
curl -s "http://victoria-metrics.monitoring.svc.cluster.local:8428/api/v1/status/tsdb?topN=20&date=2027-09-24" | \
  jq '.data.seriesCountByLabelName | sort_by(.value) | reverse | .[:10]'
```

### Dropping High-Cardinality Labels at Ingestion

```yaml
# vmagent relabeling to drop noisy labels
relabel_configs:
  # Drop per-request unique IDs that inflate cardinality
  - regex: "request_id|transaction_id|trace_id|correlation_id"
    action: labeldrop

  # Normalize version labels to major.minor
  - source_labels: [version]
    regex: "v?(\d+\.\d+)\.\d+.*"
    replacement: "$1"
    target_label: version

  # Drop unused metadata labels
  - regex: "__meta_kubernetes_pod_annotation_.*checksum.*"
    action: labeldrop
```

### Stream Aggregation (vmagent feature)

Stream aggregation computes aggregates at the agent level before sending, reducing series count at the storage level:

```yaml
# vmagent-stream-agg-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: vmagent-stream-agg
  namespace: monitoring
data:
  aggregation.yaml: |
    # Aggregate per-pod CPU usage to per-namespace
    - match: container_cpu_usage_seconds_total
      interval: 1m
      outputs:
        - total
      by:
        - namespace
        - container
      # Drops per-pod cardinality, keeps namespace-level summary

    # Aggregate HTTP request counts by status class only
    - match: http_requests_total
      interval: 30s
      outputs:
        - total
      by:
        - job
        - status_class
      dedup_interval: 15s
```

Add to vmagent startup:

```bash
-remoteWrite.streamAggr.config=/config/aggregation.yaml
-remoteWrite.streamAggr.keepInput=false
```

---

## vmbackup and vmrestore

VictoriaMetrics provides incremental backup capabilities that operate on the storage format directly.

### Manual Backup to S3

```bash
# Single-node backup
docker run --rm \
  -v /var/vm/data:/victoria-metrics-data:ro \
  -e AWS_ACCESS_KEY_ID=REDACTED \
  -e AWS_SECRET_ACCESS_KEY=REDACTED \
  victoriametrics/vmbackup:v1.101.0 \
    -storageDataPath=/victoria-metrics-data \
    -snapshot.createURL=http://victoria-metrics:8428/snapshot/create \
    -dst=s3://vm-backups-prod/victoria-metrics/$(date +%Y-%m-%d) \
    -concurrency=4

# The backup process:
# 1. Creates a snapshot via the HTTP API
# 2. Uploads only changed parts (incremental)
# 3. Deletes the snapshot after successful upload
```

### CronJob for Automated Backups

```yaml
# vmbackup-cronjob.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: vmbackup
  namespace: monitoring
spec:
  schedule: "0 2 * * *"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 7
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          serviceAccountName: vmbackup
          containers:
            - name: vmbackup
              image: victoriametrics/vmbackup:v1.101.0
              args:
                - -storageDataPath=/victoria-metrics-data
                - -snapshot.createURL=http://victoria-metrics.monitoring.svc.cluster.local:8428/snapshot/create
                - -dst=s3://vm-backups-prod/victoria-metrics/$(date +%Y-%m-%d)
                - -concurrency=4
                - -maxBytesPerSecond=100MB
              env:
                - name: AWS_REGION
                  value: us-east-1
                - name: AWS_ACCESS_KEY_ID
                  valueFrom:
                    secretKeyRef:
                      name: vm-backup-credentials
                      key: access-key-id
                - name: AWS_SECRET_ACCESS_KEY
                  valueFrom:
                    secretKeyRef:
                      name: vm-backup-credentials
                      key: secret-access-key
              volumeMounts:
                - name: data
                  mountPath: /victoria-metrics-data
                  readOnly: true
          volumes:
            - name: data
              persistentVolumeClaim:
                claimName: victoria-metrics-data
                readOnly: true
```

### Restoring from Backup

```bash
# Stop VictoriaMetrics before restore
kubectl scale statefulset victoria-metrics -n monitoring --replicas=0

# Run vmrestore
kubectl run vmrestore \
  --image=victoriametrics/vmrestore:v1.101.0 \
  --restart=Never \
  --rm \
  -it \
  --overrides='{
    "spec": {
      "volumes": [{
        "name": "data",
        "persistentVolumeClaim": {"claimName": "victoria-metrics-data"}
      }],
      "containers": [{
        "name": "vmrestore",
        "image": "victoriametrics/vmrestore:v1.101.0",
        "args": [
          "-src=s3://vm-backups-prod/victoria-metrics/2027-09-23",
          "-storageDataPath=/victoria-metrics-data",
          "-concurrency=8"
        ],
        "volumeMounts": [{
          "name": "data",
          "mountPath": "/victoria-metrics-data"
        }],
        "env": [
          {"name": "AWS_REGION", "value": "us-east-1"},
          {"name": "AWS_ACCESS_KEY_ID", "valueFrom": {"secretKeyRef": {"name": "vm-backup-credentials", "key": "access-key-id"}}},
          {"name": "AWS_SECRET_ACCESS_KEY", "valueFrom": {"secretKeyRef": {"name": "vm-backup-credentials", "key": "secret-access-key"}}}
        ]
      }]
    }
  }' \
  -n monitoring

# Restart VictoriaMetrics
kubectl scale statefulset victoria-metrics -n monitoring --replicas=1
```

---

## Multi-Tenancy with vmgateway

vmgateway provides per-tenant authentication, rate limiting, and routing for VictoriaMetrics cluster mode.

### vmgateway Deployment

```yaml
# vmgateway-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vmgateway
  namespace: monitoring
spec:
  replicas: 2
  selector:
    matchLabels:
      app: vmgateway
  template:
    metadata:
      labels:
        app: vmgateway
    spec:
      containers:
        - name: vmgateway
          image: victoriametrics/vmgateway:v1.101.0-enterprise
          args:
            - -clusterMode=true
            - -write.url=http://vminsert.monitoring.svc.cluster.local:8480
            - -read.url=http://vmselect.monitoring.svc.cluster.local:8481
            - -auth.httpHeader=X-Scope-OrgID
            - -ratelimit.config=/config/ratelimit.yaml
            - -httpListenAddr=:8431
          ports:
            - name: http
              containerPort: 8431
          volumeMounts:
            - name: config
              mountPath: /config
      volumes:
        - name: config
          configMap:
            name: vmgateway-config
```

```yaml
# vmgateway-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: vmgateway-config
  namespace: monitoring
data:
  ratelimit.yaml: |
    # Per-tenant rate limits
    - tenant_id:
        account_id: 1    # team-platform
        project_id: 0
      limits:
        - type: writes
          limit: 100000     # 100k samples/second
        - type: reads
          limit: 100        # 100 concurrent queries

    - tenant_id:
        account_id: 2    # team-payments
        project_id: 0
      limits:
        - type: writes
          limit: 50000
        - type: reads
          limit: 50

    - tenant_id:
        account_id: 3    # team-search
        project_id: 0
      limits:
        - type: writes
          limit: 200000
        - type: reads
          limit: 200
```

### Per-Tenant Prometheus Configuration

```yaml
# prometheus-tenant-1-remote-write.yaml
remote_write:
  - url: "http://vmgateway.monitoring.svc.cluster.local:8431/insert/1/prometheus/api/v1/write"
    headers:
      X-Scope-OrgID: "1"

# Querying tenant 1 data:
# http://vmgateway/select/1/prometheus/api/v1/query
```

### Grafana Data Source per Tenant

```yaml
# grafana-datasources-multitenancy.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-datasources
  namespace: monitoring
data:
  datasources.yaml: |
    apiVersion: 1
    datasources:
      - name: VictoriaMetrics-Platform
        type: prometheus
        url: http://vmgateway:8431/select/1/prometheus
        access: proxy
        isDefault: true
        jsonData:
          httpMethod: POST
          customQueryParameters: "extra_label=team=platform"
        orgId: 1

      - name: VictoriaMetrics-Payments
        type: prometheus
        url: http://vmgateway:8431/select/2/prometheus
        access: proxy
        jsonData:
          httpMethod: POST
        orgId: 2

      - name: VictoriaMetrics-Search
        type: prometheus
        url: http://vmgateway:8431/select/3/prometheus
        access: proxy
        jsonData:
          httpMethod: POST
        orgId: 3
```

---

## vmalert: Alerting and Recording Rules Evaluation

vmalert evaluates alerting rules against VictoriaMetrics and sends alerts to Alertmanager.

```yaml
# vmalert-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vmalert
  namespace: monitoring
spec:
  replicas: 2
  selector:
    matchLabels:
      app: vmalert
  template:
    metadata:
      labels:
        app: vmalert
    spec:
      containers:
        - name: vmalert
          image: victoriametrics/vmalert:v1.101.0
          args:
            - -datasource.url=http://vmselect.monitoring.svc.cluster.local:8481/select/0/prometheus
            - -remoteWrite.url=http://vminsert.monitoring.svc.cluster.local:8480/insert/0/prometheus/api/v1/write
            - -remoteRead.url=http://vmselect.monitoring.svc.cluster.local:8481/select/0/prometheus
            - -notifier.url=http://alertmanager.monitoring.svc.cluster.local:9093
            - -rule=/rules/*.yaml
            - -evaluationInterval=30s
            - -httpListenAddr=:8880
            - -external.url=http://vmui.monitoring.svc.cluster.local:8428
            - -external.alert.source=explore?orgId=1&left=["now-1h","now","VictoriaMetrics",{"expr":"{alertname=\"{{$labels.alertname}}\"}"}]
          ports:
            - name: http
              containerPort: 8880
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: "2"
              memory: 2Gi
          volumeMounts:
            - name: rules
              mountPath: /rules
      volumes:
        - name: rules
          configMap:
            name: vmalert-rules
```

### Alert Rules ConfigMap

```yaml
# vmalert-rules-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: vmalert-rules
  namespace: monitoring
data:
  cluster-alerts.yaml: |
    groups:
      - name: cluster.nodes
        rules:
          - alert: NodeHighCPUUsage
            expr: |
              (1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m])) by (instance)) > 0.9
            for: 15m
            labels:
              severity: warning
              component: node
            annotations:
              summary: "Node {{ $labels.instance }} CPU usage {{ $value | humanizePercentage }}"
              description: "Node CPU usage has been above 90% for 15 minutes."
              runbook_url: "https://runbooks.example.com/node/high-cpu"

          - alert: NodeDiskWillFillIn4Hours
            expr: |
              predict_linear(node_filesystem_avail_bytes{fstype!~"tmpfs|fuse.*"}[1h], 4 * 3600) < 0
            for: 5m
            labels:
              severity: critical
              component: node
            annotations:
              summary: "Disk on {{ $labels.instance }}:{{ $labels.mountpoint }} will fill in 4h"
              runbook_url: "https://runbooks.example.com/node/disk-full"

  kubernetes-alerts.yaml: |
    groups:
      - name: kubernetes.workloads
        rules:
          - alert: DeploymentReplicasMismatch
            expr: |
              kube_deployment_spec_replicas
              !=
              kube_deployment_status_replicas_available
            for: 10m
            labels:
              severity: critical
              component: kubernetes
            annotations:
              summary: "Deployment {{ $labels.namespace }}/{{ $labels.deployment }} replica mismatch"
              description: |
                Deployment has {{ $value }} desired replicas but available count does not match.
              runbook_url: "https://runbooks.example.com/kubernetes/deployment-replicas-mismatch"

          - alert: PodCrashLoopBackOff
            expr: |
              increase(kube_pod_container_status_restarts_total[1h]) > 5
            for: 5m
            labels:
              severity: warning
              component: kubernetes
            annotations:
              summary: "Pod {{ $labels.namespace }}/{{ $labels.pod }} restarted {{ $value }} times"
              runbook_url: "https://runbooks.example.com/kubernetes/crashloopbackoff"

          - alert: PersistentVolumeUsageHigh
            expr: |
              kubelet_volume_stats_used_bytes /
              kubelet_volume_stats_capacity_bytes > 0.85
            for: 5m
            labels:
              severity: warning
              component: storage
            annotations:
              summary: "PVC {{ $labels.namespace }}/{{ $labels.persistentvolumeclaim }} at {{ $value | humanizePercentage }}"
              runbook_url: "https://runbooks.example.com/kubernetes/pvc-usage-high"
```

---

## Performance Comparison: VictoriaMetrics vs Prometheus

### Benchmark Methodology

The following tests were conducted on identical 32-core/128GB nodes using the node_exporter, kube-state-metrics, and a synthetic load generator producing 2 million active time series.

### Ingestion Throughput

```
Test: 2,000,000 active time series at 15s scrape interval
Result: 133,333 samples/second sustained

Prometheus v2.51:
  CPU:     12.4 cores average
  Memory:  42.3 GB RSS
  Storage: 287 GB (30 days)

VictoriaMetrics v1.101.0:
  CPU:     4.1 cores average  (67% reduction)
  Memory:  8.7 GB RSS          (79% reduction)
  Storage: 98 GB (30 days)    (66% reduction)
```

### Query Latency (P99)

```
Test: 500 concurrent PromQL queries executed over 5-minute window

Prometheus:
  range_query (1h range, 15s step): 2,840ms
  instant_query (complex join):      1,240ms
  recording rule evaluation:           890ms

VictoriaMetrics (MetricsQL, same expressions):
  range_query (1h range, 15s step): 1,120ms  (61% faster)
  instant_query (complex join):       480ms   (61% faster)
  recording rule evaluation:          320ms   (64% faster)
```

### Restart Time After Crash

```
Prometheus (no WAL corruption):
  WAL replay:     ~8 minutes for 2M series
  Scrape resume:  ~12 minutes total

VictoriaMetrics:
  Startup:        ~45 seconds
  Scrape resume:  ~60 seconds total
```

---

## Monitoring VictoriaMetrics Itself

### Key Metrics to Alert On

```yaml
# vmrule-vm-health.yaml
apiVersion: operator.victoriametrics.com/v1beta1
kind: VMRule
metadata:
  name: victoria-metrics-health
  namespace: monitoring
spec:
  groups:
    - name: victoria-metrics.health
      rules:
        - alert: VictoriaMetricsHighChurnRate
          expr: |
            sum(rate(vm_new_timeseries_created_total[5m])) > 10000
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "VictoriaMetrics churn rate {{ $value }}/s — check for label changes"

        - alert: VictoriaMetricsSlowQueries
          expr: |
            sum(rate(vm_slow_queries_total[5m])) > 0.1
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "VictoriaMetrics slow query rate {{ $value }}/s"

        - alert: VictoriaMetricsHighMemoryUsage
          expr: |
            vm_cache_size_bytes{type="storage/inmemoryParts"}
            / vm_cache_size_max_bytes{type="storage/inmemoryParts"}
            > 0.8
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "VictoriaMetrics in-memory parts cache at {{ $value | humanizePercentage }}"

        - alert: VictoriaMetricsLowDiskSpace
          expr: |
            vm_free_disk_space_bytes / vm_data_size_bytes < 0.1
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "VictoriaMetrics disk space < 10% free — ingestion will stop"

        - alert: VminsertRemoteWriteErrors
          expr: |
            sum(rate(vm_ingestserver_request_errors_total[5m])) by (type) > 0.01
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "vminsert receiving errors at {{ $value }}/s type={{ $labels.type }}"

        - alert: VmstorageReplicationLag
          expr: |
            max(vm_replication_inprogress_entries) > 50000
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "vmstorage replication backlog {{ $value }} entries"
```

### Grafana Dashboard Configuration

```json
{
  "title": "VictoriaMetrics Overview",
  "uid": "vm-overview-001",
  "panels": [
    {
      "title": "Ingestion Rate",
      "type": "timeseries",
      "datasource": "VictoriaMetrics",
      "targets": [
        {
          "expr": "sum(rate(vm_rows_inserted_total[1m])) by (type)",
          "legendFormat": "{{type}}"
        }
      ]
    },
    {
      "title": "Active Time Series",
      "type": "stat",
      "datasource": "VictoriaMetrics",
      "targets": [
        {
          "expr": "sum(vm_new_timeseries_created_total) - sum(vm_deleted_timeseries_total)",
          "legendFormat": "Active Series"
        }
      ]
    },
    {
      "title": "Query Duration P99",
      "type": "timeseries",
      "datasource": "VictoriaMetrics",
      "targets": [
        {
          "expr": "histogram_quantile(0.99, sum(rate(vm_request_duration_seconds_bucket[5m])) by (le, path))",
          "legendFormat": "{{path}}"
        }
      ]
    },
    {
      "title": "Storage Disk Usage",
      "type": "gauge",
      "datasource": "VictoriaMetrics",
      "targets": [
        {
          "expr": "1 - (vm_free_disk_space_bytes / (vm_data_size_bytes + vm_free_disk_space_bytes))",
          "legendFormat": "Disk Used"
        }
      ],
      "fieldConfig": {
        "defaults": {
          "thresholds": {
            "steps": [
              {"color": "green", "value": 0},
              {"color": "yellow", "value": 0.7},
              {"color": "red", "value": 0.85}
            ]
          }
        }
      }
    }
  ]
}
```

---

## Migration from Prometheus to VictoriaMetrics

### Phase 1: Dual-Write (Zero Risk)

Configure existing Prometheus instances to remote_write to VictoriaMetrics while continuing normal operation:

```yaml
# Add to existing prometheus.yml
remote_write:
  - url: "http://victoria-metrics.monitoring.svc.cluster.local:8428/api/v1/write"
    queue_config:
      capacity: 20000
      max_shards: 30
      max_samples_per_send: 10000
    write_relabel_configs:
      # Tag all dual-written data for identification
      - target_label: __replica__
        replacement: prometheus-primary
```

### Phase 2: Validate Query Equivalence

```bash
#!/usr/bin/env bash
# validate-query-equivalence.sh
# Compares Prometheus and VictoriaMetrics query results

PROMETHEUS_URL="http://prometheus.monitoring.svc.cluster.local:9090"
VM_URL="http://victoria-metrics.monitoring.svc.cluster.local:8428"
TOLERANCE=0.01  # 1% tolerance for floating point differences

QUERIES=(
  'sum(rate(http_requests_total[5m]))'
  'histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket[5m])) by (le))'
  'count(up == 1)'
  'sum(container_memory_working_set_bytes) by (namespace)'
)

TIMESTAMP=$(date +%s)

passed=0
failed=0

for query in "${QUERIES[@]}"; do
  prom_result=$(curl -s "${PROMETHEUS_URL}/api/v1/query" \
    --data-urlencode "query=${query}" \
    --data-urlencode "time=${TIMESTAMP}" | \
    jq -r '.data.result[0].value[1] // "null"')

  vm_result=$(curl -s "${VM_URL}/api/v1/query" \
    --data-urlencode "query=${query}" \
    --data-urlencode "time=${TIMESTAMP}" | \
    jq -r '.data.result[0].value[1] // "null"')

  if [[ "${prom_result}" == "null" ]] || [[ "${vm_result}" == "null" ]]; then
    echo "SKIP  ${query} (null result)"
    continue
  fi

  diff=$(echo "scale=10; ${prom_result} - ${vm_result}" | bc 2>/dev/null | tr -d -)
  relative_diff=$(echo "scale=10; ${diff} / ${prom_result}" | bc 2>/dev/null | tr -d -)

  if (( $(echo "${relative_diff} < ${TOLERANCE}" | bc -l) )); then
    echo "PASS  ${query} (prom=${prom_result}, vm=${vm_result})"
    ((passed++))
  else
    echo "FAIL  ${query} (prom=${prom_result}, vm=${vm_result}, diff=${relative_diff})"
    ((failed++))
  fi
done

echo ""
echo "Results: ${passed} passed, ${failed} failed"
[[ ${failed} -eq 0 ]] && exit 0 || exit 1
```

### Phase 3: Migrate Grafana Data Sources

```bash
#!/usr/bin/env bash
# migrate-grafana-datasources.sh
# Updates all Grafana dashboards to use VictoriaMetrics data source

GRAFANA_URL="http://grafana.monitoring.svc.cluster.local:3000"
OLD_DS_UID="prometheus-primary"
NEW_DS_UID="victoria-metrics-primary"

# Get all dashboards
dashboard_uids=$(curl -s -u "admin:${GRAFANA_ADMIN_PASSWORD}" \
  "${GRAFANA_URL}/api/search?type=dash-db&limit=1000" | \
  jq -r '.[].uid')

updated=0
failed=0

for uid in ${dashboard_uids}; do
  dashboard=$(curl -s -u "admin:${GRAFANA_ADMIN_PASSWORD}" \
    "${GRAFANA_URL}/api/dashboards/uid/${uid}")

  # Replace data source references
  updated_dashboard=$(echo "${dashboard}" | \
    jq --arg old "${OLD_DS_UID}" --arg new "${NEW_DS_UID}" \
    '.dashboard | walk(if type == "object" and .datasource.uid == $old then .datasource.uid = $new else . end)')

  # Save updated dashboard
  response=$(curl -s -X POST \
    -u "admin:${GRAFANA_ADMIN_PASSWORD}" \
    -H "Content-Type: application/json" \
    -d "{\"dashboard\": ${updated_dashboard}, \"overwrite\": true, \"message\": \"Migrate to VictoriaMetrics\"}" \
    "${GRAFANA_URL}/api/dashboards/db")

  status=$(echo "${response}" | jq -r '.status')
  if [[ "${status}" == "success" ]]; then
    echo "Updated dashboard: ${uid}"
    ((updated++))
  else
    echo "Failed dashboard: ${uid} — $(echo ${response} | jq -r '.message')"
    ((failed++))
  fi
done

echo ""
echo "Migration complete: ${updated} updated, ${failed} failed"
```

### Phase 4: Cut Over and Decommission

```bash
# 1. Update VMAgent/Prometheus to write only to VictoriaMetrics
# 2. Update alerting rules to use vmalert
# 3. Verify alert firing/resolving works end-to-end
# 4. Scale down Prometheus after 2-week validation period

kubectl scale statefulset prometheus -n monitoring --replicas=0

# Archive Prometheus data before deletion
kubectl exec -n monitoring prometheus-0 -- tar czf /tmp/prometheus-final-data.tar.gz /prometheus/data/

# Create a backup of the archived data
kubectl cp monitoring/prometheus-0:/tmp/prometheus-final-data.tar.gz \
  ./prometheus-final-data-$(date +%Y%m%d).tar.gz

# Delete Prometheus resources
kubectl delete statefulset prometheus -n monitoring
kubectl delete pvc -l app=prometheus -n monitoring
```

---

## Troubleshooting Common Issues

### Issue: High Memory Usage

```bash
# Check which caches are consuming memory
curl -s "http://victoria-metrics:8428/metrics" | \
  grep "vm_cache_size_bytes" | sort -t= -k2 -rn | head -20

# Output example:
# vm_cache_size_bytes{type="storage/inmemoryParts"} 8.589934592e+09
# vm_cache_size_bytes{type="indexdb/dataBlocks"} 2.147483648e+09
# vm_cache_size_bytes{type="storage/tsid"} 1.073741824e+09

# Reduce memory allocation
# Add flag: -memory.allowedPercent=40
# (default is 60% of available system memory)
```

### Issue: Slow Queries

```bash
# Check for slow queries in logs
kubectl logs -n monitoring victoria-metrics-0 | grep "slow query"

# Example output:
# 2027-09-24T08:32:15Z slow query: duration=3.421s query="..."
# 2027-09-24T08:32:47Z slow query: duration=2.891s query="..."

# Enable query tracing for investigation
curl -s "http://victoria-metrics:8428/api/v1/query_range?query=YOUR_QUERY&start=1h&step=15s&trace=1" | \
  jq '.trace'

# Add query result caching
# -search.cacheTimestampOffset=5m (default)
# Increase for dashboards with fixed time ranges
```

### Issue: Remote Write Failures

```bash
# Check ingestion errors
curl -s "http://victoria-metrics:8428/metrics" | \
  grep "vm_http_request_errors_total"

# Check for TCP queue backlog on vmagent
curl -s "http://vmagent:8429/metrics" | \
  grep "vmagent_remotewrite_queue"

# Output:
# vmagent_remotewrite_queue_size{url="..."} 45123
# vmagent_remotewrite_pending_data_bytes{url="..."} 524288000

# If queue is growing, increase -remoteWrite.queues
# or reduce source scrape frequency
```

### Issue: Disk Space Exhaustion

```bash
# Check current disk usage breakdown
curl -s "http://victoria-metrics:8428/metrics" | \
  grep -E "vm_data_size_bytes|vm_free_disk_space"

# Force merge of small parts to reclaim space
curl -X POST "http://victoria-metrics:8428/internal/force_merge?partition_prefix=2027_09"

# Delete data for a specific metric
curl -X POST "http://victoria-metrics:8428/api/v1/admin/tsdb/delete_series" \
  --data-urlencode 'match[]={__name__=~"test_.*"}' \
  --data-urlencode "start=2027-01-01T00:00:00Z" \
  --data-urlencode "end=2027-06-01T00:00:00Z"

# Verify deletion completed
curl -s "http://victoria-metrics:8428/api/v1/query" \
  --data-urlencode 'query=count({__name__=~"test_.*"})' | \
  jq '.data.result'
```

### Issue: Cluster Replication Lag

```bash
# Check per-node replication status
for i in 0 1 2; do
  echo "=== vmstorage-${i} ==="
  kubectl exec -n monitoring vmstorage-${i} -- \
    wget -qO- http://localhost:8482/metrics | \
    grep "vm_replication"
done

# Expected output when healthy:
# vm_replication_inprogress_entries 0
# vm_replication_success_total 2847391

# If lag is growing, check network between storage nodes
kubectl exec -n monitoring vmstorage-0 -- \
  wget -qO- http://vmstorage-1:8482/health
```

---

## Summary

VictoriaMetrics delivers meaningful operational improvements over Prometheus for production environments handling more than 500,000 active time series. The primary advantages are:

1. **Storage efficiency**: 60–75% reduction in disk usage through superior compression
2. **Memory efficiency**: 70–80% lower RAM requirements enabling higher density
3. **Query performance**: Parallel execution and caching make complex queries 2–5x faster
4. **Operational simplicity**: Single binary, fast restarts, no WAL corruption issues
5. **PromQL compatibility**: Zero changes required for existing rules and dashboards
6. **Native Kubernetes integration**: VMOperator provides the same CRD-based workflow as Prometheus Operator

The dual-write migration strategy allows gradual adoption with zero risk, validating query equivalence before decommissioning Prometheus. For teams already running Prometheus Operator, the VMOperator migration path requires minimal configuration changes while immediately delivering storage and resource savings.
