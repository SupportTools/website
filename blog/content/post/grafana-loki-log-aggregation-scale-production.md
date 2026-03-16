---
title: "Grafana Loki Log Aggregation at Scale: Production Architecture for Multi-Tenant Kubernetes"
date: 2026-07-26T00:00:00-05:00
draft: false
tags: ["Grafana Loki", "Log Aggregation", "Kubernetes", "Observability", "Monitoring", "Production", "Multi-Tenant"]
categories: ["Observability", "Logging", "Infrastructure"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to deploying Grafana Loki for log aggregation at enterprise scale with microservices mode, multi-tenancy, and S3 storage backend."
more_link: "yes"
url: "/grafana-loki-log-aggregation-scale-production/"
---

Centralized log aggregation is essential for troubleshooting and monitoring distributed systems, but traditional solutions like Elasticsearch can be resource-intensive and complex to operate. Grafana Loki provides a cost-effective, scalable alternative designed specifically for Kubernetes environments. This guide covers production-grade Loki deployment in microservices mode with multi-tenancy, object storage backends, and high-performance querying.

<!--more-->

# Grafana Loki Log Aggregation at Scale

## Executive Summary

Grafana Loki is a horizontally scalable, highly available log aggregation system inspired by Prometheus. Unlike other logging solutions, Loki indexes only metadata (labels) rather than full-text content, making it significantly more cost-effective at scale. This guide demonstrates deploying Loki in microservices mode for enterprise Kubernetes environments, implementing multi-tenancy, configuring retention policies, and optimizing query performance.

## Loki Architecture Overview

### Microservices Mode Components

```
┌─────────────┐
│  Distributor│◄──── Promtail / Fluent Bit
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  Ingester   │────► Object Storage (S3/GCS)
└──────┬──────┘
       │
       ▼
┌─────────────┐
│   Querier   │◄──── Grafana
└──────┬──────┘
       │
       ▼
┌─────────────┐
│Query Frontend│
└─────────────┘
       │
       ▼
┌─────────────┐
│  Compactor  │
└─────────────┘
```

### Components Explained

- **Distributor**: Validates and distributes incoming log streams
- **Ingester**: Writes log data to long-term storage
- **Querier**: Handles log queries
- **Query Frontend**: Query caching and splitting
- **Compactor**: Compacts and deduplicates index files
- **Ruler**: Evaluates LogQL recording and alerting rules

## Core Infrastructure Setup

### S3 Storage Backend Configuration

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: loki-s3-config
  namespace: logging
type: Opaque
stringData:
  s3.yaml: |
    s3:
      endpoint: s3.amazonaws.com
      bucketnames: loki-logs-prod
      region: us-east-1
      access_key_id: ${AWS_ACCESS_KEY_ID}
      secret_access_key: ${AWS_SECRET_ACCESS_KEY}
      s3forcepathstyle: false
      insecure: false
      http_config:
        idle_conn_timeout: 90s
        response_header_timeout: 0s
        insecure_skip_verify: false
```

### Loki Configuration

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: loki-config
  namespace: logging
data:
  config.yaml: |
    auth_enabled: true

    server:
      http_listen_port: 3100
      grpc_listen_port: 9095
      grpc_server_max_recv_msg_size: 104857600
      grpc_server_max_send_msg_size: 104857600
      log_level: info

    distributor:
      ring:
        kvstore:
          store: memberlist
        heartbeat_timeout: 1m

    memberlist:
      node_name: ${HOSTNAME}
      bind_port: 7946
      join_members:
        - loki-memberlist

    ingester:
      lifecycler:
        ring:
          kvstore:
            store: memberlist
          replication_factor: 3
          heartbeat_timeout: 10m
        num_tokens: 512
        heartbeat_period: 5s
        join_after: 30s
        observe_period: 30s
        final_sleep: 30s

      chunk_idle_period: 1h
      chunk_block_size: 262144
      chunk_retain_period: 1m
      max_chunk_age: 2h

      wal:
        enabled: true
        dir: /loki/wal
        replay_memory_ceiling: 4GB
        checkpoint_duration: 10m
        flush_on_shutdown: true

    querier:
      max_concurrent: 20
      query_timeout: 5m
      query_ingesters_within: 3h
      engine:
        timeout: 5m
        max_look_back_period: 720h

    query_frontend:
      max_outstanding_per_tenant: 2048
      compress_responses: true
      log_queries_longer_than: 10s
      downstream_url: http://loki-querier:3100

    query_range:
      align_queries_with_step: true
      max_retries: 5
      parallelise_shardable_queries: true
      cache_results: true
      results_cache:
        cache:
          memcached_client:
            consistent_hash: true
            host: memcached-frontend.logging.svc.cluster.local
            service: memcached
            timeout: 500ms
            max_idle_conns: 100

    query_scheduler:
      max_outstanding_requests_per_tenant: 256

    ruler:
      enable_api: true
      enable_alertmanager_v2: true
      alertmanager_url: http://alertmanager.monitoring.svc.cluster.local:9093
      ring:
        kvstore:
          store: memberlist
      rule_path: /loki/rules
      storage:
        type: s3
        s3:
          bucketnames: loki-ruler-prod
          endpoint: s3.amazonaws.com
          region: us-east-1

    compactor:
      working_directory: /loki/compactor
      shared_store: s3
      compaction_interval: 10m
      retention_enabled: true
      retention_delete_delay: 2h
      retention_delete_worker_count: 150

    schema_config:
      configs:
        # Schema v11 (current)
        - from: 2024-01-01
          store: boltdb-shipper
          object_store: s3
          schema: v11
          index:
            prefix: loki_index_
            period: 24h
        # Schema v12 (future)
        - from: 2025-01-01
          store: tsdb
          object_store: s3
          schema: v12
          index:
            prefix: loki_tsdb_index_
            period: 24h

    storage_config:
      boltdb_shipper:
        active_index_directory: /loki/index
        cache_location: /loki/index-cache
        cache_ttl: 24h
        shared_store: s3
        index_gateway_client:
          server_address: dns:///loki-index-gateway:9095

      tsdb_shipper:
        active_index_directory: /loki/tsdb-index
        cache_location: /loki/tsdb-cache
        cache_ttl: 24h
        shared_store: s3
        index_gateway_client:
          server_address: dns:///loki-index-gateway:9095

      aws:
        bucketnames: loki-chunks-prod
        region: us-east-1
        s3forcepathstyle: false

    chunk_store_config:
      max_look_back_period: 720h
      chunk_cache_config:
        memcached_client:
          consistent_hash: true
          host: memcached-chunks.logging.svc.cluster.local
          service: memcached
          timeout: 500ms
          max_idle_conns: 100

      write_dedupe_cache_config:
        memcached_client:
          consistent_hash: true
          host: memcached-chunks.logging.svc.cluster.local
          service: memcached
          timeout: 500ms
          max_idle_conns: 100

    limits_config:
      # Ingestion limits
      ingestion_rate_strategy: global
      ingestion_rate_mb: 50
      ingestion_burst_size_mb: 100
      max_streams_per_user: 0
      max_global_streams_per_user: 100000

      # Query limits
      max_query_length: 721h
      max_query_parallelism: 32
      max_query_series: 10000
      max_entries_limit_per_query: 10000
      max_cache_freshness_per_query: 10m

      # Cardinality limits
      max_label_name_length: 1024
      max_label_value_length: 2048
      max_label_names_per_series: 30

      # Retention
      retention_period: 720h

      # Per-tenant overrides
      per_tenant_override_config: /etc/loki/overrides.yaml

    table_manager:
      retention_deletes_enabled: true
      retention_period: 720h

    frontend:
      compress_responses: true
      max_outstanding_per_tenant: 256
      log_queries_longer_than: 10s

    frontend_worker:
      frontend_address: loki-query-frontend:9095
      grpc_client_config:
        max_send_msg_size: 104857600
      parallelism: 10
      match_max_concurrent: true
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: loki-overrides
  namespace: logging
data:
  overrides.yaml: |
    overrides:
      # Production tenant with higher limits
      prod:
        ingestion_rate_mb: 100
        ingestion_burst_size_mb: 200
        max_global_streams_per_user: 200000
        max_query_parallelism: 64
        retention_period: 2160h  # 90 days

      # Development tenant with standard limits
      dev:
        ingestion_rate_mb: 10
        ingestion_burst_size_mb: 20
        max_global_streams_per_user: 50000
        max_query_parallelism: 16
        retention_period: 168h  # 7 days

      # Critical services with extended retention
      critical:
        ingestion_rate_mb: 200
        ingestion_burst_size_mb: 400
        max_global_streams_per_user: 300000
        max_query_parallelism: 128
        retention_period: 8760h  # 1 year
```

## Deploying Loki Components

### Distributor Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: loki-distributor
  namespace: logging
  labels:
    app: loki
    component: distributor
spec:
  replicas: 3
  selector:
    matchLabels:
      app: loki
      component: distributor
  template:
    metadata:
      labels:
        app: loki
        component: distributor
        loki-gossip-member: "true"
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "3100"
    spec:
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchExpressions:
                    - key: component
                      operator: In
                      values:
                        - distributor
                topologyKey: kubernetes.io/hostname
      containers:
        - name: distributor
          image: grafana/loki:2.9.3
          args:
            - -config.file=/etc/loki/config.yaml
            - -target=distributor
            - -config.expand-env=true
          env:
            - name: HOSTNAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
          ports:
            - name: http
              containerPort: 3100
            - name: grpc
              containerPort: 9095
            - name: gossip
              containerPort: 7946
          volumeMounts:
            - name: config
              mountPath: /etc/loki
            - name: overrides
              mountPath: /etc/loki/overrides.yaml
              subPath: overrides.yaml
          resources:
            requests:
              memory: "512Mi"
              cpu: "500m"
            limits:
              memory: "1Gi"
              cpu: "1000m"
          livenessProbe:
            httpGet:
              path: /ready
              port: 3100
            initialDelaySeconds: 45
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /ready
              port: 3100
            initialDelaySeconds: 30
            periodSeconds: 5
      volumes:
        - name: config
          configMap:
            name: loki-config
        - name: overrides
          configMap:
            name: loki-overrides
---
apiVersion: v1
kind: Service
metadata:
  name: loki-distributor
  namespace: logging
  labels:
    app: loki
    component: distributor
spec:
  type: ClusterIP
  selector:
    app: loki
    component: distributor
  ports:
    - name: http
      port: 3100
      targetPort: 3100
    - name: grpc
      port: 9095
      targetPort: 9095
```

### Ingester StatefulSet

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: loki-ingester
  namespace: logging
  labels:
    app: loki
    component: ingester
spec:
  serviceName: loki-ingester
  replicas: 3
  podManagementPolicy: Parallel
  selector:
    matchLabels:
      app: loki
      component: ingester
  template:
    metadata:
      labels:
        app: loki
        component: ingester
        loki-gossip-member: "true"
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "3100"
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchExpressions:
                  - key: component
                    operator: In
                    values:
                      - ingester
              topologyKey: kubernetes.io/hostname
      securityContext:
        fsGroup: 10001
        runAsNonRoot: true
        runAsUser: 10001
      containers:
        - name: ingester
          image: grafana/loki:2.9.3
          args:
            - -config.file=/etc/loki/config.yaml
            - -target=ingester
            - -config.expand-env=true
          env:
            - name: HOSTNAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
            - name: AWS_ACCESS_KEY_ID
              valueFrom:
                secretKeyRef:
                  name: loki-s3-credentials
                  key: AWS_ACCESS_KEY_ID
            - name: AWS_SECRET_ACCESS_KEY
              valueFrom:
                secretKeyRef:
                  name: loki-s3-credentials
                  key: AWS_SECRET_ACCESS_KEY
          ports:
            - name: http
              containerPort: 3100
            - name: grpc
              containerPort: 9095
            - name: gossip
              containerPort: 7946
          volumeMounts:
            - name: config
              mountPath: /etc/loki
            - name: overrides
              mountPath: /etc/loki/overrides.yaml
              subPath: overrides.yaml
            - name: data
              mountPath: /loki
          resources:
            requests:
              memory: "4Gi"
              cpu: "2000m"
            limits:
              memory: "8Gi"
              cpu: "4000m"
          livenessProbe:
            httpGet:
              path: /ready
              port: 3100
            initialDelaySeconds: 60
            periodSeconds: 10
            timeoutSeconds: 5
          readinessProbe:
            httpGet:
              path: /ready
              port: 3100
            initialDelaySeconds: 45
            periodSeconds: 5
            timeoutSeconds: 5
      volumes:
        - name: config
          configMap:
            name: loki-config
        - name: overrides
          configMap:
            name: loki-overrides
  volumeClaimTemplates:
    - metadata:
        name: data
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
  name: loki-ingester
  namespace: logging
  labels:
    app: loki
    component: ingester
spec:
  type: ClusterIP
  clusterIP: None
  selector:
    app: loki
    component: ingester
  ports:
    - name: http
      port: 3100
      targetPort: 3100
    - name: grpc
      port: 9095
      targetPort: 9095
```

### Querier Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: loki-querier
  namespace: logging
  labels:
    app: loki
    component: querier
spec:
  replicas: 3
  selector:
    matchLabels:
      app: loki
      component: querier
  template:
    metadata:
      labels:
        app: loki
        component: querier
        loki-gossip-member: "true"
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "3100"
    spec:
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchExpressions:
                    - key: component
                      operator: In
                      values:
                        - querier
                topologyKey: kubernetes.io/hostname
      containers:
        - name: querier
          image: grafana/loki:2.9.3
          args:
            - -config.file=/etc/loki/config.yaml
            - -target=querier
            - -config.expand-env=true
          env:
            - name: HOSTNAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
            - name: AWS_ACCESS_KEY_ID
              valueFrom:
                secretKeyRef:
                  name: loki-s3-credentials
                  key: AWS_ACCESS_KEY_ID
            - name: AWS_SECRET_ACCESS_KEY
              valueFrom:
                secretKeyRef:
                  name: loki-s3-credentials
                  key: AWS_SECRET_ACCESS_KEY
          ports:
            - name: http
              containerPort: 3100
            - name: grpc
              containerPort: 9095
            - name: gossip
              containerPort: 7946
          volumeMounts:
            - name: config
              mountPath: /etc/loki
            - name: overrides
              mountPath: /etc/loki/overrides.yaml
              subPath: overrides.yaml
            - name: cache
              mountPath: /loki
          resources:
            requests:
              memory: "2Gi"
              cpu: "1000m"
            limits:
              memory: "4Gi"
              cpu: "2000m"
          livenessProbe:
            httpGet:
              path: /ready
              port: 3100
            initialDelaySeconds: 45
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /ready
              port: 3100
            initialDelaySeconds: 30
            periodSeconds: 5
      volumes:
        - name: config
          configMap:
            name: loki-config
        - name: overrides
          configMap:
            name: loki-overrides
        - name: cache
          emptyDir: {}
---
apiVersion: v1
kind: Service
metadata:
  name: loki-querier
  namespace: logging
  labels:
    app: loki
    component: querier
spec:
  type: ClusterIP
  selector:
    app: loki
    component: querier
  ports:
    - name: http
      port: 3100
      targetPort: 3100
    - name: grpc
      port: 9095
      targetPort: 9095
```

### Query Frontend Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: loki-query-frontend
  namespace: logging
  labels:
    app: loki
    component: query-frontend
spec:
  replicas: 2
  selector:
    matchLabels:
      app: loki
      component: query-frontend
  template:
    metadata:
      labels:
        app: loki
        component: query-frontend
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "3100"
    spec:
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchExpressions:
                    - key: component
                      operator: In
                      values:
                        - query-frontend
                topologyKey: kubernetes.io/hostname
      containers:
        - name: query-frontend
          image: grafana/loki:2.9.3
          args:
            - -config.file=/etc/loki/config.yaml
            - -target=query-frontend
            - -config.expand-env=true
          env:
            - name: HOSTNAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
          ports:
            - name: http
              containerPort: 3100
            - name: grpc
              containerPort: 9095
          volumeMounts:
            - name: config
              mountPath: /etc/loki
            - name: overrides
              mountPath: /etc/loki/overrides.yaml
              subPath: overrides.yaml
          resources:
            requests:
              memory: "512Mi"
              cpu: "250m"
            limits:
              memory: "1Gi"
              cpu: "500m"
          livenessProbe:
            httpGet:
              path: /ready
              port: 3100
            initialDelaySeconds: 30
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /ready
              port: 3100
            initialDelaySeconds: 15
            periodSeconds: 5
      volumes:
        - name: config
          configMap:
            name: loki-config
        - name: overrides
          configMap:
            name: loki-overrides
---
apiVersion: v1
kind: Service
metadata:
  name: loki-query-frontend
  namespace: logging
  labels:
    app: loki
    component: query-frontend
spec:
  type: LoadBalancer
  selector:
    app: loki
    component: query-frontend
  ports:
    - name: http
      port: 3100
      targetPort: 3100
    - name: grpc
      port: 9095
      targetPort: 9095
```

### Compactor StatefulSet

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: loki-compactor
  namespace: logging
  labels:
    app: loki
    component: compactor
spec:
  serviceName: loki-compactor
  replicas: 1
  selector:
    matchLabels:
      app: loki
      component: compactor
  template:
    metadata:
      labels:
        app: loki
        component: compactor
        loki-gossip-member: "true"
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "3100"
    spec:
      securityContext:
        fsGroup: 10001
        runAsNonRoot: true
        runAsUser: 10001
      containers:
        - name: compactor
          image: grafana/loki:2.9.3
          args:
            - -config.file=/etc/loki/config.yaml
            - -target=compactor
            - -config.expand-env=true
          env:
            - name: HOSTNAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
            - name: AWS_ACCESS_KEY_ID
              valueFrom:
                secretKeyRef:
                  name: loki-s3-credentials
                  key: AWS_ACCESS_KEY_ID
            - name: AWS_SECRET_ACCESS_KEY
              valueFrom:
                secretKeyRef:
                  name: loki-s3-credentials
                  key: AWS_SECRET_ACCESS_KEY
          ports:
            - name: http
              containerPort: 3100
            - name: grpc
              containerPort: 9095
            - name: gossip
              containerPort: 7946
          volumeMounts:
            - name: config
              mountPath: /etc/loki
            - name: overrides
              mountPath: /etc/loki/overrides.yaml
              subPath: overrides.yaml
            - name: data
              mountPath: /loki
          resources:
            requests:
              memory: "2Gi"
              cpu: "1000m"
            limits:
              memory: "4Gi"
              cpu: "2000m"
          livenessProbe:
            httpGet:
              path: /ready
              port: 3100
            initialDelaySeconds: 60
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /ready
              port: 3100
            initialDelaySeconds: 45
            periodSeconds: 5
      volumes:
        - name: config
          configMap:
            name: loki-config
        - name: overrides
          configMap:
            name: loki-overrides
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: fast-ssd
        resources:
          requests:
            storage: 50Gi
```

### Memberlist Service

```yaml
apiVersion: v1
kind: Service
metadata:
  name: loki-memberlist
  namespace: logging
  labels:
    app: loki
spec:
  type: ClusterIP
  clusterIP: None
  publishNotReadyAddresses: true
  selector:
    loki-gossip-member: "true"
  ports:
    - name: gossip
      port: 7946
      targetPort: 7946
      protocol: TCP
```

## Log Shippers Configuration

### Promtail DaemonSet

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: promtail-config
  namespace: logging
data:
  promtail.yaml: |
    server:
      http_listen_port: 9080
      grpc_listen_port: 0
      log_level: info

    positions:
      filename: /run/promtail/positions.yaml

    clients:
      - url: http://loki-distributor.logging.svc.cluster.local:3100/loki/api/v1/push
        tenant_id: prod
        batchwait: 1s
        batchsize: 1048576
        timeout: 10s
        backoff_config:
          min_period: 500ms
          max_period: 5m
          max_retries: 10
        external_labels:
          cluster: production
          datacenter: us-east-1

    scrape_configs:
      # Kubernetes pods
      - job_name: kubernetes-pods
        pipeline_stages:
          # Extract pod metadata
          - cri: {}
          # Parse JSON logs
          - json:
              expressions:
                level: level
                msg: message
                timestamp: timestamp
          # Extract level
          - labels:
              level:
          # Drop debug logs
          - drop:
              source: level
              expression: "debug"
        kubernetes_sd_configs:
          - role: pod
        relabel_configs:
          # Only scrape pods with correct annotation
          - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape_logs]
            action: keep
            regex: true
          # Add namespace label
          - source_labels: [__meta_kubernetes_namespace]
            target_label: namespace
          # Add pod name label
          - source_labels: [__meta_kubernetes_pod_name]
            target_label: pod
          # Add container name label
          - source_labels: [__meta_kubernetes_pod_container_name]
            target_label: container
          # Add app label
          - source_labels: [__meta_kubernetes_pod_label_app]
            target_label: app
          # Add job label from app label
          - source_labels: [__meta_kubernetes_pod_label_app]
            target_label: job
          # Add node name label
          - source_labels: [__meta_kubernetes_pod_node_name]
            target_label: node
          # Set path to container logs
          - source_labels: [__meta_kubernetes_pod_uid, __meta_kubernetes_pod_container_name]
            target_label: __path__
            separator: /
            replacement: /var/log/pods/*$1/*.log

      # System logs
      - job_name: system
        static_configs:
          - targets:
              - localhost
            labels:
              job: system
              __path__: /var/log/*.log

      # Kubernetes audit logs
      - job_name: kubernetes-audit
        static_configs:
          - targets:
              - localhost
            labels:
              job: kubernetes-audit
              __path__: /var/log/kubernetes/audit/*.log
        pipeline_stages:
          - json:
              expressions:
                verb: verb
                user: user.username
                resource: objectRef.resource
          - labels:
              verb:
              user:
              resource:
---
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: promtail
  namespace: logging
  labels:
    app: promtail
spec:
  selector:
    matchLabels:
      app: promtail
  template:
    metadata:
      labels:
        app: promtail
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9080"
    spec:
      serviceAccountName: promtail
      containers:
        - name: promtail
          image: grafana/promtail:2.9.3
          args:
            - -config.file=/etc/promtail/promtail.yaml
          env:
            - name: HOSTNAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
          ports:
            - name: http
              containerPort: 9080
          volumeMounts:
            - name: config
              mountPath: /etc/promtail
            - name: positions
              mountPath: /run/promtail
            - name: varlog
              mountPath: /var/log
              readOnly: true
            - name: varlibdockercontainers
              mountPath: /var/lib/docker/containers
              readOnly: true
          resources:
            requests:
              memory: "128Mi"
              cpu: "100m"
            limits:
              memory: "256Mi"
              cpu: "200m"
          securityContext:
            privileged: true
            runAsUser: 0
      volumes:
        - name: config
          configMap:
            name: promtail-config
        - name: positions
          hostPath:
            path: /var/lib/promtail
            type: DirectoryOrCreate
        - name: varlog
          hostPath:
            path: /var/log
        - name: varlibdockercontainers
          hostPath:
            path: /var/lib/docker/containers
      tolerations:
        - effect: NoSchedule
          operator: Exists
```

## Grafana Integration

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-datasources
  namespace: logging
data:
  loki.yaml: |
    apiVersion: 1
    datasources:
      - name: Loki
        type: loki
        access: proxy
        url: http://loki-query-frontend.logging.svc.cluster.local:3100
        jsonData:
          maxLines: 1000
          derivedFields:
            # Extract trace ID from logs
            - datasourceUid: tempo
              matcherRegex: "traceID=(\\w+)"
              name: TraceID
              url: "$${__value.raw}"
            # Extract request ID
            - matcherRegex: "requestID=(\\w+)"
              name: RequestID
              url: "/explore?left={\"queries\":[{\"expr\":\"{job=\\\"nginx\\\"} |= \\\"$${__value.raw}\\\"\"}]}"
```

## LogQL Query Examples

```logql
# Show all logs for a specific pod
{namespace="production", pod="api-server-xyz"}

# Filter by log level
{namespace="production"} |= "level=error"

# JSON parsing and filtering
{app="api-server"} | json | level="error" | line_format "{{.timestamp}} {{.message}}"

# Rate queries
sum(rate({namespace="production"}[5m])) by (pod)

# Top 10 error-prone pods
topk(10, sum(rate({namespace="production"} |= "error" [5m])) by (pod))

# Latency analysis
quantile_over_time(0.99, {app="api"} | json | __error__="" | unwrap duration [5m]) by (endpoint)

# Log pattern detection
{namespace="production"} |= "error" | pattern "<_> error: <error_msg>"

# Multi-line log parsing
{app="java-app"} | multiline "^\\d{4}-\\d{2}-\\d{2}" firstline ^\\d{4}

# Label formatting
{app="nginx"} | json | line_format "{{.method}} {{.path}} {{.status}} {{.duration}}ms"
```

## Performance Optimization

### Memcached for Caching

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: memcached-frontend
  namespace: logging
spec:
  serviceName: memcached-frontend
  replicas: 3
  selector:
    matchLabels:
      app: memcached
      component: frontend
  template:
    metadata:
      labels:
        app: memcached
        component: frontend
    spec:
      containers:
        - name: memcached
          image: memcached:1.6-alpine
          args:
            - -m 2048
            - -c 1024
            - -I 32m
            - -t 4
          ports:
            - name: memcached
              containerPort: 11211
          resources:
            requests:
              memory: "2Gi"
              cpu: "500m"
            limits:
              memory: "2Gi"
              cpu: "1000m"
---
apiVersion: v1
kind: Service
metadata:
  name: memcached-frontend
  namespace: logging
spec:
  type: ClusterIP
  clusterIP: None
  selector:
    app: memcached
    component: frontend
  ports:
    - port: 11211
      targetPort: 11211
```

## Monitoring and Alerting

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: loki-rules
  namespace: logging
data:
  alerts.yaml: |
    groups:
      - name: loki_alerts
        interval: 30s
        rules:
          # High error rate
          - alert: HighErrorRate
            expr: |
              sum(rate({namespace="production"} |= "error" [5m])) by (namespace, app)
              > 10
            for: 5m
            labels:
              severity: warning
            annotations:
              summary: "High error rate detected"
              description: "{{ $labels.app }} in {{ $labels.namespace }} has error rate of {{ $value }} errors/sec"

          # Ingester not ready
          - alert: LokiIngesterNotReady
            expr: |
              kube_pod_container_status_ready{namespace="logging",container="ingester"} == 0
            for: 5m
            labels:
              severity: critical
            annotations:
              summary: "Loki ingester not ready"

          # Request failures
          - alert: LokiRequestErrors
            expr: |
              sum(rate(loki_request_duration_seconds_count{status_code=~"5.."}[5m])) by (job, route)
              / sum(rate(loki_request_duration_seconds_count[5m])) by (job, route)
              > 0.05
            for: 15m
            labels:
              severity: warning
```

## Best Practices

1. **Use appropriate cardinality** - limit label values
2. **Implement tenant isolation** with multi-tenancy
3. **Configure proper retention** based on compliance needs
4. **Use structured logging** for better parsing
5. **Enable caching** for query performance
6. **Monitor Loki metrics** for health
7. **Use LogQL patterns** for efficient queries
8. **Implement rate limiting** per tenant
9. **Configure index caching** for faster queries
10. **Regular compaction** for storage efficiency

## Conclusion

Grafana Loki provides a cost-effective, scalable solution for log aggregation in Kubernetes environments. By deploying in microservices mode with proper multi-tenancy, caching, and retention policies, organizations can achieve enterprise-grade log management while minimizing infrastructure costs and operational complexity.