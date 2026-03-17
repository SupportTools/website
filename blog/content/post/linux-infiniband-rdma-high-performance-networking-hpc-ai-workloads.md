---
title: "Linux InfiniBand and RDMA: High-Performance Networking for HPC and AI Workloads"
date: 2030-09-27T00:00:00-05:00
draft: false
tags: ["Linux", "InfiniBand", "RDMA", "HPC", "AI", "Kubernetes", "High-Performance Networking", "RoCE"]
categories:
- Linux
- Networking
- HPC
- AI/ML
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise RDMA guide covering InfiniBand architecture and HCA configuration, RDMA verbs programming model, RoCE over Ethernet, SR-IOV for RDMA in containers, Kubernetes RDMA device plugin, and benchmarking RDMA performance with perftest."
more_link: "yes"
url: "/linux-infiniband-rdma-high-performance-networking-hpc-ai-workloads/"
---

AI training workloads at scale hit a fundamental constraint: GPU compute is only as fast as the interconnect that moves data between nodes. A cluster of 100-node GPUs training a large language model spends a significant fraction of its training step time on gradient synchronization — moving tensors between accelerators. When the interconnect is 100GbE with TCP/IP overhead, the CPU and network stack become the bottleneck. InfiniBand with RDMA eliminates that bottleneck by allowing GPUs to transfer data directly to each other's memory, bypassing both the CPU and the OS network stack, achieving latencies measured in microseconds rather than milliseconds.

<!--more-->

## InfiniBand Architecture Overview

InfiniBand (IB) is a networking technology designed from the ground up for high-performance computing. Unlike Ethernet, which evolved from a shared medium to switched fabric while carrying TCP/IP overhead, InfiniBand was designed as a channel-based, switched fabric with built-in reliability and hardware-level flow control.

### Key Components

**Host Channel Adapter (HCA)**: The NIC equivalent for InfiniBand. The HCA handles all RDMA operations in hardware — the CPU issues a send/receive command and the HCA DMA-transfers the data directly from application memory to the remote node's application memory, completing the operation without CPU involvement on either end.

**InfiniBand Switch**: Switches connect HCAs in a fabric. Fat-tree topologies are standard for HPC. InfiniBand switches operate at the fabric level with credit-based flow control, eliminating dropped packets within the fabric.

**Subnet Manager (SM)**: Manages the fabric topology, assigns LIDs (Local Identifiers), and configures routing tables. OpenSM is the standard open-source SM.

**Queue Pairs (QP)**: The fundamental IB communication endpoint. Each QP has a Send Queue and Receive Queue. Applications post Work Requests (WRs) to QPs; the HCA processes them asynchronously.

### InfiniBand Data Rates

| Generation | Speed | Typical Use |
|---|---|---|
| SDR | 10 Gb/s | Legacy, rarely deployed |
| DDR | 20 Gb/s | Legacy |
| QDR | 40 Gb/s | Legacy |
| FDR | 56 Gb/s | Active in older HPC |
| EDR | 100 Gb/s | Common in current HPC |
| HDR | 200 Gb/s | Current HPC and AI |
| NDR | 400 Gb/s | Next-gen AI clusters |
| XDR | 800 Gb/s | Emerging |

For AI training, HDR (200 Gb/s per port, 400 Gb/s with dual-port) or NDR (400 Gb/s per port) are the current standard.

## HCA Installation and Configuration

### Kernel Module Installation (MLNX_OFED)

Mellanox (now NVIDIA) provides MLNX_OFED (OpenFabrics Enterprise Distribution) which includes optimized drivers:

```bash
# Download MLNX_OFED for your OS and HCA generation
# Example: Ubuntu 22.04, OFED 23.10 for ConnectX-7
OFED_VERSION="23.10-0.5.5.0"
OS="ubuntu22.04"
ARCH="x86_64"

wget https://content.mellanox.com/ofed/MLNX_OFED-${OFED_VERSION}/MLNX_OFED_LINUX-${OFED_VERSION}-${OS}-${ARCH}.tgz
tar xzf MLNX_OFED_LINUX-${OFED_VERSION}-${OS}-${ARCH}.tgz
cd MLNX_OFED_LINUX-${OFED_VERSION}-${OS}-${ARCH}

# Install (this takes several minutes, includes kernel module compilation)
./mlnxofedinstall --add-kernel-support --skip-repo --force

# Restart driver
/etc/init.d/openibd restart

# Verify installation
ibv_devinfo
# Shows: hca_id, port state, transport type, etc.

# Check HCA details
ibstat
# Shows: CA, port state, rate, LID, GUID

# List IB devices
ls /dev/infiniband/
# uverbsN, rdmaN devices
```

### Verifying HCA and Fabric State

```bash
# Show all IB ports and their state
ibv_devinfo -v

# Expected output for active port:
# hca_id: mlx5_0
#   transport:            InfiniBand (0)
#   fw_ver:               28.39.3002
#   port:   1
#     state:              PORT_ACTIVE (4)
#     max_mtu:            4096 (5)
#     active_mtu:         4096 (5)
#     sm_lid:             1
#     port_lid:           7
#     link_layer:         InfiniBand

# Check fabric-level view (requires SM access)
iblinkinfo
ibhosts

# Run OpenSM (if no external SM)
opensm &
# Or configure as systemd service:
systemctl start opensm
systemctl enable opensm

# Verify routes
ibtracert 7 8  # Trace route from LID 7 to LID 8

# Check for errors
perfquery  # Per-port performance counters
```

### RDMA Subsystem Configuration

```bash
# Load RDMA modules
modprobe ib_core
modprobe ib_uverbs
modprobe ib_ucm
modprobe rdma_ucm
modprobe mlx5_core
modprobe mlx5_ib

# Make persistent
cat >> /etc/modules-load.d/rdma.conf << 'EOF'
ib_core
ib_uverbs
mlx5_core
mlx5_ib
rdma_ucm
EOF

# Configure huge pages (critical for RDMA memory pinning)
# RDMA requires pinning (locking) memory - huge pages reduce TLB pressure
echo 2048 > /sys/kernel/mm/hugepages/hugepages-2048kB/nr_hugepages
# For 1GB huge pages (best for large RDMA buffers):
echo 8 > /sys/kernel/mm/hugepages/hugepages-1048576kB/nr_hugepages

# Persistent huge page configuration
cat >> /etc/sysctl.d/99-hugepages.conf << 'EOF'
vm.nr_hugepages = 2048
vm.hugetlb_shm_group = 0
EOF

# Configure RDMA resource limits
cat >> /etc/security/limits.conf << 'EOF'
* soft memlock unlimited
* hard memlock unlimited
* soft nofile 1048576
* hard nofile 1048576
EOF

# Or via PAM limits for containers
ulimit -l unlimited
```

## RDMA Verbs Programming Model

RDMA Verbs is the low-level API for InfiniBand and RDMA operations. Understanding the model is necessary for troubleshooting and performance analysis.

### Core Abstractions

```
Protection Domain (PD)     - Security boundary for RDMA resources
Memory Region (MR)         - Registered memory that HCA can DMA from/to
Queue Pair (QP)            - Communication channel (send + receive queues)
Completion Queue (CQ)      - Where HCA posts completion notifications
Address Handle (AH)        - Remote endpoint addressing
Work Request (WR)          - Operation submitted to send/receive queue
Work Completion (WC)       - Result of completed work request
```

### Minimal RDMA Send/Receive in C

```c
// rdma_example.c - simplified RDMA send/receive
#include <infiniband/verbs.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MSG_SIZE 4096
#define MAX_WR   64

struct rdma_context {
    struct ibv_context  *context;
    struct ibv_pd       *pd;
    struct ibv_mr       *mr;
    struct ibv_cq       *cq;
    struct ibv_qp       *qp;
    char                *buf;
};

int init_rdma_context(struct rdma_context *ctx, const char *device_name) {
    // Get list of IB devices
    int num_devices;
    struct ibv_device **device_list = ibv_get_device_list(&num_devices);
    if (!device_list || num_devices == 0) {
        fprintf(stderr, "No IB devices found\n");
        return -1;
    }

    // Find requested device
    struct ibv_device *device = NULL;
    for (int i = 0; i < num_devices; i++) {
        if (strcmp(ibv_get_device_name(device_list[i]), device_name) == 0) {
            device = device_list[i];
            break;
        }
    }
    if (!device) { return -1; }

    // Open device
    ctx->context = ibv_open_device(device);
    ibv_free_device_list(device_list);
    if (!ctx->context) { return -1; }

    // Create Protection Domain
    ctx->pd = ibv_alloc_pd(ctx->context);
    if (!ctx->pd) { return -1; }

    // Allocate and register memory
    ctx->buf = aligned_alloc(4096, MSG_SIZE);
    if (!ctx->buf) { return -1; }

    ctx->mr = ibv_reg_mr(ctx->pd, ctx->buf, MSG_SIZE,
        IBV_ACCESS_LOCAL_WRITE |
        IBV_ACCESS_REMOTE_READ |
        IBV_ACCESS_REMOTE_WRITE);
    if (!ctx->mr) { return -1; }

    // Create Completion Queue
    ctx->cq = ibv_create_cq(ctx->context, MAX_WR * 2, NULL, NULL, 0);
    if (!ctx->cq) { return -1; }

    // Create Queue Pair
    struct ibv_qp_init_attr qp_attr = {
        .send_cq = ctx->cq,
        .recv_cq = ctx->cq,
        .cap = {
            .max_send_wr = MAX_WR,
            .max_recv_wr = MAX_WR,
            .max_send_sge = 1,
            .max_recv_sge = 1,
        },
        .qp_type = IBV_QPT_RC,  // Reliable Connected
    };
    ctx->qp = ibv_create_qp(ctx->pd, &qp_attr);
    if (!ctx->qp) { return -1; }

    return 0;
}

// Post a receive buffer (pre-post before send arrives)
int post_recv(struct rdma_context *ctx) {
    struct ibv_sge sg = {
        .addr   = (uint64_t)ctx->buf,
        .length = MSG_SIZE,
        .lkey   = ctx->mr->lkey,
    };
    struct ibv_recv_wr wr = {
        .wr_id   = 1,
        .sg_list = &sg,
        .num_sge = 1,
    };
    struct ibv_recv_wr *bad_wr;
    return ibv_post_recv(ctx->qp, &wr, &bad_wr);
}

// Post a send
int post_send(struct rdma_context *ctx, size_t len) {
    struct ibv_sge sg = {
        .addr   = (uint64_t)ctx->buf,
        .length = len,
        .lkey   = ctx->mr->lkey,
    };
    struct ibv_send_wr wr = {
        .wr_id      = 2,
        .sg_list    = &sg,
        .num_sge    = 1,
        .opcode     = IBV_WR_SEND,
        .send_flags = IBV_SEND_SIGNALED,
    };
    struct ibv_send_wr *bad_wr;
    return ibv_post_send(ctx->qp, &wr, &bad_wr);
}

// Poll for completions
int poll_completions(struct rdma_context *ctx) {
    struct ibv_wc wc[MAX_WR];
    int ne = ibv_poll_cq(ctx->cq, MAX_WR, wc);
    for (int i = 0; i < ne; i++) {
        if (wc[i].status != IBV_WC_SUCCESS) {
            fprintf(stderr, "Completion error: %s\n", ibv_wc_status_str(wc[i].status));
            return -1;
        }
    }
    return ne;
}
```

## RoCE: RDMA over Converged Ethernet

RoCE (RDMA over Converged Ethernet) brings RDMA semantics to Ethernet infrastructure. Most enterprises choose RoCE v2 (which encapsulates IB transport in UDP/IP) because it runs on standard 100GbE or 400GbE switches.

### RoCE vs InfiniBand Comparison

| Aspect | InfiniBand | RoCE v2 |
|---|---|---|
| Latency | 1-2 μs | 2-5 μs |
| Throughput | 200-400 Gb/s | 100-400 Gb/s |
| Infrastructure | Dedicated IB fabric | Standard Ethernet |
| Packet loss tolerance | Lossless (hardware FC) | Requires PFC/ECN |
| Cost | High (IB switches) | Lower (Ethernet switches) |
| Management complexity | IB SM required | Standard network tooling |

### RoCE Configuration on Mellanox/NVIDIA NICs

```bash
# Check current link type
cat /sys/class/infiniband/mlx5_0/ports/1/link_layer
# InfiniBand or Ethernet

# Switch to Ethernet (RoCE) mode
mlxconfig -d /dev/mst/mt4117_pciconf0 set LINK_TYPE_P1=2  # 1=IB, 2=ETH

# Configure interface
ip link set enp3s0f0 up
ip addr add 192.168.100.10/24 dev enp3s0f0

# Configure RoCE v2 (UDP encapsulation)
cma_roce_mode -d mlx5_0 -p 1 -m 2  # mode 2 = RoCEv2

# Verify RoCE configuration
rdma link show
# link mlx5_0/1 state ACTIVE physical_state LINK_UP netdev enp3s0f0

# Configure Priority Flow Control (PFC) - essential for lossless RoCE
# On the NIC side:
mlnx_qos -i enp3s0f0 --pfc 0,0,0,0,0,0,0,0  # Disable on all priorities first
mlnx_qos -i enp3s0f0 --pfc 0,0,0,1,0,0,0,0  # Enable PFC on priority 3 (RDMA traffic)

# On the switch side (example for Arista):
# interface Ethernet1
#   flowcontrol send on
#   priority-flow-control on
#   priority-flow-control priority 3 no-drop

# Configure ECN (Explicit Congestion Notification) for RoCE
tc qdisc add dev enp3s0f0 root handle 1: prio
tc qdisc add dev enp3s0f0 parent 1:4 handle 40: red \
  limit 1000000 min 50000 max 200000 avpkt 1500 \
  burst 100 probability 1 bandwidth 100gbit ecn

# Configure DSCP marking for RDMA traffic
tc filter add dev enp3s0f0 protocol ip parent 1:0 prio 1 \
  u32 match ip dscp 26 0xfc flowid 1:4  # DSCP 26 = AF31, map to PFC priority 3
```

## SR-IOV for RDMA in Containers

SR-IOV (Single Root I/O Virtualization) allows a single physical HCA to appear as multiple virtual functions (VFs), each of which can be directly assigned to a container for near-native RDMA performance.

### Enabling SR-IOV on Mellanox HCAs

```bash
# Check SR-IOV capability
cat /sys/class/net/enp3s0f0/device/sriov_totalvfs
# e.g., 8 (supports up to 8 VFs)

# Enable SR-IOV and create VFs
echo 4 > /sys/class/net/enp3s0f0/device/sriov_numvfs

# Verify VFs created
ip link show enp3s0f0
# Will show VFs as enp3s0f0v0, enp3s0f0v1, etc.

# For persistent SR-IOV configuration
cat > /etc/NetworkManager/conf.d/sriov.conf << 'EOF'
[device-sriov-enp3s0f0]
match-device=interface-name:enp3s0f0
sriov-num-vfs=4
EOF

# Configure VF MAC addresses and VLAN (optional)
ip link set enp3s0f0 vf 0 mac 02:11:22:33:44:00
ip link set enp3s0f0 vf 1 mac 02:11:22:33:44:01
ip link set enp3s0f0 vf 2 mac 02:11:22:33:44:02
ip link set enp3s0f0 vf 3 mac 02:11:22:33:44:03

# For trust mode (needed for RDMA in some configurations)
ip link set enp3s0f0 vf 0 trust on
ip link set enp3s0f0 vf 1 trust on
```

## Kubernetes RDMA Device Plugin

The RDMA device plugin exposes RDMA resources to pods, enabling GPU-to-GPU RDMA in Kubernetes AI training clusters.

### Installing the RDMA Device Plugin

```bash
# Install using the official NVIDIA/Mellanox manifests
kubectl apply -f https://raw.githubusercontent.com/Mellanox/k8s-rdma-shared-dev-plugin/master/deployment/k8s-rdma-shared-dev-plugin-ds.yaml

# Verify plugin is running on all RDMA nodes
kubectl get daemonset rdma-shared-dp-ds -n kube-system
```

### ConfigMap for RDMA Device Plugin

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: rdma-devices
  namespace: kube-system
data:
  config.json: |
    {
      "configList": [
        {
          "resourceName": "rdma_shared_device_a",
          "rdmaHcaMax": 63,
          "selectors": {
            "vendors": ["15b3"],
            "deviceIDs": ["1017"],
            "ifNames": ["enp3s0f0", "enp3s0f1"]
          }
        }
      ]
    }
```

### Pod Requesting RDMA Resources

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: ai-training-worker
  namespace: ai-training
spec:
  containers:
    - name: trainer
      image: nvcr.io/nvidia/pytorch:24.09-py3
      command: ["/bin/bash", "-c"]
      args:
        - |
          # Verify RDMA device is available
          rdma link show
          # Run distributed training with NCCL over RDMA
          python -m torch.distributed.launch \
            --nproc_per_node=8 \
            --nnodes=4 \
            --node_rank=$NODE_RANK \
            --master_addr=$MASTER_ADDR \
            --master_port=29500 \
            train.py

      env:
        - name: NCCL_IB_DISABLE
          value: "0"
        - name: NCCL_IB_HCA
          value: "mlx5_0,mlx5_1"
        - name: NCCL_IB_GID_INDEX
          value: "3"
        - name: NCCL_SOCKET_IFNAME
          value: "eth0"
        - name: NCCL_DEBUG
          value: "INFO"
        # NCCL RDMA tuning
        - name: NCCL_IB_TIMEOUT
          value: "22"
        - name: NCCL_IB_RETRY_CNT
          value: "7"
        - name: NCCL_IB_SL
          value: "0"

      resources:
        requests:
          nvidia.com/gpu: 8
          rdma/rdma_shared_device_a: 1
        limits:
          nvidia.com/gpu: 8
          rdma/rdma_shared_device_a: 1

      securityContext:
        capabilities:
          add: ["IPC_LOCK"]  # Required for memory pinning (mlock)

      volumeMounts:
        - name: shm
          mountPath: /dev/shm
        - name: rdma-config
          mountPath: /etc/rdma

  volumes:
    - name: shm
      emptyDir:
        medium: Memory
        sizeLimit: 16Gi  # Shared memory for NCCL
    - name: rdma-config
      configMap:
        name: rdma-config

  nodeSelector:
    rdma-enabled: "true"
    nvidia.com/gpu.present: "true"

  tolerations:
    - key: nvidia.com/gpu
      operator: Exists
      effect: NoSchedule
```

### Multus for Multiple RDMA Interfaces

For multi-rail RDMA (multiple HCAs per node), use Multus CNI:

```yaml
apiVersion: k8s.cni.cncf.io/v1
kind: NetworkAttachmentDefinition
metadata:
  name: rdma-net-0
  namespace: ai-training
  annotations:
    k8s.v1.cni.cncf.io/resourceName: rdma/rdma_shared_device_a
spec:
  config: |
    {
      "cniVersion": "0.3.1",
      "type": "host-device",
      "device": "enp3s0f0",
      "ipam": {
        "type": "static",
        "addresses": [
          {"address": "192.168.1.0/24"}
        ]
      }
    }
---
apiVersion: k8s.cni.cncf.io/v1
kind: NetworkAttachmentDefinition
metadata:
  name: rdma-net-1
  namespace: ai-training
  annotations:
    k8s.v1.cni.cncf.io/resourceName: rdma/rdma_shared_device_b
spec:
  config: |
    {
      "cniVersion": "0.3.1",
      "type": "host-device",
      "device": "enp3s0f1",
      "ipam": {
        "type": "static",
        "addresses": [
          {"address": "192.168.2.0/24"}
        ]
      }
    }
```

```yaml
# Pod using multiple RDMA interfaces
apiVersion: v1
kind: Pod
metadata:
  name: multi-rail-trainer
  namespace: ai-training
  annotations:
    k8s.v1.cni.cncf.io/networks: rdma-net-0, rdma-net-1
spec:
  containers:
    - name: trainer
      image: nvcr.io/nvidia/pytorch:24.09-py3
      env:
        - name: NCCL_IB_HCA
          value: "mlx5_0,mlx5_1,mlx5_2,mlx5_3"  # All HCAs
      resources:
        requests:
          nvidia.com/gpu: 8
          rdma/rdma_shared_device_a: 1
          rdma/rdma_shared_device_b: 1
        limits:
          nvidia.com/gpu: 8
          rdma/rdma_shared_device_a: 1
          rdma/rdma_shared_device_b: 1
```

## Benchmarking RDMA Performance with perftest

The `perftest` suite provides standard RDMA benchmarks for bandwidth and latency.

### Installation

```bash
# From package manager
apt-get install perftest
# or
dnf install perftest

# Verify
ib_send_lat --help
ib_read_bw --help
```

### Latency Benchmarks

```bash
# Run latency test between two nodes
# On receiver (server):
ib_send_lat -d mlx5_0 -p 18515

# On sender (client):
ib_send_lat -d mlx5_0 -p 18515 192.168.100.20

# Expected output (HDR InfiniBand):
# ---------------------------------------------------------------------------------------
#                     Send Latency Test
#  Dual-port       : OFF  Device         : mlx5_0
#  Number of qps   : 1    Transport type : IB
#  Connection type : RC   Using SRQ      : OFF
#  TX depth        : 1
#  Mtu             : 4096[B]
#  Link type       : IB
#  Max inline data : 236[B]
# ---------------------------------------------------------------------------------------
#  #bytes #iterations    t_min[usec]    t_max[usec]  t_typical[usec]    t_avg[usec]    t_stdev[usec]
#      2       1000          1.22           2.45          1.28            1.30           0.11
#   1024       1000          1.31           2.67          1.38            1.40           0.12
#   4096       1000          1.45           2.89          1.52            1.55           0.14
#  65536       1000          2.87           4.23          2.95            2.98           0.15

# RDMA Read latency (one-sided, server CPU not involved in data path)
ib_read_lat -d mlx5_0 -p 18516  # server
ib_read_lat -d mlx5_0 -p 18516 192.168.100.20  # client

# Write latency
ib_write_lat -d mlx5_0 -p 18517  # server
ib_write_lat -d mlx5_0 -p 18517 192.168.100.20  # client
```

### Bandwidth Benchmarks

```bash
# RDMA Read bandwidth test
# Server:
ib_read_bw -d mlx5_0 -p 18520 -q 4 --report_gbits

# Client:
ib_read_bw -d mlx5_0 -p 18520 -q 4 --report_gbits 192.168.100.20

# Expected output (HDR 200Gb/s):
# ---------------------------------------------------------------------------------------
#                     RDMA_Read Bandwidth Test
# ---------------------------------------------------------------------------------------
#  #bytes     #iterations    BW peak[Gb/sec]    BW average[Gb/sec]   MsgRate[Mpps]
#  65536      1000           196.45             195.87               0.374

# RDMA Write bandwidth (typically higher than Read)
ib_write_bw -d mlx5_0 -p 18521 -q 4 --report_gbits  # server
ib_write_bw -d mlx5_0 -p 18521 -q 4 --report_gbits 192.168.100.20  # client

# Test with multiple queue pairs (more realistic for distributed training)
ib_write_bw -d mlx5_0 -p 18522 -q 8 --report_gbits  # server
ib_write_bw -d mlx5_0 -p 18522 -q 8 --report_gbits 192.168.100.20  # client

# RoCE-specific: test over Ethernet interface
ib_send_bw -d mlx5_0 -p 18523 \
  --report_gbits \
  -R  # Use RDMA_CM for connection management (required for RoCE)
```

### Automated Performance Validation Script

```bash
#!/bin/bash
# rdma_perf_test.sh - Run standard RDMA benchmark suite

REMOTE_HOST=$1
DEVICE=${2:-mlx5_0}
PORT_BASE=18500

if [ -z "$REMOTE_HOST" ]; then
    echo "Usage: $0 <remote-host> [device]"
    exit 1
fi

echo "=== RDMA Performance Test Suite ==="
echo "Device: $DEVICE"
echo "Remote: $REMOTE_HOST"
echo ""

run_test() {
    local test_name=$1
    local server_cmd=$2
    local client_cmd=$3

    echo "--- $test_name ---"
    # Start server in background
    $server_cmd &
    SERVER_PID=$!
    sleep 1

    # Run client
    ssh $REMOTE_HOST "$client_cmd" 2>&1 | grep -E "BW|Lat|bytes|Gbps|usec"

    kill $SERVER_PID 2>/dev/null
    wait $SERVER_PID 2>/dev/null
    echo ""
}

run_test "Send Latency (2B-64KB)" \
    "ib_send_lat -d $DEVICE -p $((PORT_BASE+1))" \
    "ib_send_lat -d $DEVICE -p $((PORT_BASE+1)) $(hostname -I | awk '{print $1}')"

run_test "Write Bandwidth (multiple QPs)" \
    "ib_write_bw -d $DEVICE -p $((PORT_BASE+2)) -q 8 --report_gbits" \
    "ib_write_bw -d $DEVICE -p $((PORT_BASE+2)) -q 8 --report_gbits $(hostname -I | awk '{print $1}')"

run_test "Read Bandwidth (multiple QPs)" \
    "ib_read_bw -d $DEVICE -p $((PORT_BASE+3)) -q 8 --report_gbits" \
    "ib_read_bw -d $DEVICE -p $((PORT_BASE+3)) -q 8 --report_gbits $(hostname -I | awk '{print $1}')"

echo "=== Performance Test Complete ==="
```

## NCCL Tuning for AI Training

NCCL (NVIDIA Collective Communication Library) uses RDMA for GPU-to-GPU transfers. Key tuning parameters:

```bash
# Environment variables for NCCL RDMA optimization
export NCCL_IB_DISABLE=0              # Enable InfiniBand
export NCCL_IB_HCA=mlx5_0,mlx5_1    # List of HCAs to use
export NCCL_IB_GID_INDEX=3           # GID index for RoCEv2 (typically 3)
export NCCL_IB_TC=106                 # Traffic class for DSCP marking
export NCCL_IB_SL=0                   # Service level (0 for most setups)
export NCCL_IB_TIMEOUT=22             # Timeout exponent (2^22 * 4.096ns ≈ 17ms)
export NCCL_IB_RETRY_CNT=7           # Retry count for reliable connections
export NCCL_IB_QPS_PER_CONNECTION=4  # QPs per NCCL connection (increase for bandwidth)
export NCCL_MIN_NCHANNELS=4          # Minimum communication channels
export NCCL_MAX_NCHANNELS=8          # Maximum communication channels
export NCCL_BUFFSIZE=8388608         # 8MB buffer size
export NCCL_ALGO=Ring                 # Ring algorithm for bandwidth, Tree for latency
export NCCL_PROTO=Simple             # Simple protocol (no pipeline)

# For debugging slow performance:
export NCCL_DEBUG=INFO
export NCCL_DEBUG_SUBSYS=INIT,NET,GRAPH

# Verify NCCL is using RDMA:
# NCCL INFO NET/IB : Using[0] mlx5_0:1/IB
# NCCL INFO NET/IB : Using[1] mlx5_1:1/IB
```

## Monitoring RDMA Performance

```bash
# Per-port statistics
perfquery -x 0 mlx5_0 1
# Shows: XmitData, RcvData, XmitPkts, RcvPkts, SymbolErrors, etc.

# Continuous monitoring
watch -n 1 'perfquery -x 0 mlx5_0 1 | grep -E "Xmit|Rcv"'

# InfiniBand bandwidth monitoring tool
ibtraf

# From /sys filesystem (no tools required)
cat /sys/class/infiniband/mlx5_0/ports/1/counters/port_xmit_data
cat /sys/class/infiniband/mlx5_0/ports/1/counters/port_rcv_data

# Calculate bandwidth (bytes counter, not bits)
PREV=$(cat /sys/class/infiniband/mlx5_0/ports/1/counters/port_xmit_data)
sleep 1
CURR=$(cat /sys/class/infiniband/mlx5_0/ports/1/counters/port_xmit_data)
# IB counters are in units of 4 bytes (lanes)
BW_GBPS=$(echo "scale=2; ($CURR - $PREV) * 4 * 8 / 1000000000" | bc)
echo "Transmit bandwidth: ${BW_GBPS} Gb/s"

# Check for errors (should be zero in healthy fabric)
cat /sys/class/infiniband/mlx5_0/ports/1/counters/symbol_error_counter
cat /sys/class/infiniband/mlx5_0/ports/1/counters/port_rcv_errors
cat /sys/class/infiniband/mlx5_0/ports/1/counters/port_xmit_discards
```

The operational discipline for InfiniBand and RDMA clusters requires tighter coupling between network operations and application teams than traditional Ethernet environments. The hardware flow control and lossless fabric properties that make RDMA fast also mean that a misconfigured PFC policy or a faulty HCA can cause fabric-wide performance degradation. Systematic monitoring of per-port error counters and benchmark-based acceptance testing for new nodes are non-negotiable operational practices for production AI training clusters.
