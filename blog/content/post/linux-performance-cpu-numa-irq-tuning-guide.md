---
title: "Linux Performance Tuning: CPU Pinning, NUMA Awareness, IRQ Affinity, and Kernel Bypass Networking"
date: 2028-07-06T00:00:00-05:00
draft: false
tags: ["Linux", "Performance", "CPU", "NUMA", "IRQ", "Kernel"]
categories:
- Linux
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep-dive guide to Linux performance tuning covering CPU pinning with cgroups and taskset, NUMA topology optimization, IRQ affinity management, and DPDK-based kernel bypass networking for latency-sensitive workloads."
more_link: "yes"
url: "/linux-performance-cpu-numa-irq-tuning-guide/"
---

The gap between a Linux system's peak capability and what most production workloads achieve is measured in the quality of its tuning. A poorly configured 64-core server can lose 30-40% of its theoretical throughput to NUMA misses, cache bouncing, and IRQ storms. A well-tuned system on the same hardware can sustain microsecond-level latency under millions of requests per second.

This guide covers the four pillars of Linux performance tuning: CPU pinning for workload isolation, NUMA-aware memory allocation, IRQ affinity management to eliminate interrupt contention, and kernel bypass networking with DPDK for applications that need to push past the kernel's own overhead. These techniques are used in trading systems, real-time streaming, and high-frequency API gateways where every microsecond matters.

<!--more-->

# Linux Performance Tuning: CPU Pinning, NUMA, IRQ, and Kernel Bypass

## Section 1: Understanding the Hardware Topology

Before tuning anything, you need an accurate picture of your system's topology:

```bash
# Full topology report
lstopo --output-format console

# Compact topology
lscpu

# NUMA topology
numactl --hardware

# CPU topology details
cat /proc/cpuinfo | grep -E "processor|physical id|core id|cpu MHz" | head -40

# Cache topology
getconf -a | grep -i cache

# Detailed NUMA info
cat /sys/devices/system/node/node*/meminfo
ls /sys/devices/system/node/

# Check for hyperthreading
grep -c processor /proc/cpuinfo  # Total logical CPUs
cat /sys/devices/system/cpu/cpu0/topology/core_id  # Physical core IDs
```

On a typical 2-socket server with 32 physical cores and hyperthreading enabled (128 logical CPUs):

```
Socket 0: CPUs 0-31, 64-95   (cores 0-31 and their HT siblings)
Socket 1: CPUs 32-63, 96-127 (cores 32-63 and their HT siblings)
NUMA Node 0: Socket 0 + local memory
NUMA Node 1: Socket 1 + local memory
```

NUMA cross-socket memory access adds approximately 40-100ns compared to local memory access. At high throughput, this compounds into measurable latency degradation.

## Section 2: CPU Pinning with taskset and numactl

### Basic CPU Pinning with taskset

```bash
# Pin a process to specific CPUs (CPUs 0, 1, 2, 3)
taskset -c 0-3 ./my-application

# Pin a running process
taskset -cp 0-3 $(pgrep my-application)

# Check current affinity
taskset -cp $(pgrep my-application)

# Pin with bitmask (binary: CPU 0 and CPU 1 = 0b11 = 0x3)
taskset 0x3 ./my-application
```

### NUMA-Aware Execution with numactl

```bash
# Run on NUMA node 0 with local memory only
numactl --cpunodebind=0 --membind=0 ./my-application

# Run on specific CPUs within a NUMA node
numactl --physcpubind=0-15 --membind=0 ./my-application

# Interleave memory across all NUMA nodes (for throughput)
numactl --interleave=all ./my-application

# Prefer local memory but fall back to remote
numactl --preferred=0 ./my-application

# Check NUMA memory statistics
numastat -p $(pgrep my-application)
numastat -m  # System-wide memory stats
```

### CPU Sets with cgroups v2

For persistent CPU isolation, cgroups are the right tool:

```bash
# Create a cpuset for the application
mkdir -p /sys/fs/cgroup/app-isolated

# Assign CPUs 4-15 to this group
echo "4-15" > /sys/fs/cgroup/app-isolated/cpuset.cpus

# Assign NUMA node 0 memory
echo "0" > /sys/fs/cgroup/app-isolated/cpuset.mems

# Enable exclusive CPU usage
echo 1 > /sys/fs/cgroup/app-isolated/cpuset.cpus.exclusive

# Move a process into the cgroup
echo $(pgrep my-application) > /sys/fs/cgroup/app-isolated/cgroup.procs

# Verify
cat /proc/$(pgrep my-application)/cgroup
```

### Kubernetes CPU Pinning with the CPU Manager

Kubernetes provides CPU Manager policies for workloads that need dedicated CPU cores:

```yaml
# Enable CPU Manager with static policy in kubelet config
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
cpuManagerPolicy: static
cpuManagerReconcilePeriod: 5s
reservedSystemCPUs: "0-1,64-65"  # Reserve CPUs for system workloads
topologyManagerPolicy: single-numa-node  # NUMA-aware scheduling
topologyManagerScope: pod
```

```yaml
# Pod requesting exclusive CPUs
apiVersion: v1
kind: Pod
metadata:
  name: latency-sensitive-app
spec:
  containers:
  - name: app
    image: my-app:latest
    resources:
      requests:
        cpu: "8"       # Must be integer for static policy
        memory: "4Gi"
      limits:
        cpu: "8"       # Must equal requests for CPU pinning
        memory: "4Gi"
    # Optional: hint for NUMA-aware scheduling
  runtimeClassName: kata-qemu  # For hardware isolation
```

With `cpuManagerPolicy: static` and integer CPU requests equal to limits, the CPU Manager pins the container to specific physical CPU cores using cpuset cgroups.

### Isolating CPUs from the Kernel Scheduler

For the most extreme isolation, remove CPUs from the kernel's scheduler entirely using `isolcpus`:

```bash
# Add to kernel command line (GRUB)
# /etc/default/grub
GRUB_CMDLINE_LINUX="isolcpus=4-15,68-79 nohz_full=4-15,68-79 rcu_nocbs=4-15,68-79"

# Update GRUB
update-grub

# Reboot and verify
cat /sys/devices/system/cpu/isolated

# Tasks can still be pinned to isolated CPUs explicitly
taskset -c 4 ./latency-critical-app
```

On isolated CPUs, the kernel timer interrupt (`nohz_full`) is disabled, RCU callbacks (`rcu_nocbs`) run on other CPUs, and no other tasks are scheduled there. This eliminates jitter from kernel housekeeping.

Verify the isolation is working:

```bash
# Check timer interrupts per CPU (should be near 0 on isolated CPUs)
watch -n 1 'cat /proc/interrupts | grep -E "LOC|NMI"'

# Check CPU idle stats
turbostat --interval 1 --quiet --show CPU,Busy%,Bzy_MHz
```

## Section 3: NUMA Optimization

### NUMA Topology Impact Measurement

```bash
# Benchmark local vs remote NUMA access
numactl --membind=0 numactl --cpunodebind=0 \
  mbw 1024  # Memory bandwidth test, local

numactl --membind=1 numactl --cpunodebind=0 \
  mbw 1024  # Memory bandwidth test, remote (cross-NUMA)

# Measure NUMA miss rate
perf stat -e cache-misses,cache-references,LLC-load-misses,LLC-loads \
  -p $(pgrep my-application) -- sleep 5

# NUMA statistics for a process
numastat -p $(pgrep my-application)
```

### NUMA-Aware Memory Allocation in C

```c
// numa_alloc.c
#include <numa.h>
#include <numaif.h>
#include <stdio.h>
#include <stdlib.h>

int main() {
    if (numa_available() < 0) {
        fprintf(stderr, "NUMA not available\n");
        return 1;
    }

    int num_nodes = numa_num_configured_nodes();
    printf("NUMA nodes: %d\n", num_nodes);

    // Allocate on a specific NUMA node
    size_t size = 1024 * 1024 * 1024;  // 1GB
    void *ptr = numa_alloc_onnode(size, 0);  // Node 0
    if (!ptr) {
        perror("numa_alloc_onnode");
        return 1;
    }

    // Verify the allocation node
    int status[1];
    void *pages[1] = { ptr };
    move_pages(0, 1, pages, NULL, status, 0);
    printf("Memory allocated on node: %d\n", status[0]);

    // Move existing memory to a specific node
    int nodes[1] = { 0 };  // Target node
    move_pages(0, 1, pages, nodes, status, MPOL_MF_MOVE);

    numa_free(ptr, size);
    return 0;
}
```

Compile and link: `gcc -o numa_alloc numa_alloc.c -lnuma`

### Go Application NUMA Awareness

Go does not expose NUMA APIs directly, but you can use runtime process pinning:

```go
// main.go
package main

import (
    "fmt"
    "os"
    "os/exec"
    "strconv"
    "syscall"
)

func init() {
    // Pin to NUMA node 0 if not already pinned
    node := os.Getenv("NUMA_NODE")
    if node == "" {
        // Re-exec with numactl
        numaNode := "0"
        args := append([]string{
            "numactl",
            fmt.Sprintf("--cpunodebind=%s", numaNode),
            fmt.Sprintf("--membind=%s", numaNode),
            os.Args[0],
        }, os.Args[1:]...)

        env := append(os.Environ(), fmt.Sprintf("NUMA_NODE=%s", numaNode))
        cmd := exec.Command(args[0], args[1:]...)
        cmd.Env = env
        cmd.Stdin = os.Stdin
        cmd.Stdout = os.Stdout
        cmd.Stderr = os.Stderr
        cmd.SysProcAttr = &syscall.SysProcAttr{}

        if err := cmd.Run(); err != nil {
            if exitErr, ok := err.(*exec.ExitError); ok {
                os.Exit(exitErr.ExitCode())
            }
            os.Exit(1)
        }
        os.Exit(0)
    }
    fmt.Printf("Running on NUMA node %s (PID %d)\n", node, os.Getpid())
}
```

### Huge Pages for NUMA Workloads

Huge pages reduce TLB pressure and improve NUMA memory locality:

```bash
# Check current huge page configuration
cat /proc/meminfo | grep -i huge

# Allocate huge pages at runtime (2MB pages)
echo 2048 > /proc/sys/vm/nr_hugepages

# Allocate on a specific NUMA node
echo 1024 > /sys/devices/system/node/node0/hugepages/hugepages-2048kB/nr_hugepages
echo 1024 > /sys/devices/system/node/node1/hugepages/hugepages-2048kB/nr_hugepages

# Use 1GB huge pages (requires kernel support)
echo 16 > /sys/kernel/mm/hugepages/hugepages-1048576kB/nr_hugepages

# Mount hugetlbfs
mkdir -p /dev/hugepages
mount -t hugetlbfs nodev /dev/hugepages -o pagesize=2M

# Persistent configuration
echo 'vm.nr_hugepages = 2048' >> /etc/sysctl.d/99-hugepages.conf
sysctl -p /etc/sysctl.d/99-hugepages.conf

# Verify
cat /proc/meminfo | grep -i huge
```

## Section 4: IRQ Affinity Management

### Understanding Interrupt Processing

Network cards, storage controllers, and other devices interrupt the CPU to signal work is available. By default, `irqbalance` distributes interrupts across all CPUs. For high-performance workloads, you want to control this precisely.

```bash
# View all IRQs and their current CPU assignments
cat /proc/interrupts

# Check IRQ affinity for a specific IRQ
cat /proc/irq/42/smp_affinity      # Bitmask
cat /proc/irq/42/smp_affinity_list  # Human-readable list

# Identify NIC IRQs
ls /proc/irq/ | xargs -I{} sh -c \
  'echo -n "{}: "; cat /proc/irq/{}/actions 2>/dev/null' | \
  grep -i eth

# Or using ethtool
ethtool -l eth0      # Show channel configuration
ethtool -S eth0      # Show statistics
```

### Disabling irqbalance and Setting Affinity Manually

```bash
# Stop irqbalance
systemctl stop irqbalance
systemctl disable irqbalance

# Find NIC IRQs (example for eth0 with 16 queues)
NIC=eth0
IRQ_LIST=$(grep -e "$NIC" /proc/interrupts | awk '{print $1}' | tr -d ':')

echo "IRQs for $NIC: $IRQ_LIST"

# Pin IRQs to CPUs 4-19 (16 CPUs for 16 queues)
CPU=4
for IRQ in $IRQ_LIST; do
    echo "Pinning IRQ $IRQ to CPU $CPU"
    echo $CPU > /proc/irq/$IRQ/smp_affinity_list
    CPU=$((CPU + 1))
done

# Verify
for IRQ in $IRQ_LIST; do
    echo "IRQ $IRQ affinity: $(cat /proc/irq/$IRQ/smp_affinity_list)"
done
```

### Automating IRQ Affinity with a Tuning Script

```bash
#!/bin/bash
# irq-tune.sh - Comprehensive IRQ and CPU affinity tuning

set -euo pipefail

NIC=${1:-eth0}
NUMA_NODE=${2:-0}

# Get CPUs on the target NUMA node (excluding CPU 0)
NUMA_CPUS=$(cat /sys/devices/system/node/node${NUMA_NODE}/cpulist | \
    sed 's/0,//' | sed 's/^,//')
echo "NUMA ${NUMA_NODE} CPUs: ${NUMA_CPUS}"

# Stop irqbalance
systemctl stop irqbalance 2>/dev/null || true

# Get NIC IRQs
NIC_IRQS=$(grep "${NIC}" /proc/interrupts | awk '{print $1}' | tr -d ':' | sort -n)
IRQ_COUNT=$(echo "${NIC_IRQS}" | wc -l)
echo "Found ${IRQ_COUNT} IRQs for ${NIC}"

# Get list of CPUs for the NUMA node
IFS=',' read -ra CPU_ARRAY <<< "${NUMA_CPUS}"
CPU_INDEX=0

# Assign one IRQ per CPU
for IRQ in ${NIC_IRQS}; do
    CPU=${CPU_ARRAY[$((CPU_INDEX % ${#CPU_ARRAY[@]}))]}
    echo "${CPU}" > /proc/irq/${IRQ}/smp_affinity_list
    echo "IRQ ${IRQ} -> CPU ${CPU}"
    CPU_INDEX=$((CPU_INDEX + 1))
done

# Set NIC queue affinity to match IRQ affinity
for i in $(seq 0 $((IRQ_COUNT - 1))); do
    CPU=${CPU_ARRAY[$((i % ${#CPU_ARRAY[@]}))]}
    QUEUE_FILE="/sys/class/net/${NIC}/queues/rx-${i}/rps_cpus"
    if [ -f "${QUEUE_FILE}" ]; then
        # Convert CPU number to bitmask
        MASK=$(python3 -c "print(hex(1 << ${CPU}))")
        echo "${MASK}" > "${QUEUE_FILE}"
    fi
done

# Disable IRQ balance for NIC CPUs in irqbalance (if using it selectively)
# echo "IRQBALANCE_BANNED_CPUS=$(echo ${NUMA_CPUS} | tr ',' '-')" >> /etc/irqbalance.conf

echo "IRQ affinity configuration complete"

# Show final state
echo ""
echo "Final IRQ assignments:"
grep "${NIC}" /proc/interrupts | awk '{print $1}' | tr -d ':' | \
    xargs -I{} sh -c 'echo "IRQ {}: $(cat /proc/irq/{}/smp_affinity_list)"'
```

### Network Queue Tuning

```bash
# Set number of NIC queues (should match CPU count)
ethtool -L eth0 combined 16

# Increase ring buffer sizes
ethtool -G eth0 rx 4096 tx 4096

# Enable RSS (Receive Side Scaling)
ethtool -X eth0 equal 16

# Set interrupt coalescing
ethtool -C eth0 rx-usecs 50 tx-usecs 50

# Check current settings
ethtool -c eth0  # Coalescing
ethtool -g eth0  # Ring buffers
ethtool -k eth0  # Offload features

# Enable GRO/GSO/TSO offloads
ethtool -K eth0 gro on gso on tso on

# Tune kernel network settings
cat >> /etc/sysctl.d/99-network-tuning.conf << 'EOF'
# Increase socket buffers
net.core.rmem_max = 134217728
net.core.wmem_max = 134217728
net.core.rmem_default = 65536
net.core.wmem_default = 65536
net.ipv4.tcp_rmem = 4096 65536 134217728
net.ipv4.tcp_wmem = 4096 65536 134217728
net.ipv4.udp_rmem_min = 8192
net.ipv4.udp_wmem_min = 8192

# Increase connection backlog
net.core.netdev_max_backlog = 250000
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535

# TCP tuning
net.ipv4.tcp_fastopen = 3
net.ipv4.tcp_slow_start_after_idle = 0
net.ipv4.tcp_tw_reuse = 1
net.ipv4.ip_local_port_range = 1024 65535

# Disable NUMA balancing for pinned workloads
kernel.numa_balancing = 0
EOF
sysctl -p /etc/sysctl.d/99-network-tuning.conf
```

## Section 5: CPU Frequency and Power Management

Modern CPUs throttle frequency under light load. For latency-sensitive workloads, disable this:

```bash
# Check current governor
cat /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor | sort -u

# Set performance governor on all CPUs
for cpu in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
    echo performance > $cpu
done

# Using cpupower (easier)
cpupower frequency-set -g performance

# Or with tuned profile
tuned-adm profile latency-performance

# Disable Turbo Boost (can cause frequency jitter)
echo 1 > /sys/devices/system/cpu/intel_pstate/no_turbo

# Or with Intel MSR
modprobe msr
wrmsr -a 0x1a0 0x4000850089  # Disable Turbo

# Disable C-states deeper than C1 (prevent sleep latency)
for cpu in /sys/devices/system/cpu/cpu*/cpuidle/state*/name; do
    state_dir=$(dirname $cpu)
    name=$(cat $cpu)
    if [[ $name == "C2" || $name == "C3" || $name == "C6" || $name == "C7" ]]; then
        echo 1 > $state_dir/disable
    fi
done
```

### Intel P-state and Uncore Frequency

```bash
# Check P-state driver
cat /sys/devices/system/cpu/intel_pstate/status

# For pinned workloads, set min=max frequency
cpupower --cpu 4-15 frequency-set \
  --min $(cpupower frequency-info -l | grep -oP '[\d.]+\s*GHz' | tail -1) \
  --max $(cpupower frequency-info -l | grep -oP '[\d.]+\s*GHz' | tail -1)

# Tune uncore frequency (Intel)
# Uncore includes LLC, memory controllers, QPI links
if [ -d /sys/devices/system/cpu/intel_uncore_frequency ]; then
    for domain in /sys/devices/system/cpu/intel_uncore_frequency/package_00*/; do
        MAX_FREQ=$(cat ${domain}max_freq_khz)
        echo $MAX_FREQ > ${domain}min_freq_khz
    done
fi
```

## Section 6: DPDK Kernel Bypass Networking

DPDK (Data Plane Development Kit) bypasses the Linux kernel network stack entirely, allowing applications to process millions of packets per second from a single CPU core.

### Installing DPDK

```bash
# Install dependencies
apt-get install -y libnuma-dev linux-headers-$(uname -r) \
  libpcap-dev python3-pyelftools meson ninja-build

# Build DPDK from source
wget https://fast.dpdk.org/rel/dpdk-23.11.tar.xz
tar xf dpdk-23.11.tar.xz
cd dpdk-23.11

meson setup build \
  -Dplatform=native \
  -Denable_kmods=true \
  -Ddisable_libs="" \
  --prefix=/usr/local

ninja -C build
ninja -C build install
ldconfig

# Verify installation
dpdk-devbind.py --status
```

### Binding Network Interfaces to DPDK

```bash
# Load the vfio-pci driver (recommended over uio_pci_generic)
modprobe vfio-pci

# Get the PCI address of the NIC
dpdk-devbind.py --status-dev net

# Bind the interface to DPDK (interface must be down)
ip link set eth1 down
dpdk-devbind.py --bind=vfio-pci 0000:00:1f.6

# Verify binding
dpdk-devbind.py --status

# Allocate huge pages for DPDK
echo 1024 > /proc/sys/vm/nr_hugepages
mkdir -p /dev/hugepages
mount -t hugetlbfs nodev /dev/hugepages
```

### DPDK Application in C (Packet Forwarder)

```c
// dpdk_forward.c
#include <rte_eal.h>
#include <rte_ethdev.h>
#include <rte_mbuf.h>
#include <rte_lcore.h>
#include <rte_ring.h>

#define RX_RING_SIZE 1024
#define TX_RING_SIZE 1024
#define NUM_MBUFS 8191
#define MBUF_CACHE_SIZE 250
#define BURST_SIZE 32

static const struct rte_eth_conf port_conf_default = {
    .rxmode = {
        .max_lro_pkt_size = RTE_ETHER_MAX_LEN,
    },
};

static struct rte_mempool *mbuf_pool = NULL;

static int port_init(uint16_t port) {
    struct rte_eth_conf port_conf = port_conf_default;
    const uint16_t rx_rings = 1, tx_rings = 1;
    uint16_t nb_rxd = RX_RING_SIZE;
    uint16_t nb_txd = TX_RING_SIZE;
    int retval;
    struct rte_eth_dev_info dev_info;

    if (!rte_eth_dev_is_valid_port(port))
        return -1;

    retval = rte_eth_dev_info_get(port, &dev_info);
    if (retval != 0) return retval;

    retval = rte_eth_dev_configure(port, rx_rings, tx_rings, &port_conf);
    if (retval != 0) return retval;

    retval = rte_eth_dev_adjust_nb_rx_tx_desc(port, &nb_rxd, &nb_txd);
    if (retval != 0) return retval;

    // Setup RX queue on NUMA node local memory
    retval = rte_eth_rx_queue_setup(port, 0, nb_rxd,
        rte_eth_dev_socket_id(port), NULL, mbuf_pool);
    if (retval < 0) return retval;

    // Setup TX queue
    struct rte_eth_txconf txconf = dev_info.default_txconf;
    txconf.offloads = port_conf.txmode.offloads;
    retval = rte_eth_tx_queue_setup(port, 0, nb_txd,
        rte_eth_dev_socket_id(port), &txconf);
    if (retval < 0) return retval;

    retval = rte_eth_dev_start(port);
    if (retval < 0) return retval;

    retval = rte_eth_promiscuous_enable(port);
    if (retval != 0) return retval;

    return 0;
}

// Forwarding loop: receive from port 0, send to port 1
static int lcore_main(__rte_unused void *arg) {
    uint16_t port;

    RTE_ETH_FOREACH_DEV(port) {
        if (rte_eth_dev_socket_id(port) >= 0 &&
            rte_eth_dev_socket_id(port) != (int)rte_socket_id()) {
            printf("Warning: port %u on different NUMA node\n", port);
        }
    }

    struct rte_mbuf *bufs[BURST_SIZE];

    while (!force_quit) {
        // Burst receive from port 0
        uint16_t nb_rx = rte_eth_rx_burst(0, 0, bufs, BURST_SIZE);
        if (unlikely(nb_rx == 0)) continue;

        // Burst transmit to port 1
        uint16_t nb_tx = rte_eth_tx_burst(1, 0, bufs, nb_rx);

        // Free unsent packets
        if (unlikely(nb_tx < nb_rx)) {
            uint16_t buf;
            for (buf = nb_tx; buf < nb_rx; buf++)
                rte_pktmbuf_free(bufs[buf]);
        }
    }
    return 0;
}

int main(int argc, char *argv[]) {
    // Initialize EAL
    int ret = rte_eal_init(argc, argv);
    if (ret < 0) rte_exit(EXIT_FAILURE, "EAL init failed\n");

    argc -= ret;
    argv += ret;

    uint16_t nb_ports = rte_eth_dev_count_avail();
    if (nb_ports < 2)
        rte_exit(EXIT_FAILURE, "Need at least 2 ports\n");

    // Create memory pool on NUMA node 0
    mbuf_pool = rte_pktmbuf_pool_create("MBUF_POOL",
        NUM_MBUFS * nb_ports, MBUF_CACHE_SIZE, 0,
        RTE_MBUF_DEFAULT_BUF_SIZE, rte_socket_id());
    if (mbuf_pool == NULL)
        rte_exit(EXIT_FAILURE, "Cannot create mbuf pool\n");

    // Initialize each port
    uint16_t portid;
    RTE_ETH_FOREACH_DEV(portid) {
        if (port_init(portid) != 0)
            rte_exit(EXIT_FAILURE, "Cannot init port %u\n", portid);
    }

    // Launch forwarding on each lcore
    rte_eal_mp_remote_launch(lcore_main, NULL, CALL_MAIN);
    rte_eal_mp_wait_lcore();

    // Cleanup
    RTE_ETH_FOREACH_DEV(portid) {
        rte_eth_dev_stop(portid);
        rte_eth_dev_close(portid);
    }
    rte_eal_cleanup();
    return 0;
}
```

Run the forwarder:

```bash
# EAL options:
# -l 4,5,6,7  : use lcores 4-7 (pinned to these CPUs)
# -n 4        : 4 memory channels
# --proc-type primary
# -- separates EAL opts from app opts

./dpdk_forward \
  -l 4,5,6,7 \
  -n 4 \
  --huge-dir /dev/hugepages \
  --proc-type primary \
  --file-prefix dpdk_fwd \
  -- --no-promiscuous-mode
```

## Section 7: Memory Bandwidth and Latency Profiling

### Using perf for Hardware Counters

```bash
# Record cache misses during workload
perf stat -e \
  cycles,instructions,cache-references,cache-misses,\
  LLC-loads,LLC-load-misses,\
  node-loads,node-load-misses,\
  node-stores,node-store-misses \
  -p $(pgrep my-application) \
  -- sleep 10

# Record with NUMA events
perf stat -e \
  uncore_imc/cas_count_read/,\
  uncore_imc/cas_count_write/ \
  -- sleep 1

# Profile memory bandwidth
perf mem record -p $(pgrep my-application) -- sleep 5
perf mem report --stdio

# Flame graph for CPU profiling
perf record -F 99 -g -p $(pgrep my-application) -- sleep 30
perf script | stackcollapse-perf.pl | flamegraph.pl > cpu-profile.svg
```

### mlc (Memory Latency Checker)

```bash
# Download Intel MLC
wget https://downloadmirror.intel.com/838327/mlc_v3.11.tgz
tar xzf mlc_v3.11.tgz

# Measure idle latency across NUMA nodes
./mlc --latency_matrix

# Measure peak memory bandwidth
./mlc --bandwidth_matrix

# Measure loaded latency (more representative of production)
./mlc --loaded_latency

# Expected output:
# Latency matrix (ns):
#         Numa node
# Numa node     0       1
#        0   73.4   134.7   <- Node 0 local=73ns, remote=134ns
#        1  135.1    73.2
```

## Section 8: Linux Kernel Tuning for Latency

```bash
# Create a comprehensive latency tuning script
cat > /etc/sysctl.d/99-latency-tuning.conf << 'EOF'
# Disable NUMA balancing (do it manually)
kernel.numa_balancing = 0

# Minimize swap usage
vm.swappiness = 1

# Use huge pages transparently
vm.nr_hugepages = 1024
vm.hugetlb_shm_group = 0

# Transparent huge pages (set to madvise for control)
# Set separately: echo madvise > /sys/kernel/mm/transparent_hugepage/enabled

# Reduce timer interrupts
kernel.timer_migration = 0

# Disable ASLR for reproducible performance (security trade-off)
# kernel.randomize_va_space = 0

# CPU scheduler tuning
kernel.sched_min_granularity_ns = 10000000
kernel.sched_wakeup_granularity_ns = 15000000
kernel.sched_migration_cost_ns = 5000000

# Disable CPU frequency scaling impact on scheduler
kernel.sched_energy_aware = 0
EOF

sysctl -p /etc/sysctl.d/99-latency-tuning.conf

# THP settings
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag

# Disable watchdog on isolated CPUs
for cpu in $(cat /sys/devices/system/cpu/isolated); do
    echo 0 > /sys/devices/system/cpu/cpu${cpu}/thermal_throttle/core_throttle_count 2>/dev/null || true
done

# Set real-time scheduling for critical processes
chrt -f -p 99 $(pgrep my-latency-app)
```

## Section 9: Verification and Benchmarking

### Latency Benchmarking with cyclictest

```bash
# Install rt-tests
apt-get install -y rt-tests

# Run cyclictest on isolated CPUs
cyclictest \
  --mlockall \
  --smp \
  --priority=99 \
  --interval=200 \
  --distance=0 \
  --affinity=4-15 \
  --duration=60 \
  --histogram=50 \
  --quiet

# Expected output format:
# T: 0 ( PID) P:99 I:200 C: 300000 Min:      3 Act:    5 Avg:    4 Max:    14
# Latency histogram saved to histogram file
```

### Network Latency Benchmarking

```bash
# Using sockperf for network latency
apt-get install -y sockperf

# Server
sockperf sr --tcp -i 0.0.0.0 -p 11111

# Client (on pinned CPU)
taskset -c 4 sockperf ping-pong \
  --tcp \
  -i 10.0.0.1 \
  -p 11111 \
  --time 60 \
  --msg-size 64 \
  --full-log /tmp/sockperf-log.csv

# Latency percentiles from log
awk -F, '{print $1}' /tmp/sockperf-log.csv | \
  sort -n | \
  awk 'BEGIN{c=0} {a[c++]=$1} END{
    print "p50:", a[int(c*0.5)];
    print "p99:", a[int(c*0.99)];
    print "p999:", a[int(c*0.999)];
    print "max:", a[c-1]
  }'
```

## Section 10: Production Deployment Checklist

```bash
#!/bin/bash
# performance-check.sh - Pre-deployment performance validation

echo "=== CPU Governor ==="
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor

echo "=== CPU Frequency ==="
cpupower frequency-info -f

echo "=== Turbo Boost Status ==="
cat /sys/devices/system/cpu/intel_pstate/no_turbo 2>/dev/null || \
  cat /sys/devices/system/cpu/cpufreq/boost 2>/dev/null || echo "N/A"

echo "=== C-State Residency ==="
turbostat --quiet --show CPU,C1%,C3%,C6% -- sleep 1 2>/dev/null || true

echo "=== irqbalance Status ==="
systemctl is-active irqbalance

echo "=== NUMA Balancing ==="
cat /proc/sys/kernel/numa_balancing

echo "=== Huge Pages ==="
cat /proc/meminfo | grep -i huge

echo "=== Isolated CPUs ==="
cat /sys/devices/system/cpu/isolated 2>/dev/null || echo "None"

echo "=== THP Setting ==="
cat /sys/kernel/mm/transparent_hugepage/enabled

echo "=== Swap Activity ==="
vmstat 1 5 | tail -5

echo "=== NIC Queues ==="
for nic in $(ls /sys/class/net | grep -v lo); do
    echo "${nic}: $(ethtool -l $nic 2>/dev/null | grep -i combined | tail -1)"
done

echo "=== Memory Bandwidth (quick check) ==="
numactl --membind=0 --cpunodebind=0 dd if=/dev/zero of=/dev/null bs=1M count=4096 2>&1 | tail -1
```

## Conclusion

Linux performance tuning is not a one-size-fits-all exercise. The right configuration depends on your workload characteristics: latency-sensitive applications (trading, real-time control) benefit most from CPU isolation, IRQ pinning, and disabled C-states. Throughput-oriented workloads (batch processing, analytics) benefit more from NUMA locality and huge pages. Kernel bypass with DPDK is warranted only when you need to process millions of packets per second from userspace.

The common thread is measurement. Every tuning decision should be validated with hardware performance counters, cyclictest results, or application-level latency percentiles. Tuning that reduces paper latency but increases p99 under load is worse than the baseline. Measure, tune, measure again.
