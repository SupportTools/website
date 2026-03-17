---
title: "Linux High Availability with Pacemaker/Corosync: Resource Agents, Cluster Quorum, STONITH Fencing, and Active-Passive VIPs"
date: 2032-01-12T00:00:00-05:00
draft: false
tags: ["Linux", "High Availability", "Pacemaker", "Corosync", "STONITH", "Clustering", "Infrastructure", "Enterprise"]
categories:
- Linux
- Infrastructure
- High Availability
author: "Matthew Mattox - mmattox@support.tools"
description: "A production enterprise guide to building Linux high availability clusters with Pacemaker and Corosync: resource agents, quorum configuration, STONITH fencing implementation, and active-passive VIP failover patterns."
more_link: "yes"
url: "/linux-high-availability-pacemaker-corosync-stonith-active-passive-vip/"
---

Linux high availability clustering with Pacemaker and Corosync remains the foundation of enterprise-grade HA for databases (PostgreSQL, MySQL), network services (DRBD, NFS), and custom application workloads that cannot tolerate the latency or cold-start time of Kubernetes pod scheduling. When a primary database node fails, Pacemaker can detect the failure, fence the failed node, and promote a standby replica to active within 30-60 seconds—without split-brain risk because STONITH ensures the former primary cannot write to shared storage. This guide covers building a production-ready two-node (plus optional arbiter) Pacemaker cluster from scratch.

<!--more-->

# Linux High Availability with Pacemaker/Corosync

## Cluster Architecture Fundamentals

### Components and Their Roles

```
┌──────────────────────────────────────────────────────────────────┐
│  Pacemaker/Corosync HA Cluster                                   │
│                                                                   │
│  node1 (active)              node2 (standby)                    │
│  ┌─────────────────┐        ┌─────────────────┐                 │
│  │  Pacemaker CRM  │◄──────►│  Pacemaker CRM  │                 │
│  │  (cluster mgr)  │        │  (cluster mgr)  │                 │
│  ├─────────────────┤        ├─────────────────┤                 │
│  │  Corosync       │◄──────►│  Corosync       │                 │
│  │  (membership)   │ UDP    │  (membership)   │                 │
│  │                 │ 5405   │                 │                 │
│  └────────┬────────┘        └────────┬────────┘                 │
│           │                          │                           │
│  Resources on node1:        Resources on node2:                 │
│  - VirtualIP (active)       - VirtualIP (standby, no IP)       │
│  - PostgreSQL (primary)     - PostgreSQL (replica)              │
│  - Filesystem (mounted)     - Filesystem (unmounted)            │
│                                                                  │
│  Fencing (STONITH):                                             │
│  - IPMI/iLO fence agent     - Power cycle via BMC              │
│  - AWS fence agent          - Instance stop/start              │
└──────────────────────────────────────────────────────────────────┘
```

### Why STONITH Is Non-Negotiable

STONITH (Shoot The Other Node In The Head) is the mechanism by which a healthy cluster node ensures a potentially failed node cannot continue accessing shared resources. Without STONITH, split-brain scenarios are possible: both nodes believe they are active, both mount shared storage, and both write to it simultaneously—causing filesystem corruption.

The rule is absolute: **if you cannot fence, you cannot fail over safely**. Any Pacemaker cluster without working STONITH is either `stonith-enabled=false` (accepting split-brain risk) or will refuse to start cluster resources.

## Part 1: Installation

### RHEL 9 / Rocky Linux 9

```bash
# On ALL cluster nodes
dnf install -y pacemaker corosync pcs fence-agents-all \
    resource-agents resource-agents-paf

# Enable pcsd (the cluster management daemon)
systemctl enable --now pcsd

# Set hacluster password (required for pcs auth)
passwd hacluster
# Set to a strong, consistent password across all nodes

# Open firewall ports
firewall-cmd --permanent --add-service=high-availability
firewall-cmd --reload
# Equivalent to: TCP 2224 (pcsd), UDP 5405-5412 (corosync), TCP 21064 (dlm)
```

### Debian / Ubuntu 22.04+

```bash
# On ALL cluster nodes
apt-get install -y pacemaker corosync pcs fence-agents \
    resource-agents python3-pycurl

# Set hacluster password
passwd hacluster

# Enable and start pcsd
systemctl enable --now pcsd

# Firewall (ufw)
ufw allow 2224/tcp
ufw allow 5405/udp
ufw allow 21064/tcp
```

## Part 2: Corosync Configuration

### Cluster Authentication and Initialization

```bash
# On node1: authenticate all nodes
pcs host auth node1.example.com node2.example.com \
    -u hacluster -p <hacluster-password>

# On node1: create the cluster
pcs cluster setup mycluster \
    node1.example.com \
    node2.example.com \
    --start \
    --enable \
    --force

# Verify cluster formation
pcs cluster status
corosync-quorumtool -l
```

### /etc/corosync/corosync.conf (Manual Configuration)

For fine-grained control, configure corosync directly:

```ini
# /etc/corosync/corosync.conf

totem {
    version: 2

    # Cluster name (must match on all nodes)
    cluster_name: mycluster

    # Crypto: encryption and authentication for cluster messages
    crypto_cipher: aes256
    crypto_hash: sha256

    # Token timeout: time before a non-responsive node is considered dead
    # Lower = faster failover, higher = fewer false positives
    # Production: 3000-10000ms (3-10s)
    token: 5000

    # Token retransmit: how many times to retransmit before marking node as dead
    token_retransmits_before_loss_const: 10

    # Join timeout: wait for cluster members to join
    join: 60

    # Consensus timeout: time for all nodes to agree on membership
    consensus: 7500

    # Merge timeout: for merging partitioned clusters
    merge: 200

    # Failure detection via heartbeat
    transport: knet

    interface {
        ringnumber: 0
        bindnetaddr: 10.0.1.0  # Use dedicated cluster network if available
        mcastport: 5405
    }
}

quorum {
    provider: corosync_votequorum
    two_node: 1  # Enable for 2-node clusters: 1 node = quorum
    # For 3+ nodes, remove two_node and use:
    # expected_votes: 3
    # wait_for_all: 1
}

nodelist {
    node {
        ring0_addr: node1.example.com
        name: node1
        nodeid: 1
    }
    node {
        ring0_addr: node2.example.com
        name: node2
        nodeid: 2
    }
}

logging {
    to_syslog: yes
    debug: off
    logger_subsys {
        subsys: QUORUM
        debug: off
    }
}
```

### Multi-Ring Configuration for Redundant Networks

```ini
totem {
    transport: knet

    interface {
        linknumber: 0
        bindnetaddr: 10.0.1.0   # Primary cluster network (dedicated NIC)
        mcastport: 5405
    }

    interface {
        linknumber: 1
        bindnetaddr: 192.168.1.0  # Secondary cluster network (backup)
        mcastport: 5406
    }
}

nodelist {
    node {
        ring0_addr: 10.0.1.10   # node1 primary
        ring1_addr: 192.168.1.10 # node1 secondary
        name: node1
        nodeid: 1
    }
    node {
        ring0_addr: 10.0.1.11
        ring1_addr: 192.168.1.11
        name: node2
        nodeid: 2
    }
}
```

## Part 3: STONITH Fencing

### IPMI/iLO Fencing (Physical Servers)

```bash
# Install IPMI fence agent
dnf install -y fence-agents-ipmilan

# Test the fence agent before adding to cluster
fence_ipmilan \
    -a 10.0.0.200 \
    -l admin \
    -p <ipmi-password> \
    -o status

# Add STONITH resource to cluster
pcs stonith create fence-node1 fence_ipmilan \
    ipaddr="10.0.0.200" \
    login="admin" \
    passwd="<ipmi-password>" \
    lanplus="1" \
    pcmk_host_list="node1" \
    op monitor interval="60s"

pcs stonith create fence-node2 fence_ipmilan \
    ipaddr="10.0.0.201" \
    login="admin" \
    passwd="<ipmi-password>" \
    lanplus="1" \
    pcmk_host_list="node2" \
    op monitor interval="60s"

# Location constraint: node must fence itself on the peer node
pcs constraint location fence-node1 avoids node1
pcs constraint location fence-node2 avoids node2

# Verify fencing is configured
pcs stonith show
```

### AWS EC2 Fencing

```bash
# Install AWS fence agent
dnf install -y fence-agents-aws

# IAM policy required:
# ec2:DescribeInstances, ec2:StopInstances, ec2:StartInstances,
# ec2:RebootInstances

# Configure using instance IDs or tags
pcs stonith create fence-node1 fence_aws \
    region="us-east-1" \
    tag="Name=ha-node1" \
    pcmk_host_list="node1" \
    pcmk_reboot_action="off-on" \
    op monitor interval="120s"

pcs stonith create fence-node2 fence_aws \
    region="us-east-1" \
    tag="Name=ha-node2" \
    pcmk_host_list="node2" \
    pcmk_reboot_action="off-on" \
    op monitor interval="120s"
```

### Virtual Machine Fencing (VMware/KVM)

```bash
# For VMware VMs: use fence_vmware_soap
pcs stonith create fence-node1 fence_vmware_soap \
    ipaddr="vcenter.example.com" \
    login="svc-cluster-fence@vsphere.local" \
    passwd="<vcenter-password>" \
    ssl="1" \
    ssl_insecure="0" \
    pcmk_host_list="node1" \
    pcmk_host_check="static-list" \
    op monitor interval="120s"

# For KVM: use fence_virsh
pcs stonith create fence-node1 fence_virsh \
    ipaddr="kvm-hypervisor.example.com" \
    login="root" \
    identity_file="/etc/pacemaker/fence_keys/id_rsa" \
    pcmk_host_list="node1" \
    pcmk_host_map="node1:vm-node1-uuid" \
    op monitor interval="60s"
```

### Testing Fencing Without Impacting Production

```bash
# Test fencing in safe mode (verify connectivity, don't actually fence)
pcs stonith fence node2 --verbose --wait

# Check stonith history
pcs stonith history

# Simulate what would happen during failover
pcs cluster simulate
```

## Part 4: Cluster Properties

```bash
# Disable STONITH only for testing/development clusters
# NEVER in production
pcs property set stonith-enabled=true

# Quorum policy
# stop: stop all resources if quorum lost (safe default)
# ignore: continue running without quorum (DANGEROUS)
# freeze: stop resource changes but keep running
pcs property set no-quorum-policy=stop

# Resource stickiness: prefer to keep resources where they are
# Higher = harder to move resources off current node
pcs property set default-resource-stickiness=100

# Migration threshold: how many failures before moving to another node
pcs property set migration-threshold=3

# Failure timeout: clear failure counts after this duration
pcs property set failure-timeout=300

# Batch limit: max resource operations to run in parallel
pcs property set batch-limit=20

# View all cluster properties
pcs property show
```

## Part 5: Resource Agents

### VirtualIP Resource

```bash
# Create a virtual IP (floating IP) resource
pcs resource create VirtualIP ocf:heartbeat:IPaddr2 \
    ip="10.0.1.100" \
    cidr_netmask="24" \
    nic="eth0" \
    op monitor interval="30s" \
    meta migration-threshold=3

# Verify
pcs resource show VirtualIP
ip addr show eth0 | grep 10.0.1.100  # Should appear only on active node
```

### PostgreSQL Active-Passive with PAF

PAF (PostgreSQL Automatic Failover) is the OCF resource agent for PostgreSQL:

```bash
# Install PAF
dnf install -y resource-agents-paf

# Create PostgreSQL resource
pcs resource create PostgreSQL ocf:heartbeat:pgsqlms \
    bindir="/usr/pgsql-16/bin" \
    pgdata="/var/lib/pgsql/16/data" \
    pgport="5432" \
    pguser="postgres" \
    start_opts="-s -w -t 300" \
    op start timeout=120 \
    op stop timeout=120 \
    op promote timeout=120 \
    op demote timeout=120 \
    op monitor interval=15 timeout=10 role=Primary \
    op monitor interval=16 timeout=10 role=Replica
```

### Filesystem Resource

```bash
# Create DRBD-backed filesystem resource
# (assumes DRBD is configured separately)
pcs resource create DRBD_r0 ocf:linbit:drbd \
    drbd_resource="r0" \
    op monitor interval="15s" role=Master \
    op monitor interval="30s" role=Slave

pcs resource create FileSystem_data ocf:heartbeat:Filesystem \
    device="/dev/drbd0" \
    directory="/data" \
    fstype="xfs" \
    options="noatime,nodiratime" \
    op monitor interval="20s" timeout="40s"
```

### Custom OCF Resource Agent

Writing a custom resource agent allows Pacemaker to manage any service:

```bash
#!/bin/bash
# /usr/lib/ocf/resource.d/myorg/myservice
# Custom OCF Resource Agent for MyService

# OCF metadata
: ${OCF_FUNCTIONS_DIR=${OCF_ROOT}/lib/heartbeat}
. ${OCF_FUNCTIONS_DIR}/ocf-shellfuncs

OCF_RESKEY_binary_default="/usr/sbin/myservice"
OCF_RESKEY_config_default="/etc/myservice/config.yaml"
OCF_RESKEY_port_default="8080"

: ${OCF_RESKEY_binary=${OCF_RESKEY_binary_default}}
: ${OCF_RESKEY_config=${OCF_RESKEY_config_default}}
: ${OCF_RESKEY_port=${OCF_RESKEY_port_default}}

PIDFILE="/var/run/myservice.pid"
LOCKFILE="/var/lock/myservice"

meta_data() {
    cat <<END
<?xml version="1.0"?>
<!DOCTYPE resource-agent SYSTEM "ra-api-1.dtd">
<resource-agent name="myservice" version="1.0">
<version>1.0</version>
<longdesc lang="en">OCF resource agent for MyService</longdesc>
<shortdesc lang="en">MyService resource agent</shortdesc>

<parameters>
<parameter name="binary" unique="0" required="0">
<longdesc lang="en">Full path to myservice binary</longdesc>
<shortdesc lang="en">Binary path</shortdesc>
<content type="string" default="${OCF_RESKEY_binary_default}" />
</parameter>

<parameter name="config" unique="0" required="0">
<longdesc lang="en">Path to configuration file</longdesc>
<shortdesc lang="en">Config file</shortdesc>
<content type="string" default="${OCF_RESKEY_config_default}" />
</parameter>
</parameters>

<actions>
<action name="start"        timeout="30s" />
<action name="stop"         timeout="30s" />
<action name="monitor"      timeout="20s" interval="10s" depth="0" />
<action name="validate-all" timeout="20s" />
<action name="meta-data"    timeout="5s" />
</actions>
</resource-agent>
END
}

myservice_start() {
    if myservice_monitor; then
        ocf_log info "MyService already running"
        return ${OCF_SUCCESS}
    fi

    ocf_log info "Starting MyService"
    "${OCF_RESKEY_binary}" \
        --config "${OCF_RESKEY_config}" \
        --port "${OCF_RESKEY_port}" \
        --daemonize \
        --pidfile "${PIDFILE}"

    local rc=$?
    if [ $rc -ne 0 ]; then
        ocf_log err "Failed to start MyService: exit code $rc"
        return ${OCF_ERR_GENERIC}
    fi

    ocf_log info "MyService started successfully"
    touch "${LOCKFILE}"
    return ${OCF_SUCCESS}
}

myservice_stop() {
    if ! myservice_monitor; then
        ocf_log info "MyService already stopped"
        return ${OCF_SUCCESS}
    fi

    ocf_log info "Stopping MyService"
    if [ -f "${PIDFILE}" ]; then
        kill -TERM "$(cat ${PIDFILE})" 2>/dev/null
        local timeout=30
        while myservice_monitor && [ $timeout -gt 0 ]; do
            sleep 1
            timeout=$((timeout - 1))
        done
    fi

    if myservice_monitor; then
        ocf_log err "MyService failed to stop gracefully, sending SIGKILL"
        kill -9 "$(cat ${PIDFILE})" 2>/dev/null
    fi

    rm -f "${PIDFILE}" "${LOCKFILE}"
    return ${OCF_SUCCESS}
}

myservice_monitor() {
    if [ ! -f "${PIDFILE}" ]; then
        return ${OCF_NOT_RUNNING}
    fi

    local pid
    pid=$(cat "${PIDFILE}" 2>/dev/null) || return ${OCF_NOT_RUNNING}

    if ! kill -0 "$pid" 2>/dev/null; then
        ocf_log warn "MyService PID file exists but process $pid is gone"
        rm -f "${PIDFILE}"
        return ${OCF_NOT_RUNNING}
    fi

    # Deep check: verify the HTTP health endpoint
    if ! curl -sf "http://localhost:${OCF_RESKEY_port}/health" > /dev/null 2>&1; then
        ocf_log warn "MyService process running but health check failed"
        return ${OCF_ERR_GENERIC}
    fi

    return ${OCF_SUCCESS}
}

myservice_validate() {
    if [ ! -x "${OCF_RESKEY_binary}" ]; then
        ocf_log err "Binary not found: ${OCF_RESKEY_binary}"
        return ${OCF_ERR_INSTALLED}
    fi
    if [ ! -f "${OCF_RESKEY_config}" ]; then
        ocf_log err "Config file not found: ${OCF_RESKEY_config}"
        return ${OCF_ERR_CONFIGURED}
    fi
    return ${OCF_SUCCESS}
}

case "$1" in
    meta-data)  meta_data ;;
    start)      myservice_start ;;
    stop)       myservice_stop ;;
    monitor)    myservice_monitor ;;
    validate-all) myservice_validate ;;
    *)
        ocf_log err "Unknown action: $1"
        exit ${OCF_ERR_UNIMPLEMENTED}
        ;;
esac
```

```bash
# Install and test the custom agent
chmod +x /usr/lib/ocf/resource.d/myorg/myservice

# Validate the agent syntax
ocf-tester -n myservice-test /usr/lib/ocf/resource.d/myorg/myservice

# Add to cluster
pcs resource create MyService ocf:myorg:myservice \
    binary="/usr/sbin/myservice" \
    config="/etc/myservice/config.yaml" \
    op monitor interval="10s" timeout="20s"
```

## Part 6: Resource Groups and Ordering Constraints

### Resource Group (Start/Stop Together)

```bash
# Create a group: VirtualIP + PostgreSQL start together, stop together
# Resources within a group start in order, stop in reverse order
pcs resource group add HA_Group VirtualIP PostgreSQL

# View group configuration
pcs resource show HA_Group

# Group failover: all resources move together when any fails
```

### Clone and Promotable Resources

```bash
# Clone: run resource on all cluster nodes simultaneously
pcs resource clone SomeService \
    clone-max=2 \
    clone-node-max=1 \
    interleave=true

# Promotable (formerly Multi-State): one Primary, one+ Replica
pcs resource promotable PostgreSQL \
    promoted-max=1 \
    promoted-node-max=1 \
    clone-max=2 \
    clone-node-max=1
```

### Ordering Constraints

```bash
# Start VirtualIP BEFORE PostgreSQL starts
pcs constraint order VirtualIP then PostgreSQL

# Start DRBD before FileSystem, then FileSystem before MyService
pcs constraint order DRBD_r0-clone then FileSystem_data
pcs constraint order FileSystem_data then MyService

# Mandatory ordering (if VirtualIP fails, stop everything after it)
pcs constraint order VirtualIP then PostgreSQL kind=Mandatory
```

### Location Constraints

```bash
# Prefer node1 for VirtualIP (higher score = more preferred)
pcs constraint location VirtualIP prefers node1=50

# Require that PostgreSQL runs on the same node as VirtualIP
pcs constraint colocation add PostgreSQL with VirtualIP score=INFINITY

# Ban a resource from a specific node
pcs constraint location MyService avoids node2

# View all constraints
pcs constraint show
```

## Part 7: Cluster Operations

### Manual Failover

```bash
# Move a resource to the other node
pcs resource move VirtualIP node2

# Check where resources are running
pcs status

# After manual move, remove the temporary location constraint to allow future automatic failover
pcs resource clear VirtualIP

# Failback: prefer original node
pcs resource move VirtualIP node1
pcs resource clear VirtualIP
```

### Maintenance Mode

```bash
# Put cluster into maintenance mode (stop monitoring, keep resources running)
pcs property set maintenance-mode=true

# Perform maintenance (e.g., OS updates, hardware work)
dnf update -y
# ...

# Exit maintenance mode (resume monitoring)
pcs property set maintenance-mode=false

# Put only a specific node into maintenance
pcs node maintenance node2

# Remove node from maintenance
pcs node unmaintenance node2
```

### Standby Mode (Evacuate a Node)

```bash
# Move all resources off node2 (for maintenance or testing)
pcs node standby node2

# Verify resources moved to node1
pcs status

# Return node2 to active service
pcs node unstandby node2
```

### Resource Cleanup After Failure

```bash
# After manual fix, clear failure count so Pacemaker will try again
pcs resource cleanup PostgreSQL

# Cleanup on specific node
pcs resource cleanup VirtualIP node=node1

# Force probe current resource state
pcs resource refresh PostgreSQL

# View resource failure history
pcs resource failcount show PostgreSQL
```

## Part 8: Two-Node Cluster Quorum

### The Quorum Problem with Two Nodes

With two nodes, losing either one means losing 50% of the cluster—exactly at the quorum boundary. Without special handling, either node can be denied quorum when the other fails, causing a cluster-wide resource shutdown.

Solutions:

**Option 1: `two_node: 1` in corosync.conf (simplest)**
Sets quorum to 1 vote. Either node alone has quorum. Risk: if the network link between nodes fails, both nodes believe they have quorum. STONITH is mandatory to prevent split-brain.

**Option 2: Quorum device (recommended)**
Add a third vote source—typically a small VM or cloud instance:

```bash
# Install quorum device packages
# On quorum device (separate small VM)
dnf install -y corosync-qdevice corosync-qnetd

# On cluster nodes
dnf install -y corosync-qdevice

# Configure qnetd on the quorum device
corosync-qnetd-certutil -i
systemctl enable --now corosync-qnetd

# On cluster node1
pcs quorum device add model net \
    host=qdevice.example.com \
    algorithm=lms

# Verify quorum device
corosync-quorumtool -s
pcs quorum status
```

## Part 9: Monitoring and Alerting

### Pacemaker Alerts

```bash
# Configure alert for resource operations (start, stop, failure)
pcs alert create id=email-alert \
    path=/etc/pacemaker/alerts/alert-smtp.sh \
    description="Email on resource events"

pcs alert recipient add email-alert \
    value=ops-team@example.com

# Create alert script
cat << 'SCRIPT' > /etc/pacemaker/alerts/alert-smtp.sh
#!/bin/bash
# Pacemaker alert handler — sends email on events

TO="${CRM_alert_recipient}"
FROM="pacemaker@$(hostname -f)"
SUBJECT="Pacemaker: ${CRM_alert_kind} ${CRM_alert_status} — ${CRM_alert_desc}"

sendmail -t << EOF
To: ${TO}
From: ${FROM}
Subject: ${SUBJECT}

Node: ${CRM_alert_node}
Task: ${CRM_alert_task}
Time: $(date -d @${CRM_alert_timestamp_epoch} --rfc-3339=seconds)
Status: ${CRM_alert_status} (${CRM_alert_rc})
Description: ${CRM_alert_desc}
EOF
SCRIPT
chmod +x /etc/pacemaker/alerts/alert-smtp.sh
```

### Prometheus Integration

```bash
# Install prometheus-pacemaker-exporter
dnf install -y prometheus-pacemaker-exporter

# Or use ha_cluster_exporter
curl -Lo /usr/local/bin/ha_cluster_exporter \
    "https://github.com/ClusterLabs/ha_cluster_exporter/releases/latest/download/ha_cluster_exporter-linux-amd64"
chmod +x /usr/local/bin/ha_cluster_exporter

# Run exporter
/usr/local/bin/ha_cluster_exporter --port=9664 &

# Key metrics:
# ha_cluster_pacemaker_nodes{node="node1",type="online"} 1
# ha_cluster_pacemaker_resources{resource="VirtualIP",role="Started",node="node1"} 1
# ha_cluster_corosync_quorum_members 2
# ha_cluster_corosync_quorum_votes{type="quorum"} 2
```

```yaml
# Prometheus alert rules for HA cluster
groups:
  - name: ha-cluster
    rules:
      - alert: HAClusterNodeOffline
        expr: ha_cluster_pacemaker_nodes{type="online"} == 0
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "HA cluster node is offline"

      - alert: HAClusterResourceFailed
        expr: ha_cluster_pacemaker_resources{role="Failed"} > 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "HA cluster resource failed"

      - alert: HAClusterQuorumLost
        expr: ha_cluster_corosync_quorum_votes{type="quorum"} < ha_cluster_corosync_quorum_members
        for: 30s
        labels:
          severity: critical
        annotations:
          summary: "HA cluster has lost quorum"
```

## Part 10: Complete Active-Passive PostgreSQL Setup

```bash
#!/bin/bash
# setup-ha-cluster.sh — complete active-passive PostgreSQL HA cluster

set -euo pipefail

NODE1="node1.example.com"
NODE2="node2.example.com"
VIP="10.0.1.100"
VIP_NETMASK="24"
VIP_NIC="eth0"

echo "=== Configuring cluster properties ==="
pcs property set stonith-enabled=true
pcs property set no-quorum-policy=stop
pcs property set default-resource-stickiness=100
pcs property set migration-threshold=3

echo "=== Creating STONITH resources ==="
# IPMI fence agents (adjust for your hardware/cloud)
pcs stonith create fence-node1 fence_ipmilan \
    ipaddr="10.0.0.200" login="admin" passwd="<ipmi-password>" \
    lanplus="1" pcmk_host_list="node1" \
    op monitor interval="60s"

pcs stonith create fence-node2 fence_ipmilan \
    ipaddr="10.0.0.201" login="admin" passwd="<ipmi-password>" \
    lanplus="1" pcmk_host_list="node2" \
    op monitor interval="60s"

pcs constraint location fence-node1 avoids node1
pcs constraint location fence-node2 avoids node2

echo "=== Creating VirtualIP resource ==="
pcs resource create VirtualIP ocf:heartbeat:IPaddr2 \
    ip="${VIP}" cidr_netmask="${VIP_NETMASK}" nic="${VIP_NIC}" \
    op monitor interval="30s"

echo "=== Creating PostgreSQL promotable resource ==="
pcs resource create PostgreSQL ocf:heartbeat:pgsqlms \
    bindir="/usr/pgsql-16/bin" \
    pgdata="/var/lib/pgsql/16/data" \
    pgport="5432" \
    pguser="postgres" \
    recovery_template="/etc/pacemaker/pgsql/recovery.conf.pcmk" \
    op start timeout=120 \
    op stop timeout=120 \
    op promote timeout=120 \
    op demote timeout=120 \
    op monitor interval=15 timeout=10 role=Primary \
    op monitor interval=16 timeout=10 role=Replica

pcs resource promotable PostgreSQL \
    promoted-max=1 \
    promoted-node-max=1 \
    clone-max=2 \
    clone-node-max=1

echo "=== Setting up constraints ==="
# VirtualIP must run on the same node as the PostgreSQL Primary
pcs constraint colocation add VirtualIP \
    with PostgreSQL-clone role=Primary score=INFINITY

# VirtualIP must start after PostgreSQL promotion
pcs constraint order promote PostgreSQL-clone \
    then start VirtualIP kind=Mandatory

echo "=== Cluster setup complete ==="
pcs status
```

## Summary

Pacemaker/Corosync provides battle-tested, production-grade HA clustering for Linux:

1. **Corosync** handles cluster membership, quorum computation, and inter-node messaging. Its knet transport supports encryption, compression, and multiple redundant rings.

2. **STONITH fencing** is the cornerstone of split-brain prevention. Any production cluster must have working STONITH. Test it before trusting it.

3. **Resource agents** (OCF, LSB, systemd) abstract service management, providing start/stop/monitor/promote/demote operations that Pacemaker orchestrates based on constraints and node health.

4. **Constraints** (colocation, ordering, location) define the dependency graph between resources, ensuring that related resources (VIP, database, filesystem) move together and start in the correct order.

5. **Two-node clusters** require `two_node: 1` in corosync or a quorum device to handle node failures without deadlocking, with STONITH being even more critical than in larger clusters.

For organizations evaluating Pacemaker vs. Kubernetes HA: Pacemaker excels for stateful services requiring deterministic, sub-60-second failover with complex dependency graphs. Kubernetes is better for stateless or cloud-native services where rolling updates and pod rescheduling are acceptable.
