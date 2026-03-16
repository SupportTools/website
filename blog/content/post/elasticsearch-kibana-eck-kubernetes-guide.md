---
title: "Elasticsearch and Kibana on Kubernetes with ECK: Production Cluster Management"
date: 2027-07-19T00:00:00-05:00
draft: false
tags: ["Elasticsearch", "Kibana", "ECK", "Kubernetes", "Observability", "Search"]
categories:
- Elasticsearch
- Kubernetes
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to running Elasticsearch and Kibana on Kubernetes with the Elastic Cloud on Kubernetes (ECK) operator, covering node roles, hot-warm-cold architecture, index lifecycle management, snapshot repositories, Fleet server, Elastic Agent, X-Pack security, and autoscaling policies."
more_link: "yes"
url: "/elasticsearch-kibana-eck-kubernetes-guide/"
---

The Elastic Cloud on Kubernetes (ECK) operator is the production-supported method for running Elasticsearch, Kibana, Logstash, Elastic Agent, and Fleet Server on Kubernetes. ECK handles TLS certificate management, rolling upgrades, node configuration, X-Pack license provisioning, and the complex coordination required for Elasticsearch node role transitions. This guide builds a production-grade Elasticsearch cluster with hot-warm-cold tiering, index lifecycle management, snapshot backups, and the full Elastic observability stack.

<!--more-->

# Elasticsearch and Kibana on Kubernetes with ECK: Production Cluster Management

## Section 1: ECK Operator Architecture

ECK runs a single operator Deployment that watches CRDs across all namespaces (or scoped namespaces). The operator manages:

- **Elasticsearch** CRD — cluster node topology, storage, resources, and configuration
- **Kibana** CRD — Kibana Deployment with automatic Elasticsearch backend association
- **Beat** CRD — Filebeat and Metricbeat DaemonSets for log/metric collection
- **Agent** CRD — Elastic Agent with Fleet Server for centralized policy management
- **Logstash** CRD — Logstash pipelines for data transformation
- **ElasticsearchAutoscaler** CRD — dynamic node count and storage scaling

ECK generates self-signed TLS certificates for all inter-component communication, automatically rotates them, and stores them in Kubernetes Secrets. The `elastic` superuser password is generated on first deployment and stored in a Secret named `<cluster-name>-es-elastic-user`.

### Installation

```bash
# Install ECK operator via Helm
helm repo add elastic https://helm.elastic.co
helm repo update

helm upgrade --install elastic-operator elastic/eck-operator \
  --namespace elastic-system \
  --create-namespace \
  --set managedNamespaces="{elastic}" \
  --set config.logVerbosity=0 \
  --set resources.limits.memory=512Mi \
  --set resources.requests.memory=512Mi \
  --version 2.13.0

kubectl -n elastic-system get pods
kubectl get crd | grep elastic.co
```

---

## Section 2: Elasticsearch CR with Node Roles

The `Elasticsearch` CRD defines the cluster topology using node sets, each corresponding to a StatefulSet. Each node set specifies the Elasticsearch node roles via the `node.roles` configuration parameter.

### Node Role Reference

| Role | Responsibility |
|---|---|
| `master` | Cluster state management, index creation/deletion |
| `data` | Data storage and search |
| `data_hot` | Hot tier — active write and search target |
| `data_warm` | Warm tier — recent data, less frequent queries |
| `data_cold` | Cold tier — older data, infrequent queries |
| `data_frozen` | Frozen tier — rarely accessed, searchable snapshots |
| `ingest` | Document pre-processing pipelines |
| `coordinating` (no roles) | Request routing, result aggregation |
| `ml` | Machine learning workloads |
| `remote_cluster_client` | Cross-cluster search/replication |

### Production Cluster with Dedicated Roles

```yaml
apiVersion: elasticsearch.k8s.elastic.co/v1
kind: Elasticsearch
metadata:
  name: elastic-prod
  namespace: elastic
spec:
  version: 8.14.0
  nodeSets:
  # Dedicated master nodes — 3 for quorum
  - name: master
    count: 3
    config:
      node.roles: ["master"]
      cluster.routing.allocation.disk.threshold_enabled: true
      cluster.routing.allocation.disk.watermark.low: "85%"
      cluster.routing.allocation.disk.watermark.high: "90%"
      cluster.routing.allocation.disk.watermark.flood_stage: "95%"
      xpack.monitoring.collection.enabled: true
    podTemplate:
      spec:
        affinity:
          podAntiAffinity:
            requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  elasticsearch.k8s.elastic.co/node-name: master
              topologyKey: kubernetes.io/hostname
        nodeSelector:
          role: elasticsearch-master
        tolerations:
        - key: elasticsearch
          operator: Equal
          value: master
          effect: NoSchedule
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
              cpu: "500m"
            limits:
              memory: 2Gi
              cpu: "2"
          env:
          - name: ES_JAVA_OPTS
            value: "-Xms1g -Xmx1g"
    volumeClaimTemplates:
    - metadata:
        name: elasticsearch-data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 20Gi
        storageClassName: gp3-encrypted

  # Hot data nodes — write and active search target
  - name: data-hot
    count: 3
    config:
      node.roles: ["data_hot", "data_content", "ingest"]
      node.attr.data: hot
      indices.memory.index_buffer_size: "30%"
      thread_pool.write.queue_size: 1000
    podTemplate:
      spec:
        affinity:
          podAntiAffinity:
            requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  elasticsearch.k8s.elastic.co/node-name: data-hot
              topologyKey: kubernetes.io/hostname
        nodeSelector:
          role: elasticsearch-hot
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
        resources:
          requests:
            storage: 1Ti
        storageClassName: gp3-encrypted

  # Warm data nodes — recent but less active data
  - name: data-warm
    count: 3
    config:
      node.roles: ["data_warm"]
      node.attr.data: warm
      indices.recovery.max_bytes_per_sec: "200mb"
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
        resources:
          requests:
            storage: 2Ti
        storageClassName: st1-encrypted   # Throughput-optimized, lower cost

  # Cold data nodes — older, infrequent data
  - name: data-cold
    count: 2
    config:
      node.roles: ["data_cold"]
      node.attr.data: cold
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
        resources:
          requests:
            storage: 4Ti
        storageClassName: sc1-encrypted   # Cold HDD storage

  # Coordinating-only nodes — query routing and aggregation
  - name: coordinating
    count: 2
    config:
      node.roles: []   # No roles = coordinating-only
    podTemplate:
      spec:
        containers:
        - name: elasticsearch
          resources:
            requests:
              memory: 4Gi
              cpu: "2"
            limits:
              memory: 4Gi
              cpu: "4"
          env:
          - name: ES_JAVA_OPTS
            value: "-Xms2g -Xmx2g"
    volumeClaimTemplates:
    - metadata:
        name: elasticsearch-data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 10Gi
        storageClassName: gp3-encrypted

  http:
    tls:
      selfSignedCertificate:
        subjectAltNames:
        - ip: 10.0.0.1
        - dns: elasticsearch.elastic.svc.cluster.local

  podDisruptionBudget:
    spec:
      minAvailable: 2
      selector:
        matchLabels:
          elasticsearch.k8s.elastic.co/cluster-name: elastic-prod
```

---

## Section 3: Storage Sizing and Tiering

### Storage Calculator

Elasticsearch storage requirements:

```
Required Storage = Raw Data Size
                 × Replication Factor (typically 1.5 for 1 replica)
                 × Index Overhead (1.45 to account for segments, translog, etc.)
                 × Safety Buffer (1.1)
```

For 1 TB of raw log data with 1 replica:
`1 TB × 1.5 × 1.45 × 1.1 ≈ 2.4 TB`

### Storage Class Selection by Tier

| Tier | AWS Storage Class | Characteristic | Use Case |
|---|---|---|---|
| Hot | `gp3` | Low latency, high IOPS | Active writes and searches |
| Warm | `st1` | Sequential throughput | Recent data, range queries |
| Cold | `sc1` | Low cost, low IOPS | Archival, compliance |
| Frozen | `s3` (via searchable snapshots) | Near-zero per-GB cost | Rare queries |

### Forcing Specific IOPS for Hot Nodes

```yaml
volumeClaimTemplates:
- metadata:
    name: elasticsearch-data
  spec:
    accessModes: ["ReadWriteOnce"]
    storageClassName: gp3-iops-provisioned
    resources:
      requests:
        storage: 1Ti
    # Annotation to provision 6000 IOPS (gp3 can deliver up to 16000)
    # Set via StorageClass parameters
```

---

## Section 4: Index Lifecycle Management

ILM automates index management across the hot-warm-cold-delete pipeline.

### ILM Policy via Kibana Dev Tools

```json
PUT _ilm/policy/logs-standard
{
  "policy": {
    "phases": {
      "hot": {
        "min_age": "0ms",
        "actions": {
          "rollover": {
            "max_primary_shard_size": "50gb",
            "max_age": "1d",
            "max_docs": 50000000
          },
          "set_priority": {
            "priority": 100
          }
        }
      },
      "warm": {
        "min_age": "2d",
        "actions": {
          "migrate": {
            "enabled": true
          },
          "shrink": {
            "number_of_shards": 1
          },
          "forcemerge": {
            "max_num_segments": 1
          },
          "set_priority": {
            "priority": 50
          }
        }
      },
      "cold": {
        "min_age": "14d",
        "actions": {
          "migrate": {
            "enabled": true
          },
          "set_priority": {
            "priority": 0
          },
          "freeze": {}
        }
      },
      "frozen": {
        "min_age": "60d",
        "actions": {
          "searchable_snapshot": {
            "snapshot_repository": "s3-snapshots",
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
}
```

### Index Template with ILM Policy

```json
PUT _index_template/logs-template
{
  "index_patterns": ["logs-*"],
  "data_stream": {},
  "template": {
    "settings": {
      "index.lifecycle.name": "logs-standard",
      "index.routing.allocation.require.data": "hot",
      "number_of_shards": 1,
      "number_of_replicas": 1,
      "refresh_interval": "5s",
      "index.codec": "best_compression"
    },
    "mappings": {
      "dynamic": true,
      "_source": {
        "enabled": true
      },
      "properties": {
        "@timestamp": {
          "type": "date"
        },
        "message": {
          "type": "text",
          "fields": {
            "keyword": {
              "type": "keyword",
              "ignore_above": 256
            }
          }
        },
        "level": {
          "type": "keyword"
        },
        "service": {
          "type": "keyword"
        },
        "kubernetes": {
          "type": "object",
          "properties": {
            "namespace": {"type": "keyword"},
            "pod": {"type": "keyword"},
            "container": {"type": "keyword"}
          }
        }
      }
    }
  },
  "priority": 100
}
```

---

## Section 5: Snapshot Repositories

Snapshots provide point-in-time backups and are required for searchable snapshots in the frozen tier.

### S3 Snapshot Repository

```yaml
apiVersion: elasticsearch.k8s.elastic.co/v1
kind: Elasticsearch
metadata:
  name: elastic-prod
  namespace: elastic
spec:
  # ... node sets ...
  secureSettings:
  - secretName: s3-snapshot-credentials
```

Create the credentials secret:

```bash
kubectl -n elastic create secret generic s3-snapshot-credentials \
  --from-literal=s3.client.default.access_key="<your-access-key>" \
  --from-literal=s3.client.default.secret_key="<your-secret-key>"
```

Register the repository via the Elasticsearch API:

```bash
# Get the elastic user password
ELASTIC_PASS=$(kubectl -n elastic get secret \
  elastic-prod-es-elastic-user \
  -o jsonpath='{.data.elastic}' | base64 -d)

# Port-forward to Elasticsearch
kubectl -n elastic port-forward svc/elastic-prod-es-http 9200:9200 &

# Register S3 snapshot repository
curl -k -u "elastic:$ELASTIC_PASS" \
  -X PUT "https://localhost:9200/_snapshot/s3-snapshots" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "s3",
    "settings": {
      "bucket": "my-elasticsearch-snapshots",
      "region": "us-east-1",
      "base_path": "elastic-prod",
      "compress": true,
      "server_side_encryption": true
    }
  }'
```

### Scheduled Snapshot Policy (SLM)

```bash
curl -k -u "elastic:$ELASTIC_PASS" \
  -X PUT "https://localhost:9200/_slm/policy/daily-snapshots" \
  -H "Content-Type: application/json" \
  -d '{
    "schedule": "0 30 1 * * ?",
    "name": "<daily-snap-{now/d}>",
    "repository": "s3-snapshots",
    "config": {
      "indices": ["*"],
      "ignore_unavailable": true,
      "include_global_state": true
    },
    "retention": {
      "expire_after": "30d",
      "min_count": 5,
      "max_count": 50
    }
  }'
```

### GCS Snapshot Repository

```bash
kubectl -n elastic create secret generic gcs-snapshot-credentials \
  --from-file=gcs.client.default.credentials_file=service-account.json

curl -k -u "elastic:$ELASTIC_PASS" \
  -X PUT "https://localhost:9200/_snapshot/gcs-snapshots" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "gcs",
    "settings": {
      "bucket": "my-elasticsearch-snapshots",
      "base_path": "elastic-prod",
      "compress": true
    }
  }'
```

---

## Section 6: Kibana Deployment

```yaml
apiVersion: kibana.k8s.elastic.co/v1
kind: Kibana
metadata:
  name: kibana-prod
  namespace: elastic
spec:
  version: 8.14.0
  count: 2
  elasticsearchRef:
    name: elastic-prod
  config:
    server.publicBaseUrl: "https://kibana.example.com"
    xpack.fleet.outputs:
    - id: fleet-default-output
      name: default
      is_default: true
      is_default_monitoring: true
      type: elasticsearch
      hosts:
      - "https://elastic-prod-es-http:9200"
      ssl:
        certificate_authorities:
        - "/mnt/elastic-internal/elasticsearch-association/elastic/elastic-prod/certs/ca.crt"
    xpack.fleet.packages:
    - name: system
      version: latest
    - name: elastic_agent
      version: latest
    - name: fleet_server
      version: latest
    - name: kubernetes
      version: latest
    xpack.fleet.agentPolicies:
    - name: Fleet Server Policy
      id: fleet-server-policy
      is_default_fleet_server: true
      package_policies:
      - name: fleet_server-1
        id: default-fleet-server
        package:
          name: fleet_server
    - name: Kubernetes Agent Policy
      id: kubernetes-agent-policy
      is_default: true
      namespace: default
      monitoring_enabled:
      - logs
      - metrics
      unenroll_timeout: 900
      package_policies:
      - name: system-1
        id: default-system
        package:
          name: system
      - name: kubernetes-1
        id: default-kubernetes
        package:
          name: kubernetes
    xpack.reporting.roles.enabled: false
    xpack.security.cookieName: kibana-prod-session
    logging.root.level: warn
  http:
    tls:
      selfSignedCertificate:
        subjectAltNames:
        - dns: kibana.example.com
  podTemplate:
    spec:
      containers:
      - name: kibana
        resources:
          requests:
            memory: 1Gi
            cpu: "500m"
          limits:
            memory: 2Gi
            cpu: "2"
  podDisruptionBudget:
    spec:
      minAvailable: 1
```

### Kibana Ingress

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: kibana
  namespace: elastic
  annotations:
    nginx.ingress.kubernetes.io/backend-protocol: "HTTPS"
    nginx.ingress.kubernetes.io/ssl-passthrough: "true"
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
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
            name: kibana-prod-kb-http
            port:
              number: 5601
```

---

## Section 7: Filebeat and Metricbeat via DaemonSet

### Filebeat via Beat CRD

```yaml
apiVersion: beat.k8s.elastic.co/v1beta1
kind: Beat
metadata:
  name: filebeat-prod
  namespace: elastic
spec:
  type: filebeat
  version: 8.14.0
  elasticsearchRef:
    name: elastic-prod
  kibanaRef:
    name: kibana-prod
  config:
    filebeat.autodiscover:
      providers:
      - type: kubernetes
        node: ${NODE_NAME}
        hints.enabled: true
        hints.default_config:
          type: container
          paths:
          - /var/log/containers/*${data.kubernetes.container.id}.log
          multiline.type: pattern
          multiline.pattern: '^[[:space:]]'
          multiline.negate: false
          multiline.match: after
    processors:
    - add_cloud_metadata: {}
    - add_host_metadata: {}
    - add_kubernetes_metadata:
        host: ${NODE_NAME}
        matchers:
        - logs_path:
            logs_path: "/var/log/containers/"
    - drop_fields:
        fields: ["agent.ephemeral_id", "log.offset"]
        ignore_missing: true
    output.elasticsearch:
      hosts: []    # Populated automatically by ECK
  daemonSet:
    podTemplate:
      spec:
        serviceAccount: filebeat
        automountServiceAccountToken: true
        terminationGracePeriodSeconds: 30
        dnsPolicy: ClusterFirstWithHostNet
        hostNetwork: true
        tolerations:
        - key: node-role.kubernetes.io/control-plane
          effect: NoSchedule
        containers:
        - name: filebeat
          env:
          - name: NODE_NAME
            valueFrom:
              fieldRef:
                fieldPath: spec.nodeName
          resources:
            requests:
              cpu: "100m"
              memory: "200Mi"
            limits:
              cpu: "500m"
              memory: "500Mi"
          securityContext:
            runAsUser: 0
          volumeMounts:
          - name: varlogcontainers
            mountPath: /var/log/containers
          - name: varlogpods
            mountPath: /var/log/pods
          - name: varlibdockercontainers
            mountPath: /var/lib/docker/containers
        volumes:
        - name: varlogcontainers
          hostPath:
            path: /var/log/containers
        - name: varlogpods
          hostPath:
            path: /var/log/pods
        - name: varlibdockercontainers
          hostPath:
            path: /var/lib/docker/containers
```

### Metricbeat via Beat CRD

```yaml
apiVersion: beat.k8s.elastic.co/v1beta1
kind: Beat
metadata:
  name: metricbeat-prod
  namespace: elastic
spec:
  type: metricbeat
  version: 8.14.0
  elasticsearchRef:
    name: elastic-prod
  kibanaRef:
    name: kibana-prod
  config:
    metricbeat.autodiscover:
      providers:
      - type: kubernetes
        node: ${NODE_NAME}
        hints.enabled: true
    metricbeat.modules:
    - module: kubernetes
      metricsets:
      - node
      - system
      - pod
      - container
      - volume
      period: 10s
      host: ${NODE_NAME}
      hosts: ["https://${NODE_NAME}:10250"]
      bearer_token_file: /var/run/secrets/kubernetes.io/serviceaccount/token
      ssl.verification_mode: "none"
      processors:
      - add_kubernetes_metadata: {}
    - module: kubernetes
      enabled: true
      metricsets:
      - proxy
      period: 10s
      host: ${NODE_NAME}
      hosts: ["localhost:10249"]
    - module: system
      period: 10s
      metricsets:
      - cpu
      - load
      - memory
      - network
      - process
      - process_summary
      process.include_top_n:
        by_cpu: 5
        by_memory: 5
    processors:
    - add_cloud_metadata: {}
    - add_host_metadata: {}
  daemonSet:
    podTemplate:
      spec:
        serviceAccount: metricbeat
        automountServiceAccountToken: true
        hostNetwork: true
        dnsPolicy: ClusterFirstWithHostNet
        tolerations:
        - key: node-role.kubernetes.io/control-plane
          effect: NoSchedule
        containers:
        - name: metricbeat
          env:
          - name: NODE_NAME
            valueFrom:
              fieldRef:
                fieldPath: spec.nodeName
          resources:
            requests:
              cpu: "100m"
              memory: "200Mi"
            limits:
              cpu: "500m"
              memory: "500Mi"
          securityContext:
            runAsUser: 0
```

---

## Section 8: Fleet Server and Elastic Agent

Fleet Server centralizes Elastic Agent policy management. The `Agent` CRD deploys both Fleet Server and Elastic Agents.

### Fleet Server Deployment

```yaml
apiVersion: agent.k8s.elastic.co/v1alpha1
kind: Agent
metadata:
  name: fleet-server-prod
  namespace: elastic
spec:
  version: 8.14.0
  kibanaRef:
    name: kibana-prod
  elasticsearchRefs:
  - name: elastic-prod
  mode: fleet
  fleetServerEnabled: true
  policyID: fleet-server-policy
  deployment:
    replicas: 2
    podTemplate:
      spec:
        serviceAccount: fleet-server
        automountServiceAccountToken: true
        securityContext:
          runAsUser: 0
        containers:
        - name: agent
          resources:
            requests:
              cpu: "200m"
              memory: 256Mi
            limits:
              cpu: "1"
              memory: 512Mi
```

### Elastic Agent DaemonSet for Kubernetes Monitoring

```yaml
apiVersion: agent.k8s.elastic.co/v1alpha1
kind: Agent
metadata:
  name: elastic-agent-prod
  namespace: elastic
spec:
  version: 8.14.0
  kibanaRef:
    name: kibana-prod
  fleetServerRef:
    name: fleet-server-prod
  mode: fleet
  policyID: kubernetes-agent-policy
  daemonSet:
    podTemplate:
      spec:
        serviceAccount: elastic-agent
        automountServiceAccountToken: true
        hostNetwork: true
        dnsPolicy: ClusterFirstWithHostNet
        tolerations:
        - key: node-role.kubernetes.io/control-plane
          effect: NoSchedule
        containers:
        - name: agent
          env:
          - name: NODE_NAME
            valueFrom:
              fieldRef:
                fieldPath: spec.nodeName
          - name: POD_NAME
            valueFrom:
              fieldRef:
                fieldPath: metadata.name
          resources:
            requests:
              cpu: "200m"
              memory: 300Mi
            limits:
              cpu: "1"
              memory: 700Mi
          securityContext:
            runAsUser: 0
          volumeMounts:
          - name: proc
            mountPath: /hostfs/proc
            readOnly: true
          - name: cgroup
            mountPath: /hostfs/sys/fs/cgroup
            readOnly: true
          - name: varlibdockercontainers
            mountPath: /var/lib/docker/containers
            readOnly: true
          - name: varlog
            mountPath: /var/log
            readOnly: true
        volumes:
        - name: proc
          hostPath:
            path: /proc
        - name: cgroup
          hostPath:
            path: /sys/fs/cgroup
        - name: varlibdockercontainers
          hostPath:
            path: /var/lib/docker/containers
        - name: varlog
          hostPath:
            path: /var/log
```

---

## Section 9: X-Pack Security Configuration

ECK enables X-Pack security by default. All inter-node and client-facing TLS is configured automatically. Additional security hardening:

### Custom TLS Certificates

```yaml
apiVersion: elasticsearch.k8s.elastic.co/v1
kind: Elasticsearch
metadata:
  name: elastic-prod
  namespace: elastic
spec:
  http:
    tls:
      certificate:
        secretName: elastic-prod-custom-tls
```

Create the custom TLS secret:

```bash
kubectl -n elastic create secret generic elastic-prod-custom-tls \
  --from-file=ca.crt=ca.crt \
  --from-file=tls.crt=elasticsearch.crt \
  --from-file=tls.key=elasticsearch.key
```

### RBAC via Elasticsearch API

```bash
ELASTIC_PASS=$(kubectl -n elastic get secret \
  elastic-prod-es-elastic-user \
  -o jsonpath='{.data.elastic}' | base64 -d)

# Create a custom role
curl -k -u "elastic:$ELASTIC_PASS" \
  -X PUT "https://localhost:9200/_security/role/logs-reader" \
  -H "Content-Type: application/json" \
  -d '{
    "indices": [
      {
        "names": ["logs-*"],
        "privileges": ["read", "view_index_metadata"]
      }
    ],
    "cluster": ["monitor"]
  }'

# Create a user with the custom role
curl -k -u "elastic:$ELASTIC_PASS" \
  -X PUT "https://localhost:9200/_security/user/logs-service" \
  -H "Content-Type: application/json" \
  -d '{
    "password": "REPLACE_WITH_STRONG_PASSWORD",
    "roles": ["logs-reader"],
    "full_name": "Logs Service Account"
  }'
```

### SAML and OIDC Configuration

Configure SSO via Kibana for enterprise identity providers:

```yaml
apiVersion: kibana.k8s.elastic.co/v1
kind: Kibana
metadata:
  name: kibana-prod
  namespace: elastic
spec:
  config:
    xpack.security.authc.providers:
      saml.saml1:
        order: 0
        realm: saml1
        description: "Login with Corporate SSO"
        icon: "https://idp.example.com/logo.png"
      basic.basic1:
        order: 1
        description: "Login with Elasticsearch username/password"
```

---

## Section 10: Autoscaling Policies

The `ElasticsearchAutoscaler` CRD adjusts node count and storage based on cluster resource utilization.

### Autoscaling Policy

```yaml
apiVersion: autoscaling.k8s.elastic.co/v1alpha1
kind: ElasticsearchAutoscaler
metadata:
  name: elastic-prod-autoscaler
  namespace: elastic
spec:
  elasticsearchRef:
    name: elastic-prod
  policies:
  - name: data-hot-policy
    roles:
    - data_hot
    - data_content
    - ingest
    resources:
      nodeCount:
        min: 3
        max: 10
      cpu:
        min: 2
        max: 8
        requestsToLimitsRatio: "2"
      memory:
        min: 8Gi
        max: 32Gi
      storage:
        minimumNodeSize: 500Gi
        maximumNodeSize: 2Ti
  - name: data-warm-policy
    roles:
    - data_warm
    resources:
      nodeCount:
        min: 2
        max: 6
      cpu:
        min: 1
        max: 4
      memory:
        min: 4Gi
        max: 16Gi
      storage:
        minimumNodeSize: 1Ti
        maximumNodeSize: 4Ti
  - name: ml-policy
    roles:
    - ml
    resources:
      nodeCount:
        min: 0
        max: 4
      cpu:
        min: 1
        max: 4
      memory:
        min: 4Gi
        max: 32Gi
```

---

## Section 11: Monitoring the ECK Stack

### ECK Operator Metrics

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: eck-operator-metrics
  namespace: elastic-system
  labels:
    release: prometheus
spec:
  selector:
    matchLabels:
      control-plane: elastic-operator
  namespaceSelector:
    matchNames:
    - elastic-system
  endpoints:
  - port: https
    scheme: https
    tlsConfig:
      insecureSkipVerify: true
    interval: 60s
```

### Elasticsearch Cluster Health Alerts

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: elasticsearch-alerts
  namespace: elastic
spec:
  groups:
  - name: elasticsearch
    rules:
    - alert: ElasticsearchClusterNotGreen
      expr: elasticsearch_cluster_health_status{color="green"} == 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Elasticsearch cluster {{ $labels.cluster }} is not green"
        description: "Cluster health is {{ $labels.color }}"

    - alert: ElasticsearchHighJVMHeapUsage
      expr: |
        elasticsearch_jvm_memory_used_bytes{area="heap"} /
        elasticsearch_jvm_memory_max_bytes{area="heap"} > 0.85
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "High JVM heap usage on {{ $labels.node }}"
        description: "Heap usage is {{ $value | humanizePercentage }}"

    - alert: ElasticsearchDiskWatermarkHigh
      expr: |
        (elasticsearch_filesystem_data_available_bytes /
         elasticsearch_filesystem_data_size_bytes) < 0.15
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Disk usage high on {{ $labels.node }}"
        description: "Only {{ $value | humanizePercentage }} disk available"

    - alert: ElasticsearchUnassignedShards
      expr: elasticsearch_cluster_health_unassigned_shards > 0
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "Unassigned shards in cluster"
        description: "{{ $value }} shards are unassigned"
```

---

## Section 12: Operational Runbooks

### Check Cluster Health

```bash
ELASTIC_PASS=$(kubectl -n elastic get secret \
  elastic-prod-es-elastic-user \
  -o jsonpath='{.data.elastic}' | base64 -d)

kubectl -n elastic port-forward svc/elastic-prod-es-http 9200:9200 &

# Cluster health
curl -sk -u "elastic:$ELASTIC_PASS" \
  "https://localhost:9200/_cluster/health?pretty"

# Node status
curl -sk -u "elastic:$ELASTIC_PASS" \
  "https://localhost:9200/_cat/nodes?v&h=name,role,heap.percent,disk.used_percent,cpu,load_1m"

# Shard allocation
curl -sk -u "elastic:$ELASTIC_PASS" \
  "https://localhost:9200/_cat/shards?v&s=state&h=index,shard,prirep,state,node,docs,store"

# Indices sorted by size
curl -sk -u "elastic:$ELASTIC_PASS" \
  "https://localhost:9200/_cat/indices?v&s=store.size:desc&h=index,health,pri,rep,docs.count,store.size"
```

### Fix Unassigned Shards

```bash
# Check allocation explanation
curl -sk -u "elastic:$ELASTIC_PASS" \
  -X POST "https://localhost:9200/_cluster/allocation/explain?pretty"

# Force reroute (may cause data loss — review first)
curl -sk -u "elastic:$ELASTIC_PASS" \
  -X POST "https://localhost:9200/_cluster/reroute?retry_failed=true"

# Allow allocation of unassigned primary shards (last resort)
curl -sk -u "elastic:$ELASTIC_PASS" \
  -X POST "https://localhost:9200/_cluster/reroute" \
  -H "Content-Type: application/json" \
  -d '{
    "commands": [{
      "allocate_stale_primary": {
        "index": "logs-2027.06.24",
        "shard": 0,
        "node": "elastic-prod-es-data-hot-0",
        "accept_data_loss": false
      }
    }]
  }'
```

### Rolling Restart

ECK handles rolling restarts automatically when the `Elasticsearch` CR is updated. To trigger a manual rolling restart:

```bash
# Annotate the Elasticsearch resource to trigger a rolling restart
kubectl -n elastic annotate elasticsearch elastic-prod \
  elasticsearch.k8s.elastic.co/restart-annotation="$(date +%s)"

# Watch pods restart one at a time
kubectl -n elastic get pods -l elasticsearch.k8s.elastic.co/cluster-name=elastic-prod -w
```

### Checking ILM Progress

```bash
# Check ILM status for an index
curl -sk -u "elastic:$ELASTIC_PASS" \
  "https://localhost:9200/logs-2027.06.24/_ilm/explain?pretty"

# List indices currently in warm phase
curl -sk -u "elastic:$ELASTIC_PASS" \
  "https://localhost:9200/_cat/indices?v&h=index,ilm.phase&s=ilm.phase" \
  | grep warm

# Check ILM policy status
curl -sk -u "elastic:$ELASTIC_PASS" \
  "https://localhost:9200/_ilm/policy/logs-standard?pretty"
```

ECK represents the maturation of Elasticsearch operations on Kubernetes — moving from manually managed StatefulSets to a declarative, operator-driven platform with automated certificate management, rolling upgrades, and native Kubernetes autoscaling integration. The hot-warm-cold-frozen tiering model, combined with ILM policies and snapshot lifecycle management, provides a complete data management solution that balances query performance with storage cost across the full data lifecycle.
