---
title: "Kubernetes Local Persistent Volumes: High-Performance Storage for Stateful Workloads"
date: 2028-01-16T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Storage", "Local Volumes", "StatefulSet", "NVMe", "Performance", "Database"]
categories: ["Kubernetes", "Storage"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Kubernetes local persistent volumes covering the local-static-provisioner, StorageClass with WaitForFirstConsumer, node affinity, NVMe/SSD performance configuration, database I/O optimization, and topology-aware scheduling."
more_link: "yes"
url: "/kubernetes-storage-local-volumes-guide/"
---

Network-attached storage introduces latency that is measurable and meaningful for high-throughput database workloads. NVMe drives connected directly to nodes provide microsecond latency and hundreds of thousands of IOPS—capabilities that no network storage tier can match. Kubernetes local persistent volumes bridge the gap between raw hardware performance and Kubernetes-native workload scheduling, enabling StatefulSets to consume local storage with proper lifecycle management, node affinity enforcement, and graceful failure handling.

<!--more-->

# Kubernetes Local Persistent Volumes: High-Performance Storage for Stateful Workloads

## Section 1: Understanding Local Volumes vs. hostPath

Local persistent volumes differ from `hostPath` volumes in critical ways that matter for production use:

| Property | hostPath | Local PV |
|---|---|---|
| Node affinity enforcement | None | Automatic via node affinity in PV spec |
| Lifecycle management | No PVC required | Standard PVC/PV binding |
| Capacity tracking | None | Reported to scheduler |
| Reclaim policy | N/A | Delete or Retain |
| Dynamic provisioning | N/A | Via local-static-provisioner or TopoLVM |
| Scheduler awareness | None | WaitForFirstConsumer binding |

The scheduler awareness difference is the most critical. Without `WaitForFirstConsumer` volume binding mode, PVCs bind to PVs immediately at creation, before a pod is scheduled. This causes pods to be scheduled on nodes based on PV location rather than resource availability, leading to suboptimal placement and potential scheduling failures.

## Section 2: Node Preparation

### Disk Configuration for Database Workloads

```bash
#!/bin/bash
# prepare-local-storage.sh
# Run on each storage node to prepare NVMe drives for Kubernetes local PVs
# Requires: node has NVMe drive at /dev/nvme1n1

set -euo pipefail

DEVICE="/dev/nvme1n1"
MOUNT_BASE="/mnt/local-storage"
PARTITION_LABEL="kubernetes-local"

echo "=== Preparing ${DEVICE} for Kubernetes local storage ==="

# Verify device exists and is not mounted
if ! lsblk "${DEVICE}" > /dev/null 2>&1; then
  echo "ERROR: Device ${DEVICE} not found"
  exit 1
fi

if mount | grep -q "${DEVICE}"; then
  echo "ERROR: ${DEVICE} is currently mounted. Unmount before proceeding."
  exit 1
fi

# Partition the disk — separate partitions per PV allow independent formatting
# and prevent one workload's filesystem fragmentation from affecting others
parted -s "${DEVICE}" \
  mklabel gpt \
  mkpart ${PARTITION_LABEL}-1 xfs 0% 25% \
  mkpart ${PARTITION_LABEL}-2 xfs 25% 50% \
  mkpart ${PARTITION_LABEL}-3 xfs 50% 75% \
  mkpart ${PARTITION_LABEL}-4 xfs 75% 100%

# Wait for partition devices to appear in /dev
sleep 2
partprobe "${DEVICE}"
sleep 2

# Format each partition with XFS
# XFS is preferred for database workloads: excellent write performance,
# supports online resize, and handles large files efficiently
for i in 1 2 3 4; do
  PART="${DEVICE}p${i}"
  echo "Formatting ${PART} with XFS..."
  mkfs.xfs \
    -f \
    -L "local-pv-${i}" \
    -d agcount=8 \          # 8 allocation groups for parallel I/O
    "${PART}"
done

# Create mount point directories
mkdir -p "${MOUNT_BASE}/vol-1" \
         "${MOUNT_BASE}/vol-2" \
         "${MOUNT_BASE}/vol-3" \
         "${MOUNT_BASE}/vol-4"

# Add persistent mounts to /etc/fstab
# noatime: skip updating access time on reads — significant performance gain
# nodiratime: same for directory access times
# discard: enable TRIM/DISCARD for NVMe wear leveling
# nofail: allow system boot even if disk is missing (for graceful degradation)
for i in 1 2 3 4; do
  PART="${DEVICE}p${i}"
  UUID=$(blkid -s UUID -o value "${PART}")
  echo "UUID=${UUID} ${MOUNT_BASE}/vol-${i} xfs defaults,noatime,nodiratime,discard,nofail 0 2" \
    >> /etc/fstab
done

# Mount all new partitions
mount -a

# Verify mounts
echo "=== Mounted volumes ==="
df -h "${MOUNT_BASE}"/*

echo "=== I/O scheduler configuration ==="
# Set deadline/mq-deadline scheduler for NVMe (none/mq-deadline)
# NVMe has its own internal queuing; deadline provides fairness
for NVME_DEV in /sys/block/nvme*/queue/scheduler; do
  echo "mq-deadline" > "${NVME_DEV}" 2>/dev/null || \
  echo "none" > "${NVME_DEV}" 2>/dev/null || true
  echo "  ${NVME_DEV}: $(cat ${NVME_DEV})"
done

# Disable transparent huge pages — causes latency spikes for databases
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag

# Make THP setting persistent via systemd
cat > /etc/systemd/system/disable-thp.service << 'EOF'
[Unit]
Description=Disable Transparent Huge Pages
After=local-fs.target

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'echo never > /sys/kernel/mm/transparent_hugepage/enabled'
ExecStart=/bin/sh -c 'echo never > /sys/kernel/mm/transparent_hugepage/defrag'
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now disable-thp.service

echo "Node preparation complete."
```

### Kernel and Sysctl Tuning for Storage Nodes

```bash
#!/bin/bash
# storage-node-sysctl.sh
# Apply kernel parameters optimized for local NVMe database storage

cat > /etc/sysctl.d/99-local-storage-node.conf << 'EOF'
# ── Virtual Memory ───────────────────────────────────────────────────────────
# Reduce kernel tendency to swap — databases should stay in RAM
vm.swappiness = 1
# Dirty page ratio — allow more dirty pages before writeback kicks in
# Higher values improve write throughput at cost of potential data loss window
vm.dirty_ratio = 15
vm.dirty_background_ratio = 5
# Expire dirty pages after 30 seconds maximum
vm.dirty_expire_centisecs = 3000
vm.dirty_writeback_centisecs = 500

# ── File System ───────────────────────────────────────────────────────────────
# Maximum number of open file descriptors
fs.file-max = 2097152
# Maximum number of inotify watches (for application file monitoring)
fs.inotify.max_user_watches = 524288
fs.inotify.max_user_instances = 512

# ── Network (for database replication) ──────────────────────────────────────
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.core.netdev_max_backlog = 65535
net.ipv4.tcp_rmem = 4096 87380 16777216
net.ipv4.tcp_wmem = 4096 65536 16777216
EOF

sysctl --system
```

### Node Labeling for Storage Tiers

```bash
#!/bin/bash
# label-storage-nodes.sh
# Label nodes by storage tier for topology-aware scheduling

# NVMe nodes — highest performance tier
kubectl label node nvme-node-1 nvme-node-2 nvme-node-3 \
  storage.kubernetes.io/storage-class=nvme \
  node-role.kubernetes.io/storage=true \
  storage.kubernetes.io/local-provisioner=enabled

# SSD nodes — standard performance tier
kubectl label node ssd-node-1 ssd-node-2 \
  storage.kubernetes.io/storage-class=ssd \
  node-role.kubernetes.io/storage=true \
  storage.kubernetes.io/local-provisioner=enabled

# Add toleration for storage-dedicated nodes
kubectl taint node nvme-node-1 nvme-node-2 nvme-node-3 \
  dedicated=storage:NoSchedule
```

## Section 3: Local Static Provisioner

The `local-static-provisioner` daemon set monitors configured directories and automatically creates PersistentVolume objects for each discovered disk or directory.

### Provisioner Configuration

```yaml
# local-static-provisioner-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: local-provisioner-config
  namespace: kube-system
data:
  # Provisioner configuration
  nodeLabelsForPV: |
    - kubernetes.io/hostname
    - topology.kubernetes.io/zone
    - topology.kubernetes.io/region
    - storage.kubernetes.io/storage-class

  # Storage class configurations
  storageClassMap: |
    local-nvme:
      # Mount path on each node to discover volumes
      hostDir: /mnt/local-storage
      # Mount path inside provisioner pod
      mountDir: /mnt/local-storage
      # Block volume mode for databases that do raw I/O
      volumeMode: Filesystem
      # File system type for XFS-formatted volumes
      fsType: xfs
      # Name prefix for auto-created PV objects
      namePattern: "*"
    local-ssd:
      hostDir: /mnt/ssd-storage
      mountDir: /mnt/ssd-storage
      volumeMode: Filesystem
      fsType: ext4
      namePattern: "*"
    local-block:
      # Raw block volumes — no filesystem overhead
      # Used by databases managing their own I/O (PostgreSQL, MySQL with O_DIRECT)
      hostDir: /mnt/block-storage
      mountDir: /mnt/block-storage
      volumeMode: Block
      namePattern: "*"
```

```yaml
# local-static-provisioner-daemonset.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: local-volume-provisioner
  namespace: kube-system
  labels:
    app: local-volume-provisioner
spec:
  selector:
    matchLabels:
      app: local-volume-provisioner
  template:
    metadata:
      labels:
        app: local-volume-provisioner
    spec:
      serviceAccountName: local-storage-admin
      # Only run on nodes labeled for local storage
      nodeSelector:
        storage.kubernetes.io/local-provisioner: "enabled"
      tolerations:
        - key: "dedicated"
          operator: "Equal"
          value: "storage"
          effect: "NoSchedule"
      containers:
        - name: provisioner
          image: registry.k8s.io/sig-storage/local-volume-provisioner:v2.6.0
          imagePullPolicy: IfNotPresent
          securityContext:
            privileged: true  # Required for filesystem operations
          env:
            - name: MY_NODE_NAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
            - name: MY_NAMESPACE
              valueFrom:
                fieldRef:
                  fieldPath: metadata.namespace
            - name: JOB_CONTAINER_IMAGE
              value: "registry.k8s.io/sig-storage/local-volume-provisioner:v2.6.0"
          resources:
            requests:
              cpu: 100m
              memory: 100Mi
            limits:
              cpu: 200m
              memory: 200Mi
          volumeMounts:
            - name: provisioner-config
              mountPath: /etc/provisioner/config
              readOnly: true
            - name: provisioner-dev
              mountPath: /dev
            - name: local-nvme
              mountPath: /mnt/local-storage
              mountPropagation: HostToContainer
            - name: local-ssd
              mountPath: /mnt/ssd-storage
              mountPropagation: HostToContainer
      volumes:
        - name: provisioner-config
          configMap:
            name: local-provisioner-config
        - name: provisioner-dev
          hostPath:
            path: /dev
        - name: local-nvme
          hostPath:
            path: /mnt/local-storage
            type: DirectoryOrCreate
        - name: local-ssd
          hostPath:
            path: /mnt/ssd-storage
            type: DirectoryOrCreate
---
# RBAC for provisioner
apiVersion: v1
kind: ServiceAccount
metadata:
  name: local-storage-admin
  namespace: kube-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: local-storage-provisioner-runner
rules:
  - apiGroups: [""]
    resources: ["nodes", "persistentvolumes", "persistentvolumeclaims"]
    verbs: ["get", "list", "watch", "create", "delete", "update", "patch"]
  - apiGroups: ["storage.k8s.io"]
    resources: ["storageclasses"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["events"]
    verbs: ["watch", "create", "update", "patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: local-storage-provisioner-binding
subjects:
  - kind: ServiceAccount
    name: local-storage-admin
    namespace: kube-system
roleRef:
  kind: ClusterRole
  name: local-storage-provisioner-runner
  apiGroup: rbac.authorization.k8s.io
```

## Section 4: StorageClass with WaitForFirstConsumer

```yaml
# storage-classes.yaml
# NVMe StorageClass — highest performance tier
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: local-nvme
  annotations:
    storageclass.kubernetes.io/is-default-class: "false"
provisioner: kubernetes.io/no-provisioner
# WaitForFirstConsumer: PV binding is deferred until a pod is scheduled
# This allows the scheduler to consider node resources alongside storage
# availability, preventing pods from being forced onto congested nodes
volumeBindingMode: WaitForFirstConsumer
# Retain: do not delete PV data when PVC is deleted
# This is critical for stateful workloads where data must survive PVC deletion
reclaimPolicy: Retain
allowVolumeExpansion: false  # Local volumes cannot be resized
---
# SSD StorageClass — standard performance tier
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: local-ssd
provisioner: kubernetes.io/no-provisioner
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Retain
allowVolumeExpansion: false
---
# Block device StorageClass — raw I/O, no filesystem overhead
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: local-block
provisioner: kubernetes.io/no-provisioner
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Retain
allowVolumeExpansion: false
```

## Section 5: PersistentVolume with Node Affinity

When the local-static-provisioner creates PVs, it automatically adds node affinity rules. For manually managed PVs, node affinity must be specified explicitly.

```yaml
# persistent-volumes.yaml
# PV for PostgreSQL primary on nvme-node-1
apiVersion: v1
kind: PersistentVolume
metadata:
  name: local-nvme-nvme-node-1-vol-1
  labels:
    kubernetes.io/hostname: nvme-node-1
    storage-tier: nvme
spec:
  capacity:
    storage: 500Gi  # Matches the partition size created in Section 2
  volumeMode: Filesystem
  accessModes:
    - ReadWriteOnce  # Local volumes are single-node exclusive
  persistentVolumeReclaimPolicy: Retain
  storageClassName: local-nvme
  local:
    path: /mnt/local-storage/vol-1  # Directory provisioned in Section 2
  # Node affinity is MANDATORY for local volumes
  # Without this, any pod can claim the PV and fail to mount it
  nodeAffinity:
    required:
      nodeSelectorTerms:
        - matchExpressions:
            - key: kubernetes.io/hostname
              operator: In
              values:
                - nvme-node-1
---
# PV for PostgreSQL replica on nvme-node-2
apiVersion: v1
kind: PersistentVolume
metadata:
  name: local-nvme-nvme-node-2-vol-1
  labels:
    kubernetes.io/hostname: nvme-node-2
    storage-tier: nvme
spec:
  capacity:
    storage: 500Gi
  volumeMode: Filesystem
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  storageClassName: local-nvme
  local:
    path: /mnt/local-storage/vol-1
  nodeAffinity:
    required:
      nodeSelectorTerms:
        - matchExpressions:
            - key: kubernetes.io/hostname
              operator: In
              values:
                - nvme-node-2
---
# Raw block PV for databases using direct I/O
apiVersion: v1
kind: PersistentVolume
metadata:
  name: local-block-nvme-node-1-nvme1n1p1
spec:
  capacity:
    storage: 500Gi
  volumeMode: Block  # Raw block device — no filesystem layer
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  storageClassName: local-block
  local:
    path: /dev/nvme1n1p1  # Direct partition reference
  nodeAffinity:
    required:
      nodeSelectorTerms:
        - matchExpressions:
            - key: kubernetes.io/hostname
              operator: In
              values:
                - nvme-node-1
```

## Section 6: StatefulSet with Local Volumes

### PostgreSQL StatefulSet on Local NVMe

```yaml
# postgresql-statefulset-local.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgresql
  namespace: databases
spec:
  serviceName: postgresql-headless
  replicas: 3
  selector:
    matchLabels:
      app: postgresql
  template:
    metadata:
      labels:
        app: postgresql
    spec:
      # Spread pods across nodes with local storage
      # This ensures each replica lands on a different node with its own PV
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: postgresql

      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  app: postgresql
              topologyKey: kubernetes.io/hostname

      # Schedule only on NVMe nodes
      nodeSelector:
        storage.kubernetes.io/storage-class: nvme

      tolerations:
        - key: "dedicated"
          operator: "Equal"
          value: "storage"
          effect: "NoSchedule"

      # Run as postgres user for proper file ownership
      securityContext:
        runAsUser: 999
        runAsGroup: 999
        fsGroup: 999

      initContainers:
        # Ensure data directory has correct permissions before PostgreSQL starts
        - name: init-permissions
          image: busybox:1.36
          command:
            - sh
            - -c
            - |
              chown -R 999:999 /var/lib/postgresql/data
              chmod 700 /var/lib/postgresql/data
          volumeMounts:
            - name: postgresql-data
              mountPath: /var/lib/postgresql/data
          securityContext:
            runAsUser: 0  # Root for chown

      containers:
        - name: postgresql
          image: postgres:16.2
          env:
            - name: POSTGRES_USER
              valueFrom:
                secretKeyRef:
                  name: postgresql-credentials
                  key: username
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: postgresql-credentials
                  key: password
            - name: PGDATA
              value: /var/lib/postgresql/data/pgdata
            # Tune PostgreSQL for NVMe performance
            - name: POSTGRES_INITDB_ARGS
              value: "--data-checksums --encoding=UTF8 --locale=en_US.UTF-8"
          ports:
            - containerPort: 5432
              name: postgresql
          volumeMounts:
            - name: postgresql-data
              mountPath: /var/lib/postgresql/data
            - name: postgresql-config
              mountPath: /etc/postgresql/postgresql.conf
              subPath: postgresql.conf
          resources:
            requests:
              cpu: 2000m
              memory: 8Gi
            limits:
              cpu: 8000m
              memory: 16Gi
          readinessProbe:
            exec:
              command:
                - pg_isready
                - -U
                - postgres
            initialDelaySeconds: 30
            periodSeconds: 10
            timeoutSeconds: 5
          livenessProbe:
            exec:
              command:
                - pg_isready
                - -U
                - postgres
            initialDelaySeconds: 60
            periodSeconds: 30
            timeoutSeconds: 5

      volumes:
        - name: postgresql-config
          configMap:
            name: postgresql-config

  # volumeClaimTemplates creates one PVC per replica
  # The scheduler uses WaitForFirstConsumer to bind PVCs to PVs
  # on the same node as the scheduled pod
  volumeClaimTemplates:
    - metadata:
        name: postgresql-data
      spec:
        accessModes:
          - ReadWriteOnce
        storageClassName: local-nvme
        resources:
          requests:
            storage: 490Gi  # Slightly less than PV capacity for safety margin
---
# Headless service for StatefulSet pod DNS
apiVersion: v1
kind: Service
metadata:
  name: postgresql-headless
  namespace: databases
spec:
  clusterIP: None
  selector:
    app: postgresql
  ports:
    - port: 5432
      targetPort: 5432
```

### PostgreSQL Configuration for NVMe

```yaml
# postgresql-config-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: postgresql-config
  namespace: databases
data:
  postgresql.conf: |
    # ── Memory Configuration ──────────────────────────────────────────────────
    # shared_buffers: 25% of total RAM for PostgreSQL buffer pool
    shared_buffers = 4GB

    # effective_cache_size: estimate of total available memory for caching
    # Used by query planner; does not actually allocate this memory
    effective_cache_size = 12GB

    # work_mem: per-sort, per-hash memory. Can be multiplied by connections
    # max_connections * work_mem must be << total_ram
    work_mem = 64MB

    # maintenance_work_mem: VACUUM, CREATE INDEX, etc.
    maintenance_work_mem = 1GB

    # ── NVMe I/O Configuration ────────────────────────────────────────────────
    # random_page_cost: NVMe has nearly sequential cost for random I/O
    # Default is 4.0 (assumes spinning disk). NVMe should be 1.1
    random_page_cost = 1.1

    # effective_io_concurrency: number of concurrent I/O operations
    # NVMe supports extremely high parallelism
    effective_io_concurrency = 200

    # Parallel query on NVMe is particularly effective
    max_parallel_workers_per_gather = 4
    max_parallel_workers = 8
    max_parallel_maintenance_workers = 4

    # ── Write-Ahead Logging ───────────────────────────────────────────────────
    # wal_level: replica enables physical replication
    wal_level = replica

    # wal_buffers: in-memory buffer for WAL data before fsync
    wal_buffers = 64MB

    # checkpoint_completion_target: spread checkpoint I/O over this fraction
    # of checkpoint_timeout to reduce I/O spikes
    checkpoint_completion_target = 0.9
    checkpoint_timeout = 15min

    # max_wal_size: allow WAL to grow to this size between checkpoints
    # Larger value reduces checkpoint frequency, improving write throughput
    max_wal_size = 8GB
    min_wal_size = 1GB

    # ── Connection Configuration ──────────────────────────────────────────────
    max_connections = 200
    # Use pg_bouncer for connection pooling in front of PostgreSQL

    # ── Logging ───────────────────────────────────────────────────────────────
    log_min_duration_statement = 1000  # Log queries taking > 1 second
    log_checkpoints = on
    log_lock_waits = on
    log_temp_files = 0
    log_autovacuum_min_duration = 250ms

    # ── Autovacuum Tuning for NVMe ────────────────────────────────────────────
    # NVMe can handle more aggressive autovacuum
    autovacuum_vacuum_cost_limit = 800     # Default: 200
    autovacuum_vacuum_scale_factor = 0.05  # Default: 0.2 (vacuum at 5% dead tuples)
    autovacuum_analyze_scale_factor = 0.02
```

## Section 7: Topology-Aware Volume Scheduling

### Multi-Zone Local Volume Setup

```yaml
# multi-zone-storage-classes.yaml
# Zone-specific StorageClasses enable topology-aware pod scheduling
# Use when nodes with local storage span multiple AZs

# Zone A NVMe
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: local-nvme-zone-a
provisioner: kubernetes.io/no-provisioner
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Retain
allowedTopologies:
  - matchLabelExpressions:
      - key: topology.kubernetes.io/zone
        values:
          - us-east-1a
---
# Zone B NVMe
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: local-nvme-zone-b
provisioner: kubernetes.io/no-provisioner
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Retain
allowedTopologies:
  - matchLabelExpressions:
      - key: topology.kubernetes.io/zone
        values:
          - us-east-1b
---
# Zone C NVMe
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: local-nvme-zone-c
provisioner: kubernetes.io/no-provisioner
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Retain
allowedTopologies:
  - matchLabelExpressions:
      - key: topology.kubernetes.io/zone
        values:
          - us-east-1c
```

### Zone-Spread StatefulSet

```yaml
# zone-spread-statefulset.yaml
# Deploy a 3-replica StatefulSet with one replica per AZ
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: cassandra
  namespace: databases
spec:
  serviceName: cassandra-headless
  replicas: 3
  selector:
    matchLabels:
      app: cassandra
  template:
    metadata:
      labels:
        app: cassandra
    spec:
      # Enforce one pod per zone
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: cassandra
      containers:
        - name: cassandra
          image: cassandra:4.1
          resources:
            requests:
              cpu: 4000m
              memory: 16Gi
            limits:
              cpu: 8000m
              memory: 32Gi
          volumeMounts:
            - name: cassandra-data
              mountPath: /var/lib/cassandra/data

  volumeClaimTemplates:
    - metadata:
        name: cassandra-data
      spec:
        accessModes:
          - ReadWriteOnce
        # Using a generic local-nvme class — scheduler will select the
        # appropriate zone based on topologySpreadConstraints + WaitForFirstConsumer
        storageClassName: local-nvme
        resources:
          requests:
            storage: 1Ti
```

## Section 8: Operational Procedures

### PV Health Monitoring

```bash
#!/bin/bash
# monitor-local-pvs.sh
# Check health of all local persistent volumes

echo "=== Local PV Status Summary ==="
kubectl get pv \
  -l storage.kubernetes.io/storage-class=nvme \
  -o custom-columns=\
'NAME:.metadata.name,CAPACITY:.spec.capacity.storage,STATUS:.status.phase,NODE:.spec.nodeAffinity.required.nodeSelectorTerms[0].matchExpressions[0].values[0],CLAIM:.spec.claimRef.name'

echo ""
echo "=== PVs in Released/Failed State ==="
kubectl get pv \
  -o json \
  | jq -r '.items[] | select(.status.phase == "Released" or .status.phase == "Failed") | [.metadata.name, .status.phase, .spec.capacity.storage] | @tsv'

echo ""
echo "=== Node Disk Usage ==="
for NODE in $(kubectl get nodes -l storage.kubernetes.io/local-provisioner=enabled -o jsonpath='{.items[*].metadata.name}'); do
  echo "Node: ${NODE}"
  kubectl debug node/${NODE} -it --image=busybox:1.36 \
    -- sh -c "df -h /mnt/local-storage/* 2>/dev/null || echo 'Cannot access storage on this node'" \
    2>/dev/null &
done
wait
```

### PV Reclamation After Workload Deletion

```bash
#!/bin/bash
# reclaim-local-pv.sh
# Manually reclaim a Released local PV after PVC deletion
# Required because local volumes use Retain reclaim policy

set -euo pipefail

PV_NAME="${1:?Usage: $0 <pv-name>}"

# Verify PV exists and is in Released state
PV_PHASE=$(kubectl get pv "${PV_NAME}" -o jsonpath='{.status.phase}')
if [[ "${PV_PHASE}" != "Released" ]]; then
  echo "ERROR: PV ${PV_NAME} is in phase '${PV_PHASE}', expected 'Released'"
  exit 1
fi

# Get node name from PV node affinity
NODE=$(kubectl get pv "${PV_NAME}" \
  -o jsonpath='{.spec.nodeAffinity.required.nodeSelectorTerms[0].matchExpressions[0].values[0]}')
MOUNT_PATH=$(kubectl get pv "${PV_NAME}" -o jsonpath='{.spec.local.path}')

echo "=== PV Reclamation Plan ==="
echo "PV:         ${PV_NAME}"
echo "Node:       ${NODE}"
echo "Mount Path: ${MOUNT_PATH}"
echo ""
echo "This will DELETE all data at ${MOUNT_PATH} on ${NODE}."
echo "Type 'confirm-delete' to proceed:"
read CONFIRMATION

if [[ "${CONFIRMATION}" != "confirm-delete" ]]; then
  echo "Aborted."
  exit 0
fi

# Remove the PV claimRef to make it Available again
kubectl patch pv "${PV_NAME}" --type=json \
  -p='[{"op": "remove", "path": "/spec/claimRef"}]'

# Clean the data directory on the node using a privileged debug pod
kubectl debug node/${NODE} \
  --image=busybox:1.36 \
  --target=local-volume-provisioner \
  -it -- \
  sh -c "rm -rf ${MOUNT_PATH}/* && echo 'Data cleared successfully'"

echo "PV ${PV_NAME} is now Available and ready for reuse."
kubectl get pv "${PV_NAME}"
```

## Section 9: Performance Benchmarking

```bash
#!/bin/bash
# benchmark-local-storage.sh
# Run fio benchmarks against a local PV mount point
# Deploy as a pod to get in-cluster results

cat << 'EOF' | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: storage-benchmark
  namespace: databases
spec:
  restartPolicy: Never
  nodeSelector:
    storage.kubernetes.io/storage-class: nvme
  tolerations:
    - key: "dedicated"
      operator: "Equal"
      value: "storage"
      effect: "NoSchedule"
  containers:
    - name: fio
      image: nixery.dev/fio
      command:
        - /bin/sh
        - -c
        - |
          echo "=== Sequential Write Performance ===" && \
          fio --name=seqwrite --ioengine=libaio --iodepth=32 \
              --rw=write --bs=1M --direct=1 --size=10G \
              --numjobs=4 --runtime=60 --time_based \
              --group_reporting --filename=/data/seqwrite.dat && \

          echo "=== Random Read IOPS ===" && \
          fio --name=randread --ioengine=libaio --iodepth=128 \
              --rw=randread --bs=4K --direct=1 --size=10G \
              --numjobs=8 --runtime=60 --time_based \
              --group_reporting --filename=/data/seqwrite.dat && \

          echo "=== Mixed 70/30 Read/Write ===" && \
          fio --name=mixed --ioengine=libaio --iodepth=64 \
              --rw=randrw --rwmixread=70 --bs=8K --direct=1 \
              --size=10G --numjobs=4 --runtime=60 --time_based \
              --group_reporting --filename=/data/seqwrite.dat && \

          rm -f /data/seqwrite.dat && \
          echo "Benchmark complete"
      volumeMounts:
        - name: test-storage
          mountPath: /data
      resources:
        requests:
          cpu: 2000m
          memory: 2Gi
  volumes:
    - name: test-storage
      persistentVolumeClaim:
        claimName: benchmark-pvc
EOF

# Create the PVC for the benchmark
cat << 'EOF' | kubectl apply -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: benchmark-pvc
  namespace: databases
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: local-nvme
  resources:
    requests:
      storage: 20Gi
EOF

# Wait for benchmark to complete and collect results
kubectl wait pod/storage-benchmark -n databases \
  --for=condition=Ready --timeout=120s

kubectl logs -n databases storage-benchmark --follow
```

## Summary

Local persistent volumes provide the highest storage performance achievable in Kubernetes, but require careful operational discipline. The `WaitForFirstConsumer` binding mode is non-negotiable—it ensures pod scheduling considers both node resources and storage locality simultaneously. Node affinity in PV specs enforces that workloads cannot be scheduled on nodes where their data does not reside.

The local-static-provisioner automates PV lifecycle management at scale, eliminating manual PV creation as disks are added to nodes. PostgreSQL and other databases benefit significantly from NVMe-specific tuning: `random_page_cost = 1.1`, high `effective_io_concurrency`, and aggressive autovacuum settings aligned to the I/O headroom NVMe provides.

The primary operational challenge is failure handling: when a node fails, pods with local PVs cannot be rescheduled until the node recovers. This makes local volumes suitable for applications with built-in replication (Cassandra, Kafka, PostgreSQL with Patroni) but inappropriate for single-replica stateful workloads that cannot tolerate node-level failures.
