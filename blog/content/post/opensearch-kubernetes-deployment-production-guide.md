---
title: "OpenSearch on Kubernetes: Production Deployment with the OpenSearch Operator"
date: 2027-01-20T00:00:00-05:00
draft: false
tags: ["Kubernetes", "OpenSearch", "Elasticsearch", "Logging", "Search"]
categories: ["Kubernetes", "Observability", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide for deploying OpenSearch on Kubernetes using the OpenSearch Operator. Covers cluster roles, ISM policies, TLS with cert-manager, security plugin RBAC, JVM tuning, S3 snapshots, rolling upgrades, and Prometheus monitoring."
more_link: "yes"
url: "/opensearch-kubernetes-deployment-production-guide/"
---

OpenSearch, the AWS-sponsored fork of Elasticsearch 7.10, has become the default choice for teams that need an open-source distributed search and log analytics engine without commercial licensing constraints. Running OpenSearch on Kubernetes with the **OpenSearch Operator** replaces manual `StatefulSet` management with a declarative `OpenSearchCluster` CRD that handles node role assignment, rolling upgrades, TLS bootstrapping, and inter-node coordination. This guide covers every production concern from cluster sizing through ISM index lifecycle, security plugin configuration, and operational runbooks.

<!--more-->

## Executive Summary

The **OpenSearch Operator** (maintained by the OpenSearch community and Aiven) watches `OpenSearchCluster` custom resources and reconciles the cluster toward the declared state: creating StatefulSets per node role group, managing certificates via cert-manager integration, and handling rolling upgrades with controlled shard reallocation. A production cluster separates nodes into dedicated roles — **master** (cluster state), **data** (shards), **ingest** (pipeline processing), and optionally **coordinating** (scatter-gather query routing) — to allow independent scaling of each tier. This guide builds a 3-master, 6-data, 2-ingest topology as the baseline and layers ISM policies, SAML authentication, S3 snapshots, and Prometheus metrics on top.

## OpenSearch Architecture on Kubernetes

### Node Roles

```
              ┌────────────────────────────────────────┐
  Clients ──► │        Coordinating Nodes (2)          │
              │    Query scatter-gather, no data        │
              └───────────────┬────────────────────────┘
                              │
              ┌───────────────▼────────────────────────┐
              │          Data Nodes (6)                 │
              │   Shards, indices, search execution     │
              └───────────────┬────────────────────────┘
                              │ cluster state
              ┌───────────────▼────────────────────────┐
              │        Master Nodes (3)                 │
              │    Cluster state, routing table         │
              └────────────────────────────────────────┘
              ┌────────────────────────────────────────┐
              │         Ingest Nodes (2)                │
              │    Pipeline processors, transforms      │
              └────────────────────────────────────────┘
```

### Sizing Guidelines

| Cluster Size | Masters | Data Nodes | Ingest | Coordinating |
|---|---|---|---|---|
| Small (dev/test) | 1 | 2 | 0 | 0 |
| Medium (< 1 TB) | 3 | 3 | 0 | 0 |
| Large (1–10 TB) | 3 | 6 | 2 | 2 |
| Very Large (> 10 TB) | 3 | 12+ | 4 | 4+ |

General rules:
- Master nodes: always 3 (quorum-safe) — never co-locate master and data on the same node for large clusters
- Data node heap: 50% of node RAM, never exceed 31 GB (off-heap compression threshold)
- Shard count: target 10–50 GB per shard; 20 shards per GB of heap maximum
- Replica shards: minimum 1 for production; 2 for critical indices

## Installing the OpenSearch Operator

```bash
#!/bin/bash
# install-opensearch-operator.sh

helm repo add opensearch-operator https://opensearch-project.github.io/opensearch-k8s-operator
helm repo update

helm upgrade --install opensearch-operator opensearch-operator/opensearch-operator \
  --namespace opensearch-system \
  --create-namespace \
  --version 2.6.1 \
  --set manager.resources.requests.cpu=100m \
  --set manager.resources.requests.memory=128Mi \
  --set manager.resources.limits.cpu=500m \
  --set manager.resources.limits.memory=256Mi \
  --wait
```

## OpenSearchCluster CRD — Production Topology

```yaml
# opensearch-cluster.yaml
apiVersion: opensearch.opster.io/v1
kind: OpenSearchCluster
metadata:
  name: production
  namespace: opensearch
spec:
  general:
    # Image version — pin to a specific patch release
    version: "2.13.0"
    httpPort: 9200
    serviceName: opensearch
    setVMMaxMapCount: true    # Sets vm.max_map_count=262144 via init container

    # Cluster-wide settings
    additionalConfig:
      cluster.routing.allocation.disk.watermark.low: "85%"
      cluster.routing.allocation.disk.watermark.high: "90%"
      cluster.routing.allocation.disk.watermark.flood_stage: "95%"
      indices.memory.index_buffer_size: "30%"
      action.auto_create_index: "false"

    # Extra JVM flags applied to all nodes
    additionalJVMOptions:
    - "-Djava.net.preferIPv4Stack=true"

  # TLS configuration via cert-manager
  security:
    config:
      adminCredentialsSecret:
        name: opensearch-admin-credentials
    tls:
      transport:
        generate: true      # Operator generates transport TLS via cert-manager
      http:
        generate: true      # Operator generates HTTP TLS
        certificates:
          secret: opensearch-http-tls   # Override with cert-manager-issued cert

  # Dashboards deployment
  dashboards:
    enable: true
    version: "2.13.0"
    replicas: 2
    resources:
      requests:
        cpu: 250m
        memory: 512Mi
      limits:
        cpu: 1000m
        memory: 1Gi
    service:
      type: ClusterIP
    tls:
      enable: true
      generate: true
    opensearchCredentialsSecret:
      name: opensearch-admin-credentials

  # Node pools — one StatefulSet per pool
  nodePools:

  # ── Master nodes ──
  - component: masters
    replicas: 3
    diskSize: "20Gi"   # Masters hold cluster state only; small disk
    resources:
      requests:
        cpu: 500m
        memory: 2Gi
      limits:
        cpu: 2000m
        memory: 4Gi
    jvm: "-Xmx1g -Xms1g"
    roles:
    - "cluster_manager"
    topologySpreadConstraints:
    - maxSkew: 1
      topologyKey: topology.kubernetes.io/zone
      whenUnsatisfiable: DoNotSchedule
      labelSelector:
        matchLabels:
          opster.io/opensearch-cluster: production
          opster.io/opensearch-nodepool: masters
    persistence:
      pvc:
        storageClass: gp3
        accessModes:
        - ReadWriteOnce
    affinity:
      podAntiAffinity:
        requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              opster.io/opensearch-nodepool: masters
          topologyKey: kubernetes.io/hostname

  # ── Data nodes ──
  - component: data
    replicas: 6
    diskSize: "500Gi"
    resources:
      requests:
        cpu: 2000m
        memory: 16Gi
      limits:
        cpu: 8000m
        memory: 32Gi
    jvm: "-Xmx15g -Xms15g"
    roles:
    - "data"
    topologySpreadConstraints:
    - maxSkew: 1
      topologyKey: topology.kubernetes.io/zone
      whenUnsatisfiable: DoNotSchedule
      labelSelector:
        matchLabels:
          opster.io/opensearch-cluster: production
          opster.io/opensearch-nodepool: data
    persistence:
      pvc:
        storageClass: gp3
        accessModes:
        - ReadWriteOnce
    additionalConfig:
      # Data nodes handle indexing and search — tune for write throughput
      index.search.slowlog.threshold.query.warn: "10s"
      index.search.slowlog.threshold.fetch.warn: "1s"
      index.indexing.slowlog.threshold.index.warn: "10s"

  # ── Ingest nodes ──
  - component: ingest
    replicas: 2
    diskSize: "20Gi"
    resources:
      requests:
        cpu: 1000m
        memory: 4Gi
      limits:
        cpu: 4000m
        memory: 8Gi
    jvm: "-Xmx3g -Xms3g"
    roles:
    - "ingest"
    affinity:
      podAntiAffinity:
        preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 100
          podAffinityTerm:
            labelSelector:
              matchLabels:
                opster.io/opensearch-nodepool: ingest
            topologyKey: kubernetes.io/hostname

  # ── Coordinating nodes (optional, for read-heavy clusters) ──
  - component: coordinating
    replicas: 2
    diskSize: "10Gi"
    resources:
      requests:
        cpu: 2000m
        memory: 8Gi
      limits:
        cpu: 8000m
        memory: 16Gi
    jvm: "-Xmx6g -Xms6g"
    roles: []    # Empty roles = coordinating only
```

## TLS Configuration with cert-manager

```yaml
# opensearch-tls.yaml
---
# Certificate for HTTP (REST API) access
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: opensearch-http
  namespace: opensearch
spec:
  secretName: opensearch-http-tls
  issuerRef:
    name: internal-ca-issuer
    kind: ClusterIssuer
  duration: 8760h    # 1 year
  renewBefore: 720h  # Renew 30 days before expiry
  subject:
    organizations:
    - platform-engineering
  dnsNames:
  - opensearch
  - opensearch.opensearch
  - opensearch.opensearch.svc
  - opensearch.opensearch.svc.cluster.local
  - "*.opensearch.opensearch.svc.cluster.local"
  usages:
  - server auth
  - client auth
---
# Certificate for inter-node transport encryption
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: opensearch-transport
  namespace: opensearch
spec:
  secretName: opensearch-transport-tls
  issuerRef:
    name: internal-ca-issuer
    kind: ClusterIssuer
  duration: 8760h
  renewBefore: 720h
  dnsNames:
  - "*.opensearch.opensearch.svc.cluster.local"
  usages:
  - server auth
  - client auth
```

## Security Plugin Configuration

### Internal Users and RBAC

The OpenSearch Security plugin (formerly Open Distro) manages internal users, roles, role mappings, and backend authentication.

```yaml
# security-config.yaml (mounted as a ConfigMap)
---
# _internal_users.yml
internal_users:
  admin:
    hash: "$2y$12$ExampleBcryptHashForDocumentation1234567890abcdefgh"
    reserved: true
    backend_roles:
    - "admin"
    description: "Admin user"

  logstash:
    hash: "$2y$12$ExampleBcryptHashForLogstash12345678901234567890abcd"
    reserved: false
    backend_roles:
    - "logstash"

  dashboards:
    hash: "$2y$12$ExampleBcryptHashForDashboards1234567890abcdefghijk"
    reserved: true
    backend_roles:
    - "dashboards_server"

  fluentd:
    hash: "$2y$12$ExampleBcryptHashForFluentd123456789012345678901234"
    reserved: false
    backend_roles:
    - "ingest"
---
# roles.yml
roles:
  log_reader:
    cluster_permissions:
    - "cluster:monitor/health"
    - "cluster:monitor/state"
    index_permissions:
    - index_patterns:
      - "logs-*"
      - "metrics-*"
      allowed_actions:
      - "read"
      - "indices:data/read/search*"
      - "indices:data/read/msearch*"

  log_writer:
    cluster_permissions:
    - "cluster:monitor/health"
    - "indices:data/write/bulk"
    index_permissions:
    - index_patterns:
      - "logs-*"
      - "metrics-*"
      allowed_actions:
      - "write"
      - "create_index"
      - "manage"

  index_manager:
    cluster_permissions:
    - "cluster_all"
    index_permissions:
    - index_patterns:
      - "*"
      allowed_actions:
      - "indices_all"
---
# roles_mapping.yml
roles_mapping:
  all_access:
    reserved: false
    backend_roles:
    - "admin"
    users:
    - "admin"

  log_reader:
    backend_roles:
    - "opensearch-readers"
    - "sre"

  log_writer:
    users:
    - "fluentd"
    - "logstash"

  kibana_user:
    backend_roles:
    - "opensearch-users"
    users:
    - "dashboards"
```

### SAML Authentication

```yaml
# saml-config.yml
authc:
  saml_auth:
    http_enabled: true
    transport_enabled: false
    order: 5
    http_authenticator:
      type: saml
      challenge: true
      config:
        idp:
          metadata_url: https://example.okta.com/app/samlokta/sso/saml/metadata
          entity_id: https://example.okta.com
        sp:
          entity_id: https://opensearch.example.com
          forceAuthn: false
        kibana_url: https://dashboards.example.com
        subject_key: email
        roles_key: groups
        exchange_key: "EXAMPLE_SAML_EXCHANGE_KEY_32CHARS"
    authentication_backend:
      type: noop
```

### OIDC Authentication

```yaml
# oidc-config.yml
authc:
  oidc_auth:
    http_enabled: true
    transport_enabled: false
    order: 1
    http_authenticator:
      type: openid
      challenge: false
      config:
        subject_key: email
        roles_key: groups
        openid_connect_url: https://dex.example.com/.well-known/openid-configuration
        openid_connect_idp:
          enable_ssl: true
          verify_hostnames: true
        jwt_header: Authorization
        jwt_url_parameter: null
    authentication_backend:
      type: noop
```

## Index State Management (ISM) Policies

**ISM** automates index lifecycle: hot phase (active writes) → warm phase (compressed, fewer replicas) → cold phase (read-only) → delete.

```json
{
  "policy": {
    "description": "Log index lifecycle management",
    "default_state": "hot",
    "states": [
      {
        "name": "hot",
        "actions": [
          {
            "rollover": {
              "min_index_age": "1d",
              "min_primary_shard_size": "30gb",
              "min_doc_count": 50000000
            }
          }
        ],
        "transitions": [
          {
            "state_name": "warm",
            "conditions": {
              "min_index_age": "2d"
            }
          }
        ]
      },
      {
        "name": "warm",
        "actions": [
          {
            "replica_count": {
              "number_of_replicas": 1
            }
          },
          {
            "force_merge": {
              "max_num_segments": 1
            }
          },
          {
            "index_priority": {
              "priority": 50
            }
          }
        ],
        "transitions": [
          {
            "state_name": "cold",
            "conditions": {
              "min_index_age": "14d"
            }
          }
        ]
      },
      {
        "name": "cold",
        "actions": [
          {
            "replica_count": {
              "number_of_replicas": 0
            }
          },
          {
            "read_only": {}
          }
        ],
        "transitions": [
          {
            "state_name": "delete",
            "conditions": {
              "min_index_age": "90d"
            }
          }
        ]
      },
      {
        "name": "delete",
        "actions": [
          {
            "delete": {}
          }
        ],
        "transitions": []
      }
    ],
    "ism_template": [
      {
        "index_patterns": ["logs-*"],
        "priority": 100
      }
    ]
  }
}
```

Apply the policy:

```bash
#!/bin/bash
# apply-ism-policy.sh

OPENSEARCH_URL="https://opensearch.opensearch.svc.cluster.local:9200"
CREDS="admin:EXAMPLE_ADMIN_PASSWORD"

curl -k -u "${CREDS}" \
  -H "Content-Type: application/json" \
  -X PUT "${OPENSEARCH_URL}/_plugins/_ism/policies/log-lifecycle" \
  -d @ism-policy.json
```

### Data Streams

```bash
#!/bin/bash
# setup-data-streams.sh

# Create an index template with data stream enabled
curl -k -u "admin:EXAMPLE_ADMIN_PASSWORD" \
  -H "Content-Type: application/json" \
  -X PUT "https://opensearch.opensearch.svc.cluster.local:9200/_index_template/logs" \
  -d '{
    "index_patterns": ["logs-*"],
    "data_stream": {},
    "template": {
      "settings": {
        "number_of_shards": 2,
        "number_of_replicas": 1,
        "index.refresh_interval": "30s",
        "index.translog.durability": "async",
        "index.translog.sync_interval": "30s",
        "plugins.index_state_management.policy_id": "log-lifecycle"
      },
      "mappings": {
        "dynamic_templates": [
          {
            "strings_as_keywords": {
              "match_mapping_type": "string",
              "mapping": {
                "type": "keyword",
                "ignore_above": 512
              }
            }
          }
        ],
        "properties": {
          "@timestamp": {"type": "date"},
          "message": {"type": "text", "fields": {"keyword": {"type": "keyword"}}},
          "level": {"type": "keyword"},
          "service": {"type": "keyword"},
          "namespace": {"type": "keyword"},
          "pod": {"type": "keyword"},
          "container": {"type": "keyword"}
        }
      }
    },
    "priority": 500
  }'
```

## Performance Tuning

### JVM Heap Sizing

```yaml
# Per the OpenSearch JVM sizing guide:
# - Set Xms = Xmx (prevent heap resizing GC pauses)
# - Never exceed 31 GB (G1GC compressed OOPs threshold)
# - Leave at least 50% of node RAM for OS filesystem cache (Lucene uses it)

# Data node: 32 GB RAM node
jvm: "-Xmx15g -Xms15g -XX:+UseG1GC -XX:G1ReservePercent=25 -XX:InitiatingHeapOccupancyPercent=30"

# Master node: 8 GB RAM node
jvm: "-Xmx3g -Xms3g -XX:+UseG1GC"

# Ingest node: 16 GB RAM node
jvm: "-Xmx6g -Xms6g -XX:+UseG1GC"
```

### Index Settings for Write Throughput

```bash
#!/bin/bash
# Apply to a specific index or index template
curl -k -u "admin:EXAMPLE_ADMIN_PASSWORD" \
  -H "Content-Type: application/json" \
  -X PUT "https://opensearch.opensearch.svc.cluster.local:9200/logs-app/_settings" \
  -d '{
    "index": {
      "refresh_interval": "30s",
      "number_of_replicas": 0,
      "translog": {
        "durability": "async",
        "sync_interval": "30s",
        "flush_threshold_size": "1gb"
      },
      "merge": {
        "scheduler": {
          "max_thread_count": 1
        }
      },
      "indexing": {
        "slowlog": {
          "reformat": false,
          "threshold": {
            "index": {
              "warn": "5s",
              "info": "2s"
            }
          }
        }
      }
    }
  }'
```

### Shard Count Optimization

```bash
#!/bin/bash
# Check shard count vs heap ratio
# Target: no more than 20 shards per GB of heap across the cluster

OPENSEARCH_URL="https://opensearch.opensearch.svc.cluster.local:9200"
CREDS="admin:EXAMPLE_ADMIN_PASSWORD"

# Count total shards
curl -k -u "${CREDS}" "${OPENSEARCH_URL}/_cat/shards?h=state&format=json" | \
  python3 -c "import sys,json; s=json.load(sys.stdin); print(f'Total shards: {len(s)}')"

# Check node heap and shard count
curl -k -u "${CREDS}" "${OPENSEARCH_URL}/_cat/nodes?h=name,heap.percent,heap.max,shard.stats.total&v"
```

## Snapshot and Restore to S3

```bash
#!/bin/bash
# configure-s3-snapshots.sh

OPENSEARCH_URL="https://opensearch.opensearch.svc.cluster.local:9200"
CREDS="admin:EXAMPLE_ADMIN_PASSWORD"

# Register S3 snapshot repository
curl -k -u "${CREDS}" \
  -H "Content-Type: application/json" \
  -X PUT "${OPENSEARCH_URL}/_snapshot/s3-backup" \
  -d '{
    "type": "s3",
    "settings": {
      "bucket": "opensearch-snapshots-prod",
      "region": "us-east-1",
      "base_path": "production/",
      "server_side_encryption": true,
      "storage_class": "STANDARD_IA",
      "compress": true,
      "chunk_size": "1gb",
      "max_restore_bytes_per_sec": "500mb",
      "max_snapshot_bytes_per_sec": "500mb"
    }
  }'

# Create a snapshot
curl -k -u "${CREDS}" \
  -H "Content-Type: application/json" \
  -X PUT "${OPENSEARCH_URL}/_snapshot/s3-backup/snapshot-$(date +%Y%m%d-%H%M)" \
  -d '{
    "indices": "*",
    "ignore_unavailable": true,
    "include_global_state": true,
    "partial": false
  }'

# ISM snapshot policy — take daily snapshots automatically
curl -k -u "${CREDS}" \
  -H "Content-Type: application/json" \
  -X POST "${OPENSEARCH_URL}/_plugins/_sm/policies/daily-backup" \
  -d '{
    "description": "Daily S3 snapshot",
    "enabled": true,
    "snapshot_config": {
      "repository": "s3-backup",
      "date_format": "yyyy-MM-dd-HH:mm",
      "ignore_unavailable": true,
      "include_global_state": true
    },
    "creation": {
      "schedule": {
        "cron": {
          "expression": "0 1 * * *",
          "timezone": "UTC"
        }
      }
    },
    "deletion": {
      "schedule": {
        "cron": {
          "expression": "0 2 * * *",
          "timezone": "UTC"
        }
      },
      "condition": {
        "max_count": 30,
        "max_age": "30d"
      }
    }
  }'
```

## Rolling Upgrades

The OpenSearch Operator handles rolling upgrades automatically when `spec.general.version` is updated. To upgrade safely:

```bash
#!/bin/bash
# rolling-upgrade.sh

CURRENT_VERSION="2.12.0"
TARGET_VERSION="2.13.0"

echo "=== Pre-upgrade health check ==="
kubectl exec -n opensearch opensearch-masters-0 -- \
  curl -sk -u admin:EXAMPLE_ADMIN_PASSWORD \
  https://localhost:9200/_cluster/health?pretty

echo ""
echo "=== Disable shard allocation before upgrade ==="
kubectl exec -n opensearch opensearch-masters-0 -- \
  curl -sk -u admin:EXAMPLE_ADMIN_PASSWORD \
  -H "Content-Type: application/json" \
  -X PUT https://localhost:9200/_cluster/settings \
  -d '{"persistent":{"cluster.routing.allocation.enable":"primaries"}}'

echo ""
echo "=== Update cluster version (triggers rolling restart) ==="
kubectl patch opensearchcluster production -n opensearch \
  --type=merge \
  -p "{\"spec\":{\"general\":{\"version\":\"${TARGET_VERSION}\"}}}"

echo ""
echo "=== Watch rolling upgrade progress ==="
kubectl rollout status statefulset/production-masters -n opensearch --timeout=300s
kubectl rollout status statefulset/production-data -n opensearch --timeout=600s

echo ""
echo "=== Re-enable shard allocation ==="
kubectl exec -n opensearch opensearch-masters-0 -- \
  curl -sk -u admin:EXAMPLE_ADMIN_PASSWORD \
  -H "Content-Type: application/json" \
  -X PUT https://localhost:9200/_cluster/settings \
  -d '{"persistent":{"cluster.routing.allocation.enable":null}}'

echo ""
echo "=== Post-upgrade health check ==="
kubectl exec -n opensearch opensearch-masters-0 -- \
  curl -sk -u admin:EXAMPLE_ADMIN_PASSWORD \
  https://localhost:9200/_cluster/health?pretty
```

## Monitoring with Prometheus

### ServiceMonitor

```yaml
# opensearch-monitoring.yaml
---
# Deploy opensearch-exporter (Prometheus exporter)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: opensearch-exporter
  namespace: opensearch
spec:
  replicas: 1
  selector:
    matchLabels:
      app: opensearch-exporter
  template:
    metadata:
      labels:
        app: opensearch-exporter
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9114"
    spec:
      containers:
      - name: exporter
        image: prometheuscommunity/elasticsearch-exporter:v1.7.0
        args:
        - --es.uri=https://opensearch:9200
        - --es.ssl-skip-verify
        - --es.username=admin
        - --es.password=$(OPENSEARCH_PASSWORD)
        - --es.all
        - --es.indices
        - --es.shards
        - --es.timeout=30s
        env:
        - name: OPENSEARCH_PASSWORD
          valueFrom:
            secretKeyRef:
              name: opensearch-admin-credentials
              key: password
        ports:
        - containerPort: 9114
          name: metrics
        resources:
          requests:
            cpu: 50m
            memory: 64Mi
          limits:
            cpu: 200m
            memory: 128Mi
---
apiVersion: v1
kind: Service
metadata:
  name: opensearch-exporter
  namespace: opensearch
  labels:
    app: opensearch-exporter
spec:
  ports:
  - port: 9114
    name: metrics
  selector:
    app: opensearch-exporter
---
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: opensearch
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: opensearch-exporter
  namespaceSelector:
    matchNames:
    - opensearch
  endpoints:
  - port: metrics
    interval: 30s
    path: /metrics
---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: opensearch-alerts
  namespace: monitoring
spec:
  groups:
  - name: opensearch.cluster
    interval: 30s
    rules:
    - alert: OpenSearchClusterRed
      expr: elasticsearch_cluster_health_status{color="red"} == 1
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "OpenSearch cluster health is RED"
        description: "Primary shard(s) are unassigned. Data loss risk."

    - alert: OpenSearchClusterYellow
      expr: elasticsearch_cluster_health_status{color="yellow"} == 1
      for: 30m
      labels:
        severity: warning
      annotations:
        summary: "OpenSearch cluster health is YELLOW"
        description: "Replica shard(s) are unassigned. No redundancy."

    - alert: OpenSearchHighHeapUsage
      expr: |
        elasticsearch_jvm_memory_used_bytes{area="heap"} /
        elasticsearch_jvm_memory_max_bytes{area="heap"} > 0.85
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "OpenSearch node {{ $labels.name }} heap usage above 85%"
        description: "{{ $value | humanizePercentage }} heap used."

    - alert: OpenSearchDiskUsageHigh
      expr: |
        (1 - elasticsearch_filesystem_data_available_bytes /
        elasticsearch_filesystem_data_size_bytes) > 0.80
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "OpenSearch node {{ $labels.name }} disk usage above 80%"

    - alert: OpenSearchUnassignedShards
      expr: elasticsearch_cluster_health_unassigned_shards > 0
      for: 15m
      labels:
        severity: warning
      annotations:
        summary: "OpenSearch has {{ $value }} unassigned shards"

    - alert: OpenSearchPendingTasks
      expr: elasticsearch_cluster_health_number_of_pending_tasks > 50
      for: 15m
      labels:
        severity: warning
      annotations:
        summary: "OpenSearch has {{ $value }} pending cluster tasks"
```

## Operational Runbook

```bash
#!/bin/bash
# opensearch-ops.sh

OPENSEARCH_URL="https://opensearch.opensearch.svc.cluster.local:9200"
CREDS="admin:EXAMPLE_ADMIN_PASSWORD"

echo "=== Cluster Health ==="
curl -sk -u "${CREDS}" "${OPENSEARCH_URL}/_cluster/health?pretty"

echo ""
echo "=== Node Stats ==="
curl -sk -u "${CREDS}" "${OPENSEARCH_URL}/_cat/nodes?v&h=name,ip,heapPercent,diskAvail,cpu,load_1m,role"

echo ""
echo "=== Shard Allocation ==="
curl -sk -u "${CREDS}" "${OPENSEARCH_URL}/_cat/shards?v&h=index,shard,prirep,state,unassigned.reason" | \
  grep -v STARTED | head -30

echo ""
echo "=== Hot Threads (debugging slow nodes) ==="
curl -sk -u "${CREDS}" "${OPENSEARCH_URL}/_nodes/hot_threads?interval=1s&snapshots=3&type=cpu"

echo ""
echo "=== Index Stats ==="
curl -sk -u "${CREDS}" "${OPENSEARCH_URL}/_cat/indices?v&h=index,health,status,pri,rep,docs.count,store.size&s=store.size:desc" | head -20

echo ""
echo "=== ISM Job Status ==="
curl -sk -u "${CREDS}" "${OPENSEARCH_URL}/_plugins/_ism/explain?pretty" | \
  python3 -c "import sys,json; d=json.load(sys.stdin); [print(k, d[k].get('current_state','?')) for k in d if k != 'total_managed_indices']" 2>/dev/null | head -20
```

## Conclusion

Running OpenSearch on Kubernetes with the OpenSearch Operator provides a robust, declarative path to production-grade distributed search. Key operational recommendations:

- Separate master, data, and ingest nodes in distinct StatefulSets to allow independent scaling and resource tuning
- Limit JVM heap to 31 GB per node and set `Xms = Xmx` to prevent heap resizing GC pauses
- Apply ISM policies from day one — retrofitting lifecycle management to existing indices is significantly more disruptive than enabling it proactively
- Schedule force-merge of warm indices to 1 segment to reduce query overhead by 60–80% on read-heavy indices
- Take daily S3 snapshots using the ISM snapshot management plugin with a 30-day retention window
- Monitor `elasticsearch_jvm_memory_used_bytes / max > 0.85` as the primary leading indicator of node instability
- Use data streams for time-series log data to leverage built-in rollover, retention, and ISM policy attachment
