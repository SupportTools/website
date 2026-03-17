---
title: "Linux Kernel Modules: Writing and Loading Custom Drivers"
date: 2029-08-29T00:00:00-05:00
draft: false
tags: ["Linux", "Kernel", "Device Drivers", "Systems Programming", "Kernel Modules", "C", "sysfs"]
categories: ["Linux", "Systems Programming"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to writing and loading Linux kernel modules covering module_init/module_exit lifecycle, kobject/kset hierarchies, sysfs entries, character device drivers, ioctl interfaces, and module parameters for production use."
more_link: "yes"
url: "/linux-kernel-modules-writing-loading-custom-drivers/"
---

Writing a Linux kernel module is the gateway to the most powerful layer of systems programming. Unlike user-space programs, kernel code runs with full hardware access, no memory protection between components, and zero tolerance for bugs — a null pointer dereference panics the kernel. This guide builds from a minimal module skeleton through a production-quality character device driver with a sysfs interface, ioctl command handling, and proper cleanup semantics.

<!--more-->

# Linux Kernel Modules: Writing and Loading Custom Drivers

## Section 1: Build Environment Setup

Kernel module development requires the kernel headers matching your running kernel. On production systems, always develop against the exact kernel version you will deploy to.

```bash
# Install required build tools
sudo apt-get install -y \
    build-essential \
    linux-headers-$(uname -r) \
    kmod \
    dkms

# Verify kernel headers are available
ls /lib/modules/$(uname -r)/build/include/linux/module.h

# Check kernel version
uname -r
# Example output: 6.8.0-55-generic

# Verify your GCC version matches the one used to build the kernel
cat /proc/version
# Example: Linux version 6.8.0-55-generic (buildd@...) (gcc-13 (Ubuntu 13.3.0) 13.3.0)
```

### Minimal Makefile for a Kernel Module

```makefile
# Makefile
# Target module name (without .ko extension)
MODULE_NAME := mydriver

# Kernel build directory
KDIR := /lib/modules/$(shell uname -r)/build

# Source files that make up the module
obj-m := $(MODULE_NAME).o
$(MODULE_NAME)-y := main.o device.o sysfs.o ioctl.o

# Default target: build the module
all:
	$(MAKE) -C $(KDIR) M=$(PWD) modules

# Clean build artifacts
clean:
	$(MAKE) -C $(KDIR) M=$(PWD) clean

# Install module to the system
install:
	$(MAKE) -C $(KDIR) M=$(PWD) modules_install
	depmod -a

# Load the module
load:
	insmod $(MODULE_NAME).ko

# Unload the module
unload:
	rmmod $(MODULE_NAME)

# Show module info
info:
	modinfo $(MODULE_NAME).ko

.PHONY: all clean install load unload info
```

## Section 2: Module Lifecycle — module_init and module_exit

Every kernel module has two mandatory lifecycle hooks: an initialization function called when the module is inserted, and an exit function called when the module is removed. These must be registered with the `module_init()` and `module_exit()` macros.

### Minimal Module Skeleton

```c
/* main.c - Minimal kernel module skeleton */
#include <linux/module.h>
#include <linux/kernel.h>
#include <linux/init.h>
#include <linux/fs.h>

/* Module metadata */
MODULE_LICENSE("GPL");
MODULE_AUTHOR("Support Tools <ops@support.tools>");
MODULE_DESCRIPTION("Production character device driver example");
MODULE_VERSION("1.0.0");

/* Module parameters - configurable at load time */
static int major_number = 0;  /* 0 = dynamic allocation */
module_param(major_number, int, S_IRUGO);
MODULE_PARM_DESC(major_number, "Major device number (0 for dynamic allocation)");

static char *device_name = "mydriver";
module_param(device_name, charp, S_IRUGO);
MODULE_PARM_DESC(device_name, "Device name as it appears in /dev");

static int buffer_size = 4096;
module_param(buffer_size, int, S_IRUGO | S_IWUSR);
MODULE_PARM_DESC(buffer_size, "Size of the internal ring buffer in bytes");

/* Forward declarations */
static int mydriver_init(void);
static void mydriver_exit(void);

/* Module entry point */
static int __init mydriver_init(void)
{
    pr_info("mydriver: initializing (major=%d, name=%s, buffer_size=%d)\n",
            major_number, device_name, buffer_size);

    /* Initialization steps in order - clean up on partial failure */
    int ret;

    ret = device_setup();
    if (ret) {
        pr_err("mydriver: device setup failed: %d\n", ret);
        return ret;
    }

    ret = sysfs_setup();
    if (ret) {
        pr_err("mydriver: sysfs setup failed: %d\n", ret);
        device_cleanup();
        return ret;
    }

    pr_info("mydriver: initialized successfully\n");
    return 0;
}

/* Module exit point - must undo everything init did, in reverse order */
static void __exit mydriver_exit(void)
{
    pr_info("mydriver: shutting down\n");
    sysfs_cleanup();
    device_cleanup();
    pr_info("mydriver: unloaded\n");
}

module_init(mydriver_init);
module_exit(mydriver_exit);
```

### The `__init` and `__exit` Annotations

The `__init` macro marks the function as initialization code. After the module is loaded and init completes, the kernel can free the memory occupied by init code. `__exit` marks code that is only needed during module removal — if the module is compiled into the kernel (not loadable), exit code is discarded entirely since built-in modules cannot be unloaded.

## Section 3: Character Device Driver

A character device is the most common driver type for custom hardware or virtual devices. It exposes a file-like interface in `/dev`, allowing user-space programs to `open()`, `read()`, `write()`, and `ioctl()` the device.

```c
/* device.c - Character device implementation */
#include <linux/module.h>
#include <linux/kernel.h>
#include <linux/cdev.h>
#include <linux/device.h>
#include <linux/fs.h>
#include <linux/uaccess.h>
#include <linux/slab.h>
#include <linux/mutex.h>
#include <linux/wait.h>
#include <linux/poll.h>
#include <linux/kfifo.h>
#include "mydriver.h"

#define DEVICE_COUNT 1
#define FIFO_SIZE    65536  /* 64 KiB ring buffer */

/* Per-device state */
struct mydriver_dev {
    struct cdev     cdev;
    struct device  *device;
    struct mutex    lock;
    wait_queue_head_t read_queue;
    wait_queue_head_t write_queue;
    DECLARE_KFIFO_PTR(fifo, u8);
    unsigned long   open_count;
    atomic_t        ref_count;
    u32             dropped_bytes;
};

/* Module-level state */
static struct class        *mydriver_class;
static struct mydriver_dev *mydriver_devices;
static dev_t                mydriver_devt;   /* First device number */
static int                  registered_major;

/* File operations - implemented below */
static int     mydriver_open(struct inode *inode, struct file *filp);
static int     mydriver_release(struct inode *inode, struct file *filp);
static ssize_t mydriver_read(struct file *filp, char __user *buf,
                              size_t count, loff_t *ppos);
static ssize_t mydriver_write(struct file *filp, const char __user *buf,
                               size_t count, loff_t *ppos);
static long    mydriver_ioctl(struct file *filp, unsigned int cmd,
                               unsigned long arg);
static __poll_t mydriver_poll(struct file *filp, struct poll_table_struct *wait);

static const struct file_operations mydriver_fops = {
    .owner          = THIS_MODULE,
    .open           = mydriver_open,
    .release        = mydriver_release,
    .read           = mydriver_read,
    .write          = mydriver_write,
    .unlocked_ioctl = mydriver_ioctl,
    .poll           = mydriver_poll,
};

/* Initialize device infrastructure */
int device_setup(void)
{
    int ret, i;
    dev_t devt;

    /* Allocate character device numbers */
    if (major_number == 0) {
        ret = alloc_chrdev_region(&mydriver_devt, 0, DEVICE_COUNT, device_name);
        registered_major = MAJOR(mydriver_devt);
    } else {
        mydriver_devt = MKDEV(major_number, 0);
        ret = register_chrdev_region(mydriver_devt, DEVICE_COUNT, device_name);
        registered_major = major_number;
    }
    if (ret < 0) {
        pr_err("mydriver: failed to allocate device numbers: %d\n", ret);
        return ret;
    }
    pr_info("mydriver: allocated major number %d\n", registered_major);

    /* Create device class (appears in /sys/class/) */
    mydriver_class = class_create(THIS_MODULE, "mydriver");
    if (IS_ERR(mydriver_class)) {
        ret = PTR_ERR(mydriver_class);
        pr_err("mydriver: failed to create class: %d\n", ret);
        goto err_unregister;
    }

    /* Allocate per-device structures */
    mydriver_devices = kcalloc(DEVICE_COUNT, sizeof(*mydriver_devices), GFP_KERNEL);
    if (!mydriver_devices) {
        ret = -ENOMEM;
        goto err_class;
    }

    /* Initialize each device */
    for (i = 0; i < DEVICE_COUNT; i++) {
        struct mydriver_dev *dev = &mydriver_devices[i];

        mutex_init(&dev->lock);
        init_waitqueue_head(&dev->read_queue);
        init_waitqueue_head(&dev->write_queue);
        atomic_set(&dev->ref_count, 0);

        /* Allocate the ring buffer */
        ret = kfifo_alloc(&dev->fifo, FIFO_SIZE, GFP_KERNEL);
        if (ret) {
            pr_err("mydriver: failed to allocate FIFO for device %d\n", i);
            goto err_devices;
        }

        /* Initialize the cdev and attach file operations */
        cdev_init(&dev->cdev, &mydriver_fops);
        dev->cdev.owner = THIS_MODULE;

        devt = MKDEV(registered_major, i);
        ret = cdev_add(&dev->cdev, devt, 1);
        if (ret) {
            pr_err("mydriver: cdev_add failed for device %d: %d\n", i, ret);
            kfifo_free(&dev->fifo);
            goto err_devices;
        }

        /* Create /dev/mydriver0 entry */
        dev->device = device_create(mydriver_class, NULL, devt, dev,
                                    "%s%d", device_name, i);
        if (IS_ERR(dev->device)) {
            ret = PTR_ERR(dev->device);
            pr_err("mydriver: device_create failed for device %d: %d\n", i, ret);
            cdev_del(&dev->cdev);
            kfifo_free(&dev->fifo);
            goto err_devices;
        }
    }

    return 0;

err_devices:
    /* Clean up any devices we successfully initialized */
    while (--i >= 0) {
        struct mydriver_dev *dev = &mydriver_devices[i];
        device_destroy(mydriver_class, MKDEV(registered_major, i));
        cdev_del(&dev->cdev);
        kfifo_free(&dev->fifo);
    }
    kfree(mydriver_devices);
err_class:
    class_destroy(mydriver_class);
err_unregister:
    unregister_chrdev_region(mydriver_devt, DEVICE_COUNT);
    return ret;
}

void device_cleanup(void)
{
    int i;
    for (i = 0; i < DEVICE_COUNT; i++) {
        struct mydriver_dev *dev = &mydriver_devices[i];
        device_destroy(mydriver_class, MKDEV(registered_major, i));
        cdev_del(&dev->cdev);
        kfifo_free(&dev->fifo);
    }
    kfree(mydriver_devices);
    class_destroy(mydriver_class);
    unregister_chrdev_region(mydriver_devt, DEVICE_COUNT);
}

/* open: called when user-space opens the device file */
static int mydriver_open(struct inode *inode, struct file *filp)
{
    struct mydriver_dev *dev;

    /* Get the per-device structure from the cdev embedded in the inode */
    dev = container_of(inode->i_cdev, struct mydriver_dev, cdev);
    filp->private_data = dev;

    atomic_inc(&dev->ref_count);
    dev->open_count++;

    pr_debug("mydriver: device opened (open_count=%lu, ref=%d)\n",
             dev->open_count, atomic_read(&dev->ref_count));
    return 0;
}

/* release: called when the last file descriptor for the device is closed */
static int mydriver_release(struct inode *inode, struct file *filp)
{
    struct mydriver_dev *dev = filp->private_data;

    atomic_dec(&dev->ref_count);
    pr_debug("mydriver: device released (ref=%d)\n", atomic_read(&dev->ref_count));
    return 0;
}

/* read: copy data from the kernel FIFO to user-space */
static ssize_t mydriver_read(struct file *filp, char __user *buf,
                              size_t count, loff_t *ppos)
{
    struct mydriver_dev *dev = filp->private_data;
    unsigned int copied;
    int ret;

    /* Non-blocking mode: return EAGAIN if no data */
    if (filp->f_flags & O_NONBLOCK) {
        if (kfifo_is_empty(&dev->fifo))
            return -EAGAIN;
    } else {
        /* Blocking mode: sleep until data is available */
        ret = wait_event_interruptible(dev->read_queue,
                                       !kfifo_is_empty(&dev->fifo));
        if (ret)
            return ret;
    }

    if (mutex_lock_interruptible(&dev->lock))
        return -ERESTARTSYS;

    ret = kfifo_to_user(&dev->fifo, buf, count, &copied);

    mutex_unlock(&dev->lock);

    if (ret)
        return ret;

    /* Wake up writers that may be sleeping */
    wake_up_interruptible(&dev->write_queue);

    return copied;
}

/* write: copy data from user-space into the kernel FIFO */
static ssize_t mydriver_write(struct file *filp, const char __user *buf,
                               size_t count, loff_t *ppos)
{
    struct mydriver_dev *dev = filp->private_data;
    unsigned int copied;
    int ret;

    if (filp->f_flags & O_NONBLOCK) {
        if (kfifo_is_full(&dev->fifo))
            return -EAGAIN;
    } else {
        ret = wait_event_interruptible(dev->write_queue,
                                       !kfifo_is_full(&dev->fifo));
        if (ret)
            return ret;
    }

    if (mutex_lock_interruptible(&dev->lock))
        return -ERESTARTSYS;

    ret = kfifo_from_user(&dev->fifo, buf, count, &copied);

    mutex_unlock(&dev->lock);

    if (ret)
        return ret;

    wake_up_interruptible(&dev->read_queue);

    return copied;
}

/* poll: support select/poll/epoll for non-blocking I/O readiness notification */
static __poll_t mydriver_poll(struct file *filp, struct poll_table_struct *wait)
{
    struct mydriver_dev *dev = filp->private_data;
    __poll_t mask = 0;

    poll_wait(filp, &dev->read_queue, wait);
    poll_wait(filp, &dev->write_queue, wait);

    if (!kfifo_is_empty(&dev->fifo))
        mask |= EPOLLIN | EPOLLRDNORM;   /* Data available to read */

    if (!kfifo_is_full(&dev->fifo))
        mask |= EPOLLOUT | EPOLLWRNORM;  /* Space available to write */

    return mask;
}
```

## Section 4: ioctl Interface

The `ioctl` interface allows user-space programs to send device-specific commands that don't fit the read/write model.

```c
/* ioctl.h - shared between kernel module and user-space */
#ifndef MYDRIVER_IOCTL_H
#define MYDRIVER_IOCTL_H

#include <linux/ioctl.h>
#include <linux/types.h>

#define MYDRIVER_IOC_MAGIC  0xAB

/* Command definitions */
#define MYDRIVER_IOCTL_RESET        _IO(MYDRIVER_IOC_MAGIC,  0)
#define MYDRIVER_IOCTL_GET_STATS    _IOR(MYDRIVER_IOC_MAGIC, 1, struct mydriver_stats)
#define MYDRIVER_IOCTL_SET_TIMEOUT  _IOW(MYDRIVER_IOC_MAGIC, 2, __u32)
#define MYDRIVER_IOCTL_GET_VERSION  _IOR(MYDRIVER_IOC_MAGIC, 3, __u32)

#define MYDRIVER_IOC_MAXNR 3

/* Statistics structure returned by MYDRIVER_IOCTL_GET_STATS */
struct mydriver_stats {
    __u64 bytes_read;
    __u64 bytes_written;
    __u32 read_errors;
    __u32 write_errors;
    __u32 fifo_size;
    __u32 fifo_used;
    __u32 open_count;
    __u32 dropped_bytes;
};

#endif /* MYDRIVER_IOCTL_H */
```

```c
/* ioctl.c - ioctl command handler */
#include <linux/module.h>
#include <linux/uaccess.h>
#include "mydriver.h"
#include "ioctl.h"

static long mydriver_ioctl(struct file *filp, unsigned int cmd, unsigned long arg)
{
    struct mydriver_dev *dev = filp->private_data;
    struct mydriver_stats stats;
    __u32 timeout;
    int ret = 0;

    /* Validate the magic number */
    if (_IOC_TYPE(cmd) != MYDRIVER_IOC_MAGIC)
        return -ENOTTY;

    /* Validate the command number */
    if (_IOC_NR(cmd) > MYDRIVER_IOC_MAXNR)
        return -ENOTTY;

    /* Verify user-space buffer accessibility */
    if (_IOC_DIR(cmd) & _IOC_READ) {
        ret = !access_ok((void __user *)arg, _IOC_SIZE(cmd));
        if (ret) return -EFAULT;
    }
    if (_IOC_DIR(cmd) & _IOC_WRITE) {
        ret = !access_ok((void __user *)arg, _IOC_SIZE(cmd));
        if (ret) return -EFAULT;
    }

    switch (cmd) {
    case MYDRIVER_IOCTL_RESET:
        if (mutex_lock_interruptible(&dev->lock))
            return -ERESTARTSYS;
        kfifo_reset(&dev->fifo);
        dev->stats.bytes_read = 0;
        dev->stats.bytes_written = 0;
        dev->stats.read_errors = 0;
        dev->stats.write_errors = 0;
        dev->dropped_bytes = 0;
        mutex_unlock(&dev->lock);
        pr_info("mydriver: device reset by user\n");
        break;

    case MYDRIVER_IOCTL_GET_STATS:
        mutex_lock(&dev->lock);
        stats.bytes_read    = dev->stats.bytes_read;
        stats.bytes_written = dev->stats.bytes_written;
        stats.read_errors   = dev->stats.read_errors;
        stats.write_errors  = dev->stats.write_errors;
        stats.fifo_size     = kfifo_size(&dev->fifo);
        stats.fifo_used     = kfifo_len(&dev->fifo);
        stats.open_count    = (u32)dev->open_count;
        stats.dropped_bytes = dev->dropped_bytes;
        mutex_unlock(&dev->lock);

        if (copy_to_user((struct mydriver_stats __user *)arg,
                         &stats, sizeof(stats)))
            return -EFAULT;
        break;

    case MYDRIVER_IOCTL_SET_TIMEOUT:
        if (copy_from_user(&timeout, (__u32 __user *)arg, sizeof(timeout)))
            return -EFAULT;
        if (timeout > 60000) {  /* Max 60 seconds */
            pr_warn("mydriver: timeout %u ms exceeds maximum, clamping to 60000\n",
                    timeout);
            timeout = 60000;
        }
        dev->timeout_ms = timeout;
        pr_info("mydriver: timeout set to %u ms\n", timeout);
        break;

    case MYDRIVER_IOCTL_GET_VERSION:
        {
            __u32 version = MYDRIVER_VERSION_PACKED;  /* e.g., (1 << 16) | (0 << 8) | 0 */
            if (copy_to_user((__u32 __user *)arg, &version, sizeof(version)))
                return -EFAULT;
        }
        break;

    default:
        return -ENOTTY;
    }

    return ret;
}
```

### User-Space ioctl Usage

```c
/* userspace/test_driver.c */
#include <stdio.h>
#include <stdlib.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/ioctl.h>
#include "ioctl.h"

int main(void)
{
    int fd;
    struct mydriver_stats stats;
    __u32 version;

    fd = open("/dev/mydriver0", O_RDWR);
    if (fd < 0) {
        perror("open");
        return EXIT_FAILURE;
    }

    /* Get driver version */
    if (ioctl(fd, MYDRIVER_IOCTL_GET_VERSION, &version) < 0) {
        perror("ioctl GET_VERSION");
        close(fd);
        return EXIT_FAILURE;
    }
    printf("Driver version: %d.%d.%d\n",
           (version >> 16) & 0xFF,
           (version >> 8) & 0xFF,
           version & 0xFF);

    /* Write some data */
    const char *test_data = "Hello, kernel!\n";
    ssize_t written = write(fd, test_data, strlen(test_data));
    printf("Wrote %zd bytes\n", written);

    /* Get stats */
    if (ioctl(fd, MYDRIVER_IOCTL_GET_STATS, &stats) < 0) {
        perror("ioctl GET_STATS");
        close(fd);
        return EXIT_FAILURE;
    }
    printf("Stats: bytes_written=%llu, fifo_used=%u/%u\n",
           (unsigned long long)stats.bytes_written,
           stats.fifo_used, stats.fifo_size);

    /* Reset the device */
    if (ioctl(fd, MYDRIVER_IOCTL_RESET) < 0) {
        perror("ioctl RESET");
    }

    close(fd);
    return EXIT_SUCCESS;
}
```

## Section 5: kobject, kset, and sysfs

The `kobject` infrastructure provides the foundation for sysfs — the virtual filesystem under `/sys` that exposes kernel objects to user-space.

```c
/* sysfs.c - sysfs attribute interface */
#include <linux/module.h>
#include <linux/kobject.h>
#include <linux/sysfs.h>
#include <linux/slab.h>
#include "mydriver.h"

static struct kobject *mydriver_kobj;

/* sysfs attribute: /sys/kernel/mydriver/buffer_size */
static ssize_t buffer_size_show(struct kobject *kobj,
                                 struct kobj_attribute *attr, char *buf)
{
    return sysfs_emit(buf, "%d\n", buffer_size);
}

static ssize_t buffer_size_store(struct kobject *kobj,
                                  struct kobj_attribute *attr,
                                  const char *buf, size_t count)
{
    int val;
    int ret;

    ret = kstrtoint(buf, 10, &val);
    if (ret)
        return ret;

    if (val < 512 || val > 1048576) {
        pr_warn("mydriver: buffer_size %d out of range [512, 1048576]\n", val);
        return -EINVAL;
    }

    buffer_size = val;
    pr_info("mydriver: buffer_size updated to %d\n", buffer_size);
    return count;
}

static struct kobj_attribute buffer_size_attr =
    __ATTR(buffer_size, 0664, buffer_size_show, buffer_size_store);

/* sysfs attribute: /sys/kernel/mydriver/device_name (read-only) */
static ssize_t device_name_show(struct kobject *kobj,
                                 struct kobj_attribute *attr, char *buf)
{
    return sysfs_emit(buf, "%s\n", device_name);
}

static struct kobj_attribute device_name_attr =
    __ATTR_RO(device_name);

/* sysfs attribute: /sys/kernel/mydriver/stats - read statistics in JSON */
static ssize_t stats_show(struct kobject *kobj,
                            struct kobj_attribute *attr, char *buf)
{
    struct mydriver_dev *dev;
    if (!mydriver_devices)
        return sysfs_emit(buf, "{}\n");

    dev = &mydriver_devices[0];
    return sysfs_emit(buf,
        "{\n"
        "  \"bytes_read\": %llu,\n"
        "  \"bytes_written\": %llu,\n"
        "  \"fifo_size\": %u,\n"
        "  \"fifo_used\": %u,\n"
        "  \"open_count\": %lu\n"
        "}\n",
        (unsigned long long)dev->stats.bytes_read,
        (unsigned long long)dev->stats.bytes_written,
        kfifo_size(&dev->fifo),
        kfifo_len(&dev->fifo),
        dev->open_count);
}

static struct kobj_attribute stats_attr = __ATTR_RO(stats);

/* Group all attributes for single sysfs_create_group call */
static struct attribute *mydriver_attrs[] = {
    &buffer_size_attr.attr,
    &device_name_attr.attr,
    &stats_attr.attr,
    NULL,  /* Array must be NULL-terminated */
};

static struct attribute_group mydriver_attr_group = {
    .attrs = mydriver_attrs,
    .name  = "config",  /* Creates a subdirectory: /sys/kernel/mydriver/config/ */
};

int sysfs_setup(void)
{
    int ret;

    /* Create /sys/kernel/mydriver/ kobject */
    mydriver_kobj = kobject_create_and_add("mydriver", kernel_kobj);
    if (!mydriver_kobj)
        return -ENOMEM;

    /* Create /sys/kernel/mydriver/config/ with all attributes */
    ret = sysfs_create_group(mydriver_kobj, &mydriver_attr_group);
    if (ret) {
        kobject_put(mydriver_kobj);
        return ret;
    }

    pr_info("mydriver: sysfs entries created at /sys/kernel/mydriver/\n");
    return 0;
}

void sysfs_cleanup(void)
{
    sysfs_remove_group(mydriver_kobj, &mydriver_attr_group);
    kobject_put(mydriver_kobj);
    pr_info("mydriver: sysfs entries removed\n");
}
```

## Section 6: Loading and Managing Modules

### Loading with Parameters

```bash
# Load the module with default parameters
sudo insmod mydriver.ko

# Load with custom parameters
sudo insmod mydriver.ko buffer_size=65536 device_name=databus

# Verify it loaded
lsmod | grep mydriver
# Output: mydriver   32768  0

# Check kernel log for initialization messages
dmesg | tail -20

# Inspect module information
modinfo mydriver.ko
# Outputs: filename, description, version, author, license, parmtype, parm

# Check sysfs entries
ls /sys/kernel/mydriver/config/
# buffer_size  device_name  stats

# Read a sysfs attribute
cat /sys/kernel/mydriver/config/buffer_size
# 4096

# Write to a writable attribute
echo 65536 | sudo tee /sys/kernel/mydriver/config/buffer_size

# Verify device node created
ls -la /dev/mydriver0
# crw-rw-rw- 1 root root 243, 0 Aug 29 00:00 /dev/mydriver0
```

### Installing Permanently with DKMS

```bash
# Create DKMS configuration
cat > /usr/src/mydriver-1.0.0/dkms.conf << 'EOF'
PACKAGE_NAME="mydriver"
PACKAGE_VERSION="1.0.0"
CLEAN="make clean"
MAKE[0]="make -C /lib/modules/${kernelver}/build M=${dkms_tree}/${PACKAGE_NAME}/${PACKAGE_VERSION}/build"
BUILT_MODULE_NAME[0]="mydriver"
DEST_MODULE_LOCATION[0]="/updates/dkms"
AUTOINSTALL="yes"
EOF

# Copy source to DKMS tree
cp -r . /usr/src/mydriver-1.0.0/

# Register with DKMS
sudo dkms add -m mydriver -v 1.0.0

# Build for current kernel
sudo dkms build -m mydriver -v 1.0.0

# Install
sudo dkms install -m mydriver -v 1.0.0

# Verify DKMS status
dkms status
# mydriver, 1.0.0, 6.8.0-55-generic, x86_64: installed

# Module now loads automatically after kernel updates
# and can be loaded with modprobe
sudo modprobe mydriver buffer_size=32768
```

### Loading at Boot with modprobe

```bash
# Create modprobe configuration
cat > /etc/modprobe.d/mydriver.conf << 'EOF'
# Load mydriver with production settings
options mydriver buffer_size=65536 major_number=0
EOF

# Add to modules-load for automatic boot loading
echo "mydriver" | sudo tee -a /etc/modules-load.d/mydriver.conf

# Verify configuration
modprobe --showconfig mydriver

# Test modprobe loading (includes dependencies)
sudo modprobe mydriver
sudo modprobe -r mydriver  # Remove
```

## Section 7: Debugging Kernel Modules

### Using dynamic_pr_debug

```c
/* Enable debug messages for specific modules without recompiling */
/* In module code, use pr_debug() instead of pr_info() for debug messages */

/* Enable at runtime: */
/* echo "file mydriver.c +p" > /sys/kernel/debug/dynamic_debug/control */
/* echo "module mydriver +p" > /sys/kernel/debug/dynamic_debug/control */
```

```bash
# Enable dynamic debug for all messages in our module
echo "module mydriver +pflmt" > /sys/kernel/debug/dynamic_debug/control
# Flags: p=print, f=filename, l=line, m=module, t=thread

# Enable for specific function
echo "func mydriver_read +p" > /sys/kernel/debug/dynamic_debug/control

# Disable all debug for the module
echo "module mydriver -p" > /sys/kernel/debug/dynamic_debug/control

# Watch kernel log in real time
dmesg -w | grep mydriver

# Use ftrace to trace function calls
echo "mydriver_read" >> /sys/kernel/debug/tracing/set_ftrace_filter
echo function > /sys/kernel/debug/tracing/current_tracer
echo 1 > /sys/kernel/debug/tracing/tracing_on
# ... run test ...
cat /sys/kernel/debug/tracing/trace
echo 0 > /sys/kernel/debug/tracing/tracing_on
```

## Section 8: Production Considerations

### Memory Safety Rules

1. **Never sleep in spinlock context**: Spinlocks disable preemption. Use `mutex_lock()` instead of `spin_lock()` when sleeping is needed (e.g., waiting for I/O).

2. **Check all memory allocations**: Every `kmalloc()`, `kzalloc()`, `vmalloc()` can return NULL. Always check and return `-ENOMEM`.

3. **Use `copy_from_user()` / `copy_to_user()`**: Never dereference user-space pointers directly. The pointer may be invalid, NULL, or point to a kernel address.

4. **Reference counting**: Use `kobject_get()` / `kobject_put()` or `kref` to prevent use-after-free when objects can be accessed concurrently.

5. **Error path cleanup**: The `goto` pattern for cleanup on error is idiomatic kernel code. Use it consistently.

```c
/* Correct error path cleanup pattern */
int example_init(void)
{
    int ret;

    ret = step_one();
    if (ret)
        goto err_step_one;

    ret = step_two();
    if (ret)
        goto err_step_two;

    ret = step_three();
    if (ret)
        goto err_step_three;

    return 0;

err_step_three:
    undo_step_two();
err_step_two:
    undo_step_one();
err_step_one:
    return ret;
}
```

### Kernel Oops Analysis

```bash
# If the module causes a kernel oops, decode the stack trace:
# 1. Capture the oops from dmesg
dmesg > oops.txt

# 2. Use addr2line with the module's debug symbols
addr2line -e mydriver.ko -i 0xdeadbeef

# 3. Use decode_stacktrace.sh from the kernel tools
./scripts/decode_stacktrace.sh mydriver.ko /proc/modules < oops.txt

# 4. For persistent kernel crashes, enable kdump
systemctl enable kdump
# Then analyze with crash utility
crash /usr/lib/debug/lib/modules/$(uname -r)/vmlinux /var/crash/*/vmcore
```

## Conclusion

Writing kernel modules demands a different mindset from user-space programming: there are no exceptions, no memory protection, and bugs that seem minor in user-space can corrupt kernel data structures and bring down the entire system. The patterns in this guide — error-path cleanup with goto, explicit reference counting, blocking I/O with wait queues, and the kobject sysfs interface — reflect decades of kernel coding conventions designed to keep the kernel stable under adversarial conditions.

The character device driver in Section 3 provides a complete, production-usable template. Build on it by replacing the ring-buffer FIFO with hardware register I/O via `ioread32()` / `iowrite32()` and memory-mapped I/O (`ioremap()`) for PCI or platform device drivers.
