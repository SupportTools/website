---
title: "Elastic Cloud on Kubernetes (ECK): Production Elasticsearch and Kibana Deployment"
date: 2027-03-26T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Elasticsearch", "ECK", "Kibana", "Logging", "Search"]
categories: ["Kubernetes", "Logging", "Search"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise deployment guide for Elastic Cloud on Kubernetes (ECK), covering Elasticsearch Cluster CRD with dedicated node roles, TLS/security configuration, index lifecycle management, Kibana deployment, Logstash/Beats collectors, Prometheus monitoring, and production scaling patterns."
more_link: "yes"
url: "/elastic-cloud-kubernetes-eck-production-guide/"
---

Elastic Cloud on Kubernetes (ECK) is the official Kubernetes operator for Elasticsearch, Kibana, Logstash, and the Elastic Beats family. ECK translates Elastic Stack topology into Kubernetes-native resources: `Elasticsearch`, `Kibana`, `Logstash`, `Beat`, and `Agent` custom resources each map to StatefulSets or Deployments managed by the ECK operator. Security is enabled by default — TLS encryption and built-in user authentication are bootstrapped automatically without manual certificate management.

This guide covers a complete production deployment: operator installation, Elasticsearch CRD with dedicated node roles, JVM heap configuration, TLS and RBAC, index lifecycle management, Kibana, Beats with Beat CRD, Logstash with Logstash CRD, Prometheus monitoring, licensing, and cluster upgrade procedures.

<!--more-->

## Section 1: Architecture Overview

### ECK Operator and Resource Model

```
┌─────────────────────────────────────────────────────────────────┐
│  ECK Operator (Deployment in elastic-system namespace)          │
│  Watches: Elasticsearch, Kibana, Logstash, Beat, Agent, ...    │
└────────────────────────────────────────────────────────────────-┘
                          │
          ┌───────────────┼───────────────────────┐
          │               │                       │
    ┌─────▼──────┐  ┌─────▼──────┐  ┌────────────▼──────────────┐
    │Elasticsearch│  │  Kibana    │  │  Logstash / Beats / Agent  │
    │  CRD        │  │  CRD       │  │  CRDs                      │
    └─────┬───────┘  └─────┬──────┘  └────────────┬──────────────┘
          │                │                       │
    ┌─────▼───────────────────────────────────────▼──────┐
    │  Elasticsearch NodeSets (StatefulSets)              │
    │  ┌─────────────┐  ┌─────────────┐  ┌───────────┐  │
    │  │  master-0   │  │  data-hot-0 │  │  coord-0  │  │
    │  │  master-1   │  │  data-hot-1 │  │  coord-1  │  │
    │  │  master-2   │  │  data-hot-2 │  │           │  │
    │  │ (master,    │  │ (data,      │  │ (coord,   │  │
    │  │  voting_    │  │  ingest)    │  │  ingest)  │  │
    │  │  only)      │  └─────────────┘  └───────────┘  │
    │  └─────────────┘                                   │
    │  ┌─────────────┐  ┌─────────────┐                 │
    │  │ data-warm-0 │  │ data-cold-0 │                 │
    │  │ data-warm-1 │  │             │                 │
    │  │ (data,warm) │  │ (data,cold) │                 │
    │  └─────────────┘  └─────────────┘                 │
    └────────────────────────────────────────────────────┘
```

### Node Role Separation

Dedicated node roles prevent noisy-neighbor effects. Master nodes manage cluster state only and should have minimal JVM heap and fast SSDs. Hot data nodes hold recent, frequently queried indices on NVMe storage. Warm and cold nodes hold older indices on larger, cheaper storage. Coordinating nodes receive client requests, scatter to data nodes, and aggregate results — they do not hold data.

---

## Section 2: ECK Operator Installation

### Install via Helm

```bash
# Add Elastic Helm repo
helm repo add elastic https://helm.elastic.co
helm repo update

# Install ECK operator
helm upgrade --install elastic-operator elastic/eck-operator \
  --namespace elastic-system \
  --create-namespace \
  --version 2.13.0 \
  --set managedNamespaces="{logging,search,monitoring}" \
  --set config.metrics.port=8080 \
  --wait
```

### Verify Operator Health

```bash
kubectl get pods -n elastic-system

# Check operator logs
kubectl logs -n elastic-system -l control-plane=elastic-operator --tail=50

# Verify CRDs
kubectl get crd | grep elastic
```

---

## Section 3: Elasticsearch CRD — Production Multi-Role Cluster

### Full Production Elasticsearch Cluster

```yaml
# elasticsearch-production.yaml
apiVersion: elasticsearch.k8s.elastic.co/v1
kind: Elasticsearch
metadata:
  name: es-production
  namespace: logging
spec:
  version: 8.13.4

  # HTTP layer TLS (ECK manages certificates automatically)
  http:
    tls:
      selfSignedCertificate:
        disabled: false     # Keep TLS enabled (default)

  nodeSets:
    # ── Master Nodes ─────────────────────────────────────────
    - name: master
      count: 3
      config:
        node.roles: ["master", "voting_only"]
        cluster.routing.allocation.disk.watermark.low: "85%"
        cluster.routing.allocation.disk.watermark.high: "90%"
        cluster.routing.allocation.disk.watermark.flood_stage: "95%"
        # Faster master election
        discovery.zen.minimum_master_nodes: 2
        # Disable data roles on master nodes
        indices.memory.index_buffer_size: "10%"

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
              env:
                - name: ES_JAVA_OPTS
                  value: "-Xms2g -Xmx2g -XX:+UseG1GC -XX:G1ReservePercent=25 -XX:InitiatingHeapOccupancyPercent=30"
              resources:
                requests:
                  cpu: "1"
                  memory: "4Gi"
                limits:
                  cpu: "2"
                  memory: "4Gi"
          affinity:
            podAntiAffinity:
              requiredDuringSchedulingIgnoredDuringExecution:
                - labelSelector:
                    matchExpressions:
                      - key: elasticsearch.k8s.elastic.co/node-master
                        operator: In
                        values:
                          - "true"
                  topologyKey: kubernetes.io/hostname

      volumeClaimTemplates:
        - metadata:
            name: elasticsearch-data
          spec:
            storageClassName: premium-rwo
            accessModes:
              - ReadWriteOnce
            resources:
              requests:
                storage: 30Gi     # Master nodes only store cluster state

    # ── Hot Data Nodes ────────────────────────────────────────
    - name: data-hot
      count: 3
      config:
        node.roles: ["data", "data_content", "data_hot", "ingest"]
        # NVMe-optimised settings
        indices.memory.index_buffer_size: "15%"
        indices.queries.cache.size: "15%"
        thread_pool.write.queue_size: 10000
        thread_pool.search.queue_size: 10000

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
              env:
                - name: ES_JAVA_OPTS
                  value: "-Xms16g -Xmx16g -XX:+UseG1GC -XX:G1ReservePercent=25 -XX:InitiatingHeapOccupancyPercent=30"
              resources:
                requests:
                  cpu: "4"
                  memory: "32Gi"
                limits:
                  cpu: "8"
                  memory: "32Gi"
          nodeSelector:
            storage-tier: nvme
          affinity:
            podAntiAffinity:
              requiredDuringSchedulingIgnoredDuringExecution:
                - labelSelector:
                    matchExpressions:
                      - key: elasticsearch.k8s.elastic.co/node-data-hot
                        operator: In
                        values:
                          - "true"
                  topologyKey: kubernetes.io/hostname

      volumeClaimTemplates:
        - metadata:
            name: elasticsearch-data
          spec:
            storageClassName: nvme-rwo     # High-performance NVMe storage class
            accessModes:
              - ReadWriteOnce
            resources:
              requests:
                storage: 1Ti

    # ── Warm Data Nodes ───────────────────────────────────────
    - name: data-warm
      count: 2
      config:
        node.roles: ["data", "data_warm"]
        indices.memory.index_buffer_size: "10%"

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
              env:
                - name: ES_JAVA_OPTS
                  value: "-Xms8g -Xmx8g -XX:+UseG1GC"
              resources:
                requests:
                  cpu: "2"
                  memory: "16Gi"
                limits:
                  cpu: "4"
                  memory: "16Gi"

      volumeClaimTemplates:
        - metadata:
            name: elasticsearch-data
          spec:
            storageClassName: standard-rwo
            accessModes:
              - ReadWriteOnce
            resources:
              requests:
                storage: 2Ti

    # ── Cold Data Nodes ───────────────────────────────────────
    - name: data-cold
      count: 1
      config:
        node.roles: ["data", "data_cold"]

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
              env:
                - name: ES_JAVA_OPTS
                  value: "-Xms4g -Xmx4g"
              resources:
                requests:
                  cpu: "1"
                  memory: "8Gi"
                limits:
                  cpu: "2"
                  memory: "8Gi"

      volumeClaimTemplates:
        - metadata:
            name: elasticsearch-data
          spec:
            storageClassName: hdd-rwo      # Cheap spinning disk
            accessModes:
              - ReadWriteOnce
            resources:
              requests:
                storage: 5Ti

    # ── Coordinating Nodes ────────────────────────────────────
    - name: coordinating
      count: 2
      config:
        node.roles: []      # Empty array = coordinating-only node

      podTemplate:
        spec:
          containers:
            - name: elasticsearch
              env:
                - name: ES_JAVA_OPTS
                  value: "-Xms4g -Xmx4g"
              resources:
                requests:
                  cpu: "2"
                  memory: "8Gi"
                limits:
                  cpu: "4"
                  memory: "8Gi"

      volumeClaimTemplates:
        - metadata:
            name: elasticsearch-data
          spec:
            storageClassName: standard-rwo
            accessModes:
              - ReadWriteOnce
            resources:
              requests:
                storage: 20Gi

  # Pod Disruption Budget (set automatically by ECK, shown for reference)
  # ECK creates a PDB with maxUnavailable=1 for each nodeSet
```

### Check Cluster Health

```bash
# Wait for cluster to become green
kubectl get elasticsearch es-production -n logging

# Extract the elastic user password
kubectl get secret es-production-es-elastic-user \
  --namespace logging \
  -o jsonpath='{.data.elastic}' | base64 -d && echo

# Port-forward to access Elasticsearch API
kubectl port-forward service/es-production-es-http 9200:9200 -n logging &

# Check cluster health
curl -k -u "elastic:$(kubectl get secret es-production-es-elastic-user -n logging -o jsonpath='{.data.elastic}' | base64 -d)" \
  https://localhost:9200/_cluster/health?pretty

# Check node roles
curl -k -u "elastic:$(kubectl get secret es-production-es-elastic-user -n logging -o jsonpath='{.data.elastic}' | base64 -d)" \
  "https://localhost:9200/_cat/nodes?v&h=name,roles,heap.percent,ram.percent,disk.used_percent,load_1m"
```

---

## Section 4: Index Lifecycle Management (ILM)

ILM automates data tier migration (hot → warm → cold → delete) based on age or index size.

### Log Retention ILM Policy

```bash
# Create ILM policy via Elasticsearch API
curl -k -X PUT \
  -u "elastic:StrongElasticPassword2024!" \
  "https://localhost:9200/_ilm/policy/logs-retention-policy" \
  -H "Content-Type: application/json" \
  -d '{
    "policy": {
      "phases": {
        "hot": {
          "min_age": "0ms",
          "actions": {
            "rollover": {
              "max_age": "1d",
              "max_primary_shard_size": "50gb"
            },
            "set_priority": {
              "priority": 100
            }
          }
        },
        "warm": {
          "min_age": "7d",
          "actions": {
            "allocate": {
              "require": {
                "data": "warm"
              }
            },
            "forcemerge": {
              "max_num_segments": 1
            },
            "shrink": {
              "number_of_shards": 1
            },
            "set_priority": {
              "priority": 50
            }
          }
        },
        "cold": {
          "min_age": "30d",
          "actions": {
            "allocate": {
              "require": {
                "data": "cold"
              }
            },
            "freeze": {},
            "set_priority": {
              "priority": 0
            }
          }
        },
        "delete": {
          "min_age": "90d",
          "actions": {
            "delete": {}
          }
        }
      }
    }
  }'
```

### Index Template with ILM Policy

```bash
curl -k -X PUT \
  -u "elastic:StrongElasticPassword2024!" \
  "https://localhost:9200/_index_template/logs-template" \
  -H "Content-Type: application/json" \
  -d '{
    "index_patterns": ["logs-*"],
    "template": {
      "settings": {
        "number_of_shards": 3,
        "number_of_replicas": 1,
        "index.lifecycle.name": "logs-retention-policy",
        "index.lifecycle.rollover_alias": "logs",
        "index.routing.allocation.require.data": "hot",
        "index.codec": "best_compression"
      },
      "mappings": {
        "dynamic": "false",
        "properties": {
          "@timestamp": { "type": "date" },
          "message": { "type": "text" },
          "level": { "type": "keyword" },
          "service": { "type": "keyword" },
          "pod": { "type": "keyword" },
          "namespace": { "type": "keyword" }
        }
      }
    },
    "priority": 500
  }'
```

---

## Section 5: Kibana Deployment

```yaml
# kibana-production.yaml
apiVersion: kibana.k8s.elastic.co/v1
kind: Kibana
metadata:
  name: kibana-production
  namespace: logging
spec:
  version: 8.13.4
  count: 2

  # Associate with the Elasticsearch cluster
  elasticsearchRef:
    name: es-production
    namespace: logging

  config:
    server.publicBaseUrl: "https://kibana.company.internal"

    # Security settings
    xpack.security.enabled: true
    xpack.security.encryptionKey: "EXAMPLE_KIBANA_ENCRYPTION_KEY_32CHARS_REPLACE_ME"
    xpack.encryptedSavedObjects.encryptionKey: "EXAMPLE_KIBANA_SAVED_OBJ_KEY_32_REPLACE_ME"
    xpack.reporting.encryptionKey: "EXAMPLE_KIBANA_REPORTING_KEY_32_REPLACE_ME"

    # Fleet / APM
    xpack.fleet.enabled: true
    xpack.fleet.packages:
      - name: system
        version: latest
      - name: apm
        version: latest

    # Logging
    logging.root.level: warn
    logging.appenders.default.type: console

  podTemplate:
    spec:
      containers:
        - name: kibana
          resources:
            requests:
              cpu: "500m"
              memory: "1Gi"
            limits:
              cpu: "2"
              memory: "2Gi"
          env:
            - name: NODE_OPTIONS
              value: "--max-old-space-size=1500"

  # Ingress for external access
  http:
    service:
      spec:
        type: ClusterIP
    tls:
      selfSignedCertificate:
        disabled: false
```

### Kibana Ingress

```yaml
# kibana-ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: kibana-production
  namespace: logging
  annotations:
    nginx.ingress.kubernetes.io/backend-protocol: "HTTPS"
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - kibana.company.internal
      secretName: kibana-tls
  rules:
    - host: kibana.company.internal
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: kibana-production-kb-http
                port:
                  number: 5601
```

---

## Section 6: Filebeat with Beat CRD

### Filebeat Collecting Kubernetes Logs

```yaml
# filebeat-kubernetes.yaml
apiVersion: beat.k8s.elastic.co/v1beta1
kind: Beat
metadata:
  name: filebeat-kubernetes
  namespace: logging
spec:
  type: filebeat
  version: 8.13.4

  # Associate with Elasticsearch output
  elasticsearchRef:
    name: es-production
    namespace: logging

  # Associate with Kibana for dashboard setup
  kibanaRef:
    name: kibana-production
    namespace: logging

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

    processors:
      - add_cloud_metadata: {}
      - add_host_metadata: {}
      - add_kubernetes_metadata:
          host: ${NODE_NAME}
          matchers:
            - logs_path:
                logs_path: "/var/log/containers/"

    output.elasticsearch:
      hosts: ["https://${ELASTICSEARCH_HOST}:${ELASTICSEARCH_PORT}"]
      username: ${ELASTICSEARCH_USERNAME}
      password: ${ELASTICSEARCH_PASSWORD}
      ssl.certificate_authorities:
        - /mnt/elastic/tls.crt
      indices:
        - index: "logs-kubernetes-%{[kubernetes.namespace]}-%{+yyyy.MM.dd}"

    logging.level: warning
    logging.to_files: false

  # Deploy as DaemonSet for per-node log collection
  daemonSet:
    podTemplate:
      spec:
        serviceAccountName: filebeat
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
                memory: "512Mi"
            volumeMounts:
              - name: varlogcontainers
                mountPath: /var/log/containers
                readOnly: true
              - name: varlogpods
                mountPath: /var/log/pods
                readOnly: true
              - name: varlibdockercontainers
                mountPath: /var/lib/docker/containers
                readOnly: true
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

---

## Section 7: Metricbeat with Beat CRD

```yaml
# metricbeat-kubernetes.yaml
apiVersion: beat.k8s.elastic.co/v1beta1
kind: Beat
metadata:
  name: metricbeat-kubernetes
  namespace: logging
spec:
  type: metricbeat
  version: 8.13.4

  elasticsearchRef:
    name: es-production
    namespace: logging

  kibanaRef:
    name: kibana-production
    namespace: logging

  config:
    metricbeat.autodiscover:
      providers:
        - type: kubernetes
          scope: cluster
          node: ${NODE_NAME}
          unique: true
          templates:
            - config:
                - module: kubernetes
                  hosts: ["kube-state-metrics:8080"]
                  period: 10s
                  add_metadata: true
                  metricsets:
                    - state_node
                    - state_deployment
                    - state_replicaset
                    - state_pod
                    - state_container
                    - state_persistentvolume
                    - state_persistentvolumeclaim
                    - state_service
                    - event

        - type: kubernetes
          scope: node
          node: ${NODE_NAME}
          templates:
            - config:
                - module: kubernetes
                  metricsets:
                    - node
                    - system
                    - pod
                    - container
                    - volume
                  period: 10s
                  hosts: ["https://${NODE_NAME}:10250"]
                  bearer_token_file: /var/run/secrets/kubernetes.io/serviceaccount/token
                  ssl.verification_mode: "none"

    processors:
      - add_cloud_metadata: {}
      - add_host_metadata: {}

    output.elasticsearch:
      hosts: ["https://${ELASTICSEARCH_HOST}:${ELASTICSEARCH_PORT}"]
      username: ${ELASTICSEARCH_USERNAME}
      password: ${ELASTICSEARCH_PASSWORD}
      ssl.certificate_authorities:
        - /mnt/elastic/tls.crt

  clusterRoleBinding:
    subjects:
      - kind: ServiceAccount
        name: metricbeat
        namespace: logging

  daemonSet:
    podTemplate:
      spec:
        serviceAccountName: metricbeat
        automountServiceAccountToken: true
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
                memory: "512Mi"
```

---

## Section 8: Logstash CRD

```yaml
# logstash-production.yaml
apiVersion: logstash.k8s.elastic.co/v1alpha1
kind: Logstash
metadata:
  name: logstash-production
  namespace: logging
spec:
  count: 2
  version: 8.13.4

  # Input from Kafka; output to Elasticsearch
  elasticsearchRefs:
    - name: es-production
      namespace: logging
      clusterName: es-production

  config:
    log.level: warn
    queue.type: persisted
    queue.page_capacity: 64mb
    queue.max_bytes: 1gb
    pipeline.workers: 4
    pipeline.batch.size: 1000
    pipeline.batch.delay: 50

  pipelines:
    - pipeline.id: kafka-to-elastic
      config.string: |
        input {
          kafka {
            bootstrap_servers => "kafka-cluster-kafka-bootstrap.messaging.svc.cluster.local:9092"
            topics => ["application-logs", "system-logs"]
            consumer_threads => 4
            group_id => "logstash-es-consumer"
            codec => json
            decorate_events => true
          }
        }

        filter {
          # Parse structured JSON logs
          if [message] =~ /^\{/ {
            json {
              source => "message"
              target => "parsed"
            }
            if "_jsonparsefailure" not in [tags] {
              mutate {
                replace => { "message" => "%{[parsed][msg]}" }
                add_field => {
                  "level" => "%{[parsed][level]}"
                  "service" => "%{[parsed][service]}"
                }
              }
            }
          }

          # Add geo data for IP fields
          if [client_ip] {
            geoip {
              source => "client_ip"
              target => "geoip"
            }
          }

          # Drop health check noise
          if [path] =~ "^/health" or [path] =~ "^/readyz" {
            drop {}
          }

          # Tag slow requests
          if [duration_ms] and [duration_ms] > 1000 {
            mutate { add_tag => ["slow_request"] }
          }
        }

        output {
          elasticsearch {
            hosts => ["${ES_PRODUCTION_ES_HTTP_HOST}"]
            user => "${ES_PRODUCTION_ES_HTTP_USER}"
            password => "${ES_PRODUCTION_ES_HTTP_PASSWORD}"
            ssl_certificate_authorities => ["${ES_PRODUCTION_ES_HTTP_CA}"]
            index => "logs-%{[kubernetes][namespace]}-%{+YYYY.MM.dd}"
            ilm_enabled => true
            ilm_rollover_alias => "logs"
            ilm_policy => "logs-retention-policy"
          }
        }

  podTemplate:
    spec:
      containers:
        - name: logstash
          env:
            - name: LS_JAVA_OPTS
              value: "-Xms2g -Xmx2g"
          resources:
            requests:
              cpu: "1"
              memory: "4Gi"
            limits:
              cpu: "4"
              memory: "4Gi"

  volumeClaimTemplates:
    - metadata:
        name: logstash-data
      spec:
        storageClassName: standard-rwo
        accessModes:
          - ReadWriteOnce
        resources:
          requests:
            storage: 10Gi    # Persistent queue storage
```

---

## Section 9: Prometheus Monitoring Integration

ECK does not include a native Prometheus exporter. Metricbeat with the Elasticsearch module is the official monitoring approach. For Prometheus-native environments, deploy the community `elasticsearch-exporter`.

### Elasticsearch Exporter Deployment

```yaml
# elasticsearch-exporter.yaml
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
          image: quay.io/prometheuscommunity/elasticsearch-exporter:v1.7.0
          args:
            - --es.uri=https://elastic:$(ELASTIC_PASSWORD)@es-production-es-http.logging.svc.cluster.local:9200
            - --es.ssl-skip-verify=false
            - --es.ca=/mnt/elastic/tls.crt
            - --es.all
            - --es.indices
            - --es.indices_settings
            - --es.shards
            - --es.snapshots
            - --es.cluster_settings
            - --web.listen-address=:9114
          env:
            - name: ELASTIC_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: es-production-es-elastic-user
                  key: elastic
          ports:
            - containerPort: 9114
              name: metrics
          volumeMounts:
            - name: es-ca
              mountPath: /mnt/elastic
      volumes:
        - name: es-ca
          secret:
            secretName: es-production-es-http-certs-public
            items:
              - key: tls.crt
                path: tls.crt
---
apiVersion: v1
kind: Service
metadata:
  name: elasticsearch-exporter
  namespace: logging
  labels:
    app: elasticsearch-exporter
spec:
  selector:
    app: elasticsearch-exporter
  ports:
    - name: metrics
      port: 9114
      targetPort: 9114
```

### ServiceMonitor

```yaml
# elasticsearch-service-monitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: elasticsearch-metrics
  namespace: logging
  labels:
    release: kube-prometheus-stack
spec:
  selector:
    matchLabels:
      app: elasticsearch-exporter
  namespaceSelector:
    matchNames:
      - logging
  endpoints:
    - port: metrics
      interval: 60s          # Elasticsearch API can be slow; use longer interval
      path: /metrics
      scrapeTimeout: 30s
```

### Prometheus Alerting Rules

```yaml
# elasticsearch-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: elasticsearch-production-alerts
  namespace: logging
  labels:
    release: kube-prometheus-stack
spec:
  groups:
    - name: elasticsearch.cluster
      interval: 60s
      rules:
        # Cluster health is red (data loss possible)
        - alert: ElasticsearchClusterRed
          expr: elasticsearch_cluster_health_status{color="red"} == 1
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "Elasticsearch cluster status is RED"
            description: "One or more primary shards are unassigned. Data may be unavailable."

        # Cluster health is yellow
        - alert: ElasticsearchClusterYellow
          expr: elasticsearch_cluster_health_status{color="yellow"} == 1
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Elasticsearch cluster status is YELLOW"
            description: "One or more replica shards are unassigned."

        # JVM heap usage > 85%
        - alert: ElasticsearchJVMHeapHigh
          expr: |
            elasticsearch_jvm_memory_used_bytes{area="heap"} /
            elasticsearch_jvm_memory_max_bytes{area="heap"} > 0.85
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Elasticsearch JVM heap high on {{ $labels.name }}"
            description: "Node {{ $labels.name }} heap at {{ $value | humanizePercentage }}."

        # Unassigned shards
        - alert: ElasticsearchUnassignedShards
          expr: elasticsearch_cluster_health_unassigned_shards > 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Elasticsearch has {{ $value }} unassigned shards"
            description: "Check shard allocation explain for details."

        # Pending tasks (long queue indicates cluster instability)
        - alert: ElasticsearchPendingTasks
          expr: elasticsearch_cluster_health_number_of_pending_tasks > 50
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Elasticsearch has {{ $value }} pending tasks"

        # Disk usage > 80% on any data node
        - alert: ElasticsearchDiskPressure
          expr: |
            (1 - elasticsearch_filesystem_data_free_bytes /
                 elasticsearch_filesystem_data_size_bytes) > 0.80
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Elasticsearch disk pressure on {{ $labels.name }}"
            description: "Node {{ $labels.name }} disk is {{ $value | humanizePercentage }} full."
```

---

## Section 10: Security — Built-in Users and RBAC

### Retrieve Built-in User Passwords

```bash
# Elastic superuser
kubectl get secret es-production-es-elastic-user \
  --namespace logging \
  -o jsonpath='{.data.elastic}' | base64 -d && echo

# Kibana system user (ECK manages this automatically)
kubectl get secret es-production-es-kibana-user \
  --namespace logging \
  -o jsonpath='{.data.kibana_system}' | base64 -d && echo 2>/dev/null || \
  echo "Kibana user managed internally by ECK association"
```

### Create Custom Roles and Users

```bash
# Create a read-only role for application queries
curl -k -X PUT \
  -u "elastic:StrongElasticPassword2024!" \
  "https://localhost:9200/_security/role/logs_readonly" \
  -H "Content-Type: application/json" \
  -d '{
    "indices": [
      {
        "names": ["logs-*"],
        "privileges": ["read", "view_index_metadata"],
        "field_security": {
          "grant": ["@timestamp", "message", "level", "service", "pod", "namespace"]
        }
      }
    ]
  }'

# Create user with the custom role
curl -k -X PUT \
  -u "elastic:StrongElasticPassword2024!" \
  "https://localhost:9200/_security/user/logs_reader" \
  -H "Content-Type: application/json" \
  -d '{
    "password": "EXAMPLE_LOGS_READER_PASSWORD_REPLACE_ME",
    "roles": ["logs_readonly"],
    "full_name": "Logs Read-Only User",
    "email": "logs-reader@company.internal"
  }'
```

---

## Section 11: ECK Licensing

ECK operates under two licensing tiers. The basic license (free) enables all core functionality. The enterprise license enables cross-cluster replication, machine learning, SIEM, and advanced security features.

```bash
# Check current license
curl -k -u "elastic:StrongElasticPassword2024!" \
  "https://localhost:9200/_license" | python3 -m json.tool | grep '"type"'

# Apply an enterprise trial license (30 days)
curl -k -X POST \
  -u "elastic:StrongElasticPassword2024!" \
  "https://localhost:9200/_license/start_trial?acknowledge=true"

# Apply a production enterprise license (obtained from Elastic)
curl -k -X PUT \
  -u "elastic:StrongElasticPassword2024!" \
  "https://localhost:9200/_license" \
  -H "Content-Type: application/json" \
  -d @enterprise-license.json
```

### ECK License Secret (Operator Level)

```yaml
# eck-license.yaml
apiVersion: v1
kind: Secret
metadata:
  name: eck-license
  namespace: elastic-system
  labels:
    license.k8s.elastic.co/type: enterprise
type: Opaque
data:
  license: <base64-encoded-license-json-replace-me>
```

---

## Section 12: Cluster Upgrades

ECK performs rolling upgrades with coordinated shard migration and PDB enforcement.

### Minor Version Upgrade

```bash
# Update the version in the Elasticsearch CRD
kubectl patch elasticsearch es-production \
  --namespace logging \
  --type merge \
  --patch '{"spec":{"version":"8.14.0"}}'

# Monitor upgrade progress
kubectl get elasticsearch es-production -n logging -w

# Watch Pod restarts (master nodes first, then data nodes, then coordinating)
kubectl get pods -n logging -l elasticsearch.k8s.elastic.co/cluster-name=es-production -w
```

### Pre-Upgrade Checklist

```bash
# 1. Verify cluster health is green
curl -k -u "elastic:StrongElasticPassword2024!" \
  "https://localhost:9200/_cluster/health?wait_for_status=green&timeout=60s"

# 2. Check for deprecated API usage in the current version
curl -k -u "elastic:StrongElasticPassword2024!" \
  "https://localhost:9200/_migration/deprecations"

# 3. Disable shard allocation rebalancing to reduce churn during upgrade
curl -k -X PUT \
  -u "elastic:StrongElasticPassword2024!" \
  "https://localhost:9200/_cluster/settings" \
  -H "Content-Type: application/json" \
  -d '{"persistent":{"cluster.routing.rebalance.enable":"none"}}'

# 4. After upgrade completes, re-enable rebalancing
curl -k -X PUT \
  -u "elastic:StrongElasticPassword2024!" \
  "https://localhost:9200/_cluster/settings" \
  -H "Content-Type: application/json" \
  -d '{"persistent":{"cluster.routing.rebalance.enable":"all"}}'
```

---

## Section 13: Snapshot Repository for Backup

```bash
# Register an S3 snapshot repository
curl -k -X PUT \
  -u "elastic:StrongElasticPassword2024!" \
  "https://localhost:9200/_snapshot/s3-backup-repo" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "s3",
    "settings": {
      "bucket": "company-elasticsearch-snapshots",
      "region": "us-east-1",
      "base_path": "es-production",
      "compress": true,
      "chunk_size": "1gb",
      "server_side_encryption": true
    }
  }'

# Create a snapshot lifecycle policy (SLM)
curl -k -X PUT \
  -u "elastic:StrongElasticPassword2024!" \
  "https://localhost:9200/_slm/policy/daily-snapshots" \
  -H "Content-Type: application/json" \
  -d '{
    "schedule": "0 30 2 * * ?",
    "name": "<daily-snap-{now/d}>",
    "repository": "s3-backup-repo",
    "config": {
      "indices": ["*"],
      "include_global_state": true,
      "ignore_unavailable": true
    },
    "retention": {
      "expire_after": "30d",
      "min_count": 5,
      "max_count": 50
    }
  }'

# Execute SLM policy immediately for a test
curl -k -X POST \
  -u "elastic:StrongElasticPassword2024!" \
  "https://localhost:9200/_slm/policy/daily-snapshots/_execute"

# Monitor snapshot progress
curl -k -u "elastic:StrongElasticPassword2024!" \
  "https://localhost:9200/_snapshot/s3-backup-repo/_current"
```

---

## Section 14: Common Troubleshooting

### Shard Allocation Explain

```bash
# Find out why a shard is unassigned
curl -k -X POST \
  -u "elastic:StrongElasticPassword2024!" \
  "https://localhost:9200/_cluster/allocation/explain" \
  -H "Content-Type: application/json" \
  -d '{
    "index": "logs-application-2027.03.25",
    "shard": 0,
    "primary": false
  }'
```

### Force Retry Unassigned Shards

```bash
# Retry allocation for all unassigned shards
curl -k -X POST \
  -u "elastic:StrongElasticPassword2024!" \
  "https://localhost:9200/_cluster/reroute?retry_failed=true"
```

### Hot Threads Analysis

```bash
# Identify CPU-intensive threads (useful for debugging slow searches)
curl -k -u "elastic:StrongElasticPassword2024!" \
  "https://localhost:9200/_nodes/hot_threads?interval=5s&threads=3"
```

### Clear Cache on Specific Index

```bash
# Clear fielddata, request, and query caches
curl -k -X POST \
  -u "elastic:StrongElasticPassword2024!" \
  "https://localhost:9200/logs-application-2027.03.25/_cache/clear?fielddata=true&query=true&request=true"
```

ECK reduces Elasticsearch operations to a declarative intent expressed in Kubernetes CRDs. The operator's automatic TLS management, rolling upgrade coordination, and tight integration with the full Elastic Stack — Kibana, Beats, Logstash — makes it the reference deployment model for Elasticsearch on Kubernetes. Combined with ILM-driven data tiering, SLM-based snapshots, and Prometheus alerting, the result is a production logging and search platform that meets enterprise data retention, security, and observability requirements.
