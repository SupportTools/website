---
title: "Linux Networking Deep Dive: DPDK, SR-IOV, and Kernel Bypass for Line-Rate Processing"
date: 2030-02-08T00:00:00-05:00
draft: false
tags: ["Linux", "DPDK", "SR-IOV", "Networking", "Performance", "Kernel Bypass", "OVS-DPDK", "High Performance"]
categories: ["Linux", "Networking"]
author: "Matthew Mattox - mmattox@support.tools"
description: "High-performance networking with DPDK for kernel bypass, SR-IOV for direct hardware access in VMs and containers, OVS-DPDK integration, and benchmarking with MoonGen and TRex for line-rate packet processing."
more_link: "yes"
url: "/linux-networking-dpdk-sriov-kernel-bypass/"
---

Modern network interfaces operate at 25, 100, or 400 Gbps — rates that overwhelm the Linux kernel's networking stack if packets are processed using the standard interrupt-driven model. At 100 Gbps with 64-byte packets, the network delivers approximately 150 million packets per second. Each packet processed through the kernel requires a context switch, cache invalidation, and memory copy. The Linux kernel is genuinely excellent at networking, but not at these rates with per-packet interrupt overhead.

DPDK (Data Plane Development Kit) bypasses the kernel entirely, polling the NIC directly from userspace. SR-IOV (Single Root I/O Virtualization) allows hardware NIC functions to be directly assigned to VMs and containers, eliminating the software switching overhead. This guide covers both technologies at the production deployment level, including OVS-DPDK for software-defined networking at line rate, and the benchmarking tools needed to verify performance.

<!--more-->

## Understanding the Performance Problem

Standard Linux networking processes packets through a chain: NIC interrupt, driver ISR, softirq, socket buffer copy, system call, application. At low packet rates, this overhead is invisible. At 10+ Gbps with small packets, it becomes the bottleneck.

**Interrupt coalescing** reduces interrupt frequency by batching packets, but this adds latency. **Busy polling** (`SO_BUSY_POLL`) eliminates interrupts entirely for a socket but still involves system call overhead and memory copies.

DPDK eliminates the OS from the data path entirely:

```
DPDK Application
     |
NIC Driver (PMD - Poll Mode Driver)
     |
Physical NIC
```

The application polls the NIC's receive ring directly, processes packets entirely in userspace, and writes to the transmit ring directly. No interrupts, no system calls, no kernel networking stack.

## Hardware Requirements and BIOS Configuration

```bash
# Verify hardware capabilities
lscpu | grep -E "NUMA|CPU\(s\)|Socket"
lspci | grep "Ethernet"

# Check if IOMMU is enabled (required for DPDK and SR-IOV)
dmesg | grep -i iommu
# [    0.000000] DMAR: IOMMU enabled
# OR
# [    0.000000] AMD-Vi: AMD IOMMUv2 loaded and initialized

# Enable IOMMU in GRUB (Intel)
# GRUB_CMDLINE_LINUX="intel_iommu=on iommu=pt default_hugepagesz=1G hugepagesz=1G hugepages=32 isolcpus=2-7,10-15 nohz_full=2-7,10-15 rcu_nocbs=2-7,10-15"

# Enable IOMMU in GRUB (AMD)
# GRUB_CMDLINE_LINUX="amd_iommu=on iommu=pt default_hugepagesz=1G hugepagesz=1G hugepages=32 isolcpus=2-7,10-15"

# Apply and reboot
grub2-mkconfig -o /boot/grub2/grub.cfg
reboot

# After reboot, verify
cat /proc/cmdline | grep iommu
dmesg | grep -i "iommu\|DMAR"
```

### Hugepage Configuration

DPDK requires hugepages to avoid TLB thrashing on large packet buffers:

```bash
# Check current hugepage status
cat /proc/meminfo | grep -i huge
# HugePages_Total:      32
# HugePages_Free:       30
# Hugepagesize:       1048576 kB

# Allocate hugepages at runtime
echo 32 > /sys/kernel/mm/hugepages/hugepages-1048576kB/nr_hugepages

# For NUMA systems, allocate per-node
echo 16 > /sys/devices/system/node/node0/hugepages/hugepages-1048576kB/nr_hugepages
echo 16 > /sys/devices/system/node/node1/hugepages/hugepages-1048576kB/nr_hugepages

# Mount the hugepage filesystem
mkdir -p /mnt/huge
mount -t hugetlbfs nodev /mnt/huge

# Make persistent
echo 'nodev /mnt/huge hugetlbfs defaults 0 0' >> /etc/fstab
echo 'vm.nr_hugepages = 32' >> /etc/sysctl.d/99-hugepages.conf
```

## Installing DPDK

```bash
# Install dependencies
dnf install -y meson ninja-build python3-pyelftools numactl-devel \
  libpcap-devel openssl-devel zlib-devel \
  kernel-devel-$(uname -r) rdma-core-devel

# Download and build DPDK
wget https://fast.dpdk.org/rel/dpdk-23.11.tar.xz
tar xf dpdk-23.11.tar.xz
cd dpdk-23.11

# Configure build
meson setup build \
  --prefix=/usr/local \
  -Dplatform=generic \
  -Ddefault_library=shared \
  -Denable_kmods=true

# Build and install
ninja -C build -j$(nproc)
ninja -C build install
ldconfig

# Set up environment
export RTE_SDK=/opt/dpdk
export RTE_TARGET=x86_64-native-linux-gcc
echo 'export RTE_SDK=/opt/dpdk' >> /etc/profile.d/dpdk.sh
```

### Binding NICs to DPDK-Compatible Drivers

```bash
# List all NICs and their current drivers
dpdk-devbind.py --status

# Network devices using kernel drivers
# ============================================
# 0000:01:00.0 'Ethernet Controller X710' drv=i40e unused=vfio-pci
# 0000:01:00.1 'Ethernet Controller X710' drv=i40e unused=vfio-pci

# Load vfio-pci driver (preferred over igb_uio)
modprobe vfio-pci

# Unbind NIC from kernel driver
dpdk-devbind.py -u 0000:01:00.1

# Bind to vfio-pci for DPDK use
dpdk-devbind.py -b vfio-pci 0000:01:00.1

# Verify
dpdk-devbind.py --status | grep vfio
# 0000:01:00.1 'Ethernet Controller X710' drv=vfio-pci unused=i40e

# Make persistent across reboots
cat > /etc/udev/rules.d/99-dpdk.rules << 'EOF'
ACTION=="add", SUBSYSTEM=="net", ATTR{address}=="00:11:22:33:44:55", \
  RUN+="/usr/local/bin/dpdk-bind.sh %k"
EOF
```

## DPDK Application Development

### Basic DPDK Initialization

```c
// src/main.c - DPDK L2 forwarding application
#include <stdio.h>
#include <stdint.h>
#include <inttypes.h>
#include <rte_eal.h>
#include <rte_ethdev.h>
#include <rte_mbuf.h>
#include <rte_cycles.h>
#include <rte_lcore.h>

#define RX_RING_SIZE    1024
#define TX_RING_SIZE    1024
#define NUM_MBUFS       8192
#define MBUF_CACHE_SIZE 250
#define BURST_SIZE      32

static const struct rte_eth_conf port_conf_default = {
    .rxmode = {
        .max_lro_pkt_size = RTE_ETHER_MAX_LEN,
        .offloads = RTE_ETH_RX_OFFLOAD_CHECKSUM,
    },
    .txmode = {
        .mq_mode = RTE_ETH_MQ_TX_NONE,
        .offloads = RTE_ETH_TX_OFFLOAD_IPV4_CKSUM |
                    RTE_ETH_TX_OFFLOAD_TCP_CKSUM |
                    RTE_ETH_TX_OFFLOAD_UDP_CKSUM,
    },
};

struct lcore_stats {
    uint64_t rx_packets;
    uint64_t tx_packets;
    uint64_t dropped;
} __attribute__((aligned(64)));

static struct lcore_stats stats[RTE_MAX_LCORE];

/* Initialize a DPDK port */
static int port_init(uint16_t port, struct rte_mempool *mbuf_pool)
{
    struct rte_eth_conf port_conf = port_conf_default;
    const uint16_t rx_rings = 1, tx_rings = 1;
    int retval;
    uint16_t q;
    struct rte_eth_dev_info dev_info;

    if (!rte_eth_dev_is_valid_port(port))
        return -1;

    retval = rte_eth_dev_info_get(port, &dev_info);
    if (retval != 0)
        return retval;

    /* Enable RSS for multi-queue */
    if (dev_info.rx_offload_capa & RTE_ETH_RX_OFFLOAD_RSS_HASH) {
        port_conf.rxmode.offloads |= RTE_ETH_RX_OFFLOAD_RSS_HASH;
    }

    /* Configure the Ethernet device */
    retval = rte_eth_dev_configure(port, rx_rings, tx_rings, &port_conf);
    if (retval != 0)
        return retval;

    /* Allocate and set up RX queues */
    for (q = 0; q < rx_rings; q++) {
        retval = rte_eth_rx_queue_setup(
            port, q, RX_RING_SIZE,
            rte_eth_dev_socket_id(port),
            NULL, mbuf_pool
        );
        if (retval < 0)
            return retval;
    }

    /* Allocate and set up TX queues */
    struct rte_eth_txconf txconf = dev_info.default_txconf;
    txconf.offloads = port_conf.txmode.offloads;

    for (q = 0; q < tx_rings; q++) {
        retval = rte_eth_tx_queue_setup(
            port, q, TX_RING_SIZE,
            rte_eth_dev_socket_id(port),
            &txconf
        );
        if (retval < 0)
            return retval;
    }

    /* Start the Ethernet port */
    retval = rte_eth_dev_start(port);
    if (retval < 0)
        return retval;

    /* Enable promiscuous mode */
    rte_eth_promiscuous_enable(port);

    return 0;
}

/* Main packet processing loop - runs on each worker lcore */
static int lcore_main(void *arg __rte_unused)
{
    uint16_t port;
    unsigned lcore_id = rte_lcore_id();
    struct lcore_stats *s = &stats[lcore_id];

    printf("Core %u forwarding packets\n", lcore_id);

    /* Check that the port is on the same NUMA node as the lcore */
    RTE_ETH_FOREACH_DEV(port) {
        if (rte_eth_dev_socket_id(port) >= 0 &&
            rte_eth_dev_socket_id(port) != (int)rte_socket_id()) {
            printf("WARNING: port %u is on different NUMA node than lcore %u\n",
                   port, lcore_id);
        }
    }

    /* Main work loop - poll both ports */
    for (;;) {
        RTE_ETH_FOREACH_DEV(port) {
            struct rte_mbuf *bufs[BURST_SIZE];

            /* Receive a burst of packets */
            const uint16_t nb_rx = rte_eth_rx_burst(port, 0, bufs, BURST_SIZE);

            if (unlikely(nb_rx == 0))
                continue;

            s->rx_packets += nb_rx;

            /* Process packets - example: L2 forward to opposite port */
            uint16_t out_port = port ^ 1;

            /* Transmit to the other port */
            const uint16_t nb_tx = rte_eth_tx_burst(out_port, 0, bufs, nb_rx);
            s->tx_packets += nb_tx;

            /* Free any unsent packets */
            if (unlikely(nb_tx < nb_rx)) {
                uint16_t buf;
                for (buf = nb_tx; buf < nb_rx; buf++) {
                    rte_pktmbuf_free(bufs[buf]);
                    s->dropped++;
                }
            }
        }
    }
    return 0;
}

int main(int argc, char *argv[])
{
    struct rte_mempool *mbuf_pool;
    uint16_t nb_ports;

    /* Initialize the EAL */
    int ret = rte_eal_init(argc, argv);
    if (ret < 0)
        rte_exit(EXIT_FAILURE, "EAL initialization failed\n");

    argc -= ret;
    argv += ret;

    nb_ports = rte_eth_dev_count_avail();
    if (nb_ports < 2)
        rte_exit(EXIT_FAILURE, "Need at least 2 Ethernet ports\n");

    /* Create memory pool for packet buffers */
    mbuf_pool = rte_pktmbuf_pool_create(
        "MBUF_POOL",
        NUM_MBUFS * nb_ports,
        MBUF_CACHE_SIZE,
        0,
        RTE_MBUF_DEFAULT_BUF_SIZE,
        rte_socket_id()
    );
    if (mbuf_pool == NULL)
        rte_exit(EXIT_FAILURE, "Cannot create mbuf pool\n");

    /* Initialize all ports */
    uint16_t portid;
    RTE_ETH_FOREACH_DEV(portid) {
        if (port_init(portid, mbuf_pool) != 0)
            rte_exit(EXIT_FAILURE, "Cannot init port %u\n", portid);
    }

    /* Launch main loop on worker lcores */
    rte_eal_mp_remote_launch(lcore_main, NULL, SKIP_MAIN);

    /* Stats loop on main lcore */
    for (;;) {
        uint64_t total_rx = 0, total_tx = 0, total_drop = 0;
        unsigned lcore;
        RTE_LCORE_FOREACH_WORKER(lcore) {
            total_rx += stats[lcore].rx_packets;
            total_tx += stats[lcore].tx_packets;
            total_drop += stats[lcore].dropped;
        }
        printf("RX: %"PRIu64" TX: %"PRIu64" DROP: %"PRIu64"\n",
               total_rx, total_tx, total_drop);
        rte_delay_ms(1000);
    }

    return 0;
}
```

### Building the DPDK Application

```makefile
# Makefile
APP = l2fwd
SRCS = src/main.c

PKGCONF ?= pkg-config
PC_FILE := $(shell $(PKGCONF) --path libdpdk 2>/dev/null)
CFLAGS += -O3 $(shell $(PKGCONF) --cflags libdpdk)
LDFLAGS += $(shell $(PKGCONF) --libs libdpdk)

CFLAGS += -DALLOW_EXPERIMENTAL_API

$(APP): $(SRCS)
	$(CC) $(CFLAGS) $^ -o $@ $(LDFLAGS)

clean:
	rm -f $(APP)
```

```bash
# Build and run
make

# Run on CPUs 2-7, with port 0000:01:00.0 and 0000:01:00.1
./l2fwd \
  -l 2-7 \
  -n 4 \
  --socket-mem 1024,1024 \
  -a 0000:01:00.0 \
  -a 0000:01:00.1 \
  -- \
  -p 0x3 \
  -T 10 \
  --no-mac-updating
```

## SR-IOV Configuration

SR-IOV creates multiple Virtual Functions (VFs) from a single Physical Function (PF). Each VF appears as a separate PCIe device that can be assigned directly to a VM or container.

```bash
# Check SR-IOV capability
lspci -vvv -s 0000:01:00.0 | grep -A 10 "Single Root I/O"
# Single Root I/O Virtualization (SR-IOV)
#     IOVCap: Migration+, Interrupt Message Number: 000
#     IOVCtl: Enable- Migration- Interrupt- MSE- ARIHierarchy+
#     IOVSta: Migration-
#     Initial VFs: 64, Total VFs: 64, Number of VFs: 0
#     Supported Page Size: 00000553
#     System Page Size: 00000001

# Create 8 VFs on the NIC
echo 8 > /sys/bus/pci/devices/0000:01:00.0/sriov_numvfs

# Verify VFs were created
ip link show | grep "vf"
# 6: enp1s0f0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500
#    vf 0     link/ether 00:11:22:33:44:50 brd ff:ff:ff:ff:ff:ff
#    vf 1     link/ether 00:11:22:33:44:51 brd ff:ff:ff:ff:ff:ff
#    ...

# List VF PCI devices
lspci | grep "Virtual Function"
# 0000:01:10.0 Ethernet controller: Intel Corporation XL710/X710 Virtual Function
# 0000:01:10.2 Ethernet controller: Intel Corporation XL710/X710 Virtual Function
# ...

# Set rate limiting per VF (in Mbps)
ip link set enp1s0f0 vf 0 rate 10000   # Limit VF0 to 10 Gbps
ip link set enp1s0f0 vf 1 rate 5000    # Limit VF1 to 5 Gbps

# Set MAC address for VF
ip link set enp1s0f0 vf 0 mac 00:11:22:33:44:50

# Enable trusted mode (allows VF to change its own MAC)
ip link set enp1s0f0 vf 0 trust on
```

### SR-IOV in Kubernetes with SR-IOV Network Device Plugin

```bash
# Install the SR-IOV Network Device Plugin
kubectl apply -f https://raw.githubusercontent.com/k8s-sigs/sriov-network-device-plugin/master/deployments/k8s-v1.16/sriovdp-daemonset.yaml

# Configure the device plugin for Intel X710 NICs
cat > sriov-config.yaml <<'EOF'
apiVersion: v1
kind: ConfigMap
metadata:
  name: sriovdp-config
  namespace: kube-system
data:
  config.json: |
    {
      "resourceList": [
        {
          "resourceName": "intel_sriov_dpdk",
          "resourcePrefix": "intel.com",
          "selectors": {
            "vendors": ["8086"],
            "devices": ["154c", "10ed"],
            "drivers": ["vfio-pci"],
            "pfNames": ["enp1s0f0#0-7"]
          }
        },
        {
          "resourceName": "intel_sriov_netdevice",
          "resourcePrefix": "intel.com",
          "selectors": {
            "vendors": ["8086"],
            "devices": ["154c", "10ed"],
            "drivers": ["i40evf", "iavf"],
            "pfNames": ["enp1s0f1#0-7"]
          }
        }
      ]
    }
EOF
kubectl apply -f sriov-config.yaml
```

```yaml
# Pod using SR-IOV VF directly
apiVersion: v1
kind: Pod
metadata:
  name: dpdk-app
  namespace: high-perf
  annotations:
    k8s.v1.cni.cncf.io/networks: sriov-dpdk-net
spec:
  containers:
    - name: dpdk-app
      image: registry.internal/dpdk-app:23.11
      command: ["/bin/dpdk-testpmd"]
      args:
        - "-l"
        - "2-5"
        - "-n"
        - "4"
        - "--"
        - "-i"
        - "--nb-cores=4"
      resources:
        requests:
          cpu: "8"
          memory: "4Gi"
          hugepages-1Gi: "4Gi"
          intel.com/intel_sriov_dpdk: "1"
        limits:
          cpu: "8"
          memory: "4Gi"
          hugepages-1Gi: "4Gi"
          intel.com/intel_sriov_dpdk: "1"
      securityContext:
        capabilities:
          add:
            - IPC_LOCK
            - SYS_RAWIO
            - NET_ADMIN
      volumeMounts:
        - name: hugepages
          mountPath: /dev/hugepages
        - name: dev
          mountPath: /dev
  volumes:
    - name: hugepages
      emptyDir:
        medium: HugePages
    - name: dev
      hostPath:
        path: /dev
```

## OVS-DPDK Integration

Open vSwitch with DPDK (OVS-DPDK) provides software-defined networking at near-line-rate speeds. It is used by OpenStack, KVM hypervisors, and NFV deployments.

```bash
# Install OVS with DPDK support
dnf install openvswitch-dpdk

# Configure OVS to use DPDK
ovs-vsctl --no-wait set Open_vSwitch . \
  other_config:dpdk-init=true \
  other_config:dpdk-socket-mem="1024,1024" \
  other_config:dpdk-lcore-mask=0x3fc \
  other_config:pmd-cpu-mask=0x3fc

# Start OVS services
systemctl start openvswitch
systemctl enable openvswitch

# Create an OVS bridge with DPDK datapath
ovs-vsctl add-br br-dpdk -- \
  set Bridge br-dpdk \
  datapath_type=netdev

# Add a DPDK physical port
ovs-vsctl add-port br-dpdk dpdk0 -- \
  set Interface dpdk0 \
  type=dpdk \
  options:dpdk-devargs=0000:01:00.0

# Add a DPDK physical port for the second NIC
ovs-vsctl add-port br-dpdk dpdk1 -- \
  set Interface dpdk1 \
  type=dpdk \
  options:dpdk-devargs=0000:01:00.1

# Add VirtIO ports for VMs
ovs-vsctl add-port br-dpdk vhost-user-1 -- \
  set Interface vhost-user-1 \
  type=dpdkvhostuser

# Set number of PMD threads (one per RX queue)
ovs-vsctl set Open_vSwitch . \
  other_config:n-dpdk-rxqs=2

# Configure RSS queues per port
ovs-vsctl set Interface dpdk0 \
  options:n_rxq=4

# Verify OVS-DPDK configuration
ovs-vsctl show
ovs-appctl dpif-netdev/pmd-stats-show
```

### OVS Flow Rules

```bash
# Add L2 forwarding rules
ovs-ofctl add-flow br-dpdk "in_port=1,actions=output:2"
ovs-ofctl add-flow br-dpdk "in_port=2,actions=output:1"

# Add VLAN tagging for tenant isolation
ovs-ofctl add-flow br-dpdk \
  "in_port=dpdk0,vlan_tci=0x0000/0x1fff,actions=push_vlan:0x8100,mod_vlan_vid:100,output:dpdk1"

# Dump flows
ovs-ofctl dump-flows br-dpdk

# Monitor OVS-DPDK performance
ovs-appctl dpif-netdev/pmd-stats-show
# pmd thread numa_id 0 core_id 2:
#   packets received: 15234567
#   packet recirculations: 0
#   avg. datapath passes per packet: 1.00
#   emc hits: 14987234
#   megaflow hits: 245678
#   miss with success upcall: 1655
#   miss with failed upcall: 0
#   avg. packets per output batch: 30.45
```

## Benchmarking with TRex

TRex is a stateful and stateless traffic generator built on DPDK. It is the standard tool for network performance testing.

```bash
# Install TRex
wget https://trex-tgn.cisco.com/trex/release/latest_release
tar xf latest.tar.gz
cd v3.04

# Configure TRex for the NICs
cat > /etc/trex_cfg.yaml << 'EOF'
- version : 2
  interfaces: ["0000:01:00.0", "0000:01:00.1"]
  port_limit: 2
  enable_zmq_pub: true
  c: 8
  platform:
    master_thread_id: 0
    latency_thread_id: 1
    dual_if:
      - socket: 0
        threads: [2, 3, 4, 5, 6, 7, 8, 9]
EOF

# Run stateless benchmark
./t-rex-64 -f cap2/dns.yaml -c 8 -m 100 -d 60 --nc

# Run with Python API for automated testing
python3 - << 'PYEOF'
from trex_stl_lib.api import *
import time

c = STLClient(server='localhost')
c.connect()
c.reset(ports=[0, 1])

# Create traffic stream
base_pkt = Ether() / IP(src="192.168.1.1", dst="192.168.2.1") / UDP(dport=5000)
pad = max(0, 60 - len(base_pkt)) * 'x'
pkt = STLPktBuilder(pkt=base_pkt / pad)
stream = STLStream(packet=pkt, mode=STLTXCont(pps=10e6))  # 10Mpps

c.add_streams(stream, ports=[0])
c.start(ports=[0], duration=30)
c.wait_on_traffic(ports=[0])

stats = c.get_stats()
print(f"RX: {stats[1]['ipackets']:,} pps, TX: {stats[0]['opackets']:,} pps")
print(f"Throughput: {stats[0]['obytes'] * 8 / 30 / 1e9:.2f} Gbps")

c.disconnect()
PYEOF
```

### MoonGen for Precision Traffic Generation

```lua
-- moongen-l3-load.lua
-- Generate L3 traffic at precise rates using hardware timestamping

local mg     = require "moongen"
local memory = require "memory"
local device = require "device"
local ts     = require "timestamping"
local hist   = require "histogram"
local stats  = require "stats"
local log    = require "log"
local pcap   = require "pcap"
local pkt    = require "packet"

local PKT_SIZE = 64

function master(txPort, rxPort, rate)
    local txDev = device.config{port = txPort, rxQueues = 2, txQueues = 2}
    local rxDev = device.config{port = rxPort, rxQueues = 2, txQueues = 2}
    device.waitForLinks()

    -- Measure throughput
    stats.startStatsTask{devices = {txDev, rxDev}}

    -- TX worker
    mg.startTask("txWorker", txDev:getTxQueue(0), rate)

    -- RX + latency measurement worker
    mg.startTask("rxWorker", rxDev:getRxQueue(0))

    mg.waitForTasks()
end

function txWorker(queue, rate)
    local mempool = memory.createMemPool(function(buf)
        buf:getEthernetPacket():fill{
            ethSrc = queue,
            ethDst = "ff:ff:ff:ff:ff:ff",
            ethType = 0x0800,
        }
        local ipPkt = buf:getIPPacket()
        ipPkt.ip:setDst("192.168.0.1")
        ipPkt.ip:setSrc("10.0.0.1")
        buf:setSize(PKT_SIZE)
    end)

    local bufs = mempool:bufArray()
    local txCtr = stats:newDevTxCounter(queue, "plain")

    while mg.running() do
        bufs:alloc(PKT_SIZE)
        -- Set rate in Mbit/s
        bufs:setRate(rate)
        queue:send(bufs)
        txCtr:update()
    end
    txCtr:finalize()
end

function rxWorker(queue)
    local bufs = memory.bufArray()
    local rxCtr = stats:newDevRxCounter(queue, "plain")
    while mg.running() do
        local rx = queue:recv(bufs)
        rxCtr:update(rx)
        bufs:freeAll()
    end
    rxCtr:finalize()
end
```

```bash
# Run MoonGen benchmark
./build/MoonGen moongen-l3-load.lua 0 1 10000  # 10 Gbps line rate
```

## Performance Tuning

### CPU Affinity and NUMA Alignment

```bash
# Pin DPDK processes to specific CPUs
taskset -c 2-7 ./dpdk-app \
  -l 2-7 \
  -n 4 \
  --socket-mem 2048,2048

# Verify NUMA alignment
numactl --hardware
numactl --membind=0 --cpunodebind=0 ./dpdk-app

# Disable hyperthreading for deterministic latency
echo off > /sys/devices/system/cpu/smt/control

# Set CPU governor to performance
for cpu in /sys/devices/system/cpu/cpu[2-7]/cpufreq/scaling_governor; do
  echo performance > $cpu
done

# Disable C-states for lowest latency
for state in /sys/devices/system/cpu/cpu*/cpuidle/state*/disable; do
  echo 1 > $state 2>/dev/null
done
```

### NIC Queue Tuning

```bash
# Set optimal ring sizes
ethtool -G enp1s0f0 rx 4096 tx 4096

# Disable interrupt coalescing (use adaptive coalescing for balance)
ethtool -C enp1s0f0 adaptive-rx off adaptive-tx off \
  rx-usecs 0 rx-frames 1 \
  tx-usecs 0 tx-frames 1

# Enable flow control
ethtool -A enp1s0f0 rx on tx on

# Set channel count
ethtool -L enp1s0f0 combined 8

# Verify final settings
ethtool -l enp1s0f0
ethtool -g enp1s0f0
ethtool -c enp1s0f0
```

## Key Takeaways

**Hugepages are non-optional**: DPDK cannot function without hugepages. Allocate them at boot time through the kernel command line rather than at runtime to guarantee contiguous physical memory regions. Use 1GB hugepages for bulk memory pools, 2MB hugepages for smaller allocations.

**NUMA awareness is critical**: A DPDK application using memory from a different NUMA node than the NIC will experience severe performance degradation due to PCIe transactions crossing the inter-socket interconnect. Always verify NUMA alignment with `dpdk-devbind.py --status` and the `rte_eth_dev_socket_id()` API.

**SR-IOV versus VirtIO**: SR-IOV provides lower latency and higher throughput than any software-based forwarding path. When running DPDK workloads in VMs or containers, SR-IOV VFs directly assigned to the guest eliminate the vSwitch overhead entirely. The tradeoff is operational complexity in VF lifecycle management.

**OVS-DPDK for multi-tenant scenarios**: When you need both SR-IOV performance and network policy enforcement (VLANs, ACLs, tunneling), OVS-DPDK provides the best balance. The DPDK PMD in OVS handles the fast path, while the kernel OVS handles slow-path policy decisions.

**TRex for production validation**: Never deploy a DPDK-based network function without validating its throughput and latency under real traffic patterns with TRex. Test at multiple packet sizes (64B, 128B, 512B, 1500B) since small packets are always the worst case for packets-per-second limits.
