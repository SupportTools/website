---
title: "Kubernetes Observability Stack 2030: VictoriaMetrics, Grafana Alloy, and Tempo"
date: 2030-03-25T00:00:00-05:00
draft: false
tags: ["Kubernetes", "VictoriaMetrics", "Grafana", "Grafana Alloy", "Tempo", "Observability", "Prometheus", "Distributed Tracing"]
categories: ["Kubernetes", "Observability", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete guide to building a production observability stack with VictoriaMetrics cluster, Grafana Alloy as the unified collector, Tempo for distributed tracing, and cohesive dashboards on Kubernetes."
more_link: "yes"
url: "/kubernetes-observability-stack-2030-victoriametrics-grafana-alloy-tempo/"
---

Modern Kubernetes observability has moved well beyond installing a Prometheus operator and calling it done. Production clusters routinely ingest hundreds of millions of time-series samples per day, generate gigabytes of logs across hundreds of pods, and produce distributed traces that span dozens of microservices. Managing three separate agents — Prometheus scraper, Promtail for logs, and an OpenTelemetry collector for traces — creates operational overhead and creates gaps when those agents disagree about labels or drop data under pressure.

This guide builds a cohesive observability stack around three components that have become the production standard: VictoriaMetrics cluster for long-term metrics storage, Grafana Alloy as the single unified collector replacing the legacy agent/promtail/otel trio, and Grafana Tempo for distributed tracing. Every configuration shown here is production-ready and has been tested against clusters running thousands of workloads.

<!--more-->

## Why This Stack

Before diving into configuration, the rationale matters. Each component was chosen for a specific reason over its alternatives.

**VictoriaMetrics over Thanos/Cortex**: VictoriaMetrics cluster provides horizontal scalability with a dramatically simpler operational model. A Thanos deployment requires managing sidecar containers, object store compactors, queriers, store gateways, and rulers as separate components. VictoriaMetrics expresses the same capabilities as three component types: vminsert, vmselect, and vmstorage. The read and write paths are independently scalable. On clusters where Prometheus remote write is already the data path, switching the remote write endpoint from a local Prometheus to vminsert costs nothing in application changes.

**Grafana Alloy over separate agents**: Alloy is the successor to the Grafana Agent, built on the River/Alloy configuration language. It can scrape Prometheus targets, tail logs using the Loki-compatible pipeline, collect OpenTelemetry traces, and forward all three signal types — all from a single binary and a single configuration file. Replacing three DaemonSets with one reduces node resource consumption and eliminates the labeling inconsistencies that emerge when separate agents independently attach Kubernetes metadata.

**Tempo for traces**: Tempo stores traces without requiring an index, using object storage as the backend. This gives it virtually unlimited retention at low cost. It integrates with Grafana natively, so trace lookups can jump directly from a metric anomaly in a VictoriaMetrics panel to the specific trace that was running at that moment.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                       Kubernetes Cluster                         │
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐  │
│  │  Application │    │  Application │    │   Application    │  │
│  │  Pod (OTLP)  │    │  Pod (OTLP)  │    │   Pod (OTLP)     │  │
│  └──────┬───────┘    └──────┬───────┘    └────────┬─────────┘  │
│         │                   │                     │             │
│         └───────────────────┴─────────────────────┘             │
│                             │                                    │
│                    ┌────────▼────────┐                          │
│                    │  Grafana Alloy  │  (DaemonSet)             │
│                    │  ┌───────────┐  │                          │
│                    │  │ Prometheus │  │                          │
│                    │  │  Scraper  │  │                          │
│                    │  ├───────────┤  │                          │
│                    │  │   Log     │  │                          │
│                    │  │  Tailing  │  │                          │
│                    │  ├───────────┤  │                          │
│                    │  │   OTLP    │  │                          │
│                    │  │ Receiver  │  │                          │
│                    │  └───────────┘  │                          │
│                    └────────┬────────┘                          │
│                             │                                    │
│         ┌───────────────────┼───────────────────┐               │
│         │                   │                   │               │
│  ┌──────▼──────┐   ┌───────▼───────┐   ┌──────▼──────┐        │
│  │vminsert     │   │  Loki         │   │  Tempo       │        │
│  │(metrics)    │   │  (logs)       │   │  (traces)    │        │
│  └──────┬──────┘   └───────┬───────┘   └──────┬──────┘        │
│         │                   │                   │               │
│  ┌──────▼──────┐   ┌───────▼───────┐   ┌──────▼──────┐        │
│  │vmstorage    │   │  Object Store │   │  Object Store│        │
│  │(x3 shards)  │   │  (S3/GCS)     │   │  (S3/GCS)    │        │
│  └──────┬──────┘   └───────────────┘   └─────────────┘        │
│         │                                                        │
│  ┌──────▼──────┐                                                │
│  │vmselect     │◄──────────────────────────────────────────┐   │
│  └─────────────┘                                           │   │
│                                                             │   │
│  ┌────────────────────────────────────────────────────────┐│   │
│  │                    Grafana                              ││   │
│  │  VictoriaMetrics DS │ Loki DS │ Tempo DS               ││   │
│  └────────────────────────────────────────────────────────┘│   │
└─────────────────────────────────────────────────────────────────┘
```

## VictoriaMetrics Cluster Deployment

### Namespace and RBAC

```yaml
# namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: monitoring
  labels:
    app.kubernetes.io/part-of: observability-stack
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: victoriametrics
  namespace: monitoring
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: victoriametrics-cluster-role
rules:
  - apiGroups: [""]
    resources:
      - nodes
      - nodes/metrics
      - nodes/proxy
      - services
      - endpoints
      - pods
      - configmaps
    verbs: ["get", "list", "watch"]
  - apiGroups: ["networking.k8s.io"]
    resources: ["ingresses"]
    verbs: ["get", "list", "watch"]
  - nonResourceURLs: ["/metrics", "/metrics/cadvisor"]
    verbs: ["get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: victoriametrics-cluster-role-binding
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: victoriametrics-cluster-role
subjects:
  - kind: ServiceAccount
    name: victoriametrics
    namespace: monitoring
```

### vmstorage StatefulSet

```yaml
# vmstorage.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: vmstorage
  namespace: monitoring
  labels:
    app: vmstorage
    component: victoriametrics
spec:
  serviceName: vmstorage
  replicas: 3
  selector:
    matchLabels:
      app: vmstorage
  template:
    metadata:
      labels:
        app: vmstorage
        component: victoriametrics
    spec:
      serviceAccountName: victoriametrics
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
      terminationGracePeriodSeconds: 60
      containers:
        - name: vmstorage
          image: victoriametrics/vmstorage:v1.115.0-cluster
          args:
            - "--storageDataPath=/vmstorage-data"
            - "--retentionPeriod=12"          # 12 months retention
            - "--dedup.minScrapeInterval=30s"  # deduplication window
            - "--httpListenAddr=:8482"
            - "--vminsertAddr=:8400"
            - "--vmselectAddr=:8401"
            - "--loggerLevel=INFO"
            - "--memory.allowedPercent=60"
          ports:
            - containerPort: 8482
              name: http
            - containerPort: 8400
              name: vminsert
            - containerPort: 8401
              name: vmselect
          livenessProbe:
            httpGet:
              path: /health
              port: http
            initialDelaySeconds: 30
            periodSeconds: 15
            failureThreshold: 5
          readinessProbe:
            httpGet:
              path: /health
              port: http
            initialDelaySeconds: 5
            periodSeconds: 5
          resources:
            requests:
              cpu: "2"
              memory: "8Gi"
            limits:
              cpu: "4"
              memory: "16Gi"
          volumeMounts:
            - name: vmstorage-data
              mountPath: /vmstorage-data
  volumeClaimTemplates:
    - metadata:
        name: vmstorage-data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: fast-ssd
        resources:
          requests:
            storage: 500Gi
---
apiVersion: v1
kind: Service
metadata:
  name: vmstorage
  namespace: monitoring
  labels:
    app: vmstorage
spec:
  clusterIP: None
  selector:
    app: vmstorage
  ports:
    - port: 8482
      name: http
    - port: 8400
      name: vminsert
    - port: 8401
      name: vmselect
```

### vminsert Deployment

```yaml
# vminsert.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vminsert
  namespace: monitoring
  labels:
    app: vminsert
    component: victoriametrics
spec:
  replicas: 2
  selector:
    matchLabels:
      app: vminsert
  template:
    metadata:
      labels:
        app: vminsert
        component: victoriametrics
    spec:
      serviceAccountName: victoriametrics
      containers:
        - name: vminsert
          image: victoriametrics/vminsert:v1.115.0-cluster
          args:
            - "--storageNode=vmstorage-0.vmstorage.monitoring.svc.cluster.local:8400"
            - "--storageNode=vmstorage-1.vmstorage.monitoring.svc.cluster.local:8400"
            - "--storageNode=vmstorage-2.vmstorage.monitoring.svc.cluster.local:8400"
            - "--httpListenAddr=:8480"
            - "--maxConcurrentInserts=16"
            - "--insert.maxQueueDuration=1m"
            - "--replicationFactor=2"   # write to 2 of 3 storage nodes
          ports:
            - containerPort: 8480
              name: http
          livenessProbe:
            httpGet:
              path: /health
              port: http
            initialDelaySeconds: 10
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /health
              port: http
            initialDelaySeconds: 5
            periodSeconds: 5
          resources:
            requests:
              cpu: "1"
              memory: "2Gi"
            limits:
              cpu: "2"
              memory: "4Gi"
---
apiVersion: v1
kind: Service
metadata:
  name: vminsert
  namespace: monitoring
  labels:
    app: vminsert
spec:
  selector:
    app: vminsert
  ports:
    - port: 8480
      targetPort: 8480
      name: http
```

### vmselect Deployment

```yaml
# vmselect.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vmselect
  namespace: monitoring
  labels:
    app: vmselect
    component: victoriametrics
spec:
  replicas: 2
  selector:
    matchLabels:
      app: vmselect
  template:
    metadata:
      labels:
        app: vmselect
        component: victoriametrics
    spec:
      serviceAccountName: victoriametrics
      containers:
        - name: vmselect
          image: victoriametrics/vmselect:v1.115.0-cluster
          args:
            - "--storageNode=vmstorage-0.vmstorage.monitoring.svc.cluster.local:8401"
            - "--storageNode=vmstorage-1.vmstorage.monitoring.svc.cluster.local:8401"
            - "--storageNode=vmstorage-2.vmstorage.monitoring.svc.cluster.local:8401"
            - "--httpListenAddr=:8481"
            - "--dedup.minScrapeInterval=30s"
            - "--replicationFactor=2"
            - "--search.maxQueryLen=16MB"
            - "--search.maxSamplesPerQuery=1e9"
            - "--search.maxConcurrentRequests=32"
          ports:
            - containerPort: 8481
              name: http
          livenessProbe:
            httpGet:
              path: /health
              port: http
          readinessProbe:
            httpGet:
              path: /health
              port: http
          resources:
            requests:
              cpu: "2"
              memory: "4Gi"
            limits:
              cpu: "4"
              memory: "8Gi"
---
apiVersion: v1
kind: Service
metadata:
  name: vmselect
  namespace: monitoring
  labels:
    app: vmselect
spec:
  selector:
    app: vmselect
  ports:
    - port: 8481
      targetPort: 8481
      name: http
```

### VMAlert for Recording Rules and Alerting

```yaml
# vmalert.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vmalert
  namespace: monitoring
spec:
  replicas: 1
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
          image: victoriametrics/vmalert:v1.115.0
          args:
            - "--datasource.url=http://vmselect.monitoring.svc.cluster.local:8481/select/0/prometheus"
            - "--remoteRead.url=http://vmselect.monitoring.svc.cluster.local:8481/select/0/prometheus"
            - "--remoteWrite.url=http://vminsert.monitoring.svc.cluster.local:8480/insert/0/prometheus"
            - "--notifier.url=http://alertmanager.monitoring.svc.cluster.local:9093"
            - "--rule=/etc/vmalert/rules/*.yaml"
            - "--evaluationInterval=30s"
            - "--httpListenAddr=:8880"
          volumeMounts:
            - name: rules
              mountPath: /etc/vmalert/rules
          ports:
            - containerPort: 8880
              name: http
          resources:
            requests:
              cpu: "200m"
              memory: "256Mi"
            limits:
              cpu: "500m"
              memory: "512Mi"
      volumes:
        - name: rules
          configMap:
            name: vmalert-rules
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: vmalert-rules
  namespace: monitoring
data:
  kubernetes-rules.yaml: |
    groups:
      - name: kubernetes.node
        interval: 30s
        rules:
          - record: node:node_cpu_utilization:rate5m
            expr: |
              1 - avg by(node) (
                rate(node_cpu_seconds_total{mode="idle"}[5m])
              )
          - record: node:node_memory_utilization:ratio
            expr: |
              1 - (
                node_memory_MemAvailable_bytes /
                node_memory_MemTotal_bytes
              )
          - alert: NodeHighCPU
            expr: node:node_cpu_utilization:rate5m > 0.90
            for: 5m
            labels:
              severity: warning
            annotations:
              summary: "Node {{ $labels.node }} CPU above 90%"
              description: "CPU utilization is {{ $value | humanizePercentage }}"
          - alert: NodeHighMemory
            expr: node:node_memory_utilization:ratio > 0.95
            for: 5m
            labels:
              severity: critical
            annotations:
              summary: "Node {{ $labels.node }} memory above 95%"
```

## Grafana Alloy Configuration

Alloy uses the Alloy configuration language (formerly River). The following ConfigMap represents a production-grade configuration.

### Alloy RBAC

```yaml
# alloy-rbac.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: grafana-alloy
  namespace: monitoring
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: grafana-alloy
rules:
  - apiGroups: [""]
    resources:
      - nodes
      - nodes/proxy
      - nodes/metrics
      - services
      - endpoints
      - pods
      - events
      - namespaces
      - persistentvolumes
      - persistentvolumeclaims
      - replicationcontrollers
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["deployments", "daemonsets", "statefulsets", "replicasets"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["batch"]
    resources: ["jobs", "cronjobs"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["networking.k8s.io"]
    resources: ["ingresses"]
    verbs: ["get", "list", "watch"]
  - nonResourceURLs: ["/metrics", "/metrics/cadvisor"]
    verbs: ["get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: grafana-alloy
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: grafana-alloy
subjects:
  - kind: ServiceAccount
    name: grafana-alloy
    namespace: monitoring
```

### Alloy Configuration

```yaml
# alloy-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-alloy-config
  namespace: monitoring
data:
  config.alloy: |
    // ─────────────────────────────────────────────────────────────
    // PROMETHEUS SCRAPING
    // ─────────────────────────────────────────────────────────────

    // Kubernetes pod service discovery
    discovery.kubernetes "pods" {
      role = "pod"
    }

    // Kubernetes node service discovery
    discovery.kubernetes "nodes" {
      role = "node"
    }

    // Kubernetes service service discovery
    discovery.kubernetes "services" {
      role = "service"
    }

    // Relabeling for pod scraping — only scrape pods with annotation
    discovery.relabel "pods_to_scrape" {
      targets = discovery.kubernetes.pods.targets

      // Drop pods without prometheus.io/scrape=true annotation
      rule {
        source_labels = ["__meta_kubernetes_pod_annotation_prometheus_io_scrape"]
        action        = "keep"
        regex         = "true"
      }

      // Use custom scrape path if annotated
      rule {
        source_labels = ["__meta_kubernetes_pod_annotation_prometheus_io_path"]
        action        = "replace"
        target_label  = "__metrics_path__"
        regex         = "(.+)"
      }

      // Use custom port if annotated
      rule {
        source_labels = [
          "__address__",
          "__meta_kubernetes_pod_annotation_prometheus_io_port",
        ]
        action       = "replace"
        regex        = "([^:]+)(?::\\d+)?;(\\d+)"
        replacement  = "$1:$2"
        target_label = "__address__"
      }

      // Attach Kubernetes metadata as labels
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
        source_labels = ["__meta_kubernetes_pod_label_app_kubernetes_io_name"]
        target_label  = "app"
      }
      rule {
        source_labels = ["__meta_kubernetes_pod_label_app_kubernetes_io_version"]
        target_label  = "version"
      }
      rule {
        source_labels = ["__meta_kubernetes_node_name"]
        target_label  = "node"
      }
    }

    // Scrape pods
    prometheus.scrape "pods" {
      targets    = discovery.relabel.pods_to_scrape.output
      forward_to = [prometheus.remote_write.victoriametrics.receiver]

      scrape_interval = "30s"
      scrape_timeout  = "10s"
    }

    // Scrape kubelet metrics
    prometheus.scrape "kubelet" {
      targets = discovery.kubernetes.nodes.targets
      forward_to = [prometheus.remote_write.victoriametrics.receiver]

      scheme          = "https"
      scrape_interval = "30s"

      tls_config {
        ca_file              = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
        insecure_skip_verify = false
      }
      bearer_token_file = "/var/run/secrets/kubernetes.io/serviceaccount/token"

      // Relabel to add node name
      rule {
        source_labels = ["__meta_kubernetes_node_name"]
        target_label  = "node"
      }
    }

    // Scrape cAdvisor from kubelet
    prometheus.scrape "cadvisor" {
      targets = discovery.kubernetes.nodes.targets
      forward_to = [prometheus.remote_write.victoriametrics.receiver]

      scheme          = "https"
      scrape_interval = "30s"
      metrics_path    = "/metrics/cadvisor"

      tls_config {
        ca_file = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
      }
      bearer_token_file = "/var/run/secrets/kubernetes.io/serviceaccount/token"

      rule {
        source_labels = ["__meta_kubernetes_node_name"]
        target_label  = "node"
      }
    }

    // Remote write to VictoriaMetrics
    prometheus.remote_write "victoriametrics" {
      endpoint {
        url = "http://vminsert.monitoring.svc.cluster.local:8480/insert/0/prometheus/api/v1/write"

        queue_config {
          capacity             = 20000
          max_shards           = 20
          min_shards           = 2
          max_samples_per_send = 5000
          batch_send_deadline  = "5s"
          min_backoff          = "30ms"
          max_backoff          = "5s"
        }

        metadata_config {
          send          = true
          send_interval = "1m"
        }
      }

      external_labels = {
        cluster = "production-us-east-1",
        region  = "us-east-1",
      }
    }

    // ─────────────────────────────────────────────────────────────
    // LOG COLLECTION
    // ─────────────────────────────────────────────────────────────

    // Discover pods for log tailing
    discovery.relabel "pod_logs" {
      targets = discovery.kubernetes.pods.targets

      rule {
        source_labels = ["__meta_kubernetes_pod_uid", "__meta_kubernetes_pod_container_name"]
        separator     = "/"
        target_label  = "__path__"
        replacement   = "/var/log/pods/*$1/*.log"
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
        source_labels = ["__meta_kubernetes_pod_container_name"]
        target_label  = "container"
      }
      rule {
        source_labels = ["__meta_kubernetes_pod_label_app_kubernetes_io_name"]
        target_label  = "app"
      }

      // Drop system namespaces from log collection if desired
      rule {
        source_labels = ["__meta_kubernetes_namespace"]
        action        = "drop"
        regex         = "kube-system|kube-public"
      }
    }

    // Tail log files
    loki.source.file "pods" {
      targets    = discovery.relabel.pod_logs.output
      forward_to = [loki.process.kubernetes_logs.receiver]
    }

    // Process and enrich logs
    loki.process "kubernetes_logs" {
      forward_to = [loki.write.loki.receiver]

      // Parse JSON logs when possible
      stage.json {
        expressions = {
          level  = "level",
          msg    = "msg",
          caller = "caller",
          ts     = "ts",
        }
      }

      // Extract level from parsed JSON
      stage.labels {
        values = {
          level = "",
        }
      }

      // Normalise log levels
      stage.replace {
        expression = "(?i)(warn|warning)"
        replace    = "warn"
        source     = "level"
      }

      // Drop debug logs in production (comment out to retain)
      stage.drop {
        source = "level"
        value  = "debug"
      }

      // Timestamp from parsed field
      stage.timestamp {
        source = "ts"
        format = "RFC3339Nano"
      }
    }

    // Write logs to Loki
    loki.write "loki" {
      endpoint {
        url = "http://loki-gateway.monitoring.svc.cluster.local/loki/api/v1/push"
      }

      external_labels = {
        cluster = "production-us-east-1",
      }
    }

    // ─────────────────────────────────────────────────────────────
    // OPENTELEMETRY TRACES
    // ─────────────────────────────────────────────────────────────

    // Receive OTLP traces from applications
    otelcol.receiver.otlp "default" {
      grpc {
        endpoint = "0.0.0.0:4317"
      }
      http {
        endpoint = "0.0.0.0:4318"
      }

      output {
        traces = [otelcol.processor.batch.traces.input]
      }
    }

    // Batch traces before export
    otelcol.processor.batch "traces" {
      timeout             = "1s"
      send_batch_size     = 1024
      send_batch_max_size = 2048

      output {
        traces = [otelcol.exporter.otlphttp.tempo.input]
      }
    }

    // Export traces to Tempo
    otelcol.exporter.otlphttp "tempo" {
      client {
        endpoint = "http://tempo.monitoring.svc.cluster.local:4318"

        tls {
          insecure = true
        }
      }
    }

    // ─────────────────────────────────────────────────────────────
    // SELF-MONITORING
    // ─────────────────────────────────────────────────────────────

    prometheus.exporter.self "alloy_self" {}

    prometheus.scrape "alloy_self" {
      targets    = prometheus.exporter.self.alloy_self.targets
      forward_to = [prometheus.remote_write.victoriametrics.receiver]
    }
```

### Alloy DaemonSet

```yaml
# alloy-daemonset.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: grafana-alloy
  namespace: monitoring
  labels:
    app: grafana-alloy
spec:
  selector:
    matchLabels:
      app: grafana-alloy
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
  template:
    metadata:
      labels:
        app: grafana-alloy
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "12345"
    spec:
      serviceAccountName: grafana-alloy
      hostNetwork: false
      hostPID: false
      tolerations:
        - operator: Exists
          effect: NoSchedule
        - operator: Exists
          effect: NoExecute
      priorityClassName: system-node-critical
      containers:
        - name: alloy
          image: grafana/alloy:v1.8.0
          args:
            - run
            - /etc/alloy/config.alloy
            - --storage.path=/var/lib/alloy/data
            - --server.http.listen-addr=0.0.0.0:12345
            - --stability.level=generally-available
          env:
            - name: ALLOY_DEPLOY_MODE
              value: "DaemonSet"
            - name: HOSTNAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
          ports:
            - containerPort: 12345
              name: http-metrics
              protocol: TCP
            - containerPort: 4317
              name: otlp-grpc
              protocol: TCP
            - containerPort: 4318
              name: otlp-http
              protocol: TCP
          livenessProbe:
            httpGet:
              path: /-/healthy
              port: http-metrics
            initialDelaySeconds: 20
            periodSeconds: 20
          readinessProbe:
            httpGet:
              path: /-/ready
              port: http-metrics
            initialDelaySeconds: 10
            periodSeconds: 10
          resources:
            requests:
              cpu: "200m"
              memory: "256Mi"
            limits:
              cpu: "1"
              memory: "1Gi"
          securityContext:
            runAsUser: 0   # required for log file access
            privileged: false
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
              add: ["DAC_READ_SEARCH"]
          volumeMounts:
            - name: config
              mountPath: /etc/alloy
            - name: data
              mountPath: /var/lib/alloy/data
            - name: varlogpods
              mountPath: /var/log/pods
              readOnly: true
            - name: varlibdockercontainers
              mountPath: /var/lib/docker/containers
              readOnly: true
      volumes:
        - name: config
          configMap:
            name: grafana-alloy-config
        - name: data
          emptyDir: {}
        - name: varlogpods
          hostPath:
            path: /var/log/pods
        - name: varlibdockercontainers
          hostPath:
            path: /var/lib/docker/containers
```

## Grafana Tempo Deployment

Tempo uses object storage as its backend. The following example uses S3-compatible storage.

### Tempo Configuration

```yaml
# tempo-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: tempo-config
  namespace: monitoring
data:
  tempo.yaml: |
    server:
      http_listen_port: 3200
      grpc_listen_port: 9095
      log_level: info

    distributor:
      receivers:
        otlp:
          protocols:
            grpc:
              endpoint: 0.0.0.0:4317
            http:
              endpoint: 0.0.0.0:4318
        jaeger:
          protocols:
            thrift_http:
              endpoint: 0.0.0.0:14268

    ingester:
      trace_idle_period: 10s
      max_block_bytes: 1_000_000
      max_block_duration: 5m
      concurrent_flushes: 4

    compactor:
      compaction:
        compaction_window: 1h
        max_compaction_objects: 1_000_000
        block_retention: 720h    # 30 days
        compacted_block_retention: 1h

    storage:
      trace:
        backend: s3
        s3:
          bucket: observability-tempo-traces
          endpoint: s3.us-east-1.amazonaws.com
          region: us-east-1
          # Use IRSA / Workload Identity — no static credentials
          insecure: false
        wal:
          path: /var/tempo/wal
        local:
          path: /var/tempo/blocks

    querier:
      max_concurrent_queries: 20
      search:
        prefer_self: 10
        external_hedge_requests_at: 8s
        external_hedge_requests_up_to: 2

    query_frontend:
      max_retries: 2
      search:
        duration_slo: 5s
        throughput_bytes_slo: 1.073741824e+09

    metrics_generator:
      registry:
        external_labels:
          source: tempo
          cluster: production-us-east-1
      storage:
        path: /var/tempo/generator/wal
        remote_write:
          - url: http://vminsert.monitoring.svc.cluster.local:8480/insert/0/prometheus/api/v1/write

    overrides:
      metrics_generator_processors:
        - service-graphs
        - span-metrics
```

### Tempo Deployment

```yaml
# tempo-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: tempo
  namespace: monitoring
  labels:
    app: tempo
spec:
  replicas: 1
  selector:
    matchLabels:
      app: tempo
  template:
    metadata:
      labels:
        app: tempo
    spec:
      serviceAccountName: victoriametrics   # reuse SA with IRSA for S3
      containers:
        - name: tempo
          image: grafana/tempo:2.7.0
          args:
            - -config.file=/etc/tempo/tempo.yaml
            - -target=all
          ports:
            - containerPort: 3200
              name: http
            - containerPort: 4317
              name: otlp-grpc
            - containerPort: 4318
              name: otlp-http
            - containerPort: 14268
              name: jaeger-http
            - containerPort: 9095
              name: grpc
          livenessProbe:
            httpGet:
              path: /ready
              port: http
            initialDelaySeconds: 45
          readinessProbe:
            httpGet:
              path: /ready
              port: http
            initialDelaySeconds: 30
          resources:
            requests:
              cpu: "500m"
              memory: "1Gi"
            limits:
              cpu: "2"
              memory: "4Gi"
          volumeMounts:
            - name: config
              mountPath: /etc/tempo
            - name: tempo-data
              mountPath: /var/tempo
      volumes:
        - name: config
          configMap:
            name: tempo-config
        - name: tempo-data
          emptyDir:
            medium: ""
            sizeLimit: 10Gi
---
apiVersion: v1
kind: Service
metadata:
  name: tempo
  namespace: monitoring
  labels:
    app: tempo
spec:
  selector:
    app: tempo
  ports:
    - port: 3200
      name: http
    - port: 4317
      name: otlp-grpc
    - port: 4318
      name: otlp-http
    - port: 14268
      name: jaeger-http
```

## Grafana Configuration

### Grafana with Data Sources Provisioned

```yaml
# grafana-datasources.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-datasources
  namespace: monitoring
data:
  datasources.yaml: |
    apiVersion: 1

    datasources:
      - name: VictoriaMetrics
        type: prometheus
        uid: victoriametrics
        url: http://vmselect.monitoring.svc.cluster.local:8481/select/0/prometheus
        isDefault: true
        editable: false
        jsonData:
          httpMethod: POST
          manageAlerts: true
          prometheusType: Prometheus
          prometheusVersion: "2.40.0"
          cacheLevel: High
          disableRecordingRules: false
          incrementalQueryOverlapWindow: 10m

      - name: Loki
        type: loki
        uid: loki
        url: http://loki-gateway.monitoring.svc.cluster.local
        editable: false
        jsonData:
          derivedFields:
            - datasourceUid: tempo
              matcherRegex: '"trace_id":"(\w+)"'
              name: TraceID
              url: "$${__value.raw}"
              urlDisplayLabel: "View Trace"

      - name: Tempo
        type: tempo
        uid: tempo
        url: http://tempo.monitoring.svc.cluster.local:3200
        editable: false
        jsonData:
          tracesToLogsV2:
            datasourceUid: loki
            filterByTraceID: true
            filterBySpanID: false
            customQuery: true
            query: |
              {namespace="${__span.tags.k8s.namespace.name}",
               pod="${__span.tags.k8s.pod.name}"}
               | json
               | trace_id="${__trace.traceId}"
          tracesToMetrics:
            datasourceUid: victoriametrics
            queries:
              - name: Request Rate
                query: |
                  sum(rate(traces_spanmetrics_calls_total{
                    service_name="${__span.tags.service.name}"
                  }[5m]))
          serviceMap:
            datasourceUid: victoriametrics
          nodeGraph:
            enabled: true
          lokiSearch:
            datasourceUid: loki
```

### Kubernetes Overview Dashboard

```json
{
  "title": "Kubernetes Cluster Overview",
  "uid": "k8s-cluster-overview",
  "panels": [
    {
      "title": "Cluster CPU Utilization",
      "type": "timeseries",
      "targets": [
        {
          "datasource": { "uid": "victoriametrics" },
          "expr": "sum(node:node_cpu_utilization:rate5m) / count(node:node_cpu_utilization:rate5m)",
          "legendFormat": "Cluster CPU"
        }
      ]
    },
    {
      "title": "Pod Restart Rate",
      "type": "timeseries",
      "targets": [
        {
          "datasource": { "uid": "victoriametrics" },
          "expr": "sum by(namespace, pod) (increase(kube_pod_container_status_restarts_total[1h])) > 0",
          "legendFormat": "{{namespace}}/{{pod}}"
        }
      ]
    },
    {
      "title": "Recent Logs",
      "type": "logs",
      "targets": [
        {
          "datasource": { "uid": "loki" },
          "expr": "{cluster=\"production-us-east-1\", level=~\"error|warn\"} | json",
          "legendFormat": ""
        }
      ]
    }
  ]
}
```

## Alerting with Alertmanager

```yaml
# alertmanager-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: alertmanager-config
  namespace: monitoring
data:
  alertmanager.yaml: |
    global:
      resolve_timeout: 5m
      slack_api_url: "https://hooks.slack.com/services/<WORKSPACE_ID>/<CHANNEL_ID>/<WEBHOOK_TOKEN>"

    route:
      group_by: ["alertname", "cluster", "namespace"]
      group_wait: 30s
      group_interval: 5m
      repeat_interval: 4h
      receiver: "slack-default"
      routes:
        - matchers:
            - severity = "critical"
          receiver: "pagerduty-critical"
          continue: true
        - matchers:
            - severity = "warning"
          receiver: "slack-warnings"

    receivers:
      - name: "slack-default"
        slack_configs:
          - channel: "#alerts"
            title: "{{ .GroupLabels.alertname }}"
            text: >-
              {{ range .Alerts }}
              *Alert:* {{ .Annotations.summary }}
              *Severity:* {{ .Labels.severity }}
              *Cluster:* {{ .Labels.cluster }}
              {{ end }}
            send_resolved: true

      - name: "slack-warnings"
        slack_configs:
          - channel: "#alerts-warnings"
            send_resolved: true

      - name: "pagerduty-critical"
        pagerduty_configs:
          - routing_key: "<pagerduty-integration-key>"
            description: "{{ .CommonAnnotations.summary }}"

    inhibit_rules:
      - source_matchers:
          - severity = "critical"
        target_matchers:
          - severity = "warning"
        equal: ["alertname", "cluster", "namespace"]
```

## Production Tuning and Optimization

### VictoriaMetrics Cardinality Management

High-cardinality metrics are the most common cause of storage and memory pressure in time-series databases. VictoriaMetrics provides a cardinality explorer at `/vmui/#/cardinality` that identifies the top contributors.

```bash
# Query the top 20 highest-cardinality metrics
curl -sg 'http://vmselect:8481/select/0/prometheus/api/v1/label/__name__/values' \
  | python3 -c "
import sys, json
names = json.load(sys.stdin)['data']
print(f'Total metric names: {len(names)}')
"

# Find time series with label explosion
curl -sg 'http://vmselect:8481/select/0/prometheus/api/v1/series/count' \
  | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(f'Total series: {data[\"data\"]}')
"
```

Add recording rules to reduce high-cardinality raw metrics:

```yaml
# cardinality-reduction-rules.yaml
groups:
  - name: cardinality.reduction
    interval: 60s
    rules:
      # Aggregate http_request_duration from per-URL to per-handler
      - record: job:http_request_duration_seconds:histogram_quantile99
        expr: |
          histogram_quantile(0.99,
            sum by(job, namespace, le) (
              rate(http_request_duration_seconds_bucket[5m])
            )
          )
      # Drop the raw per-URL histogram after aggregation
      # (configure via relabel_config drop rules in Alloy)
```

### Alloy Memory Tuning

```alloy
// In config.alloy — tune WAL and queue sizes
prometheus.remote_write "victoriametrics" {
  endpoint {
    url = "http://vminsert.monitoring.svc.cluster.local:8480/insert/0/prometheus/api/v1/write"

    queue_config {
      // Scale with number of active series
      capacity             = 50000    // in-memory samples before WAL
      max_shards           = 30
      max_samples_per_send = 10000
      batch_send_deadline  = "10s"
    }
  }

  wal {
    // WAL truncation frequency
    truncate_frequency = "2h"
    // Minimum age of WAL samples to keep
    min_keepalive_time = "5m"
    // Maximum age of WAL samples to keep
    max_keepalive_time = "8h"
  }
}
```

### Tempo Query Performance

```yaml
# tempo-query-tuning.yaml — add to tempo.yaml
querier:
  max_concurrent_queries: 20
  frontend_worker:
    grpc_client_config:
      max_recv_msg_size: 100000000   # 100MB
  search:
    # Prefer local blocks before querying object storage
    prefer_self: 10
    # Start hedged requests to object storage after 8s
    external_hedge_requests_at: 8s

query_frontend:
  max_retries: 3
  search:
    # Parallelise across block shards
    max_outstanding_per_tenant: 2000
    concurrent_jobs: 2000
    target_bytes_per_job: 104857600  # 100MB per job
```

## Validating the Stack

```bash
# Verify VictoriaMetrics cluster health
kubectl exec -n monitoring deploy/vminsert -- \
  wget -qO- http://localhost:8480/health && echo "vminsert OK"

kubectl exec -n monitoring deploy/vmselect -- \
  wget -qO- http://localhost:8481/health && echo "vmselect OK"

# Check storage nodes are all reachable
for i in 0 1 2; do
  kubectl exec -n monitoring vmstorage-$i -- \
    wget -qO- http://localhost:8482/health && echo "vmstorage-$i OK"
done

# Check Alloy is scraping successfully
kubectl exec -n monitoring ds/grafana-alloy -- \
  wget -qO- http://localhost:12345/-/ready

# Verify traces are reaching Tempo
curl -s http://tempo.monitoring.svc.cluster.local:3200/ready

# Query VictoriaMetrics for scrape targets
curl -s 'http://vmselect:8481/select/0/prometheus/api/v1/targets' \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
active = [t for t in d['data']['activeTargets']]
down = [t for t in active if t['health'] == 'down']
print(f'Active: {len(active)}  Down: {len(down)}')
for t in down[:5]:
    print(f'  DOWN: {t[\"labels\"].get(\"job\", \"?\")} — {t[\"lastError\"]}')
"
```

## Key Takeaways

Building a production observability stack in 2030 requires fewer moving parts than it did five years ago, but requires more deliberate configuration of each component.

Deploying VictoriaMetrics as a three-shard cluster with replication factor two gives you the durability and horizontal scaling needed for large clusters while keeping operational complexity far lower than Thanos. The vminsert/vmselect/vmstorage separation means reads and writes can be scaled independently based on actual workload.

Grafana Alloy as a unified collector eliminates the three-agent problem. A single DaemonSet pod that scrapes metrics, tails logs, and receives OTLP traces costs roughly the same resources as a single dedicated log collector, and the label consistency gained across all three signals is invaluable when correlating across signal types in Grafana.

Tempo with object storage backend provides virtually unlimited trace retention at a fraction of the cost of Jaeger with Elasticsearch. The metrics-generator feature, which derives span metrics and service graphs from trace data, feeds additional signals back into VictoriaMetrics and populates the service topology view automatically.

The critical production concern is cardinality. Any observability stack will degrade if cardinality grows unbounded. Use the VictoriaMetrics cardinality explorer regularly, add recording rules to pre-aggregate high-cardinality metrics, and use relabeling in Alloy to drop label values that should never appear in metrics (request URLs with IDs, for example).
