---
title: "Linux iSCSI Initiator Configuration: Multipath I/O, CHAP Authentication, LIO Kernel Target, and NVMe-oF"
date: 2031-10-31T00:00:00-05:00
draft: false
tags: ["Linux", "iSCSI", "Multipath", "Storage", "NVMe-oF", "LIO", "CHAP", "SAN"]
categories:
- Linux
- Storage
- Infrastructure
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide to Linux iSCSI storage configuration: setting up the initiator with CHAP authentication, configuring multipath I/O for high availability, deploying the Linux-IO kernel target, and transitioning to NVMe over Fabrics for modern high-performance storage."
more_link: "yes"
url: "/linux-iscsi-initiator-multipath-io-chap-lio-nvme-of/"
---

iSCSI remains a foundational storage protocol in enterprise environments, providing block-level access to storage over standard Ethernet infrastructure. Properly configured with multipath I/O and mutual CHAP authentication, iSCSI delivers the reliability and security required for production workloads. This guide covers the complete Linux iSCSI stack from initiator configuration through NVMe-oF migration paths.

<!--more-->

# Linux iSCSI and NVMe-oF: Enterprise Storage Configuration

## iSCSI Architecture Overview

iSCSI (Internet Small Computer System Interface) encapsulates SCSI commands in TCP/IP packets, allowing storage area network (SAN) functionality over existing Ethernet infrastructure.

Key components:
- **Initiator**: Client that initiates connections to storage (the Linux host)
- **Target**: Storage server that accepts connections and presents LUNs
- **IQN**: iSCSI Qualified Name - unique identifier (format: `iqn.YYYY-MM.reverse.domain:identifier`)
- **Portal**: IP:port combination for iSCSI connections (default port 3260)
- **LUN**: Logical Unit Number - individual storage device presented by target

## Installing the iSCSI Initiator

```bash
# RHEL/CentOS/Rocky Linux
dnf install -y iscsi-initiator-utils device-mapper-multipath

# Ubuntu/Debian
apt-get install -y open-iscsi multipath-tools

# Verify packages
rpm -q iscsi-initiator-utils device-mapper-multipath  # RHEL
dpkg -l open-iscsi multipath-tools                     # Ubuntu
```

### Configure the Initiator IQN

```bash
# View the auto-generated IQN
cat /etc/iscsi/initiatorname.iscsi

# Set a meaningful IQN following naming conventions
# Format: iqn.YYYY-MM.reverse.domain:hostname.purpose
cat > /etc/iscsi/initiatorname.iscsi << 'EOF'
InitiatorName=iqn.2024-01.corp.example:prod-web-01.san
EOF

# The IQN must be unique per host
# Use the hostname and purpose to ensure uniqueness
```

## CHAP Authentication Configuration

CHAP (Challenge Handshake Authentication Protocol) authenticates the initiator to the target and optionally the target to the initiator (mutual CHAP).

### Initiator-side CHAP Configuration

```bash
# /etc/iscsi/iscsid.conf
# Key authentication settings

# One-way CHAP (initiator authenticates to target)
cat >> /etc/iscsi/iscsid.conf << 'EOF'

# CHAP settings
node.session.auth.authmethod = CHAP
node.session.auth.username = iscsi-prod-web-01
node.session.auth.password = S3cur3P@ssw0rdExample!

# Mutual CHAP (target also authenticates to initiator)
node.session.auth.username_in = storage-target-01
node.session.auth.password_in = T@rg3tSecr3tExample!

# Discovery CHAP
discovery.sendtargets.auth.authmethod = CHAP
discovery.sendtargets.auth.username = discover-user
discovery.sendtargets.auth.password = D1sc0v3ryP@ssExample!
EOF
```

### Complete iscsid.conf Production Template

```ini
# /etc/iscsi/iscsid.conf
# Production iSCSI initiator configuration

# Session management
node.startup = automatic
node.session.err_timeo.abort_timeout = 15
node.session.err_timeo.lu_reset_timeout = 30
node.session.err_timeo.tgt_reset_timeout = 30

# Login timeouts
node.conn[0].timeo.login_timeout = 30
node.conn[0].timeo.logout_timeout = 15
node.conn[0].timeo.noop_out_interval = 5
node.conn[0].timeo.noop_out_timeout = 5

# Connection parameters
node.conn[0].iscsi.MaxRecvDataSegmentLength = 262144
node.session.iscsi.InitialR2T = No
node.session.iscsi.ImmediateData = Yes
node.session.iscsi.FirstBurstLength = 262144
node.session.iscsi.MaxBurstLength = 16776192
node.session.iscsi.MaxConnections = 1
node.session.iscsi.FastAbort = Yes

# Queuing
node.session.queue_depth = 128

# Error recovery
node.session.err_timeo.abort_timeout = 15
node.session.err_timeo.lu_reset_timeout = 30
node.session.err_timeo.tgt_reset_timeout = 30
node.session.err_timeo.host_reset_timeout = 60

# CHAP Authentication
node.session.auth.authmethod = CHAP
node.session.auth.username = iscsi-prod-web-01
node.session.auth.password = S3cur3P@ssw0rdExample!
node.session.auth.username_in = storage-target-01
node.session.auth.password_in = T@rg3tSecr3tExample!
discovery.sendtargets.auth.authmethod = CHAP
discovery.sendtargets.auth.username = discover-user
discovery.sendtargets.auth.password = D1sc0v3ryP@ssExample!
```

## Discovering and Connecting to Targets

### Target Discovery

```bash
# Start the iSCSI service
systemctl enable --now iscsid

# Discover targets on a specific portal (with CHAP)
iscsiadm --mode discoverydb \
  --type sendtargets \
  --portal 10.0.10.100:3260 \
  --op new \
  --op update \
  --name discovery.sendtargets.auth.authmethod \
  --value CHAP \
  --name discovery.sendtargets.auth.username \
  --value discover-user \
  --name discovery.sendtargets.auth.password \
  --value D1sc0v3ryP@ssExample! \
  --discover

# Example output:
# 10.0.10.100:3260,1 iqn.2024-01.corp.example:storage-01.lun0
# 10.0.10.101:3260,1 iqn.2024-01.corp.example:storage-01.lun0
# 10.0.10.100:3260,2 iqn.2024-01.corp.example:storage-02.lun0

# List discovered targets
iscsiadm --mode discoverydb --type sendtargets --portal 10.0.10.100:3260 --discover
```

### Logging Into Targets

```bash
# Login to a specific target
iscsiadm --mode node \
  --targetname iqn.2024-01.corp.example:storage-01.lun0 \
  --portal 10.0.10.100:3260 \
  --login

# Login to all discovered targets
iscsiadm --mode node --loginall all

# Verify sessions
iscsiadm --mode session --print 3

# Example output:
# tcp: [1] 10.0.10.100:3260,1 iqn.2024-01.corp.example:storage-01.lun0 (non-flash)
# tcp: [2] 10.0.10.101:3260,1 iqn.2024-01.corp.example:storage-01.lun0 (non-flash)
```

### Verify Block Device Availability

```bash
# List attached iSCSI disks
lsblk | grep -A 5 disk
ls -la /dev/disk/by-path/ | grep iscsi

# Check SCSI devices
lsscsi

# View session details
iscsiadm --mode session --print 3
```

## Multipath I/O Configuration

Multipath I/O provides redundancy and load balancing by creating a single logical device from multiple physical paths to the same storage.

### Install and Configure dm-multipath

```bash
# Enable multipathd
systemctl enable --now multipathd

# Initial configuration
mpathconf --enable --with_multipathd y
```

### Production multipath.conf

```ini
# /etc/multipath.conf
# Production multipath configuration for iSCSI

defaults {
    user_friendly_names     yes
    find_multipaths         yes
    path_grouping_policy    multibus
    path_selector           "round-robin 0"
    failback                immediate
    no_path_retry           5
    rr_min_io               100
    flush_on_last_del       yes
    max_fds                 8192
    dev_loss_tmo            30
    fast_io_fail_tmo        5

    # Hardware-specific tunables
    polling_interval        2
    path_checker            tur         # Test Unit Ready
    prio                    const
}

blacklist {
    # Exclude local disks and known non-multipathed devices
    devnode "^(ram|raw|loop|fd|md|dm-|sr|scd|st)[0-9]*"
    devnode "^hd[a-z]"
    devnode "^nvme[0-9]"  # NVMe devices handled separately

    # Exclude virtual devices
    device {
        vendor  "VMware"
        product "Virtual disk"
    }
    device {
        vendor  "QEMU"
        product "QEMU HARDDISK"
    }
}

blacklist_exceptions {
    # Re-include specific NVMe multipath devices if using NVMe-TCP multipath
    devnode "^nvme[0-9]n[0-9]"
}

devices {
    # Pure Storage FlashArray
    device {
        vendor              "PURE"
        product             "FlashArray"
        path_grouping_policy    multibus
        path_selector           "round-robin 0"
        path_checker            tur
        fast_io_fail_tmo        10
        dev_loss_tmo            60
        no_path_retry           0
        hardware_handler        "0"
    }

    # NetApp ONTAP
    device {
        vendor              "NETAPP"
        product             "LUN.*"
        path_grouping_policy    group_by_prio
        path_checker            tur
        prio                    "ontap"
        failback                immediate
        rr_weight               priorities
        no_path_retry           queue
        dev_loss_tmo            60
    }

    # Dell EMC PowerStore
    device {
        vendor              "DellEMC"
        product             "PowerStore"
        path_grouping_policy    group_by_prio
        prio                    alua
        path_checker            tur
        hardware_handler        "1 alua"
        failback                immediate
        no_path_retry           queue
    }

    # Generic iSCSI storage
    device {
        vendor              ".*"
        product             ".*"
        path_grouping_policy    multibus
        path_selector           "round-robin 0"
        path_checker            tur
        no_path_retry           5
    }
}

multipaths {
    # Explicitly map WWIDs to friendly names for known LUNs
    multipath {
        wwid                3600000000000000000000000000000001
        alias               prod-data-01
        path_grouping_policy    multibus
        path_selector           "round-robin 0"
        no_path_retry           5
        rr_min_io               100
    }
    multipath {
        wwid                3600000000000000000000000000000002
        alias               prod-log-01
        path_grouping_policy    multibus
    }
}
```

### Verify Multipath Configuration

```bash
# Show all multipath devices
multipath -ll

# Example output for a properly configured device:
# prod-data-01 (3600000000000000000000000000000001) dm-0 VENDOR,PRODUCT
# size=500G features='0' hwhandler='0' wp=rw
# |-+- policy='round-robin 0' prio=1 status=active
# | |- 3:0:0:0 sdb 8:16 active ready running
# | `- 4:0:0:0 sdc 8:32 active ready running
# `--+- policy='round-robin 0' prio=1 status=enabled
#   |- 3:0:1:0 sdd 8:48 active ready running
#   `- 4:0:1:0 sde 8:64 active ready running

# Check path status
multipath -v3 2>&1 | grep -E "status|fail|error"

# Validate paths are active
multipathd show paths
multipathd show maps

# Check for path failures
multipathd show topology
```

### Path Failure Recovery Testing

```bash
# Simulate path failure (pull a cable)
# Monitor recovery
watch -n 1 'multipath -ll'

# Force path check
multipathd reconfigure

# Re-add a failed path
iscsiadm --mode session --rescan

# Verify all paths are active after recovery
multipath -ll | grep "active"
```

## Setting Up the Linux-IO (LIO) Kernel Target

LIO is the Linux kernel's iSCSI target implementation, providing high-performance storage serving.

### Install targetcli

```bash
# RHEL/Rocky
dnf install -y targetcli

# Ubuntu
apt-get install -y targetcli-fb

# Start and enable
systemctl enable --now target
```

### Creating an iSCSI Target with targetcli

```bash
# Launch targetcli interactive shell
targetcli

# Or use non-interactive mode for automation:
targetcli /backstores/block create name=lun0_block dev=/dev/sdb
targetcli /backstores/block create name=lun1_block dev=/dev/sdc
targetcli /iscsi create iqn.2024-01.corp.example:storage-01
targetcli /iscsi/iqn.2024-01.corp.example:storage-01/tpg1/luns \
  create /backstores/block/lun0_block
targetcli /iscsi/iqn.2024-01.corp.example:storage-01/tpg1/luns \
  create /backstores/block/lun1_block
```

### Complete LIO Configuration Script

```bash
#!/bin/bash
# configure-lio-target.sh
# Configure Linux-IO iSCSI target with CHAP authentication

TARGET_IQN="iqn.2024-01.corp.example:storage-01"
INITIATOR_IQN="iqn.2024-01.corp.example:prod-web-01.san"
PORTAL_IP="10.0.10.100"
PORTAL_PORT="3260"

# Storage backends
DISK1="/dev/sdb"
DISK2="/dev/sdc"

# CHAP credentials
CHAP_USER="iscsi-prod-web-01"
CHAP_PASSWORD="S3cur3P@ssw0rdExample!"
MUTUAL_CHAP_USER="storage-target-01"
MUTUAL_CHAP_PASSWORD="T@rg3tSecr3tExample!"

echo "Configuring LIO iSCSI target..."

# Create block backstores
targetcli /backstores/block create \
  name=lun0 dev="${DISK1}" add_wwn=true

targetcli /backstores/block create \
  name=lun1 dev="${DISK2}" add_wwn=true

# Create iSCSI target
targetcli /iscsi create "${TARGET_IQN}"

# Configure the target portal group (TPG)
# Set authentication mode
targetcli /iscsi/${TARGET_IQN}/tpg1 set attribute \
  authentication=1 \
  demo_mode_write_protect=0 \
  generate_node_acls=0

# Add portal (listening IP:port)
targetcli /iscsi/${TARGET_IQN}/tpg1/portals \
  delete ip_address=0.0.0.0 ip_port=3260 2>/dev/null || true
targetcli /iscsi/${TARGET_IQN}/tpg1/portals \
  create ip_address="${PORTAL_IP}" ip_port="${PORTAL_PORT}"

# If serving on a second path for multipath:
# targetcli /iscsi/${TARGET_IQN}/tpg1/portals create 10.0.11.100 3260

# Add LUNs
targetcli /iscsi/${TARGET_IQN}/tpg1/luns \
  create /backstores/block/lun0
targetcli /iscsi/${TARGET_IQN}/tpg1/luns \
  create /backstores/block/lun1

# Create ACL for the initiator (restricts access to specific IQN)
targetcli /iscsi/${TARGET_IQN}/tpg1/acls \
  create "${INITIATOR_IQN}"

# Set CHAP credentials for this initiator
targetcli /iscsi/${TARGET_IQN}/tpg1/acls/${INITIATOR_IQN} \
  set auth userid="${CHAP_USER}" password="${CHAP_PASSWORD}"

# Mutual CHAP (target authenticates to initiator)
targetcli /iscsi/${TARGET_IQN}/tpg1/acls/${INITIATOR_IQN} \
  set auth mutual_userid="${MUTUAL_CHAP_USER}" \
  mutual_password="${MUTUAL_CHAP_PASSWORD}"

# Map LUNs to ACL
targetcli /iscsi/${TARGET_IQN}/tpg1/acls/${INITIATOR_IQN} \
  create mapped_lun=0 tpg_lun_or_lun=0 write_protect=false
targetcli /iscsi/${TARGET_IQN}/tpg1/acls/${INITIATOR_IQN} \
  create mapped_lun=1 tpg_lun_or_lun=1 write_protect=false

# Save configuration (persists across reboots)
targetcli saveconfig

echo "LIO target configuration complete"
echo "Target IQN: ${TARGET_IQN}"
echo "Portal: ${PORTAL_IP}:${PORTAL_PORT}"

# Verify configuration
targetcli ls
```

### LIO Performance Tuning

```bash
# Increase kernel target thread count
# /etc/target/fabric.conf is managed by targetcli, but kernel params can be tuned

# Adjust TCP socket buffer sizes for iSCSI
sysctl -w net.core.rmem_max=268435456
sysctl -w net.core.wmem_max=268435456

# Enable jumbo frames on iSCSI network interfaces
ip link set eth2 mtu 9000
ip link set eth3 mtu 9000

# Verify MTU settings persist (via /etc/network/interfaces or nmcli)
nmcli connection modify "iSCSI-Net-1" 802-3-ethernet.mtu 9000

# LIO-specific: tune io_timeout for flash storage
targetcli /iscsi/iqn.2024-01.corp.example:storage-01/tpg1 \
  set parameter DefaultTime2Retain=0 DefaultTime2Wait=2

# Set block size for 4K aligned storage
targetcli /backstores/block/lun0 set attribute block_size=4096
```

## NVMe over Fabrics (NVMe-oF)

NVMe-oF extends NVMe's low-latency protocol over network fabrics, offering significantly lower latency than iSCSI for flash storage workloads.

### Transport Options

- **NVMe/TCP**: Uses standard TCP/IP, easiest to deploy
- **NVMe/RDMA**: Uses RoCE or InfiniBand, lowest latency
- **NVMe/FC**: Uses Fibre Channel infrastructure

### NVMe/TCP Initiator Setup

```bash
# Install NVMe userspace tools
dnf install -y nvme-cli

# Load NVMe-TCP kernel module
modprobe nvme-tcp

# Persist module loading
echo "nvme-tcp" >> /etc/modules-load.d/nvme-tcp.conf

# Verify module is loaded
lsmod | grep nvme
```

### Discovering NVMe/TCP Subsystems

```bash
# Discover NVMe subsystems
nvme discover \
  --transport tcp \
  --traddr 10.0.20.100 \
  --trsvcid 4420

# Example output:
# Discovery Log Number of Records 2, Generation counter 5
# =====Discovery Log Entry 0======
# trtype:  tcp
# adrfam:  ipv4
# subtype: nvme subsystem
# treq:    not specified
# portid:  1
# trsvcid: 4420
# subnqn:  nqn.2024-01.corp.example:nvme-subsys-01
# traddr:  10.0.20.100
# sectype: none

# Connect to a subsystem
nvme connect \
  --transport tcp \
  --traddr 10.0.20.100 \
  --trsvcid 4420 \
  --nqn nqn.2024-01.corp.example:nvme-subsys-01 \
  --hostnqn nqn.2024-01.corp.example:prod-web-01 \
  --hostid $(cat /etc/machine-id)

# Verify connection
nvme list
nvme list-subsys

# Check NVMe device details
nvme id-ctrl /dev/nvme0
nvme id-ns /dev/nvme0n1
```

### NVMe/TCP with Authentication (NVMe-oF 1.1+)

```bash
# Generate host key for DH-HMAC-CHAP
nvme gen-hostsymkey \
  --nqn nqn.2024-01.corp.example:prod-web-01 \
  --hmac sha256

# Connect with authentication
nvme connect \
  --transport tcp \
  --traddr 10.0.20.100 \
  --trsvcid 4420 \
  --nqn nqn.2024-01.corp.example:nvme-subsys-01 \
  --hostnqn nqn.2024-01.corp.example:prod-web-01 \
  --dhchap-secret "DHHC-1:00:..." \
  --dhchap-ctrl-secret "DHHC-1:00:..."
```

### Setting Up NVMe/TCP Target with nvmet

```bash
# Load nvmet-tcp module
modprobe nvmet-tcp

# Create NVMe target subsystem
mkdir -p /sys/kernel/config/nvmet/subsystems/nqn.2024-01.corp.example:nvme-subsys-01

# Allow any host (restrict in production)
echo 1 > /sys/kernel/config/nvmet/subsystems/nqn.2024-01.corp.example:nvme-subsys-01/attr_allow_any_host

# Create namespace and map a block device
mkdir -p /sys/kernel/config/nvmet/subsystems/nqn.2024-01.corp.example:nvme-subsys-01/namespaces/1
echo /dev/sdd > /sys/kernel/config/nvmet/subsystems/nqn.2024-01.corp.example:nvme-subsys-01/namespaces/1/device_path
echo 1 > /sys/kernel/config/nvmet/subsystems/nqn.2024-01.corp.example:nvme-subsys-01/namespaces/1/enable

# Create port for TCP
mkdir -p /sys/kernel/config/nvmet/ports/1
echo ipv4 > /sys/kernel/config/nvmet/ports/1/addr_adrfam
echo tcp > /sys/kernel/config/nvmet/ports/1/addr_trtype
echo 4420 > /sys/kernel/config/nvmet/ports/1/addr_trsvcid
echo 10.0.20.100 > /sys/kernel/config/nvmet/ports/1/addr_traddr

# Link subsystem to port
ln -s /sys/kernel/config/nvmet/subsystems/nqn.2024-01.corp.example:nvme-subsys-01 \
  /sys/kernel/config/nvmet/ports/1/subsystems/nqn.2024-01.corp.example:nvme-subsys-01
```

### nvmetcli for Persistent NVMe Target Configuration

```bash
# Install nvmetcli
pip3 install nvmetcli

# Save current configuration
nvmetcli save /etc/nvmet/config.json

# Example config.json
cat /etc/nvmet/config.json
```

```json
{
  "subsystems": [
    {
      "nqn": "nqn.2024-01.corp.example:nvme-subsys-01",
      "attr": {
        "allow_any_host": "0"
      },
      "namespaces": [
        {
          "device": {
            "path": "/dev/sdd",
            "nguid": "00000000-0000-0000-0000-000000000001"
          },
          "enable": 1,
          "nsid": 1
        }
      ],
      "allowed_hosts": [
        {
          "nqn": "nqn.2024-01.corp.example:prod-web-01"
        }
      ]
    }
  ],
  "ports": [
    {
      "addr": {
        "adrfam": "ipv4",
        "traddr": "10.0.20.100",
        "treq": "not specified",
        "trsvcid": "4420",
        "trtype": "tcp"
      },
      "portid": 1,
      "subsystems": [
        "nqn.2024-01.corp.example:nvme-subsys-01"
      ],
      "referrals": []
    }
  ]
}
```

```bash
# Restore configuration at boot via systemd
cat > /etc/systemd/system/nvmet.service << 'EOF'
[Unit]
Description=NVMe Target Configuration
After=network.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/nvmetcli restore /etc/nvmet/config.json
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

systemctl enable nvmet
```

### NVMe Multipath (Native)

NVMe-oF supports native multipath without dm-multipath:

```bash
# Connect to multiple paths to the same subsystem
nvme connect \
  --transport tcp \
  --traddr 10.0.20.100 \
  --trsvcid 4420 \
  --nqn nqn.2024-01.corp.example:nvme-subsys-01 \
  --hostnqn nqn.2024-01.corp.example:prod-web-01

nvme connect \
  --transport tcp \
  --traddr 10.0.21.100 \
  --trsvcid 4420 \
  --nqn nqn.2024-01.corp.example:nvme-subsys-01 \
  --hostnqn nqn.2024-01.corp.example:prod-web-01

# Check native multipath
nvme list-subsys
# Output shows both paths under same controller

# Monitor path status
nvme list-subsys -o json | python3 -c "
import sys, json
data = json.load(sys.stdin)
for subsys in data.get('Subsystems', []):
    print(f\"Subsystem: {subsys['NQN']}\")
    for ctrl in subsys.get('Controllers', []):
        print(f\"  Controller: {ctrl['Controller']} State: {ctrl['State']}\")
        for path in ctrl.get('Paths', []):
            print(f\"    Path: {path['Name']} State: {path['ANAState']}\")
"
```

## Udev Rules for Consistent Device Naming

```bash
# /etc/udev/rules.d/99-iscsi-naming.rules
# Create consistent symlinks for iSCSI devices

# Rule for iSCSI disks - creates /dev/iscsi/prod-data-01
ACTION=="add|change", SUBSYSTEM=="block", \
  ENV{ID_PATH}=="ip-10.0.10.100:3260-iscsi-iqn.2024-01.corp.example:storage-01.lun0-lun-0", \
  SYMLINK+="iscsi/prod-data-01"

# For multipath devices
ACTION=="add|change", SUBSYSTEM=="block", KERNEL=="dm-*", \
  ENV{DM_NAME}=="prod-data-01", \
  SYMLINK+="storage/prod-data-01"
```

```bash
# Reload udev rules
udevadm control --reload-rules
udevadm trigger --subsystem-match=block
```

## Monitoring iSCSI and NVMe Sessions

### iSCSI Session Monitoring

```bash
#!/bin/bash
# monitor-iscsi-sessions.sh

echo "=== iSCSI Session Status ==="
iscsiadm --mode session 2>/dev/null | while read line; do
    echo "  Session: ${line}"
done

echo ""
echo "=== iSCSI Error Counters ==="
iscsiadm --mode session --print 3 2>/dev/null | \
  grep -E "(State|Iface|Portal|Node|Stats|abort|error|timeout)" | \
  head -40

echo ""
echo "=== Multipath Status ==="
multipathd show paths format "%n %d %D %t %i %o %T %a %p %s" | column -t

echo ""
echo "=== Path Statistics ==="
multipathd show maps stats

echo ""
echo "=== NVMe Subsystems ==="
nvme list-subsys 2>/dev/null

echo ""
echo "=== NVMe Device Queue Depth ==="
for dev in /sys/class/nvme/nvme*/nvme*n*/queue; do
    dev_name=$(echo $dev | cut -d/ -f6,7)
    qdepth=$(cat $dev/nr_requests 2>/dev/null)
    echo "  ${dev_name}: queue_depth=${qdepth}"
done
```

### Prometheus Metrics via node_exporter

```bash
# node_exporter exposes disk I/O metrics for multipath devices
# Key metrics:
# node_disk_reads_completed_total{device="dm-0"}
# node_disk_writes_completed_total{device="dm-0"}
# node_disk_io_time_seconds_total{device="dm-0"}
# node_disk_read_bytes_total{device="dm-0"}

# Custom metric collection for iSCSI session state
cat > /usr/local/bin/iscsi-metrics.py << 'PYEOF'
#!/usr/bin/env python3
"""Expose iSCSI session metrics in Prometheus format."""

import subprocess
import re
import time

def get_iscsi_sessions():
    result = subprocess.run(
        ["iscsiadm", "--mode", "session", "--print", "3"],
        capture_output=True, text=True
    )
    return result.stdout

def parse_sessions(output):
    sessions = []
    current = {}

    for line in output.splitlines():
        if line.startswith("tcp:"):
            if current:
                sessions.append(current)
            match = re.match(r'tcp: \[(\d+)\] (\S+) (\S+) ', line)
            if match:
                current = {
                    "session_id": match.group(1),
                    "portal": match.group(2),
                    "target": match.group(3),
                    "state": "unknown",
                    "iface": "default"
                }
        elif "State:" in line and current:
            current["state"] = line.split(":")[1].strip()

    if current:
        sessions.append(current)
    return sessions

def main():
    while True:
        sessions = parse_sessions(get_iscsi_sessions())

        print("# HELP iscsi_session_up iSCSI session state (1=connected, 0=disconnected)")
        print("# TYPE iscsi_session_up gauge")

        for sess in sessions:
            state_val = 1 if sess["state"] == "LOGGED IN" else 0
            print(f'iscsi_session_up{{session_id="{sess["session_id"]}",portal="{sess["portal"]}",target="{sess["target"]}"}} {state_val}')

        time.sleep(30)

if __name__ == "__main__":
    main()
PYEOF
chmod +x /usr/local/bin/iscsi-metrics.py
```

## Performance Benchmarking

```bash
# Benchmark iSCSI LUN performance via multipath device
fio --filename=/dev/mapper/prod-data-01 \
  --rw=randrw \
  --bs=4k \
  --numjobs=8 \
  --iodepth=64 \
  --time_based \
  --runtime=60 \
  --name=iscsi-benchmark \
  --output-format=json | \
  python3 -c "
import sys, json
data = json.load(sys.stdin)
jobs = data['jobs']
read_iops = sum(j['read']['iops'] for j in jobs)
write_iops = sum(j['write']['iops'] for j in jobs)
read_lat = data['jobs'][0]['read']['lat_ns']['mean'] / 1000  # microseconds
write_lat = data['jobs'][0]['write']['lat_ns']['mean'] / 1000
print(f'Read IOPS: {read_iops:.0f}')
print(f'Write IOPS: {write_iops:.0f}')
print(f'Read latency: {read_lat:.1f} us')
print(f'Write latency: {write_lat:.1f} us')
"

# Compare NVMe/TCP performance
fio --filename=/dev/nvme0n1 \
  --rw=randrw \
  --bs=4k \
  --numjobs=8 \
  --iodepth=64 \
  --time_based \
  --runtime=60 \
  --name=nvme-tcp-benchmark \
  --output-format=json > /tmp/nvme-tcp-results.json
```

## Conclusion

iSCSI with properly configured multipath I/O and CHAP authentication provides enterprise-grade block storage over standard Ethernet at minimal infrastructure cost. The Linux-IO kernel target offers a robust, high-performance serving capability built into the kernel. For modern flash storage deployments where microsecond latency matters, NVMe-oF — particularly NVMe/TCP — provides a compelling upgrade path that reuses existing Ethernet infrastructure while delivering near-PCIe NVMe performance characteristics. The migration from iSCSI to NVMe/TCP is relatively straightforward since both run over standard TCP networking.
