---
title: "Linux KVM Virtualization: Production VM Management and Performance Tuning"
date: 2030-07-15T00:00:00-05:00
draft: false
tags: ["KVM", "Linux", "Virtualization", "libvirt", "QEMU", "Performance", "NUMA"]
categories:
- Linux
- Virtualization
- Infrastructure
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise KVM guide covering VM creation with libvirt, CPU pinning and NUMA topology, virtio device configuration, live migration, storage backend optimization, and monitoring VM performance with perf and virt-top."
more_link: "yes"
url: "/linux-kvm-virtualization-production-vm-management-performance-tuning/"
---

KVM (Kernel-based Virtual Machine) is the hypervisor of choice for enterprise Linux environments, powering OpenStack, oVirt, and custom virtualization platforms. Unlike type-2 hypervisors, KVM integrates directly into the Linux kernel, providing near-native performance for CPU-bound workloads. Effective production KVM deployments require understanding NUMA topology, CPU pinning, virtio paravirtualized devices, and storage I/O paths. This guide covers the configuration and operational practices needed to run KVM at scale with predictable performance.

<!--more-->

## Host Preparation and KVM Verification

### Hardware Virtualization Support

```bash
# Verify CPU supports virtualization extensions
grep -E "(vmx|svm)" /proc/cpuinfo | head -1

# Check KVM module is loaded
lsmod | grep kvm
# Expected output:
# kvm_intel    385024  0
# kvm          1032192  1 kvm_intel

# Verify KVM device nodes
ls -la /dev/kvm
# crw-rw---- 1 root kvm 10, 232 Jul 15 10:00 /dev/kvm

# Enable IOMMU for PCI passthrough (add to /etc/default/grub)
GRUB_CMDLINE_LINUX="intel_iommu=on iommu=pt"
# For AMD:
# GRUB_CMDLINE_LINUX="amd_iommu=on iommu=pt"

sudo update-grub
```

### Installing Libvirt and QEMU

```bash
# RHEL/Rocky Linux
sudo dnf install -y \
  qemu-kvm \
  libvirt \
  libvirt-client \
  libvirt-daemon-kvm \
  virt-install \
  virt-manager \
  virt-top \
  python3-libvirt \
  bridge-utils \
  tuned \
  numactl \
  numad \
  cpupower

sudo systemctl enable --now libvirtd

# Ubuntu/Debian
sudo apt install -y \
  qemu-kvm \
  libvirt-daemon-system \
  libvirt-clients \
  virtinst \
  virt-top \
  bridge-utils \
  cpu-checker \
  numactl \
  numad \
  linux-tools-$(uname -r)

sudo systemctl enable --now libvirtd

# Add user to libvirt and kvm groups
sudo usermod -aG libvirt,kvm $USER
```

### Host Tuning Profile

```bash
# Apply KVM host tuning profile
sudo tuned-adm profile virtual-host

# Verify active profile
tuned-adm active

# Check current CPU governor
cat /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor | sort -u

# Set performance governor for all CPUs
sudo cpupower frequency-set -g performance

# Disable transparent huge pages (THP) on KVM hosts for predictable latency
echo never | sudo tee /sys/kernel/mm/transparent_hugepage/enabled
echo never | sudo tee /sys/kernel/mm/transparent_hugepage/defrag

# Persist THP setting
cat | sudo tee /etc/systemd/system/disable-thp.service <<'EOF'
[Unit]
Description=Disable Transparent Huge Pages
DefaultDependencies=no
After=sysinit.target local-fs.target
Before=libvirtd.service

[Service]
Type=oneshot
ExecStart=/bin/sh -c "echo never > /sys/kernel/mm/transparent_hugepage/enabled"
ExecStart=/bin/sh -c "echo never > /sys/kernel/mm/transparent_hugepage/defrag"

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable disable-thp
```

## NUMA Topology Analysis

### Understanding NUMA Layout

```bash
# View NUMA topology
numactl --hardware
# Expected output:
# available: 2 nodes (0-1)
# node 0 cpus: 0 1 2 3 4 5 6 7 16 17 18 19 20 21 22 23
# node 0 size: 64481 MB
# node 0 free: 48210 MB
# node 1 cpus: 8 9 10 11 12 13 14 15 24 25 26 27 28 29 30 31
# node 1 size: 64509 MB
# node 1 free: 52108 MB
# node distances:
# node   0   1
#   0:  10  21
#   1:  21  10

# View CPU socket/core/thread topology
lscpu -e=CPU,SOCKET,NODE,CORE,THREAD

# View NUMA memory balancing statistics
cat /proc/vmstat | grep -i numa

# Check per-NUMA-node memory stats
numastat -m
```

## VM Creation with libvirt

### Creating a Production VM

```bash
# Create a VM with virt-install
virt-install \
  --name prod-app-01 \
  --ram 16384 \
  --vcpus 8,maxvcpus=16,sockets=1,cores=8,threads=1 \
  --cpu host-passthrough,cache.mode=passthrough \
  --os-variant rhel9.0 \
  --disk path=/var/lib/libvirt/images/prod-app-01.qcow2,size=100,format=qcow2,bus=virtio,cache=none,io=native \
  --disk path=/var/lib/libvirt/images/prod-app-01-data.qcow2,size=500,format=qcow2,bus=virtio,cache=none,io=native \
  --network bridge=br0,model=virtio \
  --graphics none \
  --serial pty \
  --console pty,target_type=serial \
  --location 'http://mirror.example.com/rocky/9/BaseOS/x86_64/os/' \
  --extra-args 'console=ttyS0,115200n8 inst.ks=http://ks.example.com/ks-prod.cfg' \
  --noautoconsole
```

### VM XML Definition with Detailed Configuration

```xml
<!-- /etc/libvirt/qemu/prod-database-01.xml -->
<domain type='kvm'>
  <name>prod-database-01</name>
  <uuid>a1b2c3d4-e5f6-7890-abcd-ef1234567890</uuid>
  <memory unit='GiB'>64</memory>
  <currentMemory unit='GiB'>64</currentMemory>

  <!-- Huge pages for database workloads -->
  <memoryBacking>
    <hugepages>
      <page size='2048' unit='KiB' nodeset='0'/>
    </hugepages>
    <nosharepages/>
    <locked/>
    <source type='memfd'/>
    <access mode='shared'/>
    <allocation mode='immediate'/>
  </memoryBacking>

  <vcpu placement='static' cpuset='0-7,16-23'>16</vcpu>

  <!-- NUMA topology matching host NUMA node 0 -->
  <numatune>
    <memory mode='strict' nodeset='0'/>
    <memnode cellid='0' mode='strict' nodeset='0'/>
  </numatune>

  <!-- CPU configuration with host passthrough for best performance -->
  <cpu mode='host-passthrough' check='none' migratable='off'>
    <topology sockets='1' cores='8' threads='2'/>
    <cache mode='passthrough'/>
    <!-- Disable NUMA balancing for pinned VMs -->
    <feature policy='disable' name='lahf_lm'/>
    <numa>
      <cell id='0' cpus='0-15' memory='67108864' unit='KiB' memAccess='shared'/>
    </numa>
  </cpu>

  <!-- Emulator and I/O threads pinned to dedicated CPUs -->
  <iothreads>4</iothreads>
  <cputune>
    <!-- Pin vCPUs to physical cores on NUMA node 0 -->
    <vcpupin vcpu='0' cpuset='0'/>
    <vcpupin vcpu='1' cpuset='16'/>
    <vcpupin vcpu='2' cpuset='1'/>
    <vcpupin vcpu='3' cpuset='17'/>
    <vcpupin vcpu='4' cpuset='2'/>
    <vcpupin vcpu='5' cpuset='18'/>
    <vcpupin vcpu='6' cpuset='3'/>
    <vcpupin vcpu='7' cpuset='19'/>
    <vcpupin vcpu='8' cpuset='4'/>
    <vcpupin vcpu='9' cpuset='20'/>
    <vcpupin vcpu='10' cpuset='5'/>
    <vcpupin vcpu='11' cpuset='21'/>
    <vcpupin vcpu='12' cpuset='6'/>
    <vcpupin vcpu='13' cpuset='22'/>
    <vcpupin vcpu='14' cpuset='7'/>
    <vcpupin vcpu='15' cpuset='23'/>
    <!-- Emulator and I/O threads on dedicated CPUs -->
    <emulatorpin cpuset='8-9'/>
    <iothreadpin iothread='1' cpuset='10'/>
    <iothreadpin iothread='2' cpuset='11'/>
    <iothreadpin iothread='3' cpuset='12'/>
    <iothreadpin iothread='4' cpuset='13'/>
    <!-- CPU scheduling policy -->
    <vcpusched vcpus='0-15' scheduler='fifo' priority='1'/>
    <iothreadsched iothreads='1-4' scheduler='fifo' priority='1'/>
  </cputune>

  <os>
    <type arch='x86_64' machine='pc-q35-8.0'>hvm</type>
    <loader readonly='yes' type='pflash'>/usr/share/edk2/ovmf/OVMF_CODE.fd</loader>
    <nvram>/var/lib/libvirt/qemu/nvram/prod-database-01_VARS.fd</nvram>
    <boot dev='hd'/>
    <bootmenu enable='no'/>
  </os>

  <features>
    <acpi/>
    <apic/>
    <vmport state='off'/>
    <!-- KVM optimizations -->
    <kvm>
      <hidden state='off'/>
    </kvm>
    <pvspinlock state='on'/>
  </features>

  <clock offset='utc'>
    <timer name='rtc' tickpolicy='catchup'/>
    <timer name='pit' tickpolicy='delay'/>
    <timer name='hpet' present='no'/>
    <!-- Use KVM clock for accurate timekeeping -->
    <timer name='kvmclock' present='yes'/>
    <timer name='hypervclock' present='no'/>
  </clock>

  <on_poweroff>destroy</on_poweroff>
  <on_reboot>restart</on_reboot>
  <on_crash>restart</on_crash>

  <pm>
    <suspend-to-mem enabled='no'/>
    <suspend-to-disk enabled='no'/>
  </pm>

  <devices>
    <emulator>/usr/bin/qemu-system-x86_64</emulator>

    <!-- System disk with virtio-blk and native I/O -->
    <disk type='file' device='disk'>
      <driver name='qemu' type='qcow2' cache='none' io='native'
              discard='unmap' detect_zeroes='unmap' queues='4'/>
      <source file='/var/lib/libvirt/images/prod-database-01-os.qcow2'/>
      <target dev='vda' bus='virtio'/>
      <boot order='1'/>
      <iotune>
        <total_bytes_sec>1073741824</total_bytes_sec>
        <total_iops_sec>50000</total_iops_sec>
      </iotune>
    </disk>

    <!-- Data disk with virtio-scsi for better queue depth -->
    <disk type='block' device='disk'>
      <driver name='qemu' type='raw' cache='none' io='native'
              discard='unmap' queues='8'/>
      <source dev='/dev/sdb'/>
      <target dev='sda' bus='scsi'/>
      <address type='drive' controller='0' bus='0' target='0' unit='0'/>
    </disk>

    <!-- virtio-scsi controller with multiple queues -->
    <controller type='scsi' index='0' model='virtio-scsi'>
      <driver queues='8' iothread='1'/>
    </controller>

    <!-- virtio-net with multiqueue -->
    <interface type='bridge'>
      <mac address='52:54:00:a1:b2:c3'/>
      <source bridge='br0'/>
      <model type='virtio'/>
      <driver name='vhost' queues='4'/>
      <tune>
        <sndbuf>0</sndbuf>
      </tune>
    </interface>

    <!-- Memory balloon for dynamic memory management -->
    <memballoon model='virtio'>
      <stats period='10'/>
    </memballoon>

    <!-- virtio-rng for entropy -->
    <rng model='virtio'>
      <backend model='random'>/dev/urandom</backend>
    </rng>

    <!-- virtio-serial for guest agent communication -->
    <channel type='unix'>
      <source mode='bind'
              path='/var/lib/libvirt/qemu/channel/prod-database-01.agent'/>
      <target type='virtio' name='org.qemu.guest_agent.0'/>
    </channel>

    <console type='pty'>
      <target type='serial' port='0'/>
    </console>

    <video>
      <model type='vga' vram='16384' heads='1' primary='yes'/>
    </video>
  </devices>

  <!-- Resource limits -->
  <blkiotune>
    <weight>800</weight>
  </blkiotune>

</domain>
```

### Applying the VM Definition

```bash
# Define the VM from XML
sudo virsh define /etc/libvirt/qemu/prod-database-01.xml

# Start the VM
sudo virsh start prod-database-01

# Enable autostart
sudo virsh autostart prod-database-01

# Verify the VM is running
sudo virsh list --all
sudo virsh dominfo prod-database-01
```

## Huge Pages Configuration

### Pre-allocating Huge Pages

```bash
# Check available huge page sizes
ls /sys/kernel/mm/hugepages/

# Allocate 1GB huge pages at boot (add to kernel cmdline)
GRUB_CMDLINE_LINUX="hugepagesz=1G hugepages=64 default_hugepagesz=1G"

# Allocate 2MB huge pages at runtime
echo 32768 | sudo tee /sys/kernel/mm/hugepages/hugepages-2048kB/nr_hugepages

# Persist 2MB huge pages via sysctl
echo "vm.nr_hugepages = 32768" | sudo tee /etc/sysctl.d/10-hugepages.conf
sudo sysctl --system

# Mount hugetlbfs
echo "hugetlbfs /dev/hugepages hugetlbfs defaults 0 0" | sudo tee -a /etc/fstab
sudo mount /dev/hugepages

# Verify allocation
cat /proc/meminfo | grep -i huge
# HugePages_Total:   32768
# HugePages_Free:    16384
# Hugepagesize:       2048 kB
```

### NUMA-Aware Huge Page Allocation

```bash
# Allocate huge pages on specific NUMA nodes
echo 16384 | sudo tee /sys/devices/system/node/node0/hugepages/hugepages-2048kB/nr_hugepages
echo 16384 | sudo tee /sys/devices/system/node/node1/hugepages/hugepages-2048kB/nr_hugepages

# Verify NUMA-node allocation
cat /sys/devices/system/node/node*/hugepages/hugepages-2048kB/nr_hugepages
```

## Storage Backend Optimization

### Storage Pool Types and Performance Characteristics

```bash
# Create a directory-based storage pool
sudo virsh pool-define-as images-pool dir \
  --target /var/lib/libvirt/images
sudo virsh pool-autostart images-pool
sudo virsh pool-start images-pool

# Create an LVM-based storage pool for better performance
sudo virsh pool-define-as lvm-pool logical \
  --source-dev /dev/sdb \
  --target /dev/vg-kvm
sudo virsh pool-start lvm-pool
sudo virsh pool-autostart lvm-pool

# Create a volume in the LVM pool
sudo virsh vol-create-as lvm-pool prod-db-data 200G

# Create thin-provisioned qcow2 volume
sudo virsh vol-create-as images-pool prod-app-01.qcow2 100G \
  --format qcow2 \
  --allocation 0
```

### Optimizing qcow2 Images

```bash
# Create an optimized base image
qemu-img create -f qcow2 \
  -o cluster_size=2M,lazy_refcounts=on,compression_type=zstd \
  /var/lib/libvirt/images/rhel9-base.qcow2 \
  100G

# Create a differencing image (thin clone)
qemu-img create -f qcow2 \
  -b /var/lib/libvirt/images/rhel9-base.qcow2 \
  -F qcow2 \
  /var/lib/libvirt/images/prod-app-01.qcow2

# Check image info
qemu-img info /var/lib/libvirt/images/prod-app-01.qcow2

# Compact an image (reclaim unused space)
sudo virsh domblkinfo prod-app-01 vda
qemu-img convert -O qcow2 \
  -o compression_type=zstd \
  prod-app-01.qcow2 \
  prod-app-01-compact.qcow2

# Check image integrity
qemu-img check /var/lib/libvirt/images/prod-app-01.qcow2
```

### Block Device I/O Tuning

```bash
# Check current I/O statistics for a domain
sudo virsh domblkstat prod-database-01 vda

# Set I/O throttling
sudo virsh blkdeviotune prod-database-01 vda \
  --total-bytes-sec 1073741824 \
  --total-iops-sec 50000 \
  --live

# Check current settings
sudo virsh blkdeviotune prod-database-01 vda
```

## Live Migration

### Prerequisites for Live Migration

```bash
# Configure shared storage (NFS example)
# On storage server
echo "/var/lib/libvirt/images  *(rw,sync,no_root_squash)" \
  | sudo tee -a /etc/exports
sudo exportfs -r

# On KVM hosts
sudo mount -t nfs storage-server:/var/lib/libvirt/images \
  /var/lib/libvirt/images

# Configure SSH key-based auth between KVM hosts
sudo ssh-keygen -t ed25519 -f /root/.ssh/id_ed25519 -N ""
sudo ssh-copy-id root@kvm-host-02.example.com

# Open required firewall ports (libvirt migration port range)
sudo firewall-cmd --add-port=49152-49215/tcp --permanent
sudo firewall-cmd --add-service=libvirt --permanent
sudo firewall-cmd --reload
```

### Performing Live Migration

```bash
# Basic live migration
sudo virsh migrate --live \
  prod-app-01 \
  qemu+ssh://kvm-host-02.example.com/system

# Migration with bandwidth limit (100 MB/s)
sudo virsh migrate --live \
  --bandwidth 100 \
  prod-app-01 \
  qemu+ssh://kvm-host-02.example.com/system

# Post-copy migration (useful when VM memory exceeds bandwidth)
sudo virsh migrate --live \
  --postcopy \
  prod-app-01 \
  qemu+ssh://kvm-host-02.example.com/system

# Monitor migration progress
sudo virsh domjobinfo prod-app-01

# Check migration status in real time
watch -n1 "sudo virsh domjobinfo prod-app-01 2>&1"
```

### Migration with Compression and Auto-converge

```bash
# Use XBZRLE compression for WAN migrations
sudo virsh migrate --live \
  --compressed \
  --comp-methods xbzrle \
  --comp-xbzrle-cache 512 \
  --auto-converge \
  --auto-converge-initial 20 \
  --auto-converge-increment 10 \
  prod-app-01 \
  qemu+ssh://kvm-host-02.example.com/system
```

## CPU Pinning Best Practices

### Analyzing and Applying CPU Pinning

```bash
# Show CPU topology
lstopo-no-graphics --no-io

# Check current vCPU pinning
sudo virsh vcpupin prod-database-01

# Pin individual vCPUs
sudo virsh vcpupin prod-database-01 0 0 --live
sudo virsh vcpupin prod-database-01 1 16 --live

# Set emulator thread pinning
sudo virsh emulatorpin prod-database-01 8-9 --live

# Verify pinning took effect
sudo virsh vcpupin prod-database-01
cat /proc/$(sudo virsh dumpxml prod-database-01 \
  | xmllint --xpath 'string(//domain/@id)' -)/status/cpuset
```

### Isolating Host CPUs from the Scheduler

```bash
# Isolate CPUs 0-15 from the host scheduler (for VM-exclusive use)
# Add to /etc/default/grub:
GRUB_CMDLINE_LINUX="isolcpus=0-15 nohz_full=0-15 rcu_nocbs=0-15"

# Verify isolation after reboot
cat /sys/devices/system/cpu/isolated

# Use systemd to restrict system services to remaining CPUs
sudo systemctl set-property --runtime system.slice AllowedCPUs=16-31
sudo systemctl set-property --runtime user.slice AllowedCPUs=16-31
sudo systemctl set-property --runtime init.scope AllowedCPUs=16-31
```

## Network Performance

### virtio-net Multiqueue Configuration

```bash
# Enable multiqueue in the VM's network interface
sudo virsh dumpxml prod-app-01 > /tmp/prod-app-01.xml
# Edit the interface section to add queues attribute

# After VM starts, configure the guest interface for multiqueue
# Inside the VM guest:
sudo ethtool -l eth0
sudo ethtool -L eth0 combined 4

# Verify multiqueue is active
cat /sys/class/net/eth0/queues/rx-*/rps_cpus
```

### macvtap for Near-Native Network Performance

```xml
<!-- macvtap interface for near-native performance -->
<interface type='direct'>
  <mac address='52:54:00:d1:e2:f3'/>
  <source dev='ens3' mode='bridge'/>
  <model type='virtio'/>
  <driver name='vhost' queues='4'/>
</interface>
```

### SR-IOV for Low-Latency Networking

```bash
# Enable SR-IOV Virtual Functions
echo 4 | sudo tee /sys/class/net/ens3/device/sriov_numvfs

# Verify VFs were created
ip link show ens3

# Bind a VF to a VM using PCI passthrough in the XML:
# <interface type='hostdev'>
#   <source>
#     <address type='pci' domain='0x0000' bus='0x04' slot='0x10' function='0x0'/>
#   </source>
# </interface>
```

## Monitoring VM Performance

### virt-top

```bash
# Monitor all VMs in real time
sudo virt-top

# Monitor specific metrics (CPU, memory, disk, network)
sudo virt-top --csv /tmp/virt-top.csv --csv-file /tmp/metrics.csv

# Non-interactive batch mode
sudo virt-top --batch --delay 5 --iterations 10
```

### perf-based VM Profiling

```bash
# Profile KVM exit reasons (requires root)
sudo perf kvm stat live -p $(pgrep -f prod-database-01)

# Common output interpretation:
# VM-EXIT reasons to watch:
# - EXTERNAL_INTERRUPT: Hardware interrupts, normal
# - HLT: Guest is idle, normal
# - EPT_MISCONFIG: Memory configuration issue, investigate
# - APIC_ACCESS: High APIC access rate can indicate virtualization overhead
# - VMCALL: Hypercall, can be high for paravirt-heavy workloads

# Profile specific KVM events
sudo perf kvm stat record -a sleep 30
sudo perf kvm stat report

# Monitor KVM exit latency
sudo perf stat -e kvm:kvm_exit,kvm:kvm_entry sleep 10
```

### Custom Prometheus Metrics for KVM

```bash
# Using libvirt-exporter
docker run -d \
  --name libvirt-exporter \
  --privileged \
  -v /var/run/libvirt:/var/run/libvirt:ro \
  -p 9177:9177 \
  ruanbekker/libvirt-exporter:latest

# Key metrics to monitor:
# libvirt_domain_vcpu_time_seconds_total - CPU time per vCPU
# libvirt_domain_block_stats_read_bytes_total - Disk read bytes
# libvirt_domain_block_stats_write_bytes_total - Disk write bytes
# libvirt_domain_interface_stats_receive_bytes_total - Network RX
# libvirt_domain_info_memory_usage_bytes - Memory usage
```

### libvirt API-Based Monitoring Script

```bash
#!/usr/bin/env python3
# vm-monitor.py - Collect and display VM performance metrics
import libvirt
import time
import json
from datetime import datetime

def get_vm_stats(conn):
    stats = []
    for domain in conn.listAllDomains(libvirt.VIR_CONNECT_LIST_DOMAINS_ACTIVE):
        info = domain.info()
        # CPU stats
        cpu_stats = domain.getCPUStats(True, 0)
        # Memory stats (requires qemu-guest-agent)
        try:
            mem_stats = domain.memoryStats()
        except libvirt.libvirtError:
            mem_stats = {}
        # Block stats for each disk
        block_devices = []
        xml = domain.XMLDesc()
        # Parse disk targets from XML (simplified)
        for dev in ['vda', 'vdb', 'sda']:
            try:
                blk = domain.blockStats(dev)
                block_devices.append({
                    'dev': dev,
                    'rd_req': blk[0],
                    'rd_bytes': blk[1],
                    'wr_req': blk[2],
                    'wr_bytes': blk[3],
                    'errors': blk[4],
                })
            except libvirt.libvirtError:
                pass

        stats.append({
            'name': domain.name(),
            'state': info[0],
            'max_mem_kb': info[1],
            'used_mem_kb': info[2],
            'vcpus': info[3],
            'cpu_time_ns': info[4],
            'cpu_user_ns': cpu_stats[0].get('user', 0),
            'cpu_system_ns': cpu_stats[0].get('system', 0),
            'mem_actual': mem_stats.get('actual', 0),
            'mem_available': mem_stats.get('available', 0),
            'block_devices': block_devices,
            'timestamp': datetime.utcnow().isoformat(),
        })
    return stats

if __name__ == '__main__':
    conn = libvirt.openReadOnly('qemu:///system')
    if conn is None:
        raise SystemExit("Failed to connect to libvirt")
    while True:
        data = get_vm_stats(conn)
        print(json.dumps(data, indent=2))
        time.sleep(10)
```

## Snapshot Management

### Taking and Managing Snapshots

```bash
# Create an external snapshot (preferred for production)
sudo virsh snapshot-create-as prod-app-01 \
  "pre-upgrade-$(date +%Y%m%d)" \
  "Snapshot before OS upgrade" \
  --disk-only \
  --atomic

# List snapshots
sudo virsh snapshot-list prod-app-01

# Show snapshot details
sudo virsh snapshot-dumpxml prod-app-01 pre-upgrade-20300715

# Revert to snapshot
sudo virsh snapshot-revert prod-app-01 pre-upgrade-20300715

# Delete a snapshot (external snapshots require blockcommit first)
sudo virsh blockcommit prod-app-01 vda \
  --active --verbose --pivot
sudo virsh snapshot-delete prod-app-01 pre-upgrade-20300715
```

## Security Hardening

### sVirt and SELinux Labeling

```bash
# Verify sVirt is active
sudo virsh seclabel prod-app-01
# system_u:system_r:svirt_t:s0:c100,c200

# Check SELinux labels on disk images
ls -lZ /var/lib/libvirt/images/

# Restore correct SELinux context
sudo restorecon -v /var/lib/libvirt/images/prod-app-01.qcow2

# Verify AppArmor profiles (Debian/Ubuntu)
sudo aa-status | grep virt
```

### Network Isolation with libvirt NAT Networks

```xml
<!-- Isolated network for sensitive workloads -->
<network>
  <name>prod-isolated</name>
  <uuid>c7f55aba-d4d7-4a9b-b6e3-f1234567890a</uuid>
  <bridge name='virbr10' stp='on' delay='0'/>
  <mac address='52:54:00:10:00:01'/>
  <ip address='192.168.100.1' netmask='255.255.255.0'>
    <dhcp>
      <range start='192.168.100.100' end='192.168.100.200'/>
    </dhcp>
  </ip>
  <forward mode='none'/>
</network>
```

## Troubleshooting Common Issues

```bash
# Check QEMU process limits
sudo virsh dumpxml prod-app-01 | grep -E "memlock|nofile"
cat /proc/$(pgrep -f prod-app-01)/limits

# Debug migration failures
sudo virsh migrate --verbose --live prod-app-01 qemu+ssh://kvm-host-02/system 2>&1

# Check for NUMA cross-node memory access
numastat -p $(pgrep -f prod-database-01)

# Diagnose disk I/O latency
sudo iostat -x 1 5 /dev/sdb
sudo blktrace -d /dev/sdb -o - | blkparse -i -

# Check vhost worker CPU usage
grep vhost /proc/*/comm | while read f; do
  pid=$(echo $f | cut -d/ -f3)
  echo "PID $pid: $(ps -p $pid -o pcpu= -o comm=)"
done

# Verify huge page consumption
grep -E "AnonHugePages|HugePages" /proc/meminfo
grep VmFlags /proc/$(pgrep -f prod-database-01)/smaps | head -20
```

## Summary

Production KVM deployments require careful attention to NUMA topology, CPU isolation, huge page allocation, and virtio device configuration to achieve near-native performance. CPU pinning eliminates NUMA latency by keeping vCPU threads and associated memory on the same NUMA node. virtio devices with multiqueue support scale I/O throughput proportionally to available host CPU cores. Live migration with auto-converge handles memory-intensive VMs across cluster maintenance windows. Combining libvirt-exporter metrics with Prometheus provides visibility into per-VM resource consumption at the hypervisor level, enabling capacity planning and performance optimization.
