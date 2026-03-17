---
title: "Elasticsearch on Kubernetes: Production Deployment with ECK"
date: 2027-12-04T00:00:00-05:00
draft: false
tags: ["Elasticsearch", "ECK", "Kubernetes", "Search", "Logging"]
categories:
- Kubernetes
- Logging
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to deploying production-grade Elasticsearch on Kubernetes using the Elastic Cloud on Kubernetes (ECK) operator, covering hot-warm-cold topology, ILM, TLS security, RBAC, snapshot repositories, performance tuning, and Fluentd integration."
more_link: "yes"
url: "/elasticsearch-production-kubernetes-guide/"
---

Running Elasticsearch on Kubernetes requires deep integration between Elasticsearch's cluster management requirements and Kubernetes operational patterns. The Elastic Cloud on Kubernetes (ECK) operator bridges this gap, handling certificate management, rolling upgrades, and configuration reconciliation. This guide covers a production deployment that handles petabyte-scale logging with proper data lifecycle management and security hardening.

<!--more-->

# Elasticsearch on Kubernetes: Production Deployment with ECK

## ECK Operator Installation

The ECK operator manages the lifecycle of Elasticsearch, Kibana, APM Server, Logstash, and Fleet Server instances.

### Installing the ECK Operator

```bash
# Install ECK CRDs and operator
kubectl create -f https://download.elastic.co/downloads/eck/2.11.0/crds.yaml
kubectl apply -f https://download.elastic.co/downloads/eck/2.11.0/operator.yaml

# Verify operator is running
kubectl get pods -n elastic-system
kubectl get crd | grep elastic

# Configure operator settings (optional, for production)
kubectl edit configmap elastic-operator -n elastic-system
```

```yaml
# ECK operator ConfigMap customization
apiVersion: v1
kind: ConfigMap
metadata:
  name: elastic-operator
  namespace: elastic-system
data:
  eck.yaml: |-
    log-verbosity: 0
    metrics-port: 8080
    operator-namespace: elastic-system
    enable-webhook: true
    webhook-name: elastic-webhook.k8s.elastic.co
    # Enable resource watch across all namespaces
    namespaces: []
    # Operator resource settings
    operator-roles:
      global: true
    # Container registry for Elasticsearch images
    container-registry: docker.elastic.co
    # Maximum concurrent reconciliation loops
    max-concurrent-reconciles: 3
    # Elasticsearch operator settings
    elasticsearch-operator-roles:
      global: true
```

## Section 1: Hot-Warm-Cold Architecture

### Cluster Topology Design

For a logging cluster handling 50GB/day of ingest, the hot-warm-cold architecture optimizes cost and performance:

- **Hot nodes**: Fast NVMe SSDs, high CPU, active indexing and recent queries
- **Warm nodes**: Slower SSDs, optimized for read-only shard storage
- **Cold nodes**: Magnetic disks or object storage, archived data rarely queried
- **Master nodes**: Dedicated, no data, cluster state management only
- **Coordinating nodes**: Load balancing, query aggregation (optional for large clusters)

```yaml
apiVersion: elasticsearch.k8s.elastic.co/v1
kind: Elasticsearch
metadata:
  name: production-logs
  namespace: logging
spec:
  version: 8.11.1

  # Cluster-wide settings
  nodeSets:
  # Master nodes - dedicated, no data
  - name: master
    count: 3
    config:
      node.roles: ["master"]
      # Ensure master nodes don't hold data
      node.data: false
      node.ingest: false
      node.ml: false
      cluster.remote.connect: false
    podTemplate:
      spec:
        # Master nodes need less memory than data nodes
        initContainers:
        - name: sysctl
          securityContext:
            privileged: true
            runAsUser: 0
          command: ['sh', '-c', 'sysctl -w vm.max_map_count=262144']
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
        affinity:
          podAntiAffinity:
            requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  elasticsearch.k8s.elastic.co/cluster-name: production-logs
                  elasticsearch.k8s.elastic.co/statefulset-name: production-logs-es-master
              topologyKey: kubernetes.io/hostname
    volumeClaimTemplates:
    - metadata:
        name: elasticsearch-data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: standard-ssd
        resources:
          requests:
            storage: 10Gi  # Small, masters don't store data

  # Hot nodes - fast SSDs, active indexing
  - name: hot
    count: 3
    config:
      node.roles: ["data_hot", "data_content", "ingest", "transform"]
      node.attr.data: hot
      # JVM settings for hot nodes
      cluster.routing.allocation.awareness.attributes: zone
      node.attr.zone: "${ZONE}"
    podTemplate:
      spec:
        initContainers:
        - name: sysctl
          securityContext:
            privileged: true
            runAsUser: 0
          command: ['sh', '-c', 'sysctl -w vm.max_map_count=262144']
        - name: install-plugins
          command:
          - sh
          - -c
          - |
            bin/elasticsearch-plugin install --batch repository-s3
            bin/elasticsearch-plugin install --batch repository-gcs
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
            value: "-Xms8g -Xmx8g -XX:+UseG1GC -XX:G1HeapRegionSize=32m"
          - name: ZONE
            valueFrom:
              fieldRef:
                fieldPath: metadata.annotations['topology.kubernetes.io/zone']
          volumeMounts:
          - name: elasticsearch-data
            mountPath: /usr/share/elasticsearch/data
        affinity:
          podAntiAffinity:
            requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  elasticsearch.k8s.elastic.co/statefulset-name: production-logs-es-hot
              topologyKey: kubernetes.io/hostname
          nodeAffinity:
            requiredDuringSchedulingIgnoredDuringExecution:
              nodeSelectorTerms:
              - matchExpressions:
                - key: node-type
                  operator: In
                  values:
                  - elasticsearch-hot
        tolerations:
        - key: elasticsearch-hot
          operator: Exists
          effect: NoSchedule
    volumeClaimTemplates:
    - metadata:
        name: elasticsearch-data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: fast-nvme
        resources:
          requests:
            storage: 2Ti

  # Warm nodes - cost-optimized SSDs for aging data
  - name: warm
    count: 3
    config:
      node.roles: ["data_warm"]
      node.attr.data: warm
    podTemplate:
      spec:
        initContainers:
        - name: sysctl
          securityContext:
            privileged: true
            runAsUser: 0
          command: ['sh', '-c', 'sysctl -w vm.max_map_count=262144']
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
        affinity:
          podAntiAffinity:
            preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchLabels:
                    elasticsearch.k8s.elastic.co/statefulset-name: production-logs-es-warm
                topologyKey: kubernetes.io/hostname
          nodeAffinity:
            preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              preference:
                matchExpressions:
                - key: node-type
                  operator: In
                  values:
                  - elasticsearch-warm
    volumeClaimTemplates:
    - metadata:
        name: elasticsearch-data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: standard-ssd
        resources:
          requests:
            storage: 4Ti

  # Cold nodes - cheap storage, frozen indices
  - name: cold
    count: 2
    config:
      node.roles: ["data_cold", "data_frozen"]
      node.attr.data: cold
    podTemplate:
      spec:
        initContainers:
        - name: sysctl
          securityContext:
            privileged: true
            runAsUser: 0
          command: ['sh', '-c', 'sysctl -w vm.max_map_count=262144']
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
        storageClassName: standard-hdd
        resources:
          requests:
            storage: 8Ti
```

## Section 2: Security Configuration

### TLS and Authentication

ECK automatically provisions and rotates TLS certificates. External access requires additional configuration:

```yaml
apiVersion: elasticsearch.k8s.elastic.co/v1
kind: Elasticsearch
metadata:
  name: production-logs
  namespace: logging
spec:
  version: 8.11.1

  # HTTP layer settings
  http:
    service:
      spec:
        type: ClusterIP  # Use ingress for external access
    tls:
      selfSignedCertificate:
        disabled: false
        subjectAltNames:
        - dns: elasticsearch.acme.corp
        - dns: production-logs-es-http.logging.svc.cluster.local
        - ip: 10.96.100.50

  # Transport layer (node-to-node) TLS
  transport:
    tls:
      subjectAltNames:
      - dns: "*.production-logs-es-transport.logging.svc"
      certificate:
        secretName: elasticsearch-transport-cert

  # Security configuration in elasticsearch.yml
  nodeSets:
  - name: combined
    config:
      # Security is always enabled in Elasticsearch 8.x
      xpack.security.enabled: true
      xpack.security.http.ssl.enabled: true
      xpack.security.transport.ssl.enabled: true
      # Audit logging
      xpack.security.audit.enabled: true
      xpack.security.audit.logfile.events.include:
      - access_denied
      - authentication_failed
      - realm_authentication_success
      - run_as_denied
      - tampered_request
      # FIPS compliance mode (optional)
      xpack.security.fips_mode.enabled: false
```

### Ingress for External Access

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: elasticsearch
  namespace: logging
  annotations:
    nginx.ingress.kubernetes.io/backend-protocol: "HTTPS"
    nginx.ingress.kubernetes.io/ssl-passthrough: "false"
    nginx.ingress.kubernetes.io/proxy-ssl-verify: "false"
    nginx.ingress.kubernetes.io/proxy-body-size: "100m"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "300"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "300"
    nginx.ingress.kubernetes.io/configuration-snippet: |
      proxy_ssl_session_reuse off;
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - elasticsearch.acme.corp
    secretName: elasticsearch-tls
  rules:
  - host: elasticsearch.acme.corp
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: production-logs-es-http
            port:
              number: 9200
```

### Elasticsearch Security Roles and Users

```bash
# Get the auto-generated elastic superuser password
ES_PASSWORD=$(kubectl get secret production-logs-es-elastic-user \
  -n logging \
  -o jsonpath='{.data.elastic}' | base64 -d)

ES_HOST="https://elasticsearch.acme.corp"

# Create roles for different access levels
curl -k -u "elastic:$ES_PASSWORD" -X PUT \
  "$ES_HOST/_security/role/logs_writer" \
  -H "Content-Type: application/json" \
  -d '{
    "cluster": ["monitor"],
    "indices": [{
      "names": ["logs-*", "metrics-*", "traces-*"],
      "privileges": ["write", "create_index", "view_index_metadata"]
    }]
  }'

curl -k -u "elastic:$ES_PASSWORD" -X PUT \
  "$ES_HOST/_security/role/logs_reader" \
  -H "Content-Type: application/json" \
  -d '{
    "cluster": ["monitor"],
    "indices": [{
      "names": ["logs-*", "metrics-*"],
      "privileges": ["read", "view_index_metadata"]
    }],
    "applications": [{
      "application": "kibana-.kibana",
      "privileges": ["read"],
      "resources": ["*"]
    }]
  }'

curl -k -u "elastic:$ES_PASSWORD" -X PUT \
  "$ES_HOST/_security/role/kibana_admin" \
  -H "Content-Type: application/json" \
  -d '{
    "cluster": ["monitor", "manage_ilm", "manage_index_templates"],
    "indices": [{"names": ["*"], "privileges": ["all"]}],
    "applications": [{
      "application": "kibana-.kibana",
      "privileges": ["all"],
      "resources": ["*"]
    }]
  }'

# Create service account for Fluentd
curl -k -u "elastic:$ES_PASSWORD" -X PUT \
  "$ES_HOST/_security/user/fluentd" \
  -H "Content-Type: application/json" \
  -d "{
    \"password\": \"$(openssl rand -base64 32)\",
    \"roles\": [\"logs_writer\"],
    \"full_name\": \"Fluentd Log Shipper\",
    \"email\": \"fluentd@acme.corp\"
  }"
```

### Role-Based Access Control with OIDC

```yaml
# Elasticsearch OIDC realm configuration
# Add to elasticsearch.yml via configmap

apiVersion: v1
kind: ConfigMap
metadata:
  name: elasticsearch-oidc-config
  namespace: logging
data:
  elasticsearch.yml: |
    xpack.security.authc.realms.oidc.oidc1:
      order: 2
      rp.client_id: elasticsearch-oidc
      rp.response_type: code
      rp.redirect_uri: "https://elasticsearch.acme.corp/_security/oidc/callback"
      op.issuer: "https://auth.acme.corp"
      op.authorization_endpoint: "https://auth.acme.corp/oauth2/authorize"
      op.token_endpoint: "https://auth.acme.corp/oauth2/token"
      op.userinfo_endpoint: "https://auth.acme.corp/oauth2/userinfo"
      op.endsession_endpoint: "https://auth.acme.corp/oauth2/logout"
      rp.post_logout_redirect_uri: "https://elasticsearch.acme.corp/logout"
      claims.principal: sub
      claims.groups: groups
      ssl.certificate_authorities: ["/usr/share/elasticsearch/config/certs/ca.crt"]
```

## Section 3: Index Lifecycle Management

### ILM Policy for Log Data

```bash
# Create ILM policy for log rotation
curl -k -u "elastic:$ES_PASSWORD" -X PUT \
  "$ES_HOST/_ilm/policy/logs-policy" \
  -H "Content-Type: application/json" \
  -d '{
    "policy": {
      "phases": {
        "hot": {
          "min_age": "0ms",
          "actions": {
            "rollover": {
              "max_primary_shard_size": "50gb",
              "max_age": "1d",
              "max_docs": 100000000
            },
            "set_priority": {
              "priority": 100
            },
            "forcemerge": {
              "max_num_segments": 1
            }
          }
        },
        "warm": {
          "min_age": "3d",
          "actions": {
            "set_priority": {
              "priority": 50
            },
            "allocate": {
              "require": {
                "data": "warm"
              }
            },
            "readonly": {},
            "forcemerge": {
              "max_num_segments": 1
            },
            "shrink": {
              "number_of_shards": 1,
              "allow_write_after_shrink": false
            }
          }
        },
        "cold": {
          "min_age": "30d",
          "actions": {
            "set_priority": {
              "priority": 0
            },
            "allocate": {
              "require": {
                "data": "cold"
              }
            },
            "freeze": {}
          }
        },
        "frozen": {
          "min_age": "90d",
          "actions": {
            "searchable_snapshot": {
              "snapshot_repository": "s3-logs-snapshots",
              "force_merge_index": true
            }
          }
        },
        "delete": {
          "min_age": "365d",
          "actions": {
            "delete": {
              "delete_searchable_snapshot": true
            }
          }
        }
      }
    }
  }'
```

### Index Template

```bash
# Create index template for log data
curl -k -u "elastic:$ES_PASSWORD" -X PUT \
  "$ES_HOST/_index_template/logs" \
  -H "Content-Type: application/json" \
  -d '{
    "index_patterns": ["logs-*"],
    "data_stream": {},
    "template": {
      "settings": {
        "index": {
          "lifecycle": {
            "name": "logs-policy"
          },
          "number_of_shards": 3,
          "number_of_replicas": 1,
          "refresh_interval": "10s",
          "codec": "best_compression",
          "routing": {
            "allocation": {
              "require": {
                "data": "hot"
              }
            }
          },
          "mapping": {
            "total_fields": {
              "limit": 2000
            }
          }
        }
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
          },
          {
            "long_fields": {
              "match_mapping_type": "long",
              "mapping": {
                "type": "long"
              }
            }
          }
        ],
        "properties": {
          "@timestamp": {
            "type": "date",
            "format": "strict_date_optional_time||epoch_millis"
          },
          "message": {
            "type": "text",
            "fields": {
              "keyword": {
                "type": "keyword",
                "ignore_above": 1024
              }
            }
          },
          "kubernetes": {
            "properties": {
              "namespace": {"type": "keyword"},
              "pod": {"type": "keyword"},
              "node": {"type": "keyword"},
              "container": {"type": "keyword"},
              "labels": {"type": "flattened"},
              "annotations": {"type": "flattened"}
            }
          },
          "log": {
            "properties": {
              "level": {"type": "keyword"},
              "logger": {"type": "keyword"},
              "file": {"type": "keyword"}
            }
          },
          "trace": {
            "properties": {
              "id": {"type": "keyword"},
              "transaction": {
                "properties": {
                  "id": {"type": "keyword"}
                }
              }
            }
          }
        }
      }
    },
    "priority": 200
  }'

# Initialize the data stream
curl -k -u "elastic:$ES_PASSWORD" -X PUT \
  "$ES_HOST/_data_stream/logs-production"
```

## Section 4: Snapshot Repository Configuration

### S3 Snapshot Repository

```bash
# Configure S3 snapshot repository
# First, store S3 credentials in Elasticsearch keystore
kubectl exec -n logging \
  $(kubectl get pod -n logging -l elasticsearch.k8s.elastic.co/cluster-name=production-logs -o name | head -1) \
  -- elasticsearch-keystore add s3.client.default.access_key <<< "$AWS_ACCESS_KEY_ID"

kubectl exec -n logging \
  $(kubectl get pod -n logging -l elasticsearch.k8s.elastic.co/cluster-name=production-logs -o name | head -1) \
  -- elasticsearch-keystore add s3.client.default.secret_key <<< "$AWS_SECRET_ACCESS_KEY"

# Register the repository
curl -k -u "elastic:$ES_PASSWORD" -X PUT \
  "$ES_HOST/_snapshot/s3-logs-snapshots" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "s3",
    "settings": {
      "bucket": "acme-elasticsearch-snapshots",
      "region": "us-east-1",
      "base_path": "production-logs",
      "compress": true,
      "server_side_encryption": true,
      "storage_class": "intelligent_tiering",
      "max_snapshot_bytes_per_sec": "500mb",
      "max_restore_bytes_per_sec": "500mb",
      "chunk_size": "1gb"
    }
  }'

# Verify repository
curl -k -u "elastic:$ES_PASSWORD" \
  "$ES_HOST/_snapshot/s3-logs-snapshots/_verify"
```

### Automated Snapshot Policy (SLM)

```bash
# Create Snapshot Lifecycle Management policy
curl -k -u "elastic:$ES_PASSWORD" -X PUT \
  "$ES_HOST/_slm/policy/daily-snapshots" \
  -H "Content-Type: application/json" \
  -d '{
    "schedule": "0 30 1 * * ?",
    "name": "<daily-snap-{now/d}>",
    "repository": "s3-logs-snapshots",
    "config": {
      "indices": ["logs-*", "metrics-*"],
      "ignore_unavailable": true,
      "include_global_state": false,
      "partial": false,
      "metadata": {
        "taken_by": "slm",
        "taken_because": "scheduled daily backup"
      }
    },
    "retention": {
      "expire_after": "30d",
      "min_count": 5,
      "max_count": 50
    }
  }'

# Trigger a snapshot immediately for testing
curl -k -u "elastic:$ES_PASSWORD" -X POST \
  "$ES_HOST/_slm/policy/daily-snapshots/_execute"

# Check snapshot status
curl -k -u "elastic:$ES_PASSWORD" \
  "$ES_HOST/_snapshot/s3-logs-snapshots/_current"
```

## Section 5: Performance Tuning

### Cluster Settings for High Ingest

```bash
# Apply cluster-level settings for high ingest workloads
curl -k -u "elastic:$ES_PASSWORD" -X PUT \
  "$ES_HOST/_cluster/settings" \
  -H "Content-Type: application/json" \
  -d '{
    "persistent": {
      "cluster": {
        "routing": {
          "allocation": {
            "disk": {
              "threshold_enabled": true,
              "watermark": {
                "low": "85%",
                "high": "90%",
                "flood_stage": "95%"
              }
            },
            "balance": {
              "shard": "0.45",
              "index": "0.55",
              "threshold": "1.0"
            },
            "node_concurrent_incoming_recoveries": "4",
            "node_concurrent_outgoing_recoveries": "4"
          }
        }
      },
      "indices": {
        "recovery": {
          "max_bytes_per_sec": "400mb"
        }
      },
      "search": {
        "max_buckets": "100000"
      },
      "action": {
        "destructive_requires_name": true
      }
    }
  }'
```

### JVM and Thread Pool Tuning

```yaml
# Per-node type JVM settings via ECK
# Hot nodes - optimized for indexing
config:
  node.roles: ["data_hot", "ingest"]
  # Thread pool sizing
  thread_pool.write.queue_size: 1000
  thread_pool.write.size: 16
  thread_pool.search.queue_size: 1000
  thread_pool.search.size: 13  # (number_of_vcpus * 3) / 2 + 1
  thread_pool.get.queue_size: 1000
  # Memory locking
  bootstrap.memory_lock: true
  # Indexing settings
  indices.memory.index_buffer_size: "20%"
  indices.memory.min_index_buffer_size: "128mb"
  indices.recovery.max_bytes_per_sec: "200mb"
```

### Index-Level Performance Settings

```bash
# Tune specific data stream settings for high ingest
curl -k -u "elastic:$ES_PASSWORD" -X PUT \
  "$ES_HOST/logs-production/_settings" \
  -H "Content-Type: application/json" \
  -d '{
    "index": {
      "refresh_interval": "30s",
      "number_of_replicas": 1,
      "translog": {
        "durability": "async",
        "sync_interval": "5s",
        "flush_threshold_size": "1gb"
      },
      "merge": {
        "scheduler": {
          "max_thread_count": "1"
        },
        "policy": {
          "max_merge_at_once": "10",
          "segments_per_tier": "10",
          "max_merged_segment": "5gb"
        }
      },
      "indexing": {
        "slowlog": {
          "threshold": {
            "index": {
              "warn": "10s",
              "info": "5s",
              "debug": "2s",
              "trace": "500ms"
            }
          }
        }
      }
    }
  }'
```

## Section 6: Shard Allocation and Management

### Shard Sizing Best Practices

```bash
# Check current shard sizes
curl -k -u "elastic:$ES_PASSWORD" \
  "$ES_HOST/_cat/shards?v&h=index,shard,prirep,state,docs,store&s=store:desc" | head -30

# Check node disk usage
curl -k -u "elastic:$ES_PASSWORD" \
  "$ES_HOST/_cat/allocation?v&h=node,disk.used,disk.avail,disk.percent,shards"

# Force shard rebalancing if allocation is uneven
curl -k -u "elastic:$ES_PASSWORD" -X POST \
  "$ES_HOST/_cluster/reroute?retry_failed=true"

# Move a shard manually (for maintenance)
curl -k -u "elastic:$ES_PASSWORD" -X POST \
  "$ES_HOST/_cluster/reroute" \
  -H "Content-Type: application/json" \
  -d '{
    "commands": [{
      "move": {
        "index": "logs-production-2024.01.15",
        "shard": 0,
        "from_node": "production-logs-es-hot-0",
        "to_node": "production-logs-es-hot-1"
      }
    }]
  }'
```

### Shard Allocation Awareness

```yaml
# Configure zone-aware shard allocation in Elasticsearch
config:
  cluster.routing.allocation.awareness.attributes: zone
  cluster.routing.allocation.awareness.force.zone.values: us-east-1a,us-east-1b,us-east-1c

# Each pod must report its zone
env:
- name: ZONE
  valueFrom:
    fieldRef:
      fieldPath: metadata.annotations['topology.kubernetes.io/zone']
      # Requires node that adds this annotation, or:
      # metadata.labels['topology.kubernetes.io/zone']
```

## Section 7: Kibana Deployment

```yaml
apiVersion: kibana.k8s.elastic.co/v1
kind: Kibana
metadata:
  name: production-kibana
  namespace: logging
spec:
  version: 8.11.1
  count: 3  # HA deployment
  elasticsearchRef:
    name: production-logs

  config:
    server.publicBaseUrl: "https://kibana.acme.corp"
    # Logging
    logging.appenders.default:
      type: console
      layout:
        type: json
    logging.root.level: info
    # Performance
    ops.interval: 5000
    xpack.reporting.queue.timeout: 120000
    # Spaces for multi-tenancy
    xpack.spaces.enabled: true
    # Fleet Server (for agent management)
    xpack.fleet.enabled: true
    xpack.fleet.packages:
    - name: system
      version: latest
    - name: kubernetes
      version: latest

  http:
    tls:
      selfSignedCertificate:
        subjectAltNames:
        - dns: kibana.acme.corp

  podTemplate:
    spec:
      containers:
      - name: kibana
        resources:
          requests:
            cpu: 500m
            memory: 2Gi
          limits:
            cpu: "2"
            memory: 4Gi
        env:
        - name: NODE_OPTIONS
          value: "--max-old-space-size=2048"
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchLabels:
                  kibana.k8s.elastic.co/name: production-kibana
              topologyKey: kubernetes.io/hostname
```

## Section 8: Fluentd Integration

### Fluentd DaemonSet for Log Collection

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: fluentd-config
  namespace: logging
data:
  fluent.conf: |
    # Input: collect from all containers
    <source>
      @type tail
      path /var/log/containers/*.log
      pos_file /var/log/fluentd-containers.log.pos
      tag kubernetes.*
      read_from_head false
      <parse>
        @type json
        time_format %Y-%m-%dT%H:%M:%S.%NZ
        time_key time
        time_type string
        utc true
      </parse>
    </source>

    # Filter: add Kubernetes metadata
    <filter kubernetes.**>
      @type kubernetes_metadata
      @id filter_kubernetes_metadata
      watch false
      skip_labels false
      skip_container_metadata false
      skip_master_url false
    </filter>

    # Filter: parse nested JSON messages
    <filter kubernetes.**>
      @type parser
      key_name log
      reserve_data true
      remove_key_name_field false
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

    # Filter: add cluster metadata
    <filter kubernetes.**>
      @type record_transformer
      enable_ruby true
      <record>
        cluster_name "#{ENV['CLUSTER_NAME']}"
        cluster_region "#{ENV['CLUSTER_REGION']}"
        @timestamp ${time.strftime('%Y-%m-%dT%H:%M:%S.%3NZ')}
      </record>
    </filter>

    # Route: separate by namespace
    <match kubernetes.**>
      @type rewrite_tag_filter
      <rule>
        key $.kubernetes.namespace_name
        pattern ^kube-system$
        tag infrastructure.kube-system
      </rule>
      <rule>
        key $.kubernetes.namespace_name
        pattern ^(monitoring|logging)$
        tag infrastructure.platform
      </rule>
      <rule>
        key $.kubernetes.namespace_name
        pattern ^(.+)$
        tag application.${tag_parts[1]}
      </rule>
    </match>

    # Output: application logs to Elasticsearch data stream
    <match application.**>
      @type elasticsearch_data_stream
      @id out_es_application
      data_stream_name "logs-production"
      host "#{ENV['ELASTICSEARCH_HOST']}"
      port 9200
      scheme https
      ssl_verify false
      user "#{ENV['ELASTICSEARCH_USER']}"
      password "#{ENV['ELASTICSEARCH_PASSWORD']}"
      
      # Buffering for reliability
      <buffer>
        @type file
        path /var/log/fluentd-buffers/application
        flush_mode interval
        retry_type exponential_backoff
        flush_thread_count 4
        flush_interval 5s
        retry_forever false
        retry_max_interval 30
        chunk_limit_size 32M
        total_limit_size 512M
        overflow_action block
      </buffer>

      # Retry on transient errors
      retry_limit 3
      
      # Log ingestion performance
      reconnect_on_error true
      reload_on_failure true
      reload_connections false
    </match>

    # Output: infrastructure logs to separate stream
    <match infrastructure.**>
      @type elasticsearch_data_stream
      data_stream_name "logs-infrastructure"
      host "#{ENV['ELASTICSEARCH_HOST']}"
      port 9200
      scheme https
      ssl_verify false
      user "#{ENV['ELASTICSEARCH_USER']}"
      password "#{ENV['ELASTICSEARCH_PASSWORD']}"
      <buffer>
        @type file
        path /var/log/fluentd-buffers/infrastructure
        flush_interval 10s
        chunk_limit_size 16M
        total_limit_size 256M
      </buffer>
    </match>
---
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: fluentd
  namespace: logging
  labels:
    app: fluentd
spec:
  selector:
    matchLabels:
      app: fluentd
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
  template:
    metadata:
      labels:
        app: fluentd
    spec:
      serviceAccountName: fluentd
      tolerations:
      - operator: Exists
        effect: NoSchedule
      - operator: Exists
        effect: NoExecute
      containers:
      - name: fluentd
        image: fluent/fluentd-kubernetes-daemonset:v1.16.2-debian-elasticsearch8-1.0
        env:
        - name: ELASTICSEARCH_HOST
          value: "production-logs-es-http.logging.svc.cluster.local"
        - name: ELASTICSEARCH_USER
          value: "fluentd"
        - name: ELASTICSEARCH_PASSWORD
          valueFrom:
            secretKeyRef:
              name: fluentd-elasticsearch-credentials
              key: password
        - name: CLUSTER_NAME
          value: "production-us-east-1"
        - name: CLUSTER_REGION
          value: "us-east-1"
        resources:
          requests:
            cpu: 200m
            memory: 512Mi
          limits:
            cpu: "1"
            memory: 1Gi
        volumeMounts:
        - name: varlog
          mountPath: /var/log
        - name: varlibdockercontainers
          mountPath: /var/lib/docker/containers
          readOnly: true
        - name: config
          mountPath: /fluentd/etc/fluent.conf
          subPath: fluent.conf
        - name: buffer
          mountPath: /var/log/fluentd-buffers
        livenessProbe:
          httpGet:
            path: /metrics
            port: 24231
          initialDelaySeconds: 60
          periodSeconds: 30
        readinessProbe:
          httpGet:
            path: /metrics
            port: 24231
          initialDelaySeconds: 30
          periodSeconds: 10
      volumes:
      - name: varlog
        hostPath:
          path: /var/log
      - name: varlibdockercontainers
        hostPath:
          path: /var/lib/docker/containers
      - name: config
        configMap:
          name: fluentd-config
      - name: buffer
        hostPath:
          path: /var/log/fluentd-buffers
```

## Section 9: Monitoring Elasticsearch

### Elasticsearch Prometheus Exporter

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: elasticsearch-exporter
  namespace: logging
spec:
  replicas: 1
  selector:
    matchLabels:
      app: elasticsearch-exporter
  template:
    metadata:
      labels:
        app: elasticsearch-exporter
    spec:
      containers:
      - name: exporter
        image: prometheuscommunity/elasticsearch-exporter:v1.7.0
        args:
        - --es.uri=https://$(ELASTICSEARCH_USER):$(ELASTICSEARCH_PASSWORD)@production-logs-es-http.logging.svc.cluster.local:9200
        - --es.ssl-skip-verify
        - --es.all
        - --es.indices
        - --es.shards
        - --es.cluster_settings
        - --collector.snapshots
        - --collector.ilm
        - --web.listen-address=:9114
        - --web.telemetry-path=/metrics
        env:
        - name: ELASTICSEARCH_USER
          value: "elastic"
        - name: ELASTICSEARCH_PASSWORD
          valueFrom:
            secretKeyRef:
              name: production-logs-es-elastic-user
              key: elastic
        ports:
        - containerPort: 9114
          name: metrics
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 256Mi
---
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: elasticsearch
  namespace: logging
spec:
  endpoints:
  - port: metrics
    interval: 30s
    path: /metrics
  selector:
    matchLabels:
      app: elasticsearch-exporter
```

### Critical Prometheus Alert Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: elasticsearch-alerts
  namespace: monitoring
spec:
  groups:
  - name: elasticsearch
    rules:
    - alert: ElasticsearchClusterRed
      expr: elasticsearch_cluster_health_status{color="red"} == 1
      for: 2m
      labels:
        severity: critical
      annotations:
        summary: "Elasticsearch cluster {{ $labels.cluster }} is RED"
        description: "At least one primary shard is unassigned. Data may be unavailable."

    - alert: ElasticsearchClusterYellow
      expr: elasticsearch_cluster_health_status{color="yellow"} == 1
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Elasticsearch cluster {{ $labels.cluster }} is YELLOW"
        description: "At least one replica shard is unassigned. Redundancy is reduced."

    - alert: ElasticsearchDiskSpaceHigh
      expr: elasticsearch_filesystem_data_available_bytes / elasticsearch_filesystem_data_size_bytes < 0.15
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Elasticsearch node {{ $labels.node }} disk space is low"
        description: "Less than 15% disk space remaining on {{ $labels.node }}."

    - alert: ElasticsearchJVMHeapHigh
      expr: elasticsearch_jvm_memory_used_bytes{area="heap"} / elasticsearch_jvm_memory_max_bytes{area="heap"} > 0.90
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Elasticsearch node {{ $labels.node }} JVM heap is above 90%"
        description: "High JVM heap usage may lead to garbage collection pauses and OOMKill."

    - alert: ElasticsearchIndexingRateAnomaly
      expr: |
        rate(elasticsearch_indices_indexing_index_total[5m]) < 0.1
        and
        elasticsearch_cluster_health_status{color="green"} == 1
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "Elasticsearch indexing rate is very low"
        description: "Possible log pipeline failure - less than 1 doc/10sec being indexed."
```

## Section 10: Operational Runbooks

### Cluster Health Recovery

```bash
#!/bin/bash
# es-health-check.sh - Diagnose Elasticsearch cluster issues

ES_URL="https://elasticsearch.acme.corp"
ES_USER="elastic"
ES_PASS=$(kubectl get secret production-logs-es-elastic-user \
  -n logging -o jsonpath='{.data.elastic}' | base64 -d)

echo "=== Elasticsearch Health Diagnosis ==="

# Cluster health overview
echo "Cluster health:"
curl -sk -u "$ES_USER:$ES_PASS" "$ES_URL/_cluster/health?pretty"

# Unassigned shards
echo ""
echo "Unassigned shards:"
curl -sk -u "$ES_USER:$ES_PASS" \
  "$ES_URL/_cat/shards?h=index,shard,prirep,state,node,reason&s=state:desc" | \
  grep -v STARTED | head -20

# Explain why shards are not allocated
echo ""
echo "Shard allocation explanation:"
curl -sk -u "$ES_USER:$ES_PASS" \
  "$ES_URL/_cluster/allocation/explain?pretty" 2>/dev/null | head -50

# Node statistics
echo ""
echo "Node disk usage:"
curl -sk -u "$ES_USER:$ES_PASS" \
  "$ES_URL/_cat/nodes?v&h=name,disk.used,disk.avail,disk.percent,heap.percent,cpu,load_1m"

# Pending tasks
echo ""
echo "Pending cluster tasks:"
curl -sk -u "$ES_USER:$ES_PASS" \
  "$ES_URL/_cluster/pending_tasks?pretty" | head -30

# ILM status
echo ""
echo "ILM policy status:"
curl -sk -u "$ES_USER:$ES_PASS" \
  "$ES_URL/_ilm/status"
```

## Summary

Production Elasticsearch on Kubernetes with ECK requires careful attention to:

1. Hot-warm-cold node topology to balance ingest performance against storage cost, using node attribute routing to direct ILM phase migrations
2. Dedicated master nodes (minimum 3) to maintain cluster state without competing with data node I/O
3. ECK operator manages TLS certificate rotation, rolling upgrades, and configuration reconciliation automatically
4. ILM policies should include rollover (prevent oversized shards), shrink (reduce shard count), freeze, searchable snapshots, and delete phases
5. S3 snapshot repositories with SLM policies provide durable backup with configurable retention
6. Security must include TLS (provided by ECK), role-based access control, and audit logging for compliance
7. JVM heap should be set to 50% of available memory with a maximum of 31GB (above this G1GC performance degrades)
8. sysctl `vm.max_map_count=262144` must be set on every node hosting Elasticsearch pods
9. Fluentd DaemonSet with buffered output to data streams provides reliable log delivery with backpressure handling
10. Prometheus alerting for cluster status (red/yellow), disk space, and JVM heap prevents silent failures from becoming incidents
