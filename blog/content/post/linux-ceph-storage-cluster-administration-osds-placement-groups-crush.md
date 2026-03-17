---
title: "Linux Ceph Storage Cluster Administration: OSDs, Placement Groups, CRUSH Maps, and Maintenance"
date: 2031-07-30T00:00:00-05:00
draft: false
tags: ["Ceph", "Linux", "Storage", "Distributed Systems", "CRUSH", "OSD", "Block Storage", "Object Storage"]
categories:
- Linux
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive operational guide to Ceph storage cluster administration covering OSD management, placement group tuning, CRUSH map customization, maintenance procedures, and troubleshooting production issues."
more_link: "yes"
url: "/linux-ceph-storage-cluster-administration-osds-placement-groups-crush-maps/"
---

Ceph powers the storage layer for some of the largest production environments in the world, yet it remains one of the technologies most likely to cause operational confusion when things go wrong. Its distributed architecture means that understanding a HEALTH_WARN or HEALTH_ERR requires knowing how OSDs, placement groups, CRUSH maps, and monitors interact. This guide is an operator's reference for maintaining, tuning, and recovering Ceph clusters in production — covering the procedures you actually need when you have a degraded cluster at 2 AM.

<!--more-->

# Linux Ceph Storage Cluster Administration: OSDs, Placement Groups, CRUSH Maps, and Maintenance

## Cluster Architecture Fundamentals

A Ceph cluster consists of several daemon types with distinct responsibilities:

- **MON (Monitor)**: Maintains the cluster map (OSD map, CRUSH map, PG map). Requires an odd number for quorum (3 or 5 in production). Does not store data.
- **MGR (Manager)**: Provides monitoring, metrics, and orchestration services. Runs alongside monitors.
- **OSD (Object Storage Daemon)**: Stores actual data. One OSD per physical disk. Handles replication, recovery, and scrubbing.
- **MDS (Metadata Server)**: Required only for CephFS. Manages file system metadata.
- **RGW (RADOS Gateway)**: Provides S3/Swift-compatible object storage API.

Data is distributed across OSDs using CRUSH (Controlled Replication Under Scalable Hashing), a deterministic algorithm that maps object names to OSD locations without a central lookup table.

## Cluster Health Assessment

Before touching anything, understand the cluster state completely.

```bash
# Overall cluster health
ceph status
# or equivalently:
ceph -s

# Sample healthy output:
#   cluster:
#     id:     f2a8c4d1-xxxx-xxxx-xxxx-xxxxxxxxxxxx
#     health: HEALTH_OK
#
#   services:
#     mon: 3 daemons, quorum ceph-mon1,ceph-mon2,ceph-mon3 (age 2w)
#     mgr: ceph-mgr1(active, since 2w), standbys: ceph-mgr2
#     osd: 48 osds: 48 up (since 2w), 48 in (since 2w)
#
#   data:
#     pools:   8 pools, 256 pgs
#     objects: 45.2M objects, 89.4TiB used
#     usage:   91.2TiB used, 287TiB / 378TiB avail
#     pgs:     256 active+clean

# Detailed health messages (shows all warnings and errors)
ceph health detail

# Watch health in real time (1-second refresh)
watch -n 1 ceph -s

# OSD utilization per OSD
ceph osd df tree

# Pool-level utilization
ceph df detail

# IO statistics (current operations)
ceph osd perf
```

## OSD Management

### Adding New OSDs

Modern Ceph deployments use cephadm for orchestration. Legacy deployments may use ceph-deploy or manual procedures.

```bash
# Using cephadm (Ceph Octopus/Pacific/Quincy)
# Add a specific disk on a specific host
ceph orch daemon add osd ceph-storage-node3:/dev/sdb

# Add all available disks on a host
ceph orch apply osd --all-available-devices

# Preview what would be added (dry run)
ceph orch apply osd --all-available-devices --dry-run

# List currently managed OSD services
ceph orch ls osd

# Check OSD daemon status
ceph orch ps --daemon-type osd
```

For manual OSD creation on physical hosts (older deployments):

```bash
# Prepare the disk (wipes partition table, creates Ceph LVM volumes)
ceph-volume lvm prepare --bluestore --data /dev/sdb

# Activate the prepared OSD
# Replace {osd-id} and {osd-fsid} with values from prepare output
ceph-volume lvm activate {osd-id} {osd-fsid}

# Verify the OSD is up and in
ceph osd tree | grep osd.{osd-id}

# Full creation in one step
ceph-volume lvm create --bluestore --data /dev/sdb
```

### Removing OSDs Safely

Never remove an OSD without first setting it out and waiting for rebalancing to complete.

```bash
# Step 1: Mark the OSD out (stops data from being assigned to it)
ceph osd out osd.42

# Step 2: Wait for rebalancing to complete
# This can take minutes to hours depending on data volume
watch -n 10 ceph -s
# Wait until: pgs: N active+clean (no degraded/remapped/recovering)

# Step 3: Stop the OSD daemon
systemctl stop ceph-osd@42
# or with cephadm:
ceph orch daemon stop osd.42

# Step 4: Remove from the CRUSH map
ceph osd crush remove osd.42

# Step 5: Remove authentication key
ceph auth del osd.42

# Step 6: Remove the OSD from the cluster
ceph osd rm 42

# Step 7: Wipe the disk (if reusing)
ceph-volume lvm zap /dev/sdb --destroy
```

### OSD Failure and Recovery

```bash
# Identify failed OSDs
ceph osd stat
# Example output: 48 osds: 46 up (since 2h), 48 in

# Find which OSD is down
ceph osd tree | grep down

# Check the OSD's systemd status on the host
systemctl status ceph-osd@42

# Check OSD logs
journalctl -u ceph-osd@42 --since "1 hour ago" | tail -100

# Common OSD failure reasons:
# 1. Disk failure (hardware)
# 2. Filesystem corruption
# 3. Network isolation
# 4. Memory pressure (OOM killed)

# If the OSD is just flapping (network issues), check:
ceph osd blacklist ls    # Ceph Nautilus and earlier
ceph osd blocklist ls    # Ceph Octopus+

# Clear a blocklisted client
ceph osd blocklist rm 10.0.1.42:0/123456789

# Force OSD back up (if the daemon is running but the OSD is marked down)
ceph osd down osd.42  # marks it explicitly down
# Then restart the daemon
```

### OSD Weights and Rebalancing

CRUSH weight determines how much data an OSD receives relative to others. The default weight is calculated from disk capacity.

```bash
# View current weights
ceph osd tree

# Set weight manually (use this when replacing a small disk with a large one)
# Weight = disk size in TiB (e.g., 4TB = 4.0)
ceph osd crush reweight osd.42 4.0

# Reweight all OSDs to match their actual capacity
ceph osd reweight-by-utilization

# Check rebalancing progress after reweight
ceph -w   # follow the event log
```

## Placement Groups

Placement groups (PGs) are the unit of data distribution in Ceph. Each pool has a fixed number of PGs, and CRUSH maps PGs to OSDs. Getting PG counts right is critical for performance and recovery time.

### PG Count Sizing

The recommended formula for PG count per pool:

```
PGs per pool = (Target PGs per OSD * OSD count * Data percentage) / Replication factor

Where:
- Target PGs per OSD: 100-200 (use 100 for stable clusters, 200 for growth)
- Data percentage: the fraction of total cluster data in this pool
- Replication factor: typically 3

Example for a cluster with 48 OSDs, 1 pool using 100% of space, replication factor 3:
PGs = (100 * 48 * 1.0) / 3 = 1600
Round to nearest power of 2: 2048
```

```bash
# Check current PG counts
ceph osd pool ls detail

# View PG distribution across OSDs
ceph pg dump_pools

# Check if PG counts are appropriate
ceph osd pool autoscale-status

# Enable PG autoscaling (Nautilus+)
ceph osd pool set {pool-name} pg_autoscale_mode on

# Set autoscale globally
ceph config set global osd_pool_default_pg_autoscale_mode on

# Manual PG adjustment (requires care — always increase, never decrease in production)
ceph osd pool set {pool-name} pg_num 512
ceph osd pool set {pool-name} pgp_num 512
# Note: pg_num and pgp_num must match for stable operation
```

### PG States and Troubleshooting

```bash
# Summary of all PG states
ceph pg stat

# Detailed PG listing
ceph pg dump | head -50

# Find stuck PGs
ceph pg dump_stuck unclean
ceph pg dump_stuck inactive
ceph pg dump_stuck stale

# Query a specific PG
ceph pg 1.a3 query

# Force a PG to recover (use sparingly)
ceph pg repair 1.a3

# Common PG states and their meanings:
# active+clean        - normal operation
# active+degraded     - some replicas missing, operating with reduced redundancy
# active+recovering   - recovery in progress
# peering             - OSDs negotiating PG membership (normal during OSD changes)
# remapped            - data has been remapped to new OSDs but not yet moved
# backfilling         - copying data to a new OSD
# incomplete          - cannot find enough OSDs to form a valid acting set (serious)
# stale               - no OSD has reported status recently (serious)
```

### PG Recovery Throttling

Aggressive recovery fills your network and slows client IO. These settings balance recovery speed against client impact.

```bash
# Check current recovery settings
ceph config get osd osd_recovery_max_active
ceph config get osd osd_max_backfills

# Slow down recovery during business hours
ceph tell osd.* config set osd_recovery_max_active 1
ceph tell osd.* config set osd_max_backfills 1
ceph tell osd.* config set osd_recovery_sleep 0.1

# Speed up recovery during maintenance windows
ceph tell osd.* config set osd_recovery_max_active 5
ceph tell osd.* config set osd_max_backfills 2
ceph tell osd.* config set osd_recovery_sleep 0

# Prioritize client IO over recovery
ceph config set osd osd_recovery_priority 5
ceph config set osd osd_client_op_priority 63

# View recovery progress
ceph -s | grep -A3 "io:"
```

## CRUSH Maps

The CRUSH map defines the topology of your cluster: which hosts are in which racks, which racks are in which rows, and which rows are in which data centers. This topology determines failure domain isolation for replicas.

### Understanding CRUSH Rules

```bash
# Dump the compiled CRUSH map to a file
ceph osd getcrushmap -o /tmp/crushmap.bin

# Decompile to human-readable text
crushtool -d /tmp/crushmap.bin -o /tmp/crushmap.txt

# View the CRUSH rules
ceph osd crush rule ls
ceph osd crush rule dump
```

A typical CRUSH map for a 3-rack deployment:

```
# Types define the hierarchy levels
# Lower numbers are leaves (closer to storage)
type 0 osd
type 1 host
type 2 chassis
type 3 rack
type 4 row
type 5 room
type 6 datacenter
type 7 zone
type 8 region
type 9 root

# Buckets define the topology
# Each OSD gets a weight proportional to its capacity (TB)
host ceph-node-01 {
    id -3
    alg straw2
    hash 0
    item osd.0 weight 4.000
    item osd.1 weight 4.000
    item osd.2 weight 4.000
    item osd.3 weight 4.000
}

host ceph-node-02 {
    id -4
    alg straw2
    hash 0
    item osd.4 weight 4.000
    item osd.5 weight 4.000
    item osd.6 weight 4.000
    item osd.7 weight 4.000
}

rack rack-1 {
    id -10
    alg straw2
    hash 0
    item ceph-node-01 weight 16.000
    item ceph-node-02 weight 16.000
}

rack rack-2 {
    id -11
    alg straw2
    hash 0
    item ceph-node-03 weight 16.000
    item ceph-node-04 weight 16.000
}

rack rack-3 {
    id -12
    alg straw2
    hash 0
    item ceph-node-05 weight 16.000
    item ceph-node-06 weight 16.000
}

root default {
    id -1
    alg straw2
    hash 0
    item rack-1 weight 32.000
    item rack-2 weight 32.000
    item rack-3 weight 32.000
}

# CRUSH rule: replicate across racks
rule replicated_rack {
    id 0
    type replicated
    min_size 1
    max_size 10
    step take default
    step chooseleaf firstn 0 type rack
    step emit
}
```

### Modifying CRUSH Maps

```bash
# Add a new host to an existing rack
ceph osd crush add-bucket ceph-node-07 host
ceph osd crush move ceph-node-07 rack=rack-2

# Move an OSD into the correct host bucket
ceph osd crush set osd.48 4.0 root=default rack=rack-2 host=ceph-node-07

# Rename a bucket
ceph osd crush rename-bucket old-name new-name

# Create a new replication rule (replicate across data centers)
ceph osd crush rule create-replicated replicated_dc default datacenter

# Test a CRUSH rule to verify placement
ceph osd map {pool-name} {object-name}
# Example:
ceph osd map rbd my-test-image
# Output shows which OSDs would store this object under current CRUSH rules

# Compile and load a modified CRUSH map
crushtool -c /tmp/crushmap.txt -o /tmp/crushmap-new.bin
ceph osd setcrushmap -i /tmp/crushmap-new.bin
```

### Failure Domain Validation

```bash
# Verify that replicas are placed in different failure domains
# Check that no two OSDs in an acting set share the same rack

# For pool "rbd", check acting sets for all PGs
ceph pg dump | awk '/^[0-9]/{print $1, $15}' | while read pg acting; do
    echo "PG $pg: $acting"
    # Parse acting set and verify cross-rack placement
done

# Simpler: test CRUSH placement for a sample of objects
for i in $(seq 1 20); do
    ceph osd map rbd test-object-$i
done
```

## Pool Management

### Creating Pools

```bash
# Create a replicated pool (most common)
ceph osd pool create rbd 128 128 replicated

# Create an erasure-coded pool for cold storage
# EC pools use less space (4+2 = ~1.5x overhead vs 3x for replication)
ceph osd erasure-code-profile set my-ec-profile \
    k=4 m=2 crush-failure-domain=rack

ceph osd pool create ec-cold-data 128 128 erasure my-ec-profile

# Enable RBD application on a pool
ceph osd pool application enable rbd rbd
ceph osd pool application enable ec-cold-data rgw

# Set pool quotas
ceph osd pool set-quota rbd max_bytes $((50 * 1024 * 1024 * 1024 * 1024))  # 50 TiB
ceph osd pool set-quota rbd max_objects 10000000

# Configure compression for a pool (BlueStore only)
ceph osd pool set rbd compression_mode aggressive
ceph osd pool set rbd compression_algorithm snappy
```

### Pool Parameters Tuning

```bash
# Enable fast read (read from primary only, no replica reads)
# Good for read-heavy workloads
ceph osd pool set rbd fast_read 1

# Set minimum replication size (minimum copies needed for writes to succeed)
ceph osd pool set rbd min_size 2  # Default 2 for size 3

# Disable scrubbing on a specific pool (during critical operations only)
ceph osd pool set rbd noscrub 1
ceph osd pool set rbd nodeep-scrub 1

# Re-enable after operations
ceph osd pool set rbd noscrub 0
ceph osd pool set rbd nodeep-scrub 0
```

## Scrubbing and Data Integrity

Scrubbing verifies data integrity by comparing object checksums across replicas.

```bash
# Check last scrub times for all PGs
ceph pg dump | awk '{print $1, $22, $23}' | column -t | head -30

# Force immediate scrub of a specific PG
ceph pg scrub 1.a3

# Force deep scrub (reads and verifies all data, more thorough but slower)
ceph pg deep-scrub 1.a3

# Scrub all PGs in a pool
ceph osd pool scrub rbd

# Schedule scrubbing to off-peak hours
ceph config set osd osd_scrub_begin_hour 22
ceph config set osd osd_scrub_end_hour 6

# Limit scrub impact
ceph config set osd osd_scrub_sleep 0.1
ceph config set osd osd_scrub_chunk_min 1
ceph config set osd osd_scrub_chunk_max 5

# Check for objects with inconsistencies
ceph health detail | grep inconsistent

# Repair inconsistent objects
ceph pg repair 1.a3
```

## Monitor and Manager Operations

### Monitor Quorum

```bash
# Check monitor status and quorum
ceph mon stat
ceph quorum_status --format json-pretty

# Add a new monitor
ceph mon add ceph-mon4 10.0.1.14:6789

# Remove a failed monitor
ceph mon remove ceph-mon3

# Force a specific monitor to leave the quorum (emergency only)
# Run on the specific monitor host
ceph-mon -i {mon-id} --inject-monmap /tmp/monmap
```

### Manager Modules

```bash
# List available manager modules
ceph mgr module ls

# Enable the dashboard module
ceph mgr module enable dashboard
ceph dashboard create-self-signed-cert
ceph dashboard set-login-credentials admin <password>

# Enable the Prometheus module for metrics export
ceph mgr module enable prometheus
# Metrics available at: http://{mgr-host}:9283/metrics

# Enable the balancer for automatic PG rebalancing
ceph mgr module enable balancer
ceph balancer mode upmap
ceph balancer on

# Check balancer status
ceph balancer status
ceph balancer eval  # show current score (lower = better balanced)
```

## Performance Tuning

### BlueStore Tuning

BlueStore is the default OSD backend since Luminous. Its key tuning parameters:

```bash
# Cache size (per OSD, larger = better read performance)
# Default: 1GB. For all-NVMe clusters, 4-8GB per OSD is appropriate.
ceph config set osd bluestore_cache_size_hdd 2147483648   # 2GB for HDD OSDs
ceph config set osd bluestore_cache_size_ssd 4294967296   # 4GB for SSD OSDs

# WAL (Write-Ahead Log) device configuration
# Place WAL on NVMe when OSDs are on HDD for significant write latency improvement
# Configure during OSD creation with --block.wal /dev/nvme0n1p1

# RocksDB tuning for metadata-heavy workloads
ceph config set osd bluestore_rocksdb_options \
    "compression=kNoCompression,max_write_buffer_number=4,min_write_buffer_number_to_merge=1"

# Check BlueStore cache statistics
ceph daemon osd.0 perf dump | python3 -m json.tool | grep -A5 bluestore_cache
```

### Network Tuning

```bash
# Separate public and cluster networks for Ceph
# Public network: client-to-OSD communication
# Cluster network: OSD-to-OSD replication (high bandwidth)

# In ceph.conf:
# [global]
# public_network = 10.0.1.0/24
# cluster_network = 10.0.2.0/24

# Tune network buffers for high-throughput replication
sysctl -w net.core.rmem_max=2147483648
sysctl -w net.core.wmem_max=2147483648
sysctl -w net.core.rmem_default=65536
sysctl -w net.ipv4.tcp_rmem="4096 87380 2147483648"
sysctl -w net.ipv4.tcp_wmem="4096 65536 2147483648"

# Verify messenger settings
ceph config get osd ms_type
# For high-throughput clusters, use async messenger (default since Nautilus)
ceph config set osd ms_type async
```

## Maintenance Procedures

### Rolling OSD Updates

```bash
# Set noout flag to prevent CRUSH rebalancing during maintenance
ceph osd set noout

# Also set norebalance to prevent PG remapping
ceph osd set norebalance

# Perform maintenance on one host at a time:
# 1. Stop OSDs on the host
systemctl stop ceph-osd.target

# 2. Perform maintenance (firmware updates, disk replacement, etc.)

# 3. Restart OSDs
systemctl start ceph-osd.target

# 4. Verify OSDs are up before proceeding to the next host
ceph osd stat
watch -n 5 ceph -s

# After all hosts are updated, clear the flags
ceph osd unset noout
ceph osd unset norebalance
```

### Full Cluster Upgrade

```bash
# Using cephadm for orchestrated upgrades
# Check available versions
ceph orch upgrade check

# Start upgrade to a specific version
ceph orch upgrade start --image quay.io/ceph/ceph:v18.2.0

# Monitor upgrade progress
ceph orch upgrade status
ceph -w  # watch for events

# The upgrade proceeds in this order:
# 1. Managers (non-active first, then active)
# 2. Monitors (one at a time, quorum maintained)
# 3. OSDs (one host at a time)
# 4. MDSes (if CephFS is in use)
# 5. RGW (if RADOS Gateway is in use)
```

### Disk Replacement

```bash
# Identify the failed disk
ceph health detail
# Example: osd.42 is down and out

# Identify which physical disk OSD 42 is on
ceph osd metadata 42 | grep -E 'device|path'

# Or check via ceph-volume
ceph-volume lvm list | grep 42

# Mark OSD out (if not already out)
ceph osd out osd.42

# Stop the OSD
systemctl stop ceph-osd@42

# Remove from cluster
ceph osd purge osd.42 --yes-i-really-mean-it

# Replace the physical disk (use your host's disk replacement procedure)

# Add new OSD on the replacement disk
ceph-volume lvm create --bluestore --data /dev/sdb

# Verify new OSD is up and in
ceph osd stat
ceph osd tree
```

## Troubleshooting Common Issues

### HEALTH_WARN: Too Many PGs per OSD

```bash
# Check current PG per OSD ratio
ceph osd df | awk 'NR>1{sum+=$8} END{print "Avg PGs per OSD:", sum/NR}'

# Resolution: reduce PG counts for pools (Luminous+)
ceph osd pool set {pool-name} pg_num_min 32
# Enable autoscaling
ceph osd pool set {pool-name} pg_autoscale_mode on
```

### HEALTH_WARN: Clock Skew Detected

```bash
# Check clock skew between monitors
ceph time-sync-status

# Ceph requires clocks synchronized within 0.05 seconds
# Verify NTP is running on all nodes
timedatectl status
systemctl status chronyd

# Force NTP sync
chronyc makestep
```

### HEALTH_ERR: Insufficient Standby MDSes

```bash
# For CephFS deployments
# Check MDS status
ceph mds stat

# Add additional MDS instances
ceph orch apply mds {fs-name} --placement="3 ceph-mds1 ceph-mds2 ceph-mds3"
```

### Slow Requests

```bash
# Identify OSDs with slow requests
ceph osd perf | sort -k3 -n | tail -20

# Get detailed slow request info from an OSD
ceph daemon osd.5 dump_ops_in_flight

# Check for blocked requests
ceph daemon osd.5 dump_blocked_ops

# Common causes of slow requests:
# 1. Disk latency (failing drive or I/O queue saturation)
# 2. Network latency (check cluster network)
# 3. CPU pressure (OSD process competing with other workloads)
# 4. Memory pressure (OSD being swapped)

# Check OSD CPU and memory
top -p $(systemctl show ceph-osd@5.service -p MainPID | cut -d= -f2)

# Check disk latency
iostat -x 5 | grep -E 'sdb|sdc|sdd'
```

### Recovering from Split Brain

If a cluster loses quorum and the monitors disagree on the cluster state:

```bash
# Identify the issue
ceph-mon -i {mon-id} --extract-monmap /tmp/monmap
monmaptool --print /tmp/monmap

# If all monitors are unreachable, you may need to force a new quorum
# This is a last resort and can cause data loss
# On the most up-to-date monitor host:
ceph-mon -i {mon-id} --inject-monmap /tmp/monmap

# Force a single-monitor cluster temporarily
ceph-mon -i {mon-id} --force-quorum-on-start
```

## Monitoring Ceph with Prometheus

The Ceph MGR Prometheus module exports all cluster metrics.

```yaml
# prometheus/ceph-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: ceph-alerts
  namespace: monitoring
spec:
  groups:
    - name: ceph.health
      rules:
        - alert: CephHealthWarning
          expr: ceph_health_status == 1
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Ceph cluster health is WARN"
            description: "Ceph cluster {{ $labels.cluster }} is in HEALTH_WARN state"

        - alert: CephHealthError
          expr: ceph_health_status == 2
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "Ceph cluster health is ERROR"
            description: "Ceph cluster {{ $labels.cluster }} is in HEALTH_ERR state"

        - alert: CephOSDDown
          expr: ceph_osd_up == 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Ceph OSD {{ $labels.ceph_daemon }} is down"

        - alert: CephCapacityCritical
          expr: ceph_cluster_total_used_bytes / ceph_cluster_total_bytes > 0.85
          for: 10m
          labels:
            severity: critical
          annotations:
            summary: "Ceph cluster capacity above 85%"
            description: "Used: {{ $value | humanizePercentage }}"

        - alert: CephSlowOps
          expr: ceph_osd_op_wip > 10
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Ceph OSD {{ $labels.ceph_daemon }} has slow operations"
```

## Summary

Operating a Ceph cluster requires understanding the interplay between physical topology (captured in the CRUSH map), the logical distribution layer (placement groups), and the data path (OSDs). The key operational principles:

- Never skip the `noout` flag during maintenance; rebalancing mid-procedure wastes bandwidth and risks triggering more failures
- Monitor PG states continuously; `active+clean` is the only healthy state
- Match CRUSH topology to your physical failure domains (racks, rows, data centers)
- Use PG autoscaling in production clusters running Nautilus or later
- Keep raw capacity utilization below 80% to leave room for recovery and rebalancing
- Maintain at least 3 monitors with quorum and 2 active managers at all times
- Test your recovery procedures regularly — know how long a disk replacement takes before you need to do one under pressure
