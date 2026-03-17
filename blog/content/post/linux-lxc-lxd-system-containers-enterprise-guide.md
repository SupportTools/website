---
title: "Linux Virtualization with LXC and LXD: Container Alternatives to Docker"
date: 2030-10-04T00:00:00-05:00
draft: false
tags: ["LXC", "LXD", "Linux", "Containers", "Virtualization", "Networking", "Storage"]
categories:
- Linux
- Containers
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise LXC/LXD guide covering the LXD daemon and lxc client, image management, container networking with bridge and macvlan, storage pools, snapshots, migration, LXD clustering, and use cases where system containers outperform Docker."
more_link: "yes"
url: "/linux-lxc-lxd-system-containers-enterprise-guide/"
---

LXC and LXD fill a gap that Docker deliberately leaves open: running full Linux system environments — complete with init systems, multiple services, and system-level tooling — inside a lightweight container. For workloads that behave like virtual machines but require container-level density, LXD provides a compelling operational model with a mature API and clustering support.

<!--more-->

## LXC vs LXD: Understanding the Stack

**LXC** (Linux Containers) is the low-level userspace toolkit that wraps Linux kernel namespaces and cgroups into a container API. It provides liblxc, the lxc command-line tools, and C/Python/Go/Lua bindings.

**LXD** is a next-generation container daemon built on top of LXC. It provides:
- A REST API for container and virtual machine management
- Image management with a registry protocol
- Declarative container profiles
- Storage backend abstraction (ZFS, Btrfs, LVM, ceph, dir)
- Network virtualization (bridges, VLAN, OVN)
- Clustering across multiple hosts
- VM management alongside containers (via QEMU)

The `lxc` CLI that most administrators use when working with LXD is the LXD client, not the liblxc tooling — a common source of confusion.

---

## Installation and Initial Setup

### Installing LXD on Ubuntu

```bash
# LXD is distributed via snap for current versions
sudo snap install lxd --channel=latest/stable

# Add your user to the lxd group
sudo usermod -aG lxd $USER
newgrp lxd

# Verify
lxd --version
```

### Installation on RHEL/AlmaLinux

```bash
# Install snap support first
sudo dnf install -y epel-release snapd
sudo systemctl enable --now snapd.socket
sudo ln -s /var/lib/snapd/snap /snap

# Install LXD
sudo snap install lxd

# SELinux may require policy adjustment
sudo setsebool -P domain_can_mmap_files 1
```

### Initial Configuration

The `lxd init` command configures the daemon interactively. For automated deployment:

```bash
# Non-interactive initialization
cat <<EOF | sudo lxd init --preseed
config: {}
networks:
  - config:
      ipv4.address: 10.10.10.1/24
      ipv4.nat: "true"
      ipv6.address: none
    description: ""
    name: lxdbr0
    type: bridge
storage_pools:
  - config:
      size: 100GiB
    description: ""
    driver: zfs
    name: default
profiles:
  - config: {}
    description: ""
    devices:
      eth0:
        name: eth0
        network: lxdbr0
        type: nic
      root:
        path: /
        pool: default
        type: disk
    name: default
cluster: null
EOF
```

For ZFS on an existing block device:

```bash
cat <<EOF | sudo lxd init --preseed
storage_pools:
  - config:
      source: /dev/sdb
    driver: zfs
    name: default
EOF
```

---

## Image Management

LXD uses a content-addressable image store. Images are downloaded on demand and cached locally.

### Finding and Listing Images

```bash
# List available remote images (Ubuntu images)
lxc image list ubuntu:

# List LXD community images
lxc image list images:

# Search for a specific distribution
lxc image list images: | grep -i "alpine"
lxc image list images: | grep -i "debian/12"

# List locally cached images
lxc image list

# Show image properties
lxc image info ubuntu:22.04
```

### Importing Custom Images

```bash
# Build a custom image from a squashfs + metadata tarball
lxc image import rootfs.squashfs metadata.tar.gz \
  --alias my-custom-image \
  --os linux \
  --release focal

# Import from URL
lxc image copy images:debian/12 local: --alias debian-12-base

# Export an image for distribution
lxc image export debian-12-base ./exports/
```

---

## Container Lifecycle Management

### Creating and Starting Containers

```bash
# Create (but don't start) a container
lxc init ubuntu:22.04 webserver-01

# Create and start in one step
lxc launch ubuntu:22.04 webserver-01

# Launch with a specific profile
lxc launch ubuntu:22.04 webserver-01 --profile default --profile production-web

# Launch with resource overrides
lxc launch ubuntu:22.04 webserver-01 \
  --config limits.cpu=4 \
  --config limits.memory=8GiB \
  --config security.nesting=false

# List containers
lxc list
lxc list --format json | jq '.[].name'
```

### Container Operations

```bash
# Get a shell inside the container
lxc exec webserver-01 -- /bin/bash

# Run a one-off command
lxc exec webserver-01 -- systemctl status nginx

# Copy files in/out
lxc file push /etc/nginx/nginx.conf webserver-01/etc/nginx/nginx.conf
lxc file pull webserver-01/var/log/nginx/error.log ./nginx-error.log

# Pull a directory recursively
lxc file pull --recursive webserver-01/etc/nginx ./nginx-backup/

# Container lifecycle
lxc stop webserver-01
lxc start webserver-01
lxc restart webserver-01
lxc delete webserver-01 --force
```

---

## Container Networking

### Bridge Networking (Default)

The default network creates a Linux bridge (lxdbr0) with NAT. Containers get DHCP-assigned addresses from the bridge subnet:

```bash
# Inspect the default bridge
lxc network show lxdbr0

# Create a custom bridge
lxc network create internal-bridge \
  ipv4.address=172.20.0.1/24 \
  ipv4.nat=true \
  ipv4.dhcp=true \
  ipv4.dhcp.ranges=172.20.0.100-172.20.0.200 \
  ipv6.address=none \
  dns.domain=internal.example.com

# Attach a container to the bridge
lxc network attach internal-bridge webserver-01 eth0

# Assign a static IP within LXD's DHCP
lxc network attach internal-bridge webserver-01 eth0
lxc config device set webserver-01 eth0 ipv4.address=172.20.0.50
```

### Macvlan for Direct Network Access

Macvlan allows containers to appear as separate hosts on the physical network with their own MAC addresses, bypassing the bridge entirely:

```bash
# Create a macvlan network
lxc network create macvlan-prod \
  type=macvlan \
  parent=eth0

# Attach to a container
lxc config device add webserver-01 eth0 nic \
  nictype=macvlan \
  parent=eth0 \
  name=eth0

# The container will obtain a DHCP address from the physical network's DHCP server
lxc exec webserver-01 -- ip addr show eth0
```

### VLAN Networking

```bash
# Create a VLAN-tagged network
lxc network create vlan-100 \
  type=macvlan \
  parent=eth0 \
  vlan=100

# Alternatively, use a pre-tagged parent interface
# First create the VLAN interface on the host:
ip link add link eth0 name eth0.100 type vlan id 100
ip link set eth0.100 up

# Then attach to containers
lxc config device add db-server eth0 nic \
  nictype=macvlan \
  parent=eth0.100 \
  name=eth0
```

### OVN for Software-Defined Networking

For multi-host networking without physical VLAN support, LXD integrates with OVN (Open Virtual Network):

```bash
# Install OVN on all cluster nodes
sudo apt-get install -y ovn-central ovn-host ovn-common

# Configure OVN database locations
sudo ovs-vsctl set open_vswitch . \
  external_ids:ovn-remote=ssl:192.168.1.10:6642 \
  external_ids:ovn-encap-type=geneve \
  external_ids:ovn-encap-ip=192.168.1.10

# Create OVN network in LXD
lxc network create ovn-prod \
  type=ovn \
  network=UPLINK \
  ipv4.address=10.100.0.1/24 \
  ipv4.nat=true \
  ipv6.address=none

# All containers on any cluster node attached to ovn-prod
# can communicate directly over the overlay network
```

---

## Storage Pools

LXD abstracts storage through pool drivers. ZFS and Btrfs provide the best feature sets with copy-on-write snapshots.

### ZFS Pool Management

```bash
# List storage pools
lxc storage list

# Show pool details
lxc storage info default

# Create an additional ZFS pool on a block device
lxc storage create fast-pool zfs source=/dev/nvme0n1

# Create a loop-backed pool for testing
lxc storage create test-pool zfs size=50GiB

# Set per-pool defaults
lxc storage set default volume.block.filesystem=ext4
lxc storage set default volume.size=20GiB

# Inspect ZFS dataset usage
zfs list -t all -o name,used,avail,refer,mountpoint | grep lxd
```

### Per-Container Storage Configuration

```bash
# Set root disk size at launch
lxc launch ubuntu:22.04 db-server \
  --storage fast-pool \
  --config limits.disk=50GiB

# Resize an existing container's root disk
lxc config device override db-server root size=100GiB

# Add an additional disk (mounted inside container)
lxc config device add db-server data disk \
  pool=fast-pool \
  path=/data \
  size=200GiB

# View disk usage
lxc info db-server | grep -A5 "Disk"
```

---

## Snapshots and Migration

### Container Snapshots

```bash
# Create a snapshot
lxc snapshot webserver-01 pre-upgrade

# List snapshots
lxc info webserver-01 | grep -A20 "Snapshots:"

# Restore a snapshot
lxc restore webserver-01 pre-upgrade

# Delete a snapshot
lxc delete webserver-01/pre-upgrade

# Schedule automatic snapshots
lxc config set webserver-01 snapshots.schedule="0 2 * * *"
lxc config set webserver-01 snapshots.expiry=7d
lxc config set webserver-01 snapshots.schedule.stopped=false
```

### Live Migration Between Hosts

Live migration requires CRIU (Checkpoint/Restore In Userspace) for stateful containers, or can be done stateless for a brief stop-and-start:

```bash
# Stateless migration (stop, copy, start on destination)
lxc move webserver-01 node2:webserver-01

# Migration with storage pool specification
lxc move webserver-01 node2:webserver-01 \
  --target-storage default

# Copy (not move) to another host
lxc copy webserver-01 node2:webserver-01

# Check migration status
lxc list webserver-01

# For CRIU-based stateful migration (experimental)
lxc move --stateful webserver-01 node2:webserver-01
```

---

## Container Profiles

Profiles provide reusable configuration templates that can be stacked:

```bash
# List profiles
lxc profile list

# Create a profile for web servers
lxc profile create production-web

lxc profile edit production-web <<EOF
config:
  limits.cpu: "4"
  limits.memory: 8GiB
  limits.memory.swap: "false"
  security.nesting: "false"
  security.privileged: "false"
  boot.autostart: "true"
  boot.autostart.delay: "5"
  boot.autostart.priority: "10"
description: Production web server profile
devices:
  eth0:
    name: eth0
    network: lxdbr0
    type: nic
  root:
    path: /
    pool: default
    size: 20GiB
    type: disk
name: production-web
EOF

# Apply profile to existing container
lxc profile add webserver-01 production-web

# Launch with multiple profiles (applied in order, last wins)
lxc launch ubuntu:22.04 webserver-02 \
  --profile default \
  --profile production-web \
  --profile monitoring
```

---

## LXD Clustering

LXD clustering allows multiple LXD hosts to act as a single management unit. Containers can run on any node, and the API is exposed through a single endpoint.

### Initializing the First Node

```bash
# Node 1: initialize as cluster leader
cat <<EOF | sudo lxd init --preseed
config:
  core.https_address: 192.168.1.10:8443
  core.trust_password: <cluster-join-token>
networks:
  - config:
      ipv4.address: 10.10.10.1/24
      ipv4.nat: "true"
    name: lxdbr0
    type: bridge
storage_pools:
  - config:
      source: /dev/sdb
    driver: zfs
    name: default
cluster:
  server_name: node1
  enabled: true
EOF
```

### Joining Additional Nodes

```bash
# Get the join token from node1
lxc cluster add node2

# On node2, initialize with the join token
cat <<EOF | sudo lxd init --preseed
cluster:
  server_name: node2
  enabled: true
  server_address: 192.168.1.11:8443
  cluster_address: 192.168.1.10:8443
  cluster_certificate: <cluster-certificate-contents>
  cluster_password: <cluster-join-token>
EOF

# Verify cluster membership
lxc cluster list
```

### Targeting Specific Cluster Nodes

```bash
# Launch a container on a specific node
lxc launch ubuntu:22.04 webserver-01 --target node1
lxc launch ubuntu:22.04 webserver-02 --target node2

# Move container between nodes
lxc move webserver-01 --target node3

# Cluster-aware resource display
lxc list --all-projects

# Node information
lxc cluster show node1
```

### High-Availability with Distributed Database

LXD uses Dqlite (distributed SQLite) for cluster state. For production clusters with 3+ nodes, this provides automatic failover:

```bash
# Check database health
lxc cluster list

# Expected output with healthy 3-node cluster:
# +-------+--------------------+------------------+--------+-------------------+----------+
# | NAME  |        URL         |      ROLES       | ARCH   |   FAILURE DOMAIN  |  STATE   |
# +-------+--------------------+------------------+--------+-------------------+----------+
# | node1 | https://192.168.1.10:8443 | database-leader  | x86_64 | default           | ONLINE   |
# | node2 | https://192.168.1.11:8443 | database         | x86_64 | default           | ONLINE   |
# | node3 | https://192.168.1.12:8443 | database         | x86_64 | default           | ONLINE   |
# +-------+--------------------+------------------+--------+-------------------+----------+

# Manually trigger database role redistribution
lxc cluster role add node3 database
```

---

## Security Hardening

### AppArmor Profiles

LXD generates per-container AppArmor profiles by default. View and customize them:

```bash
# Check AppArmor status for a container
lxc config show webserver-01 | grep apparmor

# Enable extra AppArmor restrictions
lxc config set webserver-01 raw.apparmor "deny /proc/sysrq-trigger rwklx,"

# View the generated profile
cat /var/snap/lxd/common/lxd/security/apparmor/profiles/criu/webserver-01
```

### Seccomp Filtering

```bash
# View default seccomp profile
lxc config show webserver-01 | grep seccomp

# Custom seccomp rules
lxc config set webserver-01 raw.seccomp - <<EOF
2
denylist
[all]
socket AF_NETLINK - -
EOF
```

### User Namespace (Unprivileged) Containers

All containers created with LXD are unprivileged by default — UIDs are remapped so root inside the container maps to an unprivileged user on the host:

```bash
# Verify UID remapping
lxc exec webserver-01 -- id
# uid=0(root) gid=0(root) groups=0(root)

# Host view: container's root is uid 1000000
ps aux | grep -i "lxc"
cat /proc/$(pidof -s init)/status | grep -i uid
# Uid: 1000000 ...

# Check id mappings
cat /proc/$(lxc info webserver-01 | grep Pid | awk '{print $2}')/uid_map
# 0 1000000 65536
```

---

## LXD vs Docker: When to Choose Each

| Scenario | LXD | Docker |
|---|---|---|
| Full Linux system with init | Preferred | Workarounds required |
| Multi-service legacy applications | Preferred | Complex compose configuration |
| Microservices with single process | Adequate | Preferred |
| CI ephemeral build environments | Preferred (fast snapshots) | Common |
| Kubernetes worker nodes | Via VM mode | Standard |
| Windows workloads | Via VM mode | Limited |
| Application packaging/distribution | Less common | Standard |
| Development parity with production | Adequate | Preferred |

### LXD VM Mode for Full Virtualization

LXD can also manage full virtual machines using QEMU while sharing the same API:

```bash
# Launch a VM (not a container)
lxc launch ubuntu:22.04 vm-server-01 --vm

# VMs support secure boot and TPM
lxc launch ubuntu:22.04 vm-secure \
  --vm \
  --config security.secureboot=true \
  --config security.vtpm=true

# VMs and containers are managed identically via the lxc CLI
lxc list
# TYPE column shows "CONTAINER" or "VIRTUAL-MACHINE"
```

---

## Monitoring and Metrics

```bash
# Container resource usage (real-time)
lxc monitor webserver-01

# One-time snapshot
lxc info webserver-01 --resources

# Export Prometheus metrics
# LXD exposes metrics at the /1.0/metrics endpoint
curl -sk https://localhost:8443/1.0/metrics \
  --cert ~/.config/lxc/client.crt \
  --key ~/.config/lxc/client.key

# Configure Prometheus scraping
cat <<EOF > /etc/prometheus/conf.d/lxd.yml
scrape_configs:
  - job_name: lxd
    scheme: https
    tls_config:
      cert_file: /etc/prometheus/lxd-client.crt
      key_file: /etc/prometheus/lxd-client.key
      insecure_skip_verify: true
    static_configs:
      - targets:
          - 192.168.1.10:8443
          - 192.168.1.11:8443
          - 192.168.1.12:8443
    metrics_path: /1.0/metrics
EOF
```

---

## Automation with the LXD REST API

```bash
# All lxc CLI operations use the REST API
# Direct API access with curl:

# List all containers
curl -sk \
  --cert ~/.config/lxc/client.crt \
  --key ~/.config/lxc/client.key \
  https://localhost:8443/1.0/instances | jq '.'

# Create a container via API
curl -sk \
  --cert ~/.config/lxc/client.crt \
  --key ~/.config/lxc/client.key \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{
    "name": "api-created-01",
    "source": {
      "type": "image",
      "protocol": "simplestreams",
      "server": "https://cloud-images.ubuntu.com/releases",
      "alias": "22.04"
    },
    "profiles": ["default"],
    "config": {
      "limits.cpu": "2",
      "limits.memory": "4GiB"
    }
  }' \
  https://localhost:8443/1.0/instances
```

LXD provides a mature, production-tested platform for teams that need system container capabilities — full init systems, multiple services per container, and VM-level isolation — without the overhead of traditional hypervisors. Its clustering, snapshot, and migration capabilities make it a strong choice for bare-metal infrastructure management at enterprise scale.
