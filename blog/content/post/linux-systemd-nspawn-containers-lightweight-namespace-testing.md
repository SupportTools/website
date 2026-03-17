---
title: "Linux systemd-nspawn Containers: Lightweight Namespace Containers for Testing and Development"
date: 2031-08-09T00:00:00-05:00
draft: false
tags: ["Linux", "systemd", "Containers", "Namespaces", "Development", "Testing"]
categories:
- Linux
- Containers
author: "Matthew Mattox - mmattox@support.tools"
description: "A practical guide to using systemd-nspawn for lightweight container-based testing and development environments, including networking, filesystem overlay, and machinectl management."
more_link: "yes"
url: "/linux-systemd-nspawn-containers-lightweight-namespace-testing/"
---

systemd-nspawn is a mature, kernel-native container runtime that ships with every modern Linux system. Unlike Docker or containerd, it requires no daemon, integrates directly with systemd's service management, and provides excellent tooling for development and testing environments. This guide covers everything from basic container creation to advanced networking and ephemeral overlay filesystems.

<!--more-->

# Linux systemd-nspawn Containers: Lightweight Namespace Containers for Testing and Development

## Overview

systemd-nspawn creates lightweight containers using the same Linux namespace and cgroup primitives as Docker, but with a different operational model:

- **No daemon required** — runs directly as a systemd unit or interactive process
- **Full systemd inside** — containers can run their own systemd init, enabling service-level testing
- **Integrated with machinectl** — first-class management through the `machinectl` tool
- **Overlay filesystem support** — ephemeral containers that discard all changes on exit
- **Direct kernel interface** — no extra abstraction layer means lower overhead

systemd-nspawn is ideal for:
- Testing package installations without touching the host
- Running integration tests with full OS-level dependencies
- Simulating multi-host environments on a single machine
- Safe exploration of configuration changes
- Building packages in clean environments

---

## Section 1: Installation and Prerequisites

### 1.1 System Requirements

systemd-nspawn is part of the `systemd` package and is available on any system running systemd 219 or later. Verify your installation:

```bash
# Check systemd-nspawn version
systemd-nspawn --version

# Required kernel features
# Check namespace support
ls /proc/self/ns/
# Expected: cgroup  ipc  mnt  net  pid  time  user  uts

# Check cgroup v2
mount | grep cgroup2
# or
cat /proc/filesystems | grep cgroup

# Verify machinectl is available
machinectl --version
```

### 1.2 Required Packages

```bash
# Debian/Ubuntu
apt-get install -y systemd-container debootstrap

# RHEL/CentOS/Rocky
dnf install -y systemd-container

# Arch Linux (built-in with systemd)
pacman -S arch-install-scripts  # for bootstrap tools

# Check /var/lib/machines exists (created by systemd-container)
ls -la /var/lib/machines/
```

---

## Section 2: Creating Container Root Filesystems

### 2.1 Bootstrap a Debian/Ubuntu Container

```bash
# Create a Debian 12 (bookworm) container
sudo debootstrap \
  --include=systemd,dbus,iproute2,iputils-ping,curl,vim,procps \
  bookworm \
  /var/lib/machines/debian-test \
  http://deb.debian.org/debian/

# Verify the bootstrap
ls /var/lib/machines/debian-test/
# bin  boot  dev  etc  home  lib  lib64  media  mnt  opt  proc  root  run  sbin  srv  sys  tmp  usr  var

# Set root password inside the container
sudo systemd-nspawn -D /var/lib/machines/debian-test passwd root

# Basic test: launch interactive shell
sudo systemd-nspawn -D /var/lib/machines/debian-test /bin/bash
```

### 2.2 Bootstrap a Rocky Linux Container

```bash
# Install dnf if not available
which dnf || apt-get install -y dnf

# Bootstrap Rocky Linux 9
sudo mkdir -p /var/lib/machines/rocky9
sudo dnf \
  --installroot=/var/lib/machines/rocky9 \
  --releasever=9 \
  --nogpgcheck \
  install \
  -y \
  basesystem \
  systemd \
  passwd \
  iproute \
  iputils \
  dnf

# Initialize the RPM database
sudo systemd-nspawn -D /var/lib/machines/rocky9 rpm --initdb
sudo systemd-nspawn -D /var/lib/machines/rocky9 passwd root
```

### 2.3 Using Tarball Images

```bash
# Download a pre-built root tarball (many distros provide these)
# For Alpine Linux:
wget https://dl-cdn.alpinelinux.org/alpine/v3.20/releases/x86_64/alpine-minirootfs-3.20.0-x86_64.tar.gz

sudo mkdir -p /var/lib/machines/alpine
sudo tar -xzf alpine-minirootfs-3.20.0-x86_64.tar.gz \
  -C /var/lib/machines/alpine

# Alpine does not use systemd, but nspawn can still run it
sudo systemd-nspawn -D /var/lib/machines/alpine /bin/sh
```

### 2.4 Pulling Container Images with machinectl

```bash
# machinectl can pull OCI-compatible container images
# Pull an Ubuntu image from Docker Hub (requires systemd 240+)
sudo machinectl pull-tar \
  --verify=no \
  https://cloud-images.ubuntu.com/minimal/releases/noble/release/ubuntu-24.04-minimal-cloudimg-amd64-root.tar.xz \
  ubuntu-noble

# Or pull a raw image
sudo machinectl pull-raw \
  --verify=no \
  https://cloud.centos.org/centos/9-stream/x86_64/images/CentOS-Stream-GenericCloud-9-latest.x86_64.qcow2 \
  centos9
```

---

## Section 3: Running Containers

### 3.1 Interactive Session

```bash
# Start an interactive container session
sudo systemd-nspawn \
  --machine=debian-test \
  --directory=/var/lib/machines/debian-test \
  --bind=/home/user/project:/workspace \
  --setenv=DEBIAN_FRONTEND=noninteractive \
  /bin/bash

# Inside the container, you have an isolated environment:
hostname    # shows the machine name
ip addr     # shows container network interface
ps aux      # shows only container processes
cat /etc/os-release  # shows container OS
```

### 3.2 Running a Full systemd Boot

For testing services that require a full init system:

```bash
# Boot the container with systemd as PID 1
sudo systemd-nspawn \
  --machine=debian-test \
  --directory=/var/lib/machines/debian-test \
  --boot \
  --network-veth \
  --private-users=pick

# In another terminal, check the machine status
machinectl list
machinectl status debian-test

# Open a login shell in the running container
machinectl shell debian-test
# or
machinectl login debian-test
```

### 3.3 Running as a systemd Service

The preferred production pattern for persistent containers:

```bash
# Create a .nspawn configuration file
sudo cat > /etc/systemd/nspawn/debian-test.nspawn << 'EOF'
[Exec]
Boot=yes
PrivateUsers=pick
Environment=DEBIAN_FRONTEND=noninteractive

[Files]
Bind=/srv/data:/data
BindReadOnly=/etc/resolv.conf

[Network]
VirtualEthernet=yes
VirtualEthernetExtra=
EOF

# Enable and start the machine
sudo systemctl enable systemd-nspawn@debian-test
sudo systemctl start systemd-nspawn@debian-test

# Check status
systemctl status systemd-nspawn@debian-test
machinectl status debian-test
```

---

## Section 4: Networking Configuration

### 4.1 Network Modes

systemd-nspawn supports several networking modes:

| Mode | Flag | Description |
|------|------|-------------|
| Host network | `--network-namespace=inherit` | Share host network stack (insecure) |
| Private (virtual ethernet) | `--network-veth` | Creates veth pair, requires host-side routing |
| Shared host interface | `--network-interface=eth0` | Move interface into container namespace |
| MACVLAN | `--network-macvlan=eth0` | Create MACVLAN sub-interface |
| Bridge | `--network-bridge=br0` | Connect to existing bridge |

### 4.2 Virtual Ethernet (veth) Networking

```bash
# Start container with veth networking
sudo systemd-nspawn \
  --machine=webserver \
  --directory=/var/lib/machines/debian-test \
  --boot \
  --network-veth

# On the host: configure the host-side veth
# systemd-nspawn creates ve-<machine-name> interface on the host
ip link show ve-webserver

# The container gets a mv-<host-interface> interface
# Inside container:
machinectl shell webserver
# > ip link show mv-host0

# Set up IP addresses
# Host side:
sudo ip addr add 192.168.100.1/24 dev ve-webserver
sudo ip link set ve-webserver up

# Container side (via machinectl shell):
# ip addr add 192.168.100.2/24 dev mv-host0
# ip link set mv-host0 up
# ip route add default via 192.168.100.1
```

### 4.3 Automated Networking with systemd-networkd

Create network configuration files that apply automatically:

```bash
# Host-side: /etc/systemd/network/80-container-ve.network
sudo cat > /etc/systemd/network/80-container-ve.network << 'EOF'
[Match]
Name=ve-*
Driver=veth

[Network]
DHCPServer=yes
IPMasquerade=both
LinkLocalAddressing=ipv6
LLDP=yes
EmitLLDP=customer-bridge

[DHCPServer]
PoolOffset=100
PoolSize=20
EmitDNS=yes
DNS=1.1.1.1
EOF

# Container-side: place in container filesystem
sudo cat > /var/lib/machines/debian-test/etc/systemd/network/80-container-host.network << 'EOF'
[Match]
Name=mv-host0

[Network]
DHCP=yes
DNS=1.1.1.1

[DHCP]
UseHostname=yes
UseDomains=yes
EOF

# Enable systemd-networkd in both host and container
sudo systemctl enable --now systemd-networkd
```

### 4.4 Bridge Networking for Multi-Container Communication

```bash
# Create a bridge for container-to-container communication
sudo ip link add name br-containers type bridge
sudo ip addr add 10.0.100.1/24 dev br-containers
sudo ip link set br-containers up

# Enable IP forwarding and masquerading
sudo sysctl -w net.ipv4.ip_forward=1
sudo iptables -t nat -A POSTROUTING -s 10.0.100.0/24 -j MASQUERADE

# Start containers connected to the bridge
sudo systemd-nspawn \
  --machine=container-a \
  --directory=/var/lib/machines/debian-test \
  --boot \
  --network-bridge=br-containers &

sudo systemd-nspawn \
  --machine=container-b \
  --directory=/var/lib/machines/debian-test \
  --boot \
  --network-bridge=br-containers &

# Now containers can communicate via 10.0.100.0/24
# Each gets a unique MAC and can acquire DHCP address from host
```

---

## Section 5: Overlay Filesystems for Ephemeral Containers

This is the killer feature for testing: run disposable containers that discard all changes on exit.

### 5.1 Basic Overlay Container

```bash
# Run an ephemeral container using --overlay
# All writes go to a temporary directory and are discarded on exit
sudo systemd-nspawn \
  --machine=ephemeral-test \
  --directory=/var/lib/machines/debian-test \
  --overlay=+/:/tmp/overlay-upper:/ \
  /bin/bash

# Inside the container, install packages, make changes
apt-get install -y nginx
# These changes are written to /tmp/overlay-upper on the host,
# NOT to /var/lib/machines/debian-test

# When the container exits, /tmp/overlay-upper can be inspected or discarded
```

### 5.2 Persistent Overlay Layers

```bash
# Create a layered container with a persistent upper layer
OVERLAY_UPPER=/var/lib/container-overlays/webserver-layer
OVERLAY_WORK=/var/lib/container-overlays/webserver-work
mkdir -p "$OVERLAY_UPPER" "$OVERLAY_WORK"

sudo systemd-nspawn \
  --machine=webserver \
  --directory=/var/lib/machines/debian-test \
  --overlay=/var/lib/machines/debian-test:"$OVERLAY_UPPER":/ \
  --boot \
  --network-veth

# The base image is read-only; changes accumulate in OVERLAY_UPPER
# Multiple containers can share the same read-only base image
```

### 5.3 Ephemeral Containers via machinectl

```bash
# machinectl ephemeral creates a temporary copy of a machine
# that is deleted when the machine is powered off

# First, create a "template" machine
sudo machinectl clone debian-test debian-template

# Start an ephemeral clone
sudo machinectl clone debian-template test-run-001
sudo machinectl start test-run-001
machinectl shell test-run-001

# Do your testing...
# When done:
machinectl poweroff test-run-001
sudo machinectl remove test-run-001

# The template remains untouched
```

---

## Section 6: Resource Controls and Security

### 6.1 cgroup Resource Limits

```bash
# Limit CPU and memory for a container
sudo systemd-run \
  --machine=debian-test \
  --scope \
  -p CPUQuota=200% \
  -p MemoryMax=512M \
  -p TasksMax=100 \
  systemd-nspawn \
    --machine=debian-test \
    --directory=/var/lib/machines/debian-test \
    --boot \
    --network-veth

# Or configure limits in the .nspawn file
sudo cat > /etc/systemd/nspawn/debian-test.nspawn << 'EOF'
[Exec]
Boot=yes

[Network]
VirtualEthernet=yes

[Files]
Bind=/srv/data:/data
EOF

# Override systemd service resource limits
sudo systemctl edit systemd-nspawn@debian-test
# Add:
# [Service]
# CPUQuota=200%
# MemoryMax=512M
# TasksMax=200
```

### 6.2 Capability Restrictions

```bash
# Drop all capabilities except what's needed
sudo systemd-nspawn \
  --machine=restricted-container \
  --directory=/var/lib/machines/debian-test \
  --capability=CAP_NET_BIND_SERVICE \
  --drop-capability=CAP_SYS_ADMIN \
  --drop-capability=CAP_NET_ADMIN \
  /bin/bash

# Restrict syscalls with a seccomp filter
sudo systemd-nspawn \
  --machine=secure-container \
  --directory=/var/lib/machines/debian-test \
  --system-call-filter="@system-service @file-system" \
  --boot

# Available syscall groups:
# @aio, @basic-io, @chown, @clock, @cpu-emulation,
# @debug, @file-system, @io-event, @ipc, @keyring,
# @memlock, @module, @mount, @network-io, @obsolete,
# @pkey, @privileged, @process, @raw-io, @reboot,
# @resources, @sandbox, @setuid, @signal, @swap,
# @sync, @system-service, @timer
```

### 6.3 User Namespace Isolation

```bash
# Run container with unprivileged user namespaces
# UID/GID mapping is handled automatically
sudo systemd-nspawn \
  --machine=unprivileged \
  --directory=/var/lib/machines/debian-test \
  --private-users=pick \
  --private-users-ownership=chown \
  /bin/bash

# Check the UID mapping
cat /proc/self/uid_map
# 0  100000  65536   <- container UID 0 maps to host UID 100000

# With private users, the container root is unprivileged on the host
```

---

## Section 7: Practical Testing Workflows

### 7.1 Package Testing Script

```bash
#!/bin/bash
# test-package.sh - Test a package installation in an ephemeral container
set -euo pipefail

PACKAGE="${1:?Usage: $0 <package-name>}"
BASE_IMAGE="${2:-debian-base}"
MACHINE_NAME="test-${PACKAGE//[^a-zA-Z0-9]/-}-$$"

echo "Testing installation of $PACKAGE in ephemeral container $MACHINE_NAME"

# Clone base image
machinectl clone "$BASE_IMAGE" "$MACHINE_NAME"
trap "machinectl remove $MACHINE_NAME 2>/dev/null || true" EXIT

# Start the container
machinectl start "$MACHINE_NAME"

# Wait for it to be ready
for i in $(seq 1 30); do
    if machinectl shell "$MACHINE_NAME" -- /bin/true 2>/dev/null; then
        break
    fi
    sleep 1
done

# Run the installation test
machinectl shell "$MACHINE_NAME" -- bash -c "
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y $PACKAGE
    echo 'Installation successful'

    # Run basic sanity check
    if command -v $PACKAGE &>/dev/null; then
        $PACKAGE --version 2>&1 | head -1 || true
    fi
"

echo "Test completed for $PACKAGE"
machinectl poweroff "$MACHINE_NAME"
```

### 7.2 Integration Test Environment

```bash
#!/bin/bash
# setup-test-env.sh - Spin up a multi-container test environment

set -euo pipefail

BRIDGE="br-test-$$"
DB_MACHINE="test-db-$$"
API_MACHINE="test-api-$$"
BASE="/var/lib/machines/debian-base"

cleanup() {
    echo "Cleaning up..."
    machinectl poweroff "$API_MACHINE" 2>/dev/null || true
    machinectl poweroff "$DB_MACHINE" 2>/dev/null || true
    sleep 2
    machinectl remove "$API_MACHINE" 2>/dev/null || true
    machinectl remove "$DB_MACHINE" 2>/dev/null || true
    ip link del "$BRIDGE" 2>/dev/null || true
}
trap cleanup EXIT

# Create bridge
ip link add name "$BRIDGE" type bridge
ip addr add 10.99.0.1/24 dev "$BRIDGE"
ip link set "$BRIDGE" up
sysctl -w net.ipv4.ip_forward=1
iptables -t nat -A POSTROUTING -s 10.99.0.0/24 -j MASQUERADE

# Clone base images
machinectl clone debian-base "$DB_MACHINE"
machinectl clone debian-base "$API_MACHINE"

# Start database container
systemd-nspawn \
  --machine="$DB_MACHINE" \
  --directory="/var/lib/machines/$DB_MACHINE" \
  --boot \
  --network-bridge="$BRIDGE" \
  --bind-ro=/etc/resolv.conf &

# Start API container
systemd-nspawn \
  --machine="$API_MACHINE" \
  --directory="/var/lib/machines/$API_MACHINE" \
  --boot \
  --network-bridge="$BRIDGE" \
  --bind=/srv/api:/app \
  --bind-ro=/etc/resolv.conf &

# Wait for containers to boot
sleep 5

# Configure networking
machinectl shell "$DB_MACHINE" -- bash -c "
    ip addr add 10.99.0.10/24 dev host0
    ip route add default via 10.99.0.1
    apt-get install -y postgresql
    pg_ctlcluster 15 main start
"

machinectl shell "$API_MACHINE" -- bash -c "
    ip addr add 10.99.0.11/24 dev host0
    ip route add default via 10.99.0.1
    cd /app && ./run-tests.sh --db-host=10.99.0.10
"

echo "Tests complete"
```

### 7.3 CI/CD Integration

```yaml
# .gitlab-ci.yml
integration-test:
  stage: test
  tags:
    - linux
    - privileged
  script:
    - |
      # Ensure base image exists
      if ! machinectl list | grep -q debian-base; then
        debootstrap bookworm /var/lib/machines/debian-base
      fi

      # Run tests in ephemeral container
      MACHINE="ci-test-$CI_JOB_ID"
      machinectl clone debian-base $MACHINE

      systemd-nspawn \
        --machine=$MACHINE \
        --directory=/var/lib/machines/$MACHINE \
        --bind=$CI_PROJECT_DIR:/workspace \
        --setenv=CI=true \
        --setenv=CI_COMMIT_SHA=$CI_COMMIT_SHA \
        /bin/bash -c "
          cd /workspace
          apt-get update -qq
          apt-get install -y make curl
          make test
        "

      machinectl remove $MACHINE
  after_script:
    - machinectl remove "ci-test-$CI_JOB_ID" || true
```

---

## Section 8: Advanced Features

### 8.1 Shared Memory and IPC

```bash
# Share /tmp between containers for IPC testing
sudo systemd-nspawn \
  --machine=ipc-test-a \
  --directory=/var/lib/machines/debian-test \
  --bind=/run/shared-ipc:/tmp/shared \
  /bin/bash

sudo systemd-nspawn \
  --machine=ipc-test-b \
  --directory=/var/lib/machines/debian-test \
  --bind=/run/shared-ipc:/tmp/shared \
  /bin/bash

# Containers can now communicate via files in /tmp/shared
```

### 8.2 Filesystem Bind Mounts

```bash
# Comprehensive bind mount example
sudo systemd-nspawn \
  --machine=dev-container \
  --directory=/var/lib/machines/debian-test \
  --bind=/home/user/projects:/projects \         # R/W project files
  --bind-ro=/etc/ssl/certs:/etc/ssl/certs \      # Share host TLS certs
  --bind-ro=/usr/local/share/ca-certificates \   # CA certs
  --bind=/dev/null:/etc/machine-id \             # Avoid machine-id conflicts
  --tmpfs=/tmp \                                  # Ephemeral /tmp
  --tmpfs=/run \                                  # Ephemeral /run
  /bin/bash
```

### 8.3 Running Containers Without Root

```bash
# Rootless systemd-nspawn (requires kernel 4.9+)
# Set up subordinate UID/GID mappings
echo "user:100000:65536" | sudo tee -a /etc/subuid
echo "user:100000:65536" | sudo tee -a /etc/subgid

# Create container directory owned by user
mkdir -p ~/containers/debian-test
# ... bootstrap the container as root, then chown ...

# Run as current user
systemd-nspawn \
  --machine=my-container \
  --directory=$HOME/containers/debian-test \
  --private-users=0:100000:65536 \
  /bin/bash
```

### 8.4 Inspecting Container Internals

```bash
# List running machines
machinectl list

# Show detailed machine status
machinectl status debian-test

# Show processes running in a container (from host)
machinectl list-images

# Copy files into/out of a running container
machinectl copy-to debian-test /local/file /remote/path
machinectl copy-from debian-test /remote/path /local/file

# Open a shell in a running container
machinectl shell debian-test

# Execute a specific command
machinectl shell debian-test -- journalctl -n 50 -u nginx

# Show container journal from host
journalctl -M debian-test -n 100
journalctl -M debian-test -u nginx --follow

# Show resource usage
systemd-cgtop -M debian-test

# Show network interfaces in a running container
nsenter -t $(machinectl show debian-test -p Leader --value) -n ip addr
```

---

## Section 9: machinectl Image Management

### 9.1 Image Operations

```bash
# List all images
machinectl list-images

# Show image details
machinectl image-status debian-test

# Clone an image (copy-on-write with btrfs, plain copy otherwise)
machinectl clone debian-base debian-test-2

# Rename an image
machinectl rename debian-test debian-test-renamed

# Mark an image as read-only (template)
machinectl read-only debian-base yes

# Remove an image
machinectl remove old-container

# Export an image as a tar archive
machinectl export-tar debian-base debian-base.tar.xz

# Import an image
machinectl import-tar ubuntu-base.tar.xz ubuntu-base

# Show image disk usage
du -sh /var/lib/machines/*
```

### 9.2 Using btrfs for Efficient Image Management

When `/var/lib/machines` is on a btrfs filesystem, machinectl uses subvolumes and COW cloning for near-instantaneous image creation:

```bash
# Create btrfs filesystem for container images (example with a loopback device)
dd if=/dev/null of=/var/lib/machines.img bs=1 count=0 seek=50G
mkfs.btrfs /var/lib/machines.img
mount -o loop,compress=zstd /var/lib/machines.img /var/lib/machines

# Or use a dedicated partition/LV
mkfs.btrfs /dev/sdb1
mount -o compress=zstd /dev/sdb1 /var/lib/machines

# Create base image as btrfs subvolume
btrfs subvolume create /var/lib/machines/debian-base
debootstrap bookworm /var/lib/machines/debian-base

# machinectl clone now uses btrfs snapshot (instant)
machinectl clone debian-base test-$(date +%s)
```

---

## Section 10: Comparison with Other Container Runtimes

| Feature | systemd-nspawn | Docker | LXC | Podman |
|---------|---------------|--------|-----|--------|
| Init system | Full systemd | Limited | Full | Limited |
| Daemon required | No | Yes | No | No |
| Root required | No (with user ns) | No (rootless) | No | No |
| Network modes | VEth, Bridge, MACVLAN | Bridge, Host, MACVLAN | VEth, Bridge | Bridge, Host |
| Overlay FS | Yes | Yes | Yes | Yes |
| OCI images | Via machinectl | Native | No | Native |
| Windows support | No | Yes | No | Limited |
| Resource control | cgroups v2 | cgroups v2 | cgroups v2 | cgroups v2 |
| Best for | System testing, dev | App containers | System containers | App containers |

---

## Summary

systemd-nspawn fills a unique niche in the container ecosystem: it provides OS-level isolation with full systemd integration, zero daemon overhead, and excellent tooling through machinectl. Key use cases where it excels over Docker/Podman:

1. **Integration testing requiring full OS init** — test service startup sequences, systemd timers, and daemons
2. **Package installation testing** — ephemeral overlay containers make this trivial
3. **Development environments** — bind-mount your project into a clean OS environment
4. **Multi-OS testing** — easily test the same code against Debian, Ubuntu, and Rocky Linux simultaneously
5. **Minimal overhead** — no daemon, direct kernel interface, lower memory overhead than Docker

The combination of overlay filesystems, ephemeral clones via machinectl, and deep systemd integration makes systemd-nspawn an excellent tool for any team doing serious Linux system or service development.
