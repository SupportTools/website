---
title: "StatefulSet Advanced Patterns: Ordered Deployment, PVC Management, and Rolling Updates"
date: 2028-02-19T00:00:00-05:00
draft: false
tags: ["Kubernetes", "StatefulSet", "Cassandra", "MongoDB", "Elasticsearch", "Storage", "PVC"]
categories:
- Kubernetes
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Kubernetes StatefulSet advanced patterns covering podManagementPolicy, updateStrategy partitions, PVC retention policy, headless service DNS, and operational patterns for Cassandra, MongoDB, and Elasticsearch."
more_link: "yes"
url: "/kubernetes-statefulset-advanced-patterns-guide/"
---

StatefulSets provide the ordered identity and persistent storage guarantees required by distributed stateful applications, but their default configurations are rarely optimal for production deployments. The difference between a Cassandra cluster that safely tolerates rolling restarts and one that triggers ring splits often comes down to three fields: `podManagementPolicy`, `updateStrategy.rollingUpdate.partition`, and how PVC lifecycle is managed relative to pod lifecycle.

This guide examines StatefulSet internals and advanced configuration patterns for running Cassandra, MongoDB, and Elasticsearch in production Kubernetes environments, covering ordered versus parallel startup, canary rolling updates, PVC retention policies, headless service DNS patterns, and VolumeClaimTemplate management.

<!--more-->

# StatefulSet Advanced Patterns: Ordered Deployment, PVC Management, and Rolling Updates

## StatefulSet Identity Model

Every StatefulSet pod receives a stable, predictable identity consisting of three components:

1. **Stable hostname**: `<statefulset-name>-<ordinal>` (e.g., `cassandra-0`, `cassandra-1`)
2. **Stable network identity**: DNS via headless service `<hostname>.<service>.<namespace>.svc.cluster.local`
3. **Stable storage**: PersistentVolumeClaims that survive pod rescheduling

These identities persist through pod restarts and rescheduling, which is what distinguishes StatefulSets from Deployments for stateful applications.

```yaml
# statefulset-identity-demo.yaml
# Demonstrates the core identity guarantees
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: cassandra
  namespace: databases
spec:
  serviceName: cassandra-headless  # Required: references the headless service
  replicas: 3
  selector:
    matchLabels:
      app: cassandra

  template:
    metadata:
      labels:
        app: cassandra
    spec:
      containers:
      - name: cassandra
        image: cassandra:4.1
        ports:
        - containerPort: 9042   # CQL port
          name: cql
        - containerPort: 7000   # Intra-node communication
          name: intra-node
        - containerPort: 7199   # JMX
          name: jmx
        env:
        # HOSTNAME is set by Kubernetes to the pod name (e.g., cassandra-0)
        # Cassandra uses this as its node identifier
        - name: CASSANDRA_SEEDS
          value: "cassandra-0.cassandra-headless.databases.svc.cluster.local"
        - name: POD_IP
          valueFrom:
            fieldRef:
              fieldPath: status.podIP
        volumeMounts:
        - name: cassandra-data
          mountPath: /var/lib/cassandra

  # PVC template creates one PVC per pod
  # PVC name: cassandra-data-cassandra-0, cassandra-data-cassandra-1, etc.
  volumeClaimTemplates:
  - metadata:
      name: cassandra-data
    spec:
      accessModes: [ReadWriteOnce]
      storageClassName: premium-ssd
      resources:
        requests:
          storage: 500Gi
---
# Headless service: clusterIP: None
# Enables direct pod DNS resolution without load balancing
apiVersion: v1
kind: Service
metadata:
  name: cassandra-headless
  namespace: databases
spec:
  clusterIP: None    # This makes it a headless service
  selector:
    app: cassandra
  ports:
  - port: 9042
    name: cql
  - port: 7000
    name: intra-node
```

### Headless Service DNS Patterns

```bash
# DNS records created by a headless service with 3 replicas:

# Individual pod addresses (A records):
# cassandra-0.cassandra-headless.databases.svc.cluster.local -> 10.244.1.5
# cassandra-1.cassandra-headless.databases.svc.cluster.local -> 10.244.2.8
# cassandra-2.cassandra-headless.databases.svc.cluster.local -> 10.244.3.12

# Service A record (round-robin to all pods):
# cassandra-headless.databases.svc.cluster.local -> 10.244.1.5, 10.244.2.8, 10.244.3.12

# Test DNS resolution from within the cluster
kubectl run dns-test \
  --image=nicolaka/netshoot \
  --namespace=databases \
  --rm -it \
  --restart=Never \
  -- nslookup cassandra-0.cassandra-headless.databases.svc.cluster.local

# Expected output:
# Server: 10.96.0.10
# Name: cassandra-0.cassandra-headless.databases.svc.cluster.local
# Address: 10.244.1.5
# (Only one IP - direct to the specific pod)
```

## podManagementPolicy: OrderedReady vs Parallel

### OrderedReady (Default)

With `OrderedReady`, pods are created/deleted one at a time in strict ordinal order. Pod N+1 is not started until pod N is Running and Ready:

```yaml
# ordered-ready-statefulset.yaml
# Default behavior: strict ordering ensures safe bootstrap for
# consensus-based systems (Zookeeper, etcd, Raft-based databases)
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: zookeeper
  namespace: coordination
spec:
  podManagementPolicy: OrderedReady   # Default; explicit for clarity
  replicas: 3
  serviceName: zookeeper-headless

  template:
    spec:
      containers:
      - name: zookeeper
        image: zookeeper:3.9
        env:
        # ZooKeeper requires knowing the full ensemble before forming quorum.
        # With OrderedReady, pod-0 is always Ready before pod-1 starts,
        # allowing the ensemble to form incrementally.
        - name: ZOO_SERVERS
          value: >
            server.1=zookeeper-0.zookeeper-headless.coordination.svc.cluster.local:2888:3888;2181
            server.2=zookeeper-1.zookeeper-headless.coordination.svc.cluster.local:2888:3888;2181
            server.3=zookeeper-2.zookeeper-headless.coordination.svc.cluster.local:2888:3888;2181
        - name: ZOO_MY_ID
          # Use the ordinal index as the ZooKeeper server ID
          # Derived from the hostname (zookeeper-0 -> ID 1, etc.)
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        readinessProbe:
          exec:
            command:
            - bash
            - -c
            - |
              # ZooKeeper-specific readiness: check that it responds to 'ruok'
              echo ruok | nc -w 1 127.0.0.1 2181 | grep imok
          initialDelaySeconds: 10
          periodSeconds: 5
          timeoutSeconds: 3
          failureThreshold: 6
```

### Parallel Management Policy

`Parallel` management policy starts or stops all pods simultaneously, which is appropriate for applications that can handle concurrent startup:

```yaml
# parallel-statefulset.yaml
# Parallel policy is safe for applications that handle their own
# coordination (e.g., Elasticsearch uses Zen Discovery internally)
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: elasticsearch-data
  namespace: logging
spec:
  podManagementPolicy: Parallel   # Start all data nodes simultaneously
  replicas: 6
  serviceName: elasticsearch-headless

  template:
    spec:
      # Affinity: spread nodes across failure domains
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchLabels:
                app: elasticsearch-data
            topologyKey: kubernetes.io/hostname  # One pod per node

      containers:
      - name: elasticsearch
        image: docker.elastic.co/elasticsearch/elasticsearch:8.11.0
        env:
        - name: cluster.name
          value: "production-logs"
        - name: node.name
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        - name: discovery.seed_hosts
          value: "elasticsearch-master-headless"
        - name: cluster.initial_master_nodes
          value: "elasticsearch-master-0,elasticsearch-master-1,elasticsearch-master-2"
        - name: ES_JAVA_OPTS
          value: "-Xms8g -Xmx8g"
        - name: node.roles
          value: "data,ingest"    # Data nodes only; masters are separate
        resources:
          requests:
            cpu: 2000m
            memory: 18Gi  # Must be > 2x JVM heap
          limits:
            cpu: 8000m
            memory: 18Gi

  volumeClaimTemplates:
  - metadata:
      name: elasticsearch-data
    spec:
      accessModes: [ReadWriteOnce]
      storageClassName: fast-ssd
      resources:
        requests:
          storage: 2Ti
```

## updateStrategy: RollingUpdate with Partition

The `partition` field in `updateStrategy.rollingUpdate` enables canary-style updates for StatefulSets. Only pods with ordinals >= partition are updated when the template changes:

```yaml
# statefulset-partition-update.yaml
# Rolling update with partition for safe canary deployments.
# Setting partition=N means only pods N, N+1, N+2... get the new template.
# Pods 0 through N-1 keep the old template.
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: mongodb
  namespace: databases
spec:
  replicas: 5
  serviceName: mongodb-headless
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      # partition=4: only pod-4 (the 5th pod, highest ordinal) gets updated first
      # This acts as a canary: validate pod-4 before updating the rest
      partition: 4

  template:
    spec:
      containers:
      - name: mongodb
        image: mongo:7.0.4   # New version being rolled out
        # ... (rest of spec)
```

```bash
#!/bin/bash
# canary-statefulset-update.sh
# Performs a staged update of a StatefulSet with validation between stages.
# This pattern allows catching issues with a single pod before fleet-wide rollout.

STATEFULSET="${1:-mongodb}"
NAMESPACE="${2:-databases}"
TOTAL_REPLICAS=$(kubectl get sts "${STATEFULSET}" -n "${NAMESPACE}" \
  -o jsonpath='{.spec.replicas}')

echo "Starting canary update of ${STATEFULSET} (${TOTAL_REPLICAS} replicas)"

# Stage 1: Update the highest ordinal pod only (canary)
echo "Stage 1: Updating pod-$((TOTAL_REPLICAS-1)) (partition=$((TOTAL_REPLICAS-1)))"
kubectl patch statefulset "${STATEFULSET}" \
  -n "${NAMESPACE}" \
  --type merge \
  --patch "{\"spec\":{\"updateStrategy\":{\"rollingUpdate\":{\"partition\":$((TOTAL_REPLICAS-1))}}}}"

# Wait for the canary pod to be ready
kubectl rollout status statefulset "${STATEFULSET}" -n "${NAMESPACE}" \
  --timeout=10m

# Validate canary pod
echo "Validating canary pod..."
CANARY_POD="${STATEFULSET}-$((TOTAL_REPLICAS-1))"
kubectl exec "${CANARY_POD}" -n "${NAMESPACE}" \
  -- mongosh --eval "db.runCommand({serverStatus: 1}).ok" \
  2>/dev/null | grep -q "1" \
  && echo "PASS: Canary validation succeeded" \
  || { echo "FAIL: Canary validation failed, aborting update"; exit 1; }

# Stage 2: Roll out to all remaining pods
echo "Stage 2: Rolling update to all pods (partition=0)"
kubectl patch statefulset "${STATEFULSET}" \
  -n "${NAMESPACE}" \
  --type merge \
  --patch '{"spec":{"updateStrategy":{"rollingUpdate":{"partition":0}}}}'

# Wait for full rollout
kubectl rollout status statefulset "${STATEFULSET}" -n "${NAMESPACE}" \
  --timeout=30m

echo "Update complete"
kubectl get pods -n "${NAMESPACE}" -l "app=${STATEFULSET}" \
  -o custom-columns='NAME:.metadata.name,IMAGE:.spec.containers[0].image,STATUS:.status.phase'
```

## PVC Retention Policy

Kubernetes 1.27 GA'd the `persistentVolumeClaimRetentionPolicy` field, which controls what happens to PVCs when pods are deleted or the StatefulSet is scaled down/deleted:

```yaml
# statefulset-pvc-retention.yaml
# Explicit PVC retention policy controls.
# Critical for data safety in production environments.
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgresql
  namespace: databases
spec:
  replicas: 3
  serviceName: postgresql-headless

  # PVC retention policy (Kubernetes 1.23+ beta, 1.27+ GA)
  persistentVolumeClaimRetentionPolicy:
    # whenDeleted: what happens to PVCs when the StatefulSet is DELETED
    # Retain: PVCs survive StatefulSet deletion (safest for production data)
    # Delete: PVCs are deleted with the StatefulSet
    whenDeleted: Retain

    # whenScaled: what happens to PVCs when replicas count is REDUCED
    # Retain: PVCs for removed pods are kept (can be reattached on scale-up)
    # Delete: PVCs are deleted when the pod is removed
    whenScaled: Retain

  template:
    spec:
      containers:
      - name: postgresql
        image: postgres:16.1
        env:
        - name: PGDATA
          value: /var/lib/postgresql/data/pgdata
        - name: POSTGRES_DB
          value: production
        - name: POSTGRES_USER
          valueFrom:
            secretKeyRef:
              name: postgres-credentials
              key: username
        - name: POSTGRES_PASSWORD
          valueFrom:
            secretKeyRef:
              name: postgres-credentials
              key: password
        volumeMounts:
        - name: postgresql-data
          mountPath: /var/lib/postgresql/data

  volumeClaimTemplates:
  - metadata:
      name: postgresql-data
    spec:
      accessModes: [ReadWriteOnce]
      storageClassName: premium-ssd-retain   # StorageClass with reclaimPolicy: Retain
      resources:
        requests:
          storage: 100Gi
```

### Managing Orphaned PVCs

```bash
#!/bin/bash
# manage-statefulset-pvcs.sh
# Identifies and manages PVCs left behind after StatefulSet scale-down.

STATEFULSET="${1:-postgresql}"
NAMESPACE="${2:-databases}"

# List all PVCs for this StatefulSet
echo "=== PVCs for StatefulSet ${STATEFULSET} ==="
kubectl get pvc -n "${NAMESPACE}" \
  -l "app=${STATEFULSET}" \
  -o custom-columns='NAME:.metadata.name,STATUS:.status.phase,CAPACITY:.spec.resources.requests.storage,AGE:.metadata.creationTimestamp'

# Get current replica count
REPLICAS=$(kubectl get sts "${STATEFULSET}" -n "${NAMESPACE}" \
  -o jsonpath='{.spec.replicas}')
echo ""
echo "Current replica count: ${REPLICAS}"

# Find PVCs for pods that no longer exist
echo ""
echo "=== Orphaned PVCs (pods no longer exist) ==="
for pvc in $(kubectl get pvc -n "${NAMESPACE}" \
    -o jsonpath='{.items[*].metadata.name}' \
    | tr ' ' '\n' \
    | grep "^${STATEFULSET}-data-${STATEFULSET}-"); do

    # Extract ordinal from PVC name
    ordinal=$(echo "${pvc}" | grep -oP '\d+$')
    if [ "${ordinal}" -ge "${REPLICAS}" ]; then
        echo "  ORPHANED: ${pvc} (pod ${STATEFULSET}-${ordinal} no longer exists)"
    fi
done

# List PVC usage by pod
echo ""
echo "=== PVC-to-Pod Mapping ==="
kubectl get pods -n "${NAMESPACE}" \
  -l "app=${STATEFULSET}" \
  -o json \
  | jq -r '.items[] | "\(.metadata.name) -> \(.spec.volumes[]? | select(.persistentVolumeClaim != null) | .persistentVolumeClaim.claimName)"'
```

## MongoDB StatefulSet with Replica Set Initialization

```yaml
# mongodb-statefulset.yaml
# Production MongoDB replica set with proper initialization handling.
# Uses an init container to configure the replica set on first boot.
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: mongodb
  namespace: databases
spec:
  replicas: 3
  serviceName: mongodb-headless
  podManagementPolicy: OrderedReady   # MongoDB requires sequential bootstrap

  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      partition: 0   # Update from highest ordinal down

  template:
    metadata:
      labels:
        app: mongodb
    spec:
      terminationGracePeriodSeconds: 60   # Allow MongoDB to flush writes

      initContainers:
      # Copy MongoDB configuration files with correct permissions
      - name: config-init
        image: busybox:1.36
        command:
        - sh
        - -c
        - |
          cp /configmap/* /etc/mongodb/
          chmod 400 /etc/mongodb/mongod.conf
          chown -R 999:999 /var/lib/mongodb
        volumeMounts:
        - name: mongodb-config
          mountPath: /configmap
        - name: mongodb-config-dir
          mountPath: /etc/mongodb
        - name: mongodb-data
          mountPath: /var/lib/mongodb

      containers:
      - name: mongodb
        image: mongo:7.0.4
        command:
        - mongod
        - --config=/etc/mongodb/mongod.conf
        ports:
        - containerPort: 27017
          name: mongodb
        env:
        - name: MONGO_INITDB_ROOT_USERNAME
          valueFrom:
            secretKeyRef:
              name: mongodb-credentials
              key: username
        - name: MONGO_INITDB_ROOT_PASSWORD
          valueFrom:
            secretKeyRef:
              name: mongodb-credentials
              key: password
        - name: POD_NAMESPACE
          valueFrom:
            fieldRef:
              fieldPath: metadata.namespace
        - name: REPLICA_SET_NAME
          value: "rs0"
        volumeMounts:
        - name: mongodb-data
          mountPath: /var/lib/mongodb
        - name: mongodb-config-dir
          mountPath: /etc/mongodb
        livenessProbe:
          exec:
            command:
            - mongosh
            - --eval
            - "db.adminCommand('ping')"
            - --quiet
          initialDelaySeconds: 30
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 6
        readinessProbe:
          exec:
            command:
            - mongosh
            - --eval
            - |
              # Check that this node is primary or secondary (not startup state)
              var state = rs.status().myState;
              if (state !== 1 && state !== 2) {
                quit(1);
              }
            - --quiet
          initialDelaySeconds: 30
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 3
        resources:
          requests:
            cpu: 2000m
            memory: 8Gi
          limits:
            cpu: 8000m
            memory: 8Gi

      volumes:
      - name: mongodb-config
        configMap:
          name: mongodb-config
      - name: mongodb-config-dir
        emptyDir: {}

  volumeClaimTemplates:
  - metadata:
      name: mongodb-data
    spec:
      accessModes: [ReadWriteOnce]
      storageClassName: premium-ssd
      resources:
        requests:
          storage: 500Gi
```

```yaml
# mongodb-config.yaml
# MongoDB configuration file
apiVersion: v1
kind: ConfigMap
metadata:
  name: mongodb-config
  namespace: databases
data:
  mongod.conf: |
    # Storage configuration
    storage:
      dbPath: /var/lib/mongodb
      journal:
        enabled: true
      wiredTiger:
        engineConfig:
          # 50% of available memory; leave rest for OS cache
          cacheSizeGB: 3.5

    # Replication
    replication:
      replSetName: "rs0"
      oplogSizeMB: 51200    # 50GB oplog for replica lag tolerance

    # Networking
    net:
      port: 27017
      bindIp: 0.0.0.0
      tls:
        mode: preferTLS
        certificateKeyFile: /etc/mongodb/tls.pem
        CAFile: /etc/mongodb/ca.crt

    # Security
    security:
      authorization: enabled
      keyFile: /etc/mongodb/keyfile    # Intra-cluster auth

    # Logging
    systemLog:
      destination: file
      path: /var/log/mongodb/mongod.log
      logAppend: true
      verbosity: 0
```

### MongoDB Replica Set Initialization Job

```yaml
# mongodb-init-job.yaml
# One-time Job to initialize the MongoDB replica set.
# Run after the StatefulSet pods are Running.
apiVersion: batch/v1
kind: Job
metadata:
  name: mongodb-rs-init
  namespace: databases
spec:
  backoffLimit: 5
  ttlSecondsAfterFinished: 3600
  template:
    spec:
      restartPolicy: OnFailure
      containers:
      - name: rs-init
        image: mongo:7.0.4
        command:
        - mongosh
        - "--host"
        - "mongodb-0.mongodb-headless.databases.svc.cluster.local"
        - "--eval"
        - |
          // Initialize the replica set if not already initialized
          try {
            var status = rs.status();
            print("Replica set already initialized: " + status.set);
          } catch (e) {
            // rs.status() throws if not initialized
            var config = {
              _id: "rs0",
              version: 1,
              members: [
                {
                  _id: 0,
                  host: "mongodb-0.mongodb-headless.databases.svc.cluster.local:27017",
                  priority: 2   // Prefer pod-0 as primary
                },
                {
                  _id: 1,
                  host: "mongodb-1.mongodb-headless.databases.svc.cluster.local:27017",
                  priority: 1
                },
                {
                  _id: 2,
                  host: "mongodb-2.mongodb-headless.databases.svc.cluster.local:27017",
                  priority: 1
                }
              ]
            };
            var result = rs.initiate(config);
            print("Replica set initialized: " + JSON.stringify(result));
          }
        env:
        - name: MONGO_USERNAME
          valueFrom:
            secretKeyRef:
              name: mongodb-credentials
              key: username
        - name: MONGO_PASSWORD
          valueFrom:
            secretKeyRef:
              name: mongodb-credentials
              key: password
```

## Cassandra StatefulSet with Proper Ordering

```yaml
# cassandra-statefulset.yaml
# Production Cassandra configuration with proper seed handling
# and ordered startup to prevent ring issues.
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: cassandra
  namespace: databases
spec:
  replicas: 6
  serviceName: cassandra-headless
  podManagementPolicy: OrderedReady   # Critical: prevents multiple nodes bootstrapping simultaneously

  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      # Update one pod at a time from the highest ordinal
      # Never set partition to update all at once on Cassandra
      partition: 0

  template:
    metadata:
      labels:
        app: cassandra
    spec:
      terminationGracePeriodSeconds: 1800   # Allow 30 minutes for graceful drain

      # Prevent Cassandra pods from co-locating on the same node
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchLabels:
                app: cassandra
            topologyKey: kubernetes.io/hostname

      containers:
      - name: cassandra
        image: cassandra:4.1.3
        ports:
        - containerPort: 7000
          name: intra-node
        - containerPort: 7001
          name: tls-intra-node
        - containerPort: 7199
          name: jmx
        - containerPort: 9042
          name: cql
        env:
        - name: CASSANDRA_SEEDS
          # Only use the first two pods as seeds
          # More seeds = slower bootstrap; two is the minimum recommended
          value: >
            cassandra-0.cassandra-headless.databases.svc.cluster.local,
            cassandra-1.cassandra-headless.databases.svc.cluster.local
        - name: CASSANDRA_CLUSTER_NAME
          value: "ProductionCluster"
        - name: CASSANDRA_DC
          value: "dc1"
        - name: CASSANDRA_RACK
          value: "rack1"
        - name: CASSANDRA_ENDPOINT_SNITCH
          value: "GossipingPropertyFileSnitch"
        - name: MAX_HEAP_SIZE
          value: "8G"
        - name: HEAP_NEWSIZE
          value: "2G"
        - name: JVM_OPTS
          value: >
            -Djava.rmi.server.hostname=$(POD_IP)
            -Dcom.sun.jndi.rmiURLParsing=legacy
        - name: POD_IP
          valueFrom:
            fieldRef:
              fieldPath: status.podIP
        lifecycle:
          preStop:
            exec:
              # Drain the node before termination to avoid data loss
              # This moves data to other nodes gracefully
              command:
              - /bin/sh
              - -c
              - nodetool drain
        readinessProbe:
          exec:
            command:
            - /bin/bash
            - -c
            - |
              # Only ready when Cassandra reports UN (Up/Normal) status
              nodetool status | grep -E "^UN\s+$(hostname -I | awk '{print $1}')"
          initialDelaySeconds: 60
          periodSeconds: 30
          timeoutSeconds: 30
          failureThreshold: 10
        livenessProbe:
          exec:
            command:
            - /bin/bash
            - -c
            - nodetool status
          initialDelaySeconds: 90
          periodSeconds: 30
          timeoutSeconds: 30
          failureThreshold: 6
        resources:
          requests:
            cpu: 4000m
            memory: 24Gi
          limits:
            cpu: 8000m
            memory: 24Gi
        volumeMounts:
        - name: cassandra-data
          mountPath: /var/lib/cassandra

  volumeClaimTemplates:
  - metadata:
      name: cassandra-data
    spec:
      accessModes: [ReadWriteOnce]
      storageClassName: fast-nvme
      resources:
        requests:
          storage: 2Ti
```

## Scale-Down Handling and Data Safety

```bash
#!/bin/bash
# safe-statefulset-scale.sh
# Safely scales a StatefulSet down, ensuring data is migrated
# before pod termination. Application-specific; this example
# shows the pattern for Cassandra.

STATEFULSET="${1:-cassandra}"
NAMESPACE="${2:-databases}"
TARGET_REPLICAS="${3}"

if [ -z "${TARGET_REPLICAS}" ]; then
    echo "Usage: $0 <statefulset> <namespace> <target-replicas>"
    exit 1
fi

CURRENT_REPLICAS=$(kubectl get sts "${STATEFULSET}" -n "${NAMESPACE}" \
  -o jsonpath='{.spec.replicas}')

if [ "${TARGET_REPLICAS}" -ge "${CURRENT_REPLICAS}" ]; then
    echo "Scale-up: no drain required"
    kubectl scale sts "${STATEFULSET}" \
      --replicas="${TARGET_REPLICAS}" \
      -n "${NAMESPACE}"
    exit 0
fi

echo "Scaling down from ${CURRENT_REPLICAS} to ${TARGET_REPLICAS}"

# Scale down one pod at a time, draining each before removal
for (( i=CURRENT_REPLICAS-1; i>=TARGET_REPLICAS; i-- )); do
    POD="${STATEFULSET}-${i}"
    echo ""
    echo "=== Draining pod ${POD} ==="

    # Cassandra: decommission node (moves data to other nodes)
    kubectl exec "${POD}" -n "${NAMESPACE}" \
      -- nodetool decommission 2>&1 | tail -5

    # Wait for decommission to complete
    echo "Waiting for decommission..."
    while kubectl exec "${POD}" -n "${NAMESPACE}" \
        -- nodetool status 2>/dev/null \
        | grep -q "^L[A-Z]"; do
        echo "  Still decommissioning..."
        sleep 30
    done

    echo "Decommission complete. Scaling to $((i)) replicas..."
    kubectl scale sts "${STATEFULSET}" \
      --replicas="${i}" \
      -n "${NAMESPACE}"

    # Wait for pod to terminate
    kubectl wait pod "${POD}" \
      -n "${NAMESPACE}" \
      --for=delete \
      --timeout=10m

    echo "Pod ${POD} removed"
done

echo ""
echo "Scale-down complete. Final replica count: ${TARGET_REPLICAS}"
```

## StatefulSet Monitoring

```yaml
# prometheusrule-statefulset.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: statefulset-health-alerts
  namespace: monitoring
spec:
  groups:
  - name: statefulset-health
    rules:
    # Alert when StatefulSet does not have the desired replica count
    - alert: StatefulSetReplicasMismatch
      expr: >
        kube_statefulset_status_replicas_ready
        != kube_statefulset_status_replicas
      for: 15m
      labels:
        severity: warning
      annotations:
        summary: "StatefulSet {{ $labels.statefulset }} replica count mismatch"
        description: >
          StatefulSet {{ $labels.namespace }}/{{ $labels.statefulset }} has
          {{ $value }} ready replicas but expects
          {{ kube_statefulset_status_replicas }} replicas.

    # Alert when StatefulSet update is stuck (partition not progressing)
    - alert: StatefulSetUpdateNotComplete
      expr: >
        kube_statefulset_status_update_revision
        != kube_statefulset_status_current_revision
      for: 30m
      labels:
        severity: warning
      annotations:
        summary: "StatefulSet {{ $labels.statefulset }} update stuck"
```

## Summary

StatefulSets provide the stable identity and ordered lifecycle management that distributed stateful applications require. The choice of `podManagementPolicy` is critical: `OrderedReady` ensures safe sequential bootstrap for consensus systems like ZooKeeper and MongoDB, while `Parallel` reduces startup time for applications with internal coordination like Elasticsearch. The `updateStrategy.rollingUpdate.partition` field enables canary-style updates that allow validation before fleet-wide rollout—a pattern that has prevented numerous production incidents with Cassandra and MongoDB deployments.

PVC retention policies ensure data survives pod deletions and scale-down operations, with `whenScaled: Retain` being the production-safe default. Headless service DNS provides stable, predictable addressing for peer-to-peer communication within the cluster. Together, these mechanisms provide the operational foundation for running production-grade distributed databases on Kubernetes.
