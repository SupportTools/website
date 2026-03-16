---
title: "RabbitMQ Cluster Operator: Production Message Queue Deployment on Kubernetes"
date: 2027-03-29T00:00:00-05:00
draft: false
tags: ["Kubernetes", "RabbitMQ", "Messaging", "Operator", "AMQP"]
categories: ["Kubernetes", "Messaging", "Operators"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide to RabbitMQ Cluster Operator on Kubernetes covering RabbitmqCluster CRD, TLS configuration, federation and shovel plugins, Prometheus monitoring with rabbitmq-exporter, vhost and user management, high-availability policies, and operational runbooks."
more_link: "yes"
url: "/rabbitmq-cluster-operator-kubernetes-guide/"
---

The RabbitMQ Cluster Operator for Kubernetes transforms RabbitMQ deployment from a complex manual process into a declarative resource managed through familiar Kubernetes primitives. Rather than scripting broker installation, managing Erlang cookie synchronization, and hand-wiring cluster join commands, platform teams declare a `RabbitmqCluster` resource and the operator handles initial formation, TLS bootstrap, rolling upgrades, and pod replacement. Companion operators for topology resources — users, vhosts, permissions, queues, exchanges, and bindings — extend the declarative model to the entire RabbitMQ configuration surface.

This guide covers the complete production deployment: cluster configuration, TLS with cert-manager, quorum queue policies, federation for multi-datacenter scenarios, shovel for message migration, Prometheus monitoring, and the operational runbooks needed to operate RabbitMQ confidently at scale.

<!--more-->

## RabbitMQ Cluster Operator Architecture

The RabbitMQ Cluster Operator consists of two main components deployed into the `rabbitmq-system` namespace.

**rabbitmq-cluster-operator**: The primary controller that watches `RabbitmqCluster` resources and manages the underlying StatefulSet, Services, ConfigMaps, and RBAC resources. It handles cluster formation by injecting the Erlang cookie as a Kubernetes Secret and configuring the `rabbitmq.conf` and `advanced.config` files.

**rabbitmq-topology-operator**: A second controller that watches topology resources (`RabbitmqUser`, `RabbitmqVhost`, `RabbitmqPermission`, `RabbitmqQueue`, `RabbitmqExchange`, `RabbitmqBinding`, `RabbitmqPolicy`, `RabbitmqFederation`, `RabbitmqShovel`) and reconciles them against the broker's HTTP management API.

### Installing the Operators

```bash
# Install the RabbitMQ Cluster Operator using the official manifests
kubectl apply -f "https://github.com/rabbitmq/cluster-operator/releases/download/v2.9.0/cluster-operator.yml"

# Install the RabbitMQ Topology Operator
kubectl apply -f "https://github.com/rabbitmq/messaging-topology-operator/releases/download/v1.13.0/messaging-topology-operator-with-certmanager.yml"

# Verify both operators are running
kubectl -n rabbitmq-system get pods
```

For production deployments, pin the operator versions using Helm rather than applying live manifests.

```bash
# Add the RabbitMQ chart repository
helm repo add rabbitmq https://charts.bitnami.com/bitnami
helm repo update

# Install the cluster operator
helm upgrade --install rabbitmq-cluster-operator rabbitmq/rabbitmq-cluster-operator \
  --namespace rabbitmq-system \
  --create-namespace \
  --set clusterOperator.image.tag=2.9.0 \
  --set msgTopologyOperator.image.tag=1.13.0 \
  --wait
```

## RabbitmqCluster CRD: Production Configuration

The `RabbitmqCluster` resource declares the desired state of a RabbitMQ cluster. The following manifest covers a production-grade three-node cluster with TLS, resource limits, persistent storage, and plugin configuration.

```yaml
# rabbitmq-cluster.yaml
# Production three-node RabbitMQ cluster
apiVersion: rabbitmq.com/v1beta1
kind: RabbitmqCluster
metadata:
  name: rabbitmq-main
  namespace: messaging
  labels:
    app: rabbitmq
    environment: production
spec:
  # Number of RabbitMQ nodes (always use an odd number for quorum)
  replicas: 3

  # RabbitMQ server image
  image: rabbitmq:3.13.2-management

  # Persistent volume for Mnesia data and message store
  persistence:
    storageClassName: fast-ssd
    storage: 50Gi

  # Resource allocation per pod
  resources:
    requests:
      cpu: 1000m
      memory: 2Gi
    limits:
      cpu: 4000m
      memory: 4Gi

  # RabbitMQ configuration (rabbitmq.conf format)
  rabbitmq:
    # Enable required plugins
    additionalPlugins:
      - rabbitmq_prometheus      # Prometheus metrics endpoint
      - rabbitmq_shovel          # Message shovel for migration
      - rabbitmq_shovel_management
      - rabbitmq_federation      # Federation for multi-datacenter
      - rabbitmq_federation_management
      - rabbitmq_peer_discovery_k8s  # Kubernetes peer discovery

    # Additional configuration in rabbitmq.conf format
    additionalConfig: |
      # Memory high watermark — RabbitMQ blocks publishers above this
      vm_memory_high_watermark.relative = 0.70

      # Disk free limit — alarm triggered below this
      disk_free_limit.relative = 1.5

      # Default message TTL for queues without explicit TTL (24 hours)
      # Per-queue policies override this
      # x-message-ttl = 86400000

      # Consumer timeout — consumers must ack within this window
      consumer_timeout = 3600000

      # Management HTTP API rate limiting
      management.rates_mode = basic

      # Log level
      log.console.level = info

      # Prometheus metrics port
      prometheus.tcp.port = 15692

    # Advanced Erlang configuration for fine-tuning
    advancedConfig: |
      [
        {rabbit, [
          {collect_statistics_interval, 5000},
          {tcp_listen_options, [
            {backlog, 4096},
            {nodelay, true},
            {linger, {true, 0}},
            {exit_on_close, false},
            {keepalive, true}
          ]}
        ]}
      ].

    # Environment variables injected into the broker container
    envConfig: |
      RABBITMQ_SERVER_ADDITIONAL_ERL_ARGS=-rabbit log [{console,[{level,info}]}]

  # TLS configuration using a cert-manager generated secret
  tls:
    secretName: rabbitmq-tls
    caSecretName: rabbitmq-ca
    disableNonTLSListeners: false  # Keep plain port open for readiness probe

  # Pod scheduling and affinity
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              app.kubernetes.io/name: rabbitmq-main
          topologyKey: kubernetes.io/hostname

  # Tolerations for dedicated messaging nodes
  tolerations:
    - key: dedicated
      operator: Equal
      value: messaging
      effect: NoSchedule

  # Override the default service to expose load-balanced AMQP
  service:
    type: ClusterIP
    annotations:
      service.beta.kubernetes.io/aws-load-balancer-internal: "true"

  # Pod annotations for Prometheus scraping
  podAnnotations:
    prometheus.io/scrape: "true"
    prometheus.io/port: "15692"
    prometheus.io/path: "/metrics"

  # Security context for the RabbitMQ container
  securityContext:
    fsGroup: 999
    runAsGroup: 999
    runAsUser: 999
    runAsNonRoot: true
```

## TLS Configuration with cert-manager

Encrypting AMQP, AMQPS, and management API traffic requires TLS certificates. cert-manager generates and rotates these certificates automatically.

```yaml
# rabbitmq-tls-certs.yaml
# CA certificate for RabbitMQ internal cluster communication
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: rabbitmq-tls
  namespace: messaging
spec:
  secretName: rabbitmq-tls
  duration: 8760h    # 1 year validity
  renewBefore: 720h  # Renew 30 days before expiry
  subject:
    organizations:
      - support.tools
  commonName: rabbitmq-main
  dnsNames:
    - rabbitmq-main
    - rabbitmq-main.messaging
    - rabbitmq-main.messaging.svc
    - rabbitmq-main.messaging.svc.cluster.local
    # Wildcard for individual pod addresses
    - "*.rabbitmq-main-nodes.messaging.svc.cluster.local"
  issuerRef:
    name: internal-ca
    kind: ClusterIssuer
---
# CA secret for peer verification between cluster nodes
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: rabbitmq-ca
  namespace: messaging
spec:
  secretName: rabbitmq-ca
  isCA: true
  commonName: rabbitmq-ca
  duration: 43800h  # 5 years
  issuerRef:
    name: internal-ca
    kind: ClusterIssuer
```

## Topology Operator: Users, Vhosts, and Permissions

The topology operator manages RabbitMQ logical resources through Kubernetes custom resources, enabling GitOps-driven configuration management.

### RabbitmqVhost: Namespace Isolation

```yaml
# rabbitmq-vhosts.yaml
# Separate vhost for each application domain
apiVersion: rabbitmq.com/v1beta1
kind: RabbitmqVhost
metadata:
  name: orders-vhost
  namespace: messaging
spec:
  name: /orders               # Vhost name in RabbitMQ
  tracing: false
  rabbitmqClusterReference:
    name: rabbitmq-main
    namespace: messaging
---
apiVersion: rabbitmq.com/v1beta1
kind: RabbitmqVhost
metadata:
  name: notifications-vhost
  namespace: messaging
spec:
  name: /notifications
  tracing: false
  rabbitmqClusterReference:
    name: rabbitmq-main
    namespace: messaging
```

### RabbitmqUser and RabbitmqPermission

```yaml
# rabbitmq-users.yaml
# Service account user for the orders service
apiVersion: rabbitmq.com/v1beta1
kind: RabbitmqUser
metadata:
  name: orders-service-user
  namespace: messaging
spec:
  name: orders-service
  # Tags: management, policymaker, monitoring, administrator
  tags: ""
  rabbitmqClusterReference:
    name: rabbitmq-main
    namespace: messaging
  # Credentials stored in a Kubernetes secret
  # The operator generates a random password if importCredentialsSecret is omitted
  importCredentialsSecret:
    name: orders-service-rabbitmq-creds
---
# Kubernetes secret holding the user credentials
# kubectl create secret generic orders-service-rabbitmq-creds \
#   --from-literal=username=orders-service \
#   --from-literal=password=EXAMPLE_RABBITMQ_PASSWORD_REPLACE_ME
#
# In production, use External Secrets Operator to pull from Vault or AWS Secrets Manager
apiVersion: v1
kind: Secret
metadata:
  name: orders-service-rabbitmq-creds
  namespace: messaging
type: Opaque
stringData:
  username: orders-service
  password: EXAMPLE_RABBITMQ_PASSWORD_REPLACE_ME
---
# Grant the orders service configure/write/read permissions on the orders vhost
apiVersion: rabbitmq.com/v1beta1
kind: RabbitmqPermission
metadata:
  name: orders-service-permission
  namespace: messaging
spec:
  vhost: /orders
  user: orders-service
  permissions:
    configure: "^orders\\..*"   # Configure queues and exchanges matching pattern
    write: "^orders\\..*"       # Publish to matching exchanges
    read: "^orders\\..*"        # Consume from matching queues
  rabbitmqClusterReference:
    name: rabbitmq-main
    namespace: messaging
```

## Queue Types: Quorum vs Classic vs Streams

### Quorum Queues (Recommended for Production)

Quorum queues are Raft-based replicated queues that provide strong durability guarantees, surviving the loss of a minority of nodes without message loss. They replace mirrored classic queues and should be the default for any production workload requiring high availability.

```yaml
# rabbitmq-queues.yaml
# Quorum queue for order processing
apiVersion: rabbitmq.com/v1beta1
kind: RabbitmqQueue
metadata:
  name: orders-created-queue
  namespace: messaging
spec:
  name: orders.created
  vhost: /orders
  durable: true
  autoDelete: false
  rabbitmqClusterReference:
    name: rabbitmq-main
    namespace: messaging
  arguments:
    # Declare as quorum queue
    x-queue-type: quorum
    # Replication factor (should match cluster size or be odd)
    x-quorum-initial-group-size: 3
    # Dead-letter exchange for failed messages
    x-dead-letter-exchange: orders.dlx
    x-dead-letter-routing-key: orders.created.failed
    # Consumer timeout in milliseconds (30 minutes)
    x-consumer-timeout: 1800000
    # Message TTL (7 days)
    x-message-ttl: 604800000
```

### Classic Queues with High-Availability Policy

Classic queues require a separate HA policy to enable mirroring. The topology operator manages policies through the `RabbitmqPolicy` resource.

```yaml
# rabbitmq-ha-policy.yaml
# High-availability policy for all queues in the orders vhost
apiVersion: rabbitmq.com/v1beta1
kind: RabbitmqPolicy
metadata:
  name: orders-ha-policy
  namespace: messaging
spec:
  name: orders-ha
  vhost: /orders
  # Apply to all queues in the vhost
  pattern: ".*"
  applyTo: queues
  definition:
    # Mirror to all cluster nodes
    ha-mode: all
    ha-sync-mode: automatic
    # Remove mirrors that are too far behind
    ha-promote-on-failure: when-synced
    # Synchronize new mirrors automatically
    ha-sync-batch-size: 4096
  rabbitmqClusterReference:
    name: rabbitmq-main
    namespace: messaging
```

### RabbitMQ Streams for High-Throughput Append-Only Logs

RabbitMQ Streams (available since 3.9) provide a Kafka-like append-only log with offset-based consumer tracking.

```yaml
# rabbitmq-stream-queue.yaml
# Stream queue for high-throughput event ingestion
apiVersion: rabbitmq.com/v1beta1
kind: RabbitmqQueue
metadata:
  name: events-stream
  namespace: messaging
spec:
  name: events.stream
  vhost: /orders
  durable: true
  rabbitmqClusterReference:
    name: rabbitmq-main
    namespace: messaging
  arguments:
    x-queue-type: stream
    # Retain stream data for 7 days
    x-max-age: 7D
    # Maximum stream size (10GB per replica)
    x-max-length-bytes: 10737418240
    # Number of stream replicas
    x-initial-cluster-size: 3
```

## Federation Plugin: Multi-Datacenter Messaging

RabbitMQ Federation allows exchanges and queues in one cluster to receive messages published to another cluster. It is appropriate for active-active multi-datacenter deployments where each site produces messages that other sites need to consume.

### Federation Upstream Configuration

```yaml
# rabbitmq-federation.yaml
# Federation link to the EU datacenter cluster
apiVersion: rabbitmq.com/v1beta1
kind: RabbitmqFederation
metadata:
  name: federation-to-eu
  namespace: messaging
spec:
  name: eu-upstream
  vhost: /orders
  uriSecret:
    # Secret containing the AMQPS URI of the upstream cluster
    name: rabbitmq-eu-federation-uri
  # Federation policy for exchange federation
  exchangeName: orders.events
  # Acknowledgment mode: on-confirm, on-publish, no-ack
  ackMode: on-confirm
  rabbitmqClusterReference:
    name: rabbitmq-main
    namespace: messaging
---
# Secret with the upstream cluster URI
# kubectl create secret generic rabbitmq-eu-federation-uri \
#   --from-literal=uri="amqps://federation-user:EXAMPLE_FEDERATION_PASSWORD_REPLACE_ME@rabbitmq-eu.example.com:5671/orders?cacertfile=/etc/rabbitmq/certs/ca.crt"
apiVersion: v1
kind: Secret
metadata:
  name: rabbitmq-eu-federation-uri
  namespace: messaging
type: Opaque
stringData:
  uri: "amqps://federation-user:EXAMPLE_FEDERATION_PASSWORD_REPLACE_ME@rabbitmq-eu.example.com:5671/orders"
---
# Policy to enable exchange federation
apiVersion: rabbitmq.com/v1beta1
kind: RabbitmqPolicy
metadata:
  name: federation-policy
  namespace: messaging
spec:
  name: orders-federation
  vhost: /orders
  pattern: "orders\\.events"
  applyTo: exchanges
  definition:
    # Upstream set that this policy applies to
    federation-upstream: eu-upstream
  rabbitmqClusterReference:
    name: rabbitmq-main
    namespace: messaging
```

## Shovel Plugin: Message Migration

The shovel plugin moves or copies messages between queues or brokers. It is the standard approach for migrating consumers between clusters, draining dead-letter queues, and routing messages to multiple destinations.

```yaml
# rabbitmq-shovel.yaml
# Dynamic shovel to drain the legacy queue into the new cluster
apiVersion: rabbitmq.com/v1beta1
kind: RabbitmqShovel
metadata:
  name: legacy-migration-shovel
  namespace: messaging
spec:
  name: legacy-to-new
  vhost: /orders
  rabbitmqClusterReference:
    name: rabbitmq-main
    namespace: messaging
  # Source queue on the legacy broker
  srcUri:
    secretKeyRef:
      name: rabbitmq-legacy-uri
      key: uri
  srcQueue: legacy.orders.created
  srcDeleteAfter: queue-length   # Delete from source after consuming all current messages
  srcPrefetchCount: 100
  srcAckMode: on-confirm

  # Destination queue on the new cluster
  destUri:
    secretKeyRef:
      name: rabbitmq-new-uri
      key: uri
  destQueue: orders.created
  destAddForwardHeaders: true    # Add x-shovelled headers for tracing
  destPublishProperties:
    delivery_mode: 2  # Persistent delivery
---
# Secret for the legacy broker URI
apiVersion: v1
kind: Secret
metadata:
  name: rabbitmq-legacy-uri
  namespace: messaging
type: Opaque
stringData:
  uri: "amqps://shovel-user:EXAMPLE_SHOVEL_PASSWORD_REPLACE_ME@rabbitmq-legacy.messaging.svc.cluster.local:5671/orders"
---
apiVersion: v1
kind: Secret
metadata:
  name: rabbitmq-new-uri
  namespace: messaging
type: Opaque
stringData:
  uri: "amqps://shovel-user:EXAMPLE_SHOVEL_PASSWORD_REPLACE_ME@rabbitmq-main.messaging.svc.cluster.local:5671/orders"
```

## Prometheus Monitoring with ServiceMonitor

The `rabbitmq_prometheus` plugin exposes a Prometheus metrics endpoint on port 15692. The Prometheus Operator scrapes this endpoint via a `ServiceMonitor`.

```yaml
# rabbitmq-monitoring.yaml
# ServiceMonitor for Prometheus Operator
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: rabbitmq-main
  namespace: monitoring
  labels:
    release: prometheus
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: rabbitmq-main
  namespaceSelector:
    matchNames:
      - messaging
  endpoints:
    # Per-object metrics (queue depth, consumer count, etc.)
    - port: prometheus
      interval: 30s
      path: /metrics
    # Aggregated cluster metrics (connections, channels, etc.)
    - port: prometheus
      interval: 30s
      path: /metrics/per-object
---
# PrometheusRule for RabbitMQ alerting
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: rabbitmq-alerts
  namespace: monitoring
  labels:
    release: prometheus
spec:
  groups:
    - name: rabbitmq.cluster
      interval: 1m
      rules:
        - alert: RabbitMQNodeDown
          expr: rabbitmq_identity_info * on(instance) group_left() up == 0
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "RabbitMQ node is down"
            description: "RabbitMQ node {{ $labels.instance }} has been unreachable for 2 minutes."

        - alert: RabbitMQQueueDepthHigh
          expr: rabbitmq_queue_messages > 50000
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "RabbitMQ queue depth is high"
            description: "Queue {{ $labels.queue }} on vhost {{ $labels.vhost }} has {{ $value }} messages."

        - alert: RabbitMQNoConsumers
          expr: rabbitmq_queue_consumers == 0 and rabbitmq_queue_messages > 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "RabbitMQ queue has messages but no consumers"
            description: "Queue {{ $labels.queue }} has {{ $labels.rabbitmq_queue_messages }} messages but zero consumers."

        - alert: RabbitMQMemoryHigh
          expr: rabbitmq_process_resident_memory_bytes / rabbitmq_resident_memory_limit_bytes > 0.85
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "RabbitMQ memory usage is high"
            description: "RabbitMQ node {{ $labels.instance }} memory usage is {{ $value | humanizePercentage }}."

        - alert: RabbitMQFileDescriptorsLow
          expr: rabbitmq_process_open_fds / rabbitmq_process_max_fds > 0.80
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "RabbitMQ file descriptor usage is high"
            description: "Node {{ $labels.instance }} file descriptor usage is {{ $value | humanizePercentage }}."

        - alert: RabbitMQUnackedMessagesHigh
          expr: rabbitmq_queue_messages_unacked > 10000
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "RabbitMQ unacknowledged messages are high"
            description: "Queue {{ $labels.queue }} has {{ $value }} unacknowledged messages. Consumers may be stalled."
```

### Grafana Dashboard Queries

Key PromQL queries for the RabbitMQ Grafana dashboard:

```promql
# Messages per second across all queues
sum(rate(rabbitmq_queue_messages_published_total[5m]))

# Average message publish rate by queue
rate(rabbitmq_queue_messages_published_total[5m])

# Queue depth for the orders queue
rabbitmq_queue_messages{queue="orders.created", vhost="/orders"}

# Consumer count per queue
rabbitmq_queue_consumers{vhost="/orders"}

# Memory usage percentage per node
rabbitmq_process_resident_memory_bytes / rabbitmq_resident_memory_limit_bytes * 100

# Connection count over time
rabbitmq_connections

# Disk free space per node
rabbitmq_disk_space_available_bytes
```

## Management Plugin UI via Ingress

The management plugin exposes a web UI on port 15672. Exposing it through an Ingress with authentication protects it from unauthorized access.

```yaml
# rabbitmq-management-ingress.yaml
# Ingress for RabbitMQ management UI
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: rabbitmq-management
  namespace: messaging
  annotations:
    # cert-manager TLS
    cert-manager.io/cluster-issuer: letsencrypt-prod
    # Nginx: restrict access to VPN CIDR
    nginx.ingress.kubernetes.io/whitelist-source-range: "10.0.0.0/8,172.16.0.0/12"
    # Enable basic auth backed by an htpasswd secret
    nginx.ingress.kubernetes.io/auth-type: basic
    nginx.ingress.kubernetes.io/auth-secret: rabbitmq-management-auth
    nginx.ingress.kubernetes.io/auth-realm: "RabbitMQ Management"
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - rabbitmq.messaging.support.tools
      secretName: rabbitmq-management-tls
  rules:
    - host: rabbitmq.messaging.support.tools
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: rabbitmq-main
                port:
                  name: management
```

## Memory High Watermark Tuning

RabbitMQ monitors memory consumption and enters a flow-control state when memory usage exceeds the high watermark. Tuning this watermark prevents out-of-memory crashes while maximizing throughput.

### Calculating the Watermark

The default `vm_memory_high_watermark.relative = 0.40` allocates 40% of available system RAM to RabbitMQ. For a container with a 4Gi memory limit, this yields approximately 1.6Gi before flow control activates.

For workloads that spike in message accumulation (batch processing, consumer downtime), increase the watermark to 0.70 to use 2.8Gi before throttling. Set the absolute limit instead of relative when the container has a known fixed limit:

```ini
# rabbitmq.conf snippet for absolute memory limit
vm_memory_high_watermark.absolute = 2800MiB
```

The disk free limit should be at least the watermark value to ensure messages can be paged to disk before memory is exhausted:

```ini
# Disk free minimum: 2.8GB (matches the memory high watermark)
disk_free_limit.absolute = 2800MiB
```

## Rolling Updates and Cluster Maintenance

The RabbitMQ Cluster Operator performs rolling updates by updating pods one at a time in reverse ordinal order. For quorum queues, the cluster tolerates losing one node at a time without losing quorum in a three-node cluster.

### Pre-Update Checklist

```bash
# Verify all queues have synchronized mirrors (for classic mirrored queues)
kubectl exec -n messaging rabbitmq-main-0 -- rabbitmqctl list_queues name synchronised_slave_pids

# Check quorum queue leader distribution
kubectl exec -n messaging rabbitmq-main-0 -- rabbitmqctl list_queues name type leader_node members

# Verify cluster status shows all nodes running
kubectl exec -n messaging rabbitmq-main-0 -- rabbitmqctl cluster_status

# Check that all queue consumers are connected before proceeding
kubectl exec -n messaging rabbitmq-main-0 -- rabbitmqctl list_consumers
```

### Triggering a Rolling Restart

```bash
# Force a rolling restart by updating a cluster annotation
kubectl annotate rabbitmqcluster -n messaging rabbitmq-main \
  rabbitmq.com/restartAt="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --overwrite

# Watch the rolling restart progress
kubectl rollout status statefulset/rabbitmq-main -n messaging --watch
```

## Operational Runbooks

### Investigating Queue Backlog

```bash
# List all queues with message depth sorted by depth
kubectl exec -n messaging rabbitmq-main-0 -- rabbitmqctl list_queues \
  name messages consumers memory state \
  --vhost /orders \
  --sorted messages

# Show consumers for a specific queue
kubectl exec -n messaging rabbitmq-main-0 -- rabbitmqctl list_consumers \
  --vhost /orders \
  | grep "orders.created"

# Inspect unacknowledged messages
kubectl exec -n messaging rabbitmq-main-0 -- rabbitmqctl list_queues \
  name messages_ready messages_unacknowledged \
  --vhost /orders
```

### Purging a Dead Letter Queue

```bash
# Purge all messages from a dead letter queue
kubectl exec -n messaging rabbitmq-main-0 -- rabbitmqctl \
  purge_queue orders.created.failed \
  --vhost /orders

# Move DLQ messages back to the main queue using shovel
# Apply a temporary RabbitmqShovel resource pointing from DLQ to the main queue
```

### Forcing a Node to Rejoin the Cluster

```bash
# If a node is partitioned, force it to forget its current state and rejoin
kubectl exec -n messaging rabbitmq-main-2 -- rabbitmqctl stop_app
kubectl exec -n messaging rabbitmq-main-2 -- rabbitmqctl reset
kubectl exec -n messaging rabbitmq-main-2 -- rabbitmqctl join_cluster rabbit@rabbitmq-main-0.rabbitmq-main-nodes.messaging.svc.cluster.local
kubectl exec -n messaging rabbitmq-main-2 -- rabbitmqctl start_app

# Verify the node is back in the cluster
kubectl exec -n messaging rabbitmq-main-0 -- rabbitmqctl cluster_status
```

### Exporting and Importing Configuration

```bash
# Export the entire broker configuration (definitions)
kubectl exec -n messaging rabbitmq-main-0 -- rabbitmqctl export_definitions /tmp/definitions.json

# Copy the definitions file locally
kubectl cp messaging/rabbitmq-main-0:/tmp/definitions.json ./rabbitmq-definitions-$(date +%Y%m%d).json

# Import definitions to a new or restored broker
kubectl cp ./rabbitmq-definitions-20270315.json messaging/rabbitmq-main-0:/tmp/definitions.json
kubectl exec -n messaging rabbitmq-main-0 -- rabbitmqctl import_definitions /tmp/definitions.json
```

## Summary

The RabbitMQ Cluster Operator provides a fully declarative approach to managing RabbitMQ on Kubernetes. The `RabbitmqCluster` CRD handles cluster formation, TLS bootstrap, and rolling upgrades. Companion topology resources manage users, vhosts, permissions, queues, and policies through GitOps workflows. Quorum queues provide the strongest durability guarantees for production workloads, replacing classic mirrored queues. The federation plugin enables active-active multi-datacenter deployments, while the shovel plugin handles zero-downtime migration scenarios. Prometheus monitoring via the built-in `rabbitmq_prometheus` plugin with `ServiceMonitor` and alerting rules gives platform teams the observability needed to detect and respond to queue backlogs, memory pressure, and node failures before they affect application throughput.
