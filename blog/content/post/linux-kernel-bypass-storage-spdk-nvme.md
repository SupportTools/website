---
title: "Linux Kernel Bypass Storage: SPDK and NVMe-oF"
date: 2029-09-14T00:00:00-05:00
draft: false
tags: ["Linux", "SPDK", "NVMe", "Storage", "Performance", "Kernel Bypass", "Kubernetes"]
categories: ["Linux", "Storage", "Performance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into kernel bypass storage with SPDK: user-mode NVMe driver architecture, NVMe-oF target and initiator configuration, latency comparison with kernel stack, and Kubernetes CSI integration for SPDK-backed persistent volumes."
more_link: "yes"
url: "/linux-kernel-bypass-storage-spdk-nvme/"
---

Modern NVMe SSDs have hardware latencies of 70-150 microseconds, but the Linux kernel storage stack introduces an additional 20-80 microseconds of software overhead. For latency-critical applications — high-frequency trading, in-memory databases with persistent logs, real-time analytics — eliminating that kernel overhead is worth the engineering complexity. SPDK (Storage Performance Development Kit) and NVMe-oF (NVMe over Fabrics) achieve this by moving the storage driver into userspace and bypassing the kernel entirely for I/O operations.

<!--more-->

# Linux Kernel Bypass Storage: SPDK and NVMe-oF

## Why Kernel Bypass?

The Linux kernel storage stack involves multiple layers between a userspace application and physical hardware:

```
Application
    |
    v
VFS (Virtual File System)
    |
    v
File System (ext4, xfs, btrfs)
    |
    v
Block Layer (elevator, scheduler)
    |
    v
Device Mapper (LVM, RAID)
    |
    v
NVMe Driver (kernel module)
    |
    v
PCIe                          <- Hardware starts here
    |
    v
NVMe Controller (on SSD)
    |
    v
NAND Flash
```

Each layer adds latency through context switches, interrupt processing, lock contention, and buffer copies. SPDK replaces most of this stack:

```
Application (with SPDK library)
    |
    v
SPDK NVMe Driver (userspace, polling)
    |
    v
VFIO (Virtual Function I/O) - kernel module for safe device access
    |
    v
PCIe (via memory-mapped I/O)
    |
    v
NVMe Controller
```

The key differences:
- No system calls in the I/O path (after initialization)
- No interrupt-driven I/O — SPDK polls for completion
- No memory copies between kernel and userspace
- No lock contention with other kernel subsystems

## SPDK Architecture

SPDK is built on three foundational components:

### 1. DPDK for Memory and CPU Management

SPDK uses DPDK (Data Plane Development Kit) for:
- Huge pages (2MB or 1GB) to reduce TLB pressure
- CPU pinning to avoid context switches and cache misses
- Memory pools with NUMA awareness

### 2. VFIO for Device Access

VFIO allows userspace programs to directly access PCI devices:

```bash
# Check if VFIO is available
ls /sys/bus/pci/drivers/ | grep vfio
# vfio-pci

# Bind an NVMe device to VFIO
# First, identify the device
lspci | grep NVMe
# 01:00.0 Non-Volatile memory controller: Samsung Electronics Co Ltd NVMe SSD Controller PM9A3

# Unbind from kernel driver
echo "0000:01:00.0" > /sys/bus/pci/devices/0000:01:00.0/driver/unbind

# Bind to vfio-pci
echo "0000:01:00.0" > /sys/bus/pci/drivers/vfio-pci/bind

# Verify
ls -la /dev/vfio/
# crw------- 1 root root 241, 0 Sep 14 10:00 0
```

### 3. Polled I/O Model

SPDK uses dedicated threads that continuously poll for I/O completions instead of waiting for interrupts:

```
Kernel I/O model:
  Submit I/O -> kernel driver -> hardware -> interrupt fires -> handler runs
  Latency: application thread waits or uses epoll/io_uring

SPDK polled model:
  Submit I/O -> SPDK driver (userspace) -> hardware (via MMIO)
  Completion: SPDK reactor polls completion queue
  Latency: no interrupt overhead, deterministic polling interval
```

## Installing SPDK

```bash
# Clone SPDK
git clone https://github.com/spdk/spdk.git
cd spdk
git submodule update --init

# Install dependencies (Ubuntu/Debian)
apt-get install -y \
    python3 python3-pip \
    libssl-dev \
    libaio-dev \
    libcunit1-dev \
    libnuma-dev \
    librdmacm-dev \
    libibverbs-dev \
    libiscsi-dev \
    libjson-c-dev \
    libpciaccess-dev \
    uuid-dev

# Configure and build
./configure --with-rdma --with-vhost
make -j$(nproc)

# Set up huge pages (2MB x 2048 = 4GB)
scripts/setup.sh  # This also binds NVMe devices to VFIO

# Or manually:
echo 2048 > /proc/sys/vm/nr_hugepages
echo "vm.nr_hugepages = 2048" >> /etc/sysctl.conf
```

## SPDK NVMe Hello World

```c
// hello_world.c - Basic SPDK NVMe read/write
#include "spdk/stdinc.h"
#include "spdk/nvme.h"
#include "spdk/vmd.h"
#include "spdk/nvme_zns.h"
#include "spdk/env.h"
#include "spdk/string.h"
#include "spdk/log.h"

#define DATA_SIZE  4096  // 4KB I/O size

struct ns_entry {
    struct spdk_nvme_ctrlr  *ctrlr;
    struct spdk_nvme_ns     *ns;
    TAILQ_ENTRY(ns_entry)   link;
    struct spdk_nvme_qpair  *qpair;
};

static TAILQ_HEAD(, ns_entry) g_namespaces = TAILQ_HEAD_INITIALIZER(g_namespaces);

struct io_context {
    struct ns_entry    *ns_entry;
    char               *buf;
    uint64_t           lba;
    bool               is_completed;
};

static void io_complete(void *ctx, const struct spdk_nvme_cpl *cpl) {
    struct io_context *io = ctx;

    if (spdk_nvme_cpl_is_error(cpl)) {
        SPDK_ERRLOG("I/O error: sct=%d sc=%d\n",
            cpl->status.sct, cpl->status.sc);
    }
    io->is_completed = true;
}

static bool probe_cb(void *cb_ctx,
                     const struct spdk_nvme_transport_id *trid,
                     struct spdk_nvme_ctrlr_opts *opts) {
    SPDK_NOTICELOG("Attaching to %s\n", trid->traddr);
    return true;  // Probe this device
}

static void attach_cb(void *cb_ctx,
                      const struct spdk_nvme_transport_id *trid,
                      struct spdk_nvme_ctrlr *ctrlr,
                      const struct spdk_nvme_ctrlr_opts *opts) {
    int num_ns = spdk_nvme_ctrlr_get_num_ns(ctrlr);
    SPDK_NOTICELOG("Attached to %s: %d namespaces\n", trid->traddr, num_ns);

    for (int nsid = 1; nsid <= num_ns; nsid++) {
        struct spdk_nvme_ns *ns = spdk_nvme_ctrlr_get_ns(ctrlr, nsid);
        if (!spdk_nvme_ns_is_active(ns)) continue;

        struct ns_entry *entry = malloc(sizeof(struct ns_entry));
        entry->ctrlr = ctrlr;
        entry->ns = ns;
        TAILQ_INSERT_TAIL(&g_namespaces, entry, link);
    }
}

static void perform_io(struct ns_entry *ns_entry) {
    uint32_t sector_size = spdk_nvme_ns_get_sector_size(ns_entry->ns);
    uint64_t size_in_ios = spdk_nvme_ns_get_size(ns_entry->ns) / DATA_SIZE;

    // Allocate DMA-capable buffer
    char *write_buf = spdk_zmalloc(DATA_SIZE, sector_size, NULL,
        SPDK_ENV_SOCKET_ID_ANY, SPDK_MALLOC_DMA);
    char *read_buf = spdk_zmalloc(DATA_SIZE, sector_size, NULL,
        SPDK_ENV_SOCKET_ID_ANY, SPDK_MALLOC_DMA);

    snprintf(write_buf, DATA_SIZE, "Hello SPDK! Timestamp: %lu",
        (unsigned long)time(NULL));

    // Create I/O queue pair
    struct spdk_nvme_io_qpair_opts qpair_opts;
    spdk_nvme_ctrlr_get_default_io_qpair_opts(ns_entry->ctrlr,
        &qpair_opts, sizeof(qpair_opts));
    ns_entry->qpair = spdk_nvme_ctrlr_alloc_io_qpair(
        ns_entry->ctrlr, &qpair_opts, sizeof(qpair_opts));

    // Write
    struct io_context write_ctx = {
        .ns_entry = ns_entry,
        .buf = write_buf,
        .lba = 0,
        .is_completed = false,
    };

    uint64_t tsc_start = spdk_get_ticks();
    spdk_nvme_ns_cmd_write(ns_entry->ns, ns_entry->qpair,
        write_buf, 0,  // LBA
        DATA_SIZE / sector_size,  // number of LBAs
        io_complete, &write_ctx, 0);

    // Poll until complete (no blocking, no interrupt)
    while (!write_ctx.is_completed) {
        spdk_nvme_qpair_process_completions(ns_entry->qpair, 0);
    }
    uint64_t write_latency_us =
        (spdk_get_ticks() - tsc_start) * 1000000 / spdk_get_ticks_hz();

    printf("Write latency: %lu us\n", write_latency_us);

    // Read back
    struct io_context read_ctx = {.is_completed = false};
    tsc_start = spdk_get_ticks();
    spdk_nvme_ns_cmd_read(ns_entry->ns, ns_entry->qpair,
        read_buf, 0, DATA_SIZE / sector_size,
        io_complete, &read_ctx, 0);

    while (!read_ctx.is_completed) {
        spdk_nvme_qpair_process_completions(ns_entry->qpair, 0);
    }
    uint64_t read_latency_us =
        (spdk_get_ticks() - tsc_start) * 1000000 / spdk_get_ticks_hz();

    printf("Read latency: %lu us\n", read_latency_us);
    printf("Data: %s\n", read_buf);

    spdk_free(write_buf);
    spdk_free(read_buf);
    spdk_nvme_ctrlr_free_io_qpair(ns_entry->qpair);
}

int main(int argc, char **argv) {
    struct spdk_env_opts opts;
    spdk_env_opts_init(&opts);
    opts.name = "hello_world";
    opts.shm_id = 0;

    if (spdk_env_init(&opts) < 0) {
        SPDK_ERRLOG("Failed to initialize SPDK env\n");
        return 1;
    }

    // Probe and attach to NVMe controllers
    if (spdk_nvme_probe(NULL, NULL, probe_cb, attach_cb, NULL) != 0) {
        SPDK_ERRLOG("spdk_nvme_probe() failed\n");
        return 1;
    }

    // Perform I/O on first namespace
    struct ns_entry *entry = TAILQ_FIRST(&g_namespaces);
    if (entry) {
        perform_io(entry);
    }

    // Cleanup
    TAILQ_FOREACH(entry, &g_namespaces, link) {
        spdk_nvme_detach(entry->ctrlr);
    }

    return 0;
}
```

```makefile
# Makefile
SPDK_DIR := /path/to/spdk

CFLAGS := -I$(SPDK_DIR)/include
LDFLAGS := -L$(SPDK_DIR)/build/lib \
    -lspdk_nvme -lspdk_env_dpdk -lspdk_util -lspdk_log \
    -ldpdk -lnuma -lpthread -ldl

hello_world: hello_world.c
    gcc $(CFLAGS) -o $@ $< $(LDFLAGS)
```

## NVMe-oF: NVMe over Fabrics

NVMe-oF extends the NVMe protocol over network fabrics (RDMA/RoCE, TCP, FC), providing remote NVMe device access with near-local latency.

### NVMe-oF Architecture

```
Initiator (client)                    Target (storage server)
    Application                           SPDK NVMe-oF Target
        |                                       |
    SPDK NVMe-oF Driver (userspace)             |
        |                                       |
    RDMA/RoCE or TCP                    --------+
    (network fabric)                            |
                                        SPDK NVMe Driver
                                                |
                                        Physical NVMe SSD
```

### Setting Up SPDK NVMe-oF Target

```bash
# Start SPDK NVMe-oF target application
build/bin/nvmf_tgt -m 0x1 &  # Pin to CPU core 0

# Configure via SPDK JSON-RPC

# Step 1: Create NVMe-oF transport
rpc.py nvmf_create_transport \
    -t RDMA \
    --max-queue-depth 128 \
    --max-io-size 131072 \
    --io-unit-size 131072

# Or for TCP transport (no RDMA hardware required):
rpc.py nvmf_create_transport \
    -t TCP \
    --max-queue-depth 128

# Step 2: Create NVM Subsystem
rpc.py nvmf_create_subsystem \
    nqn.2016-06.io.spdk:cnode1 \
    -a  # Allow any host (for testing; production: specify allowed hosts)

# Step 3: Add NVMe namespace to subsystem
rpc.py nvmf_subsystem_add_ns \
    nqn.2016-06.io.spdk:cnode1 \
    Malloc0  # Can use actual NVMe device or malloc bdev for testing

# Step 4: Add listener
rpc.py nvmf_subsystem_add_listener \
    nqn.2016-06.io.spdk:cnode1 \
    -t RDMA \
    -a 192.168.100.10 \
    -s 4420  # NVMe-oF default port

# Or TCP:
rpc.py nvmf_subsystem_add_listener \
    nqn.2016-06.io.spdk:cnode1 \
    -t TCP \
    -a 192.168.100.10 \
    -s 4420

# Verify
rpc.py nvmf_get_subsystems
```

### Connecting from a Linux Initiator

```bash
# Load kernel NVMe-oF initiator modules
modprobe nvme-tcp     # For TCP transport
modprobe nvme-rdma    # For RDMA transport

# Connect to target (using kernel nvme-cli)
nvme connect \
    -t tcp \
    -a 192.168.100.10 \
    -s 4420 \
    -n nqn.2016-06.io.spdk:cnode1

# Or for RDMA:
nvme connect \
    -t rdma \
    -a 192.168.100.10 \
    -s 4420 \
    -n nqn.2016-06.io.spdk:cnode1

# Verify the device appears
nvme list
# Node             SN                   Model                 Namespace  Usage          Format      FW Rev
# /dev/nvme1n1     SPDK-0000000000000001 SPDK                  1          0.00 GB / ...  512 B + 0 B

# Connect from SPDK initiator (userspace, lower latency)
build/bin/nvme_perf \
    -q 4 -o 4096 -w randread -t 30 \
    -r "trtype:TCP adrfam:IPv4 traddr:192.168.100.10 trsvcid:4420 subnqn:nqn.2016-06.io.spdk:cnode1"
```

## Latency Comparison: Kernel vs SPDK

```bash
# Baseline: kernel NVMe driver with io_uring
fio --filename=/dev/nvme0n1 \
    --direct=1 \
    --rw=randread \
    --bs=4k \
    --ioengine=io_uring \
    --iodepth=1 \
    --numjobs=1 \
    --runtime=30 \
    --name=kernel-lat \
    --output-format=terse

# Typical kernel stack: 80-120 μs at queue depth 1

# SPDK: userspace polling
build/bin/nvme_perf \
    -q 1 \           # Queue depth 1
    -o 4096 \        # 4K block size
    -w randread \
    -t 30 \
    -r "trtype:PCIe traddr:0000:01:00.0"

# Typical SPDK: 55-85 μs at queue depth 1

# NVMe-oF over TCP (local network)
build/bin/nvme_perf \
    -q 1 -o 4096 -w randread -t 30 \
    -r "trtype:TCP adrfam:IPv4 traddr:192.168.100.10 trsvcid:4420 subnqn:nqn.2016-06.io.spdk:cnode1"

# Typical NVMe-oF TCP (100 GbE): 90-140 μs

# NVMe-oF over RDMA (RoCEv2)
# Typical NVMe-oF RDMA: 65-100 μs
```

Approximate latency comparison:

| Stack | 4K Random Read Latency (QD=1) |
|---|---|
| Kernel NVMe + io_uring | 80-120 μs |
| SPDK local NVMe | 55-85 μs |
| NVMe-oF TCP (100GbE) | 90-140 μs |
| NVMe-oF RDMA (RoCEv2) | 65-100 μs |
| Hardware NVMe baseline | 70-90 μs |

## SPDK Bdev: Block Device Abstraction

SPDK's bdev (block device) layer abstracts different storage backends. Multiple bdev types can be combined:

```bash
# Create a Null bdev (discards writes, returns zeros)
rpc.py bdev_null_create Null0 4096 512

# Create a Malloc bdev (in-memory, for testing)
rpc.py bdev_malloc_create -b Malloc0 64 512  # 64MB, 512 byte sectors

# Create a passthrough to real NVMe
rpc.py bdev_nvme_attach_controller \
    -b NVMe0 \
    -t PCIe \
    -a 0000:01:00.0

# Create a RAID bdev from multiple NVMe devices
rpc.py bdev_raid_create \
    -n Raid0 \
    -z 64 \    # Strip size in KB
    -r 0 \     # RAID level 0
    -b "NVMe0n1 NVMe1n1 NVMe2n1 NVMe3n1"

# Create a logical volume store
rpc.py bdev_lvol_create_lvstore NVMe0n1 lvs0

# Create a logical volume (thin provisioned)
rpc.py bdev_lvol_create -l lvs0 lv0 10240  # 10 GB
```

## Kubernetes CSI for SPDK

The SPDK CSI driver enables Kubernetes pods to use SPDK-backed persistent volumes.

### SPDK CSI Architecture

```
Kubernetes API
    |
    v
SPDK CSI Controller Plugin (DaemonSet on storage nodes)
    |
    v
SPDK JSON-RPC API
    |
    v
SPDK NVMe-oF Target
    |
    v
Physical NVMe SSDs
```

### Deploying SPDK CSI

```yaml
# spdk-csi-deployment.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: spdk-csi
---
apiVersion: v1
kind: Secret
metadata:
  name: spdk-secret
  namespace: spdk-csi
type: Opaque
stringData:
  # Base64-encoded config
  config.json: |
    {
      "nodes": [
        {
          "name": "storage-node-01",
          "rpcURL": "http://192.168.100.10:9009",
          "targetType": "nvme-tcp",
          "targetAddr": "192.168.100.10"
        }
      ]
    }
---
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: spdk-nvmeof
provisioner: csi.spdk.io
parameters:
  targetType: nvme-tcp
  targetAddr: "192.168.100.10"
  nqn: "nqn.2016-06.io.spdk:cnode1"
reclaimPolicy: Delete
allowVolumeExpansion: true
volumeBindingMode: Immediate
---
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: spdk-csi-node
  namespace: spdk-csi
spec:
  selector:
    matchLabels:
      app: spdk-csi-node
  template:
    metadata:
      labels:
        app: spdk-csi-node
    spec:
      hostNetwork: true
      hostPID: true
      containers:
        - name: spdk-csi-driver
          image: spdkdev/spdk-csi:v0.1.0
          securityContext:
            privileged: true
          env:
            - name: KUBE_NODE_NAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
          volumeMounts:
            - name: dev
              mountPath: /dev
            - name: spdk-config
              mountPath: /etc/spdk
      volumes:
        - name: dev
          hostPath:
            path: /dev
        - name: spdk-config
          secret:
            secretName: spdk-secret
```

### Using SPDK Volumes in Pods

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: db-spdk-pvc
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: spdk-nvmeof
  resources:
    requests:
      storage: 100Gi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: high-perf-database
spec:
  replicas: 1
  selector:
    matchLabels:
      app: high-perf-db
  template:
    metadata:
      labels:
        app: high-perf-db
    spec:
      containers:
        - name: postgres
          image: postgres:16
          env:
            - name: PGDATA
              value: /var/lib/postgresql/data/pgdata
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
          resources:
            requests:
              cpu: "4"
              memory: "16Gi"
            limits:
              cpu: "8"
              memory: "32Gi"
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: db-spdk-pvc
```

## Performance Tuning for SPDK Workloads

### CPU Isolation for SPDK Reactors

SPDK reactors are busy-poll threads. Isolate dedicated CPUs:

```bash
# Kernel command line (in /etc/default/grub)
GRUB_CMDLINE_LINUX="isolcpus=2,3,4,5 nohz_full=2,3,4,5 rcu_nocbs=2,3,4,5"

# Update grub
update-grub
reboot

# Verify CPUs are isolated
cat /sys/devices/system/cpu/isolated
# 2,3,4,5

# Configure SPDK to use isolated CPUs
nvmf_tgt -m 0x3c  # Bitmask: 0x3c = CPUs 2,3,4,5
```

### NUMA Awareness

```bash
# Check NUMA topology
numactl --hardware
# available: 2 nodes (0-1)
# node 0 cpus: 0 1 2 3 4 5 6 7
# node 1 cpus: 8 9 10 11 12 13 14 15
# node 0 size: 64000 MB
# node 1 size: 64000 MB

# NVMe device NUMA node
cat /sys/bus/pci/devices/0000:01:00.0/numa_node
# 0  <- This device is on NUMA node 0

# Run SPDK on the same NUMA node as the NVMe device
numactl --cpunodebind=0 --membind=0 nvmf_tgt -m 0x3c

# Allocate huge pages on the correct NUMA node
echo 2048 > /sys/devices/system/node/node0/hugepages/hugepages-2048kB/nr_hugepages
```

## Monitoring SPDK Performance

```bash
# SPDK provides built-in statistics via JSON-RPC
rpc.py bdev_get_iostat -b NVMe0n1
# {
#   "tick_rate": 2793000000,
#   "bdevs": [{
#     "name": "NVMe0n1",
#     "bytes_read": 12345678,
#     "num_read_ops": 1234,
#     "bytes_written": 87654321,
#     "num_write_ops": 5678,
#     "read_latency_ticks": 123456,
#     "write_latency_ticks": 234567
#   }]
# }

# Calculate latency from ticks
# read_latency_us = (read_latency_ticks / tick_rate) * 1,000,000 / num_read_ops

# Continuous monitoring script
while true; do
    rpc.py bdev_get_iostat -b NVMe0n1 | python3 -c "
import json, sys, time
data = json.load(sys.stdin)
bdev = data['bdevs'][0]
tick_rate = data['tick_rate']
if bdev['num_read_ops'] > 0:
    lat = (bdev['read_latency_ticks'] / tick_rate * 1e6 / bdev['num_read_ops'])
    print(f'Read IOPS: {bdev[\"num_read_ops\"]/30:.0f}, Latency: {lat:.1f} us')
"
    sleep 30
done
```

## Summary

SPDK and NVMe-oF provide kernel bypass storage for latency-critical applications:

- SPDK eliminates kernel overhead (~20-80 μs) through a userspace NVMe driver using VFIO and polled I/O
- DPDK provides the underlying memory management (huge pages, NUMA-aware allocation) and CPU affinity
- NVMe-oF extends NVMe over TCP (ubiquitous, moderate latency) or RDMA (requires RoCE hardware, lowest latency)
- SPDK bdev layer abstracts physical NVMe, memory, RAID, and logical volumes under a unified API
- Kubernetes CSI integration makes SPDK volumes available as standard PersistentVolumeClaims
- CPU isolation (`isolcpus`) is essential for SPDK reactors to achieve consistent low latency
- NUMA alignment between NVMe device and SPDK reactor CPUs avoids cross-NUMA memory traffic
- Practical latency reduction: from ~100μs (kernel io_uring) to ~65μs (SPDK local) to ~80μs (NVMe-oF RDMA)
- The operational complexity of SPDK (VFIO binding, huge pages, CPU isolation) is justified only for truly latency-sensitive workloads
