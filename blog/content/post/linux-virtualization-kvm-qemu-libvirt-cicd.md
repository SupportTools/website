---
title: "Linux Virtualization: KVM, QEMU, libvirt, and Nested Virtualization for CI/CD"
date: 2030-02-21T00:00:00-05:00
draft: false
tags: ["Linux", "KVM", "QEMU", "libvirt", "Virtualization", "CI/CD", "GitLab", "GitHub Actions", "Performance Tuning"]
categories: ["Linux", "Virtualization"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to KVM and QEMU performance tuning, virtio driver configuration, hugepages for VMs, nested virtualization setup, cloud-init VM automation, and integrating hardware virtualization into GitLab and GitHub CI runners."
more_link: "yes"
url: "/linux-virtualization-kvm-qemu-libvirt-cicd/"
---

KVM (Kernel-based Virtual Machine) with QEMU provides near-native performance virtualization on Linux. Understanding how to configure it correctly — from virtio drivers and hugepages to nested virtualization and cloud-init — makes the difference between VMs that perform at 95% of bare-metal speed and VMs that struggle at 60%. This guide covers the complete operational picture, including using KVM-backed VMs as CI/CD runners where hardware virtualization provides better isolation and more realistic test environments than containers.

<!--more-->

## KVM Architecture

KVM is a kernel module that exposes the CPU's hardware virtualization extensions (Intel VT-x, AMD-V) as a file interface (`/dev/kvm`). QEMU uses these extensions to run guest virtual machines. The relationship:

- **KVM**: Kernel module providing CPU and memory virtualization
- **QEMU**: Userspace component providing device emulation, migration, and management
- **libvirt**: Management layer providing a stable API and CLI (`virsh`, `virt-manager`)
- **virtio**: Paravirtualized device drivers providing near-native I/O performance

```bash
# Verify KVM is available and functional
ls -la /dev/kvm
egrep -c '(vmx|svm)' /proc/cpuinfo  # > 0 means hardware virtualization supported

# Check KVM kernel modules
lsmod | grep kvm
# kvm_intel   xxx  0
# kvm         xxx  1 kvm_intel

# Install required packages (Debian/Ubuntu)
apt-get install -y \
  qemu-kvm \
  libvirt-daemon-system \
  libvirt-clients \
  virtinst \
  virt-manager \
  bridge-utils \
  cpu-checker

# Verify KVM is fully functional
kvm-ok
# INFO: /dev/kvm exists
# KVM acceleration can be used

# Verify libvirt is running
systemctl enable --now libvirtd
virsh version
```

## CPU Passthrough and Pinning

### CPU Model Configuration

For maximum performance, pass through the host CPU features to the guest. This enables the guest to use all CPU extensions (AVX-512, SHA, etc.) but prevents live migration to hosts with different CPU models:

```xml
<!-- /etc/libvirt/qemu/production-vm.xml - CPU section -->
<cpu mode='host-passthrough' check='partial' migratable='off'>
  <topology sockets='1' dies='1' cores='4' threads='2'/>
  <!-- Cache passthrough for NUMA-aware applications -->
  <cache mode='passthrough'/>
  <!-- Feature flags for database workloads -->
  <feature policy='require' name='x2apic'/>
  <feature policy='require' name='avx2'/>
  <feature policy='require' name='pdpe1gb'/>  <!-- 1GB hugepage support -->
</cpu>
```

### CPU Pinning for Latency-Sensitive VMs

CPU pinning assigns specific physical CPU cores exclusively to a VM, eliminating NUMA effects and scheduler interference:

```bash
# Check CPU topology before pinning
lscpu --extended
numactl --hardware

# Identify NUMA node topology
cat /sys/devices/system/node/node0/cpulist
# 0-11,24-35
cat /sys/devices/system/node/node1/cpulist
# 12-23,36-47
```

```xml
<!-- CPU pinning configuration for a 4-vCPU VM on NUMA node 0 -->
<vcpu placement='static'>4</vcpu>
<cputune>
  <!-- Pin vCPU 0 to physical CPU 2 -->
  <vcpupin vcpu='0' cpuset='2'/>
  <vcpupin vcpu='1' cpuset='3'/>
  <vcpupin vcpu='2' cpuset='26'/>  <!-- Hyperthreading sibling of 2 -->
  <vcpupin vcpu='3' cpuset='27'/>
  <!-- Pin the QEMU I/O thread to a different core -->
  <emulatorpin cpuset='0-1'/>
  <!-- NUMA-aware I/O thread placement -->
  <iothreadpin iothread='1' cpuset='0-1'/>
</cputune>

<numatune>
  <memory mode='strict' nodeset='0'/>
</numatune>
```

```bash
# Apply CPU pinning via virsh
virsh vcpupin production-vm 0 2
virsh vcpupin production-vm 1 3
virsh vcpupin production-vm 2 26
virsh vcpupin production-vm 3 27

# Verify pinning
virsh vcpuinfo production-vm
```

## virtio Drivers for Near-Native I/O

The virtio driver family provides paravirtualized devices that communicate directly with QEMU rather than emulating legacy hardware. This eliminates the overhead of emulating an IDE controller, RTL8139 NIC, etc.

### virtio-blk and virtio-scsi

```xml
<!-- High-performance storage configuration -->
<disk type='file' device='disk'>
  <driver name='qemu' type='qcow2'
          cache='none'          <!-- Bypass host page cache — use direct I/O -->
          io='native'           <!-- Use Linux native async I/O (not io_uring) -->
          discard='unmap'       <!-- Propagate TRIM/discard to host -->
          detect_zeroes='unmap' <!-- Optimize zero writes -->
  />
  <source file='/var/lib/libvirt/images/production-vm.qcow2'/>
  <target dev='vda' bus='virtio'/>
  <!-- Enable multiqueuue for high-IOPS workloads -->
  <driver queues='4'/>
</disk>

<!-- Or use raw images for maximum performance (no COW overhead) -->
<disk type='file' device='disk'>
  <driver name='qemu' type='raw' cache='none' io='native'/>
  <source file='/var/lib/libvirt/images/production-vm-data.raw'/>
  <target dev='vdb' bus='virtio'/>
</disk>
```

### virtio-net with Multi-Queue

```xml
<!-- High-throughput networking with virtio multiqueue -->
<interface type='bridge'>
  <source bridge='br0'/>
  <model type='virtio'/>
  <!-- Multiqueue: match vCPU count for maximum throughput -->
  <driver name='vhost' queues='4'/>
  <!-- Enable offloading features -->
  <guest csum='on' tso4='on' tso6='on' ufo='on' ecn='on'/>
  <host csum='on' tso4='on' tso6='on' ufo='on' ecn='on' mrg_rxbuf='on'/>
</interface>
```

```bash
# In the guest VM: enable multiqueue on the virtio NIC
ethtool -L eth0 combined 4

# Verify virtio-net multiqueue is active
cat /sys/class/net/eth0/queues/rx-0/rps_cpus
```

### vhost-user for DPDK Integration

For networking-intensive VMs that need DPDK-level performance:

```xml
<!-- vhost-user network interface for DPDK integration -->
<interface type='vhostuser'>
  <source type='unix' path='/var/run/vhost-user/vm0.sock' mode='server'/>
  <model type='virtio'/>
  <driver queues='4' rx_queue_size='1024' tx_queue_size='1024'/>
</interface>
```

## Hugepages for VM Memory

Hugepages reduce TLB pressure by using 2 MB or 1 GB memory pages instead of the default 4 KB pages. For VMs with several GBs of RAM, hugepages can provide 5-15% performance improvement for memory-intensive workloads.

### Configuring 2 MB Hugepages

```bash
# Check current hugepage status
cat /proc/meminfo | grep -i huge
# AnonHugePages:    524288 kB   (transparent hugepages)
# HugePages_Total:       0
# HugePages_Free:        0
# Hugepagesize:       2048 kB

# Allocate 2 MB hugepages at runtime
# For 8 GB of VM RAM: 8 * 1024 / 2 = 4096 hugepages
echo 4096 > /proc/sys/vm/nr_hugepages

# Mount the hugetlbfs
mkdir -p /dev/hugepages
mount -t hugetlbfs hugetlbfs /dev/hugepages

# Persistent via /etc/fstab and sysctl
echo 'vm.nr_hugepages = 4096' >> /etc/sysctl.d/99-hugepages.conf
echo 'hugetlbfs /dev/hugepages hugetlbfs mode=1770,gid=kvm 0 0' >> /etc/fstab

# Verify allocation
cat /proc/meminfo | grep HugePages
```

### Configuring 1 GB Hugepages (for large VMs)

```bash
# 1 GB pages must be allocated at boot time
# Edit /etc/default/grub
GRUB_CMDLINE_LINUX="default_hugepagesz=1G hugepagesz=1G hugepages=16"
update-grub
# Reboot required

# Verify 1 GB hugepages after reboot
cat /sys/kernel/mm/hugepages/hugepages-1048576kB/nr_hugepages
```

### libvirt Hugepage Configuration

```xml
<!-- VM memory configuration with hugepages -->
<memory unit='GiB'>8</memory>
<currentMemory unit='GiB'>8</currentMemory>
<memoryBacking>
  <hugepages>
    <!-- Use 1 GB hugepages for this VM -->
    <page size='1' unit='GiB'/>
  </hugepages>
  <!-- Lock pages in RAM — prevents swapping -->
  <locked/>
  <!-- No memory sharing with other VMs -->
  <nosharepages/>
</memoryBacking>

<numatune>
  <!-- Strict NUMA allocation — all memory from node 0 -->
  <memory mode='strict' nodeset='0'/>
  <memnode cellid='0' mode='strict' nodeset='0'/>
</numatune>
```

## Nested Virtualization

Nested virtualization allows a KVM guest to run its own KVM guests. This is essential for:

- Testing Kubernetes deployments that use KVM (e.g., KubeVirt, Kata Containers)
- Running Packer builds inside CI VMs
- Testing VM migration procedures

### Enabling Nested Virtualization

```bash
# Check if nested virtualization is already enabled
cat /sys/module/kvm_intel/parameters/nested
# Y = enabled, N = disabled

# Enable for Intel (temporary, until next reboot)
modprobe -r kvm_intel
modprobe kvm_intel nested=1

# Persistent Intel configuration
echo "options kvm_intel nested=1" > /etc/modprobe.d/kvm-intel.conf

# For AMD processors
modprobe -r kvm_amd
modprobe kvm_amd nested=1
echo "options kvm_amd nested=1" > /etc/modprobe.d/kvm-amd.conf

# Verify
cat /sys/module/kvm_intel/parameters/nested
# Y
```

### Guest VM Configuration for Nested Virtualization

The guest CPU must expose the vmx (Intel) or svm (AMD) flag:

```xml
<!-- CPU configuration for a nested virtualization host VM -->
<cpu mode='custom' match='exact'>
  <model fallback='forbid'>Haswell</model>
  <!-- Expose virtualization extensions to the guest -->
  <feature policy='require' name='vmx'/>   <!-- Intel -->
  <!-- OR for AMD hosts: -->
  <!-- <feature policy='require' name='svm'/> -->
</cpu>
```

```bash
# Verify nested virtualization is available inside the guest
egrep -c '(vmx|svm)' /proc/cpuinfo
ls /dev/kvm  # Must exist inside the guest
```

## cloud-init for Automated VM Provisioning

cloud-init is the standard for automating first-boot configuration of Linux VMs. It reads configuration from a metadata service (for cloud environments) or from an ISO image (for local/on-premises environments).

### Creating a cloud-init ISO

```bash
# cloud-init user-data file
cat > user-data <<'EOF'
#cloud-config

# Create users
users:
  - name: devops
    groups: sudo, docker
    shell: /bin/bash
    sudo: "ALL=(ALL) NOPASSWD:ALL"
    ssh_authorized_keys:
      - ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIxxxxxxxx devops@example.com

# Set hostname
hostname: ci-runner-01

# Install packages on first boot
package_update: true
package_upgrade: true
packages:
  - docker.io
  - qemu-guest-agent
  - curl
  - jq
  - git
  - unzip

# Enable and start services
runcmd:
  - systemctl enable --now docker
  - systemctl enable --now qemu-guest-agent
  - usermod -aG docker devops
  # Install GitLab Runner
  - curl -L https://packages.gitlab.com/install/repositories/runner/gitlab-runner/script.deb.sh | bash
  - apt-get install -y gitlab-runner
  - gitlab-runner register \
      --non-interactive \
      --url "https://gitlab.example.com/" \
      --registration-token "$(cat /etc/gitlab-runner-token)" \
      --executor "shell" \
      --description "KVM CI Runner $(hostname)" \
      --tag-list "kvm,linux,amd64" \
      --run-untagged=false

# Write the runner token from a secret
write_files:
  - path: /etc/gitlab-runner-token
    content: |
      glrt-xxxxxxxxxxxxxxxxxxxx
    permissions: '0400'
    owner: root:root

# Final message when cloud-init completes
final_message: |
  The system is finally up, after $UPTIME seconds

EOF

# Meta-data file
cat > meta-data <<'EOF'
instance-id: ci-runner-01
local-hostname: ci-runner-01
EOF

# Create the cloud-init ISO
genisoimage -output cloud-init.iso -volid cidata -joliet -rock user-data meta-data
# OR using cloud-localds:
cloud-localds cloud-init.iso user-data meta-data
```

### Automated VM Creation Script

```bash
#!/bin/bash
# scripts/create-ci-vm.sh
# Creates a new KVM VM for use as a CI runner

set -euo pipefail

VM_NAME="${1:?Usage: $0 <vm-name> [base-image]}"
BASE_IMAGE="${2:-/var/lib/libvirt/images/ubuntu-2404-base.qcow2}"
VM_CPU="${VM_CPU:-4}"
VM_RAM="${VM_RAM:-8192}"   # MB
VM_DISK="${VM_DISK:-50}"   # GB
OUTPUT_DIR="/var/lib/libvirt/images"

echo "=== Creating CI VM: $VM_NAME ==="
echo "CPU: $VM_CPU vCPUs, RAM: $VM_RAM MB, Disk: $VM_DISK GB"

# Create a disk image from the base
VM_DISK_PATH="${OUTPUT_DIR}/${VM_NAME}.qcow2"
qemu-img create -f qcow2 -b "${BASE_IMAGE}" -F qcow2 "${VM_DISK_PATH}" "${VM_DISK}G"

# Create cloud-init ISO with per-VM configuration
CLOUD_INIT_ISO="${OUTPUT_DIR}/${VM_NAME}-cloud-init.iso"

cat > /tmp/user-data-${VM_NAME} <<EOF
#cloud-config
hostname: ${VM_NAME}
users:
  - name: ci
    groups: sudo, docker
    sudo: "ALL=(ALL) NOPASSWD:ALL"
    ssh_authorized_keys:
      - $(cat /etc/ci/ci-ssh-pubkey)
runcmd:
  - systemctl enable --now docker
  - systemctl enable --now qemu-guest-agent
EOF

cat > /tmp/meta-data-${VM_NAME} <<EOF
instance-id: ${VM_NAME}
local-hostname: ${VM_NAME}
EOF

cloud-localds "${CLOUD_INIT_ISO}" \
  "/tmp/user-data-${VM_NAME}" \
  "/tmp/meta-data-${VM_NAME}"

# Create the VM using virt-install
virt-install \
  --name "${VM_NAME}" \
  --ram "${VM_RAM}" \
  --vcpus "${VM_CPU}" \
  --cpu host-passthrough \
  --disk "path=${VM_DISK_PATH},bus=virtio,cache=none,io=native" \
  --disk "path=${CLOUD_INIT_ISO},device=cdrom" \
  --network "bridge=br0,model=virtio" \
  --os-variant ubuntu24.04 \
  --graphics none \
  --console pty,target_type=serial \
  --boot hd \
  --noautoconsole \
  --memorybacking hugepages=yes \
  --numatune "nodeset=0,mode=strict" \
  --features "kvm_hidden=off,vmport=off" \
  --clock "offset=utc,rtc_tickpolicy=catchup"

echo "VM ${VM_NAME} created. Waiting for it to boot..."

# Wait for the VM to be accessible via SSH
timeout 300 bash -c "
  while ! ssh -o ConnectTimeout=5 \
    -o StrictHostKeyChecking=no \
    ci@\$(virsh domifaddr ${VM_NAME} | grep -oP '(\d+\.){3}\d+') \
    echo 'ready' 2>/dev/null; do
    sleep 5
  done
"

echo "VM ${VM_NAME} is ready"
virsh domifaddr "${VM_NAME}"
```

## KVM-Based CI Runners

### GitLab Runner with KVM Executor

GitLab's custom executor allows using KVM VMs as ephemeral build environments:

```bash
# Install GitLab Runner with custom executor support
# /etc/gitlab-runner/config.toml
```

```toml
[[runners]]
  name = "KVM CI Runner"
  url = "https://gitlab.example.com/"
  token = "glrt-xxxxxxxxxxxxxxxxxxxx"
  executor = "custom"
  [runners.custom]
    config_exec = "/opt/gitlab-runner-kvm/config.sh"
    config_exec_timeout = 200
    prepare_exec = "/opt/gitlab-runner-kvm/prepare.sh"
    prepare_exec_timeout = 300
    run_exec = "/opt/gitlab-runner-kvm/run.sh"
    cleanup_exec = "/opt/gitlab-runner-kvm/cleanup.sh"
    cleanup_exec_timeout = 300
    graceful_kill_timeout = 200
    force_kill_timeout = 30
```

```bash
#!/bin/bash
# /opt/gitlab-runner-kvm/prepare.sh
# Creates an ephemeral VM for each CI job

set -euo pipefail

JOB_ID="${CUSTOM_ENV_CI_JOB_ID}"
VM_NAME="gitlab-ci-${JOB_ID}"
BASE_IMAGE="/var/lib/libvirt/images/ubuntu-2404-ci-base.qcow2"

echo "Creating VM ${VM_NAME} for job ${JOB_ID}..."
/opt/gitlab-runner-kvm/create-vm.sh "${VM_NAME}" "${BASE_IMAGE}"

# Store VM name for use in run.sh and cleanup.sh
echo "${VM_NAME}" > "/tmp/gitlab-ci-${JOB_ID}-vm-name"

# Get the VM's IP address
VM_IP=$(virsh domifaddr "${VM_NAME}" | grep -oP '(\d+\.){3}\d+' | head -1)
echo "${VM_IP}" > "/tmp/gitlab-ci-${JOB_ID}-vm-ip"

echo "VM ${VM_NAME} ready at ${VM_IP}"
```

```bash
#!/bin/bash
# /opt/gitlab-runner-kvm/run.sh
# Executes a CI job step inside the ephemeral KVM VM

set -euo pipefail

SCRIPT="${1:?script required}"
STAGE="${2:?stage required}"

JOB_ID="${CUSTOM_ENV_CI_JOB_ID}"
VM_IP=$(cat "/tmp/gitlab-ci-${JOB_ID}-vm-ip")

echo "Running stage ${STAGE} in VM at ${VM_IP}..."

# SSH into the VM and run the step script
ssh -i /etc/gitlab-runner/ci-ssh-key \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  -o ConnectTimeout=30 \
  "ci@${VM_IP}" \
  "bash -s" < "${SCRIPT}"
```

```bash
#!/bin/bash
# /opt/gitlab-runner-kvm/cleanup.sh
# Destroys the ephemeral VM after job completion

set -euo pipefail

JOB_ID="${CUSTOM_ENV_CI_JOB_ID}"
VM_NAME_FILE="/tmp/gitlab-ci-${JOB_ID}-vm-name"

if [ -f "${VM_NAME_FILE}" ]; then
  VM_NAME=$(cat "${VM_NAME_FILE}")
  echo "Destroying VM ${VM_NAME}..."
  virsh destroy "${VM_NAME}" 2>/dev/null || true
  virsh undefine "${VM_NAME}" --remove-all-storage 2>/dev/null || true
  rm -f "${VM_NAME_FILE}" "/tmp/gitlab-ci-${JOB_ID}-vm-ip"
  echo "VM ${VM_NAME} destroyed"
fi
```

### GitHub Actions Self-Hosted Runner with VM Isolation

```yaml
# .github/workflows/kvm-ci.yml
name: KVM-Based CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  build-test:
    # Use runners tagged with kvm label
    runs-on: [self-hosted, kvm, linux]
    steps:
    - uses: actions/checkout@v4

    - name: Create ephemeral KVM VM for this job
      run: |
        VM_NAME="github-ci-${{ github.run_id }}-${{ github.run_attempt }}"
        echo "VM_NAME=${VM_NAME}" >> "$GITHUB_ENV"
        /opt/ci-runner/create-vm.sh "${VM_NAME}"
        VM_IP=$(virsh domifaddr "${VM_NAME}" | grep -oP '(\d+\.){3}\d+' | head -1)
        echo "VM_IP=${VM_IP}" >> "$GITHUB_ENV"

    - name: Run tests in VM
      run: |
        ssh -i /etc/ci/ci-ssh-key \
          -o StrictHostKeyChecking=no \
          "ci@${VM_IP}" \
          'cd /workspace && go test -race -count=1 ./...'

    - name: Cleanup VM
      if: always()
      run: |
        virsh destroy "${VM_NAME}" 2>/dev/null || true
        virsh undefine "${VM_NAME}" --remove-all-storage 2>/dev/null || true
```

## Performance Benchmarking

```bash
#!/bin/bash
# scripts/vm-benchmark.sh
# Benchmarks VM performance vs. bare metal baseline

set -euo pipefail

echo "=== VM Performance Benchmark ==="
echo "Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo ""
echo "--- CPU Performance ---"
# Sysbench CPU benchmark: compute prime numbers
sysbench cpu --cpu-max-prime=20000 --threads=4 run | \
  grep -E "events per second|total time"

echo ""
echo "--- Memory Bandwidth ---"
sysbench memory --memory-total-size=10G run | \
  grep -E "MiB/sec|total time"

echo ""
echo "--- Disk I/O (Sequential Write) ---"
# Direct I/O to bypass page cache
fio --name=seqwrite \
  --ioengine=libaio \
  --direct=1 \
  --rw=write \
  --bs=1M \
  --size=4G \
  --numjobs=4 \
  --runtime=60 \
  --output-format=json | \
  jq '.jobs[0].write | {bw_MBps: (.bw / 1024), iops: .iops, lat_ms: (.lat_ns.mean / 1e6)}'

echo ""
echo "--- Disk I/O (Random 4K Read) ---"
fio --name=randread \
  --ioengine=libaio \
  --direct=1 \
  --rw=randread \
  --bs=4k \
  --size=4G \
  --numjobs=4 \
  --runtime=60 \
  --output-format=json | \
  jq '.jobs[0].read | {bw_MBps: (.bw / 1024), iops: .iops, lat_us: (.lat_ns.mean / 1000)}'

echo ""
echo "--- Network Latency ---"
ping -c 100 -i 0.01 192.168.122.1 | tail -1
```

## Monitoring KVM Hosts

```bash
# Real-time VM performance monitoring
virt-top  # Like htop for VMs

# VM memory balloon statistics
virsh dommemstat production-vm
# actual 8388608
# swap_in 0
# swap_out 0
# major_fault 342
# minor_fault 1892342
# unused 4234234
# available 8388608
# last_update 1234567890
# rss 8123456   <-- actual RSS on host

# VM CPU statistics
virsh domstats production-vm --cpu-total

# Disk I/O statistics
virsh domblkstat production-vm vda

# Network statistics
virsh domifstat production-vm vnet0
```

```yaml
# Prometheus alerts for KVM host health
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kvm-host-alerts
  namespace: monitoring
spec:
  groups:
  - name: kvm-host
    rules:
    - alert: KVMHostMemoryPressure
      expr: |
        (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) > 0.90
        AND
        on(instance) kube_node_labels{label_node_role_kubernetes_io="kvm-host"}
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "KVM host {{ $labels.instance }} memory > 90%"
        description: "KVM host may start swapping VM memory, degrading performance"
```

## Key Takeaways

KVM with QEMU provides near-native performance for production workloads when configured correctly. The critical optimizations are:

CPU passthrough (`host-passthrough`) enables guest use of all host CPU extensions, providing the most realistic performance environment at the cost of migration compatibility. CPU pinning eliminates NUMA-related jitter for latency-sensitive workloads.

virtio drivers across all device types (disk, network) are mandatory for production performance. The difference between an emulated IDE disk and a virtio-blk disk is typically 3-5x IOPS. The difference between an emulated RTL8139 NIC and virtio-net is similar.

Hugepages reduce TLB miss rates for VMs with multi-GB RAM allocations. The performance benefit is most pronounced for VMs running databases, large JVM applications, and in-memory data processing.

For CI/CD workloads, ephemeral KVM VMs provide substantially better isolation than containers: each job gets a fresh kernel, clean filesystem, and independent network stack. The overhead is higher (VM boot time vs. container start), but the isolation prevents cross-job contamination that plagues shared container runners.

Nested virtualization enables testing KubeVirt, Kata Containers, and other VM-in-container scenarios inside CI without access to bare-metal hardware. Enable it on all CI host nodes regardless of current need — disabling it later is trivial, while enabling it after the fact requires a node reboot.
