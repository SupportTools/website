---
title: "Kubernetes StatefulSet Advanced: Ordered Rolling Updates, PVC Templates, Headless Services, and Pod Management"
date: 2028-09-07T00:00:00-05:00
draft: false
tags: ["Kubernetes", "StatefulSet", "PVC", "Headless Services", "Distributed Databases"]
categories:
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Master Kubernetes StatefulSets for distributed databases: ordered rolling updates, PVC retention policies, headless service DNS resolution, partition-based canary updates, and lifecycle management for Cassandra, Kafka, and PostgreSQL."
more_link: "yes"
url: "/kubernetes-statefulset-advanced-pvc-headless-guide/"
---

StatefulSets are Kubernetes' mechanism for running stateful workloads that need stable network identities, persistent storage, and ordered lifecycle management. While Deployments are suitable for stateless services, distributed databases like Cassandra, Kafka, and Etcd require the guarantees that StatefulSets provide. This guide covers everything from basic StatefulSet anatomy to advanced patterns: partition-based canary upgrades, PVC retention policies, headless service DNS, init containers for data initialization, and cluster-aware pod disruption.

<!--more-->

# Kubernetes StatefulSet Advanced: Ordered Rolling Updates, PVC Templates, Headless Services, and Pod Management

## Section 1: StatefulSet Guarantees and When to Use Them

StatefulSets provide three guarantees that Deployments cannot:

1. **Stable network identity**: Pod `web-0` always has DNS `web-0.web-svc.namespace.svc.cluster.local`
2. **Stable persistent storage**: PVC `data-web-0` is bound to pod `web-0` exclusively
3. **Ordered pod management**: Pods start/stop in a defined order (0→N for scale-up, N→0 for scale-down)

Use StatefulSets for:
- Databases (PostgreSQL, MySQL, MongoDB, Cassandra)
- Message brokers (Kafka, RabbitMQ)
- Distributed coordination (ZooKeeper, Etcd)
- Caches requiring consistent hashing (Redis Cluster)
- Any app that needs a stable hostname

Do NOT use StatefulSets for stateless apps — the ordering guarantees add unnecessary complexity and slow deployments.

## Section 2: Anatomy of a Complete StatefulSet

```yaml
# cassandra-statefulset.yaml
apiVersion: v1
kind: Service
metadata:
  name: cassandra
  namespace: databases
  labels:
    app: cassandra
spec:
  # Headless service: clusterIP: None means kube-dns creates
  # A records for each pod instead of a single ClusterIP.
  # cassandra-0.cassandra.databases.svc.cluster.local -> pod IP
  # cassandra-1.cassandra.databases.svc.cluster.local -> pod IP
  clusterIP: None
  selector:
    app: cassandra
  ports:
    - name: intra-node
      port: 7000
    - name: tls-intra-node
      port: 7001
    - name: jmx
      port: 7199
    - name: cql
      port: 9042
    - name: thrift
      port: 9160
---
# Regular service for client connections (round-robin across nodes)
apiVersion: v1
kind: Service
metadata:
  name: cassandra-client
  namespace: databases
  labels:
    app: cassandra
spec:
  selector:
    app: cassandra
  ports:
    - name: cql
      port: 9042
      targetPort: 9042
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: cassandra
  namespace: databases
  labels:
    app: cassandra
  annotations:
    app.kubernetes.io/version: "4.1.5"
spec:
  serviceName: cassandra    # Must match the headless Service name
  replicas: 3
  selector:
    matchLabels:
      app: cassandra

  # PodManagementPolicy controls pod startup/shutdown ordering.
  # OrderedReady (default): strict ordering, wait for pod Ready before next
  # Parallel: start/stop all pods simultaneously (use for scale, not initial deploy)
  podManagementPolicy: OrderedReady

  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      # Partition N means: only update pods with ordinal >= N.
      # Use for canary upgrades: set partition=2 to update only pod-2 first.
      partition: 0
      maxUnavailable: 1    # Allows faster rolling updates (Kubernetes 1.24+)

  # PVC retention policy (Kubernetes 1.27+)
  persistentVolumeClaimRetentionPolicy:
    whenDeleted: Retain     # Keep PVCs when StatefulSet is deleted
    whenScaled: Delete      # Delete PVCs when scaling down

  template:
    metadata:
      labels:
        app: cassandra
        version: "4.1.5"
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9500"
    spec:
      terminationGracePeriodSeconds: 120  # Cassandra needs time to drain
      affinity:
        # Spread pods across nodes for HA
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  app: cassandra
              topologyKey: kubernetes.io/hostname
        # Prefer pods in different AZs
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchLabels:
                    app: cassandra
                topologyKey: topology.kubernetes.io/zone

      # Don't evict Cassandra pods — use PDB instead
      priorityClassName: high-priority

      securityContext:
        fsGroup: 999
        runAsUser: 999
        runAsNonRoot: true

      initContainers:
        # Fix permissions on the mounted data volume
        - name: fix-permissions
          image: busybox:1.36
          command: ["sh", "-c", "chown -R 999:999 /cassandra/data"]
          volumeMounts:
            - name: cassandra-data
              mountPath: /cassandra/data
          securityContext:
            runAsUser: 0

        # Bootstrap: set CASSANDRA_SEEDS based on ordinal
        - name: cassandra-bootstrap
          image: cassandra:4.1.5
          command:
            - sh
            - -c
            - |
              # Extract pod ordinal from hostname (cassandra-0, cassandra-1, etc.)
              ORDINAL=$(hostname | awk -F'-' '{print $NF}')
              SEEDS="cassandra-0.cassandra.${POD_NAMESPACE}.svc.cluster.local"
              echo "CASSANDRA_SEEDS=${SEEDS}" > /etc/cassandra/env
              echo "CASSANDRA_BROADCAST_ADDRESS=${POD_IP}" >> /etc/cassandra/env
              echo "Bootstrap complete. Ordinal: ${ORDINAL}, Seeds: ${SEEDS}"
          env:
            - name: POD_NAMESPACE
              valueFrom:
                fieldRef:
                  fieldPath: metadata.namespace
            - name: POD_IP
              valueFrom:
                fieldRef:
                  fieldPath: status.podIP
          volumeMounts:
            - name: cassandra-env
              mountPath: /etc/cassandra

      containers:
        - name: cassandra
          image: cassandra:4.1.5
          imagePullPolicy: IfNotPresent

          ports:
            - containerPort: 7000
              name: intra-node
            - containerPort: 7001
              name: tls-intra-node
            - containerPort: 7199
              name: jmx
            - containerPort: 9042
              name: cql
            - containerPort: 9160
              name: thrift

          env:
            - name: MAX_HEAP_SIZE
              value: "4096M"
            - name: HEAP_NEWSIZE
              value: "800M"
            - name: CASSANDRA_CLUSTER_NAME
              value: "production-cluster"
            - name: CASSANDRA_DC
              value: "dc1"
            - name: CASSANDRA_RACK
              valueFrom:
                fieldRef:
                  fieldPath: metadata.labels['topology.kubernetes.io/zone']
            - name: POD_IP
              valueFrom:
                fieldRef:
                  fieldPath: status.podIP
            - name: POD_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
            - name: POD_NAMESPACE
              valueFrom:
                fieldRef:
                  fieldPath: metadata.namespace
            - name: CASSANDRA_SEEDS
              value: "cassandra-0.cassandra.$(POD_NAMESPACE).svc.cluster.local"

          resources:
            requests:
              cpu: "2"
              memory: 6Gi
            limits:
              cpu: "4"
              memory: 8Gi

          # Readiness: probe CQL port — pod is ready when it can accept connections
          readinessProbe:
            exec:
              command:
                - /bin/bash
                - -c
                - nodetool status | grep -E "^UN" | grep $(hostname -i)
            initialDelaySeconds: 90
            periodSeconds: 30
            timeoutSeconds: 10
            successThreshold: 1
            failureThreshold: 5

          # Liveness: more lenient — only fail if Cassandra process is stuck
          livenessProbe:
            exec:
              command:
                - /bin/bash
                - -c
                - nodetool info | grep "Gossip active"
            initialDelaySeconds: 120
            periodSeconds: 60
            timeoutSeconds: 20
            failureThreshold: 3

          # Startup probe: give Cassandra up to 10 minutes to start
          startupProbe:
            exec:
              command:
                - /bin/bash
                - -c
                - nodetool status
            initialDelaySeconds: 30
            periodSeconds: 10
            failureThreshold: 60

          lifecycle:
            preStop:
              exec:
                command:
                  - sh
                  - -c
                  - nodetool drain && sleep 30

          volumeMounts:
            - name: cassandra-data
              mountPath: /cassandra/data
            - name: cassandra-logs
              mountPath: /var/log/cassandra
            - name: cassandra-env
              mountPath: /etc/cassandra/env.d

      volumes:
        - name: cassandra-logs
          emptyDir: {}
        - name: cassandra-env
          emptyDir: {}

  # PVC templates — one PVC per pod, persists across pod restarts
  volumeClaimTemplates:
    - metadata:
        name: cassandra-data
        labels:
          app: cassandra
        annotations:
          volume.beta.kubernetes.io/storage-class: gp3
      spec:
        accessModes:
          - ReadWriteOnce
        storageClassName: gp3-encrypted
        resources:
          requests:
            storage: 500Gi
```

## Section 3: Headless Service DNS Resolution

With a headless service (`clusterIP: None`), each pod gets an individual DNS A record:

```bash
# DNS records created by kube-dns for headless service:
# <pod-name>.<service-name>.<namespace>.svc.cluster.local
#
# cassandra-0.cassandra.databases.svc.cluster.local  -> 10.0.1.100
# cassandra-1.cassandra.databases.svc.cluster.local  -> 10.0.1.101
# cassandra-2.cassandra.databases.svc.cluster.local  -> 10.0.1.102
#
# The service itself also has a DNS record that returns ALL pod IPs:
# cassandra.databases.svc.cluster.local  -> [10.0.1.100, 10.0.1.101, 10.0.1.102]

# Test DNS resolution from within the cluster
kubectl run dns-test --image=busybox:1.36 --rm -it --restart=Never -- \
  nslookup cassandra-0.cassandra.databases.svc.cluster.local

# Show all DNS records for the headless service
kubectl run dns-test --image=busybox:1.36 --rm -it --restart=Never -- \
  nslookup cassandra.databases.svc.cluster.local

# SRV records for service discovery (port information)
# _cql._tcp.cassandra.databases.svc.cluster.local
kubectl run dns-test --image=busybox:1.36 --rm -it --restart=Never -- \
  nslookup -type=SRV _cql._tcp.cassandra.databases.svc.cluster.local
```

## Section 4: Partition-Based Canary Updates

The `partition` field enables canary-style upgrades — update one pod at a time, verify, then proceed:

```bash
# Update Cassandra from 4.1.4 to 4.1.5 safely

# Step 1: Set partition=2 (only pod with ordinal >= 2 will be updated)
kubectl patch statefulset cassandra -n databases \
  --type='json' \
  -p='[{"op": "replace", "path": "/spec/updateStrategy/rollingUpdate/partition", "value": 2}]'

# Step 2: Update the image
kubectl set image statefulset/cassandra cassandra=cassandra:4.1.5 -n databases

# Step 3: Wait for cassandra-2 to be updated and healthy
kubectl rollout status statefulset/cassandra -n databases --timeout=600s
kubectl exec -n databases cassandra-2 -- nodetool status
kubectl exec -n databases cassandra-2 -- nodetool version

# Step 4: Validate the upgraded pod (run integration test, check metrics)
kubectl exec -n databases cassandra-2 -- \
  cqlsh -u cassandra -p cassandra -e "DESCRIBE KEYSPACES;"

# Step 5: Proceed to update cassandra-1
kubectl patch statefulset cassandra -n databases \
  --type='json' \
  -p='[{"op": "replace", "path": "/spec/updateStrategy/rollingUpdate/partition", "value": 1}]'

kubectl rollout status statefulset/cassandra -n databases --timeout=600s

# Step 6: Update cassandra-0 (the last, often the seed node)
kubectl patch statefulset cassandra -n databases \
  --type='json' \
  -p='[{"op": "replace", "path": "/spec/updateStrategy/rollingUpdate/partition", "value": 0}]'

kubectl rollout status statefulset/cassandra -n databases --timeout=600s

echo "Upgrade complete. Verifying cluster health..."
kubectl exec -n databases cassandra-0 -- nodetool status
```

## Section 5: Pod Disruption Budget for StatefulSets

```yaml
# cassandra-pdb.yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: cassandra-pdb
  namespace: databases
spec:
  selector:
    matchLabels:
      app: cassandra
  # Never allow more than 1 pod to be unavailable simultaneously.
  # With 3 replicas, this means at least 2 must be available.
  maxUnavailable: 1
  # Alternatively, use minAvailable for quorum-based systems:
  # minAvailable: 2  # Quorum for 3-node cluster
---
# ZooKeeper requires quorum — never drop below ceil(N/2)+1 nodes
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: zookeeper-pdb
  namespace: databases
spec:
  selector:
    matchLabels:
      app: zookeeper
  minAvailable: 2  # Quorum for 3-node ensemble
```

## Section 6: Kafka StatefulSet with Persistent Volumes

```yaml
# kafka-statefulset.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: kafka
  namespace: messaging
spec:
  serviceName: kafka-headless
  replicas: 3
  podManagementPolicy: Parallel    # Kafka brokers can start simultaneously
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
  selector:
    matchLabels:
      app: kafka
  template:
    metadata:
      labels:
        app: kafka
    spec:
      terminationGracePeriodSeconds: 90
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  app: kafka
              topologyKey: kubernetes.io/hostname
      initContainers:
        - name: broker-id
          image: busybox:1.36
          command:
            - sh
            - -c
            - |
              ORDINAL=$(hostname | awk -F'-' '{print $NF}')
              echo $((100 + ORDINAL)) > /etc/kafka/broker-id
          volumeMounts:
            - name: kafka-config
              mountPath: /etc/kafka
      containers:
        - name: kafka
          image: confluentinc/cp-kafka:7.6.1
          env:
            - name: KAFKA_BROKER_ID_COMMAND
              value: "cat /etc/kafka/broker-id"
            - name: POD_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
            - name: POD_NAMESPACE
              valueFrom:
                fieldRef:
                  fieldPath: metadata.namespace
            - name: KAFKA_ADVERTISED_LISTENERS
              value: "PLAINTEXT://$(POD_NAME).kafka-headless.$(POD_NAMESPACE).svc.cluster.local:9092"
            - name: KAFKA_LISTENERS
              value: "PLAINTEXT://0.0.0.0:9092,CONTROLLER://0.0.0.0:9093"
            - name: KAFKA_CONTROLLER_QUORUM_VOTERS
              value: "100@kafka-0.kafka-headless.messaging.svc.cluster.local:9093,101@kafka-1.kafka-headless.messaging.svc.cluster.local:9093,102@kafka-2.kafka-headless.messaging.svc.cluster.local:9093"
            - name: KAFKA_PROCESS_ROLES
              value: "broker,controller"
            - name: KAFKA_LOG_DIRS
              value: "/var/lib/kafka/data"
            - name: KAFKA_NUM_PARTITIONS
              value: "12"
            - name: KAFKA_DEFAULT_REPLICATION_FACTOR
              value: "3"
            - name: KAFKA_MIN_INSYNC_REPLICAS
              value: "2"
            - name: KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR
              value: "3"
            - name: KAFKA_AUTO_CREATE_TOPICS_ENABLE
              value: "false"
          ports:
            - name: kafka
              containerPort: 9092
            - name: controller
              containerPort: 9093
            - name: jmx
              containerPort: 9999
          resources:
            requests:
              cpu: "1"
              memory: 4Gi
            limits:
              cpu: "4"
              memory: 8Gi
          readinessProbe:
            exec:
              command:
                - sh
                - -c
                - kafka-topics.sh --bootstrap-server localhost:9092 --list > /dev/null 2>&1
            initialDelaySeconds: 30
            periodSeconds: 20
            timeoutSeconds: 10
          livenessProbe:
            tcpSocket:
              port: 9092
            initialDelaySeconds: 30
            periodSeconds: 15
          volumeMounts:
            - name: kafka-data
              mountPath: /var/lib/kafka/data
            - name: kafka-config
              mountPath: /etc/kafka
      volumes:
        - name: kafka-config
          emptyDir: {}
  volumeClaimTemplates:
    - metadata:
        name: kafka-data
      spec:
        accessModes:
          - ReadWriteOnce
        storageClassName: gp3-encrypted
        resources:
          requests:
            storage: 200Gi
```

## Section 7: Scaling StatefulSets Safely

```bash
# Scale up — new pods get new PVCs automatically
kubectl scale statefulset cassandra -n databases --replicas=5

# Wait for all pods to be Ready
kubectl rollout status statefulset/cassandra -n databases

# Scale down — PVC retention depends on persistentVolumeClaimRetentionPolicy
# With whenScaled: Retain (default), PVCs are NOT deleted on scale down
kubectl scale statefulset cassandra -n databases --replicas=3

# Check PVCs after scale-down
kubectl get pvc -n databases -l app=cassandra

# Manually delete orphaned PVCs if you want to reclaim storage
kubectl delete pvc cassandra-data-cassandra-3 cassandra-data-cassandra-4 -n databases

# For Cassandra: decommission before scaling down
kubectl exec -n databases cassandra-2 -- nodetool decommission
# Wait for decommission to complete
kubectl exec -n databases cassandra-2 -- nodetool netstats
# Then scale down
kubectl scale statefulset cassandra -n databases --replicas=2
```

## Section 8: StatefulSet Debugging and Operations

```bash
# Check StatefulSet status
kubectl get statefulset -n databases -o wide

# Check pod ordinals and their PVCs
kubectl get pods -n databases -l app=cassandra \
  -o custom-columns='NAME:.metadata.name,STATUS:.status.phase,NODE:.spec.nodeName,PVC:.spec.volumes[0].persistentVolumeClaim.claimName'

# Force delete a stuck pod (use carefully — removes ordinal guarantee)
kubectl delete pod cassandra-1 -n databases --grace-period=0 --force

# Check why a pod is not becoming Ready
kubectl describe pod cassandra-0 -n databases | grep -A20 "Events:"
kubectl logs cassandra-0 -n databases --previous

# Manually trigger pod eviction (respects PDB)
kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data
kubectl cordon <node-name>

# Check PVC binding
kubectl get pvc -n databases -l app=cassandra
kubectl describe pvc cassandra-data-cassandra-0 -n databases

# Expand a PVC (requires StorageClass with allowVolumeExpansion: true)
kubectl patch pvc cassandra-data-cassandra-0 -n databases \
  --type='json' \
  -p='[{"op": "replace", "path": "/spec/resources/requests/storage", "value": "1Ti"}]'

# Check volume expansion status
kubectl get pvc cassandra-data-cassandra-0 -n databases \
  -o jsonpath='{.status.conditions[*]}'

# Pause a rolling update
kubectl patch statefulset cassandra -n databases \
  --type='json' \
  -p='[{"op": "replace", "path": "/spec/updateStrategy/rollingUpdate/partition", "value": 999}]'

# Resume rolling update
kubectl patch statefulset cassandra -n databases \
  --type='json' \
  -p='[{"op": "replace", "path": "/spec/updateStrategy/rollingUpdate/partition", "value": 0}]'
```

## Section 9: Backup and Restore with VolumeSnapshots

```yaml
# cassandra-volumesnapshot.yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: cassandra-data-cassandra-0-snapshot
  namespace: databases
spec:
  volumeSnapshotClassName: csi-aws-vsc
  source:
    persistentVolumeClaimName: cassandra-data-cassandra-0
---
# Restore from snapshot — create new PVC from snapshot
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: cassandra-data-cassandra-0-restored
  namespace: databases
spec:
  dataSource:
    name: cassandra-data-cassandra-0-snapshot
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 500Gi
  storageClassName: gp3-encrypted
```

```bash
#!/bin/bash
# cassandra-backup.sh — snapshot all Cassandra PVCs atomically
NAMESPACE="databases"
SNAPSHOT_CLASS="csi-aws-vsc"
DATE=$(date +%Y%m%d-%H%M%S)

REPLICAS=$(kubectl get statefulset cassandra -n $NAMESPACE -o jsonpath='{.spec.replicas}')

for i in $(seq 0 $((REPLICAS - 1))); do
  PVC_NAME="cassandra-data-cassandra-${i}"
  SNAPSHOT_NAME="${PVC_NAME}-${DATE}"

  echo "Snapshotting ${PVC_NAME} -> ${SNAPSHOT_NAME}"

  kubectl apply -f - <<EOF
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: ${SNAPSHOT_NAME}
  namespace: ${NAMESPACE}
  labels:
    app: cassandra
    backup-date: "${DATE}"
spec:
  volumeSnapshotClassName: ${SNAPSHOT_CLASS}
  source:
    persistentVolumeClaimName: ${PVC_NAME}
EOF

done

# Wait for all snapshots to be ready
echo "Waiting for snapshots to complete..."
for i in $(seq 0 $((REPLICAS - 1))); do
  SNAPSHOT_NAME="cassandra-data-cassandra-${i}-${DATE}"
  kubectl wait volumesnapshot/${SNAPSHOT_NAME} -n $NAMESPACE \
    --for=jsonpath='{.status.readyToUse}'=true \
    --timeout=300s
done

echo "Backup complete. Snapshots:"
kubectl get volumesnapshot -n $NAMESPACE -l backup-date=${DATE}
```

## Section 10: Horizontal Pod Autoscaling for StatefulSets

Stateful workloads should scale conservatively — data rebalancing is expensive:

```yaml
# cassandra-hpa.yaml
# Note: HPA for StatefulSets scales replicas, not individual pod resources.
# For databases, vertical scaling (VPA) is often preferable.
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: cassandra-hpa
  namespace: databases
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: StatefulSet
    name: cassandra
  minReplicas: 3
  maxReplicas: 9   # Scale up to 9 nodes, always multiples of 3 for RF=3
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 80
  behavior:
    scaleDown:
      # Very conservative scale-down — Cassandra rebalancing is expensive
      stabilizationWindowSeconds: 3600  # 1 hour
      policies:
        - type: Pods
          value: 1
          periodSeconds: 600   # At most 1 pod every 10 minutes
    scaleUp:
      stabilizationWindowSeconds: 300  # 5 minutes
      policies:
        - type: Pods
          value: 2
          periodSeconds: 180
```

StatefulSets are complex but essential for running distributed databases reliably in Kubernetes. The patterns in this guide — ordered updates, partition-based canary deployments, PDB for quorum protection, and VolumeSnapshot-based backups — form the operational foundation for production database workloads.
