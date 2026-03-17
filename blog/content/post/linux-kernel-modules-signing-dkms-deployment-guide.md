---
title: "Linux Kernel Modules: Writing, Signing, and Deploying Custom Kernel Modules"
date: 2030-04-29T00:00:00-05:00
draft: false
tags: ["Linux", "Kernel", "Kernel Modules", "DKMS", "Secure Boot", "Systems Programming"]
categories: ["Linux", "Systems"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Linux kernel module development covering the full workflow from writing and compiling modules, module signing for Secure Boot environments, DKMS for distribution-independent deployment, debugging with dynamic debug and ftrace, and module parameters via sysfs."
more_link: "yes"
url: "/linux-kernel-modules-signing-dkms-deployment-guide/"
---

Kernel modules extend the Linux kernel at runtime without requiring a reboot or kernel rebuild. They are the mechanism behind hardware drivers, filesystem implementations, network protocols, and security enforcement modules like AppArmor and SELinux. Writing a kernel module means operating in the kernel's execution context — no standard library, manual memory management, and bugs that panic the entire system.

This guide covers the complete module lifecycle: from writing a functional module to deploying it in production with Secure Boot signing and DKMS for kernel upgrade survival.

<!--more-->

# Linux Kernel Modules: Writing, Signing, and Deploying Custom Kernel Modules

## Development Environment Setup

### Required Packages

```bash
# Debian/Ubuntu
apt-get install -y \
  linux-headers-$(uname -r) \
  build-essential \
  dkms \
  openssl \
  mokutil \
  sbsigntool  # For EFI binary signing

# RHEL/Rocky Linux
dnf install -y \
  kernel-devel-$(uname -r) \
  kernel-headers \
  gcc \
  make \
  dkms \
  openssl \
  mokutil

# Verify headers are present
ls /lib/modules/$(uname -r)/build/include/linux/module.h
```

### Kernel Version Information

```bash
# Current kernel version
uname -r
# 6.8.0-45-generic

# Kernel configuration (needed for compatible module builds)
zcat /proc/config.gz 2>/dev/null || cat /boot/config-$(uname -r) | grep -E "CONFIG_MODULE|CONFIG_DYNAMIC_DEBUG"

# Loaded modules
lsmod | head -20

# Module information
modinfo ext4
```

## Writing a Basic Kernel Module

### Hello World Module

```c
/* hello_module.c — minimal kernel module */
#include <linux/init.h>
#include <linux/module.h>
#include <linux/kernel.h>
#include <linux/version.h>

MODULE_LICENSE("GPL");
MODULE_AUTHOR("Matthew Mattox <mmattox@support.tools>");
MODULE_DESCRIPTION("Example kernel module for support.tools blog");
MODULE_VERSION("1.0.0");

static int __init hello_init(void)
{
    pr_info("hello_module: loaded (kernel %d.%d.%d)\n",
            LINUX_VERSION_MAJOR, LINUX_VERSION_PATCHLEVEL, LINUX_VERSION_SUBLEVEL);
    return 0;  /* 0 = success, non-zero = failure (module not loaded) */
}

static void __exit hello_exit(void)
{
    pr_info("hello_module: unloaded\n");
}

module_init(hello_init);
module_exit(hello_exit);
```

```makefile
# Makefile
obj-m += hello_module.o

# Additional source files would be listed here:
# hello_module-objs := file1.o file2.o

KDIR := /lib/modules/$(shell uname -r)/build
PWD  := $(shell pwd)

all:
	$(MAKE) -C $(KDIR) M=$(PWD) modules

clean:
	$(MAKE) -C $(KDIR) M=$(PWD) clean

install:
	$(MAKE) -C $(KDIR) M=$(PWD) modules_install
	depmod -a

.PHONY: all clean install
```

```bash
# Build and load
make
sudo insmod hello_module.ko
dmesg | tail -3
# [12345.678] hello_module: loaded (kernel 6.8.0)

sudo rmmod hello_module
dmesg | tail -2
# [12346.789] hello_module: unloaded

# Module information
modinfo hello_module.ko
```

## A Practical Module: Character Device Driver

```c
/* chardev.c — character device driver with read/write */
#include <linux/init.h>
#include <linux/module.h>
#include <linux/kernel.h>
#include <linux/fs.h>
#include <linux/cdev.h>
#include <linux/uaccess.h>
#include <linux/slab.h>
#include <linux/mutex.h>

MODULE_LICENSE("GPL");
MODULE_AUTHOR("Matthew Mattox <mmattox@support.tools>");
MODULE_DESCRIPTION("Simple character device driver");
MODULE_VERSION("1.0.0");

#define DEVICE_NAME     "support_chardev"
#define CLASS_NAME      "support"
#define BUFFER_SIZE     4096

static int    major_number;
static char  *kernel_buffer;
static size_t buffer_len = 0;
static struct class  *device_class  = NULL;
static struct device *device_object = NULL;
static struct cdev    cdev_object;
static DEFINE_MUTEX(chardev_mutex);

/* Module parameter: adjustable at load time and via sysfs */
static int buffer_size = BUFFER_SIZE;
module_param(buffer_size, int, 0644);
MODULE_PARM_DESC(buffer_size, "Internal buffer size in bytes (default 4096)");

static int     device_open(struct inode *, struct file *);
static int     device_release(struct inode *, struct file *);
static ssize_t device_read(struct file *, char __user *, size_t, loff_t *);
static ssize_t device_write(struct file *, const char __user *, size_t, loff_t *);

static const struct file_operations fops = {
    .owner   = THIS_MODULE,
    .open    = device_open,
    .release = device_release,
    .read    = device_read,
    .write   = device_write,
};

static int __init chardev_init(void)
{
    dev_t dev;
    int ret;

    /* Validate module parameter */
    if (buffer_size <= 0 || buffer_size > (1 << 20)) {
        pr_err("chardev: invalid buffer_size %d\n", buffer_size);
        return -EINVAL;
    }

    /* Allocate buffer */
    kernel_buffer = kzalloc(buffer_size, GFP_KERNEL);
    if (!kernel_buffer) {
        pr_err("chardev: failed to allocate buffer\n");
        return -ENOMEM;
    }

    /* Allocate a major number dynamically */
    ret = alloc_chrdev_region(&dev, 0, 1, DEVICE_NAME);
    if (ret < 0) {
        pr_err("chardev: alloc_chrdev_region failed: %d\n", ret);
        goto err_free_buf;
    }
    major_number = MAJOR(dev);

    /* Initialize and add cdev */
    cdev_init(&cdev_object, &fops);
    cdev_object.owner = THIS_MODULE;
    ret = cdev_add(&cdev_object, dev, 1);
    if (ret < 0) {
        pr_err("chardev: cdev_add failed: %d\n", ret);
        goto err_unregister;
    }

    /* Create device class */
    device_class = class_create(CLASS_NAME);
    if (IS_ERR(device_class)) {
        ret = PTR_ERR(device_class);
        pr_err("chardev: class_create failed: %d\n", ret);
        goto err_cdev;
    }

    /* Create device node /dev/support_chardev */
    device_object = device_create(device_class, NULL, dev, NULL, DEVICE_NAME);
    if (IS_ERR(device_object)) {
        ret = PTR_ERR(device_object);
        pr_err("chardev: device_create failed: %d\n", ret);
        goto err_class;
    }

    pr_info("chardev: registered with major %d, buffer_size=%d\n",
            major_number, buffer_size);
    return 0;

err_class:
    class_destroy(device_class);
err_cdev:
    cdev_del(&cdev_object);
err_unregister:
    unregister_chrdev_region(dev, 1);
err_free_buf:
    kfree(kernel_buffer);
    return ret;
}

static void __exit chardev_exit(void)
{
    dev_t dev = MKDEV(major_number, 0);
    device_destroy(device_class, dev);
    class_destroy(device_class);
    cdev_del(&cdev_object);
    unregister_chrdev_region(dev, 1);
    kfree(kernel_buffer);
    pr_info("chardev: unregistered\n");
}

static int device_open(struct inode *inodep, struct file *filep)
{
    if (!mutex_trylock(&chardev_mutex)) {
        pr_warn("chardev: device busy\n");
        return -EBUSY;
    }
    pr_debug("chardev: opened\n");
    return 0;
}

static int device_release(struct inode *inodep, struct file *filep)
{
    mutex_unlock(&chardev_mutex);
    pr_debug("chardev: released\n");
    return 0;
}

static ssize_t device_read(struct file *filep, char __user *buf,
                            size_t len, loff_t *offset)
{
    size_t to_copy;

    if (*offset >= buffer_len)
        return 0;  /* EOF */

    to_copy = min(len, buffer_len - (size_t)*offset);

    if (copy_to_user(buf, kernel_buffer + *offset, to_copy)) {
        return -EFAULT;
    }

    *offset += to_copy;
    pr_debug("chardev: read %zu bytes\n", to_copy);
    return to_copy;
}

static ssize_t device_write(struct file *filep, const char __user *buf,
                              size_t len, loff_t *offset)
{
    size_t to_write;

    to_write = min(len, (size_t)(buffer_size - 1));

    if (copy_from_user(kernel_buffer, buf, to_write)) {
        return -EFAULT;
    }

    kernel_buffer[to_write] = '\0';
    buffer_len = to_write;
    pr_debug("chardev: wrote %zu bytes\n", to_write);
    return to_write;
}

module_init(chardev_init);
module_exit(chardev_exit);
```

```bash
# Test the character device
sudo insmod chardev.ko buffer_size=8192

# Write to device
echo "Hello from userspace" | sudo tee /dev/support_chardev

# Read back
sudo cat /dev/support_chardev
# Hello from userspace

# Inspect module parameters via sysfs
cat /sys/module/chardev/parameters/buffer_size
# 8192

# Change at runtime (if parameter was declared with 0644)
echo 16384 | sudo tee /sys/module/chardev/parameters/buffer_size
```

## Module Signing for Secure Boot

Modern Linux distributions with Secure Boot enabled require that kernel modules be signed with a key trusted by the UEFI firmware. Attempting to load an unsigned module on such a system results in:

```
insmod: ERROR: could not insert module: Key was rejected by service
```

### Generating a Signing Key

```bash
# Create a directory for module signing keys
sudo mkdir -p /root/module-signing
cd /root/module-signing

# Generate a self-signed X.509 certificate and private key
# The openssl.conf configuration is required for correct key usage extensions
cat > openssl.conf << 'EOF'
[ req ]
default_bits        = 4096
distinguished_name  = req_distinguished_name
prompt              = no
string_mask         = utf8only
x509_extensions     = myexts

[ req_distinguished_name ]
CN = Module Signing Key - support.tools

[ myexts ]
basicConstraints    = critical,CA:FALSE
keyUsage            = critical,digitalSignature
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
EOF

openssl req -new -nodes -utf8 -sha256 -days 36500 \
  -batch -x509 \
  -config openssl.conf \
  -outform PEM \
  -out signing_cert.pem \
  -keyout signing_key.pem

# Protect the private key
chmod 600 signing_key.pem
```

### Enrolling the Key in MOK (Machine Owner Key)

```bash
# Convert certificate to DER format for MOK enrollment
openssl x509 -in signing_cert.pem -out signing_cert.der -outform DER

# Enroll with MOK — requires physical console interaction on next boot
sudo mokutil --import signing_cert.der
# You will be prompted for a one-time enrollment password

# Reboot — the UEFI MOK Manager will appear and ask to confirm enrollment
# After reboot, verify enrollment:
sudo mokutil --list-enrolled | grep "Module Signing"
```

### Signing a Module

```bash
# Sign a module using the kernel's sign-file utility
sudo /usr/src/linux-headers-$(uname -r)/scripts/sign-file \
  sha256 \
  /root/module-signing/signing_key.pem \
  /root/module-signing/signing_cert.pem \
  chardev.ko

# Verify the signature
modinfo chardev.ko | grep signer
# signer:         Module Signing Key - support.tools

# Verify the module can be loaded
sudo insmod chardev.ko
dmesg | tail -3
```

### Automated Signing via kernel-module-signer

```bash
#!/bin/bash
# sign-module.sh — sign all built modules in a directory

SIGN_TOOL="/usr/src/linux-headers-$(uname -r)/scripts/sign-file"
KEY="/root/module-signing/signing_key.pem"
CERT="/root/module-signing/signing_cert.pem"
MODULE_DIR="${1:-.}"

if [ ! -f "$KEY" ] || [ ! -f "$CERT" ]; then
    echo "ERROR: Signing key/cert not found"
    exit 1
fi

find "$MODULE_DIR" -name "*.ko" | while read -r module; do
    echo "Signing: $module"
    "$SIGN_TOOL" sha256 "$KEY" "$CERT" "$module"
    if [ $? -ne 0 ]; then
        echo "ERROR: Failed to sign $module"
        exit 1
    fi
done

echo "All modules signed successfully"
```

## DKMS: Distribution-Independent Module Deployment

DKMS (Dynamic Kernel Module Support) automatically rebuilds kernel modules when a new kernel is installed. Without it, every kernel upgrade breaks your custom modules until you manually rebuild and reinstall them.

### DKMS Module Configuration

```bash
# Standard DKMS directory structure
/usr/src/chardev-1.0.0/
├── chardev.c
├── Makefile
└── dkms.conf
```

```bash
# dkms.conf
PACKAGE_NAME="chardev"
PACKAGE_VERSION="1.0.0"
CLEAN="make clean"
MAKE="make -C /lib/modules/${kernelver}/build M=${dkms_tree}/${PACKAGE_NAME}/${PACKAGE_VERSION}/build"
BUILT_MODULE_NAME[0]="chardev"
BUILT_MODULE_LOCATION[0]="."
DEST_MODULE_LOCATION[0]="/updates/dkms"
MODULE_NAME="chardev"
AUTOINSTALL="yes"
# Run signing after build (for Secure Boot systems)
POST_BUILD="sign-module.sh"
```

```bash
# Install module source to DKMS tree
sudo mkdir -p /usr/src/chardev-1.0.0
sudo cp chardev.c Makefile /usr/src/chardev-1.0.0/
sudo cp dkms.conf /usr/src/chardev-1.0.0/

# Add to DKMS
sudo dkms add -m chardev -v 1.0.0

# Build for the current kernel
sudo dkms build -m chardev -v 1.0.0

# Install
sudo dkms install -m chardev -v 1.0.0

# Verify installation
sudo dkms status
# chardev/1.0.0, 6.8.0-45-generic, x86_64: installed

# Load the installed module
sudo modprobe chardev
```

### DKMS with Automatic Signing

```bash
# dkms.conf with integrated signing
PACKAGE_NAME="chardev"
PACKAGE_VERSION="1.0.0"
CLEAN="make clean"
MAKE[0]="make -C /lib/modules/${kernelver}/build M=${dkms_tree}/${PACKAGE_NAME}/${PACKAGE_VERSION}/build"
BUILT_MODULE_NAME[0]="chardev"
BUILT_MODULE_LOCATION[0]="."
DEST_MODULE_LOCATION[0]="/updates/dkms"
AUTOINSTALL="yes"
SIGN_TOOL="/usr/src/linux-headers-${kernelver}/scripts/sign-file"
SIGNING_KEY="/root/module-signing/signing_key.pem"
SIGNING_CERTIFICATE="/root/module-signing/signing_cert.pem"
```

```bash
# DKMS with explicit signing (newer DKMS versions)
sudo dkms build -m chardev -v 1.0.0 \
  --kernelsourcedir /lib/modules/$(uname -r)/build \
  --signing-key /root/module-signing/signing_key.pem \
  --signing-cert /root/module-signing/signing_cert.pem

sudo dkms install -m chardev -v 1.0.0
```

## Debugging with Dynamic Debug

The kernel's dynamic debug system allows enabling per-module, per-file, and per-function debug messages at runtime without recompiling.

### Enabling Dynamic Debug

```bash
# Check if dynamic debug is compiled in
grep CONFIG_DYNAMIC_DEBUG /boot/config-$(uname -r)
# CONFIG_DYNAMIC_DEBUG=y

# List all dynamic debug callsites in the chardev module
sudo cat /sys/kernel/debug/dynamic_debug/control | grep chardev

# Enable all debug messages in chardev module
echo "module chardev +p" | sudo tee /sys/kernel/debug/dynamic_debug/control

# Enable only messages in a specific function
echo "func device_write +p" | sudo tee /sys/kernel/debug/dynamic_debug/control

# Enable with file info and line numbers
echo "module chardev +pflmt" | sudo tee /sys/kernel/debug/dynamic_debug/control
# +p = print, +f = function name, +l = line number, +m = module name, +t = thread ID

# View debug output
sudo dmesg -w | grep chardev

# Disable when done
echo "module chardev -p" | sudo tee /sys/kernel/debug/dynamic_debug/control
```

### Enabling at Boot Time

```bash
# Add to kernel command line in GRUB
# Edit /etc/default/grub
GRUB_CMDLINE_LINUX="... dyndbg=\"module chardev +p\""
sudo update-grub
```

### Using ftrace for Function Call Tracing

```bash
# Mount debugfs if not already mounted
sudo mount -t debugfs none /sys/kernel/debug

# Enable function tracer for chardev functions
echo function | sudo tee /sys/kernel/debug/tracing/current_tracer
echo "chardev:*" | sudo tee /sys/kernel/debug/tracing/set_ftrace_filter
echo 1 | sudo tee /sys/kernel/debug/tracing/tracing_on

# Trigger some I/O
echo "test" | sudo tee /dev/support_chardev
sudo cat /dev/support_chardev

# Read trace output
sudo cat /sys/kernel/debug/tracing/trace | head -40

# Disable
echo 0 | sudo tee /sys/kernel/debug/tracing/tracing_on
echo nop | sudo tee /sys/kernel/debug/tracing/current_tracer
```

## Module Parameters and sysfs Interface

Module parameters create sysfs files for runtime inspection and modification:

```c
/* Extended parameter examples */
#include <linux/moduleparam.h>

static bool enable_verbose = false;
module_param(enable_verbose, bool, 0644);
MODULE_PARM_DESC(enable_verbose, "Enable verbose logging (default: false)");

static char *device_prefix = "support";
module_param(device_prefix, charp, 0444);  /* read-only after load */
MODULE_PARM_DESC(device_prefix, "Device name prefix (default: support)");

static int max_connections = 10;
module_param(max_connections, int, 0644);
MODULE_PARM_DESC(max_connections, "Maximum concurrent connections (1-100)");

/* Array parameter */
static int thresholds[8] = {10, 20, 30, 40, 50, 60, 70, 80};
static int thresholds_count = ARRAY_SIZE(thresholds);
module_param_array(thresholds, int, &thresholds_count, 0644);
MODULE_PARM_DESC(thresholds, "Alert thresholds array");
```

```bash
# Load with parameters
sudo insmod chardev.ko enable_verbose=1 max_connections=50

# Read parameters via sysfs
ls /sys/module/chardev/parameters/
cat /sys/module/chardev/parameters/max_connections
# 50

cat /sys/module/chardev/parameters/enable_verbose
# Y

# Modify at runtime (parameters declared 0644)
echo 100 | sudo tee /sys/module/chardev/parameters/max_connections

# Read-only parameters
echo "new_prefix" | sudo tee /sys/module/chardev/parameters/device_prefix
# bash: /sys/module/chardev/parameters/device_prefix: Permission denied
```

## Production Deployment Checklist

```bash
#!/bin/bash
# deploy-module.sh — production module deployment with validation

MODULE_NAME="chardev"
MODULE_VERSION="1.0.0"
KERNEL_VERSION=$(uname -r)

echo "=== Pre-deployment checks ==="

# 1. Verify kernel headers match
if [ ! -d "/lib/modules/${KERNEL_VERSION}/build" ]; then
    echo "ERROR: Kernel headers for ${KERNEL_VERSION} not found"
    exit 1
fi

# 2. Verify module is signed (if Secure Boot is enabled)
if mokutil --sb-state 2>/dev/null | grep -q "SecureBoot enabled"; then
    echo "Secure Boot is enabled — verifying module signature"
    if ! modinfo "${MODULE_NAME}.ko" | grep -q "^signer:"; then
        echo "ERROR: Module is not signed but Secure Boot is enabled"
        exit 1
    fi
fi

# 3. Build via DKMS
dkms build -m "${MODULE_NAME}" -v "${MODULE_VERSION}" || exit 1
dkms install -m "${MODULE_NAME}" -v "${MODULE_VERSION}" || exit 1

# 4. Load the module
modprobe "${MODULE_NAME}" || exit 1

# 5. Verify it loaded
if ! lsmod | grep -q "^${MODULE_NAME}"; then
    echo "ERROR: Module not found in lsmod after modprobe"
    exit 1
fi

# 6. Check for kernel errors
if dmesg | tail -20 | grep -iE "(ERROR|PANIC|BUG:|WARNING)" | grep -i "${MODULE_NAME}"; then
    echo "WARNING: Kernel error messages detected after loading"
fi

echo "=== Deployment complete ==="
dkms status "${MODULE_NAME}"
modinfo "${MODULE_NAME}"
```

## Key Takeaways

- Kernel modules execute in kernel context: any bug can crash the entire system — use `pr_err`/`pr_warn` extensively, check every pointer for NULL, and use `BUG_ON()` for invariant violations during development.
- The `__init` and `__exit` annotations mark functions for memory reclamation after initialization — always annotate init and cleanup functions correctly.
- Module signing with MOK is mandatory in Secure Boot environments; generate signing keys in a secure location, enroll the certificate via `mokutil`, and sign modules before installation.
- DKMS automates module rebuilds across kernel upgrades — without it, custom modules break silently during unattended OS updates; always deploy production modules through DKMS.
- Dynamic debug (`CONFIG_DYNAMIC_DEBUG`) provides zero-cost when disabled and per-callsite granularity when enabled — prefer `pr_debug()` over `pr_info()` for verbose diagnostic messages.
- Module parameters with `0644` permissions allow runtime adjustment without reload; use this for thresholds, timeouts, and feature flags that operators need to adjust without a maintenance window.
- Always call `copy_to_user` and `copy_from_user` for all kernel-userspace data transfers — never directly dereference user-provided pointers in kernel code.
