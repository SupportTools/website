---
title: "Linux iSCSI: Initiator Configuration and Multipathing for Enterprise Storage"
date: 2030-12-13T00:00:00-05:00
draft: false
tags: ["Linux", "iSCSI", "Storage", "Multipath", "Kubernetes", "Enterprise", "SAN", "CHAP"]
categories:
- Linux
- Storage
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Linux iSCSI configuration: open-iscsi initiator setup, target discovery, CHAP authentication, device-mapper-multipath for high-availability storage, failover testing, and Kubernetes iSCSI persistent volumes for enterprise SAN integration."
more_link: "yes"
url: "/linux-iscsi-initiator-multipathing-enterprise-storage-kubernetes/"
---

iSCSI remains the backbone of enterprise block storage in data centers where Fibre Channel is cost-prohibitive. Correctly configured iSCSI with multipath I/O provides the same high-availability and performance characteristics as FC at a fraction of the cost. This guide covers end-to-end iSCSI configuration from initiator setup through Kubernetes persistent volume integration.

<!--more-->

# Linux iSCSI: Initiator Configuration and Multipathing for Enterprise Storage

## Section 1: iSCSI Architecture Overview

iSCSI encapsulates SCSI commands in TCP/IP packets. The key components are:

- **Target**: The storage device (NetApp, Pure Storage, EMC, TrueNAS, etc.)
- **Initiator**: The client (Linux host or Kubernetes node)
- **IQN (iSCSI Qualified Name)**: Unique identifier for both targets and initiators
- **Portal**: IP:port combination where the target listens (default port 3260)
- **Session**: A connection between an initiator and a target
- **LUN (Logical Unit Number)**: A logical disk exposed by the target

For high availability, each host has two iSCSI NICs connecting to two independent storage fabric switches, each connected to both storage controllers. This creates four possible paths from initiator to target.

```
Initiator Host
  ├── eth2 (iSCSI NIC A) ──── Switch A ──── Storage Controller A
  │                                    └──── Storage Controller B
  └── eth3 (iSCSI NIC B) ──── Switch B ──── Storage Controller A
                                        └──── Storage Controller B
```

Device-mapper-multipath (dm-multipath) presents these four physical paths as a single virtual device to the OS, handles path failover transparently, and can load-balance I/O across paths.

## Section 2: Installing and Configuring the iSCSI Initiator

### Installation

```bash
# RHEL/CentOS/Rocky Linux
dnf install -y iscsi-initiator-utils device-mapper-multipath

# Ubuntu/Debian
apt-get install -y open-iscsi multipath-tools

# Verify installation
rpm -q iscsi-initiator-utils   # RHEL family
dpkg -l open-iscsi             # Debian family
```

### Initiator IQN Configuration

Every iSCSI initiator needs a unique IQN. The standard format is:
`iqn.YYYY-MM.reverse.domain:identifier`

```bash
# View the current initiator IQN (auto-generated at install time)
cat /etc/iscsi/initiatorname.iscsi

# Set a meaningful IQN (change before first login — cannot change after)
cat > /etc/iscsi/initiatorname.iscsi << 'EOF'
InitiatorName=iqn.2024-01.tools.support:k8s-node-01
EOF
```

### iscsid Configuration

```bash
# /etc/iscsi/iscsid.conf — critical settings for enterprise environments
cat > /etc/iscsi/iscsid.conf << 'EOF'
# Authentication
node.session.auth.authmethod = CHAP
node.session.auth.username = iqn.2024-01.tools.support:k8s-node-01
node.session.auth.password = <iscsi-chap-password-initiator>
# Mutual CHAP (target authenticates to initiator)
node.session.auth.username_in = iqn.2024-01.tools.support:storage-target-01
node.session.auth.password_in = <iscsi-chap-password-target>

# Discovery authentication
discovery.sendtargets.auth.authmethod = CHAP
discovery.sendtargets.auth.username = iqn.2024-01.tools.support:k8s-node-01
discovery.sendtargets.auth.password = <iscsi-chap-password-initiator>

# Session timeouts — tune for your storage array
node.session.timeo.replacement_timeout = 120
node.conn[0].timeo.login_timeout = 15
node.conn[0].timeo.logout_timeout = 15
node.conn[0].timeo.noop_out_interval = 5
node.conn[0].timeo.noop_out_timeout = 5

# Queue depth — match to storage array recommendation
node.session.cmds_max = 128
node.session.queue_depth = 32

# Error recovery
node.session.err_timeo.abort_timeout = 15
node.session.err_timeo.lu_reset_timeout = 30
node.session.err_timeo.tgt_reset_timeout = 30

# Automatic login at boot
node.startup = automatic
node.conn[0].startup = automatic

# TCP settings for dedicated iSCSI NICs
node.conn[0].iscsi.InitialR2T = No
node.conn[0].iscsi.ImmediateData = Yes
node.conn[0].iscsi.FirstBurstLength = 262144
node.conn[0].iscsi.MaxBurstLength = 16776192
node.conn[0].iscsi.MaxRecvDataSegmentLength = 262144
node.conn[0].iscsi.MaxXmitDataSegmentLength = 0
EOF
```

### Network Configuration for iSCSI NICs

iSCSI NICs should be on dedicated VLANs with jumbo frames:

```bash
# /etc/NetworkManager/system-connections/iscsi-a.nmconnection
cat > /etc/NetworkManager/system-connections/iscsi-a.nmconnection << 'EOF'
[connection]
id=iscsi-a
type=ethernet
interface-name=eth2
autoconnect=true

[ethernet]
mtu=9000

[ipv4]
method=manual
address1=192.168.100.10/24
# No default gateway on iSCSI NICs
dns-search=

[ipv6]
method=disabled
EOF

chmod 600 /etc/NetworkManager/system-connections/iscsi-a.nmconnection

cat > /etc/NetworkManager/system-connections/iscsi-b.nmconnection << 'EOF'
[connection]
id=iscsi-b
type=ethernet
interface-name=eth3
autoconnect=true

[ethernet]
mtu=9000

[ipv4]
method=manual
address1=192.168.101.10/24

[ipv6]
method=disabled
EOF

chmod 600 /etc/NetworkManager/system-connections/iscsi-b.nmconnection
nmcli connection reload
nmcli connection up iscsi-a
nmcli connection up iscsi-b

# Verify MTU
ip link show eth2
# eth2: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 9000 ...

# Test jumbo frames end-to-end
ping -M do -s 8972 192.168.100.1   # 8972 + 28 headers = 9000 MTU
```

### Disable iSCSI NIC Features that Cause Problems

```bash
# Disable NIC offloads that can cause issues with iSCSI
ethtool -K eth2 tx off rx off gso off tso off gro off lro off

# Make persistent with udev rule
cat > /etc/udev/rules.d/99-iscsi-nic.rules << 'EOF'
ACTION=="add", SUBSYSTEM=="net", KERNEL=="eth2", \
    RUN+="/sbin/ethtool -K eth2 tx off rx off gso off tso off gro off lro off"
ACTION=="add", SUBSYSTEM=="net", KERNEL=="eth3", \
    RUN+="/sbin/ethtool -K eth3 tx off rx off gso off tso off gro off lro off"
EOF
```

## Section 3: Target Discovery and Login

### Discover Targets

```bash
# Enable and start iscsid
systemctl enable --now iscsid

# Discover targets via SendTargets method
# Portal A (primary storage controller)
iscsiadm -m discovery -t sendtargets -p 192.168.100.100:3260

# Portal B (secondary storage controller)
iscsiadm -m discovery -t sendtargets -p 192.168.101.100:3260

# Example output:
# 192.168.100.100:3260,1 iqn.2020-01.com.purestorage:flasharray-m50.lun01
# 192.168.100.101:3260,2 iqn.2020-01.com.purestorage:flasharray-m50.lun01
# 192.168.101.100:3260,1 iqn.2020-01.com.purestorage:flasharray-m50.lun01
# 192.168.101.101:3260,2 iqn.2020-01.com.purestorage:flasharray-m50.lun01

# List discovered nodes
iscsiadm -m node

# View node record details
iscsiadm -m node -T iqn.2020-01.com.purestorage:flasharray-m50.lun01 \
    -p 192.168.100.100:3260
```

### Login to Targets

```bash
# Login to a specific target
iscsiadm -m node \
    -T iqn.2020-01.com.purestorage:flasharray-m50.lun01 \
    -p 192.168.100.100:3260 \
    --login

# Login to all discovered targets
iscsiadm -m node --loginall=all

# Check active sessions
iscsiadm -m session
# tcp: [1] 192.168.100.100:3260,1 iqn.2020-01.com.purestorage:flasharray-m50.lun01 (non-flash)
# tcp: [2] 192.168.100.101:3260,2 iqn.2020-01.com.purestorage:flasharray-m50.lun01 (non-flash)
# tcp: [3] 192.168.101.100:3260,1 iqn.2020-01.com.purestorage:flasharray-m50.lun01 (non-flash)
# tcp: [4] 192.168.101.101:3260,2 iqn.2020-01.com.purestorage:flasharray-m50.lun01 (non-flash)

# Check iSCSI device
ls -la /dev/disk/by-path/
# ip-192.168.100.100:3260-iscsi-iqn.2020-01.com.purestorage:flasharray-m50.lun01-lun-1 -> ../../sdb
# ip-192.168.100.101:3260-iscsi-iqn.2020-01.com.purestorage:flasharray-m50.lun01-lun-1 -> ../../sdc
# ip-192.168.101.100:3260-iscsi-iqn.2020-01.com.purestorage:flasharray-m50.lun01-lun-1 -> ../../sdd
# ip-192.168.101.101:3260-iscsi-iqn.2020-01.com.purestorage:flasharray-m50.lun01-lun-1 -> ../../sde
```

### CHAP Authentication Setup

```bash
# Set CHAP credentials for a specific node record
iscsiadm -m node \
    -T iqn.2020-01.com.purestorage:flasharray-m50.lun01 \
    -p 192.168.100.100:3260 \
    --op update \
    --name node.session.auth.authmethod \
    --value CHAP

iscsiadm -m node \
    -T iqn.2020-01.com.purestorage:flasharray-m50.lun01 \
    -p 192.168.100.100:3260 \
    --op update \
    --name node.session.auth.username \
    --value "iqn.2024-01.tools.support:k8s-node-01"

iscsiadm -m node \
    -T iqn.2020-01.com.purestorage:flasharray-m50.lun01 \
    -p 192.168.100.100:3260 \
    --op update \
    --name node.session.auth.password \
    --value "<iscsi-chap-password-initiator>"

# Test CHAP authentication by re-logging in
iscsiadm -m node \
    -T iqn.2020-01.com.purestorage:flasharray-m50.lun01 \
    -p 192.168.100.100:3260 \
    --logout

iscsiadm -m node \
    -T iqn.2020-01.com.purestorage:flasharray-m50.lun01 \
    -p 192.168.100.100:3260 \
    --login
```

## Section 4: Device-Mapper Multipath Configuration

### Core Multipath Configuration

```bash
# Generate a default config and customize
mpathconf --enable --with_multipathd y

# /etc/multipath.conf — full production configuration
cat > /etc/multipath.conf << 'EOF'
defaults {
    # Failover behavior
    polling_interval        5
    path_selector           "round-robin 0"
    path_grouping_policy    multibus
    failback                immediate
    rr_weight               priorities
    no_path_retry           fail
    user_friendly_names     yes
    find_multipaths         yes

    # Timeouts
    fast_io_fail_tmo        5
    dev_loss_tmo            30
}

blacklist {
    # Blacklist non-iSCSI devices to prevent multipath from claiming them
    devnode "^(ram|raw|loop|fd|md|dm-|sr|scd|st)[0-9]*"
    devnode "^hd[a-z]"
    devnode "^nvme[0-9]"

    # Blacklist local SATA/NVMe boot devices by WWN
    wwid "REPLACE_WITH_LOCAL_DISK_WWID"
}

# Pure Storage FlashArray configuration
devices {
    device {
        vendor                  "PURE"
        product                 "FlashArray"
        path_grouping_policy    multibus
        path_selector           "service-time 0"
        path_checker            tur
        features                "0"
        hardware_handler        "1 alua"
        prio                    alua
        failback                immediate
        rr_weight               priorities
        no_path_retry           0
        rr_min_io               1
        fast_io_fail_tmo        10
        dev_loss_tmo            600
        user_friendly_names     yes
    }

    # NetApp ONTAP (AFF/FAS) configuration
    device {
        vendor                  "NETAPP"
        product                 "LUN"
        path_grouping_policy    group_by_prio
        features                "3 queue_if_no_path pg_init_retries 50"
        prio                    ontap
        path_checker            directio
        hardware_handler        "1 alua"
        failback                immediate
        rr_weight               uniform
        no_path_retry           18
        fast_io_fail_tmo        5
        dev_loss_tmo            infinity
    }

    # Generic iSCSI storage
    device {
        vendor                  ".*"
        product                 ".*"
        path_grouping_policy    failover
        path_checker            tur
        failback                5
        no_path_retry           fail
    }
}

# Explicitly whitelist iSCSI devices by WWN
multipaths {
    multipath {
        wwid    360000000000000001
        alias   prod-db-vol01
        rr_weight priorities
        path_grouping_policy multibus
    }
    multipath {
        wwid    360000000000000002
        alias   prod-db-vol02
    }
}
EOF

# Restart multipathd
systemctl restart multipathd

# Verify configuration
multipath -t       # Show compiled config
multipath -ll      # Show all multipath devices
```

### Multipath Device Status

```bash
# Check multipath status
multipath -ll

# Expected output for a healthy 4-path setup:
# prod-db-vol01 (360000000000000001) dm-0 PURE,FlashArray
# size=1.0T features='0' hwhandler='1 alua' wp=rw
# |-+- policy='service-time 0' prio=50 status=active
# | |- 0:0:0:1 sdb 8:16 active ready running
# | |- 0:0:1:1 sdc 8:32 active ready running
# |-+- policy='service-time 0' prio=10 status=enabled
#   |- 1:0:0:1 sdd 8:48 active ready running
#   |- 1:0:1:1 sde 8:64 active ready running

# Check individual path status
multipathd show paths
multipathd show topology

# Check I/O stats per path
multipathd show maps stats
```

### Creating Filesystems on Multipath Devices

```bash
# Always use the multipath device (dm-*), NEVER the underlying sd* device directly
ls -la /dev/mapper/prod-db-vol01
# lrwxrwxrwx 1 root root 7 Dec 13 00:00 /dev/mapper/prod-db-vol01 -> ../dm-0

# Create filesystem
mkfs.xfs -L prod-db-vol01 /dev/mapper/prod-db-vol01

# Get the WWID for /etc/fstab (persistent naming)
/lib/udev/scsi_id --page=0x83 --whitelisted /dev/mapper/prod-db-vol01
# 360000000000000001

# Mount using dm device name (more stable than UUID for multipath)
echo "/dev/mapper/prod-db-vol01 /mnt/prod-db xfs defaults,_netdev,noatime 0 0" >> /etc/fstab

mount /mnt/prod-db
```

## Section 5: Failover Testing

### Simulating Path Failures

```bash
#!/bin/bash
# test-multipath-failover.sh

DEVICE="/dev/mapper/prod-db-vol01"
MOUNT_POINT="/mnt/prod-db"
TEST_FILE="$MOUNT_POINT/failover-test-$(date +%s)"

echo "=== Starting Multipath Failover Test ==="

# Baseline: write test data
fio --name=baseline --filename=$TEST_FILE --bs=64k --size=512m \
    --runtime=30 --time_based --rw=randrw --iodepth=16 \
    --ioengine=libaio --direct=1 --output-format=json > /tmp/fio-baseline.json &
FIO_PID=$!

echo "FIO running with PID $FIO_PID"

# Show current paths
echo ""
echo "=== Current Paths ==="
multipath -ll $DEVICE | head -20

# Simulate path failure by blocking one NIC
sleep 5
echo ""
echo "=== Simulating path failure on eth2 ==="
ip link set eth2 down
echo "eth2 is DOWN"

# Check failover
sleep 3
echo ""
echo "=== Path status after eth2 failure ==="
multipath -ll $DEVICE | head -20
multipathd show paths | head -20

# Restore path
sleep 10
echo ""
echo "=== Restoring eth2 ==="
ip link up eth2
sleep 5

echo ""
echo "=== Path status after eth2 restore ==="
multipath -ll $DEVICE | head -20

# Wait for FIO to complete
wait $FIO_PID

echo ""
echo "=== FIO completed — checking for I/O errors ==="
# Check for I/O errors in kernel log
dmesg | grep -E "(I/O error|SCSI error|path fail|multipath)" | tail -20

echo ""
echo "=== Test complete ==="
```

### Testing with Actual I/O During Failover

```bash
# Start background I/O
fio --name=failover-test \
    --filename=/mnt/prod-db/failover.dat \
    --bs=4k \
    --size=10g \
    --runtime=300 \
    --time_based \
    --rw=randrw \
    --iodepth=32 \
    --ioengine=libaio \
    --direct=1 \
    --verify=md5 \
    --do_verify=1 \
    --verify_fatal=1 &    # Will exit with error if data corruption occurs

FIO_PID=$!
echo "FIO PID: $FIO_PID"

# Simulate failures at 10, 30, and 60 seconds
sleep 10
ip link set eth2 down
echo "$(date): eth2 DOWN"

sleep 20
ip link set eth2 up
echo "$(date): eth2 UP"

sleep 10
ip link set eth3 down
echo "$(date): eth3 DOWN"

sleep 20
ip link set eth3 up
echo "$(date): eth3 UP"

# Check FIO result
wait $FIO_PID
FIO_EXIT=$?
if [ $FIO_EXIT -eq 0 ]; then
    echo "SUCCESS: No I/O errors during failover"
else
    echo "FAILURE: I/O errors detected (exit code $FIO_EXIT)"
fi
```

## Section 6: iSCSI Persistent Volumes in Kubernetes

### Static iSCSI PV

```yaml
# iscsi-pv-static.yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: iscsi-pv-prod-db
  annotations:
    volume.beta.kubernetes.io/storage-class: ""
spec:
  capacity:
    storage: 500Gi
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  storageClassName: ""
  iscsi:
    targetPortal: 192.168.100.100:3260
    portals:
      - 192.168.100.101:3260
      - 192.168.101.100:3260
      - 192.168.101.101:3260
    iqn: iqn.2020-01.com.purestorage:flasharray-m50.lun01
    lun: 1
    fsType: xfs
    readOnly: false
    # CHAP authentication
    chapAuthDiscovery: true
    chapAuthSession: true
    secretRef:
      name: iscsi-chap-secret
    # Multipath through device naming
    initiatorName: iqn.2024-01.tools.support:k8s-node-01
```

```yaml
# iscsi-chap-secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: iscsi-chap-secret
  namespace: default
type: "kubernetes.io/iscsi-chap"
data:
  # echo -n "username" | base64
  node.session.auth.username: <base64-encoded-username>
  # echo -n "password" | base64
  node.session.auth.password: <base64-encoded-password>
  node.session.auth.username_in: <base64-encoded-target-username>
  node.session.auth.password_in: <base64-encoded-target-password>
```

```yaml
# iscsi-pvc.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-storage
  namespace: production
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: ""
  volumeName: iscsi-pv-prod-db
  resources:
    requests:
      storage: 500Gi
```

### Dynamic iSCSI Provisioning with iSCSI CSI Driver

```yaml
# iscsi-csi-storageclass.yaml
# Using the democratic-csi driver for dynamic iSCSI provisioning
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: iscsi-csi
provisioner: org.democratic-csi.iscsi
parameters:
  csi.storage.k8s.io/provisioner-secret-name: democratic-csi-driver-config
  csi.storage.k8s.io/provisioner-secret-namespace: democratic-csi
  csi.storage.k8s.io/controller-publish-secret-name: democratic-csi-driver-config
  csi.storage.k8s.io/controller-publish-secret-namespace: democratic-csi
  csi.storage.k8s.io/node-stage-secret-name: democratic-csi-driver-config
  csi.storage.k8s.io/node-stage-secret-namespace: democratic-csi
  csi.storage.k8s.io/node-publish-secret-name: democratic-csi-driver-config
  csi.storage.k8s.io/node-publish-secret-namespace: democratic-csi
  csi.storage.k8s.io/node-expand-secret-name: democratic-csi-driver-config
  csi.storage.k8s.io/node-expand-secret-namespace: democratic-csi
  fsType: xfs
reclaimPolicy: Retain
allowVolumeExpansion: true
volumeBindingMode: Immediate
mountOptions:
  - noatime
  - nodiratime
```

### Kubernetes iSCSI with Multipath

For Kubernetes nodes, enable multipath before deploying iSCSI workloads:

```bash
#!/bin/bash
# setup-iscsi-k8s-node.sh — run on every Kubernetes node that will use iSCSI

# Install packages
if command -v apt-get &> /dev/null; then
    apt-get install -y open-iscsi multipath-tools
elif command -v dnf &> /dev/null; then
    dnf install -y iscsi-initiator-utils device-mapper-multipath
fi

# Set unique initiator name
NODE_NAME=$(hostname -s)
cat > /etc/iscsi/initiatorname.iscsi << EOF
InitiatorName=iqn.2024-01.tools.support:${NODE_NAME}
EOF

# Configure multipath
cat > /etc/multipath.conf << 'EOF'
defaults {
    user_friendly_names yes
    find_multipaths yes
    no_path_retry fail
    polling_interval 5
}
blacklist {
    devnode "^(ram|raw|loop|fd|md|dm-|sr|scd|st)[0-9]*"
    devnode "^nvme[0-9]"
}
EOF

# Enable services
systemctl enable --now iscsid
systemctl enable --now multipathd

# Verify
iscsiadm -m iface
```

## Section 7: Monitoring and Troubleshooting

### Key Monitoring Commands

```bash
# Session statistics
iscsiadm -m session -P 3 | grep -E "(Target|Portal|State|iSCSI Connection State)"

# Path statistics
multipath -ll
multipathd show paths format "%d %t %i %p %P"

# Block device stats for multipath device
iostat -x /dev/mapper/prod-db-vol01 1

# iSCSI statistics from kernel
cat /proc/net/iscsi_exact_stats  # if available

# Check for iSCSI errors in kernel log
journalctl -k | grep -i iscsi | tail -50
dmesg | grep -i iscsi | tail -50
```

### Common Issues and Solutions

```bash
# Issue: Device not appearing after discovery
# Solution: Check firewall and network connectivity
nc -zv 192.168.100.100 3260
iptables -L INPUT | grep 3260
firewall-cmd --list-ports

# Issue: Session keeps dropping (wrong timeout settings)
# Check current timeout
iscsiadm -m session -P 3 | grep timeout

# Issue: Multipath not picking up all paths
# Force rescan
iscsiadm -m session --rescan
multipath -F   # Flush stale multipath maps
multipath      # Re-discover
multipath -ll  # Verify all paths present

# Issue: dm-multipath taking wrong device
# Get WWID of a specific device
/lib/udev/scsi_id --page=0x83 --whitelisted /dev/sdb
# Blacklist the device in multipath.conf using its WWID

# Issue: Poor iSCSI performance
# Check CPU interrupts and NIC affinity
cat /proc/interrupts | grep eth2
# Set IRQ affinity for iSCSI NICs
echo 2 > /proc/irq/$(cat /sys/class/net/eth2/device/irq)/smp_affinity

# Enable jumbo frames and verify
ip link show eth2 | grep mtu
ping -M do -s 8972 -c 3 192.168.100.100
```

### iSCSI Performance Benchmarking

```bash
# Sequential read throughput
fio --name=seq-read \
    --filename=/dev/mapper/prod-db-vol01 \
    --bs=1m \
    --size=10g \
    --rw=read \
    --iodepth=32 \
    --ioengine=libaio \
    --direct=1 \
    --numjobs=4 \
    --group_reporting

# Random 4K IOPS (database workload)
fio --name=rand-4k \
    --filename=/dev/mapper/prod-db-vol01 \
    --bs=4k \
    --size=10g \
    --rw=randrw \
    --rwmixread=70 \
    --iodepth=64 \
    --ioengine=libaio \
    --direct=1 \
    --numjobs=8 \
    --runtime=60 \
    --time_based \
    --group_reporting

# Latency test
fio --name=latency \
    --filename=/dev/mapper/prod-db-vol01 \
    --bs=4k \
    --size=1g \
    --rw=randread \
    --iodepth=1 \
    --ioengine=libaio \
    --direct=1 \
    --runtime=30 \
    --time_based \
    --lat_percentiles=1 \
    --percentile_list=50:90:95:99:99.9:99.99
```

A properly configured iSCSI stack with multipathing provides enterprise-grade block storage with sub-millisecond failover, transparent load balancing, and seamless Kubernetes integration. The key to reliable operation is proper NIC configuration with jumbo frames, a storage array-specific multipath profile, and thorough failover testing before production deployment.
