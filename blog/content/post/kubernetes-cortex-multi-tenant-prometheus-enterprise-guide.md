---
title: "Kubernetes Cortex Multi-Tenant Prometheus: Tenant Isolation, Query Frontend Sharding, Ruler, and Compactor"
date: 2032-02-13T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Cortex", "Prometheus", "Multi-Tenancy", "Observability", "Monitoring"]
categories:
- Kubernetes
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to running Cortex on Kubernetes with full tenant isolation, query frontend sharding, ruler configuration for multi-tenant alerting, and compactor tuning for long-term storage efficiency."
more_link: "yes"
url: "/kubernetes-cortex-multi-tenant-prometheus-enterprise-guide/"
---

Running Prometheus at enterprise scale means operating across dozens of teams, hundreds of services, and billions of active time series. Cortex solves this by providing horizontally scalable, multi-tenant Prometheus-as-a-service on top of object storage. This guide covers everything needed to deploy Cortex on Kubernetes in production: tenant isolation at the ingestion and query layers, query frontend sharding for query parallelism, ruler configuration for per-tenant alerting, and compactor tuning to keep long-term storage costs under control.

<!--more-->

# Kubernetes Cortex Multi-Tenant Prometheus: Enterprise Deployment Guide

## Section 1: Architecture Overview

Cortex decomposes a monolithic Prometheus server into microservices that can be scaled and deployed independently. Each component has a distinct role:

- **Distributor**: receives remote-write from Prometheus agents, validates samples, routes to ingesters
- **Ingester**: holds recent data in memory, flushes to object storage as blocks
- **Querier**: handles PromQL queries by federating across ingesters and store-gateway
- **Query Frontend**: queues and shards queries, sits in front of queriers
- **Ruler**: evaluates recording rules and alerting rules per tenant
- **Compactor**: merges and compacts Thanos-format blocks in object storage
- **Store Gateway**: serves queries against historical blocks in object storage
- **Alertmanager**: multi-tenant Alertmanager for routing alerts

```
Prometheus Agents ──remote-write──► Distributors ──► Ingesters ──► Object Storage
                                                                         │
Query Clients ──► Query Frontend ──► Queriers ──────────────────► Store Gateway
                                        │
                                     Ruler
                                     Compactor
```

The ring-based consistent hashing ensures each write and each query knows exactly which ingesters hold relevant data for a given tenant.

## Section 2: Namespace and RBAC Setup

All Cortex components run in a dedicated namespace. ServiceAccounts get the minimum required permissions.

```yaml
# namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: cortex
  labels:
    app.kubernetes.io/name: cortex
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/warn: restricted
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: cortex
  namespace: cortex
  annotations:
    eks.amazonaws.com/role-arn: "arn:aws:iam::<account-id>:role/cortex-s3-role"
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: cortex-ring-reader
  namespace: cortex
rules:
- apiGroups: [""]
  resources: ["configmaps"]
  verbs: ["get", "list", "watch", "create", "update", "patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: cortex-ring-reader
  namespace: cortex
subjects:
- kind: ServiceAccount
  name: cortex
  namespace: cortex
roleRef:
  kind: Role
  name: cortex-ring-reader
  apiGroup: rbac.authorization.k8s.io
```

## Section 3: Core Configuration

The Cortex configuration file controls every component. A single config file is mounted as a ConfigMap and all components share it (each reads only what it needs based on the `-target` flag).

```yaml
# cortex-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: cortex-config
  namespace: cortex
data:
  cortex.yaml: |
    # ── Authentication ──────────────────────────────────────────────
    auth_enabled: true

    # ── Server ──────────────────────────────────────────────────────
    server:
      http_listen_port: 8080
      grpc_listen_port: 9095
      log_level: info
      log_format: json
      grpc_server_max_recv_msg_size: 104857600   # 100 MiB
      grpc_server_max_send_msg_size: 104857600

    # ── Distributor ─────────────────────────────────────────────────
    distributor:
      ring:
        kvstore:
          store: memberlist
      pool:
        health_check_ingesters: true
      ha_tracker:
        enable_ha_tracker: true
        kvstore:
          store: memberlist
          prefix: "ha-tracker/"

    # ── Ingester ────────────────────────────────────────────────────
    ingester:
      lifecycler:
        ring:
          kvstore:
            store: memberlist
          replication_factor: 3
        num_tokens: 512
        heartbeat_period: 5s
        join_after: 10s
        observe_period: 10s
      chunk_idle_period: 1h
      max_chunk_age: 12h
      chunk_target_size: 1572864  # 1.5 MiB
      chunk_encoding: snappy

    # ── Querier ─────────────────────────────────────────────────────
    querier:
      query_ingesters_within: 13h
      max_concurrent: 20
      timeout: 2m
      iterators: true
      batch_iterators: true
      ingester_metadata_streaming: true

    # ── Query Frontend ───────────────────────────────────────────────
    frontend:
      log_queries_longer_than: 10s
      compress_responses: true
      max_outstanding_per_tenant: 200

    query_range:
      split_queries_by_interval: 24h
      align_queries_with_step: true
      cache_results: true
      results_cache:
        cache:
          memcached_client:
            addresses: "dns+memcached.cortex.svc.cluster.local:11211"
            max_idle_connections: 100
            timeout: 200ms
            max_item_size: 1048576

    # ── Ruler ────────────────────────────────────────────────────────
    ruler:
      enable_api: true
      enable_sharding: true
      ring:
        kvstore:
          store: memberlist
      storage:
        type: s3
        s3:
          bucket_name: <cortex-ruler-bucket>
          endpoint: s3.amazonaws.com
          region: us-east-1
      evaluation_interval: 1m
      poll_interval: 1m
      rule_path: /tmp/rules

    ruler_storage:
      backend: s3
      s3:
        bucket_name: <cortex-ruler-bucket>
        endpoint: s3.amazonaws.com
        region: us-east-1

    # ── Alertmanager ─────────────────────────────────────────────────
    alertmanager:
      enable_api: true
      sharding_enabled: true
      sharding_ring:
        kvstore:
          store: memberlist
      storage:
        type: s3
        s3:
          bucket_name: <cortex-alertmanager-bucket>
          endpoint: s3.amazonaws.com
          region: us-east-1
      fallback_config_file: /etc/cortex/alertmanager-fallback.yaml

    alertmanager_storage:
      backend: s3
      s3:
        bucket_name: <cortex-alertmanager-bucket>
        endpoint: s3.amazonaws.com
        region: us-east-1

    # ── Compactor ────────────────────────────────────────────────────
    compactor:
      data_dir: /data/compactor
      sharding_enabled: true
      sharding_ring:
        kvstore:
          store: memberlist
      block_ranges:
        - 2h
        - 12h
        - 24h
      consistency_delay: 30m
      deletion_delay: 12h
      cleanup_interval: 15m
      compaction_interval: 1h
      compaction_retries: 3

    # ── Store Gateway ────────────────────────────────────────────────
    store_gateway:
      sharding_enabled: true
      sharding_ring:
        kvstore:
          store: memberlist
        replication_factor: 3
      bucket_store:
        sync_dir: /data/store-gateway
        consistency_delay: 15m
        index_cache:
          backend: memcached
          memcached:
            addresses: "dns+memcached.cortex.svc.cluster.local:11211"
            max_item_size: 1048576
        chunks_cache:
          backend: memcached
          memcached:
            addresses: "dns+memcached.cortex.svc.cluster.local:11211"
        metadata_cache:
          backend: memcached
          memcached:
            addresses: "dns+memcached.cortex.svc.cluster.local:11211"

    # ── Blocks Storage ───────────────────────────────────────────────
    blocks_storage:
      backend: s3
      s3:
        bucket_name: <cortex-blocks-bucket>
        endpoint: s3.amazonaws.com
        region: us-east-1
      tsdb:
        dir: /data/tsdb
        block_ranges_period:
          - 2h
        retention_period: 0  # 0 = no retention, managed by compactor
        wal_compression_enabled: true
        head_compaction_interval: 1m
        stripe_size: 16384

    # ── Memberlist ───────────────────────────────────────────────────
    memberlist:
      join_members:
        - "cortex-memberlist.cortex.svc.cluster.local:7946"
      bind_port: 7946
      gossip_interval: 200ms
      gossip_nodes: 3
      push_pull_interval: 30s
      node_name: ""  # auto-set from pod name

    # ── Limits (default per-tenant) ──────────────────────────────────
    limits:
      ingestion_rate: 100000
      ingestion_burst_size: 200000
      max_label_names_per_series: 30
      max_label_value_length: 2048
      max_metadata_length: 1024
      max_global_series_per_user: 1500000
      max_global_series_per_metric: 100000
      max_global_metadata_per_user: 8000
      max_global_metadata_per_metric: 10
      out_of_order_time_window: 30m
      ruler_max_rules_per_rule_group: 100
      ruler_max_rule_groups_per_tenant: 50
      compactor_blocks_retention_period: 0  # 0 = no retention limit
      query_shards: 16
      store_gateway_tenant_shard_size: 0
```

## Section 4: Tenant Isolation

### Per-Tenant Rate Limiting and Quotas

Cortex supports runtime overrides that apply per-tenant without restarting the cluster. Store the overrides in a ConfigMap (or object storage) and configure the runtime-config loader.

```yaml
# runtime-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: cortex-runtime-config
  namespace: cortex
data:
  runtime-config.yaml: |
    overrides:
      # Team A: large-scale infrastructure monitoring
      team-a:
        ingestion_rate: 500000
        ingestion_burst_size: 1000000
        max_global_series_per_user: 10000000
        max_global_series_per_metric: 500000
        compactor_blocks_retention_period: 1y
        query_shards: 32
        ruler_max_rule_groups_per_tenant: 200
        ruler_max_rules_per_rule_group: 200

      # Team B: small application team
      team-b:
        ingestion_rate: 10000
        ingestion_burst_size: 20000
        max_global_series_per_user: 100000
        max_global_series_per_metric: 5000
        compactor_blocks_retention_period: 90d
        query_shards: 4

      # Team C: security/compliance — long retention
      team-c:
        ingestion_rate: 50000
        ingestion_burst_size: 100000
        max_global_series_per_user: 500000
        compactor_blocks_retention_period: 2y
        query_shards: 16

      # Team D: ephemeral/CI workloads — short retention
      team-d:
        ingestion_rate: 20000
        ingestion_burst_size: 40000
        max_global_series_per_user: 200000
        compactor_blocks_retention_period: 7d
        query_shards: 8
```

Reference the runtime config in the main config:

```yaml
# add to cortex.yaml
runtime_config:
  file: /etc/cortex/runtime-config.yaml
  period: 30s
```

Mount both ConfigMaps into the pod:

```yaml
volumes:
- name: cortex-config
  configMap:
    name: cortex-config
- name: cortex-runtime-config
  configMap:
    name: cortex-runtime-config
volumeMounts:
- name: cortex-config
  mountPath: /etc/cortex/cortex.yaml
  subPath: cortex.yaml
- name: cortex-runtime-config
  mountPath: /etc/cortex/runtime-config.yaml
  subPath: runtime-config.yaml
```

### Tenant Authentication via Nginx Proxy

In front of Cortex, an Nginx proxy validates JWT tokens and injects the `X-Scope-OrgID` header that Cortex uses for tenancy.

```nginx
# nginx.conf snippet
upstream cortex_distributor {
    server cortex-distributor.cortex.svc.cluster.local:8080;
    keepalive 32;
}

upstream cortex_query_frontend {
    server cortex-query-frontend.cortex.svc.cluster.local:8080;
    keepalive 32;
}

server {
    listen 443 ssl;
    ssl_certificate     /etc/tls/tls.crt;
    ssl_certificate_key /etc/tls/tls.key;

    # Remote-write endpoint
    location /api/v1/push {
        auth_request /auth;
        auth_request_set $tenant_id $upstream_http_x_tenant_id;
        proxy_set_header X-Scope-OrgID $tenant_id;
        proxy_pass http://cortex_distributor;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
    }

    # Query endpoint
    location /api/v1/query {
        auth_request /auth;
        auth_request_set $tenant_id $upstream_http_x_tenant_id;
        proxy_set_header X-Scope-OrgID $tenant_id;
        proxy_pass http://cortex_query_frontend;
    }

    # Internal auth service
    location = /auth {
        internal;
        proxy_pass http://auth-service.cortex.svc.cluster.local:8080/verify;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header X-Original-URI $request_uri;
    }
}
```

## Section 5: Distributor Deployment

```yaml
# distributor-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cortex-distributor
  namespace: cortex
  labels:
    app: cortex
    component: distributor
spec:
  replicas: 3
  selector:
    matchLabels:
      app: cortex
      component: distributor
  template:
    metadata:
      labels:
        app: cortex
        component: distributor
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8080"
        prometheus.io/path: "/metrics"
    spec:
      serviceAccountName: cortex
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            component: distributor
      containers:
      - name: distributor
        image: quay.io/cortexproject/cortex:v1.17.0
        args:
        - -target=distributor
        - -config.file=/etc/cortex/cortex.yaml
        - -config.expand-env=true
        ports:
        - containerPort: 8080
          name: http
        - containerPort: 9095
          name: grpc
        - containerPort: 7946
          name: memberlist
        resources:
          requests:
            cpu: 500m
            memory: 512Mi
          limits:
            cpu: 2000m
            memory: 2Gi
        livenessProbe:
          httpGet:
            path: /ready
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 15
        readinessProbe:
          httpGet:
            path: /ready
            port: 8080
          initialDelaySeconds: 15
          periodSeconds: 5
        volumeMounts:
        - name: cortex-config
          mountPath: /etc/cortex/cortex.yaml
          subPath: cortex.yaml
        - name: cortex-runtime-config
          mountPath: /etc/cortex/runtime-config.yaml
          subPath: runtime-config.yaml
      volumes:
      - name: cortex-config
        configMap:
          name: cortex-config
      - name: cortex-runtime-config
        configMap:
          name: cortex-runtime-config
---
apiVersion: v1
kind: Service
metadata:
  name: cortex-distributor
  namespace: cortex
  labels:
    app: cortex
    component: distributor
spec:
  selector:
    app: cortex
    component: distributor
  ports:
  - name: http
    port: 8080
    targetPort: 8080
  - name: grpc
    port: 9095
    targetPort: 9095
```

## Section 6: Ingester StatefulSet

Ingesters require stable network identities (for ring registration) and persistent storage (for WAL replay after restart).

```yaml
# ingester-statefulset.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: cortex-ingester
  namespace: cortex
  labels:
    app: cortex
    component: ingester
spec:
  replicas: 6
  serviceName: cortex-ingester
  selector:
    matchLabels:
      app: cortex
      component: ingester
  podManagementPolicy: Parallel
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
  template:
    metadata:
      labels:
        app: cortex
        component: ingester
    spec:
      serviceAccountName: cortex
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchLabels:
                component: ingester
            topologyKey: kubernetes.io/hostname
      terminationGracePeriodSeconds: 240
      containers:
      - name: ingester
        image: quay.io/cortexproject/cortex:v1.17.0
        args:
        - -target=ingester
        - -config.file=/etc/cortex/cortex.yaml
        - -ingester.lifecycler.ID=$(POD_NAME)
        env:
        - name: POD_NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        ports:
        - containerPort: 8080
          name: http
        - containerPort: 9095
          name: grpc
        - containerPort: 7946
          name: memberlist
        resources:
          requests:
            cpu: 2000m
            memory: 8Gi
          limits:
            cpu: 4000m
            memory: 16Gi
        livenessProbe:
          httpGet:
            path: /ready
            port: 8080
          initialDelaySeconds: 60
          periodSeconds: 15
          failureThreshold: 10
        readinessProbe:
          httpGet:
            path: /ready
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 5
          failureThreshold: 5
        lifecycle:
          preStop:
            httpGet:
              path: /ingester/flush
              port: 8080
        volumeMounts:
        - name: cortex-config
          mountPath: /etc/cortex/cortex.yaml
          subPath: cortex.yaml
        - name: cortex-runtime-config
          mountPath: /etc/cortex/runtime-config.yaml
          subPath: runtime-config.yaml
        - name: data
          mountPath: /data
      volumes:
      - name: cortex-config
        configMap:
          name: cortex-config
      - name: cortex-runtime-config
        configMap:
          name: cortex-runtime-config
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: ["ReadWriteOnce"]
      storageClassName: gp3
      resources:
        requests:
          storage: 100Gi
---
apiVersion: v1
kind: Service
metadata:
  name: cortex-ingester
  namespace: cortex
spec:
  selector:
    app: cortex
    component: ingester
  clusterIP: None
  ports:
  - name: http
    port: 8080
  - name: grpc
    port: 9095
  - name: memberlist
    port: 7946
```

## Section 7: Query Frontend with Sharding

The query frontend queues requests and can shard PromQL range queries across multiple querier replicas. Sharding dramatically reduces query latency for long time-range queries.

```yaml
# query-frontend-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cortex-query-frontend
  namespace: cortex
  labels:
    app: cortex
    component: query-frontend
spec:
  replicas: 2
  selector:
    matchLabels:
      app: cortex
      component: query-frontend
  template:
    metadata:
      labels:
        app: cortex
        component: query-frontend
    spec:
      serviceAccountName: cortex
      containers:
      - name: query-frontend
        image: quay.io/cortexproject/cortex:v1.17.0
        args:
        - -target=query-frontend
        - -config.file=/etc/cortex/cortex.yaml
        - -query-frontend.downstream-url=http://cortex-querier.cortex.svc.cluster.local:8080
        ports:
        - containerPort: 8080
          name: http
        - containerPort: 9095
          name: grpc
        resources:
          requests:
            cpu: 500m
            memory: 512Mi
          limits:
            cpu: 2000m
            memory: 2Gi
        volumeMounts:
        - name: cortex-config
          mountPath: /etc/cortex/cortex.yaml
          subPath: cortex.yaml
        - name: cortex-runtime-config
          mountPath: /etc/cortex/runtime-config.yaml
          subPath: runtime-config.yaml
      volumes:
      - name: cortex-config
        configMap:
          name: cortex-config
      - name: cortex-runtime-config
        configMap:
          name: cortex-runtime-config
---
# query-scheduler-deployment.yaml
# The query scheduler decouples the queue from the frontend for better scalability
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cortex-query-scheduler
  namespace: cortex
  labels:
    app: cortex
    component: query-scheduler
spec:
  replicas: 2
  selector:
    matchLabels:
      app: cortex
      component: query-scheduler
  template:
    metadata:
      labels:
        app: cortex
        component: query-scheduler
    spec:
      serviceAccountName: cortex
      containers:
      - name: query-scheduler
        image: quay.io/cortexproject/cortex:v1.17.0
        args:
        - -target=query-scheduler
        - -config.file=/etc/cortex/cortex.yaml
        ports:
        - containerPort: 8080
          name: http
        - containerPort: 9095
          name: grpc
        resources:
          requests:
            cpu: 250m
            memory: 256Mi
          limits:
            cpu: 1000m
            memory: 1Gi
        volumeMounts:
        - name: cortex-config
          mountPath: /etc/cortex/cortex.yaml
          subPath: cortex.yaml
      volumes:
      - name: cortex-config
        configMap:
          name: cortex-config
```

Add to cortex.yaml to connect frontend to scheduler:

```yaml
frontend:
  scheduler_address: "cortex-query-scheduler.cortex.svc.cluster.local:9095"
  query_stats_enabled: true

querier:
  scheduler_address: "cortex-query-scheduler.cortex.svc.cluster.local:9095"
```

## Section 8: Ruler Configuration for Multi-Tenant Alerting

The ruler evaluates recording rules and alerting rules stored per-tenant in S3. Each tenant uploads their rules via the Cortex Ruler API.

```bash
# Upload rules for tenant team-a via the ruler API
CORTEX_ADDRESS="https://cortex.example.com"
TENANT_ID="team-a"

cat > /tmp/team-a-rules.yaml << 'EOF'
groups:
- name: slo.rules
  interval: 1m
  rules:
  - record: job:http_request_duration_seconds:p99
    expr: |
      histogram_quantile(0.99,
        sum by (job, le) (
          rate(http_request_duration_seconds_bucket[5m])
        )
      )
  - record: job:http_requests:rate5m
    expr: |
      sum by (job) (
        rate(http_requests_total[5m])
      )
  - alert: HighErrorRate
    expr: |
      (
        sum by (job) (rate(http_requests_total{status=~"5.."}[5m]))
        /
        sum by (job) (rate(http_requests_total[5m]))
      ) > 0.01
    for: 5m
    labels:
      severity: warning
      team: "{{ $labels.job }}"
    annotations:
      summary: "High error rate on {{ $labels.job }}"
      description: "Error rate is {{ $value | humanizePercentage }} for job {{ $labels.job }}"
  - alert: SLOBudgetBurnRate
    expr: |
      (
        1 - (
          sum by (job) (rate(http_requests_total{status!~"5.."}[1h]))
          /
          sum by (job) (rate(http_requests_total[1h]))
        )
      ) > (1 - 0.999) * 14.4
    for: 2m
    labels:
      severity: critical
    annotations:
      summary: "SLO burn rate too high for {{ $labels.job }}"
EOF

curl -X POST \
  -H "X-Scope-OrgID: ${TENANT_ID}" \
  -H "Content-Type: application/yaml" \
  --data-binary @/tmp/team-a-rules.yaml \
  "${CORTEX_ADDRESS}/api/v1/rules/slo"
```

Ruler StatefulSet for HA sharding:

```yaml
# ruler-statefulset.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: cortex-ruler
  namespace: cortex
  labels:
    app: cortex
    component: ruler
spec:
  replicas: 3
  serviceName: cortex-ruler
  selector:
    matchLabels:
      app: cortex
      component: ruler
  template:
    metadata:
      labels:
        app: cortex
        component: ruler
    spec:
      serviceAccountName: cortex
      containers:
      - name: ruler
        image: quay.io/cortexproject/cortex:v1.17.0
        args:
        - -target=ruler
        - -config.file=/etc/cortex/cortex.yaml
        - -ruler.ring.instance-id=$(POD_NAME)
        env:
        - name: POD_NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        ports:
        - containerPort: 8080
          name: http
        - containerPort: 9095
          name: grpc
        - containerPort: 7946
          name: memberlist
        resources:
          requests:
            cpu: 500m
            memory: 512Mi
          limits:
            cpu: 2000m
            memory: 2Gi
        volumeMounts:
        - name: cortex-config
          mountPath: /etc/cortex/cortex.yaml
          subPath: cortex.yaml
        - name: cortex-runtime-config
          mountPath: /etc/cortex/runtime-config.yaml
          subPath: runtime-config.yaml
        - name: rules-tmp
          mountPath: /tmp/rules
      volumes:
      - name: cortex-config
        configMap:
          name: cortex-config
      - name: cortex-runtime-config
        configMap:
          name: cortex-runtime-config
      - name: rules-tmp
        emptyDir: {}
```

## Section 9: Compactor Tuning

The compactor merges 2-hour TSDB blocks created by ingesters into larger blocks (12h, 24h) for storage efficiency. Proper tuning reduces S3 API costs and query latency.

```yaml
# compactor-statefulset.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: cortex-compactor
  namespace: cortex
  labels:
    app: cortex
    component: compactor
spec:
  replicas: 3
  serviceName: cortex-compactor
  selector:
    matchLabels:
      app: cortex
      component: compactor
  template:
    metadata:
      labels:
        app: cortex
        component: compactor
    spec:
      serviceAccountName: cortex
      containers:
      - name: compactor
        image: quay.io/cortexproject/cortex:v1.17.0
        args:
        - -target=compactor
        - -config.file=/etc/cortex/cortex.yaml
        - -compactor.ring.instance-id=$(POD_NAME)
        env:
        - name: POD_NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        ports:
        - containerPort: 8080
          name: http
        - containerPort: 9095
          name: grpc
        - containerPort: 7946
          name: memberlist
        resources:
          requests:
            cpu: 1000m
            memory: 4Gi
          limits:
            cpu: 4000m
            memory: 16Gi
        volumeMounts:
        - name: cortex-config
          mountPath: /etc/cortex/cortex.yaml
          subPath: cortex.yaml
        - name: data
          mountPath: /data/compactor
      volumes:
      - name: cortex-config
        configMap:
          name: cortex-config
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: ["ReadWriteOnce"]
      storageClassName: gp3
      resources:
        requests:
          storage: 500Gi
```

Key compactor parameters and their impact:

```yaml
compactor:
  # Block ranges define the compaction levels.
  # Cortex creates 2h blocks from ingesters.
  # The compactor merges: 2h→12h→24h
  block_ranges:
    - 2h    # level 0: raw ingester blocks
    - 12h   # level 1: first compaction
    - 24h   # level 2: final daily blocks

  # consistency_delay: wait this long before compacting a block
  # to ensure all ingesters have finished uploading
  consistency_delay: 30m

  # deletion_delay: keep blocks marked for deletion for this long
  # before actually removing them (allows recovery from mistakes)
  deletion_delay: 12h

  # compaction_interval: how often to run the compaction loop
  compaction_interval: 1h

  # max_compaction_time: cap a single compaction run
  # prevents runaway compaction that starves other tenants
  max_compaction_time: 1h

  # blocks_retention_period: delete blocks older than this per-tenant
  # 0 = no deletion. Override per-tenant in runtime config
  blocks_retention_period: 0

  # skip_blocks_with_out_of_order_chunks: do not compact blocks
  # that contain out-of-order chunks (Cortex 1.14+)
  skip_blocks_with_out_of_order_chunks: false
```

## Section 10: Memberlist Headless Service for Ring Discovery

All ring-based components (distributor, ingester, ruler, compactor, store-gateway) use memberlist gossip for ring membership. A headless Service provides DNS-based peer discovery.

```yaml
# memberlist-service.yaml
apiVersion: v1
kind: Service
metadata:
  name: cortex-memberlist
  namespace: cortex
  labels:
    app: cortex
spec:
  selector:
    app: cortex
  clusterIP: None
  ports:
  - name: memberlist
    port: 7946
    targetPort: 7946
    protocol: TCP
```

## Section 11: HorizontalPodAutoscaler for Query Components

```yaml
# hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: cortex-querier
  namespace: cortex
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: cortex-querier
  minReplicas: 3
  maxReplicas: 30
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 60
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 70
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 60
      policies:
      - type: Pods
        value: 4
        periodSeconds: 60
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
      - type: Pods
        value: 2
        periodSeconds: 120
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: cortex-distributor
  namespace: cortex
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: cortex-distributor
  minReplicas: 3
  maxReplicas: 20
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
```

## Section 12: Observability for Cortex Itself

Cortex exposes rich metrics. Key dashboards to build:

```promql
# Distributor: samples per second received
sum(rate(cortex_distributor_received_samples_total[5m])) by (tenant)

# Ingester: active series per tenant
sum(cortex_ingester_active_series) by (tenant)

# Query Frontend: query queue depth
sum(cortex_query_frontend_queue_length) by (tenant)

# Query Frontend: query duration P99 per tenant
histogram_quantile(0.99,
  sum by (tenant, le) (
    rate(cortex_query_frontend_query_seconds_bucket[5m])
  )
)

# Compactor: blocks compacted per hour
rate(cortex_compactor_blocks_marked_for_deletion_total[1h])

# Store Gateway: cache hit rate
sum(rate(cortex_bucket_store_series_data_fetched_total{data_type="chunk",data_fetched_from="cache"}[5m]))
/
sum(rate(cortex_bucket_store_series_data_fetched_total{data_type="chunk"}[5m]))

# Ruler: rule evaluation failures
sum(rate(cortex_prometheus_rule_evaluation_failures_total[5m])) by (tenant, rule_group)
```

## Section 13: Troubleshooting Common Issues

### Ingester Ring Unhealthy

When ingesters leave the ring ungracefully (e.g., OOMKill), their tokens remain in the ring as UNHEALTHY. Queries that require replication factor N cannot be satisfied.

```bash
# Check ring status
kubectl -n cortex port-forward svc/cortex-distributor 8080:8080 &
curl -s http://localhost:8080/ring | jq '.[] | select(.state != "ACTIVE")'

# Force-remove a stuck ingester from the ring
curl -X POST \
  "http://localhost:8080/ring?action=forget&id=cortex-ingester-3"
```

### Compactor Stuck on Large Tenant

If a tenant has millions of small blocks (common after prolonged out-of-order ingestion), the compactor may appear stuck. Check compactor logs for slow block listing:

```bash
kubectl -n cortex logs -l component=compactor --tail=200 | grep "compaction"

# Force a single-tenant compaction run for debugging
kubectl -n cortex exec -it cortex-compactor-0 -- \
  cortex \
    -target=compactor \
    -config.file=/etc/cortex/cortex.yaml \
    -compactor.tenant-shard-size=1 \
    -compactor.enabled-tenants=team-a
```

### Query Timeout Debugging

```bash
# Find slow queries in query-frontend logs
kubectl -n cortex logs -l component=query-frontend | \
  jq 'select(.msg == "query stats") | {tenant: .org_id, duration: .duration, query: .query}' | \
  sort -t: -k2 -nr | head -20

# Check per-tenant queue depth
curl -s http://localhost:8080/api/v1/admin/queue | jq '.[]'
```

### S3 Throttling on Compactor

When compaction runs at peak, S3 may throttle. Use exponential backoff and reduce parallelism:

```yaml
# In cortex.yaml
blocks_storage:
  s3:
    max_retries: 20
    sse:
      type: SSE-S3

compactor:
  max_opening_blocks_concurrency: 4
  max_closing_blocks_concurrency: 4
  symbols_flushers_concurrency: 4
```

## Section 14: Security Hardening

```yaml
# PodSecurityContext for all Cortex pods
securityContext:
  runAsNonRoot: true
  runAsUser: 10001
  runAsGroup: 10001
  fsGroup: 10001
  seccompProfile:
    type: RuntimeDefault

# Container SecurityContext
securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop:
    - ALL
```

NetworkPolicy to restrict inter-component traffic:

```yaml
# networkpolicy.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: cortex-allow-internal
  namespace: cortex
spec:
  podSelector:
    matchLabels:
      app: cortex
  policyTypes:
  - Ingress
  - Egress
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: cortex
    ports:
    - port: 8080
    - port: 9095
    - port: 7946
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: monitoring
    ports:
    - port: 8080
  egress:
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: cortex
  - to: []
    ports:
    - port: 443   # S3
    - port: 53    # DNS
    protocol: UDP
  - to: []
    ports:
    - port: 53
    protocol: TCP
```

## Summary

A production Cortex deployment on Kubernetes requires careful attention across all layers:

- **Tenant isolation** is enforced by the `X-Scope-OrgID` header and runtime overrides for per-tenant quotas and retention
- **Query frontend sharding** with a query scheduler decouples queue management and enables parallel execution of PromQL range queries
- **Ruler sharding** distributes rule evaluation across ruler replicas, preventing any single ruler from becoming a bottleneck for large tenants
- **Compactor tuning** — especially block ranges, consistency delay, and per-tenant retention — directly controls both S3 costs and query performance
- **Memberlist** provides lightweight gossip-based ring management without requiring etcd for every ring operation

The combination of these components gives teams a production-grade Prometheus-as-a-service platform that scales to tens of tenants and billions of active series.
