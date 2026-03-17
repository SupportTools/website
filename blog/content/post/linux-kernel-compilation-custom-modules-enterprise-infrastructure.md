---
title: "Linux Kernel Compilation and Custom Modules for Enterprise Infrastructure"
date: 2031-02-27T00:00:00-05:00
draft: false
tags: ["Linux", "Kernel", "Kernel Modules", "DKMS", "Secure Boot", "Performance Tuning"]
categories:
- Linux
- Systems Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Linux kernel compilation for cloud and container workloads, custom module development, module signing for Secure Boot, DKMS for out-of-tree modules, and kernel version management in enterprise environments."
more_link: "yes"
url: "/linux-kernel-compilation-custom-modules-enterprise-infrastructure/"
---

Enterprise infrastructure teams occasionally need to compile custom kernels or develop kernel modules — whether to enable hardware support not in the distribution kernel, implement custom network or storage hooks, patch performance regressions, or build security modules for compliance requirements. This guide covers the complete workflow from kernel configuration through production deployment with Secure Boot module signing.

<!--more-->

# Linux Kernel Compilation and Custom Modules for Enterprise Infrastructure

## Section 1: When to Compile a Custom Kernel

Most enterprise Linux deployments should use distribution-provided kernels (RHEL, Ubuntu, SUSE). The distro kernel is:
- Tested against the distribution's userspace
- Supported with security patches
- Compatible with certified hardware drivers
- Signed for Secure Boot

Reasons to compile a custom kernel or modules:

1. **Out-of-tree hardware drivers** not yet mainlined or backported.
2. **Performance patches** (e.g., BPF patches, scheduler improvements) not in the LTS backport.
3. **Custom LSM (Linux Security Module)** for compliance requirements.
4. **Container/cloud optimization**: remove unnecessary drivers to reduce attack surface and memory footprint.
5. **Debugging**: kernel instrumentation for production performance analysis.
6. **Custom kernel parameters**: enable `CONFIG_DEBUG_KMEMLEAK`, `CONFIG_KASAN` in a test environment.

## Section 2: Kernel Source and Build Environment

### Setting Up the Build Environment

```bash
# Ubuntu/Debian
apt-get install -y \
    build-essential \
    libncurses-dev \
    bison \
    flex \
    libssl-dev \
    libelf-dev \
    libudev-dev \
    libpci-dev \
    libiberty-dev \
    bc \
    rsync \
    git \
    kmod \
    cpio \
    dwarves  # for BTF (BPF Type Format) generation

# RHEL/CentOS/Rocky
yum groupinstall "Development Tools" -y
yum install -y \
    ncurses-devel \
    bison \
    flex \
    openssl-devel \
    elfutils-libelf-devel \
    bc \
    perl-generators \
    dwarves
```

### Obtaining Kernel Source

```bash
# Method 1: kernel.org tarball (recommended for clean builds)
KERNEL_VERSION="6.12.8"
wget https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-${KERNEL_VERSION}.tar.xz
wget https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-${KERNEL_VERSION}.tar.sign

# Verify GPG signature
gpg --locate-keys torvalds@kernel.org gregkh@kernel.org
xz -cd linux-${KERNEL_VERSION}.tar.xz | gpg --verify linux-${KERNEL_VERSION}.tar.sign -

# Extract
tar xf linux-${KERNEL_VERSION}.tar.xz
cd linux-${KERNEL_VERSION}

# Method 2: From git (for development, slower)
git clone https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git
cd linux
git checkout v6.12.8

# Method 3: Ubuntu kernel source (includes Ubuntu patches)
apt-get source linux-image-$(uname -r)
# OR
git clone https://git.launchpad.net/~ubuntu-kernel/ubuntu/+source/linux/+git/jammy
```

## Section 3: Kernel Configuration

### Starting Configuration

```bash
# Method 1: Copy running kernel config (best for incremental changes)
cp /boot/config-$(uname -r) .config
make olddefconfig  # Accept defaults for new symbols

# Method 2: Start from distribution config
cp /usr/src/linux-headers-$(uname -r)/.config .config
make olddefconfig

# Method 3: Minimal config (manual, for embedded/container)
make allnoconfig   # Start with everything disabled

# Method 4: Interactive menuconfig
make menuconfig    # ncurses UI
make nconfig       # Alternative ncurses UI
make xconfig       # Qt UI (requires Qt5 dev packages)
```

### Key Container/Cloud Configuration Options

```bash
# Open menuconfig and enable these options for cloud/container optimization
make menuconfig

# REQUIRED for container workloads:
# Processor type and features -> Symmetric multi-processing support
CONFIG_SMP=y

# General setup -> Control Group support
CONFIG_CGROUPS=y
CONFIG_CGROUP_FREEZER=y
CONFIG_CGROUP_PIDS=y
CONFIG_CGROUP_DEVICE=y
CONFIG_CGROUP_CPUACCT=y
CONFIG_MEMCG=y
CONFIG_BLK_CGROUP=y

# Namespaces
CONFIG_NAMESPACES=y
CONFIG_UTS_NS=y
CONFIG_IPC_NS=y
CONFIG_PID_NS=y
CONFIG_NET_NS=y
CONFIG_USER_NS=y

# Networking -> BPF
CONFIG_BPF=y
CONFIG_BPF_SYSCALL=y
CONFIG_BPF_JIT=y
CONFIG_NET_CLS_BPF=y
CONFIG_NET_ACT_BPF=y
CONFIG_BPF_EVENTS=y

# File systems
CONFIG_OVERLAY_FS=y   # Required for container overlay storage
CONFIG_AUFS_FS=m      # Docker AUFS (legacy)

# Security
CONFIG_SECURITY=y
CONFIG_SECCOMP=y
CONFIG_SECCOMP_FILTER=y
CONFIG_SECURITY_APPARMOR=y
CONFIG_SECURITY_SELINUX=y

# Optimize performance:
# Remove all drivers not needed in cloud (reduces boot time and memory)
# Disable CONFIG_PCMCIA, CONFIG_IEEE1394, CONFIG_ISDN, CONFIG_INFINIBAND
# if not needed
```

### Scripted Configuration Changes

```bash
#!/bin/bash
# configure-cloud-kernel.sh — apply cloud-optimized settings non-interactively

KERNEL_SRC="${1:-.}"
cd "$KERNEL_SRC"

# Start from current running config
cp /boot/config-$(uname -r) .config

# Helper function
setconf() {
    scripts/config --set-val "$1" "$2"
}
enableconf() {
    scripts/config --enable "$1"
}
disableconf() {
    scripts/config --disable "$1"
}
moduleconf() {
    scripts/config --module "$1"
}

echo "Applying cloud-optimized kernel configuration..."

# Core virtualization
enableconf VIRTIO
enableconf VIRTIO_PCI
enableconf VIRTIO_NET
enableconf VIRTIO_BLK
enableconf VIRTIO_BALLOON
moduleconf VIRTIO_SCSI

# Container support
enableconf CGROUPS
enableconf CGROUP_FREEZER
enableconf CGROUP_PIDS
enableconf MEMCG
enableconf NAMESPACES
enableconf NET_NS
enableconf PID_NS
enableconf USER_NS

# BPF / eBPF
enableconf BPF
enableconf BPF_SYSCALL
enableconf BPF_JIT
enableconf NET_CLS_BPF
enableconf BPF_EVENTS
enableconf DEBUG_INFO_BTF  # Required for CO-RE BPF programs

# Overlayfs for containers
enableconf OVERLAY_FS

# Disable unnecessary hardware (reduces attack surface + memory)
disableconf PCMCIA
disableconf FIREWIRE
disableconf IEEE1394
disableconf ISDN
disableconf BLUETOOTH

# Performance
enableconf HZ_1000        # 1000 Hz timer
disableconf HZ_250
enableconf PREEMPT_VOLUNTARY
setconf HZ 1000

# Compression: use LZ4 for fast boot
setconf KERNEL_LZ4 y

# Accept new symbols with defaults
make olddefconfig

echo "Configuration complete."
echo "Verify key settings:"
grep -E "CONFIG_CGROUPS|CONFIG_NAMESPACES|CONFIG_BPF_SYSCALL|CONFIG_OVERLAY_FS" .config
```

## Section 4: Compiling the Kernel

### Basic Compilation

```bash
# Determine CPU count for parallel build
CPUS=$(nproc)

# Compile everything
# -j: parallel jobs (use all CPUs)
make -j${CPUS} 2>&1 | tee build.log

# Compile only specific subsystems (faster for development)
make -j${CPUS} kernel  # kernel image only
make -j${CPUS} modules  # modules only

# Cross-compile for ARM64 on x86 host
ARCH=arm64 CROSS_COMPILE=aarch64-linux-gnu- make -j${CPUS}
```

### Build Time Optimization

```bash
# Use ccache to cache compilations across builds
apt-get install ccache
export CC="ccache gcc"
export PATH=/usr/lib/ccache:$PATH

# Check ccache statistics
ccache -s

# Use clang instead of gcc (often faster, better diagnostics)
make CC=clang -j${CPUS}

# Distributed compilation with distcc
apt-get install distcc
export CCACHE_PREFIX=distcc
DISTCC_HOSTS="localhost worker1 worker2" make -j30

# Minimal rebuild after config change
make -j${CPUS} prepare  # Generate headers
make -j${CPUS} modules  # Only recompile changed modules
```

### Installing the Compiled Kernel

```bash
# Install kernel modules to /lib/modules/$(make kernelversion)
make modules_install

# Install kernel image, initrd, and update bootloader
make install

# This typically calls /sbin/installkernel which:
# 1. Copies vmlinuz to /boot/
# 2. Copies System.map to /boot/
# 3. Runs update-grub or grub2-mkconfig

# Generate initramfs
update-initramfs -c -k $(make kernelversion)  # Debian/Ubuntu
dracut --force /boot/initramfs-$(make kernelversion).img $(make kernelversion)  # RHEL

# Update GRUB
update-grub  # Debian/Ubuntu
grub2-mkconfig -o /boot/grub2/grub.cfg  # RHEL

# Reboot into the new kernel
reboot

# After reboot, verify
uname -r
```

## Section 5: Building a Kernel Module

### Hello World Module

```c
// hello_module.c — minimal kernel module

#include <linux/module.h>
#include <linux/kernel.h>
#include <linux/init.h>

MODULE_LICENSE("GPL");
MODULE_AUTHOR("Platform Engineering");
MODULE_DESCRIPTION("Hello World Kernel Module");
MODULE_VERSION("1.0");

static int __init hello_init(void)
{
    printk(KERN_INFO "hello_module: loaded\n");
    return 0;
}

static void __exit hello_exit(void)
{
    printk(KERN_INFO "hello_module: unloaded\n");
}

module_init(hello_init);
module_exit(hello_exit);
```

```makefile
# Makefile for out-of-tree module
obj-m += hello_module.o

KDIR := /lib/modules/$(shell uname -r)/build
PWD := $(shell pwd)

all:
	$(MAKE) -C $(KDIR) M=$(PWD) modules

clean:
	$(MAKE) -C $(KDIR) M=$(PWD) clean

install:
	$(MAKE) -C $(KDIR) M=$(PWD) modules_install
	depmod -A
```

```bash
# Build the module
make

# Load the module
insmod hello_module.ko

# Check kernel log
dmesg | tail -5
# [12345.678901] hello_module: loaded

# List loaded modules
lsmod | grep hello_module

# Unload
rmmod hello_module

# Persistent loading (add to modules-load.d)
echo "hello_module" > /etc/modules-load.d/hello_module.conf
```

### Production-Quality Module: Custom Network Filter

```c
// netfilter_monitor.c — monitors and logs TCP connection events

#include <linux/module.h>
#include <linux/kernel.h>
#include <linux/netfilter.h>
#include <linux/netfilter_ipv4.h>
#include <linux/ip.h>
#include <linux/tcp.h>
#include <linux/in.h>
#include <linux/skbuff.h>
#include <linux/ktime.h>
#include <linux/ratelimit.h>

MODULE_LICENSE("GPL");
MODULE_AUTHOR("Platform Engineering");
MODULE_DESCRIPTION("TCP connection monitor with rate limiting");
MODULE_VERSION("1.0");

// Module parameters
static unsigned int monitor_port = 0;  // 0 = monitor all ports
module_param(monitor_port, uint, 0644);
MODULE_PARM_DESC(monitor_port, "Port to monitor (0 = all)");

static unsigned int log_rate_limit = 100;  // max 100 per second
module_param(log_rate_limit, uint, 0644);
MODULE_PARM_DESC(log_rate_limit, "Maximum log events per second");

// Statistics counters
static atomic64_t conn_count = ATOMIC64_INIT(0);
static atomic64_t syn_count = ATOMIC64_INIT(0);

// Rate limiter state
static DEFINE_RATELIMIT_STATE(tcp_ratelimit, HZ, 100);

// Netfilter hook function
static unsigned int tcp_monitor_hook(void *priv,
                                      struct sk_buff *skb,
                                      const struct nf_hook_state *state)
{
    struct iphdr *iph;
    struct tcphdr *tcph;
    __be32 src_ip, dst_ip;
    __be16 src_port, dst_port;

    // Validate the packet
    if (!skb)
        return NF_ACCEPT;

    iph = ip_hdr(skb);
    if (!iph || iph->protocol != IPPROTO_TCP)
        return NF_ACCEPT;

    tcph = tcp_hdr(skb);
    if (!tcph)
        return NF_ACCEPT;

    src_ip = iph->saddr;
    dst_ip = iph->daddr;
    src_port = ntohs(tcph->source);
    dst_port = ntohs(tcph->dest);

    // Filter by port if configured
    if (monitor_port != 0 && dst_port != monitor_port && src_port != monitor_port)
        return NF_ACCEPT;

    // Count connections
    atomic64_inc(&conn_count);

    // Count SYN packets (new connection attempts)
    if (tcph->syn && !tcph->ack) {
        atomic64_inc(&syn_count);

        // Rate-limited logging
        if (__ratelimit(&tcp_ratelimit)) {
            pr_info("tcp_monitor: SYN %pI4:%u -> %pI4:%u [total_syn=%lld]\n",
                    &src_ip, src_port,
                    &dst_ip, dst_port,
                    atomic64_read(&syn_count));
        }
    }

    return NF_ACCEPT;  // Never drop — monitoring only
}

// Netfilter hook registration struct
static struct nf_hook_ops tcp_monitor_ops = {
    .hook     = tcp_monitor_hook,
    .pf       = PF_INET,
    .hooknum  = NF_INET_PRE_ROUTING,
    .priority = NF_IP_PRI_FIRST,
};

// /proc interface for statistics
static int stats_show(struct seq_file *m, void *v)
{
    seq_printf(m, "total_packets: %lld\n", atomic64_read(&conn_count));
    seq_printf(m, "syn_packets: %lld\n", atomic64_read(&syn_count));
    seq_printf(m, "monitor_port: %u\n", monitor_port);
    return 0;
}

static int stats_open(struct inode *inode, struct file *file)
{
    return single_open(file, stats_show, NULL);
}

static const struct proc_ops stats_fops = {
    .proc_open    = stats_open,
    .proc_read    = seq_read,
    .proc_lseek   = seq_lseek,
    .proc_release = single_release,
};

static struct proc_dir_entry *proc_entry;

static int __init tcp_monitor_init(void)
{
    int ret;

    // Register netfilter hook
    ret = nf_register_net_hook(&init_net, &tcp_monitor_ops);
    if (ret) {
        pr_err("tcp_monitor: failed to register netfilter hook: %d\n", ret);
        return ret;
    }

    // Create /proc/tcp_monitor entry
    proc_entry = proc_create("tcp_monitor", 0444, NULL, &stats_fops);
    if (!proc_entry) {
        pr_warn("tcp_monitor: failed to create /proc/tcp_monitor\n");
        // Non-fatal — continue without proc entry
    }

    pr_info("tcp_monitor: loaded (port=%u, rate_limit=%u/s)\n",
            monitor_port, log_rate_limit);
    return 0;
}

static void __exit tcp_monitor_exit(void)
{
    nf_unregister_net_hook(&init_net, &tcp_monitor_ops);
    if (proc_entry)
        proc_remove(proc_entry);
    pr_info("tcp_monitor: unloaded (total=%lld, syn=%lld)\n",
            atomic64_read(&conn_count),
            atomic64_read(&syn_count));
}

module_init(tcp_monitor_init);
module_exit(tcp_monitor_exit);
```

## Section 6: Module Signing for Secure Boot

With Secure Boot enabled, the kernel will only load modules that are signed with a trusted key.

### Generating Module Signing Keys

```bash
# Create directory for signing keys
mkdir -p /root/module-signing
cd /root/module-signing

# Generate the key pair
openssl req -new -x509 \
  -newkey rsa:2048 \
  -keyout module-signing-key.pem \
  -out module-signing-cert.pem \
  -days 3650 \
  -subj "/O=Platform Engineering/CN=Module Signing Key/emailAddress=platform@example.com" \
  -nodes

# Convert cert to DER format for MOK enrollment
openssl x509 \
  -in module-signing-cert.pem \
  -out module-signing-cert.der \
  -outform DER

# Protect the private key
chmod 600 module-signing-key.pem

# Backup the key pair SECURELY
# Store in your HSM or encrypted vault — loss means you can't sign new modules
```

### Enrolling the Key with MOK (Machine Owner Key)

```bash
# Enroll the certificate with the MOK (Machine Owner Key) database
# This requires a reboot to confirm at the UEFI firmware level
mokutil --import module-signing-cert.der

# Set a temporary enrollment password when prompted
# On next boot, the UEFI firmware will show a MOK Manager screen
# Select "Enroll MOK" and confirm with your password

# Verify enrollment after reboot
mokutil --list-enrolled | grep -A 5 "Platform Engineering"
```

### Signing a Module

```bash
# Sign the module using the kernel's signing tool
# The kernel source provides the sign-file utility

# For modules built against the running kernel:
KERNEL_SRC="/lib/modules/$(uname -r)/build"
SIGN_TOOL="${KERNEL_SRC}/scripts/sign-file"

# Sign the module
${SIGN_TOOL} \
  sha256 \
  /root/module-signing/module-signing-key.pem \
  /root/module-signing/module-signing-cert.pem \
  netfilter_monitor.ko

# Verify the signature was added
modinfo netfilter_monitor.ko | grep signer
# signer: Platform Engineering Module Signing Key

# Test loading
insmod netfilter_monitor.ko
# Should succeed without "Required key not available" error
```

### Automating Module Signing in Makefile

```makefile
# Makefile with automatic signing
obj-m += netfilter_monitor.o

KDIR := /lib/modules/$(shell uname -r)/build
PWD := $(shell pwd)
SIGN_KEY := /root/module-signing/module-signing-key.pem
SIGN_CERT := /root/module-signing/module-signing-cert.pem
SIGN_FILE := $(KDIR)/scripts/sign-file

all: build sign

build:
	$(MAKE) -C $(KDIR) M=$(PWD) modules

sign: build
	@echo "Signing kernel modules..."
	@for mod in $(PWD)/*.ko; do \
		echo "  Signing $$mod"; \
		$(SIGN_FILE) sha256 $(SIGN_KEY) $(SIGN_CERT) $$mod; \
	done
	@echo "Signing complete."

install: sign
	$(MAKE) -C $(KDIR) M=$(PWD) modules_install
	depmod -A

clean:
	$(MAKE) -C $(KDIR) M=$(PWD) clean
```

## Section 7: DKMS — Dynamic Kernel Module Support

DKMS automatically rebuilds out-of-tree modules when you install a new kernel. This is critical for production systems that use custom modules — without DKMS, you'd need to manually rebuild after every kernel update.

### DKMS Configuration

```bash
# Install DKMS
apt-get install dkms  # Debian/Ubuntu
yum install dkms      # RHEL/CentOS (EPEL required)

# DKMS expects modules in:
# /usr/src/<module-name>-<module-version>/
```

### Creating a DKMS Module Package

```bash
# Set up the DKMS source directory
MODULE_NAME="netfilter-monitor"
MODULE_VERSION="1.0"
DKMS_DIR="/usr/src/${MODULE_NAME}-${MODULE_VERSION}"

mkdir -p "${DKMS_DIR}"
cp netfilter_monitor.c "${DKMS_DIR}/"
cp Makefile "${DKMS_DIR}/"
```

```
# /usr/src/netfilter-monitor-1.0/dkms.conf

PACKAGE_NAME="netfilter-monitor"
PACKAGE_VERSION="1.0"
CLEAN="make clean"
MAKE[0]="make all KVERSION=$kernelver"
BUILT_MODULE_NAME[0]="netfilter_monitor"
BUILT_MODULE_LOCATION[0]="."
DEST_MODULE_LOCATION[0]="/updates/dkms"
AUTOINSTALL="yes"

# Run post-install script to sign the module
POST_BUILD="sign-module.sh"
POST_INSTALL="depmod -A"

REMAKE_INITRD="no"
```

```bash
#!/bin/bash
# /usr/src/netfilter-monitor-1.0/sign-module.sh
# Automatically signs the module after DKMS builds it

SIGN_KEY="/root/module-signing/module-signing-key.pem"
SIGN_CERT="/root/module-signing/module-signing-cert.pem"
KERNEL_VERSION="${1}"
SIGN_TOOL="/lib/modules/${KERNEL_VERSION}/build/scripts/sign-file"

if [ -f "$SIGN_KEY" ] && [ -f "$SIGN_CERT" ]; then
    echo "Signing netfilter_monitor.ko for kernel ${KERNEL_VERSION}..."
    ${SIGN_TOOL} sha256 "${SIGN_KEY}" "${SIGN_CERT}" \
        "/lib/modules/${KERNEL_VERSION}/updates/dkms/netfilter_monitor.ko"
fi
```

```bash
# Register the module with DKMS
dkms add -m netfilter-monitor -v 1.0

# Build for the currently running kernel
dkms build -m netfilter-monitor -v 1.0

# Install
dkms install -m netfilter-monitor -v 1.0

# Verify
dkms status
# netfilter-monitor/1.0, 6.12.8-generic, x86_64: installed

# Build for a specific kernel version (e.g., after kernel upgrade)
dkms build -m netfilter-monitor -v 1.0 -k 6.13.0-generic
dkms install -m netfilter-monitor -v 1.0 -k 6.13.0-generic
```

### DKMS Lifecycle Commands

```bash
# List all registered DKMS modules
dkms status

# Show what kernels a module is built for
dkms status -m netfilter-monitor -v 1.0

# Remove module from a specific kernel
dkms remove -m netfilter-monitor -v 1.0 -k 6.11.0-generic

# Remove module from all kernels
dkms remove -m netfilter-monitor -v 1.0 --all

# Rebuild a module (after updating source)
dkms uninstall -m netfilter-monitor -v 1.0
dkms build -m netfilter-monitor -v 1.0
dkms install -m netfilter-monitor -v 1.0

# Test that DKMS hooks work correctly
apt-get install linux-headers-6.13.0-generic
# DKMS should automatically build netfilter-monitor for 6.13.0 during install
dkms status  # Should show netfilter-monitor/1.0 for 6.13.0-generic: installed
```

## Section 8: Kernel Version Management

### Managing Multiple Kernels with apt/yum

```bash
# Ubuntu/Debian: list all installed kernels
dpkg -l | grep linux-image

# Install a specific kernel version
apt-get install linux-image-6.12.8-generic linux-headers-6.12.8-generic

# Pin the default boot kernel
# Edit /etc/default/grub:
# GRUB_DEFAULT="Advanced options for Ubuntu>Ubuntu, with Linux 6.12.8-generic"
# Then: update-grub

# Check current boot kernel
uname -r

# RHEL/CentOS: list installed kernels
rpm -qa | grep kernel

# Set default kernel (RHEL)
grubby --set-default /boot/vmlinuz-6.12.8
grubby --default-kernel

# Remove old kernels (Ubuntu — keeps last 2 by default)
apt-get autoremove
# OR explicitly remove:
apt-get remove linux-image-6.11.0-generic linux-headers-6.11.0-generic
```

### Kernel Boot Parameters for Container Workloads

```bash
# Edit /etc/default/grub
GRUB_CMDLINE_LINUX_DEFAULT="quiet splash \
  transparent_hugepage=madvise \
  hugepagesz=1G hugepages=0 \
  intel_pstate=active \
  processor.max_cstate=1 \
  intel_idle.max_cstate=0 \
  skew_tick=1 \
  tsc=reliable \
  nohz=on \
  rcu_nocbs=1-$(nproc) \
  mitigations=auto"

# Key parameters explained:
# transparent_hugepage=madvise     - THP only when requested (avoid THP pauses for containers)
# skew_tick=1                      - Avoid all CPUs servicing tick at same time
# tsc=reliable                     - Skip TSC sanity check (faster boot on known-good HW)
# nohz=on                          - Tickless idle CPUs
# rcu_nocbs=1-N                    - Offload RCU callbacks from worker CPUs
# mitigations=auto                 - Apply CPU vulnerability mitigations

update-grub
```

## Section 9: Debugging Kernel Modules

### Using Dynamic Debug

```bash
# Enable debug messages for a specific module
echo "module netfilter_monitor +p" > /sys/kernel/debug/dynamic_debug/control

# Enable all debug messages in a file
echo "file netfilter_monitor.c +p" > /sys/kernel/debug/dynamic_debug/control

# Show current debug configuration
cat /sys/kernel/debug/dynamic_debug/control | grep netfilter_monitor

# Disable debug messages
echo "module netfilter_monitor -p" > /sys/kernel/debug/dynamic_debug/control
```

### Using kgdb for Kernel Debugging

```bash
# Compile kernel with debug support
scripts/config --enable DEBUG_KERNEL
scripts/config --enable KGDB
scripts/config --enable KGDB_SERIAL_CONSOLE
scripts/config --enable FRAME_POINTER

# Boot with kgdb
# Add to kernel parameters: kgdboc=ttyS0,115200 kgdbwait

# Connect gdb from another machine
gdb vmlinux
(gdb) target remote /dev/ttyS0
(gdb) continue
```

### Module Fault Injection

```bash
# Inject failures into kernel allocations for testing
echo Y > /sys/kernel/debug/failslab/task-filter
echo 1 > /sys/kernel/debug/failslab/probability
echo 1 > /sys/kernel/debug/failslab/times
echo -1 > /sys/kernel/debug/failslab/space

# Test your module handles allocation failures gracefully
insmod netfilter_monitor.ko
dmesg | grep "netfilter_monitor"
```

## Section 10: Packaging a Custom Kernel

### Creating a Debian Package

```bash
# Install packaging tools
apt-get install libdpkg-dev dpkg-dev fakeroot

# Build the kernel as a .deb package
make -j$(nproc) bindeb-pkg

# This creates in the parent directory:
# linux-image-6.12.8_6.12.8-1_amd64.deb   — the kernel and modules
# linux-headers-6.12.8_6.12.8-1_amd64.deb  — headers for module compilation

# Install on target systems
dpkg -i linux-image-6.12.8_6.12.8-1_amd64.deb \
        linux-headers-6.12.8_6.12.8-1_amd64.deb

# Distribute via internal APT repository
# Create local repo:
mkdir -p /srv/apt/pool/main
cp *.deb /srv/apt/pool/main/
cd /srv/apt
dpkg-scanpackages pool/main > Packages
gzip -k Packages

# Add to sources.list on target machines:
# deb [trusted=yes] http://internal-repo.company.com/apt ./
```

### Creating an RPM Package

```bash
# Build kernel as RPM
make -j$(nproc) rpm-pkg

# RPM is created in ~/rpmbuild/RPMS/x86_64/
ls ~/rpmbuild/RPMS/x86_64/
# kernel-6.12.8-1.x86_64.rpm

# Install
rpm -ivh kernel-6.12.8-1.x86_64.rpm

# Distribute via Satellite/Katello or local RPM repo
createrepo /srv/rpm/
```

## Summary

Kernel compilation and module development in enterprise environments requires attention to the full lifecycle:

1. **Configuration**: Start from the distribution config and modify incrementally. Use `scripts/config` for non-interactive changes in CI.
2. **DKMS**: Every out-of-tree module in production must use DKMS. Without it, kernel updates silently break your module.
3. **Module signing**: Secure Boot is standard in enterprise environments. Build your signing infrastructure before deploying custom modules to production.
4. **Build reproducibility**: Pin kernel version, use `make bindeb-pkg` or `make rpm-pkg` to create distributable artifacts, and store kernel configs in version control.
5. **Testing**: Test modules with CONFIG_KASAN (kernel address sanitizer) and CONFIG_LOCKDEP (lock dependency checker) in a dedicated test environment before promoting to production.
6. **Fallback**: Always have the previous kernel available at boot. Never purge all old kernels — keep at least one known-good version in the GRUB menu.

For most teams, the preferred path is contributing patches upstream to the Linux kernel or using DKMS for hardware-specific drivers rather than maintaining a permanent fork. Only maintain a full custom kernel when the changes are enterprise-specific and have no upstream path.
