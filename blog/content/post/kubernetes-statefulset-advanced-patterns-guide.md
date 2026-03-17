---
title: "Kubernetes StatefulSets: Advanced Patterns for Distributed Stateful Applications"
date: 2027-08-14T00:00:00-05:00
draft: false
tags: ["Kubernetes", "StatefulSets", "Databases", "Storage"]
categories:
- Kubernetes
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "Advanced Kubernetes StatefulSet patterns covering ordered pod management, headless services, persistent storage with volumeClaimTemplates, rolling update strategies for stateful applications, and migration patterns from VMs to StatefulSets."
more_link: "yes"
url: "/kubernetes-statefulset-advanced-patterns-guide/"
---

StatefulSets provide Kubernetes with the ability to manage stateful applications that require stable network identities, ordered deployment and scaling, and persistent storage that survives pod rescheduling. Running distributed databases, message brokers, and consensus systems on Kubernetes requires understanding not just the StatefulSet API surface, but also how headless services, volumeClaimTemplates, and ordered management interact with the underlying storage and network infrastructure.

<!--more-->

## StatefulSet Core Properties

StatefulSets differ from Deployments in four fundamental ways:

1. **Stable network identities**: Each pod gets a predictable hostname: `<statefulset-name>-<ordinal>`
2. **Ordered deployment**: Pods are created in order (0, 1, 2...) and deleted in reverse order
3. **Stable persistent storage**: Each pod gets its own PVC from `volumeClaimTemplates`, and PVCs survive pod deletion
4. **Stable DNS names**: Combined with a headless service, each pod gets a unique DNS record

```
Pod names:    kafka-0, kafka-1, kafka-2
DNS records:  kafka-0.kafka.production.svc.cluster.local
              kafka-1.kafka.production.svc.cluster.local
              kafka-2.kafka.production.svc.cluster.local
PVC names:    data-kafka-0, data-kafka-1, data-kafka-2
```

## Headless Service and DNS

A headless service (clusterIP: None) is mandatory for StatefulSets. It creates the DNS records for individual pod addressing.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: kafka
  namespace: production
  labels:
    app: kafka
spec:
  clusterIP: None          # Headless
  publishNotReadyAddresses: true  # Include not-Ready pods in DNS
  selector:
    app: kafka
  ports:
    - name: client
      port: 9092
    - name: inter-broker
      port: 9093
    - name: jmx
      port: 9999
```

`publishNotReadyAddresses: true` ensures DNS records are created even before pods pass readiness checks. This is essential for bootstrapping distributed systems that need to discover peers before they're Ready.

A second regular Service provides the standard ClusterIP endpoint for clients that want to talk to any broker:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: kafka-client
  namespace: production
spec:
  selector:
    app: kafka
  ports:
    - name: client
      port: 9092
```

## Complete StatefulSet: Kafka Example

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: kafka
  namespace: production
spec:
  serviceName: kafka          # Must match the headless Service name
  replicas: 3
  podManagementPolicy: Parallel  # Create/delete all pods simultaneously
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      partition: 0            # Update all pods (set > 0 for canary rollouts)
      maxUnavailable: 1
  selector:
    matchLabels:
      app: kafka
  template:
    metadata:
      labels:
        app: kafka
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  app: kafka
              topologyKey: kubernetes.io/hostname
      terminationGracePeriodSeconds: 120
      containers:
        - name: kafka
          image: confluentinc/cp-kafka:7.6.0
          ports:
            - containerPort: 9092
              name: client
            - containerPort: 9093
              name: inter-broker
          env:
            - name: KAFKA_BROKER_ID
              valueFrom:
                fieldRef:
                  fieldPath: metadata.annotations['kafka.broker.id']
            - name: POD_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
            - name: POD_NAMESPACE
              valueFrom:
                fieldRef:
                  fieldPath: metadata.namespace
            - name: KAFKA_ZOOKEEPER_CONNECT
              value: "zookeeper-0.zookeeper.$(POD_NAMESPACE).svc.cluster.local:2181,zookeeper-1.zookeeper.$(POD_NAMESPACE).svc.cluster.local:2181,zookeeper-2.zookeeper.$(POD_NAMESPACE).svc.cluster.local:2181"
            - name: KAFKA_ADVERTISED_LISTENERS
              value: "PLAINTEXT://$(POD_NAME).kafka.$(POD_NAMESPACE).svc.cluster.local:9092"
            - name: KAFKA_LOG_DIRS
              value: /var/kafka/data
            - name: KAFKA_AUTO_CREATE_TOPICS_ENABLE
              value: "false"
            - name: KAFKA_DEFAULT_REPLICATION_FACTOR
              value: "3"
            - name: KAFKA_MIN_INSYNC_REPLICAS
              value: "2"
          resources:
            requests:
              cpu: "2"
              memory: 4Gi
            limits:
              cpu: "4"
              memory: 8Gi
          readinessProbe:
            exec:
              command:
                - /bin/bash
                - -c
                - kafka-broker-api-versions --bootstrap-server localhost:9092
            initialDelaySeconds: 30
            periodSeconds: 10
            timeoutSeconds: 5
            failureThreshold: 3
          livenessProbe:
            exec:
              command:
                - /bin/bash
                - -c
                - kafka-broker-api-versions --bootstrap-server localhost:9092
            initialDelaySeconds: 60
            periodSeconds: 20
            timeoutSeconds: 10
            failureThreshold: 5
          volumeMounts:
            - name: data
              mountPath: /var/kafka/data
            - name: config
              mountPath: /etc/kafka/config
      volumes:
        - name: config
          configMap:
            name: kafka-config
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes:
          - ReadWriteOnce
        storageClassName: fast-nvme
        resources:
          requests:
            storage: 500Gi
```

## Pod Management Policies

### OrderedReady (Default)

With `OrderedReady`, StatefulSet creates pods in order and waits for each to be Running and Ready before creating the next. Deletion occurs in reverse order.

```
Create: kafka-0 → (wait until Ready) → kafka-1 → (wait until Ready) → kafka-2
Delete: kafka-2 → (wait until terminated) → kafka-1 → kafka-0
```

Use `OrderedReady` when:
- The application requires bootstrapping with a known primary (e.g., etcd initial cluster)
- Startup order matters for data consistency

### Parallel

With `Parallel`, all pods are created or deleted simultaneously without waiting for Ready status.

```yaml
spec:
  podManagementPolicy: Parallel
```

Use `Parallel` when:
- Applications can bootstrap independently (Kafka, Cassandra with gossip protocol)
- Faster startup and scale operations are needed
- The application handles its own cluster membership

## Rolling Update Strategies

### Standard Rolling Update

```yaml
updateStrategy:
  type: RollingUpdate
  rollingUpdate:
    partition: 0          # Update all pods
    maxUnavailable: 1     # Allow one unavailable at a time
```

StatefulSet rolling updates always proceed in reverse ordinal order: highest ordinal first. For a 3-pod StatefulSet, the update order is: kafka-2 → kafka-1 → kafka-0.

### Canary Rollout with Partition

The `partition` field enables a canary rollout pattern. Only pods with ordinals >= partition are updated:

```bash
# Phase 1: Update only kafka-2 (the highest ordinal)
kubectl patch statefulset kafka -n production \
    -p '{"spec":{"updateStrategy":{"rollingUpdate":{"partition":2}}}}'

# Apply the new image
kubectl set image statefulset/kafka kafka=confluentinc/cp-kafka:7.7.0 -n production

# Verify kafka-2 is healthy
kubectl rollout status statefulset/kafka -n production

# Phase 2: Extend to kafka-1 and kafka-2
kubectl patch statefulset kafka -n production \
    -p '{"spec":{"updateStrategy":{"rollingUpdate":{"partition":1}}}}'

# Phase 3: Complete the rollout
kubectl patch statefulset kafka -n production \
    -p '{"spec":{"updateStrategy":{"rollingUpdate":{"partition":0}}}}'
```

### OnDelete Strategy

With `OnDelete`, pods are only updated when manually deleted. This gives complete control over when each pod is updated:

```yaml
updateStrategy:
  type: OnDelete
```

```bash
# Manually trigger update of kafka-2
kubectl delete pod kafka-2 -n production
# Wait for kafka-2 to restart with new image and become Ready
kubectl wait pod kafka-2 -n production --for=condition=Ready --timeout=300s

# Then update kafka-1
kubectl delete pod kafka-1 -n production
kubectl wait pod kafka-1 -n production --for=condition=Ready --timeout=300s
```

## Managing PVC Lifecycle

### Automatic PVC Deletion (Kubernetes 1.27+)

```yaml
spec:
  persistentVolumeClaimRetentionPolicy:
    whenDeleted: Delete    # Delete PVCs when the StatefulSet is deleted
    whenScaled: Retain     # Keep PVCs when the StatefulSet is scaled down
```

The default (`Retain` for both) preserves PVCs after both deletion and scale-down, preventing accidental data loss.

### Manual PVC Management

When scaling down a StatefulSet from 5 to 3 replicas, the PVCs for pods 3 and 4 are retained:

```bash
# PVCs that remain after scale-down
kubectl get pvc -n production -l app=kafka
# data-kafka-0  Bound
# data-kafka-1  Bound
# data-kafka-2  Bound
# data-kafka-3  Bound   ← retained after scale-down
# data-kafka-4  Bound   ← retained after scale-down
```

To clean up orphaned PVCs:

```bash
for i in 3 4; do
    kubectl delete pvc "data-kafka-${i}" -n production
done
```

## Initializing StatefulSet Pods with Init Containers

Init containers are essential for StatefulSet bootstrap sequences. They can configure the application based on ordinal index:

```yaml
initContainers:
  - name: init-config
    image: busybox:1.36
    command:
      - /bin/sh
      - -c
      - |
        # Extract ordinal from pod name (kafka-0, kafka-1, kafka-2)
        ORDINAL=$(echo "${POD_NAME}" | rev | cut -d'-' -f1 | rev)
        echo "BROKER_ID=${ORDINAL}" > /config/broker.env
        echo "Configured broker ID: ${ORDINAL}"
    env:
      - name: POD_NAME
        valueFrom:
          fieldRef:
            fieldPath: metadata.name
    volumeMounts:
      - name: config
        mountPath: /config
```

## VM-to-StatefulSet Migration Pattern

Migrating stateful workloads from VMs to StatefulSets requires careful data migration. The general pattern:

### Phase 1: Prepare Kubernetes Storage

```bash
# Create PVCs that will receive the migrated data
for i in 0 1 2; do
kubectl apply -f - <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: kafka-migration-${i}
  namespace: production
spec:
  storageClassName: fast-nvme
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 500Gi
EOF
done
```

### Phase 2: Data Transfer Job

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: kafka-data-migration-0
  namespace: production
spec:
  template:
    spec:
      restartPolicy: OnFailure
      containers:
        - name: rsync
          image: instrumentisto/rsync-ssh:latest
          command:
            - rsync
            - -avz
            - --progress
            - -e
            - "ssh -o StrictHostKeyChecking=no -i /ssh/id_rsa"
            - "kafka-vm-01:/var/kafka/data/"
            - /target/
          volumeMounts:
            - name: target
              mountPath: /target
            - name: ssh-key
              mountPath: /ssh
              readOnly: true
      volumes:
        - name: target
          persistentVolumeClaim:
            claimName: kafka-migration-0
        - name: ssh-key
          secret:
            secretName: migration-ssh-key
            defaultMode: 0400
```

### Phase 3: Rename PVCs to Match volumeClaimTemplates Pattern

StatefulSet volumeClaimTemplates create PVCs named `<claim-template-name>-<statefulset-name>-<ordinal>`. After migration, rename the PVCs by:

1. Unbinding the migrated PVC from the PV by deleting it
2. Setting the PV reclaim policy to Retain
3. Recreating the PVC with the correct name

```bash
# Get the PV name
PV_NAME=$(kubectl get pvc kafka-migration-0 -n production -o jsonpath='{.spec.volumeName}')

# Retain the PV
kubectl patch pv "${PV_NAME}" -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'

# Delete the old PVC
kubectl delete pvc kafka-migration-0 -n production

# Remove the claimRef from the PV so it becomes Available
kubectl patch pv "${PV_NAME}" \
    -p '{"spec":{"claimRef":null}}'

# Create a new PVC with the correct StatefulSet name
kubectl apply -f - <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: data-kafka-0
  namespace: production
spec:
  storageClassName: fast-nvme
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 500Gi
  volumeName: ${PV_NAME}
EOF
```

## StatefulSet Status and Health Checks

### Monitoring StatefulSet Status

```bash
# Watch rollout progress
kubectl rollout status statefulset/kafka -n production

# Check StatefulSet status fields
kubectl get statefulset kafka -n production -o json | jq '{
  replicas: .status.replicas,
  readyReplicas: .status.readyReplicas,
  currentReplicas: .status.currentReplicas,
  updatedReplicas: .status.updatedReplicas,
  currentRevision: .status.currentRevision,
  updateRevision: .status.updateRevision
}'
```

### Prometheus Alerts for StatefulSets

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: statefulset-alerts
  namespace: monitoring
spec:
  groups:
    - name: statefulset
      rules:
        - alert: StatefulSetReplicasMismatch
          expr: |
            kube_statefulset_replicas != kube_statefulset_status_replicas_ready
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "StatefulSet {{ $labels.namespace }}/{{ $labels.statefulset }} has pod replica mismatch"

        - alert: StatefulSetUpdateInProgress
          expr: |
            kube_statefulset_status_replicas_updated
              != kube_statefulset_status_replicas
          for: 30m
          labels:
            severity: warning
          annotations:
            summary: "StatefulSet {{ $labels.namespace }}/{{ $labels.statefulset }} update has been in progress for 30+ minutes"
```

## Summary

StatefulSets enable production-grade deployment of distributed databases, message brokers, and consensus systems on Kubernetes. The combination of stable pod identities, headless services for DNS-based peer discovery, and volumeClaimTemplates for per-pod persistent storage provides the foundation that stateful applications require. The partition-based canary rollout strategy is particularly valuable for safely upgrading Kafka, Zookeeper, and similar quorum-sensitive systems, where losing too many nodes simultaneously can cause complete cluster unavailability. VM-to-StatefulSet migrations require careful PV/PVC lifecycle management to ensure data continuity throughout the migration process.
