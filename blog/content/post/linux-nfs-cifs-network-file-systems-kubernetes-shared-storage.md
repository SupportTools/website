---
title: "Linux NFS and CIFS: Network File Systems for Kubernetes Shared Storage"
date: 2030-10-27T00:00:00-05:00
draft: false
tags: ["NFS", "CIFS", "Samba", "Kubernetes", "Storage", "Linux", "CSI"]
categories:
- Linux
- Kubernetes
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise NFS guide covering NFSv4 server configuration and exports, Kubernetes NFS provisioner, NFS CSI driver for dynamic PVC provisioning, Samba/CIFS for Windows compatibility, performance tuning (rsize/wsize, async), and debugging NFS mount failures in production."
more_link: "yes"
url: "/linux-nfs-cifs-network-file-systems-kubernetes-shared-storage/"
---

NFS remains the dominant shared filesystem for Kubernetes workloads that require ReadWriteMany (RWX) access modes—scenarios where multiple pods on different nodes must read and write the same files simultaneously. Understanding NFSv4 semantics, performance tuning, and the Kubernetes CSI driver layer is essential for building reliable shared storage infrastructure.

<!--more-->

## Section 1: NFS Server Configuration

### Installation and Base Setup

```bash
# Debian/Ubuntu
apt-get install -y nfs-kernel-server nfs-common rpcbind

# RHEL/Rocky/AlmaLinux
dnf install -y nfs-utils

# Enable and start services
systemctl enable --now nfs-server rpcbind

# Verify NFS version support
cat /proc/fs/nfsd/versions
# Output should include: +2 +3 +4 +4.1 +4.2
```

### NFSv4-Only Server Configuration

NFSv3 requires portmapper and multiple ports, making firewall configuration complex. Forcing NFSv4 simplifies firewall rules to a single port (2049) and provides better security through AUTH_GSS support:

```bash
# /etc/nfs.conf — enforce NFSv4 only
[nfsd]
# Number of NFS server threads (tune based on CPU cores and client count)
threads = 16
# Disable NFSv2 and NFSv3
vers2 = no
vers3 = no
vers4 = yes
vers4.0 = yes
vers4.1 = yes
vers4.2 = yes

[mountd]
manage-gids = yes

[lockd]
port = 32768
udp-port = 32768
```

```bash
# /etc/default/nfs-kernel-server (Debian/Ubuntu)
RPCNFSDCOUNT="16"
RPCMOUNTDOPTS="--manage-gids"
NEED_SVCGSSD="no"
RPCSVCGSSDOPTS=""
```

### Directory Preparation

```bash
# Create export directories with appropriate permissions
mkdir -p /exports/kubernetes/shared
mkdir -p /exports/kubernetes/databases
mkdir -p /exports/kubernetes/logs

# Set ownership for container workloads
# Many containers run as UID 1000 or non-root
chown -R nobody:nogroup /exports/kubernetes/shared
chmod 2775 /exports/kubernetes/shared  # SGID bit for group inheritance

# For specific workloads with known UID
chown -R 1000:1000 /exports/kubernetes/databases
chmod 750 /exports/kubernetes/databases
```

### /etc/exports Configuration

```bash
# /etc/exports

# Shared storage for Kubernetes pods (multiple nodes)
# no_root_squash: allow root inside containers to write as root
# sync: write to disk before ACKing (safer but slower than async)
# no_subtree_check: improves reliability when files are renamed
/exports/kubernetes/shared \
    192.168.1.0/24(rw,sync,no_root_squash,no_subtree_check,fsid=100) \
    10.10.0.0/16(rw,sync,no_root_squash,no_subtree_check,fsid=100)

# Database storage — restricted to specific nodes
/exports/kubernetes/databases \
    192.168.1.11(rw,sync,no_root_squash,no_subtree_check,fsid=101) \
    192.168.1.12(rw,sync,no_root_squash,no_subtree_check,fsid=101) \
    192.168.1.13(rw,sync,no_root_squash,no_subtree_check,fsid=101)

# Log aggregation — write-only for log shippers
/exports/kubernetes/logs \
    10.10.0.0/16(rw,async,no_root_squash,no_subtree_check,fsid=102)

# NFSv4 pseudo root — required for NFSv4 clients
/exports 192.168.0.0/16(rw,fsid=0,insecure,no_subtree_check,async)
```

Apply exports without restarting:

```bash
exportfs -ra

# Verify exports
exportfs -v
showmount -e localhost
```

### Firewall Rules (NFSv4)

```bash
# NFSv4 only requires port 2049
ufw allow from 192.168.0.0/16 to any port 2049
ufw allow from 10.10.0.0/16 to any port 2049

# For NFSv4.x, no additional ports needed
# But if NFSv3 is required:
# ufw allow from 192.168.0.0/16 to any port 111  # portmapper
# ufw allow from 192.168.0.0/16 to any port 2049
# ufw allow from 192.168.0.0/16 to any port 32768  # lockd
```

## Section 2: Kubernetes NFS Provisioner

The `nfs-subdir-external-provisioner` creates subdirectories within an existing NFS share for each PVC, providing dynamic provisioning without requiring a full NFS CSI driver deployment.

### Installation via Helm

```bash
helm repo add nfs-subdir-external-provisioner \
  https://kubernetes-sigs.github.io/nfs-subdir-external-provisioner/

helm upgrade --install nfs-provisioner \
  nfs-subdir-external-provisioner/nfs-subdir-external-provisioner \
  --namespace nfs-provisioner \
  --create-namespace \
  --set nfs.server=192.168.1.50 \
  --set nfs.path=/exports/kubernetes/shared \
  --set storageClass.name=nfs-shared \
  --set storageClass.defaultClass=false \
  --set storageClass.reclaimPolicy=Retain \
  --set storageClass.accessModes=ReadWriteMany \
  --set replicaCount=2 \
  --set podAnnotations."cluster-autoscaler\.kubernetes\.io/safe-to-evict"=false
```

### StorageClass Configuration

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: nfs-shared-retain
  annotations:
    storageclass.kubernetes.io/is-default-class: "false"
provisioner: cluster.local/nfs-provisioner-nfs-subdir-external-provisioner
parameters:
  archiveOnDelete: "true"      # Move data to archived-<pvc-name> on deletion
  pathPattern: "${.PVC.namespace}/${.PVC.annotations.nfs.io/storage-path}"
  onDelete: archive
reclaimPolicy: Retain
volumeBindingMode: Immediate
allowVolumeExpansion: true
```

### PVC Usage

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: shared-uploads
  namespace: production
  annotations:
    nfs.io/storage-path: "uploads"
spec:
  accessModes:
    - ReadWriteMany
  storageClassName: nfs-shared-retain
  resources:
    requests:
      storage: 50Gi
```

## Section 3: NFS CSI Driver for Production Deployments

The NFS CSI driver provides a more robust, feature-complete approach to NFS in Kubernetes, including topology awareness and node-stage/publish lifecycle management.

### Installation

```bash
helm repo add csi-driver-nfs https://raw.githubusercontent.com/kubernetes-csi/csi-driver-nfs/master/charts

helm upgrade --install csi-driver-nfs csi-driver-nfs/csi-driver-nfs \
  --namespace kube-system \
  --version 4.9.0 \
  --set controller.replicas=2 \
  --set controller.resources.requests.cpu=10m \
  --set controller.resources.requests.memory=20Mi \
  --set node.resources.requests.cpu=10m \
  --set node.resources.requests.memory=20Mi
```

### StorageClass with NFS CSI Driver

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: nfs-csi-shared
provisioner: nfs.csi.k8s.io
parameters:
  # NFS server address
  server: 192.168.1.50
  # Base path on the NFS server
  share: /exports/kubernetes/shared
  # Subdirectory name (dynamic provisioning creates subdirectory per PVC)
  subDir: ${pvc.metadata.namespace}/${pvc.metadata.name}
  # Mount options passed to the mount command
  mountPermissions: "0755"
reclaimPolicy: Retain
volumeBindingMode: Immediate
allowVolumeExpansion: false
mountOptions:
  - nfsvers=4.1
  - proto=tcp
  - rsize=1048576
  - wsize=1048576
  - hard
  - timeo=600
  - retrans=2
  - noresvport
```

### PV/PVC for Pre-Provisioned Shares

When using pre-provisioned NFS paths (not dynamic provisioning):

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: nfs-database-pv
  annotations:
    pv.kubernetes.io/provisioned-by: nfs.csi.k8s.io
spec:
  capacity:
    storage: 200Gi
  accessModes:
    - ReadWriteMany
  persistentVolumeReclaimPolicy: Retain
  storageClassName: nfs-csi-shared
  mountOptions:
    - nfsvers=4.1
    - proto=tcp
    - rsize=1048576
    - wsize=1048576
    - hard
    - timeo=600
  csi:
    driver: nfs.csi.k8s.io
    # volumeHandle must be unique: server#share#subdir#uuid
    volumeHandle: 192.168.1.50#/exports/kubernetes/databases##
    volumeAttributes:
      server: 192.168.1.50
      share: /exports/kubernetes/databases
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: database-storage
  namespace: production
spec:
  accessModes:
    - ReadWriteMany
  resources:
    requests:
      storage: 200Gi
  storageClassName: nfs-csi-shared
  volumeName: nfs-database-pv
```

## Section 4: Samba/CIFS for Windows Compatibility

Samba provides SMB/CIFS protocol support for environments that include Windows clients alongside Linux/Kubernetes workloads, or where legacy applications expect UNC paths.

### Samba Server Installation

```bash
# Debian/Ubuntu
apt-get install -y samba samba-common-bin

# RHEL/Rocky
dnf install -y samba samba-common
```

### Samba Configuration

```ini
# /etc/samba/smb.conf
[global]
    workgroup = EXAMPLE
    server string = Kubernetes Storage Server
    netbios name = storage-01
    security = user
    map to guest = bad user
    dns proxy = no

    # Performance tuning
    socket options = TCP_NODELAY IPTOS_LOWDELAY SO_RCVBUF=131072 SO_SNDBUF=131072
    read raw = yes
    write raw = yes
    max xmit = 65535
    dead time = 15
    getwd cache = yes

    # Protocol version — use SMB3 for better performance and security
    server min protocol = SMB2
    server max protocol = SMB3

    # Logging
    log file = /var/log/samba/log.%m
    max log size = 50
    log level = 1

    # Disable printing
    load printers = no
    printing = bsd
    printcap name = /dev/null
    disable spoolss = yes

[kubernetes-shared]
    comment = Kubernetes Shared Storage
    path = /exports/kubernetes/shared
    browsable = yes
    writable = yes
    guest ok = no
    valid users = @kubernetes-users
    create mask = 0664
    directory mask = 0775
    force group = kubernetes-users

    # Performance
    strict sync = no
    sync always = no
    write cache size = 2097152

[kubernetes-logs]
    comment = Log Storage
    path = /exports/kubernetes/logs
    browsable = no
    writable = yes
    valid users = @log-writers
    create mask = 0640
    directory mask = 0750
    write cache size = 524288
```

### User and Group Setup

```bash
# Create group for Kubernetes workloads
groupadd kubernetes-users
groupadd log-writers

# Add Linux system users
useradd -M -s /sbin/nologin -G kubernetes-users k8s-storage

# Set Samba password (separate from Linux password)
smbpasswd -a k8s-storage
smbpasswd -e k8s-storage

# Restart Samba
systemctl restart smbd nmbd

# Test the share
smbclient -L localhost -U k8s-storage -N
```

### Kubernetes CIFS PVC

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: cifs-credentials
  namespace: production
type: Opaque
stringData:
  username: k8s-storage
  password: <samba-password>
---
apiVersion: v1
kind: PersistentVolume
metadata:
  name: cifs-shared-pv
spec:
  capacity:
    storage: 100Gi
  accessModes:
    - ReadWriteMany
  persistentVolumeReclaimPolicy: Retain
  mountOptions:
    - dir_mode=0777
    - file_mode=0777
    - uid=1000
    - gid=1000
    - vers=3.0
    - cache=strict
  csi:
    driver: smb.csi.k8s.io
    volumeHandle: smb-volume-id
    volumeAttributes:
      source: "//192.168.1.50/kubernetes-shared"
    nodeStageSecretRef:
      name: cifs-credentials
      namespace: production
```

Install the SMB CSI driver:

```bash
helm repo add csi-driver-smb https://raw.githubusercontent.com/kubernetes-csi/csi-driver-smb/master/charts
helm upgrade --install csi-driver-smb csi-driver-smb/csi-driver-smb \
  --namespace kube-system \
  --version 1.15.0
```

## Section 5: NFS Performance Tuning

### Mount Option Selection

The most impactful mount options for NFS performance:

```bash
# High-performance mount (async writes, large buffer sizes)
mount -t nfs4 \
  -o rsize=1048576,wsize=1048576,hard,timeo=600,retrans=2,noresvport,async,noatime \
  192.168.1.50:/exports/kubernetes/shared \
  /mnt/k8s-shared

# Safe mount for databases (sync writes, stricter timeouts)
mount -t nfs4 \
  -o rsize=1048576,wsize=1048576,hard,timeo=150,retrans=5,noresvport,sync,noatime \
  192.168.1.50:/exports/kubernetes/databases \
  /mnt/k8s-databases
```

### Mount Option Reference

| Option | Effect | When to Use |
|--------|--------|-------------|
| `rsize=1048576` | 1 MB read buffer | Always (NFS default is 32KB) |
| `wsize=1048576` | 1 MB write buffer | Always |
| `hard` | Retry indefinitely on server failure | Production (prevents silent data loss) |
| `soft` | Fail after retrans attempts | Non-critical reads only |
| `timeo=600` | 60-second timeout (units: 0.1s) | Production |
| `retrans=2` | Retry count before ETIMEDOUT | Balance with timeo |
| `async` | Client-side write buffering | Throughput-sensitive workloads |
| `sync` | Flush writes synchronously | Databases, critical data |
| `noatime` | Skip access time updates | All production workloads |
| `noresvport` | Allow reconnect on any port | Cloud environments |
| `nconnect=4` | Multiple TCP connections per server | High-throughput (kernel 5.3+) |

### nconnect for High-Throughput Workloads

The `nconnect` mount option creates multiple TCP connections to the NFS server, bypassing the single-stream bottleneck of traditional NFS:

```bash
# Use 4 TCP connections to the NFS server
mount -t nfs4 \
  -o rsize=1048576,wsize=1048576,hard,nconnect=4,noresvport \
  192.168.1.50:/exports/kubernetes/shared \
  /mnt/k8s-shared

# Verify connections
ss -tn dst 192.168.1.50 | grep ':2049'
# Should show 4 ESTABLISHED connections
```

### Server-Side Tuning

```bash
# /etc/nfs.conf — tune NFS server thread count
[nfsd]
# Rule of thumb: 8 threads per CPU core, minimum 16
threads = 32

# Increase rpcd thread pool
[rpcd]
threads = 16
```

```bash
# /etc/sysctl.d/99-nfs-server.conf
# Increase socket buffers for NFS server
net.core.rmem_max = 268435456
net.core.wmem_max = 268435456
net.core.rmem_default = 33554432
net.core.wmem_default = 33554432

# Increase NFS read-ahead
vm.dirty_ratio = 20
vm.dirty_background_ratio = 5
```

Apply:

```bash
sysctl --system
systemctl restart nfs-server
```

### Benchmark NFS Performance

```bash
# Sequential write throughput
fio --name=nfs-write \
  --directory=/mnt/k8s-shared \
  --rw=write \
  --bs=1M \
  --size=4G \
  --numjobs=4 \
  --runtime=60 \
  --group_reporting

# Sequential read throughput
fio --name=nfs-read \
  --directory=/mnt/k8s-shared \
  --rw=read \
  --bs=1M \
  --size=4G \
  --numjobs=4 \
  --runtime=60 \
  --group_reporting

# Random 4KB IOPS (database workload simulation)
fio --name=nfs-rand-rw \
  --directory=/mnt/k8s-shared \
  --rw=randrw \
  --bs=4K \
  --size=1G \
  --numjobs=8 \
  --runtime=60 \
  --group_reporting
```

## Section 6: Debugging NFS Mount Failures

### Common Error Patterns

**Permission denied:**

```bash
# On the client
mount.nfs: access denied by server while mounting 192.168.1.50:/exports/kubernetes/shared

# Diagnosis
showmount -e 192.168.1.50  # Is the export visible?
rpcinfo -p 192.168.1.50    # Is RPC responding?

# Check server export permissions
ssh 192.168.1.50 "exportfs -v | grep kubernetes"

# Verify client IP is in the export list
# If exporting to 192.168.1.0/24, the client must be in that range
```

**Stale file handle:**

```bash
# Error: "Stale file handle" or ESTALE
# Cause: The server file was deleted/moved while client still has open handles

# Force unmount and remount
umount -lf /mnt/k8s-shared  # lazy unmount
mount -t nfs4 192.168.1.50:/exports/kubernetes/shared /mnt/k8s-shared
```

**NFS server not responding (mount hangs):**

```bash
# Test connectivity first
nc -z -w5 192.168.1.50 2049 && echo "NFS port open" || echo "NFS port closed"

# Check RPC registration
rpcinfo -p 192.168.1.50

# On the server
nfsstat -s  # Server statistics
nfsstat -m  # Mount statistics (from client)

# Check NFS server threads
cat /proc/fs/nfsd/threads

# Check for NFS lock issues
/proc/fs/nfsd/unlock  # (DANGER: releases all NFS locks)
```

**High NFS latency:**

```bash
# Identify slow operations with nfsiostat
nfsiostat -m 5 /mnt/k8s-shared

# Check retransmission rate (high retrans = network issues)
nfsstat -c | grep -E "retrans|timeout"

# Network path check
traceroute 192.168.1.50
mtr -r -n 192.168.1.50

# Check NFS server disk I/O
ssh 192.168.1.50 "iostat -x 1 5"

# Check for NFS server CPU saturation
ssh 192.168.1.50 "top -b -n1 | grep nfsd"
```

### Kubernetes-Specific NFS Debugging

```bash
# Check CSI driver pods
kubectl get pods -n kube-system -l app=csi-nfs-controller
kubectl get pods -n kube-system -l app=csi-nfs-node

# Check CSI driver logs
kubectl logs -n kube-system -l app=csi-nfs-node -c nfs --tail=50

# Check PVC events
kubectl describe pvc shared-uploads -n production

# Check if mount is established on the node
kubectl debug node/worker-01 -it --image=ubuntu -- bash
# Inside debug pod
mount | grep nfs
cat /proc/mounts | grep nfs

# Check NFS mount options actually in use
cat /proc/mounts | grep nfs | awk '{print $4}'

# Test write from the node
dd if=/dev/zero of=/mnt/nfs-pvc-path/testfile bs=1M count=100
```

### NFS Alert Rules

```yaml
groups:
  - name: nfs
    rules:
      - alert: NFSServerUnreachable
        expr: |
          probe_success{job="blackbox-nfs",target=~".*:2049"} == 0
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "NFS server {{ $labels.target }} is unreachable"

      - alert: NFSHighRetransmissionRate
        expr: |
          rate(node_nfs_requests_total{method="WRITE"}[5m]) > 0
          and
          (rate(node_nfs_timeouts_total[5m]) / rate(node_nfs_requests_total[5m])) > 0.01
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "NFS retransmission rate above 1% on {{ $labels.instance }}"

      - alert: NFSDiskSpaceLow
        expr: |
          (node_filesystem_avail_bytes{mountpoint=~"/exports/.*"} /
           node_filesystem_size_bytes{mountpoint=~"/exports/.*"}) < 0.15
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "NFS export filesystem {{ $labels.mountpoint }} is {{ $value | humanizePercentage }} full"
```

## Section 7: NFS High Availability

For production workloads, a single NFS server is a single point of failure. Use DRBD + Pacemaker or a distributed filesystem like GlusterFS or CephFS for HA NFS.

### Keepalived VIP for Active/Passive NFS

```bash
# /etc/keepalived/keepalived.conf — on both NFS servers

# nfs-01 (MASTER)
vrrp_instance NFS_VIP {
    state MASTER
    interface eth0
    virtual_router_id 51
    priority 100
    advert_int 1
    authentication {
        auth_type PASS
        auth_pass <keepalived-auth-password>
    }
    virtual_ipaddress {
        192.168.1.50/24 dev eth0 label eth0:nfs
    }
    track_script {
        check_nfs
    }
}

vrrp_script check_nfs {
    script "/usr/local/bin/check-nfs.sh"
    interval 5
    weight -50
    fall 2
    rise 1
}
```

```bash
#!/usr/bin/env bash
# /usr/local/bin/check-nfs.sh
systemctl is-active --quiet nfs-server && \
  mountpoint -q /exports/kubernetes && \
  exit 0 || exit 1
```

The `virtual_ipaddress` (192.168.1.50) floats between servers. All NFS mounts reference this VIP. When nfs-01 fails, keepalived promotes nfs-02 and reassigns the VIP within one to two seconds.

NFS and CIFS remain the most straightforward path to ReadWriteMany storage in Kubernetes. The combination of a properly tuned NFSv4 server with the CSI driver provides production-grade dynamic PVC provisioning that covers the majority of shared storage use cases without the operational complexity of a full distributed filesystem.
