---
title: "Linux Memory-Mapped I/O: /dev/mem, MMIO, and Kernel Device Drivers"
date: 2029-09-20T00:00:00-05:00
draft: false
tags: ["Linux", "Kernel", "Device Drivers", "MMIO", "PCIe", "VFIO", "UIO", "Systems Programming"]
categories: ["Linux", "Systems Programming"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Linux memory-mapped I/O: accessing hardware registers via mmap, kernel ioremap, write combining, PCIe BAR mapping, and building userspace device drivers with UIO and VFIO frameworks."
more_link: "yes"
url: "/linux-memory-mapped-io-dev-mem-mmio-kernel-device-drivers/"
---

Memory-mapped I/O (MMIO) is the mechanism by which software communicates with hardware devices by reading and writing to memory addresses that are mapped to device registers rather than RAM. On modern systems, virtually all PCIe devices expose their control registers through Base Address Registers (BARs) that appear as MMIO regions. Understanding how Linux maps, accesses, and protects these regions is essential for driver development, embedded systems, and high-performance device programming via VFIO. This post covers the full stack from hardware registers through kernel drivers to userspace VFIO drivers.

<!--more-->

# Linux Memory-Mapped I/O: /dev/mem, MMIO, and Kernel Device Drivers

## MMIO Fundamentals

### How Memory-Mapped I/O Works

In port I/O (PIO) systems, a separate address space exists for I/O devices, accessed via `in`/`out` instructions (x86). In MMIO, device registers appear at physical addresses in the same address space as RAM. The CPU cannot distinguish a load/store to a RAM address from one to a device register address — the memory controller routes the access to the appropriate destination based on the physical address.

```
Physical Address Space:
0x0000000000000000 - 0x00000000FFFFFFFF  (4 GiB)
  0x0000000000000000 - 0x0000000080000000  -> DRAM
  0x00000000A0000000 - 0x00000000BFFFFFFF  -> PCI/PCIe MMIO (32-bit)
  0x0000000100000000 - 0x000000FFFFFFFFFF  -> DRAM (above 4 GiB)
  0x0000800000000000 - ...                 -> PCIe MMIO (64-bit BARs)
```

The processor's MTRRs (Memory Type Range Registers) or PAT (Page Attribute Table) determine the caching behavior for each physical address range. Device registers must use uncached or write-combining access to prevent the CPU from reordering or buffering operations.

### Cache Attributes and Memory Types

```c
// Memory types that affect MMIO access:
// UC  - Uncacheable: all reads/writes go to device, no reordering
//       Required for device status registers, control registers
// WC  - Write Combining: writes are buffered and sent as bursts
//       Used for display framebuffers, network Tx rings
// WB  - Write Back: normal RAM behavior — NEVER use for device registers
// WT  - Write Through: writes go to device and cache

// The kernel handles this via ioremap variants:
// ioremap()             -> UC (uncacheable)
// ioremap_wc()          -> WC (write combining)
// ioremap_uc()          -> UC (explicit)
// ioremap_cache()       -> WB (rarely correct for MMIO)
```

## Accessing MMIO from Userspace: /dev/mem

`/dev/mem` provides direct read/write access to the physical address space from userspace. It is protected by kernel configuration — `CONFIG_STRICT_DEVMEM` limits access to memory mapped I/O regions, and `CONFIG_DEVMEM` can be disabled entirely.

```c
// userspace-mmio.c — reading a PCIe device register via /dev/mem
#include <stdio.h>
#include <stdlib.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/mman.h>
#include <stdint.h>
#include <errno.h>
#include <string.h>

#define PAGE_SIZE       4096UL
#define PAGE_MASK       (~(PAGE_SIZE - 1))

typedef volatile uint32_t __iomem_u32;

// mmio_map maps a physical MMIO region into userspace virtual address space
// phys_base: physical base address of the MMIO region
// size:      size of the region in bytes
// Returns a pointer to the mapped region, or NULL on error
void *mmio_map(off_t phys_base, size_t size) {
    // Align to page boundary
    off_t page_base   = phys_base & PAGE_MASK;
    size_t page_offset = phys_base - page_base;
    size_t map_size   = size + page_offset;

    // Round up to page boundary
    map_size = (map_size + PAGE_SIZE - 1) & PAGE_MASK;

    int fd = open("/dev/mem", O_RDWR | O_SYNC);
    if (fd < 0) {
        fprintf(stderr, "open /dev/mem: %s\n", strerror(errno));
        fprintf(stderr, "Hint: run as root or use CONFIG_DEVMEM=y\n");
        return NULL;
    }

    void *mapped = mmap(NULL, map_size,
                        PROT_READ | PROT_WRITE,
                        MAP_SHARED,
                        fd, page_base);
    close(fd);

    if (mapped == MAP_FAILED) {
        fprintf(stderr, "mmap: %s\n", strerror(errno));
        return NULL;
    }

    return (char*)mapped + page_offset;
}

void mmio_unmap(void *addr, size_t size) {
    // Align back to page boundary for munmap
    void *page_addr = (void*)((uintptr_t)addr & PAGE_MASK);
    size_t page_offset = (uintptr_t)addr - (uintptr_t)page_addr;
    munmap(page_addr, size + page_offset);
}

// Read a 32-bit device register
uint32_t mmio_read32(const volatile uint32_t *base, size_t offset_bytes) {
    return __builtin_expect(*(base + offset_bytes/4), 0);
}

// Write a 32-bit device register
void mmio_write32(volatile uint32_t *base, size_t offset_bytes, uint32_t val) {
    *(base + offset_bytes/4) = val;
    // Memory barrier to ensure write completes before returning
    __sync_synchronize();
}

int main(void) {
    // Example: read PCI configuration space via ECAM (Enhanced Configuration Access Mechanism)
    // ECAM base address varies by platform; common on x86 at 0xE0000000 or similar
    // Check with: sudo cat /proc/iomem | grep "PCI ECAM"

    // For this example, we read a known device BAR region
    // In practice, read the BAR address from /sys/bus/pci/devices/BDFN/resource
    off_t bar0_phys = 0xFB000000; // example: read from /sys/bus/pci/devices/0000:01:00.0/resource
    size_t bar0_size = 0x100000;  // 1 MiB — read from resource file

    volatile uint32_t *regs = mmio_map(bar0_phys, bar0_size);
    if (!regs) return 1;

    // Read device ID register (offset 0x0 for most PCIe devices)
    uint32_t device_id = mmio_read32(regs, 0x0);
    printf("Device ID register: 0x%08X\n", device_id);

    // Read version register (hypothetical at offset 0x4)
    uint32_t version = mmio_read32(regs, 0x4);
    printf("Version register:   0x%08X\n", version);

    mmio_unmap((void*)regs, bar0_size);
    return 0;
}
```

### Finding PCIe BAR Addresses

```bash
# List all PCI devices with their BAR addresses
lspci -v

# Get BAR addresses for a specific device (0000:01:00.0)
cat /sys/bus/pci/devices/0000:01:00.0/resource
# Output format:
# start              end                flags
# 0x00000000fb000000 0x00000000fbffffff 0x0000000000140204  <- BAR0 (32-bit MMIO)
# 0x0000000000000000 0x0000000000000000 0x0000000000000000  <- BAR1 (disabled)
# 0x00000000fb100000 0x00000000fb103fff 0x0000000000140204  <- BAR2

# flags field decodes:
# bit 8 = 1: I/O space (not MMIO)
# bit 9 = 1: 64-bit BAR
# bit 10 = 1: Prefetchable (can use WC mapping)

# Enable mmap on BAR0 from sysfs (safer than /dev/mem)
ls /sys/bus/pci/devices/0000:01:00.0/resource0
```

### Using sysfs Resource Files Instead of /dev/mem

```c
// Safer approach: mmap directly from the sysfs resource file
// This respects IOMMU and device access controls

void *map_pci_bar(const char *pci_addr, int bar_num) {
    char path[256];
    snprintf(path, sizeof(path),
             "/sys/bus/pci/devices/%s/resource%d", pci_addr, bar_num);

    int fd = open(path, O_RDWR | O_SYNC);
    if (fd < 0) {
        perror("open sysfs resource");
        return NULL;
    }

    // Get file size = BAR size
    off_t size = lseek(fd, 0, SEEK_END);
    lseek(fd, 0, SEEK_SET);

    void *mapped = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    close(fd);

    if (mapped == MAP_FAILED) {
        perror("mmap sysfs resource");
        return NULL;
    }
    return mapped;
}
```

## Kernel Driver: ioremap and MMIO Access

Inside kernel drivers, physical MMIO regions are accessed via `ioremap` which maps a physical address range into the kernel's virtual address space with appropriate cache attributes.

```c
// kernel/drivers/mydevice/mydevice.c
#include <linux/module.h>
#include <linux/pci.h>
#include <linux/io.h>
#include <linux/interrupt.h>
#include <linux/dma-mapping.h>

#define DRIVER_NAME "mydevice"

// Device register offsets
#define REG_DEVICE_ID    0x0000
#define REG_VERSION      0x0004
#define REG_CTRL         0x0008
#define REG_STATUS       0x000C
#define REG_IRQ_STATUS   0x0010
#define REG_IRQ_ENABLE   0x0014

// Control register bits
#define CTRL_ENABLE      BIT(0)
#define CTRL_RESET       BIT(1)
#define CTRL_IRQ_EN      BIT(2)

// Status register bits
#define STATUS_READY     BIT(0)
#define STATUS_ERROR     BIT(1)

struct mydevice {
    struct pci_dev *pdev;
    void __iomem   *bar0;      // mapped BAR0 registers
    void __iomem   *bar2;      // mapped BAR2 (DMA area)
    int             irq;
    spinlock_t      lock;
};

// ioread32/iowrite32 use appropriate barriers for MMIO access
static inline u32 dev_read(struct mydevice *dev, u32 offset) {
    return ioread32(dev->bar0 + offset);
}

static inline void dev_write(struct mydevice *dev, u32 offset, u32 val) {
    iowrite32(val, dev->bar0 + offset);
}

// Reset the device
static int mydevice_reset(struct mydevice *dev) {
    u32 ctrl;
    int timeout = 100; // 100ms

    dev_write(dev, REG_CTRL, CTRL_RESET);

    // Wait for reset to complete
    while (timeout--) {
        msleep(1);
        ctrl = dev_read(dev, REG_STATUS);
        if (ctrl & STATUS_READY)
            return 0;
    }
    return -ETIMEDOUT;
}

static irqreturn_t mydevice_isr(int irq, void *data) {
    struct mydevice *dev = data;
    u32 irq_status;
    unsigned long flags;

    spin_lock_irqsave(&dev->lock, flags);

    irq_status = dev_read(dev, REG_IRQ_STATUS);
    if (!irq_status) {
        spin_unlock_irqrestore(&dev->lock, flags);
        return IRQ_NONE;
    }

    // Clear interrupts by writing back the status
    dev_write(dev, REG_IRQ_STATUS, irq_status);

    spin_unlock_irqrestore(&dev->lock, flags);

    // Schedule work if needed
    // schedule_work(&dev->work);

    return IRQ_HANDLED;
}

static int mydevice_probe(struct pci_dev *pdev, const struct pci_device_id *id) {
    struct mydevice *dev;
    int ret;

    dev = devm_kzalloc(&pdev->dev, sizeof(*dev), GFP_KERNEL);
    if (!dev)
        return -ENOMEM;

    dev->pdev = pdev;
    spin_lock_init(&dev->lock);

    ret = pcim_enable_device(pdev);
    if (ret) {
        dev_err(&pdev->dev, "pcim_enable_device failed: %d\n", ret);
        return ret;
    }

    // Request and map BAR0 (UC — uncacheable, for control registers)
    ret = pcim_iomap_regions(pdev, BIT(0) | BIT(2), DRIVER_NAME);
    if (ret) {
        dev_err(&pdev->dev, "pcim_iomap_regions failed: %d\n", ret);
        return ret;
    }

    dev->bar0 = pcim_iomap_table(pdev)[0];
    dev->bar2 = pcim_iomap_table(pdev)[2];

    // For BAR2 (prefetchable, used for DMA), use write-combining mapping
    // This is important for performance when writing to VRAM or DMA descriptors
    // ioremap_wc is used for prefetchable BARs
    // dev->bar2_wc = ioremap_wc(pci_resource_start(pdev, 2),
    //                            pci_resource_len(pdev, 2));

    pci_set_master(pdev);

    // Set DMA mask
    ret = dma_set_mask_and_coherent(&pdev->dev, DMA_BIT_MASK(64));
    if (ret) {
        ret = dma_set_mask_and_coherent(&pdev->dev, DMA_BIT_MASK(32));
        if (ret) {
            dev_err(&pdev->dev, "DMA mask setup failed: %d\n", ret);
            return ret;
        }
    }

    // Read device identification
    u32 device_id = dev_read(dev, REG_DEVICE_ID);
    u32 version    = dev_read(dev, REG_VERSION);
    dev_info(&pdev->dev, "Device ID: 0x%08X, Version: 0x%08X\n",
             device_id, version);

    // Reset device to known state
    ret = mydevice_reset(dev);
    if (ret) {
        dev_err(&pdev->dev, "device reset timed out\n");
        return ret;
    }

    // Request IRQ
    ret = pci_alloc_irq_vectors(pdev, 1, 4, PCI_IRQ_MSI | PCI_IRQ_MSIX);
    if (ret < 0) {
        dev_err(&pdev->dev, "pci_alloc_irq_vectors failed: %d\n", ret);
        return ret;
    }

    dev->irq = pci_irq_vector(pdev, 0);
    ret = devm_request_irq(&pdev->dev, dev->irq, mydevice_isr,
                            0, DRIVER_NAME, dev);
    if (ret) {
        dev_err(&pdev->dev, "request_irq failed: %d\n", ret);
        return ret;
    }

    // Enable interrupts and bring device online
    dev_write(dev, REG_IRQ_ENABLE, 0xFFFFFFFF);
    dev_write(dev, REG_CTRL, CTRL_ENABLE | CTRL_IRQ_EN);

    pci_set_drvdata(pdev, dev);
    dev_info(&pdev->dev, "device initialized successfully\n");
    return 0;
}

static void mydevice_remove(struct pci_dev *pdev) {
    struct mydevice *dev = pci_get_drvdata(pdev);

    // Disable interrupts
    dev_write(dev, REG_IRQ_ENABLE, 0);
    dev_write(dev, REG_CTRL, 0);
}

static const struct pci_device_id mydevice_pci_ids[] = {
    { PCI_DEVICE(0x1234, 0x5678) },
    { 0, }
};
MODULE_DEVICE_TABLE(pci, mydevice_pci_ids);

static struct pci_driver mydevice_pci_driver = {
    .name     = DRIVER_NAME,
    .id_table = mydevice_pci_ids,
    .probe    = mydevice_probe,
    .remove   = mydevice_remove,
};

module_pci_driver(mydevice_pci_driver);

MODULE_LICENSE("GPL v2");
MODULE_AUTHOR("support.tools");
MODULE_DESCRIPTION("Example PCIe MMIO device driver");
```

## Write Combining for High-Bandwidth Regions

Write combining significantly improves performance for write-heavy MMIO regions like display framebuffers and network transmit queues. With WC, the CPU buffers writes in a 64-byte write-combining buffer and flushes them in a single burst transaction.

```c
// Kernel: explicitly using ioremap_wc for prefetchable BAR
void __iomem *wc_regs = ioremap_wc(pci_resource_start(pdev, 2),
                                     pci_resource_len(pdev, 2));

// Writing to WC region — these are buffered and sent as bursts
static void write_wc_batch(void __iomem *wc_base, u32 *data, size_t count) {
    size_t i;
    for (i = 0; i < count; i++)
        iowrite32(data[i], wc_base + i*4);
    // sfence (or wmb()) flushes the WC buffer
    wmb();
}

// Userspace WC access (important: must use non-temporal stores)
// C version:
static inline void write_wc_nt(volatile uint32_t *dst, uint32_t val) {
    // _mm_stream_si32 uses MOVNTI — non-temporal store that bypasses cache
    // and goes directly to the WC buffer
    __builtin_ia32_movnti((int*)dst, (int)val);
}

static inline void flush_wc_buffer(void) {
    // sfence: ensures all non-temporal stores are visible to other agents
    __builtin_ia32_sfence();
}
```

## PCIe BAR Mapping in Detail

A PCIe device can have up to 6 BARs (BARs 0-5). Each BAR describes an MMIO or I/O port region. The kernel reads BAR values during PCI enumeration.

```bash
# Examine BARs for a specific device
PCI_ADDR="0000:01:00.0"

# Raw resource file (hexadecimal start, end, flags)
cat /sys/bus/pci/devices/$PCI_ADDR/resource

# Human-readable BAR info
lspci -s $PCI_ADDR -vvv | grep -A5 "Region"

# Memory regions (from /proc/iomem)
grep -i "pci" /proc/iomem | head -20

# Enable device for userspace access (for sysfs-based mmap)
echo 1 > /sys/bus/pci/devices/$PCI_ADDR/enable
```

```c
// Read BAR attributes in kernel driver
resource_size_t bar0_start = pci_resource_start(pdev, 0);
resource_size_t bar0_len   = pci_resource_len(pdev, 0);
unsigned long   bar0_flags = pci_resource_flags(pdev, 0);

bool is_mmio       = (bar0_flags & IORESOURCE_MEM) != 0;
bool is_64bit      = (bar0_flags & IORESOURCE_MEM_64) != 0;
bool is_prefetch   = (bar0_flags & IORESOURCE_PREFETCH) != 0;

dev_info(&pdev->dev,
    "BAR0: start=%pa len=%pa mmio=%d 64bit=%d prefetch=%d\n",
    &bar0_start, &bar0_len, is_mmio, is_64bit, is_prefetch);

// For prefetchable BARs, use WC mapping when doing bulk writes
if (is_prefetch) {
    dev->bar0_wc = ioremap_wc(bar0_start, bar0_len);
} else {
    dev->bar0_uc = ioremap(bar0_start, bar0_len);
}
```

## Userspace Device Drivers: UIO Framework

The UIO (Userspace I/O) framework allows a minimal kernel driver to expose device BARs to userspace applications, enabling driver logic to be implemented in userspace.

### Minimal UIO Kernel Driver

```c
// kernel/drivers/uio/uio_mydevice.c
#include <linux/module.h>
#include <linux/pci.h>
#include <linux/uio_driver.h>

struct uio_mydevice {
    struct pci_dev *pdev;
    struct uio_info uio;
};

static irqreturn_t uio_mydevice_handler(int irq, struct uio_info *info) {
    struct uio_mydevice *dev = info->priv;
    void __iomem *regs = info->mem[0].internal_addr;

    // Read interrupt status
    u32 irq_status = ioread32(regs + 0x10);
    if (!irq_status)
        return IRQ_NONE;

    // Disable interrupts temporarily (userspace will re-enable)
    iowrite32(0, regs + 0x14); // disable IRQ enable register

    // Clear status
    iowrite32(irq_status, regs + 0x10);

    return IRQ_HANDLED;
}

static int uio_mydevice_probe(struct pci_dev *pdev, const struct pci_device_id *id) {
    struct uio_mydevice *priv;
    int ret;

    priv = devm_kzalloc(&pdev->dev, sizeof(*priv), GFP_KERNEL);
    if (!priv) return -ENOMEM;

    priv->pdev = pdev;

    ret = pcim_enable_device(pdev);
    if (ret) return ret;

    pci_set_master(pdev);

    // Expose BAR0 as UIO mem region 0
    priv->uio.mem[0].addr   = pci_resource_start(pdev, 0);
    priv->uio.mem[0].size   = pci_resource_len(pdev, 0);
    priv->uio.mem[0].memtype = UIO_MEM_PHYS;
    priv->uio.mem[0].internal_addr = pcim_iomap(pdev, 0, 0);

    priv->uio.name    = "mydevice";
    priv->uio.version = "1.0.0";
    priv->uio.irq     = pdev->irq;
    priv->uio.handler = uio_mydevice_handler;
    priv->uio.priv    = priv;

    ret = devm_uio_register_device(&pdev->dev, &priv->uio);
    if (ret) return ret;

    pci_set_drvdata(pdev, priv);
    return 0;
}

static const struct pci_device_id uio_mydevice_ids[] = {
    { PCI_DEVICE(0x1234, 0x5678) },
    { 0, }
};
MODULE_DEVICE_TABLE(pci, uio_mydevice_ids);

static struct pci_driver uio_mydevice_driver = {
    .name     = "uio_mydevice",
    .id_table = uio_mydevice_ids,
    .probe    = uio_mydevice_probe,
};
module_pci_driver(uio_mydevice_driver);
MODULE_LICENSE("GPL v2");
```

### Userspace UIO Driver (C)

```c
// userspace/uio_userdriver.c
#include <stdio.h>
#include <stdlib.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/mman.h>
#include <stdint.h>
#include <string.h>

#define UIO_DEV      "/dev/uio0"
#define SYSFS_UIO    "/sys/class/uio/uio0/maps/map0"

size_t get_map_size(const char *sysfs_path) {
    char path[256];
    snprintf(path, sizeof(path), "%s/size", sysfs_path);
    FILE *f = fopen(path, "r");
    if (!f) return 0;
    size_t size;
    fscanf(f, "0x%zx", &size);
    fclose(f);
    return size;
}

int main(void) {
    size_t bar_size = get_map_size(SYSFS_UIO);
    if (!bar_size) {
        fprintf(stderr, "Cannot read BAR size from sysfs\n");
        return 1;
    }

    int fd = open(UIO_DEV, O_RDWR);
    if (fd < 0) { perror("open uio"); return 1; }

    // mmap the BAR into userspace (offset = N * PAGE_SIZE for map N)
    volatile uint32_t *regs = mmap(NULL, bar_size,
                                    PROT_READ | PROT_WRITE,
                                    MAP_SHARED,
                                    fd, 0);  // offset 0 = map 0
    if (regs == MAP_FAILED) { perror("mmap"); close(fd); return 1; }

    printf("BAR0 size: 0x%zx\n", bar_size);
    printf("Device ID: 0x%08X\n", regs[0]);
    printf("Version:   0x%08X\n", regs[1]);

    // Enable device
    regs[2] = 0x1;  // CTRL_ENABLE
    __sync_synchronize();

    // Wait for interrupt
    uint32_t irq_count;
    printf("Waiting for interrupt...\n");
    if (read(fd, &irq_count, sizeof(irq_count)) < 0) {
        perror("read uio");
    } else {
        printf("Interrupt received (count: %u)\n", irq_count);
        // Re-enable interrupts (kernel driver disabled them)
        regs[5] = 0xFFFFFFFF;  // REG_IRQ_ENABLE
        // Acknowledge to kernel
        uint32_t irq_on = 1;
        write(fd, &irq_on, sizeof(irq_on));
    }

    munmap((void*)regs, bar_size);
    close(fd);
    return 0;
}
```

## VFIO: Secure Userspace Device Access

VFIO (Virtual Function I/O) provides a safer and more capable framework for userspace device drivers, particularly important for virtualisation (DPDK, SPDK, QEMU pass-through) and applications requiring IOMMU protection.

```bash
# Bind a PCIe device to VFIO driver
PCI_ADDR="0000:01:00.0"
VENDOR_DEVICE=$(cat /sys/bus/pci/devices/$PCI_ADDR/vendor \
                    /sys/bus/pci/devices/$PCI_ADDR/device | \
                paste - - | tr '\n' ' ' | tr -d ' ')

# Load VFIO modules
modprobe vfio
modprobe vfio-pci

# Unbind from current driver
echo $PCI_ADDR > /sys/bus/pci/devices/$PCI_ADDR/driver/unbind

# Bind to vfio-pci
echo $VENDOR_DEVICE > /sys/bus/pci/drivers/vfio-pci/new_id
echo $PCI_ADDR > /sys/bus/pci/drivers/vfio-pci/bind

# The IOMMU group for this device
IOMMU_GROUP=$(ls -la /sys/bus/pci/devices/$PCI_ADDR/iommu_group | \
              awk -F'/' '{print $NF}')
echo "IOMMU group: $IOMMU_GROUP"
```

```c
// vfio_userdriver.c — accessing a device via VFIO
#include <stdio.h>
#include <stdlib.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <linux/vfio.h>
#include <stdint.h>
#include <string.h>

int main(void) {
    // Open VFIO container
    int container = open("/dev/vfio/vfio", O_RDWR);
    if (container < 0) { perror("open /dev/vfio/vfio"); return 1; }

    // Check API version
    if (ioctl(container, VFIO_GET_API_VERSION) != VFIO_API_VERSION) {
        fprintf(stderr, "VFIO API version mismatch\n");
        return 1;
    }

    // Check IOMMU type support
    if (!ioctl(container, VFIO_CHECK_EXTENSION, VFIO_TYPE1_IOMMU)) {
        fprintf(stderr, "VFIO TYPE1 IOMMU not supported\n");
        return 1;
    }

    // Open the IOMMU group
    int group = open("/dev/vfio/42", O_RDWR); // group 42
    if (group < 0) { perror("open vfio group"); return 1; }

    // Check group is viable (device bound to vfio-pci)
    struct vfio_group_status gs = { .argsz = sizeof(gs) };
    ioctl(group, VFIO_GROUP_GET_STATUS, &gs);
    if (!(gs.flags & VFIO_GROUP_FLAGS_VIABLE)) {
        fprintf(stderr, "VFIO group not viable\n");
        return 1;
    }

    // Add group to container
    ioctl(group, VFIO_GROUP_SET_CONTAINER, &container);

    // Enable IOMMU on container
    ioctl(container, VFIO_SET_IOMMU, VFIO_TYPE1_IOMMU);

    // Get device fd
    int device = ioctl(group, VFIO_GROUP_GET_DEVICE_FD, "0000:01:00.0");
    if (device < 0) { perror("VFIO_GROUP_GET_DEVICE_FD"); return 1; }

    // Query device regions (BARs)
    struct vfio_device_info dev_info = { .argsz = sizeof(dev_info) };
    ioctl(device, VFIO_DEVICE_GET_INFO, &dev_info);
    printf("Device has %d regions and %d IRQs\n",
           dev_info.num_regions, dev_info.num_irqs);

    // Get BAR0 region info
    struct vfio_region_info reg_info = {
        .argsz = sizeof(reg_info),
        .index = VFIO_PCI_BAR0_REGION_INDEX,
    };
    ioctl(device, VFIO_DEVICE_GET_REGION_INFO, &reg_info);
    printf("BAR0: offset=0x%llx size=0x%llx flags=0x%x\n",
           reg_info.offset, reg_info.size, reg_info.flags);

    // Map BAR0 into userspace
    void *bar0 = mmap(NULL, reg_info.size,
                      PROT_READ | PROT_WRITE,
                      MAP_SHARED,
                      device, reg_info.offset);
    if (bar0 == MAP_FAILED) { perror("mmap BAR0"); return 1; }

    // Access device registers (IOMMU-protected)
    volatile uint32_t *regs = bar0;
    printf("Device ID: 0x%08X\n", regs[0]);

    munmap(bar0, reg_info.size);
    close(device);
    close(group);
    close(container);
    return 0;
}
```

## Memory Barrier Requirements

MMIO accesses require careful use of memory barriers to prevent CPU and compiler reordering.

```c
// Kernel MMIO barrier functions:
// rmb()  — read memory barrier
// wmb()  — write memory barrier
// mb()   — full memory barrier (read and write)
// mmiowb() — MMIO write barrier (for MMIO specifically)

// Example: writing a command register then polling status
void issue_command(void __iomem *regs, u32 cmd) {
    iowrite32(cmd, regs + REG_COMMAND);  // write command
    mmiowb();                            // ensure command write is visible to device
    // now safe to poll status
    u32 status;
    int timeout = 1000;
    do {
        status = ioread32(regs + REG_STATUS);
    } while (!(status & STATUS_DONE) && --timeout);
}

// Userspace equivalent:
static inline void mmio_wmb(void) {
    asm volatile("sfence" ::: "memory");  // x86
    // or: __atomic_thread_fence(__ATOMIC_SEQ_CST);
}
```

## Summary

Memory-mapped I/O is the foundation of all PCIe device communication on Linux. The key concepts are:

- **Physical address mapping**: Device registers appear at physical addresses determined by PCIe BAR configuration. Use `/proc/iomem` and sysfs to discover them.
- **Cache attributes matter**: Use UC (uncacheable) for control registers, WC (write combining) for bulk write regions like framebuffers. Wrong cache attributes cause subtle, intermittent bugs.
- **Kernel drivers use ioremap**: `ioremap()` for UC, `ioremap_wc()` for WC. Access via `ioread32()`/`iowrite32()` to include implicit barriers.
- **UIO framework** provides minimal kernel glue to expose BARs to userspace. Suitable for simple devices with straightforward interrupt handling.
- **VFIO framework** adds IOMMU protection and is the correct choice for production userspace drivers, DPDK, SPDK, and VM pass-through.
- **Memory barriers** are non-negotiable. Without them, the CPU and compiler may reorder register writes, causing undefined device behavior.
