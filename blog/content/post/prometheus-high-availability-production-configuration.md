---
title: "Prometheus High Availability Configuration: Production-Ready Multi-Cluster Setup with Thanos"
date: 2026-10-29T00:00:00-05:00
draft: false
tags: ["Prometheus", "High Availability", "Monitoring", "Kubernetes", "Thanos", "Observability", "DevOps"]
categories: ["Monitoring", "Observability", "Infrastructure"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to deploying highly available Prometheus in production Kubernetes environments with Thanos integration, federation, and advanced alerting strategies."
more_link: "yes"
url: "/prometheus-high-availability-production-configuration/"
---

Building a highly available Prometheus monitoring infrastructure is critical for enterprise environments where monitoring downtime is unacceptable. This comprehensive guide covers production-grade Prometheus HA deployment patterns, Thanos integration for long-term storage and global querying, advanced federation strategies, and alerting configuration for resilient monitoring at scale.

<!--more-->

# Prometheus High Availability Configuration: Production-Ready Setup

## Executive Summary

Prometheus is the de facto standard for metrics monitoring in cloud-native environments, but achieving true high availability requires careful architecture and configuration. This guide demonstrates how to deploy Prometheus in highly available configurations using multiple replicas, Thanos for long-term storage and global queries, federation patterns for multi-cluster environments, and robust alerting with deduplication.

## Understanding Prometheus HA Architecture

### Core HA Patterns

1. **Prometheus Replica Pattern**: Multiple identical Prometheus servers scraping the same targets
2. **Thanos Integration**: Global query view with long-term storage
3. **Federation**: Hierarchical Prometheus deployments
4. **Alertmanager Clustering**: Deduplicated, highly available alerting

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Load Balancer / Query Frontend           │
│                  (Thanos Query / Query Frontend)             │
└─────────────────────────────────────────────────────────────┘
                              │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
┌───────▼────────┐  ┌────────▼───────┐  ┌────────▼───────┐
│  Prometheus-0  │  │  Prometheus-1  │  │  Prometheus-2  │
│   + Sidecar    │  │   + Sidecar    │  │   + Sidecar    │
└────────────────┘  └────────────────┘  └────────────────┘
        │                    │                    │
        └────────────────────┼────────────────────┘
                             │
                    ┌────────▼────────┐
                    │  Object Storage │
                    │  (S3/GCS/Azure) │
                    └─────────────────┘
```

## Prometheus StatefulSet Deployment

### High Availability StatefulSet

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: prometheus
  namespace: monitoring
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: prometheus
rules:
- apiGroups: [""]
  resources:
    - nodes
    - nodes/proxy
    - nodes/metrics
    - services
    - endpoints
    - pods
  verbs: ["get", "list", "watch"]
- apiGroups: [""]
  resources:
    - configmaps
  verbs: ["get"]
- apiGroups:
    - networking.k8s.io
  resources:
    - ingresses
  verbs: ["get", "list", "watch"]
- nonResourceURLs: ["/metrics"]
  verbs: ["get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: prometheus
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: prometheus
subjects:
- kind: ServiceAccount
  name: prometheus
  namespace: monitoring
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: prometheus-config
  namespace: monitoring
data:
  prometheus.yml: |
    global:
      scrape_interval: 30s
      scrape_timeout: 10s
      evaluation_interval: 30s
      external_labels:
        cluster: production-us-east-1
        replica: $(HOSTNAME)
        environment: production

    # Alertmanager configuration with HA cluster
    alerting:
      alert_relabel_configs:
        # Add replica label for deduplication
        - source_labels: [__address__]
          target_label: __tmp_replica
          replacement: $(HOSTNAME)
        - source_labels: [__tmp_replica]
          target_label: replica
      alertmanagers:
        - kubernetes_sd_configs:
            - role: pod
              namespaces:
                names:
                  - monitoring
          relabel_configs:
            - source_labels: [__meta_kubernetes_pod_label_app]
              action: keep
              regex: alertmanager
            - source_labels: [__meta_kubernetes_pod_container_port_number]
              action: keep
              regex: "9093"
          timeout: 10s
          api_version: v2

    # Recording and alerting rules
    rule_files:
      - /etc/prometheus/rules/*.yml

    # Scrape configurations
    scrape_configs:
      # Kubernetes API Server
      - job_name: 'kubernetes-apiservers'
        kubernetes_sd_configs:
          - role: endpoints
        scheme: https
        tls_config:
          ca_file: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
        bearer_token_file: /var/run/secrets/kubernetes.io/serviceaccount/token
        relabel_configs:
          - source_labels: [__meta_kubernetes_namespace, __meta_kubernetes_service_name, __meta_kubernetes_endpoint_port_name]
            action: keep
            regex: default;kubernetes;https

      # Kubernetes nodes
      - job_name: 'kubernetes-nodes'
        kubernetes_sd_configs:
          - role: node
        scheme: https
        tls_config:
          ca_file: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
        bearer_token_file: /var/run/secrets/kubernetes.io/serviceaccount/token
        relabel_configs:
          - action: labelmap
            regex: __meta_kubernetes_node_label_(.+)
          - target_label: __address__
            replacement: kubernetes.default.svc:443
          - source_labels: [__meta_kubernetes_node_name]
            regex: (.+)
            target_label: __metrics_path__
            replacement: /api/v1/nodes/${1}/proxy/metrics

      # Kubernetes node cadvisor
      - job_name: 'kubernetes-cadvisor'
        kubernetes_sd_configs:
          - role: node
        scheme: https
        tls_config:
          ca_file: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
        bearer_token_file: /var/run/secrets/kubernetes.io/serviceaccount/token
        relabel_configs:
          - action: labelmap
            regex: __meta_kubernetes_node_label_(.+)
          - target_label: __address__
            replacement: kubernetes.default.svc:443
          - source_labels: [__meta_kubernetes_node_name]
            regex: (.+)
            target_label: __metrics_path__
            replacement: /api/v1/nodes/${1}/proxy/metrics/cadvisor
        metric_relabel_configs:
          # Drop high cardinality metrics
          - source_labels: [__name__]
            regex: 'container_network_tcp_usage_total|container_network_udp_usage_total'
            action: drop

      # Kubernetes service endpoints
      - job_name: 'kubernetes-service-endpoints'
        kubernetes_sd_configs:
          - role: endpoints
        relabel_configs:
          - source_labels: [__meta_kubernetes_service_annotation_prometheus_io_scrape]
            action: keep
            regex: true
          - source_labels: [__meta_kubernetes_service_annotation_prometheus_io_scheme]
            action: replace
            target_label: __scheme__
            regex: (https?)
          - source_labels: [__meta_kubernetes_service_annotation_prometheus_io_path]
            action: replace
            target_label: __metrics_path__
            regex: (.+)
          - source_labels: [__address__, __meta_kubernetes_service_annotation_prometheus_io_port]
            action: replace
            target_label: __address__
            regex: ([^:]+)(?::\d+)?;(\d+)
            replacement: $1:$2
          - action: labelmap
            regex: __meta_kubernetes_service_label_(.+)
          - source_labels: [__meta_kubernetes_namespace]
            action: replace
            target_label: kubernetes_namespace
          - source_labels: [__meta_kubernetes_service_name]
            action: replace
            target_label: kubernetes_name
          - source_labels: [__meta_kubernetes_pod_name]
            action: replace
            target_label: kubernetes_pod_name

      # Kubernetes pods
      - job_name: 'kubernetes-pods'
        kubernetes_sd_configs:
          - role: pod
        relabel_configs:
          - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
            action: keep
            regex: true
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
            target_label: kubernetes_namespace
          - source_labels: [__meta_kubernetes_pod_name]
            action: replace
            target_label: kubernetes_pod_name

      # Prometheus self-monitoring
      - job_name: 'prometheus'
        static_configs:
          - targets: ['localhost:9090']

      # Thanos sidecars
      - job_name: 'thanos-sidecars'
        kubernetes_sd_configs:
          - role: pod
            namespaces:
              names:
                - monitoring
        relabel_configs:
          - source_labels: [__meta_kubernetes_pod_label_app]
            action: keep
            regex: prometheus
          - source_labels: [__meta_kubernetes_pod_container_port_name]
            action: keep
            regex: grpc
          - source_labels: [__meta_kubernetes_pod_name]
            target_label: pod
          - source_labels: [__meta_kubernetes_namespace]
            target_label: namespace
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: prometheus-rules
  namespace: monitoring
data:
  alerts.yml: |
    groups:
      - name: prometheus
        interval: 30s
        rules:
          # Prometheus is down
          - alert: PrometheusDown
            expr: up{job="prometheus"} == 0
            for: 5m
            labels:
              severity: critical
              component: monitoring
            annotations:
              summary: "Prometheus instance is down"
              description: "Prometheus instance {{ $labels.instance }} has been down for more than 5 minutes."

          # High scrape duration
          - alert: PrometheusHighScrapeDuration
            expr: prometheus_target_interval_length_seconds{quantile="0.9"} > 60
            for: 5m
            labels:
              severity: warning
            annotations:
              summary: "Prometheus scrape duration is high"
              description: "Prometheus scrape duration for {{ $labels.job }} is {{ $value }}s."

          # Too many failed scrapes
          - alert: PrometheusHighFailedScrapes
            expr: rate(prometheus_target_scrapes_exceeded_sample_limit_total[5m]) > 0
            for: 5m
            labels:
              severity: warning
            annotations:
              summary: "Prometheus has high failed scrape rate"
              description: "Prometheus is failing to scrape {{ $labels.job }}."

          # TSDB compaction failed
          - alert: PrometheusTSDBCompactionsFailed
            expr: increase(prometheus_tsdb_compactions_failed_total[3h]) > 0
            for: 5m
            labels:
              severity: warning
            annotations:
              summary: "Prometheus TSDB compactions are failing"
              description: "Prometheus has had {{ $value }} TSDB compaction failures."

          # TSDB reload failed
          - alert: PrometheusTSDBReloadsFailed
            expr: increase(prometheus_tsdb_reloads_failures_total[3h]) > 0
            for: 5m
            labels:
              severity: warning
            annotations:
              summary: "Prometheus TSDB reloads are failing"
              description: "Prometheus has had {{ $value }} TSDB reload failures."

          # Rule evaluation failures
          - alert: PrometheusRuleEvaluationFailures
            expr: increase(prometheus_rule_evaluation_failures_total[5m]) > 0
            for: 5m
            labels:
              severity: warning
            annotations:
              summary: "Prometheus rule evaluation is failing"
              description: "Prometheus has had {{ $value }} rule evaluation failures."

          # Target down
          - alert: PrometheusTargetDown
            expr: up == 0
            for: 5m
            labels:
              severity: warning
            annotations:
              summary: "Prometheus target is down"
              description: "{{ $labels.job }}/{{ $labels.instance }} has been down for more than 5 minutes."

      - name: kubernetes
        interval: 30s
        rules:
          # Node not ready
          - alert: KubernetesNodeNotReady
            expr: kube_node_status_condition{condition="Ready",status="true"} == 0
            for: 5m
            labels:
              severity: critical
            annotations:
              summary: "Kubernetes node is not ready"
              description: "Node {{ $labels.node }} has been unready for more than 5 minutes."

          # Node memory pressure
          - alert: KubernetesNodeMemoryPressure
            expr: kube_node_status_condition{condition="MemoryPressure",status="true"} == 1
            for: 5m
            labels:
              severity: warning
            annotations:
              summary: "Kubernetes node has memory pressure"
              description: "Node {{ $labels.node }} has memory pressure."

          # Pod crash looping
          - alert: KubernetesPodCrashLooping
            expr: rate(kube_pod_container_status_restarts_total[15m]) > 0
            for: 5m
            labels:
              severity: warning
            annotations:
              summary: "Kubernetes pod is crash looping"
              description: "Pod {{ $labels.namespace }}/{{ $labels.pod }} is crash looping."
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: prometheus
  namespace: monitoring
  labels:
    app: prometheus
spec:
  serviceName: prometheus
  replicas: 2
  selector:
    matchLabels:
      app: prometheus
  template:
    metadata:
      labels:
        app: prometheus
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9090"
    spec:
      serviceAccountName: prometheus
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchExpressions:
                  - key: app
                    operator: In
                    values:
                      - prometheus
              topologyKey: kubernetes.io/hostname
      securityContext:
        fsGroup: 2000
        runAsNonRoot: true
        runAsUser: 1000
      containers:
        # Prometheus server
        - name: prometheus
          image: prom/prometheus:v2.48.0
          args:
            - '--config.file=/etc/prometheus/prometheus.yml'
            - '--storage.tsdb.path=/prometheus'
            - '--storage.tsdb.retention.time=2h'
            - '--storage.tsdb.min-block-duration=2h'
            - '--storage.tsdb.max-block-duration=2h'
            - '--web.enable-lifecycle'
            - '--web.enable-admin-api'
            - '--web.console.libraries=/usr/share/prometheus/console_libraries'
            - '--web.console.templates=/usr/share/prometheus/consoles'
          ports:
            - name: web
              containerPort: 9090
          volumeMounts:
            - name: config
              mountPath: /etc/prometheus
            - name: rules
              mountPath: /etc/prometheus/rules
            - name: storage
              mountPath: /prometheus
          resources:
            requests:
              memory: "4Gi"
              cpu: "2000m"
            limits:
              memory: "8Gi"
              cpu: "4000m"
          livenessProbe:
            httpGet:
              path: /-/healthy
              port: 9090
            initialDelaySeconds: 30
            periodSeconds: 10
            timeoutSeconds: 5
          readinessProbe:
            httpGet:
              path: /-/ready
              port: 9090
            initialDelaySeconds: 30
            periodSeconds: 5
            timeoutSeconds: 5

        # Thanos sidecar
        - name: thanos
          image: quay.io/thanos/thanos:v0.32.5
          args:
            - sidecar
            - --tsdb.path=/prometheus
            - --prometheus.url=http://localhost:9090
            - --grpc-address=0.0.0.0:10901
            - --http-address=0.0.0.0:10902
            - --objstore.config-file=/etc/thanos/objstore.yml
            - --log.level=info
          env:
            - name: HOSTNAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
          ports:
            - name: grpc
              containerPort: 10901
            - name: http
              containerPort: 10902
          volumeMounts:
            - name: storage
              mountPath: /prometheus
            - name: thanos-objstore
              mountPath: /etc/thanos
          resources:
            requests:
              memory: "512Mi"
              cpu: "250m"
            limits:
              memory: "1Gi"
              cpu: "500m"
          livenessProbe:
            httpGet:
              path: /-/healthy
              port: 10902
            initialDelaySeconds: 30
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /-/ready
              port: 10902
            initialDelaySeconds: 30
            periodSeconds: 5

      volumes:
        - name: config
          configMap:
            name: prometheus-config
        - name: rules
          configMap:
            name: prometheus-rules
        - name: thanos-objstore
          secret:
            secretName: thanos-objstore-config
  volumeClaimTemplates:
    - metadata:
        name: storage
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: fast-ssd
        resources:
          requests:
            storage: 100Gi
---
apiVersion: v1
kind: Service
metadata:
  name: prometheus
  namespace: monitoring
  labels:
    app: prometheus
spec:
  type: ClusterIP
  clusterIP: None
  selector:
    app: prometheus
  ports:
    - name: web
      port: 9090
      targetPort: 9090
    - name: grpc
      port: 10901
      targetPort: 10901
---
apiVersion: v1
kind: Service
metadata:
  name: prometheus-lb
  namespace: monitoring
  labels:
    app: prometheus
spec:
  type: LoadBalancer
  selector:
    app: prometheus
  ports:
    - name: web
      port: 9090
      targetPort: 9090
```

## Thanos Components Deployment

### Thanos Query

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: thanos-objstore-config
  namespace: monitoring
type: Opaque
stringData:
  objstore.yml: |
    type: S3
    config:
      bucket: prometheus-metrics-prod
      endpoint: s3.amazonaws.com
      region: us-east-1
      access_key: ${AWS_ACCESS_KEY_ID}
      secret_key: ${AWS_SECRET_ACCESS_KEY}
      insecure: false
      signature_version2: false
      http_config:
        idle_conn_timeout: 90s
        response_header_timeout: 2m
        insecure_skip_verify: false
      trace:
        enable: true
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: thanos-query
  namespace: monitoring
  labels:
    app: thanos-query
spec:
  replicas: 2
  selector:
    matchLabels:
      app: thanos-query
  template:
    metadata:
      labels:
        app: thanos-query
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
                      values:
                        - thanos-query
                topologyKey: kubernetes.io/hostname
      containers:
        - name: thanos-query
          image: quay.io/thanos/thanos:v0.32.5
          args:
            - query
            - --http-address=0.0.0.0:10902
            - --grpc-address=0.0.0.0:10901
            - --log.level=info
            - --query.replica-label=replica
            - --query.replica-label=prometheus_replica
            - --store=dnssrv+_grpc._tcp.prometheus.monitoring.svc.cluster.local
            - --store=dnssrv+_grpc._tcp.thanos-store.monitoring.svc.cluster.local
            - --query.auto-downsampling
            - --query.partial-response
            - --query.max-concurrent=20
            - --query.timeout=5m
            - --query.lookback-delta=15m
          ports:
            - name: http
              containerPort: 10902
            - name: grpc
              containerPort: 10901
          resources:
            requests:
              memory: "1Gi"
              cpu: "500m"
            limits:
              memory: "2Gi"
              cpu: "1000m"
          livenessProbe:
            httpGet:
              path: /-/healthy
              port: 10902
            initialDelaySeconds: 30
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /-/ready
              port: 10902
            initialDelaySeconds: 10
            periodSeconds: 5
---
apiVersion: v1
kind: Service
metadata:
  name: thanos-query
  namespace: monitoring
  labels:
    app: thanos-query
spec:
  type: LoadBalancer
  selector:
    app: thanos-query
  ports:
    - name: http
      port: 9090
      targetPort: 10902
    - name: grpc
      port: 10901
      targetPort: 10901
```

### Thanos Store Gateway

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: thanos-store
  namespace: monitoring
  labels:
    app: thanos-store
spec:
  serviceName: thanos-store
  replicas: 2
  selector:
    matchLabels:
      app: thanos-store
  template:
    metadata:
      labels:
        app: thanos-store
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
                      values:
                        - thanos-store
                topologyKey: kubernetes.io/hostname
      containers:
        - name: thanos-store
          image: quay.io/thanos/thanos:v0.32.5
          args:
            - store
            - --data-dir=/var/thanos/store
            - --grpc-address=0.0.0.0:10901
            - --http-address=0.0.0.0:10902
            - --objstore.config-file=/etc/thanos/objstore.yml
            - --log.level=info
            - --index-cache-size=2GB
            - --chunk-pool-size=2GB
            - --max-time=-1h
            - --min-time=-6w
          ports:
            - name: http
              containerPort: 10902
            - name: grpc
              containerPort: 10901
          volumeMounts:
            - name: storage
              mountPath: /var/thanos/store
            - name: thanos-objstore
              mountPath: /etc/thanos
          resources:
            requests:
              memory: "4Gi"
              cpu: "1000m"
            limits:
              memory: "8Gi"
              cpu: "2000m"
          livenessProbe:
            httpGet:
              path: /-/healthy
              port: 10902
            initialDelaySeconds: 30
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /-/ready
              port: 10902
            initialDelaySeconds: 30
            periodSeconds: 5
      volumes:
        - name: thanos-objstore
          secret:
            secretName: thanos-objstore-config
  volumeClaimTemplates:
    - metadata:
        name: storage
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: fast-ssd
        resources:
          requests:
            storage: 50Gi
---
apiVersion: v1
kind: Service
metadata:
  name: thanos-store
  namespace: monitoring
  labels:
    app: thanos-store
spec:
  type: ClusterIP
  clusterIP: None
  selector:
    app: thanos-store
  ports:
    - name: http
      port: 10902
      targetPort: 10902
    - name: grpc
      port: 10901
      targetPort: 10901
```

### Thanos Compactor

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: thanos-compactor
  namespace: monitoring
  labels:
    app: thanos-compactor
spec:
  serviceName: thanos-compactor
  replicas: 1
  selector:
    matchLabels:
      app: thanos-compactor
  template:
    metadata:
      labels:
        app: thanos-compactor
    spec:
      containers:
        - name: thanos-compactor
          image: quay.io/thanos/thanos:v0.32.5
          args:
            - compact
            - --data-dir=/var/thanos/compact
            - --objstore.config-file=/etc/thanos/objstore.yml
            - --http-address=0.0.0.0:10902
            - --log.level=info
            - --retention.resolution-raw=30d
            - --retention.resolution-5m=90d
            - --retention.resolution-1h=365d
            - --compact.concurrency=6
            - --delete-delay=48h
            - --downsampling.disable=false
            - --deduplication.replica-label=replica
            - --deduplication.replica-label=prometheus_replica
          ports:
            - name: http
              containerPort: 10902
          volumeMounts:
            - name: storage
              mountPath: /var/thanos/compact
            - name: thanos-objstore
              mountPath: /etc/thanos
          resources:
            requests:
              memory: "2Gi"
              cpu: "1000m"
            limits:
              memory: "4Gi"
              cpu: "2000m"
          livenessProbe:
            httpGet:
              path: /-/healthy
              port: 10902
            initialDelaySeconds: 60
            periodSeconds: 30
          readinessProbe:
            httpGet:
              path: /-/ready
              port: 10902
            initialDelaySeconds: 60
            periodSeconds: 30
      volumes:
        - name: thanos-objstore
          secret:
            secretName: thanos-objstore-config
  volumeClaimTemplates:
    - metadata:
        name: storage
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: fast-ssd
        resources:
          requests:
            storage: 100Gi
```

### Thanos Ruler

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: thanos-ruler-rules
  namespace: monitoring
data:
  alerts.yml: |
    groups:
      - name: thanos
        interval: 30s
        rules:
          # Thanos sidecar is unhealthy
          - alert: ThanosSidecarUnhealthy
            expr: thanos_sidecar_prometheus_up == 0
            for: 5m
            labels:
              severity: critical
            annotations:
              summary: "Thanos sidecar is unhealthy"
              description: "Thanos sidecar on {{ $labels.pod }} has been unhealthy for 5 minutes."

          # Thanos compaction failures
          - alert: ThanosCompactionFailed
            expr: rate(thanos_compact_iterations_total{result="error"}[5m]) > 0
            for: 15m
            labels:
              severity: warning
            annotations:
              summary: "Thanos compaction is failing"
              description: "Thanos compaction has failed {{ $value }} times."

          # Thanos store gRPC errors
          - alert: ThanosStoreGrpcErrors
            expr: rate(grpc_server_handled_total{grpc_code=~"Unknown|Internal|Unavailable|DataLoss",job="thanos-store"}[5m]) > 0
            for: 5m
            labels:
              severity: warning
            annotations:
              summary: "Thanos store has gRPC errors"
              description: "Thanos store is experiencing {{ $value }} gRPC errors per second."
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: thanos-ruler
  namespace: monitoring
  labels:
    app: thanos-ruler
spec:
  serviceName: thanos-ruler
  replicas: 2
  selector:
    matchLabels:
      app: thanos-ruler
  template:
    metadata:
      labels:
        app: thanos-ruler
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
                      values:
                        - thanos-ruler
                topologyKey: kubernetes.io/hostname
      containers:
        - name: thanos-ruler
          image: quay.io/thanos/thanos:v0.32.5
          args:
            - rule
            - --data-dir=/var/thanos/ruler
            - --grpc-address=0.0.0.0:10901
            - --http-address=0.0.0.0:10902
            - --log.level=info
            - --rule-file=/etc/thanos/rules/*.yml
            - --objstore.config-file=/etc/thanos/objstore.yml
            - --query=dnssrv+_http._tcp.thanos-query.monitoring.svc.cluster.local
            - --alertmanagers.url=http://alertmanager.monitoring.svc.cluster.local:9093
            - --label=replica="$(POD_NAME)"
            - --label=ruler_cluster="production"
            - --alert.query-url=https://thanos.example.com
          env:
            - name: POD_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
          ports:
            - name: http
              containerPort: 10902
            - name: grpc
              containerPort: 10901
          volumeMounts:
            - name: storage
              mountPath: /var/thanos/ruler
            - name: rules
              mountPath: /etc/thanos/rules
            - name: thanos-objstore
              mountPath: /etc/thanos
              readOnly: true
          resources:
            requests:
              memory: "1Gi"
              cpu: "500m"
            limits:
              memory: "2Gi"
              cpu: "1000m"
          livenessProbe:
            httpGet:
              path: /-/healthy
              port: 10902
            initialDelaySeconds: 30
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /-/ready
              port: 10902
            initialDelaySeconds: 30
            periodSeconds: 5
      volumes:
        - name: rules
          configMap:
            name: thanos-ruler-rules
        - name: thanos-objstore
          secret:
            secretName: thanos-objstore-config
  volumeClaimTemplates:
    - metadata:
        name: storage
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: fast-ssd
        resources:
          requests:
            storage: 50Gi
```

## Alertmanager High Availability

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: alertmanager-config
  namespace: monitoring
data:
  alertmanager.yml: |
    global:
      resolve_timeout: 5m
      slack_api_url: 'https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK'

    # Templates for notifications
    templates:
      - '/etc/alertmanager/templates/*.tmpl'

    # Route configuration
    route:
      receiver: 'default'
      group_by: ['alertname', 'cluster', 'service']
      group_wait: 30s
      group_interval: 5m
      repeat_interval: 4h
      routes:
        # Critical alerts go to PagerDuty
        - match:
            severity: critical
          receiver: pagerduty
          continue: true

        # Prometheus-specific alerts
        - match_re:
            alertname: 'Prometheus.*'
          receiver: prometheus-team
          group_by: ['alertname', 'instance']

        # Kubernetes-specific alerts
        - match_re:
            alertname: 'Kubernetes.*'
          receiver: kubernetes-team
          group_by: ['alertname', 'namespace']

    # Inhibition rules to reduce alert noise
    inhibit_rules:
      # Inhibit warning if critical is firing
      - source_match:
          severity: 'critical'
        target_match:
          severity: 'warning'
        equal: ['alertname', 'cluster', 'service']

      # Inhibit pod alerts if node is down
      - source_match:
          alertname: 'KubernetesNodeNotReady'
        target_match_re:
          alertname: 'KubernetesPod.*'
        equal: ['node']

    # Receivers configuration
    receivers:
      - name: 'default'
        slack_configs:
          - channel: '#alerts'
            title: 'Alert: {{ .GroupLabels.alertname }}'
            text: '{{ range .Alerts }}{{ .Annotations.description }}{{ end }}'
            send_resolved: true

      - name: 'pagerduty'
        pagerduty_configs:
          - service_key: 'YOUR_PAGERDUTY_KEY'
            description: '{{ .GroupLabels.alertname }}'
            details:
              firing: '{{ .Alerts.Firing | len }}'
              resolved: '{{ .Alerts.Resolved | len }}'

      - name: 'prometheus-team'
        email_configs:
          - to: 'prometheus-team@example.com'
            headers:
              subject: '[Prometheus] {{ .GroupLabels.alertname }}'
            html: '{{ template "email.html" . }}'
        slack_configs:
          - channel: '#prometheus-alerts'
            title: '[Prometheus] Alert'
            text: '{{ range .Alerts }}{{ .Annotations.description }}{{ end }}'

      - name: 'kubernetes-team'
        email_configs:
          - to: 'kubernetes-team@example.com'
            headers:
              subject: '[Kubernetes] {{ .GroupLabels.alertname }}'
        slack_configs:
          - channel: '#kubernetes-alerts'
            title: '[Kubernetes] Alert'
            text: '{{ range .Alerts }}{{ .Annotations.description }}{{ end }}'
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: alertmanager
  namespace: monitoring
  labels:
    app: alertmanager
spec:
  serviceName: alertmanager
  replicas: 3
  selector:
    matchLabels:
      app: alertmanager
  template:
    metadata:
      labels:
        app: alertmanager
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchExpressions:
                  - key: app
                    operator: In
                    values:
                      - alertmanager
              topologyKey: kubernetes.io/hostname
      containers:
        - name: alertmanager
          image: prom/alertmanager:v0.26.0
          args:
            - --config.file=/etc/alertmanager/alertmanager.yml
            - --storage.path=/alertmanager
            - --data.retention=120h
            - --cluster.listen-address=0.0.0.0:9094
            - --cluster.peer=alertmanager-0.alertmanager.monitoring.svc.cluster.local:9094
            - --cluster.peer=alertmanager-1.alertmanager.monitoring.svc.cluster.local:9094
            - --cluster.peer=alertmanager-2.alertmanager.monitoring.svc.cluster.local:9094
            - --cluster.reconnect-timeout=5m
            - --web.external-url=https://alertmanager.example.com
          ports:
            - name: web
              containerPort: 9093
            - name: mesh
              containerPort: 9094
          volumeMounts:
            - name: config
              mountPath: /etc/alertmanager
            - name: storage
              mountPath: /alertmanager
          resources:
            requests:
              memory: "256Mi"
              cpu: "100m"
            limits:
              memory: "512Mi"
              cpu: "200m"
          livenessProbe:
            httpGet:
              path: /-/healthy
              port: 9093
            initialDelaySeconds: 30
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /-/ready
              port: 9093
            initialDelaySeconds: 5
            periodSeconds: 5
      volumes:
        - name: config
          configMap:
            name: alertmanager-config
  volumeClaimTemplates:
    - metadata:
        name: storage
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: fast-ssd
        resources:
          requests:
            storage: 10Gi
---
apiVersion: v1
kind: Service
metadata:
  name: alertmanager
  namespace: monitoring
  labels:
    app: alertmanager
spec:
  type: ClusterIP
  clusterIP: None
  selector:
    app: alertmanager
  ports:
    - name: web
      port: 9093
      targetPort: 9093
    - name: mesh
      port: 9094
      targetPort: 9094
```

## Federation Setup

```yaml
# Global Prometheus for federation
apiVersion: v1
kind: ConfigMap
metadata:
  name: prometheus-global-config
  namespace: monitoring
data:
  prometheus.yml: |
    global:
      scrape_interval: 60s
      evaluation_interval: 60s
      external_labels:
        cluster: global
        datacenter: us-east

    # Federate from regional Prometheus instances
    scrape_configs:
      - job_name: 'federate-us-east-1'
        honor_labels: true
        metrics_path: '/federate'
        params:
          'match[]':
            # Aggregate metrics
            - '{job="kubernetes-apiservers"}'
            - '{job="kubernetes-nodes"}'
            - 'up{job=~".*"}'
            # Application metrics
            - '{__name__=~"http_requests_total|http_request_duration_seconds.*"}'
            # Resource usage
            - '{__name__=~"container_cpu_usage_seconds_total|container_memory_working_set_bytes"}'
        static_configs:
          - targets:
            - 'prometheus-us-east-1.monitoring.svc.cluster.local:9090'
            labels:
              region: us-east-1

      - job_name: 'federate-us-west-1'
        honor_labels: true
        metrics_path: '/federate'
        params:
          'match[]':
            - '{job="kubernetes-apiservers"}'
            - '{job="kubernetes-nodes"}'
            - 'up{job=~".*"}'
            - '{__name__=~"http_requests_total|http_request_duration_seconds.*"}'
            - '{__name__=~"container_cpu_usage_seconds_total|container_memory_working_set_bytes"}'
        static_configs:
          - targets:
            - 'prometheus-us-west-1.monitoring.svc.cluster.local:9090'
            labels:
              region: us-west-1
```

## Performance Tuning

### Query Performance Optimization

```yaml
# Thanos Query Frontend for caching
apiVersion: apps/v1
kind: Deployment
metadata:
  name: thanos-query-frontend
  namespace: monitoring
spec:
  replicas: 2
  selector:
    matchLabels:
      app: thanos-query-frontend
  template:
    metadata:
      labels:
        app: thanos-query-frontend
    spec:
      containers:
        - name: thanos-query-frontend
          image: quay.io/thanos/thanos:v0.32.5
          args:
            - query-frontend
            - --http-address=0.0.0.0:10902
            - --query-frontend.downstream-url=http://thanos-query.monitoring.svc.cluster.local:10902
            - --query-range.split-interval=24h
            - --query-range.max-retries-per-request=5
            - --query-frontend.log-queries-longer-than=10s
            - --cache-compression-type=snappy
            - |-
              --query-range.response-cache-config=
              type: MEMCACHED
              config:
                addresses:
                  - memcached:11211
                timeout: 500ms
                max_idle_connections: 100
                max_async_concurrency: 20
                max_async_buffer_size: 10000
                max_get_multi_concurrency: 100
                max_get_multi_batch_size: 0
          ports:
            - name: http
              containerPort: 10902
          resources:
            requests:
              memory: "512Mi"
              cpu: "250m"
            limits:
              memory: "1Gi"
              cpu: "500m"
---
# Memcached for query caching
apiVersion: apps/v1
kind: Deployment
metadata:
  name: memcached
  namespace: monitoring
spec:
  replicas: 3
  selector:
    matchLabels:
      app: memcached
  template:
    metadata:
      labels:
        app: memcached
    spec:
      containers:
        - name: memcached
          image: memcached:1.6-alpine
          args:
            - -m 4096
            - -c 16384
            - -t 4
            - -I 32m
          ports:
            - name: memcached
              containerPort: 11211
          resources:
            requests:
              memory: "4Gi"
              cpu: "500m"
            limits:
              memory: "4Gi"
              cpu: "1000m"
```

## Monitoring and Alerting

```promql
# Key metrics to monitor

# Prometheus up
up{job="prometheus"}

# Scrape duration
prometheus_target_interval_length_seconds{quantile="0.99"}

# TSDB metrics
prometheus_tsdb_head_samples_appended_total
prometheus_tsdb_compactions_total
prometheus_tsdb_wal_corruptions_total

# Rule evaluation
prometheus_rule_evaluation_duration_seconds
prometheus_rule_evaluation_failures_total

# Thanos metrics
thanos_sidecar_prometheus_up
thanos_compact_iterations_total
thanos_query_concurrent_selects_gate_queries_in_flight
```

## Best Practices

1. **Use external labels** for multi-cluster identification
2. **Implement tail-based sampling** for high-cardinality metrics
3. **Configure appropriate retention** based on storage capacity
4. **Use Thanos for long-term storage** and global queries
5. **Deploy Alertmanager in HA mode** with clustering
6. **Monitor Prometheus itself** with self-monitoring
7. **Use recording rules** to pre-compute expensive queries
8. **Implement proper RBAC** for security
9. **Configure resource limits** appropriately
10. **Use SSD storage** for better performance

## Conclusion

Deploying Prometheus in high availability mode with Thanos integration provides enterprise-grade monitoring infrastructure with global query capabilities, long-term storage, and robust alerting. The combination of multiple Prometheus replicas, Thanos components, and clustered Alertmanager ensures monitoring resilience while maintaining query performance at scale.