---
title: "Linux High Availability: Pacemaker, Corosync, and DRBD"
date: 2029-10-27T00:00:00-05:00
draft: false
tags: ["Linux", "High Availability", "Pacemaker", "Corosync", "DRBD", "STONITH", "Clustering"]
categories: ["Linux", "High Availability"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to building Linux high availability clusters with Pacemaker, Corosync, and DRBD. Covers corosync ring configuration, pacemaker resource agents, STONITH fencing, DRBD replication modes, and split-brain prevention strategies."
more_link: "yes"
url: "/linux-high-availability-pacemaker-corosync-drbd/"
---

Linux high availability clustering with Pacemaker, Corosync, and DRBD has been the foundation of enterprise Linux HA for over a decade. While Kubernetes handles stateless workloads elegantly, there are still classes of problems—databases that cannot run in containers, legacy applications with strict licensing, bare-metal NFS servers, or SAP HANA deployments—where a traditional two-node or multi-node cluster is the right tool. This guide covers a production-grade setup from initial corosync ring configuration through DRBD replication modes and split-brain recovery.

<!--more-->

# Linux High Availability: Pacemaker, Corosync, and DRBD

## Section 1: Architecture Overview

A typical two-node HA cluster consists of three layers:

- **Corosync**: The messaging layer. Provides reliable ordered messaging between cluster nodes and tracks cluster membership. Uses the Totem Single Ring Protocol.
- **Pacemaker**: The resource management layer. Decides where resources should run, monitors their health, and moves them when nodes fail.
- **DRBD**: Distributed Replicated Block Device. Mirrors a block device across nodes over the network, providing synchronous or asynchronous replication.

```
Node 1 (Active)                    Node 2 (Standby)
+------------------+               +------------------+
|  Application     |               |  Application     |
|  (PostgreSQL)    |               |  (stopped)       |
+------------------+               +------------------+
|  Pacemaker       |               |  Pacemaker       |
|  Resource Agent  |               |  Resource Agent  |
+------------------+               +------------------+
|  Corosync        |<-- Heartbeat->|  Corosync        |
|  (ring0: eth1)   |               |  (ring0: eth1)   |
|  (ring1: eth2)   |               |  (ring1: eth2)   |
+------------------+               +------------------+
|  DRBD            |<-- Replication|  DRBD            |
|  /dev/drbd0      |               |  /dev/drbd0      |
+------------------+               +------------------+
|  /dev/sdb        |               |  /dev/sdb        |
+------------------+               +------------------+
```

### Hardware and Network Requirements

For a two-node cluster:
- Dedicated cluster interconnect NICs (separate from production traffic)
- At least one STONITH/fencing device (IPMI/iDRAC/ILO)
- Odd number of votes (use a quorum device for two-node clusters)
- For DRBD: 10GbE minimum for synchronous replication of busy databases

### Distribution Support

This guide targets RHEL 9 / Rocky Linux 9 and Ubuntu 22.04 LTS. Package names differ slightly:

```bash
# RHEL/Rocky
dnf install -y pacemaker pcs corosync fence-agents-all drbd90-utils kmod-drbd90

# Ubuntu
apt install -y pacemaker pcs corosync fence-agents drbd-utils
```

## Section 2: Corosync Configuration

### Ring Architecture

Corosync supports multiple rings (redundant network paths) to prevent false failovers due to a single NIC failure. Each ring should use a separate physical network interface.

```bash
# Generate the corosync auth key (run on one node, copy to others)
corosync-keygen
scp /etc/corosync/authkey node2:/etc/corosync/authkey
chmod 400 /etc/corosync/authkey
```

The corosync configuration file defines the cluster topology:

```conf
# /etc/corosync/corosync.conf

totem {
    version: 2
    cluster_name: prod-cluster-01

    # Cryptographic protection
    secauth: on
    crypto_hash: sha256
    crypto_cipher: aes256

    # Transport: udpu for unicast (recommended over multicast)
    transport: udpu

    # Ring 0: Primary cluster interconnect
    interface {
        ringnumber: 0
        bindnetaddr: 192.168.10.0
        mcastport: 5405
        ttl: 1
    }

    # Ring 1: Secondary cluster interconnect (redundancy)
    interface {
        ringnumber: 1
        bindnetaddr: 192.168.11.0
        mcastport: 5407
        ttl: 1
    }

    # Timing parameters (tune based on network latency)
    token: 3000          # ms before declaring a token lost
    token_retransmits_before_loss_const: 10
    join: 60             # ms to wait for join messages
    consensus: 3600      # ms to wait for consensus
    miss_count_const: 5

    # For faster failover in low-latency environments
    # token: 1000
    # consensus: 1200
}

nodelist {
    node {
        ring0_addr: 192.168.10.11
        ring1_addr: 192.168.11.11
        nodeid: 1
        name: node1
    }
    node {
        ring0_addr: 192.168.10.12
        ring1_addr: 192.168.11.12
        nodeid: 2
        name: node2
    }
}

quorum {
    provider: corosync_votequorum

    # For two-node clusters: prevents split-brain without a quorum device
    # two_node: 1

    # Better option: use a quorum device (external tie-breaker)
    # Requires corosync-qdevice package
    device {
        model: net
        net {
            algorithm: ffsplit
            host: 192.168.10.20  # Quorum device host
            port: 5403
        }
    }

    expected_votes: 3  # 2 nodes + 1 quorum device vote
}

logging {
    fileline: off
    to_stderr: no
    to_logfile: yes
    logfile: /var/log/cluster/corosync.log
    to_syslog: yes
    syslog_facility: daemon
    debug: off
    logger_subsys {
        subsys: QUORUM
        debug: off
    }
}
```

### Starting and Validating Corosync

```bash
# Start on both nodes
systemctl enable --now corosync

# Verify ring status
corosync-cfgtool -s
# Expected output:
# Printing ring status.
# Local node ID 1
# RING ID 0
#   id    = 192.168.10.11
#   status= ring 0 active with no faults
# RING ID 1
#   id    = 192.168.11.11
#   status= ring 1 active with no faults

# Check quorum
corosync-quorumtool -l
# Node 1: node1 (votes: 1)
# Node 2: node2 (votes: 1)
# Quorum device: (votes: 1)
# Total votes: 3, Quorum: 2

# View member list
corosync-cmapctl | grep members
```

### Ring Fault Simulation

Test ring redundancy before production:

```bash
# Simulate ring 0 failure on node1
ip link set eth1 down

# Check corosync adjusts to ring 1 only
corosync-cfgtool -s
# RING ID 0
#   status= Faulty -- Loss Of Multicast Connectivity

# Verify no failover occurred (ring 1 maintains quorum)
pcs status

# Restore
ip link set eth1 up
corosync-cfgtool -r  # Re-initialize redundant ring
```

## Section 3: Pacemaker Configuration

### Initial Cluster Setup with pcs

```bash
# Set the hacluster password (same on both nodes)
passwd hacluster

# Start pcsd
systemctl enable --now pcsd

# Authenticate nodes (from node1)
pcs host auth node1 node2 -u hacluster -p <password>

# Create the cluster
pcs cluster setup prod-cluster-01 node1 node2 --start

# Enable auto-start
pcs cluster enable --all
```

### Global Cluster Properties

```bash
# Disable STONITH initially (re-enable after configuring fencing)
pcs property set stonith-enabled=false

# No-quorum policy: what to do when quorum is lost
# "stop" is safest for most deployments
pcs property set no-quorum-policy=stop

# Migration threshold: how many failures before moving resource
pcs resource defaults migration-threshold=3

# Sticky resources: prefer to stay where they are
pcs resource defaults resource-stickiness=100

# Operation timeouts
pcs resource op defaults timeout=60s
```

### STONITH Fencing Configuration

Fencing is the most critical component of a cluster. Without reliable fencing, split-brain can cause data corruption. Never disable STONITH in production.

```bash
# IPMI fencing (most common for bare metal)
pcs stonith create fence-node1 fence_ipmilan \
    pcmk_host_list="node1" \
    ipaddr="192.168.1.101" \
    login="admin" \
    passwd="<ipmi-password>" \
    lanplus=1 \
    op monitor interval=60s

pcs stonith create fence-node2 fence_ipmilan \
    pcmk_host_list="node2" \
    ipaddr="192.168.1.102" \
    login="admin" \
    passwd="<ipmi-password>" \
    lanplus=1 \
    op monitor interval=60s

# Node 1's fence device should be on a different node
pcs constraint location fence-node1 prefers node2=INFINITY
pcs constraint location fence-node2 prefers node1=INFINITY

# Enable fencing
pcs property set stonith-enabled=true

# Test fencing (this will reboot node2!)
# pcs stonith fence node2
```

For VMware environments:

```bash
# vSphere fencing
pcs stonith create fence-node1 fence_vmware_rest \
    pcmk_host_list="node1" \
    ip="vcenter.example.com" \
    username="ha-svc@vsphere.local" \
    password="<password>" \
    ssl=1 \
    ssl_insecure=0 \
    pcmk_vm_name="node1-vm" \
    op monitor interval=60s
```

### Resource Agents

Pacemaker resource agents are scripts that implement `start`, `stop`, `monitor`, and optionally `promote`/`demote` operations.

A complete resource configuration for a PostgreSQL cluster:

```bash
# Virtual IP address (the floating IP clients connect to)
pcs resource create VirtualIP IPaddr2 \
    ip=192.168.1.100 \
    cidr_netmask=24 \
    nic=eth0 \
    op monitor interval=10s timeout=20s

# DRBD resource (see Section 4 for DRBD setup)
pcs resource create DRBD ocf:linbit:drbd \
    drbd_resource=r0 \
    op monitor interval=20s timeout=40s \
    op monitor interval=10s timeout=40s role=Master \
    op start timeout=240s \
    op stop timeout=120s \
    op promote timeout=120s \
    op demote timeout=120s

# Create Master/Slave (Primary/Secondary) set for DRBD
pcs resource promotable DRBD \
    promoted-max=1 \
    promoted-node-max=1 \
    clone-max=2 \
    clone-node-max=1 \
    notify=true

# Filesystem resource (mounts DRBD on the Primary)
pcs resource create Filesystem Filesystem \
    device=/dev/drbd0 \
    directory=/data \
    fstype=xfs \
    options="noatime,nodiratime" \
    op monitor interval=20s timeout=40s \
    op start timeout=60s \
    op stop timeout=60s

# PostgreSQL resource
pcs resource create PostgreSQL pgsql \
    pgctl="/usr/bin/pg_ctl" \
    pgdata="/data/postgresql" \
    start_opt="-p 5432" \
    rep_mode=none \
    op start timeout=120s \
    op stop timeout=120s \
    op monitor interval=10s timeout=30s

# Group resources that must run together
pcs resource group add pg-group VirtualIP Filesystem PostgreSQL

# Ordering constraints: DRBD must be Primary before Filesystem mounts
pcs constraint order promote DRBD-clone then start pg-group

# Colocation: pg-group must run where DRBD-clone is Master
pcs constraint colocation add pg-group with Master DRBD-clone INFINITY
```

### Resource Monitoring and Operations

```bash
# View cluster status
pcs status
# Expected output:
# Cluster name: prod-cluster-01
# Stack: corosync
# Current DC: node1 (version 2.1.x) - partition with quorum
# Last updated: Mon Jan  1 00:00:00 2029
# 2 nodes configured
# 4 resource instances configured
#
# Node List:
#   * Online: [ node1 node2 ]
#
# Full List of Resources:
#   * DRBD-clone (ocf::linbit:drbd):   Promoted node1; Unpromoted node2
#   * Resource Group: pg-group:
#     * VirtualIP   (ocf::heartbeat:IPaddr2):    Started node1
#     * Filesystem  (ocf::heartbeat:Filesystem): Started node1
#     * PostgreSQL  (ocf::heartbeat:pgsql):      Started node1

# Move a resource manually
pcs resource move pg-group node2

# Clear move constraint (allow failback)
pcs resource clear pg-group

# Simulate a failure
pcs resource ban pg-group node1

# View constraints
pcs constraint list --full

# Resource cleanup (reset failure count)
pcs resource cleanup PostgreSQL
```

## Section 4: DRBD Configuration

### DRBD Resource Definition

DRBD 9.x supports multiple volumes per resource and more than two nodes.

```conf
# /etc/drbd.d/r0.res
resource r0 {
    # Protocol C: Synchronous replication
    # Write acknowledged only after written to both nodes
    # Safest for databases; use Protocol A for async DR
    protocol C;

    disk {
        # Auto-detect disk type and optimize accordingly
        disk-flushes yes;
        disk-barrier yes;
        md-flushes yes;

        # For SSDs (disable for HDDs)
        # disk-flushes no;
        # disk-barrier no;

        # Number of activity log extents (affects resync speed)
        # 1MB AL, higher for write-heavy workloads
        al-extents 1237;

        # I/O errors: do not detach (let fencing handle it)
        on-io-error pass_on;

        # Resynchronization bandwidth limit
        resync-rate 500M;
        c-plan-ahead 5;
        c-delay-target 10;
        c-fill-target 100;
        c-max-rate 4G;
        c-min-rate 250M;
    }

    net {
        # TLS between nodes
        # tls yes;  # Requires DRBD 9.1+

        # Socket buffer sizes (tune for high-bandwidth links)
        sndbuf-size 4M;
        rcvbuf-size 4M;

        # Timeout settings
        ping-int 10;        # Heartbeat interval
        ping-timeout 5;     # Timeout for heartbeat
        timeout 60;         # I/O timeout
        connect-int 10;     # Reconnect interval

        # Split-brain handling
        after-sb-0pri discard-younger-primary;
        after-sb-1pri discard-secondary;
        after-sb-2pri disconnect;

        # Verify algorithm for data integrity checks
        verify-alg sha256;

        # Compression for WAN replication
        # data-integrity-alg md5;
    }

    handlers {
        # Script called when split-brain is detected
        split-brain "/usr/lib/drbd/notify-split-brain.sh root";

        # Called when a node becomes Primary unexpectedly
        out-of-sync "/usr/lib/drbd/notify-out-of-sync.sh root";

        # Called on I/O error
        io-error "/usr/lib/drbd/notify-io-error.sh root";
    }

    startup {
        # Automatically promote to Primary if the other node is unavailable
        become-primary-on node1;

        # Wait for connection before becoming Primary
        wfc-timeout 30;
        degr-wfc-timeout 120;

        # On first start (or after long downtime), allow outdated data
        outdated-wfc-timeout 60;
    }

    on node1 {
        device /dev/drbd0 minor 0;
        disk /dev/sdb;
        address 192.168.10.11:7789;
        meta-disk internal;
    }

    on node2 {
        device /dev/drbd0 minor 0;
        disk /dev/sdb;
        address 192.168.10.12:7789;
        meta-disk internal;
    }
}
```

### DRBD Initialization

```bash
# Initialize metadata on both nodes (destroys existing data)
drbdadm create-md r0

# Start DRBD on both nodes
systemctl enable --now drbd
drbdadm up r0

# Initial sync: designate node1 as the source of truth
# Run on node1 only
drbdadm primary --force r0

# Monitor initial synchronization
watch -n2 cat /proc/drbd
# ...
#  0: cs:SyncSource ro:Primary/Secondary ds:UpToDate/Inconsistent C r-----
#      ns:2097152 nr:0 dw:0 dr:2162688 al:8 bm:0 lo:0 pe:0 ua:0 ap:0 ep:1 wo:b oos:524288
#      [=======>........] sync'ed: 50.2% (512/1024)M
#      finish: 0:00:25 speed: 20,480 (20,480) K/sec

# After sync completes (UpToDate/UpToDate):
mkfs.xfs /dev/drbd0
mkdir -p /data
mount /dev/drbd0 /data
```

### DRBD Replication Modes

DRBD supports three replication protocols with different consistency/performance trade-offs:

```
Protocol A (Asynchronous):
  - Write acknowledged after data is in local disk buffer
  - Lowest latency, highest performance
  - Risk: data loss if Primary fails before Secondary receives data
  - Use case: async DR across WAN, low-priority data

Protocol B (Memory Synchronous):
  - Write acknowledged after data is in Secondary's memory buffer
  - Moderate latency
  - Risk: data loss if both nodes fail simultaneously
  - Use case: LAN replication where WAN is too slow

Protocol C (Fully Synchronous):
  - Write acknowledged only after written to both nodes' disks
  - Highest latency, lowest throughput
  - No data loss (as long as disks work)
  - Use case: databases, financial data, anything requiring no data loss
```

Switch protocol at runtime (for testing):

```bash
# Switch to async (for bulk data loading)
drbdadm adjust r0  # After editing config to Protocol A

# Switch back to sync
drbdadm adjust r0  # After editing config to Protocol C

# Verify
drbdadm status r0
```

### DRBD Monitoring

```bash
# Detailed status
drbdadm status r0
# r0 role:Primary
#   disk:UpToDate
#   node2 role:Secondary
#     peer-disk:UpToDate

# Connection state
cat /proc/drbd
# version: 9.1.x (api:2/proto:86-121)
#  0: cs:Connected ro:Primary/Secondary ds:UpToDate/UpToDate C r-----
#      ns:0 nr:0 dw:1048576 dr:2097152 al:3 bm:0 lo:0 pe:0 ua:0 ap:0 ep:1 wo:d oos:0

# Performance statistics
drbdadm show-gi r0  # Generation identifiers

# Verify data consistency
drbdadm verify r0   # Background verification, non-disruptive
```

## Section 5: Split-Brain Prevention and Recovery

Split-brain occurs when both nodes believe they are Primary. This can happen if:
- The cluster network fails but both nodes continue serving clients
- STONITH fails and the cluster cannot fence the failed node
- A misconfiguration allows a node to become Primary without fencing the other

### Prevention Strategies

**1. Reliable Quorum**

Never operate a two-node cluster with `two_node: 1` in production. Always use a quorum device:

```bash
# Install quorum device on a third host (even a small VM)
# On the quorum device host:
dnf install -y corosync-qnetd
systemctl enable --now corosync-qnetd

# On cluster nodes:
dnf install -y corosync-qdevice
pcs quorum device add model net \
    host=192.168.10.20 \
    algorithm=ffsplit
```

**2. Redundant Fencing**

Configure multiple fencing methods that must both succeed (or fail) consistently:

```bash
# Primary fencing: IPMI
# Secondary fencing: shared power switch
pcs stonith create fence-node1-ipmi fence_ipmilan \
    pcmk_host_list="node1" \
    ipaddr="192.168.1.101" \
    login="admin" passwd="<password>" lanplus=1

pcs stonith create fence-node1-pdu fence_apc_snmp \
    pcmk_host_list="node1" \
    ipaddr="192.168.1.200" \
    login="apc" passwd="<password>" \
    port=1

# Configure fencing topology: try IPMI first, then PDU
pcs stonith level add 1 node1 fence-node1-ipmi
pcs stonith level add 2 node1 fence-node1-pdu
```

**3. DRBD Split-Brain Handler**

The `after-sb-*` configuration in DRBD determines automatic recovery behavior:

```conf
net {
    # If neither node is Primary: discard the node that lost most data
    after-sb-0pri discard-least-changes;

    # If one node is Primary: discard the Secondary's changes
    # (Primary's data is what clients wrote to)
    after-sb-1pri discard-secondary;

    # If both nodes are Primary: this should never happen with proper fencing
    # disconnect and alert immediately
    after-sb-2pri disconnect;
}
```

### Manual Split-Brain Recovery

When automatic recovery is not possible, manual recovery is required:

```bash
# Identify which node has the more recent data
# Check timestamps, application logs, transaction logs

# On the node that will be DISCARDED (losing data):
drbdadm secondary r0
drbdadm disconnect r0
drbdadm -- --discard-my-data connect r0

# On the node that will be KEPT (keeping data):
drbdadm connect r0

# DRBD will begin resynchronization, copying kept data to discarded node
watch -n2 cat /proc/drbd
```

### DRBD Consistency Verification

Schedule regular consistency checks to catch silent corruption:

```bash
#!/bin/bash
# /usr/local/bin/drbd-verify.sh
# Run weekly via cron

RESOURCE="r0"
LOG="/var/log/drbd-verify.log"

echo "$(date): Starting verification of $RESOURCE" >> "$LOG"

# Start online verification (non-disruptive)
drbdadm verify "$RESOURCE"

# Wait for verification to complete
while drbdadm status "$RESOURCE" | grep -q "resynced_percent"; do
    sleep 60
done

# Check for out-of-sync sectors
OOS=$(drbdadm status "$RESOURCE" | grep "out-of-sync" | awk '{print $2}')
if [ "$OOS" != "0" ]; then
    echo "$(date): WARNING: $OOS out-of-sync sectors detected!" >> "$LOG"
    # Send alert
    mail -s "DRBD Verification Failed: $OOS sectors out of sync" admin@example.com < /dev/null
else
    echo "$(date): Verification completed successfully" >> "$LOG"
fi
```

## Section 6: Automated Failover Testing

A cluster that has never been tested is a cluster that will fail when you need it most. Implement a regular failover testing schedule:

```bash
#!/bin/bash
# /usr/local/bin/cluster-failover-test.sh
# Run during maintenance windows to validate HA functionality

set -euo pipefail

NODE1="node1"
NODE2="node2"
VIRTUAL_IP="192.168.1.100"
LOG="/var/log/cluster-test.log"

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') $*" | tee -a "$LOG"
}

check_resource_running() {
    local resource="$1"
    local node="$2"
    pcs resource show "$resource" | grep -q "Started $node"
}

test_connectivity() {
    local ip="$1"
    ping -c 3 -W 2 "$ip" > /dev/null 2>&1
}

log "=== Starting Cluster Failover Test ==="

# Phase 1: Verify initial state
log "Verifying initial cluster state..."
if ! pcs status | grep -q "Current DC: $NODE1"; then
    log "ERROR: Expected $NODE1 as DC"
    exit 1
fi

# Phase 2: Record start time
START_TIME=$(date +%s)

# Phase 3: Simulate failure by putting node1 in standby
log "Putting $NODE1 into standby mode..."
pcs node standby "$NODE1"

# Phase 4: Wait for failover
log "Waiting for failover to complete..."
TIMEOUT=120
ELAPSED=0
while ! check_resource_running "VirtualIP" "$NODE2"; do
    sleep 2
    ELAPSED=$((ELAPSED + 2))
    if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
        log "ERROR: Failover timeout after ${TIMEOUT}s"
        pcs node unstandby "$NODE1"
        exit 1
    fi
done

FAILOVER_TIME=$(($(date +%s) - START_TIME))
log "Failover completed in ${FAILOVER_TIME}s"

# Phase 5: Verify virtual IP is accessible
if test_connectivity "$VIRTUAL_IP"; then
    log "Virtual IP is accessible on $NODE2"
else
    log "ERROR: Virtual IP not accessible after failover"
fi

# Phase 6: Restore node1
log "Restoring $NODE1 from standby..."
pcs node unstandby "$NODE1"

sleep 30  # Allow cluster to stabilize

# Phase 7: Verify DRBD sync
log "Checking DRBD sync status..."
DRBD_STATUS=$(drbdadm status r0 | grep "peer-disk" | awk '{print $2}')
if [ "$DRBD_STATUS" != "UpToDate" ]; then
    log "WARNING: DRBD not fully synced: $DRBD_STATUS"
fi

log "=== Failover Test Complete ==="
log "Total downtime: approximately ${FAILOVER_TIME}s"
```

## Section 7: Monitoring and Alerting

### Prometheus Integration

```bash
# Install cluster-glue for monitoring hooks
dnf install -y cluster-glue

# Use the pacemaker_exporter
dnf install -y prometheus-pacemaker-exporter
systemctl enable --now prometheus-pacemaker-exporter
```

Custom monitoring script for key cluster metrics:

```bash
#!/bin/bash
# /usr/local/bin/cluster-health-check.sh
# Used by monitoring systems

ISSUES=()

# Check corosync
if ! corosync-quorumtool -l 2>/dev/null | grep -q "Quorate: Yes"; then
    ISSUES+=("CRITICAL: Cluster has no quorum")
fi

# Check pacemaker
if ! pcs status 2>/dev/null | grep -q "partition with quorum"; then
    ISSUES+=("CRITICAL: Pacemaker reports no quorum")
fi

# Check for failed resources
FAILED=$(pcs status 2>/dev/null | grep -c "FAILED" || true)
if [ "$FAILED" -gt 0 ]; then
    ISSUES+=("WARNING: $FAILED failed resources")
fi

# Check DRBD
DRBD_CONNECTED=$(grep -c "cs:Connected" /proc/drbd || true)
DRBD_RESOURCES=$(grep -c "^[[:space:]]*[0-9]:" /proc/drbd || true)
if [ "$DRBD_CONNECTED" -lt "$DRBD_RESOURCES" ]; then
    ISSUES+=("CRITICAL: DRBD not fully connected ($DRBD_CONNECTED/$DRBD_RESOURCES)")
fi

# Check for out-of-sync data
DRBD_OOS=$(awk '/oos:/ {sum += $2} END {print sum}' /proc/drbd 2>/dev/null || echo 0)
if [ "$DRBD_OOS" -gt 0 ]; then
    ISSUES+=("WARNING: DRBD has ${DRBD_OOS} out-of-sync sectors")
fi

if [ ${#ISSUES[@]} -eq 0 ]; then
    echo "OK: Cluster is healthy"
    exit 0
else
    for issue in "${ISSUES[@]}"; do
        echo "$issue"
    done
    exit 2
fi
```

### Alertmanager Rules

```yaml
# prometheus/rules/cluster.yaml
groups:
  - name: ha_cluster
    rules:
      - alert: ClusterNoQuorum
        expr: corosync_quorum_quorate == 0
        for: 30s
        labels:
          severity: critical
        annotations:
          summary: "Cluster {{ $labels.cluster }} has lost quorum"

      - alert: PacemakerResourceFailed
        expr: pacemaker_resource_failed > 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Pacemaker resource failed on {{ $labels.instance }}"

      - alert: DRBDNotConnected
        expr: drbd_connected == 0
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "DRBD not connected on {{ $labels.instance }}"

      - alert: DRBDOutOfSync
        expr: drbd_oos_bytes > 0
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "DRBD has {{ $value }} bytes out of sync"
```

## Section 8: Common Troubleshooting Scenarios

### Node Cannot Join Cluster

```bash
# Check corosync authentication
journalctl -u corosync | grep -i "auth\|error"

# Verify authkey is identical on both nodes
md5sum /etc/corosync/authkey

# Check firewall
firewall-cmd --list-all
# Required ports:
# 5404, 5405/udp (corosync)
# 7789/tcp (DRBD)
# 2224/tcp (pcsd)
# 3121/tcp (pacemaker remote)

# Allow cluster traffic
firewall-cmd --permanent --add-service=high-availability
firewall-cmd --reload
```

### DRBD Stuck in WFConnection

```bash
# Check network between nodes
telnet node2 7789

# Check for conflicting DRBD configurations
drbdadm dump r0

# Check kernel module
lsmod | grep drbd
modprobe drbd  # If not loaded

# Restart DRBD
systemctl restart drbd
drbdadm up r0
```

### Resource Fails to Start After Failover

```bash
# View resource history
pcs resource history PostgreSQL

# Check resource agent logs
tail -100 /var/log/pacemaker/pacemaker.log | grep PostgreSQL

# Manual resource test
ocf-tester -n PostgreSQL -o pgdata=/data/postgresql pgsql monitor

# Reset failure count and try again
pcs resource cleanup PostgreSQL node2
pcs resource enable PostgreSQL
```

## Conclusion

A properly configured Pacemaker + Corosync + DRBD cluster provides enterprise-grade high availability for stateful Linux workloads. The key to reliability is in the details: redundant corosync rings prevent false failovers, reliable STONITH prevents data corruption from split-brain, and DRBD Protocol C guarantees no data loss.

The most important operational practice is regular failover testing. Test every quarter at minimum, and after any infrastructure change. A cluster configuration that has never been exercised under real failure conditions cannot be trusted.

Key takeaways:
- Never disable STONITH in production — data integrity depends on it
- Use a quorum device for two-node clusters instead of `two_node: 1`
- DRBD Protocol C is mandatory for databases; Protocols A/B only for non-critical data
- Monitor corosync ring health and DRBD out-of-sync bytes proactively
- Document and test your recovery procedures before you need them
