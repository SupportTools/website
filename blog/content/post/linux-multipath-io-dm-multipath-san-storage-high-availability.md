---
title: "Linux Multipath I/O: DM-Multipath for SAN Storage High Availability"
date: 2031-04-22T00:00:00-05:00
draft: false
tags: ["Linux", "Storage", "SAN", "Multipath", "High Availability", "Kubernetes"]
categories:
- Linux
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete enterprise guide to Linux DM-Multipath configuration for SAN high availability: path grouping policies, path checkers, persistent WWID naming, vendor-specific configurations, and integrating multipath volumes with Kubernetes persistent volumes."
more_link: "yes"
url: "/linux-multipath-io-dm-multipath-san-storage-high-availability/"
---

When a SAN LUN is presented to a Linux host through multiple HBAs, switches, and storage controllers, you get multiple device paths — each representing the same underlying block device. Without multipath I/O management, the kernel treats each path as an independent device, creating the risk of split-brain I/O, data corruption, and failure to survive path outages. The device-mapper multipath framework (dm-multipath) unifies these paths into a single virtual device, implements automatic failover, and can distribute I/O across multiple active paths for improved throughput.

This guide covers every aspect of production DM-Multipath configuration: the architecture of the path discovery and monitoring daemons, path grouping and selection policies, path health checkers, persistent device naming with WWIDs, vendor-specific tuning for common enterprise arrays, and the configuration patterns required to safely use multipath volumes as Kubernetes persistent volumes.

<!--more-->

# Linux Multipath I/O: DM-Multipath for SAN Storage High Availability

## Section 1: DM-Multipath Architecture

### Components

The Linux multipath subsystem consists of several interacting components:

**multipathd** — the user-space daemon that monitors path state changes (link up/down events, I/O errors), manages path group failover, and maintains the device-mapper multipath devices. It communicates with the kernel via the device-mapper ioctl interface.

**multipath** — the command-line tool that creates and removes multipath devices, queries device status, and flushes device maps.

**device-mapper** — the kernel framework that creates virtual block devices and routes I/O to underlying paths according to multipath table rules.

**kpartx** — creates partition device maps for multipath devices that contain partition tables.

### How Path Discovery Works

1. The kernel's SCSI layer and HBA drivers discover physical paths (e.g., `/dev/sdb`, `/dev/sdc`) through the storage fabric.
2. `multipathd` detects these new block devices via udev events.
3. `multipathd` queries each device's World Wide Identifier (WWID) using the `sg_inq` (SCSI Inquiry) or similar command.
4. Devices with the same WWID are grouped into a multipath device (e.g., `/dev/mapper/mpatha`).
5. The daemon continuously monitors all paths using the configured path checker.

### Path States

- **active** — the path is healthy and passing I/O.
- **faulty** — the path checker has determined the path is unhealthy.
- **shaky** — the path is unreliable (transitional state).
- **ghost** — the path is ghost/standby (Active-Passive arrays only — the path is accessible but not preferred).
- **dmstate: active** — device-mapper is routing I/O to this path.
- **dmstate: enabled** — path is available but not currently selected for I/O.

## Section 2: Installation and Initial Configuration

### Installing the Packages

```bash
# RHEL/CentOS/Rocky Linux
dnf install -y device-mapper-multipath device-mapper-multipath-libs sg3_utils

# Ubuntu/Debian
apt-get install -y multipath-tools multipath-tools-boot sg3-utils

# Verify installation
rpm -qa | grep multipath  # RHEL-based
dpkg -l | grep multipath  # Debian-based
```

### Generating the Initial Configuration

```bash
# Generate a basic multipath.conf from detected hardware
mpathconf --enable --with_multipathd y --user_friendly_names y

# This creates /etc/multipath.conf with:
# - defaults section with user_friendly_names yes
# - blacklist section
# - multipaths section (empty, device-specific overrides go here)
```

### Starting and Enabling the Daemon

```bash
systemctl enable --now multipathd

# Verify it is running
systemctl status multipathd

# Check discovered multipath devices
multipath -ll
```

## Section 3: The multipath.conf Configuration File

A well-structured `/etc/multipath.conf` for a production environment:

```
# /etc/multipath.conf
# Support Tools Enterprise Multipath Configuration
# Last updated: 2031-04-22

defaults {
    # Use user-friendly names (/dev/mapper/mpatha, mpathb, etc.)
    # instead of WWIDs (/dev/mapper/3600507680c82004cf800000000000001)
    user_friendly_names     yes

    # Default path grouping policy
    # failover: one path per path group (most conservative)
    # multibus: all paths in one group (round-robin across all)
    # group_by_serial: group by target serial
    # group_by_prio: group by priority assigned by prio_callout
    # group_by_node_name: group by target node name
    path_grouping_policy    group_by_prio

    # Path checker — how to test if a path is alive
    # tur: Test Unit Ready SCSI command (universal, default)
    # rdac: specific to LSI/NetApp RDAC arrays
    # emc_clariion: specific to EMC CLARiiON/VNX
    # hp_sw: HP StorageWorks specific
    # directio: test with direct I/O
    # none: no checking (not recommended for production)
    path_checker            tur

    # Priority calculator — assigns priorities to paths
    # const: all paths get equal priority
    # emc: EMC-specific
    # alua: SCSI ALUA (Asymmetric Logical Unit Access) - preferred for modern arrays
    # ontap: NetApp ONTAP specific
    # rdac: LSI RDAC specific
    # hp_sw: HP StorageWorks specific
    prio                    alua

    # Failback policy
    # immediate: revert to preferred paths as soon as they become available
    # followover: only failback when the last path in the group fails
    # manual: never automatically failback (admin must trigger)
    # <integer>: failback after this many seconds
    failback                immediate

    # Polling interval for path checker in seconds
    polling_interval        5

    # Maximum number of retries before marking a path faulty
    max_fds                 8192

    # WWID format: scsi_id output
    getuid_callout          "/lib/udev/scsi_id --whitelisted --device=/dev/%n"

    # Rounding algorithm for I/O distribution
    # round-robin: distribute I/O evenly
    # queue-length: select path with fewest outstanding requests
    # service-time: select path with lowest service time estimate
    rr_min_io               100
    rr_weight               priorities

    # No path retry policy
    # fail: return I/O errors immediately when no paths are available
    # queue: queue I/O indefinitely until a path comes back
    # <integer>: queue I/O for this many retries before failing
    no_path_retry           queue

    # Time to wait for path recovery before queuing I/O (seconds)
    queue_without_daemon    no

    # Flush stale maps on restart
    flush_on_last_del       yes

    # Fast I/O failure for path detection
    fast_io_fail_tmo        5

    # SCSI device timeout for dev_loss_tmo
    dev_loss_tmo            30

    # Features for the device-mapper target
    # 1 queue_if_no_path: queue I/O when no paths are active
    # 0: disables this feature
    features                "1 queue_if_no_path"

    # Hardware handler
    # 0: none
    # 1 emc: EMC
    # 1 rdac: LSI RDAC
    # 1 alua: ALUA standard
    hardware_handler        "1 alua"
}

# Blacklist devices that should NOT be managed by multipath
# This is critical — without a blacklist, multipath may try to manage
# local disks, SSDs, USB drives, etc.
blacklist {
    # Blacklist by device name pattern
    devnode "^sda"          # Root disk (adjust for your root device)
    devnode "^sdb"          # Adjust if sdb is a local disk
    devnode "^nvme[0-9]+"   # NVMe local SSDs
    devnode "^hd[a-z]"      # Legacy IDE drives
    devnode "^vd[a-z]"      # Virtio virtual disks
    devnode "^xvd[a-z]"     # Xen virtual disks
    devnode "^dm-[0-9]+"    # Already managed dm devices
    devnode "^loop[0-9]+"   # Loop devices
    devnode "^fd[0-9]+"     # Floppy devices
    devnode "^md[0-9]+"     # Software RAID

    # Blacklist by WWID (specific devices to exclude)
    # wwid  "3600000000000000"

    # Blacklist by device type - exclude all except disk (0x00)
    # device {
    #     vendor  ".*"
    #     product ".*"
    # }
}

# Whitelist exceptions to the blacklist
blacklist_exceptions {
    # Allow SAN LUNs even if they match a blacklist pattern
    # property "ID_WWN"    # Uncomment to allow WWN-identified devices
}

# Vendor-specific device configurations
devices {
    # --- Pure Storage FlashArray ---
    device {
        vendor                  "PURE"
        product                 "FlashArray"
        path_grouping_policy    group_by_prio
        prio                    alua
        path_checker            tur
        hardware_handler        "1 alua"
        failback                immediate
        fast_io_fail_tmo        10
        dev_loss_tmo            600
        no_path_retry           10
        rr_min_io_rq            1
    }

    # --- NetApp ONTAP (FCP) ---
    device {
        vendor                  "NETAPP"
        product                 "LUN.*"
        path_grouping_policy    group_by_prio
        prio                    ontap
        path_checker            tur
        hardware_handler        "0"
        failback                immediate
        rr_weight               uniform
        no_path_retry           queue
        rr_min_io               128
        dev_loss_tmo            infinity
        fast_io_fail_tmo        45
        features                "1 queue_if_no_path"
    }

    # --- IBM Storwize / SVC ---
    device {
        vendor                  "IBM"
        product                 "2145"
        path_grouping_policy    group_by_prio
        prio                    alua
        path_checker            tur
        hardware_handler        "1 alua"
        failback                immediate
        no_path_retry           5
    }

    # --- EMC VMAX / PowerMax ---
    device {
        vendor                  "EMC"
        product                 "SYMMETRIX"
        path_grouping_policy    multibus
        getuid_callout          "/lib/udev/scsi_id --page=0x83 --whitelisted --device=/dev/%n"
        prio                    const
        path_checker            tur
        hardware_handler        "0"
        failback                manual
        rr_weight               uniform
        no_path_retry           6
    }

    # --- HPE 3PAR / Primera ---
    device {
        vendor                  "3PARdata"
        product                 "VV"
        path_grouping_policy    group_by_prio
        prio                    alua
        path_checker            tur
        hardware_handler        "1 alua"
        failback                immediate
        no_path_retry           18
        fast_io_fail_tmo        10
        dev_loss_tmo            600
    }
}

# Specific multipath device overrides
# (WWIDs are environment-specific — replace with your actual WWIDs)
multipaths {
    # Example: database LUN with specific settings
    multipath {
        wwid                "360000000000000000000000000000001"
        alias               "db-data-lun01"
        path_grouping_policy group_by_prio
        prio                alua
        failback            immediate
        no_path_retry       queue
    }

    # Example: backup LUN — no queuing needed
    multipath {
        wwid                "360000000000000000000000000000002"
        alias               "backup-lun01"
        path_grouping_policy multibus
        no_path_retry       fail
    }
}
```

## Section 4: Path Grouping Policies

### failover

Each physical path gets its own path group. Only one path is active at a time. The highest-priority group is used; if all paths in that group fail, the next group is tried.

Use case: Active-Passive storage arrays where only one path should carry I/O at a time to avoid write conflicts.

```
path_grouping_policy    failover

# Results in:
# group 1 (active): sdb  [priority 100]
# group 2 (enabled): sdc [priority 100]
# group 3 (enabled): sdd [priority 100]
# group 4 (enabled): sde [priority 100]
```

### multibus

All paths are placed in a single group. I/O is distributed across all active paths using the configured selector (round-robin by default).

Use case: Active-Active storage arrays, local JBOD with multiple controllers.

```
path_grouping_policy    multibus

# Results in:
# group 1 (active): sdb sdc sdd sde [all priority 50]
```

### group_by_prio

Paths are grouped by their priority value. All paths with the same priority go into the same group. The highest-priority group is used; lower-priority groups serve as failover.

Use case: ALUA-capable arrays where some paths are "optimized" (high priority) and others are "non-optimized" (low priority).

```
path_grouping_policy    group_by_prio
prio                    alua

# For an ALUA array with 2 active-optimized and 2 active-non-optimized paths:
# group 1 (active):  sdb sdc [ALUA state: Active/Optimized, priority 50]
# group 2 (enabled): sdd sde [ALUA state: Active/Non-Optimized, priority 10]
```

### group_by_serial

Paths are grouped by target port serial number. Useful for arrays with multiple active controllers where each controller has distinct serial numbers.

```
path_grouping_policy    group_by_serial

# Results in:
# group 1 (active):  sdb sdd [Controller A]
# group 2 (enabled): sdc sde [Controller B]
```

## Section 5: Path Checkers

### tur (Test Unit Ready)

The default and most portable path checker. Sends a `TEST UNIT READY` SCSI command to verify the path is responsive:

```bash
# Verify tur works on a specific device
sg_turs -vv /dev/sdb
```

`tur` is appropriate for most arrays but does not detect "ghost" paths on Active-Passive arrays — it will report a standby port as healthy.

### rdac (LSI/NetApp RDAC)

Used with LSI Logic RDAC and NetApp arrays that use the RDAC (Redundant Disk Array Controller) protocol. This checker understands the RDAC command set and can distinguish owned (active) versus non-owned (passive) paths:

```
device {
    vendor      "LSI"
    product     "INF-01-00"
    path_checker rdac
    prio        rdac
    hardware_handler "1 rdac"
}
```

### emc_clariion

Used with older EMC CLARiiON and VNX arrays. Uses a proprietary EMC inquiry command to determine path state:

```
device {
    vendor      "DGC"
    product     ".*"
    path_checker emc_clariion
    prio        emc
    hardware_handler "1 emc"
    features    "1 queue_if_no_path"
}
```

### directio

Tests path health by performing a direct read I/O operation. More expensive than `tur` but works on arrays that do not respond correctly to SCSI inquiry commands:

```
path_checker    directio
checker_timeout 60
```

## Section 6: Priority Callouts (prio)

### alua

Reads the SCSI ALUA (Asymmetric Logical Unit Access) target port group state. Active/Optimized paths get priority 50, Active/Non-Optimized paths get priority 10, Standby paths get priority 1:

```bash
# Check ALUA state of a device
sg_rtpg -vv /dev/sdb

# Show ALUA target port groups
sg_tpgs /dev/sdb
```

Expected output showing ALUA states:

```
  target port group descriptor, relative target port id 0x1
    preference indication: primary storage controller
    ASYMMETRIC ACCESS STATE is implicit and/or explicit changeable
    target port asymmetric access state: Active/optimized
    T10 vendor id: PURE
    target port descriptor list:
      Relative target port id: 0x1
```

### ontap

NetApp ONTAP-specific priority calculator. Uses ONTAP-specific SCSI commands to determine path optimization:

```
device {
    vendor          "NETAPP"
    product         "LUN.*"
    prio            ontap
    path_checker    tur
    hardware_handler "0"
}
```

### const

All paths receive the same priority (50). Use with `multibus` for true active-active round-robin:

```
path_grouping_policy    multibus
prio                    const
```

## Section 7: Persistent Device Naming with WWIDs

### Why WWIDs Matter

Device names like `/dev/sdb` are ephemeral — they change based on discovery order at boot. WWIDs are derived from the device's SCSI serial number and are globally unique and persistent across reboots and path changes.

### Discovering WWIDs

```bash
# Get the WWID of a specific block device
/lib/udev/scsi_id --whitelisted --page=0x83 --device=/dev/sdb

# List all multipath devices with their WWIDs
multipath -l

# Example output
mpatha (360000000000000000000000000000001) dm-0 PURE,FlashArray
size=1000G features='1 queue_if_no_path' hwhandler='1 alua' wp=rw
|-+- policy='service-time 0' prio=50 status=active
| |- 3:0:0:1  sdb 8:16  active ready running
| `- 3:0:1:1  sdd 8:48  active ready running
`-+- policy='service-time 0' prio=10 status=enabled
  |- 4:0:0:1  sdc 8:32  active ready running
  `- 4:0:1:1  sde 8:64  active ready running

# Show device detail including WWID
multipath -ll mpatha
```

### Configuring Persistent Aliases

Map a WWID to a human-readable alias in `/etc/multipath.conf`:

```
multipaths {
    multipath {
        wwid    "360000000000000000000000000000001"
        alias   "db-primary-lun"
    }
    multipath {
        wwid    "360000000000000000000000000000002"
        alias   "db-replica-lun"
    }
    multipath {
        wwid    "360000000000000000000000000000003"
        alias   "app-data-lun"
    }
}
```

After adding aliases:

```bash
systemctl restart multipathd
# or reload without restart:
multipathd reconfigure
ls -la /dev/mapper/db-primary-lun
```

### The /etc/multipath/wwids File

`multipathd` maintains a record of all known WWIDs in `/etc/multipath/wwids`. This file is checked to determine whether a device should be managed by multipath:

```bash
cat /etc/multipath/wwids

# Output:
# Multipath wwids, Version : 1.0
# NOTE: This file is automatically maintained by the multipath program.
# You should not need to edit this file in normal circumstances.
#
# Valid WWIDs:
3600507680c82004cf800000000000001
3600507680c82004cf800000000000002
3600507680c82004cf800000000000003
```

To manually add a WWID to be managed:

```bash
multipath -a 360000000000000000000000000000004
```

## Section 8: Operational Commands

### Basic Status Commands

```bash
# Show multipath topology
multipath -ll

# Show only failed/faulty paths
multipath -ll | grep -E "failed|faulty"

# Show multipath device and path details
multipathd show maps
multipathd show paths
multipathd show topology

# Show daemon status
multipathd show daemon

# List multipath devices in block format
lsblk /dev/mapper/mpatha

# Show statistics for a multipath device
multipathd show maps stats
```

### Path Management

```bash
# Remove a specific path (e.g., before HBA maintenance)
multipathd del path sdb

# Re-add a path after maintenance
multipathd add path sdb

# Flush an unused multipath map
multipath -f mpatha

# Flush all unused maps
multipath -F

# Force reload of all maps
multipathd reconfigure

# Reset path checker counters
multipathd reset map mpatha
```

### Diagnostics

```bash
# Test if a device should be managed by multipath
multipath -t /dev/sdb

# Show the multipath table for a device (raw device-mapper)
dmsetup table /dev/mapper/mpatha

# Show device-mapper status
dmsetup status /dev/mapper/mpatha

# Check effective multipath.conf settings
multipath -t

# Show all configuration including defaults and vendor-specific settings
multipathd show config

# Check for configuration errors
multipathd show config diff

# Verbose path check output
multipathd show paths format "%w %i %d %D %p %t %T %s %o %C"
```

### Monitoring Queue Depth and I/O Distribution

```bash
# Show I/O statistics per path
iostat -x 1 /dev/sdb /dev/sdc /dev/sdd /dev/sde

# Show which paths are actually receiving I/O
multipathd show maps format "%n %g %T %s"

# Use device-mapper stats
dmsetup stats /dev/mapper/mpatha
dmsetup stats create /dev/mapper/mpatha
```

## Section 9: Tuning for Specific SAN Environments

### Pure Storage FlashArray Tuning

Pure Storage FlashArray is Active-Active with ALUA. All paths are active/optimized by default:

```
devices {
    device {
        vendor                  "PURE"
        product                 "FlashArray"
        path_grouping_policy    group_by_prio
        prio                    alua
        path_checker            tur
        hardware_handler        "1 alua"
        failback                immediate
        fast_io_fail_tmo        10
        dev_loss_tmo            600
        no_path_retry           10
        rr_min_io_rq            1
        rr_weight               uniform
        features                "0"
    }
}
```

For Pure Storage, also configure the HBA and host settings:

```bash
# Check Pure Storage recommended host settings
purecli host show --host $(hostname) --settings

# Set optimal queue depth for Pure Storage HBAs
for hba in /sys/class/scsi_host/host*/device/fc_host/host*/; do
    echo "64" > "${hba}../../queue_depth"
done
```

### NetApp ONTAP Tuning

ONTAP uses ALUA with direct (optimized) and indirect (non-optimized) paths based on LIF placement:

```
devices {
    device {
        vendor                  "NETAPP"
        product                 "LUN.*"
        path_grouping_policy    group_by_prio
        prio                    ontap
        path_checker            tur
        hardware_handler        "0"
        failback                immediate
        rr_weight               uniform
        no_path_retry           queue
        rr_min_io               128
        features                "2 pg_init_retries 50 queue_if_no_path"
        dev_loss_tmo            infinity
        fast_io_fail_tmo        45
    }
}
```

### iSCSI-Specific Tuning

For iSCSI targets, the path checker and timing need adjustment since network path failures look different than FC failures:

```bash
# Configure iSCSI session replacement timeout
iscsiadm -m node -o update -n node.session.timeo.replacement_timeout -v 120

# Configure iSCSI error recovery timeout
iscsiadm -m node -o update -n node.conn[0].timeo.login_timeout -v 30

# iSCSI-specific multipath settings
cat >> /etc/multipath.conf << 'EOF'
defaults {
    no_path_retry       queue
    queue_without_daemon no
    dev_loss_tmo        infinity
    fast_io_fail_tmo    25
    checker_timeout     60
}
EOF
```

## Section 10: Kubernetes Multipath PV Configuration

### The Problem with Multipath in Kubernetes

When Kubernetes nodes use SAN storage via multipath, the CSI driver and kubelet must interact with the multipath devices correctly. Without proper configuration:

- CSI drivers may access the raw path devices (`/dev/sdb`, `/dev/sdc`) instead of the multipath device (`/dev/mapper/mpatha`).
- Multiple pods or nodes may end up with conflicting device access.
- Node-level operations like `mkfs` may run on a raw path and corrupt the multipath device.

### Configuring the Kubelet for Multipath

```bash
# Ensure multipathd is running before kubelet starts
# In systemd, add a dependency
mkdir -p /etc/systemd/system/kubelet.service.d/
cat > /etc/systemd/system/kubelet.service.d/multipath.conf << 'EOF'
[Unit]
After=multipathd.service
Requires=multipathd.service
EOF

systemctl daemon-reload
```

### iSCSI CSI Driver with Multipath

For the iSCSI CSI driver (used with iSCSI-based SAN storage), configure multipath in the DaemonSet:

```yaml
# iscsi-csi-driver-multipath-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: iscsi-csi-multipath-config
  namespace: kube-system
data:
  multipath.conf: |
    defaults {
      user_friendly_names     yes
      path_grouping_policy    group_by_prio
      path_checker            tur
      prio                    alua
      hardware_handler        "1 alua"
      failback                immediate
      no_path_retry           queue
      fast_io_fail_tmo        5
      dev_loss_tmo            30
      features                "1 queue_if_no_path"
    }
    blacklist {
      devnode "^sda"
      devnode "^vd[a-z]"
      devnode "^xvd[a-z]"
      devnode "^nvme[0-9]+"
      devnode "^dm-[0-9]+"
    }
---
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: iscsi-node-setup
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: iscsi-node-setup
  template:
    metadata:
      labels:
        app: iscsi-node-setup
    spec:
      hostNetwork: true
      hostPID: true
      priorityClassName: system-node-critical
      tolerations:
      - operator: Exists
        effect: NoSchedule
      - operator: Exists
        effect: NoExecute
      initContainers:
      - name: configure-multipath
        image: alpine:3.19
        securityContext:
          privileged: true
        command:
        - /bin/sh
        - -c
        - |
          cp /config/multipath.conf /host/etc/multipath.conf
          echo "Multipath configuration applied"
        volumeMounts:
        - name: config
          mountPath: /config
        - name: host-etc
          mountPath: /host/etc
      containers:
      - name: multipathd-monitor
        image: alpine:3.19
        securityContext:
          privileged: true
        command:
        - /bin/sh
        - -c
        - |
          # Ensure multipathd is running on the host
          nsenter --mount=/proc/1/ns/mnt -- \
            systemctl is-active --quiet multipathd || \
            nsenter --mount=/proc/1/ns/mnt -- systemctl start multipathd
          # Keep container running
          while true; do
            sleep 60
            nsenter --mount=/proc/1/ns/mnt -- \
              systemctl is-active --quiet multipathd || \
              nsenter --mount=/proc/1/ns/mnt -- systemctl restart multipathd
          done
        volumeMounts:
        - name: host-proc
          mountPath: /proc
          readOnly: true
        - name: host-sys
          mountPath: /sys
      volumes:
      - name: config
        configMap:
          name: iscsi-csi-multipath-config
      - name: host-etc
        hostPath:
          path: /etc
      - name: host-proc
        hostPath:
          path: /proc
      - name: host-sys
        hostPath:
          path: /sys
```

### StorageClass for Multipath iSCSI

```yaml
# storageclass-iscsi-multipath.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: iscsi-multipath
provisioner: iscsi.csi.k8s.io
parameters:
  # iSCSI target portal IP:port
  targetPortal: "192.168.100.10:3260"
  # Additional portals for multipath (comma-separated)
  portals: "192.168.100.11:3260,192.168.101.10:3260,192.168.101.11:3260"
  iqn: "iqn.2031-01.com.storage:lun"
  # Enable multipath
  iscsiInterface: "default"
  discoveryCHAPAuth: "false"
  sessionCHAPAuth: "false"
  fsType: "ext4"
allowVolumeExpansion: true
reclaimPolicy: Retain
volumeBindingMode: WaitForFirstConsumer
```

### Verifying Multipath on Kubernetes Nodes

```bash
#!/bin/bash
# verify-multipath-k8s.sh - Run on each Kubernetes node

echo "=== Multipath Status ==="
multipath -ll

echo ""
echo "=== Paths per Device ==="
for dev in $(multipath -l | grep "^m" | awk '{print $1}'); do
    PATH_COUNT=$(multipath -ll "${dev}" | grep -c "active ready")
    echo "${dev}: ${PATH_COUNT} active paths"
done

echo ""
echo "=== Device Aliases ==="
ls -la /dev/mapper/ | grep -v "^total\|control"

echo ""
echo "=== PVs using multipath devices ==="
# Check which PVs are backed by multipath devices
pvs --noheadings -o pv_name | while read pv; do
    if echo "${pv}" | grep -q "mapper"; then
        echo "PV on multipath: ${pv}"
    fi
done

echo ""
echo "=== Faulty Paths ==="
multipath -ll | grep -E "faulty|failed" || echo "No faulty paths detected"
```

## Section 11: Troubleshooting

### Diagnosing "no paths available" Errors

```bash
# Check if multipathd is running
systemctl status multipathd

# Check multipathd journal for errors
journalctl -u multipathd -n 50 --no-pager

# Verify the device is visible to the OS
lsblk | grep sd

# Check if the WWID is in the multipath wwids file
multipath -l | grep -i wwid
cat /etc/multipath/wwids

# Force re-scan for new devices
echo "- - -" > /sys/class/scsi_host/host0/scan
echo "- - -" > /sys/class/scsi_host/host1/scan

# Reload multipath configuration
multipathd reconfigure

# Manually add the device
multipath /dev/sdb
multipath -v3 /dev/sdb  # Verbose output
```

### Diagnosing Path Flapping

Path flapping (paths cycling between active and faulty) causes I/O performance issues and can trigger unnecessary failovers:

```bash
# Monitor path state changes
watch -n 1 "multipath -ll | grep -E 'active|faulty|ghost'"

# Check the path checker timeout
multipathd show config | grep checker_timeout

# Check link errors on the HBA
for hba in /sys/class/fc_host/host*/; do
    echo "HBA: ${hba}"
    cat "${hba}link_failure_count"
    cat "${hba}loss_of_sync_count"
    cat "${hba}loss_of_signal_count"
done

# Increase path checker timeout to reduce false positives
# In multipath.conf defaults section:
# checker_timeout 60
# polling_interval 10
```

### Resolving Duplicate Device Maps

After system reconfiguration, stale device maps can cause conflicts:

```bash
# Show all device-mapper devices
dmsetup ls

# Remove stale/unused maps
multipath -F   # Flush all unused maps
dmsetup remove mpatha  # Force remove a specific map

# Rebuild all multipath maps from scratch
multipathd reconfigure

# If maps are still stuck
systemctl stop multipathd
multipath -F
systemctl start multipathd
```

### Checklist for New SAN LUN Addition

```bash
#!/bin/bash
# new-lun-checklist.sh

echo "1. Rescan HBAs for new targets"
for host in /sys/class/scsi_host/host*/; do
    echo "- - -" > "${host}scan"
    echo "Scanned: ${host}"
done

sleep 5

echo ""
echo "2. Check for new SCSI devices"
lsblk | grep "^sd"

echo ""
echo "3. Check if new device is managed by multipath"
multipath -v2
multipath -ll

echo ""
echo "4. Verify WWID is discovered"
for dev in /dev/sd*; do
    WWID=$(/lib/udev/scsi_id --whitelisted --page=0x83 --device="${dev}" 2>/dev/null)
    [ -n "${WWID}" ] && echo "${dev}: ${WWID}"
done

echo ""
echo "5. Add new WWIDs to management"
multipath

echo ""
echo "6. Final multipath status"
multipath -ll
```

DM-Multipath is a critical infrastructure component for any environment using shared SAN storage. Proper configuration — especially the blacklist to prevent local disk takeover, vendor-specific path checker and prio settings, and WWID-based persistent naming — is the difference between a reliable storage layer and one that creates mysterious I/O failures during HBA maintenance windows or controller failovers.
