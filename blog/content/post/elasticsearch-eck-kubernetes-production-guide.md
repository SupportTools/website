---
title: "Elasticsearch ECK Production Guide: Cluster Sizing, ILM, and Snapshot Management"
date: 2027-07-04T00:00:00-05:00
draft: false
tags: ["Elasticsearch", "ECK", "Kubernetes", "Observability", "Search"]
categories:
- Elasticsearch
- Kubernetes
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive production guide for deploying Elasticsearch on Kubernetes using the ECK operator, covering cluster node roles, storage tiering, ILM, snapshot management, TLS security, and JVM heap tuning."
more_link: "yes"
url: "/elasticsearch-eck-kubernetes-production-guide/"
---

Running Elasticsearch on Kubernetes with the Elastic Cloud on Kubernetes (ECK) operator transforms a traditionally complex deployment into a declarative, GitOps-friendly workflow. ECK handles certificate rotation, rolling upgrades, and cluster topology changes through custom resources, but production readiness still demands deliberate decisions around node roles, storage tiering, Index Lifecycle Management (ILM), snapshot repositories, and JVM tuning. This guide walks through each concern with production-ready configurations tested against real enterprise workloads.

<!--more-->

## ECK Operator Architecture

### Operator Deployment Model

ECK runs as a Kubernetes operator in the `elastic-system` namespace. It watches `Elasticsearch`, `Kibana`, `Beat`, `LogstashPipeline`, and related custom resources, then reconciles the actual cluster state toward the desired spec.

Install the operator via the official manifests:

```bash
kubectl create -f https://download.elastic.co/downloads/eck/2.13.0/crds.yaml
kubectl apply -f https://download.elastic.co/downloads/eck/2.13.0/operator.yaml
```

Verify the operator pod is running:

```bash
kubectl -n elastic-system get pods
# NAME                             READY   STATUS    RESTARTS   AGE
# elastic-operator-0               1/1     Running   0          2m
```

The operator stores its state in Kubernetes secrets and ConfigMaps, not in external storage. The operator itself is a StatefulSet with a leader-election mechanism, making it safe to scale to multiple replicas for high availability:

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: elastic-operator
  namespace: elastic-system
spec:
  replicas: 2
```

### Custom Resource Hierarchy

ECK exposes a tree of custom resources:

- `Elasticsearch` — the core cluster spec (node sets, topology, config)
- `Kibana` — connects to an Elasticsearch cluster via service reference
- `Beat` — deploys Filebeat, Metricbeat, Packetbeat
- `ElasticMapsServer` — geospatial map service
- `EnterpriseSearch` — App Search and Workplace Search
- `Agent` — Elastic Agent fleet management

All resources share namespace scope. Cross-namespace references are supported in ECK 2.x via `elasticsearchRef.namespace`.

---

## Elasticsearch Cluster Node Roles

### Role-Based Node Architecture

Production clusters should separate node roles to optimize resource allocation. Elasticsearch supports the following primary roles:

| Role | Purpose | Resource Profile |
|------|---------|-----------------|
| `master` | Cluster state management | Low CPU/RAM, high IOPS for state log |
| `data_hot` | Active write path, frequent queries | NVMe SSD, high RAM |
| `data_warm` | Recent data, moderate queries | SSD or HDD, moderate RAM |
| `data_cold` | Infrequent queries, long retention | HDD or object store mounted |
| `data_frozen` | Searchable snapshots, minimal local disk | Minimal disk, object store |
| `ingest` | Pipeline processing before indexing | High CPU |
| `coordinating` | Query routing and aggregation | High RAM, no disk |
| `ml` | Machine learning jobs | Dedicated GPU/CPU nodes |

### Production NodeSet Configuration

```yaml
apiVersion: elasticsearch.k8s.elastic.co/v1
kind: Elasticsearch
metadata:
  name: production
  namespace: elastic
spec:
  version: 8.14.0
  nodeSets:
    # Dedicated master nodes — 3 for quorum
    - name: master
      count: 3
      config:
        node.roles: ["master"]
        xpack.ml.enabled: false
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
                  memory: 4Gi
                  cpu: "1"
                limits:
                  memory: 4Gi
                  cpu: "2"
              env:
                - name: ES_JAVA_OPTS
                  value: "-Xms2g -Xmx2g"
      volumeClaimTemplates:
        - metadata:
            name: elasticsearch-data
          spec:
            accessModes: ["ReadWriteOnce"]
            storageClassName: gp3-encrypted
            resources:
              requests:
                storage: 20Gi

    # Hot data nodes — primary write and query path
    - name: data-hot
      count: 3
      config:
        node.roles: ["data_hot", "data_content", "ingest"]
        cluster.routing.allocation.disk.watermark.low: "85%"
        cluster.routing.allocation.disk.watermark.high: "90%"
        cluster.routing.allocation.disk.watermark.flood_stage: "95%"
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
                  memory: 32Gi
                  cpu: "8"
                limits:
                  memory: 32Gi
                  cpu: "16"
              env:
                - name: ES_JAVA_OPTS
                  value: "-Xms16g -Xmx16g"
          nodeSelector:
            node.kubernetes.io/instance-type: m6id.4xlarge
          tolerations:
            - key: elasticsearch-hot
              operator: Equal
              value: "true"
              effect: NoSchedule
      volumeClaimTemplates:
        - metadata:
            name: elasticsearch-data
          spec:
            accessModes: ["ReadWriteOnce"]
            storageClassName: nvme-local
            resources:
              requests:
                storage: 2Ti

    # Warm data nodes — aging data with reduced query rate
    - name: data-warm
      count: 3
      config:
        node.roles: ["data_warm"]
      podTemplate:
        spec:
          containers:
            - name: elasticsearch
              resources:
                requests:
                  memory: 16Gi
                  cpu: "4"
                limits:
                  memory: 16Gi
                  cpu: "8"
              env:
                - name: ES_JAVA_OPTS
                  value: "-Xms8g -Xmx8g"
          nodeSelector:
            node.kubernetes.io/instance-type: m6a.2xlarge
      volumeClaimTemplates:
        - metadata:
            name: elasticsearch-data
          spec:
            accessModes: ["ReadWriteOnce"]
            storageClassName: gp3-encrypted
            resources:
              requests:
                storage: 4Ti

    # Cold data nodes — long-term retention, infrequent access
    - name: data-cold
      count: 2
      config:
        node.roles: ["data_cold"]
      podTemplate:
        spec:
          containers:
            - name: elasticsearch
              resources:
                requests:
                  memory: 8Gi
                  cpu: "2"
                limits:
                  memory: 8Gi
                  cpu: "4"
              env:
                - name: ES_JAVA_OPTS
                  value: "-Xms4g -Xmx4g"
      volumeClaimTemplates:
        - metadata:
            name: elasticsearch-data
          spec:
            accessModes: ["ReadWriteOnce"]
            storageClassName: sc1-hdd
            resources:
              requests:
                storage: 8Ti

    # Coordinating-only nodes — query fan-out and aggregation buffering
    - name: coordinating
      count: 2
      config:
        node.roles: []
      podTemplate:
        spec:
          containers:
            - name: elasticsearch
              resources:
                requests:
                  memory: 16Gi
                  cpu: "4"
                limits:
                  memory: 16Gi
                  cpu: "8"
              env:
                - name: ES_JAVA_OPTS
                  value: "-Xms8g -Xmx8g"
      volumeClaimTemplates:
        - metadata:
            name: elasticsearch-data
          spec:
            accessModes: ["ReadWriteOnce"]
            storageClassName: gp3-encrypted
            resources:
              requests:
                storage: 10Gi
```

---

## Storage Tiering: Hot, Warm, Cold Architecture

### Index Shard Allocation Awareness

Elasticsearch uses shard allocation filtering to control which tier hosts an index. Node attributes drive the routing:

```yaml
# In each nodeSet config block
config:
  node.attr.data_tier: hot   # or warm, cold, frozen
  node.roles: ["data_hot"]
```

Queries against the `_cat/nodeattrs` API confirm placement:

```bash
curl -s -u elastic:${ES_PASSWORD} \
  https://production-es-http.elastic.svc:9200/_cat/nodeattrs?v&h=node,attr,value | \
  grep data_tier
```

### Forced Merge and Best Compression on Warm/Cold

When shards age into warm or cold tiers, force-merging them to a single segment and enabling `best_compression` reduces storage significantly:

```json
POST /logs-app-2024.01.01/_forcemerge?max_num_segments=1

PUT /logs-app-2024.01.01/_settings
{
  "index.codec": "best_compression"
}
```

ECK does not manage this automatically; it is handled through ILM actions (covered below).

---

## Index Lifecycle Management (ILM)

### Policy Design Principles

ILM automates the movement of indices through phases: `hot`, `warm`, `cold`, `frozen`, and `delete`. A well-designed policy reduces operational overhead and storage cost.

```json
PUT _ilm/policy/logs-default
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
          "set_priority": {
            "priority": 100
          }
        }
      },
      "warm": {
        "min_age": "7d",
        "actions": {
          "migrate": {},
          "shrink": {
            "number_of_shards": 1
          },
          "forcemerge": {
            "max_num_segments": 1
          },
          "allocate": {
            "number_of_replicas": 1
          },
          "set_priority": {
            "priority": 50
          }
        }
      },
      "cold": {
        "min_age": "30d",
        "actions": {
          "migrate": {},
          "allocate": {
            "number_of_replicas": 0
          },
          "set_priority": {
            "priority": 0
          },
          "freeze": {}
        }
      },
      "frozen": {
        "min_age": "90d",
        "actions": {
          "searchable_snapshot": {
            "snapshot_repository": "s3-cold-snapshots",
            "force_merge_index": true
          }
        }
      },
      "delete": {
        "min_age": "365d",
        "actions": {
          "delete": {}
        }
      }
    }
  }
}
```

### Index Template with ILM Binding

```json
PUT _index_template/logs-template
{
  "index_patterns": ["logs-*"],
  "data_stream": {},
  "template": {
    "settings": {
      "number_of_shards": 3,
      "number_of_replicas": 1,
      "index.lifecycle.name": "logs-default",
      "index.routing.allocation.require._tier_preference": "data_hot",
      "index.mapping.total_fields.limit": 2000
    },
    "mappings": {
      "dynamic_templates": [
        {
          "strings_as_keywords": {
            "match_mapping_type": "string",
            "mapping": {
              "type": "keyword",
              "ignore_above": 1024
            }
          }
        }
      ],
      "properties": {
        "@timestamp": { "type": "date" },
        "message": { "type": "text" },
        "log.level": { "type": "keyword" },
        "service.name": { "type": "keyword" },
        "trace.id": { "type": "keyword" }
      }
    }
  },
  "priority": 200
}
```

---

## Snapshot Repositories: S3 and GCS

### S3 Snapshot Repository

ECK does not create snapshot repositories automatically. The repository must be registered via the Elasticsearch API or through a Kubernetes Job post-deployment.

First, store the AWS credentials as a Kubernetes secret that ECK mounts into the Elasticsearch keystore:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: es-s3-credentials
  namespace: elastic
stringData:
  s3.client.default.access_key: "REPLACE_WITH_ACCESS_KEY_ID"
  s3.client.default.secret_key: "REPLACE_WITH_SECRET_ACCESS_KEY"
```

Reference the secret in the Elasticsearch spec:

```yaml
spec:
  secureSettings:
    - secretName: es-s3-credentials
```

Register the repository after the cluster is healthy:

```bash
curl -s -u elastic:${ES_PASSWORD} \
  -X PUT https://production-es-http.elastic.svc:9200/_snapshot/s3-snapshots \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "s3",
    "settings": {
      "bucket": "my-es-snapshots-prod",
      "region": "us-east-1",
      "base_path": "elasticsearch/production",
      "compress": true,
      "server_side_encryption": true,
      "storage_class": "standard_ia"
    }
  }'
```

For IAM role-based access (recommended over access keys), annotate the Elasticsearch pods with an IRSA service account:

```yaml
spec:
  nodeSets:
    - name: data-hot
      podTemplate:
        spec:
          serviceAccountName: elasticsearch-irsa
```

The service account should have an IAM role annotation:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: elasticsearch-irsa
  namespace: elastic
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/elasticsearch-snapshot-role
```

### GCS Snapshot Repository

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: es-gcs-credentials
  namespace: elastic
stringData:
  gcs.client.default.credentials_file: |
    {
      "type": "service_account",
      "project_id": "my-project",
      "private_key_id": "REPLACE_WITH_KEY_ID",
      "client_email": "es-snapshots@my-project.iam.gserviceaccount.com"
    }
```

```bash
curl -s -u elastic:${ES_PASSWORD} \
  -X PUT https://production-es-http.elastic.svc:9200/_snapshot/gcs-snapshots \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "gcs",
    "settings": {
      "bucket": "my-es-snapshots-prod",
      "client": "default",
      "base_path": "elasticsearch/production",
      "compress": true
    }
  }'
```

### Automated Snapshot Lifecycle Policy (SLM)

```json
PUT _slm/policy/nightly-snapshots
{
  "schedule": "0 0 2 * * ?",
  "name": "<production-snap-{now/d}>",
  "repository": "s3-snapshots",
  "config": {
    "indices": ["*"],
    "ignore_unavailable": true,
    "include_global_state": true,
    "feature_states": ["security"]
  },
  "retention": {
    "expire_after": "30d",
    "min_count": 5,
    "max_count": 50
  }
}
```

---

## Kibana Deployment

### ECK Kibana Resource

```yaml
apiVersion: kibana.k8s.elastic.co/v1
kind: Kibana
metadata:
  name: production
  namespace: elastic
spec:
  version: 8.14.0
  count: 2
  elasticsearchRef:
    name: production
  config:
    xpack.fleet.enabled: true
    xpack.security.encryptionKey: "REPLACE_WITH_32_CHAR_RANDOM_STRING"
    xpack.encryptedSavedObjects.encryptionKey: "REPLACE_WITH_32_CHAR_RANDOM_STRING"
    xpack.reporting.encryptionKey: "REPLACE_WITH_32_CHAR_RANDOM_STRING"
    server.publicBaseUrl: "https://kibana.example.com"
    telemetry.enabled: false
    newsfeed.enabled: false
  podTemplate:
    spec:
      containers:
        - name: kibana
          resources:
            requests:
              memory: 2Gi
              cpu: "1"
            limits:
              memory: 2Gi
              cpu: "2"
  http:
    tls:
      selfSignedCertificate:
        disabled: false
```

Expose Kibana through an Ingress with TLS termination at the load balancer:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: kibana
  namespace: elastic
  annotations:
    nginx.ingress.kubernetes.io/backend-protocol: "HTTPS"
    nginx.ingress.kubernetes.io/ssl-passthrough: "false"
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - kibana.example.com
      secretName: kibana-tls
  rules:
    - host: kibana.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: production-kb-http
                port:
                  number: 5601
```

---

## Security: X-Pack TLS and RBAC

### ECK TLS Architecture

ECK automatically provisions TLS certificates for:
- Transport layer (inter-node communication)
- HTTP layer (client-to-node communication)
- Kibana-to-Elasticsearch communication

Retrieve the CA certificate and elastic user password:

```bash
# CA certificate
kubectl -n elastic get secret production-es-http-certs-public \
  -o go-template='{{index .data "tls.crt" | base64decode}}' > ca.crt

# elastic user password
kubectl -n elastic get secret production-es-elastic-user \
  -o go-template='{{.data.elastic | base64decode}}'
```

For custom certificates (e.g., from cert-manager):

```yaml
spec:
  http:
    tls:
      certificate:
        secretName: production-es-custom-cert
```

The secret must contain `tls.crt`, `tls.key`, and optionally `ca.crt`.

### Native Realm Users and Roles

```bash
# Create an application role
curl -s -u elastic:${ES_PASSWORD} \
  -X PUT https://production-es-http.elastic.svc:9200/_security/role/logs-reader \
  -H 'Content-Type: application/json' \
  -d '{
    "cluster": ["monitor"],
    "indices": [
      {
        "names": ["logs-*"],
        "privileges": ["read", "view_index_metadata"]
      }
    ]
  }'

# Create an application user
curl -s -u elastic:${ES_PASSWORD} \
  -X PUT https://production-es-http.elastic.svc:9200/_security/user/app-reader \
  -H 'Content-Type: application/json' \
  -d '{
    "password": "REPLACE_WITH_STRONG_PASSWORD",
    "roles": ["logs-reader"],
    "full_name": "Application Read-Only User"
  }'
```

### Network Policy for Elasticsearch

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: elasticsearch-network-policy
  namespace: elastic
spec:
  podSelector:
    matchLabels:
      elasticsearch.k8s.elastic.co/cluster-name: production
  policyTypes:
    - Ingress
    - Egress
  ingress:
    # Allow Kibana
    - from:
        - podSelector:
            matchLabels:
              kibana.k8s.elastic.co/name: production
      ports:
        - protocol: TCP
          port: 9200
    # Allow monitoring namespace
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: monitoring
      ports:
        - protocol: TCP
          port: 9200
    # Inter-node transport
    - from:
        - podSelector:
            matchLabels:
              elasticsearch.k8s.elastic.co/cluster-name: production
      ports:
        - protocol: TCP
          port: 9300
  egress:
    - to:
        - podSelector:
            matchLabels:
              elasticsearch.k8s.elastic.co/cluster-name: production
      ports:
        - protocol: TCP
          port: 9300
    - to: []
      ports:
        - protocol: TCP
          port: 443   # S3/GCS snapshots
        - protocol: TCP
          port: 53    # DNS
        - protocol: UDP
          port: 53
```

---

## Monitoring with Metricbeat

### Metricbeat ECK Resource

```yaml
apiVersion: beat.k8s.elastic.co/v1beta1
kind: Beat
metadata:
  name: metricbeat
  namespace: elastic
spec:
  type: metricbeat
  version: 8.14.0
  elasticsearchRef:
    name: production
  kibanaRef:
    name: production
  config:
    metricbeat.modules:
      - module: elasticsearch
        xpack.enabled: true
        period: 10s
        hosts:
          - https://production-es-http.elastic.svc:9200
        username: elastic
        password: ${ES_PASSWORD}
        ssl.certificate_authorities:
          - /mnt/elastic-internal/elasticsearch-certs/ca.crt
      - module: kibana
        xpack.enabled: true
        period: 10s
        hosts:
          - https://production-kb-http.elastic.svc:5601
        username: elastic
        password: ${ES_PASSWORD}
        ssl.certificate_authorities:
          - /mnt/elastic-internal/kibana-certs/ca.crt
    output.elasticsearch:
      hosts:
        - https://production-es-http.elastic.svc:9200
      username: elastic
      password: ${ES_PASSWORD}
      ssl.certificate_authorities:
        - /mnt/elastic-internal/elasticsearch-certs/ca.crt
  daemonSet:
    podTemplate:
      spec:
        serviceAccountName: metricbeat
        automountServiceAccountToken: true
        securityContext:
          runAsUser: 0
        containers:
          - name: metricbeat
            resources:
              requests:
                memory: 300Mi
                cpu: 100m
              limits:
                memory: 500Mi
                cpu: 200m
```

---

## JVM Heap Sizing

### Heap Sizing Rules

Elasticsearch has two critical JVM constraints:

1. The heap must not exceed 31 GB (to stay in compressed ordinary object pointers territory).
2. The heap should be set to no more than 50% of available RAM (the remaining half is used for the filesystem cache, which is critical for search performance).

Practical sizing by node RAM:

| Node RAM | Recommended Heap | `ES_JAVA_OPTS` |
|----------|-----------------|----------------|
| 8 GB     | 4 GB            | `-Xms4g -Xmx4g` |
| 16 GB    | 8 GB            | `-Xms8g -Xmx8g` |
| 32 GB    | 16 GB           | `-Xms16g -Xmx16g` |
| 64 GB    | 31 GB           | `-Xms31g -Xmx31g` |
| 128 GB   | 31 GB           | `-Xms31g -Xmx31g` |

Always set `-Xms` and `-Xmx` to the same value to prevent heap resizing during runtime.

### GC Tuning for Large Heaps

For heaps above 8 GB, G1GC with region sizing is preferred:

```yaml
env:
  - name: ES_JAVA_OPTS
    value: >-
      -Xms16g
      -Xmx16g
      -XX:+UseG1GC
      -XX:G1HeapRegionSize=16m
      -XX:MaxGCPauseMillis=200
      -XX:InitiatingHeapOccupancyPercent=35
      -XX:+ExplicitGCInvokesConcurrent
      -Djava.io.tmpdir=/tmp
```

Monitor GC pressure through the Elasticsearch `_nodes/stats` API:

```bash
curl -s -u elastic:${ES_PASSWORD} \
  https://production-es-http.elastic.svc:9200/_nodes/stats/jvm?pretty | \
  jq '.nodes | to_entries[] | {
    node: .value.name,
    heap_used_pct: .value.jvm.mem.heap_used_percent,
    gc_old_count: .value.jvm.gc.collectors.old.collection_count,
    gc_old_time_ms: .value.jvm.gc.collectors.old.collection_time_in_millis
  }'
```

---

## Autoscaling Policies

### ECK Autoscaling Resource

ECK 2.x supports autoscaling via the `ElasticsearchAutoscalingPolicy` CRD:

```yaml
apiVersion: autoscaling.k8s.elastic.co/v1alpha1
kind: ElasticsearchAutoscalingPolicy
metadata:
  name: production-autoscaling
  namespace: elastic
spec:
  elasticsearchRef:
    name: production
  policies:
    - name: data-hot
      roles: ["data_hot", "data_content"]
      resources:
        nodeCount:
          min: 3
          max: 12
        cpu:
          min: "4"
          max: "16"
        memory:
          min: 16Gi
          max: 64Gi
        storage:
          min: 500Gi
          max: 2Ti
    - name: data-warm
      roles: ["data_warm"]
      resources:
        nodeCount:
          min: 2
          max: 6
        cpu:
          min: "2"
          max: "8"
        memory:
          min: 8Gi
          max: 32Gi
        storage:
          min: 1Ti
          max: 8Ti
```

The autoscaler uses deciders including `storage` (reactive to disk usage), `ml` (reactive to ML job queue depth), and `proactive_storage` (anticipatory based on ILM rollover projections).

Check autoscaling status:

```bash
kubectl -n elastic get elasticsearchautoscalingpolicy production-autoscaling -o yaml | \
  yq '.status'
```

---

## Operational Runbook

### Health Check Commands

```bash
# Cluster health
curl -s -u elastic:${ES_PASSWORD} \
  https://production-es-http.elastic.svc:9200/_cluster/health?pretty

# Shard allocation issues
curl -s -u elastic:${ES_PASSWORD} \
  https://production-es-http.elastic.svc:9200/_cluster/allocation/explain?pretty

# Index disk usage
curl -s -u elastic:${ES_PASSWORD} \
  "https://production-es-http.elastic.svc:9200/_cat/indices?v&h=index,pri,rep,docs.count,store.size,pri.store.size&s=store.size:desc" | \
  head -20

# ILM explain for a specific index
curl -s -u elastic:${ES_PASSWORD} \
  https://production-es-http.elastic.svc:9200/.ds-logs-app-default-000001/_ilm/explain?pretty

# Pending tasks
curl -s -u elastic:${ES_PASSWORD} \
  https://production-es-http.elastic.svc:9200/_cluster/pending_tasks?pretty
```

### Rolling Upgrade via ECK

ECK handles rolling upgrades automatically when the `version` field is changed:

```bash
kubectl -n elastic patch elasticsearch production \
  --type=merge \
  -p '{"spec":{"version":"8.15.0"}}'
```

Monitor upgrade progress:

```bash
kubectl -n elastic get elasticsearch production -w
# NAME         HEALTH   NODES   VERSION   PHASE
# production   green    13      8.14.0    ApplyingChanges
# production   green    13      8.15.0    Ready
```

### Disk Watermark Alerts

Configure a Prometheus alert for disk watermark breaches using `kube-state-metrics` and the Elasticsearch exporter:

```yaml
groups:
  - name: elasticsearch
    rules:
      - alert: ElasticsearchDiskHigh
        expr: |
          elasticsearch_filesystem_data_available_bytes /
          elasticsearch_filesystem_data_size_bytes < 0.15
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Elasticsearch node disk usage above 85%"
          description: "Node {{ $labels.node }} has less than 15% disk free."

      - alert: ElasticsearchClusterNotGreen
        expr: elasticsearch_cluster_health_status{color="green"} == 0
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Elasticsearch cluster not green"
```

---

## Summary

Deploying Elasticsearch with ECK on Kubernetes requires careful attention to node role separation, JVM heap constraints, ILM policy design, and snapshot lifecycle management. ECK automates certificate management and rolling upgrades, reducing the operational burden of cluster lifecycle management. The configurations presented here reflect production-tested patterns for enterprise log and search workloads operating at multi-terabyte scale, with storage tiering that balances cost against query performance across hot, warm, cold, and frozen data tiers.
