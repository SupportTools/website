---
title: "Kubernetes Persistent Storage with OpenEBS: LocalPV, cStor, and Mayastor"
date: 2030-01-07T00:00:00-05:00
draft: false
tags: ["Kubernetes", "OpenEBS", "Storage", "Mayastor", "cStor", "Persistent Volumes", "NVMe"]
categories: ["Kubernetes", "Storage"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive OpenEBS deployment guide covering LocalPV, cStor, and Mayastor NVMe-oF storage engines, replica management, performance tuning, and Velero backup integration for enterprise Kubernetes storage."
more_link: "yes"
url: "/kubernetes-persistent-storage-openebs-localpv-cstor-mayastor/"
---

Storage is the final frontier of Kubernetes stateful workloads. While compute and networking have been solved well, storage remains a pain point for many teams — particularly when balancing performance, resilience, and operational simplicity. OpenEBS is a Container Attached Storage (CAS) solution that brings storage capabilities directly into Kubernetes, with three distinct storage engines suited to different workload profiles.

This guide covers deploying and operating all three major OpenEBS storage engines in production: LocalPV for high-performance single-node workloads, cStor for resilient replicated storage, and Mayastor for NVMe-grade performance with replication. We also cover backup integration with Velero for disaster recovery.

<!--more-->

# Kubernetes Persistent Storage with OpenEBS: LocalPV, cStor, and Mayastor

## OpenEBS Architecture and Storage Engine Selection

OpenEBS takes a fundamentally different approach than traditional SAN/NAS storage systems. Rather than a centralized storage controller, OpenEBS deploys per-volume storage controllers (called Targets) as Kubernetes pods. This architecture means storage management operations use Kubernetes primitives — operators, custom resources, and controllers — rather than separate storage management interfaces.

### Choosing the Right Engine

| Storage Engine | Performance | Replication | Use Case |
|---|---|---|---|
| LocalPV-hostpath | Excellent | None | Databases with own replication (Cassandra, MongoDB RS) |
| LocalPV-device | Excellent | None | High-performance single-node workloads |
| cStor | Good | Yes (2-3 replicas) | Databases requiring storage-level HA |
| Mayastor | Excellent | Yes (2-3 replicas) | NVMe workloads, low-latency replication |
| Jiva | Moderate | Yes | Legacy, avoid for new deployments |

The decision framework:
- **Your application already handles replication** (PostgreSQL with streaming replication, Cassandra, MySQL Group Replication): Use LocalPV-device for maximum IOPS
- **You need storage-level HA without application complexity**: Use Mayastor for NVMe, cStor for spinning disks
- **You have mixed workloads**: Deploy multiple engines with different StorageClasses

## Part 1: Deploying OpenEBS

### Prerequisites

```bash
# Verify kernel parameters for iSCSI (required by cStor)
modprobe iscsi_tcp
lsmod | grep iscsi_tcp

# For Mayastor - verify NVMe and hugepages
modprobe nvme_tcp
cat /proc/sys/vm/nr_hugepages

# Set hugepages (add to /etc/sysctl.d/99-mayastor.conf for persistence)
echo 1024 > /proc/sys/vm/nr_hugepages
sysctl -w vm.nr_hugepages=1024

# Enable VFIO (for SPDK NVMe passthrough)
modprobe vfio-pci
echo "vfio-pci" > /etc/modules-load.d/vfio-pci.conf

# Verify kernel version (Mayastor requires 5.13+)
uname -r
```

### OpenEBS Installation via Helm

```bash
# Add OpenEBS Helm repository
helm repo add openebs https://openebs.github.io/openebs
helm repo update

# Create namespace
kubectl create namespace openebs

# Install with all engines enabled
helm install openebs openebs/openebs \
  --namespace openebs \
  --set engines.local.lvm.enabled=true \
  --set engines.local.zfs.enabled=true \
  --set engines.replicated.mayastor.enabled=true \
  --set mayastor.io_engine.resources.limits.cpu=2 \
  --set mayastor.io_engine.resources.limits.memory=2Gi \
  --set mayastor.io_engine.resources.limits."hugepages-2Mi"=1Gi \
  --set mayastor.io_engine.resources.requests."hugepages-2Mi"=1Gi \
  --wait \
  --timeout 10m

# Verify installation
kubectl get pods -n openebs
kubectl get cspc,cvc -A  # cStor pool claims and volumes
kubectl get msn -A       # Mayastor storage nodes
```

### Label Storage Nodes

OpenEBS uses node labels to determine which nodes participate in storage:

```bash
# Label nodes that will provide Mayastor storage
kubectl label node storage-node-01 openebs.io/engine=mayastor
kubectl label node storage-node-02 openebs.io/engine=mayastor
kubectl label node storage-node-03 openebs.io/engine=mayastor

# Label nodes for LocalPV
kubectl label node worker-01 openebs.io/nodeid=worker-01
kubectl label node worker-02 openebs.io/nodeid=worker-02

# Verify labels
kubectl get nodes --show-labels | grep openebs
```

## Part 2: LocalPV Configuration

### LocalPV-hostpath StorageClass

LocalPV-hostpath uses directories on the node filesystem. It is the simplest option with zero overhead:

```yaml
# storageclass-localpv-hostpath.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: openebs-hostpath
  annotations:
    cas.openebs.io/config: |
      - name: StorageType
        value: "hostpath"
      - name: BasePath
        value: "/var/openebs/local"
    openebs.io/cas-type: local
provisioner: openebs.io/local
reclaimPolicy: Delete
volumeBindingMode: WaitForFirstConsumer
---
# StorageClass with custom base path per workload type
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: openebs-hostpath-nvme
  annotations:
    cas.openebs.io/config: |
      - name: StorageType
        value: "hostpath"
      - name: BasePath
        value: "/mnt/nvme/openebs"
    openebs.io/cas-type: local
provisioner: openebs.io/local
reclaimPolicy: Retain
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: false
```

### LocalPV-device StorageClass

LocalPV-device uses raw block devices, avoiding filesystem overhead:

```yaml
# storageclass-localpv-device.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: openebs-device
  annotations:
    cas.openebs.io/config: |
      - name: StorageType
        value: "device"
      - name: FSType
        value: "xfs"
    openebs.io/cas-type: local
provisioner: openebs.io/local
reclaimPolicy: Delete
volumeBindingMode: WaitForFirstConsumer
```

List available block devices:

```bash
# Check block devices available for LocalPV
kubectl get blockdevices -n openebs

# Get detailed info on a specific device
kubectl describe blockdevice <device-name> -n openebs
```

### Using LocalPV with StatefulSet (Cassandra Example)

```yaml
# cassandra-statefulset-localpv.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: cassandra
  namespace: databases
spec:
  serviceName: cassandra
  replicas: 3
  selector:
    matchLabels:
      app: cassandra
  template:
    metadata:
      labels:
        app: cassandra
    spec:
      terminationGracePeriodSeconds: 1800
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  app: cassandra
              topologyKey: kubernetes.io/hostname
      containers:
        - name: cassandra
          image: cassandra:4.1
          resources:
            requests:
              cpu: 2
              memory: 8Gi
            limits:
              cpu: 4
              memory: 16Gi
          env:
            - name: MAX_HEAP_SIZE
              value: "4096M"
            - name: HEAP_NEWSIZE
              value: "800M"
            - name: CASSANDRA_SEEDS
              value: "cassandra-0.cassandra.databases.svc.cluster.local"
            - name: CASSANDRA_CLUSTER_NAME
              value: "production-cluster"
            - name: POD_IP
              valueFrom:
                fieldRef:
                  fieldPath: status.podIP
          volumeMounts:
            - name: cassandra-data
              mountPath: /var/lib/cassandra/data
            - name: cassandra-commitlog
              mountPath: /var/lib/cassandra/commitlog
          readinessProbe:
            exec:
              command:
                - /bin/bash
                - -c
                - nodetool status | grep -E "^UN\s+${POD_IP}"
            initialDelaySeconds: 60
            periodSeconds: 10
          livenessProbe:
            exec:
              command:
                - /bin/bash
                - -c
                - nodetool status
            initialDelaySeconds: 90
            periodSeconds: 30
  volumeClaimTemplates:
    - metadata:
        name: cassandra-data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: openebs-hostpath-nvme
        resources:
          requests:
            storage: 500Gi
    - metadata:
        name: cassandra-commitlog
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: openebs-hostpath-nvme
        resources:
          requests:
            storage: 50Gi
```

## Part 3: cStor - Replicated Storage

### cStor Pool Configuration

cStor organizes storage into pools (CStorPoolCluster), which are then used to provision volumes (CStorVolumeClaim):

```yaml
# cstor-pool-cluster.yaml
apiVersion: cstor.openebs.io/v1
kind: CStorPoolCluster
metadata:
  name: cspc-stripe
  namespace: openebs
spec:
  pools:
    - nodeSelector:
        kubernetes.io/hostname: storage-node-01
      dataRaidGroups:
        - blockDevices:
            - blockDeviceName: blockdevice-ada8ef910929513c1ad650c08fbe3f36
            - blockDeviceName: blockdevice-b1b576a0da7e3e12b5e8e2b3a5d4c6e8
      poolConfig:
        dataRaidGroupType: "mirror"  # mirror, stripe, or raidz
        writeCacheGroupType: ""
        compression: "off"
        resources:
          requests:
            memory: 2Gi
            cpu: 500m
          limits:
            memory: 4Gi
            cpu: 2
        roThresholdLimit: 85
        auxResources:
          requests:
            memory: 100Mi
            cpu: 50m
          limits:
            memory: 500Mi
            cpu: 500m
        tolerations:
          - key: node-role.kubernetes.io/storage
            operator: Exists
            effect: NoSchedule
    - nodeSelector:
        kubernetes.io/hostname: storage-node-02
      dataRaidGroups:
        - blockDevices:
            - blockDeviceName: blockdevice-c2d3ef910929513c1ad650c08fbe3f47
            - blockDeviceName: blockdevice-d4e5ef910929513c1ad650c08fbe3f58
      poolConfig:
        dataRaidGroupType: "mirror"
    - nodeSelector:
        kubernetes.io/hostname: storage-node-03
      dataRaidGroups:
        - blockDevices:
            - blockDeviceName: blockdevice-e6f7ef910929513c1ad650c08fbe3f69
            - blockDeviceName: blockdevice-f8a9ef910929513c1ad650c08fbe3f7a
      poolConfig:
        dataRaidGroupType: "mirror"
```

```bash
# Apply the pool cluster
kubectl apply -f cstor-pool-cluster.yaml

# Wait for pools to become healthy
kubectl get cspc -n openebs -w

# Detailed pool status
kubectl get cspi -n openebs  # CStorPoolInstance - one per node
kubectl describe cspi -n openebs

# Check pool capacity
kubectl get cspc cspc-stripe -n openebs \
  -o jsonpath='{.status.provisionedInstances}'
```

### cStor StorageClass

```yaml
# storageclass-cstor.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: openebs-cstor-3-replica
  annotations:
    cas.openebs.io/config: |
      - name: ReplicaCount
        value: "3"
      - name: StoragePoolClaim
        value: "cspc-stripe"
      - name: FSType
        value: "ext4"
provisioner: cstor.csi.openebs.io
reclaimPolicy: Retain
allowVolumeExpansion: true
parameters:
  cas-type: cstor
  replicaCount: "3"
  cstorPoolCluster: cspc-stripe
  fsType: ext4
```

### Monitoring cStor Volume Health

```bash
# Check all cStor volumes
kubectl get cvc -n openebs

# Detailed volume info
kubectl describe cvc <volume-name> -n openebs

# Check volume replicas
kubectl get cvr -n openebs

# cStor health check script
cat > check-cstor-health.sh << 'EOF'
#!/bin/bash
echo "=== cStor Pool Cluster Status ==="
kubectl get cspc -n openebs

echo ""
echo "=== Pool Instance Status ==="
kubectl get cspi -n openebs -o custom-columns=\
"NAME:.metadata.name,NODE:.spec.hostName,STATUS:.status.phase,\
FREE:.status.capacity.free,USED:.status.capacity.used"

echo ""
echo "=== Volume Claim Status ==="
kubectl get cvc -n openebs -o custom-columns=\
"NAME:.metadata.name,STATUS:.status.phase,CAPACITY:.status.capacity.storage,\
REPLICAS:.spec.replicaCount"

echo ""
echo "=== Volume Replica Status ==="
kubectl get cvr -n openebs -o custom-columns=\
"NAME:.metadata.name,POOL:.metadata.labels.cstorpoolinstance,\
STATUS:.status.phase,USED:.status.capacity.used"

echo ""
echo "=== Degraded Volumes ==="
kubectl get cvc -n openebs -o json | \
  jq -r '.items[] | select(.status.phase != "Bound") |
    "DEGRADED: \(.metadata.name) - Phase: \(.status.phase)"'
EOF
chmod +x check-cstor-health.sh
```

## Part 4: Mayastor - NVMe-oF Replicated Storage

Mayastor is the most sophisticated OpenEBS engine, implementing a fully user-space storage stack using SPDK (Storage Performance Development Kit) with NVMe-oF (NVMe over Fabrics) for replica communication.

### Mayastor DiskPools

```yaml
# mayastor-diskpools.yaml
apiVersion: openebs.io/v1beta2
kind: DiskPool
metadata:
  name: pool-storage-node-01
  namespace: openebs
spec:
  node: storage-node-01
  disks:
    - uring:///dev/nvme0n1  # Use uring driver for NVMe
---
apiVersion: openebs.io/v1beta2
kind: DiskPool
metadata:
  name: pool-storage-node-02
  namespace: openebs
spec:
  node: storage-node-02
  disks:
    - uring:///dev/nvme0n1
---
apiVersion: openebs.io/v1beta2
kind: DiskPool
metadata:
  name: pool-storage-node-03
  namespace: openebs
spec:
  node: storage-node-03
  disks:
    - uring:///dev/nvme0n1
```

```bash
# Apply disk pools
kubectl apply -f mayastor-diskpools.yaml

# Wait for pools to be online
kubectl get dsp -n openebs -w

# Detailed pool status
kubectl describe dsp -n openebs

# Expected output: all pools in "Online" state
NAME                      NODE               STATE    POOL_STATUS   CAPACITY        USED     AVAILABLE
pool-storage-node-01      storage-node-01    Online   Online        1992294400000   0        1992294400000
pool-storage-node-02      storage-node-02    Online   Online        1992294400000   0        1992294400000
pool-storage-node-03      storage-node-03    Online   Online        1992294400000   0        1992294400000
```

### Mayastor StorageClass

```yaml
# storageclass-mayastor.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: mayastor-3-replicas
  annotations:
    storageclass.kubernetes.io/is-default-class: "false"
parameters:
  ioTimeout: "30"
  protocol: nvmf
  repl: "3"
  thin: "false"
provisioner: io.openebs.csi-mayastor
reclaimPolicy: Delete
allowVolumeExpansion: true
volumeBindingMode: Immediate
---
# Thin-provisioned StorageClass for dev environments
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: mayastor-1-replica-thin
parameters:
  ioTimeout: "30"
  protocol: nvmf
  repl: "1"
  thin: "true"
provisioner: io.openebs.csi-mayastor
reclaimPolicy: Delete
allowVolumeExpansion: true
volumeBindingMode: Immediate
```

### Deploying PostgreSQL on Mayastor

```yaml
# postgresql-mayastor.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: postgres-config
  namespace: databases
data:
  postgresql.conf: |
    # Performance tuning for NVMe storage
    shared_buffers = 2GB
    effective_cache_size = 6GB
    maintenance_work_mem = 512MB
    checkpoint_completion_target = 0.9
    wal_buffers = 64MB
    default_statistics_target = 100
    random_page_cost = 1.1           # Low for NVMe
    effective_io_concurrency = 200   # High for NVMe
    min_wal_size = 1GB
    max_wal_size = 4GB
    max_worker_processes = 8
    max_parallel_workers_per_gather = 4
    max_parallel_workers = 8
    max_parallel_maintenance_workers = 4
    wal_level = replica
    archive_mode = on
    archive_command = 'test ! -f /mnt/pgarchive/%f && cp %p /mnt/pgarchive/%f'
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data
  namespace: databases
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: mayastor-3-replicas
  resources:
    requests:
      storage: 1Ti
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-wal
  namespace: databases
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: mayastor-3-replicas
  resources:
    requests:
      storage: 100Gi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: postgres
  namespace: databases
spec:
  replicas: 1
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
    spec:
      containers:
        - name: postgres
          image: postgres:16
          resources:
            requests:
              cpu: 4
              memory: 8Gi
            limits:
              cpu: 8
              memory: 16Gi
          env:
            - name: PGDATA
              value: /var/lib/postgresql/data/pgdata
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: postgres-secret
                  key: password
          volumeMounts:
            - name: postgres-data
              mountPath: /var/lib/postgresql/data
            - name: postgres-wal
              mountPath: /var/lib/postgresql/wal
            - name: postgres-config
              mountPath: /etc/postgresql/postgresql.conf
              subPath: postgresql.conf
          command:
            - docker-entrypoint.sh
            - postgres
            - -c
            - config_file=/etc/postgresql/postgresql.conf
      volumes:
        - name: postgres-data
          persistentVolumeClaim:
            claimName: postgres-data
        - name: postgres-wal
          persistentVolumeClaim:
            claimName: postgres-wal
        - name: postgres-config
          configMap:
            name: postgres-config
```

### Mayastor Volume Operations

```bash
# List all Mayastor volumes
kubectl get msv -n openebs

# Get volume details including replica placement
kubectl describe msv <volume-name> -n openebs

# Volume health check
kubectl get msv -n openebs -o json | jq -r \
  '.items[] | "\(.metadata.name): state=\(.status.state) replicas=\(.spec.num_replicas)"'

# Force rebuild of degraded replica
kubectl delete msr <replica-name> -n openebs  # Forces re-provisioning

# Check replica status
kubectl get msr -n openebs  # MayastorStorageReplica
```

### Performance Benchmarking

```yaml
# fio-benchmark-pod.yaml
apiVersion: v1
kind: Pod
metadata:
  name: fio-benchmark
  namespace: databases
spec:
  restartPolicy: Never
  containers:
    - name: fio
      image: ljishen/fio:latest
      command: ["/bin/sh", "-c"]
      args:
        - |
          echo "=== Sequential Read (128K blocks) ==="
          fio --name=seq-read \
              --filename=/mnt/test/testfile \
              --direct=1 \
              --rw=read \
              --bs=128k \
              --numjobs=4 \
              --size=10G \
              --runtime=60 \
              --group_reporting \
              --iodepth=32

          echo "=== Random 4K IOPS ==="
          fio --name=rand-iops \
              --filename=/mnt/test/testfile \
              --direct=1 \
              --rw=randread \
              --bs=4k \
              --numjobs=4 \
              --size=10G \
              --runtime=60 \
              --group_reporting \
              --iodepth=64

          echo "=== Mixed Read/Write 70/30 ==="
          fio --name=mixed-rw \
              --filename=/mnt/test/testfile \
              --direct=1 \
              --rw=randrw \
              --rwmixread=70 \
              --bs=4k \
              --numjobs=4 \
              --size=10G \
              --runtime=60 \
              --group_reporting \
              --iodepth=32
      volumeMounts:
        - name: test-volume
          mountPath: /mnt/test
  volumes:
    - name: test-volume
      persistentVolumeClaim:
        claimName: fio-test-pvc
```

## Part 5: Backup Integration with Velero

### Installing Velero with OpenEBS Support

```bash
# Install Velero with CSI plugin for OpenEBS
velero install \
    --provider aws \
    --plugins \
        velero/velero-plugin-for-aws:v1.9.0,\
        velero/velero-plugin-for-csi:v0.7.0 \
    --bucket velero-backups \
    --secret-file ./credentials-velero \
    --use-volume-snapshots=true \
    --features=EnableCSI \
    --backup-location-config region=us-east-1 \
    --snapshot-location-config region=us-east-1

# Verify Velero is running
kubectl get pods -n velero
velero version
```

### VolumeSnapshotClass for OpenEBS Engines

```yaml
# volumesnapshotclass-mayastor.yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: csi-mayastor-snapclass
  labels:
    velero.io/csi-volumesnapshot-class: "true"
driver: io.openebs.csi-mayastor
deletionPolicy: Delete
parameters:
  repl: "1"
---
# VolumeSnapshotClass for cStor
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: csi-cstor-snapclass
  labels:
    velero.io/csi-volumesnapshot-class: "true"
driver: cstor.csi.openebs.io
deletionPolicy: Delete
```

### Backup Schedules

```yaml
# velero-backup-schedules.yaml
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: databases-nightly
  namespace: velero
spec:
  schedule: "0 2 * * *"  # 2 AM every night
  template:
    includedNamespaces:
      - databases
    excludedResources:
      - events
    includeClusterResources: true
    snapshotVolumes: true
    volumeSnapshotLocations:
      - default
    storageLocation: default
    ttl: 720h  # 30 days
    hooks:
      resources:
        - name: postgres-backup-hook
          includedNamespaces:
            - databases
          labelSelector:
            matchLabels:
              app: postgres
          pre:
            - exec:
                container: postgres
                command:
                  - /bin/bash
                  - -c
                  - psql -U postgres -c "CHECKPOINT;"
                onError: Fail
                timeout: 30s
---
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: all-namespaces-weekly
  namespace: velero
spec:
  schedule: "0 3 * * 0"  # 3 AM every Sunday
  template:
    includedNamespaces:
      - "*"
    excludedNamespaces:
      - kube-system
      - kube-public
      - velero
    snapshotVolumes: true
    ttl: 2160h  # 90 days
```

### Backup and Restore Operations

```bash
# Create an on-demand backup
velero backup create databases-backup-$(date +%Y%m%d) \
    --include-namespaces databases \
    --snapshot-volumes \
    --wait

# Monitor backup progress
velero backup describe databases-backup-20250115 --details

# List available backups
velero backup get

# Restore from backup (to same cluster)
velero restore create \
    --from-backup databases-backup-20250115 \
    --include-namespaces databases \
    --restore-volumes \
    --wait

# Restore to different namespace
velero restore create \
    --from-backup databases-backup-20250115 \
    --include-namespaces databases \
    --namespace-mappings databases:databases-restore \
    --restore-volumes

# Check restore status
velero restore describe <restore-name> --details
```

## Part 6: Operational Best Practices

### StorageClass Topology Constraints

For multi-zone clusters, ensure replicas are spread across availability zones:

```yaml
# storageclass-mayastor-topology.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: mayastor-zonal-replicas
parameters:
  protocol: nvmf
  repl: "3"
  nodeAffinityTopologyLabel: topology.kubernetes.io/zone
provisioner: io.openebs.csi-mayastor
volumeBindingMode: WaitForFirstConsumer
allowedTopologies:
  - matchLabelExpressions:
      - key: topology.kubernetes.io/zone
        values:
          - us-east-1a
          - us-east-1b
          - us-east-1c
```

### Monitoring OpenEBS with Prometheus

```yaml
# openebs-servicemonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: openebs-mayastor
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: mayastor
  namespaceSelector:
    matchNames:
      - openebs
  endpoints:
    - port: metrics
      interval: 30s
      path: /metrics
```

Critical alerts:

```yaml
# openebs-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: openebs-alerts
  namespace: monitoring
spec:
  groups:
    - name: openebs.storage
      rules:
        - alert: MayastorPoolDegraded
          expr: |
            mayastor_pool_status{status!="Online"} == 1
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Mayastor pool {{ $labels.pool }} is not online"
            description: "Storage pool {{ $labels.pool }} on node {{ $labels.node }} has status {{ $labels.status }}"

        - alert: MayastorVolumeReplicas
          expr: |
            mayastor_volume_replicas < mayastor_volume_spec_replicas
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Mayastor volume {{ $labels.volume }} has degraded replicas"
            description: "Volume {{ $labels.volume }} has {{ $value }} replicas, expected {{ $labels.spec_replicas }}"

        - alert: CStorPoolHighUtilization
          expr: |
            (cstor_pool_used_capacity_bytes / cstor_pool_total_capacity_bytes) > 0.80
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "cStor pool {{ $labels.pool }} is over 80% capacity"
```

### Volume Expansion

```bash
# Expand a PVC (storage class must have allowVolumeExpansion: true)
kubectl patch pvc postgres-data -n databases \
    -p '{"spec":{"resources":{"requests":{"storage":"2Ti"}}}}'

# Monitor expansion progress
kubectl get pvc postgres-data -n databases -w

# Verify the underlying volume was expanded
kubectl describe pvc postgres-data -n databases | grep -A5 "Conditions:"
```

### Disaster Recovery Runbook

```bash
#!/bin/bash
# dr-runbook.sh - OpenEBS disaster recovery procedures

echo "=== OpenEBS Disaster Recovery Runbook ==="

# Step 1: Check current state
echo "--- Step 1: Current Storage State ---"
kubectl get cspc,cvc,cvr -n openebs
kubectl get dsp,msv,msr -n openebs

# Step 2: Identify degraded volumes
echo "--- Step 2: Degraded Volumes ---"
DEGRADED_CSTOR=$(kubectl get cvc -n openebs -o json | \
    jq -r '.items[] | select(.status.phase != "Bound") | .metadata.name')
DEGRADED_MAYASTOR=$(kubectl get msv -n openebs -o json | \
    jq -r '.items[] | select(.status.state != "Online") | .metadata.name')

echo "Degraded cStor volumes: $DEGRADED_CSTOR"
echo "Degraded Mayastor volumes: $DEGRADED_MAYASTOR"

# Step 3: Check if data is accessible
echo "--- Step 3: Data Accessibility ---"
for vol in $DEGRADED_CSTOR; do
    echo "cStor volume $vol:"
    kubectl describe cvc "$vol" -n openebs | grep -A10 "Status:"
done

# Step 4: Attempt recovery
echo "--- Step 4: Recovery Actions ---"
# For Mayastor: delete degraded replicas to trigger rebuild
kubectl get msr -n openebs -o json | \
    jq -r '.items[] | select(.status.state == "Faulted") | .metadata.name' | \
    while read replica; do
        echo "Deleting faulted replica: $replica"
        kubectl delete msr "$replica" -n openebs
    done

echo "Recovery actions initiated. Monitor with: kubectl get msv,msr -n openebs -w"
```

## Key Takeaways

OpenEBS brings enterprise-grade storage capabilities to Kubernetes without requiring specialized storage hardware or external storage systems. The three engines serve distinct needs:

**LocalPV** is the right choice when your application already handles data replication. The performance overhead of double-replication (application layer + storage layer) is unnecessary and costly when running distributed databases like Cassandra or MongoDB replica sets.

**cStor** provides a battle-tested replicated storage option for legacy workloads or teams not yet ready for NVMe. The RAID group model is familiar to operations teams with SAN experience.

**Mayastor** represents the future of cloud-native storage. Its user-space SPDK stack delivers NVMe-class performance with Kubernetes-native replication. For new deployments on NVMe hardware, Mayastor should be the default choice.

Operational success with OpenEBS requires investing in monitoring, backup automation, and clear runbooks. Storage failures are rare but catastrophic when they occur — the time to build recovery procedures is before an incident, not during one.
