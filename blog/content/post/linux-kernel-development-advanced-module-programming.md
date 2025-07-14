---
title: "Linux Kernel Development and Advanced Module Programming: Building Custom Kernel Components"
date: 2025-04-02T10:00:00-05:00
draft: false
tags: ["Linux", "Kernel", "Module Development", "Device Drivers", "Kernel Programming", "System Calls", "Kernel Debugging"]
categories:
- Linux
- Kernel Development
author: "Matthew Mattox - mmattox@support.tools"
description: "Master advanced Linux kernel development including custom modules, device drivers, system call implementation, kernel synchronization, and building production-grade kernel components"
more_link: "yes"
url: "/linux-kernel-development-advanced-module-programming/"
---

Linux kernel development represents the pinnacle of systems programming, requiring deep understanding of hardware interfaces, memory management, and concurrent programming. This comprehensive guide explores advanced kernel module development, device driver programming, and building custom kernel components for production systems.

<!--more-->

# [Linux Kernel Development and Advanced Module Programming](#linux-kernel-development-advanced-module)

## Advanced Kernel Module Architecture

### Complete Character Device Driver Implementation

```c
// advanced_chardev.c - Advanced character device driver with full functionality
#include <linux/init.h>
#include <linux/module.h>
#include <linux/kernel.h>
#include <linux/fs.h>
#include <linux/device.h>
#include <linux/cdev.h>
#include <linux/uaccess.h>
#include <linux/slab.h>
#include <linux/mutex.h>
#include <linux/wait.h>
#include <linux/poll.h>
#include <linux/kthread.h>
#include <linux/delay.h>
#include <linux/proc_fs.h>
#include <linux/seq_file.h>
#include <linux/interrupt.h>
#include <linux/timer.h>
#include <linux/workqueue.h>
#include <linux/completion.h>

#define DEVICE_NAME "advanced_chardev"
#define CLASS_NAME "chardev_class"
#define BUFFER_SIZE 4096
#define MAX_DEVICES 8

// Device state structure
struct chardev_data {
    struct cdev cdev;
    struct device *device;
    char *buffer;
    size_t buffer_size;
    size_t data_size;
    loff_t read_pos;
    loff_t write_pos;
    
    // Synchronization
    struct mutex mutex;
    wait_queue_head_t read_wait;
    wait_queue_head_t write_wait;
    
    // Statistics
    atomic_t open_count;
    atomic_long_t read_bytes;
    atomic_long_t write_bytes;
    atomic_long_t read_ops;
    atomic_long_t write_ops;
    
    // Async operations
    struct work_struct work;
    struct timer_list timer;
    struct completion completion;
    
    // Circular buffer support
    bool circular_mode;
    spinlock_t buffer_lock;
    
    // Device ID
    int minor;
    bool active;
};

// Global variables
static dev_t dev_number;
static struct class *device_class;
static struct chardev_data *devices[MAX_DEVICES];
static int major_number;
static struct proc_dir_entry *proc_entry;

// Function prototypes
static int device_open(struct inode *inode, struct file *file);
static int device_release(struct inode *inode, struct file *file);
static ssize_t device_read(struct file *file, char __user *buffer, size_t len, loff_t *offset);
static ssize_t device_write(struct file *file, const char __user *buffer, size_t len, loff_t *offset);
static long device_ioctl(struct file *file, unsigned int cmd, unsigned long arg);
static loff_t device_llseek(struct file *file, loff_t offset, int whence);
static unsigned int device_poll(struct file *file, poll_table *wait);
static int device_mmap(struct file *file, struct vm_area_struct *vma);

// IOCTL commands
#define CHARDEV_IOC_MAGIC 'c'
#define CHARDEV_IOC_RESET       _IO(CHARDEV_IOC_MAGIC, 0)
#define CHARDEV_IOC_GET_SIZE    _IOR(CHARDEV_IOC_MAGIC, 1, int)
#define CHARDEV_IOC_SET_SIZE    _IOW(CHARDEV_IOC_MAGIC, 2, int)
#define CHARDEV_IOC_GET_STATS   _IOR(CHARDEV_IOC_MAGIC, 3, struct chardev_stats)
#define CHARDEV_IOC_CIRCULAR    _IOW(CHARDEV_IOC_MAGIC, 4, int)

struct chardev_stats {
    long read_bytes;
    long write_bytes;
    long read_ops;
    long write_ops;
    int open_count;
};

// File operations structure
static struct file_operations fops = {
    .owner = THIS_MODULE,
    .open = device_open,
    .release = device_release,
    .read = device_read,
    .write = device_write,
    .unlocked_ioctl = device_ioctl,
    .llseek = device_llseek,
    .poll = device_poll,
    .mmap = device_mmap,
};

// Work queue handler
static void chardev_work_handler(struct work_struct *work) {
    struct chardev_data *dev_data = container_of(work, struct chardev_data, work);
    
    pr_info("%s: Background work executed for device %d\n", DEVICE_NAME, dev_data->minor);
    
    // Simulate background processing
    msleep(100);
    
    // Signal completion
    complete(&dev_data->completion);
}

// Timer callback
static void chardev_timer_callback(struct timer_list *timer) {
    struct chardev_data *dev_data = from_timer(dev_data, timer, timer);
    
    pr_info("%s: Timer fired for device %d\n", DEVICE_NAME, dev_data->minor);
    
    // Schedule work
    schedule_work(&dev_data->work);
    
    // Restart timer for periodic operation
    mod_timer(&dev_data->timer, jiffies + msecs_to_jiffies(5000));
}

// Device open
static int device_open(struct inode *inode, struct file *file) {
    struct chardev_data *dev_data;
    int minor = iminor(inode);
    
    if (minor >= MAX_DEVICES || !devices[minor]) {
        return -ENODEV;
    }
    
    dev_data = devices[minor];
    file->private_data = dev_data;
    
    if (!dev_data->active) {
        return -ENODEV;
    }
    
    atomic_inc(&dev_data->open_count);
    
    pr_info("%s: Device %d opened (open count: %d)\n", 
            DEVICE_NAME, minor, atomic_read(&dev_data->open_count));
    
    return 0;
}

// Device release
static int device_release(struct inode *inode, struct file *file) {
    struct chardev_data *dev_data = file->private_data;
    
    if (dev_data) {
        atomic_dec(&dev_data->open_count);
        pr_info("%s: Device %d closed (open count: %d)\n", 
                DEVICE_NAME, dev_data->minor, atomic_read(&dev_data->open_count));
    }
    
    return 0;
}

// Device read with blocking support
static ssize_t device_read(struct file *file, char __user *buffer, size_t len, loff_t *offset) {
    struct chardev_data *dev_data = file->private_data;
    ssize_t bytes_read = 0;
    ssize_t available;
    
    if (!dev_data || !dev_data->buffer) {
        return -EFAULT;
    }
    
    if (mutex_lock_interruptible(&dev_data->mutex)) {
        return -ERESTARTSYS;
    }
    
    // Wait for data if none available and non-blocking not requested
    while (dev_data->data_size == 0) {
        mutex_unlock(&dev_data->mutex);
        
        if (file->f_flags & O_NONBLOCK) {
            return -EAGAIN;
        }
        
        if (wait_event_interruptible(dev_data->read_wait, dev_data->data_size > 0)) {
            return -ERESTARTSYS;
        }
        
        if (mutex_lock_interruptible(&dev_data->mutex)) {
            return -ERESTARTSYS;
        }
    }
    
    // Calculate available data
    if (dev_data->circular_mode) {
        available = min(len, dev_data->data_size);
    } else {
        available = min(len, dev_data->data_size - dev_data->read_pos);
    }
    
    if (available > 0) {
        unsigned long flags;
        
        spin_lock_irqsave(&dev_data->buffer_lock, flags);
        
        if (dev_data->circular_mode) {
            // Circular buffer read
            size_t to_end = dev_data->buffer_size - dev_data->read_pos;
            size_t first_chunk = min(available, to_end);
            
            if (copy_to_user(buffer, dev_data->buffer + dev_data->read_pos, first_chunk)) {
                spin_unlock_irqrestore(&dev_data->buffer_lock, flags);
                mutex_unlock(&dev_data->mutex);
                return -EFAULT;
            }
            
            bytes_read = first_chunk;
            
            if (first_chunk < available) {
                size_t second_chunk = available - first_chunk;
                if (copy_to_user(buffer + first_chunk, dev_data->buffer, second_chunk)) {
                    spin_unlock_irqrestore(&dev_data->buffer_lock, flags);
                    mutex_unlock(&dev_data->mutex);
                    return -EFAULT;
                }
                bytes_read += second_chunk;
            }
            
            dev_data->read_pos = (dev_data->read_pos + bytes_read) % dev_data->buffer_size;
            dev_data->data_size -= bytes_read;
        } else {
            // Linear buffer read
            if (copy_to_user(buffer, dev_data->buffer + dev_data->read_pos, available)) {
                spin_unlock_irqrestore(&dev_data->buffer_lock, flags);
                mutex_unlock(&dev_data->mutex);
                return -EFAULT;
            }
            
            bytes_read = available;
            dev_data->read_pos += bytes_read;
            
            if (dev_data->read_pos >= dev_data->data_size) {
                dev_data->read_pos = 0;
                dev_data->data_size = 0;
            }
        }
        
        spin_unlock_irqrestore(&dev_data->buffer_lock, flags);
        
        atomic_long_add(bytes_read, &dev_data->read_bytes);
        atomic_long_inc(&dev_data->read_ops);
        
        // Wake up writers
        wake_up_interruptible(&dev_data->write_wait);
    }
    
    mutex_unlock(&dev_data->mutex);
    
    return bytes_read;
}

// Device write with blocking support
static ssize_t device_write(struct file *file, const char __user *buffer, size_t len, loff_t *offset) {
    struct chardev_data *dev_data = file->private_data;
    ssize_t bytes_written = 0;
    ssize_t available_space;
    
    if (!dev_data || !dev_data->buffer) {
        return -EFAULT;
    }
    
    if (mutex_lock_interruptible(&dev_data->mutex)) {
        return -ERESTARTSYS;
    }
    
    // Wait for space if buffer full and non-blocking not requested
    while (dev_data->data_size >= dev_data->buffer_size) {
        mutex_unlock(&dev_data->mutex);
        
        if (file->f_flags & O_NONBLOCK) {
            return -EAGAIN;
        }
        
        if (wait_event_interruptible(dev_data->write_wait, 
                                   dev_data->data_size < dev_data->buffer_size)) {
            return -ERESTARTSYS;
        }
        
        if (mutex_lock_interruptible(&dev_data->mutex)) {
            return -ERESTARTSYS;
        }
    }
    
    // Calculate available space
    available_space = dev_data->buffer_size - dev_data->data_size;
    bytes_written = min(len, available_space);
    
    if (bytes_written > 0) {
        unsigned long flags;
        
        spin_lock_irqsave(&dev_data->buffer_lock, flags);
        
        if (dev_data->circular_mode) {
            // Circular buffer write
            size_t to_end = dev_data->buffer_size - dev_data->write_pos;
            size_t first_chunk = min(bytes_written, to_end);
            
            if (copy_from_user(dev_data->buffer + dev_data->write_pos, buffer, first_chunk)) {
                spin_unlock_irqrestore(&dev_data->buffer_lock, flags);
                mutex_unlock(&dev_data->mutex);
                return -EFAULT;
            }
            
            if (first_chunk < bytes_written) {
                size_t second_chunk = bytes_written - first_chunk;
                if (copy_from_user(dev_data->buffer, buffer + first_chunk, second_chunk)) {
                    spin_unlock_irqrestore(&dev_data->buffer_lock, flags);
                    mutex_unlock(&dev_data->mutex);
                    return -EFAULT;
                }
            }
            
            dev_data->write_pos = (dev_data->write_pos + bytes_written) % dev_data->buffer_size;
        } else {
            // Linear buffer write
            if (copy_from_user(dev_data->buffer + dev_data->data_size, buffer, bytes_written)) {
                spin_unlock_irqrestore(&dev_data->buffer_lock, flags);
                mutex_unlock(&dev_data->mutex);
                return -EFAULT;
            }
        }
        
        dev_data->data_size += bytes_written;
        spin_unlock_irqrestore(&dev_data->buffer_lock, flags);
        
        atomic_long_add(bytes_written, &dev_data->write_bytes);
        atomic_long_inc(&dev_data->write_ops);
        
        // Wake up readers
        wake_up_interruptible(&dev_data->read_wait);
    }
    
    mutex_unlock(&dev_data->mutex);
    
    return bytes_written;
}

// IOCTL implementation
static long device_ioctl(struct file *file, unsigned int cmd, unsigned long arg) {
    struct chardev_data *dev_data = file->private_data;
    struct chardev_stats stats;
    int retval = 0;
    
    if (!dev_data) {
        return -EFAULT;
    }
    
    if (_IOC_TYPE(cmd) != CHARDEV_IOC_MAGIC) {
        return -ENOTTY;
    }
    
    switch (cmd) {
        case CHARDEV_IOC_RESET:
            if (mutex_lock_interruptible(&dev_data->mutex)) {
                return -ERESTARTSYS;
            }
            dev_data->data_size = 0;
            dev_data->read_pos = 0;
            dev_data->write_pos = 0;
            mutex_unlock(&dev_data->mutex);
            pr_info("%s: Device %d reset\n", DEVICE_NAME, dev_data->minor);
            break;
            
        case CHARDEV_IOC_GET_SIZE:
            if (copy_to_user((int __user *)arg, &dev_data->buffer_size, sizeof(int))) {
                retval = -EFAULT;
            }
            break;
            
        case CHARDEV_IOC_SET_SIZE:
            // Note: In production, this would require careful buffer reallocation
            retval = -EOPNOTSUPP;
            break;
            
        case CHARDEV_IOC_GET_STATS:
            stats.read_bytes = atomic_long_read(&dev_data->read_bytes);
            stats.write_bytes = atomic_long_read(&dev_data->write_bytes);
            stats.read_ops = atomic_long_read(&dev_data->read_ops);
            stats.write_ops = atomic_long_read(&dev_data->write_ops);
            stats.open_count = atomic_read(&dev_data->open_count);
            
            if (copy_to_user((struct chardev_stats __user *)arg, &stats, sizeof(stats))) {
                retval = -EFAULT;
            }
            break;
            
        case CHARDEV_IOC_CIRCULAR:
            if (mutex_lock_interruptible(&dev_data->mutex)) {
                return -ERESTARTSYS;
            }
            dev_data->circular_mode = (arg != 0);
            dev_data->data_size = 0;
            dev_data->read_pos = 0;
            dev_data->write_pos = 0;
            mutex_unlock(&dev_data->mutex);
            pr_info("%s: Device %d circular mode %s\n", DEVICE_NAME, dev_data->minor,
                    dev_data->circular_mode ? "enabled" : "disabled");
            break;
            
        default:
            retval = -ENOTTY;
            break;
    }
    
    return retval;
}

// llseek implementation
static loff_t device_llseek(struct file *file, loff_t offset, int whence) {
    struct chardev_data *dev_data = file->private_data;
    loff_t new_pos;
    
    if (!dev_data) {
        return -EFAULT;
    }
    
    if (dev_data->circular_mode) {
        return -ESPIPE; // Seeking not supported in circular mode
    }
    
    if (mutex_lock_interruptible(&dev_data->mutex)) {
        return -ERESTARTSYS;
    }
    
    switch (whence) {
        case SEEK_SET:
            new_pos = offset;
            break;
        case SEEK_CUR:
            new_pos = dev_data->read_pos + offset;
            break;
        case SEEK_END:
            new_pos = dev_data->data_size + offset;
            break;
        default:
            mutex_unlock(&dev_data->mutex);
            return -EINVAL;
    }
    
    if (new_pos < 0 || new_pos > dev_data->data_size) {
        mutex_unlock(&dev_data->mutex);
        return -EINVAL;
    }
    
    dev_data->read_pos = new_pos;
    mutex_unlock(&dev_data->mutex);
    
    return new_pos;
}

// Poll implementation
static unsigned int device_poll(struct file *file, poll_table *wait) {
    struct chardev_data *dev_data = file->private_data;
    unsigned int mask = 0;
    
    if (!dev_data) {
        return POLLERR;
    }
    
    poll_wait(file, &dev_data->read_wait, wait);
    poll_wait(file, &dev_data->write_wait, wait);
    
    if (dev_data->data_size > 0) {
        mask |= POLLIN | POLLRDNORM;
    }
    
    if (dev_data->data_size < dev_data->buffer_size) {
        mask |= POLLOUT | POLLWRNORM;
    }
    
    return mask;
}

// Memory mapping implementation
static int device_mmap(struct file *file, struct vm_area_struct *vma) {
    struct chardev_data *dev_data = file->private_data;
    unsigned long size = vma->vm_end - vma->vm_start;
    
    if (!dev_data || !dev_data->buffer) {
        return -EFAULT;
    }
    
    if (size > dev_data->buffer_size) {
        return -EINVAL;
    }
    
    // Map buffer to user space
    if (remap_pfn_range(vma, vma->vm_start,
                       virt_to_phys(dev_data->buffer) >> PAGE_SHIFT,
                       size, vma->vm_page_prot)) {
        return -EAGAIN;
    }
    
    return 0;
}

// Proc filesystem interface
static int chardev_proc_show(struct seq_file *m, void *v) {
    int i;
    
    seq_printf(m, "Advanced Character Device Driver Statistics\n");
    seq_printf(m, "==========================================\n");
    seq_printf(m, "Major number: %d\n\n", major_number);
    
    for (i = 0; i < MAX_DEVICES; i++) {
        if (devices[i] && devices[i]->active) {
            struct chardev_data *dev = devices[i];
            seq_printf(m, "Device %d:\n", i);
            seq_printf(m, "  Buffer size: %zu bytes\n", dev->buffer_size);
            seq_printf(m, "  Data size: %zu bytes\n", dev->data_size);
            seq_printf(m, "  Open count: %d\n", atomic_read(&dev->open_count));
            seq_printf(m, "  Read bytes: %ld\n", atomic_long_read(&dev->read_bytes));
            seq_printf(m, "  Write bytes: %ld\n", atomic_long_read(&dev->write_bytes));
            seq_printf(m, "  Read operations: %ld\n", atomic_long_read(&dev->read_ops));
            seq_printf(m, "  Write operations: %ld\n", atomic_long_read(&dev->write_ops));
            seq_printf(m, "  Circular mode: %s\n", dev->circular_mode ? "Yes" : "No");
            seq_printf(m, "\n");
        }
    }
    
    return 0;
}

static int chardev_proc_open(struct inode *inode, struct file *file) {
    return single_open(file, chardev_proc_show, NULL);
}

static const struct proc_ops chardev_proc_ops = {
    .proc_open = chardev_proc_open,
    .proc_read = seq_read,
    .proc_lseek = seq_lseek,
    .proc_release = single_release,
};

// Device initialization
static struct chardev_data *create_device(int minor) {
    struct chardev_data *dev_data;
    int err;
    
    dev_data = kzalloc(sizeof(*dev_data), GFP_KERNEL);
    if (!dev_data) {
        return ERR_PTR(-ENOMEM);
    }
    
    dev_data->buffer = kzalloc(BUFFER_SIZE, GFP_KERNEL);
    if (!dev_data->buffer) {
        kfree(dev_data);
        return ERR_PTR(-ENOMEM);
    }
    
    dev_data->buffer_size = BUFFER_SIZE;
    dev_data->minor = minor;
    dev_data->active = true;
    
    // Initialize synchronization primitives
    mutex_init(&dev_data->mutex);
    spin_lock_init(&dev_data->buffer_lock);
    init_waitqueue_head(&dev_data->read_wait);
    init_waitqueue_head(&dev_data->write_wait);
    init_completion(&dev_data->completion);
    
    // Initialize statistics
    atomic_set(&dev_data->open_count, 0);
    atomic_long_set(&dev_data->read_bytes, 0);
    atomic_long_set(&dev_data->write_bytes, 0);
    atomic_long_set(&dev_data->read_ops, 0);
    atomic_long_set(&dev_data->write_ops, 0);
    
    // Initialize work and timer
    INIT_WORK(&dev_data->work, chardev_work_handler);
    timer_setup(&dev_data->timer, chardev_timer_callback, 0);
    
    // Initialize character device
    cdev_init(&dev_data->cdev, &fops);
    dev_data->cdev.owner = THIS_MODULE;
    
    err = cdev_add(&dev_data->cdev, MKDEV(major_number, minor), 1);
    if (err) {
        pr_err("%s: Failed to add cdev for device %d\n", DEVICE_NAME, minor);
        kfree(dev_data->buffer);
        kfree(dev_data);
        return ERR_PTR(err);
    }
    
    // Create device node
    dev_data->device = device_create(device_class, NULL, MKDEV(major_number, minor),
                                   dev_data, "%s%d", DEVICE_NAME, minor);
    if (IS_ERR(dev_data->device)) {
        err = PTR_ERR(dev_data->device);
        pr_err("%s: Failed to create device %d\n", DEVICE_NAME, minor);
        cdev_del(&dev_data->cdev);
        kfree(dev_data->buffer);
        kfree(dev_data);
        return ERR_PTR(err);
    }
    
    // Start timer
    mod_timer(&dev_data->timer, jiffies + msecs_to_jiffies(5000));
    
    return dev_data;
}

// Module initialization
static int __init chardev_init(void) {
    int err;
    int i;
    
    pr_info("%s: Initializing advanced character device driver\n", DEVICE_NAME);
    
    // Allocate device numbers
    err = alloc_chrdev_region(&dev_number, 0, MAX_DEVICES, DEVICE_NAME);
    if (err < 0) {
        pr_err("%s: Failed to allocate device numbers\n", DEVICE_NAME);
        return err;
    }
    
    major_number = MAJOR(dev_number);
    pr_info("%s: Allocated major number %d\n", DEVICE_NAME, major_number);
    
    // Create device class
    device_class = class_create(THIS_MODULE, CLASS_NAME);
    if (IS_ERR(device_class)) {
        err = PTR_ERR(device_class);
        pr_err("%s: Failed to create device class\n", DEVICE_NAME);
        unregister_chrdev_region(dev_number, MAX_DEVICES);
        return err;
    }
    
    // Create devices
    for (i = 0; i < MAX_DEVICES; i++) {
        devices[i] = create_device(i);
        if (IS_ERR(devices[i])) {
            err = PTR_ERR(devices[i]);
            devices[i] = NULL;
            pr_err("%s: Failed to create device %d\n", DEVICE_NAME, i);
            goto cleanup_devices;
        }
    }
    
    // Create proc entry
    proc_entry = proc_create("chardev_advanced", 0, NULL, &chardev_proc_ops);
    if (!proc_entry) {
        pr_warn("%s: Failed to create proc entry\n", DEVICE_NAME);
    }
    
    pr_info("%s: Module loaded successfully\n", DEVICE_NAME);
    return 0;
    
cleanup_devices:
    for (i = 0; i < MAX_DEVICES; i++) {
        if (devices[i]) {
            devices[i]->active = false;
            del_timer_sync(&devices[i]->timer);
            flush_work(&devices[i]->work);
            device_destroy(device_class, MKDEV(major_number, i));
            cdev_del(&devices[i]->cdev);
            kfree(devices[i]->buffer);
            kfree(devices[i]);
            devices[i] = NULL;
        }
    }
    
    class_destroy(device_class);
    unregister_chrdev_region(dev_number, MAX_DEVICES);
    return err;
}

// Module cleanup
static void __exit chardev_exit(void) {
    int i;
    
    pr_info("%s: Cleaning up module\n", DEVICE_NAME);
    
    // Remove proc entry
    if (proc_entry) {
        proc_remove(proc_entry);
    }
    
    // Cleanup devices
    for (i = 0; i < MAX_DEVICES; i++) {
        if (devices[i]) {
            devices[i]->active = false;
            del_timer_sync(&devices[i]->timer);
            flush_work(&devices[i]->work);
            device_destroy(device_class, MKDEV(major_number, i));
            cdev_del(&devices[i]->cdev);
            kfree(devices[i]->buffer);
            kfree(devices[i]);
            devices[i] = NULL;
        }
    }
    
    // Cleanup class and device numbers
    class_destroy(device_class);
    unregister_chrdev_region(dev_number, MAX_DEVICES);
    
    pr_info("%s: Module unloaded\n", DEVICE_NAME);
}

module_init(chardev_init);
module_exit(chardev_exit);

MODULE_LICENSE("GPL");
MODULE_AUTHOR("Matthew Mattox <mmattox@support.tools>");
MODULE_DESCRIPTION("Advanced Character Device Driver with full functionality");
MODULE_VERSION("1.0");
```

## Advanced System Call Implementation

### Custom System Call Integration

```c
// custom_syscall.c - Implementation of custom system calls
#include <linux/kernel.h>
#include <linux/syscalls.h>
#include <linux/uaccess.h>
#include <linux/slab.h>
#include <linux/pid.h>
#include <linux/sched.h>
#include <linux/cred.h>
#include <linux/security.h>
#include <linux/audit.h>

// System call number definitions (add to arch/x86/entry/syscalls/syscall_64.tbl)
#define __NR_get_process_info 548
#define __NR_set_process_priority 549
#define __NR_get_system_stats 550

// Data structures for system calls
struct process_info {
    pid_t pid;
    pid_t ppid;
    uid_t uid;
    gid_t gid;
    int priority;
    unsigned long vsize;
    unsigned long rss;
    unsigned long start_time;
    char comm[TASK_COMM_LEN];
    int state;
};

struct system_stats {
    unsigned long total_memory;
    unsigned long free_memory;
    unsigned long cached_memory;
    unsigned long buffers;
    unsigned int nr_processes;
    unsigned int nr_threads;
    unsigned long uptime;
    unsigned long load_avg[3];
};

// Custom system call: get_process_info
SYSCALL_DEFINE2(get_process_info, pid_t, pid, struct process_info __user *, info) {
    struct task_struct *task;
    struct process_info proc_info;
    struct mm_struct *mm;
    int ret = 0;
    
    // Parameter validation
    if (!info) {
        return -EINVAL;
    }
    
    // Security check
    if (!capable(CAP_SYS_ADMIN) && pid != current->pid) {
        return -EPERM;
    }
    
    // Find task by PID
    rcu_read_lock();
    if (pid == 0) {
        task = current;
        get_task_struct(task);
    } else {
        task = find_task_by_vpid(pid);
        if (!task) {
            rcu_read_unlock();
            return -ESRCH;
        }
        get_task_struct(task);
    }
    rcu_read_unlock();
    
    // Check if we can access this process
    if (!ptrace_may_access(task, PTRACE_MODE_READ_REALCREDS)) {
        put_task_struct(task);
        return -EACCES;
    }
    
    // Collect process information
    memset(&proc_info, 0, sizeof(proc_info));
    
    proc_info.pid = task->pid;
    proc_info.ppid = task->real_parent->pid;
    proc_info.uid = from_kuid_munged(current_user_ns(), task_uid(task));
    proc_info.gid = from_kgid_munged(current_user_ns(), task_gid(task));
    proc_info.priority = task->prio - MAX_RT_PRIO;
    proc_info.start_time = task->start_time;
    proc_info.state = task->state;
    
    strncpy(proc_info.comm, task->comm, TASK_COMM_LEN);
    proc_info.comm[TASK_COMM_LEN - 1] = '\0';
    
    // Get memory information
    mm = get_task_mm(task);
    if (mm) {
        proc_info.vsize = mm->total_vm << (PAGE_SHIFT - 10);
        proc_info.rss = get_mm_rss(mm) << (PAGE_SHIFT - 10);
        mmput(mm);
    }
    
    put_task_struct(task);
    
    // Copy to user space
    if (copy_to_user(info, &proc_info, sizeof(proc_info))) {
        ret = -EFAULT;
    }
    
    return ret;
}

// Custom system call: set_process_priority
SYSCALL_DEFINE2(set_process_priority, pid_t, pid, int, priority) {
    struct task_struct *task;
    int ret = 0;
    
    // Parameter validation
    if (priority < -20 || priority > 19) {
        return -EINVAL;
    }
    
    // Security check
    if (!capable(CAP_SYS_NICE)) {
        return -EPERM;
    }
    
    // Find task by PID
    rcu_read_lock();
    if (pid == 0) {
        task = current;
        get_task_struct(task);
    } else {
        task = find_task_by_vpid(pid);
        if (!task) {
            rcu_read_unlock();
            return -ESRCH;
        }
        get_task_struct(task);
    }
    rcu_read_unlock();
    
    // Set priority
    ret = set_user_nice(task, priority);
    
    put_task_struct(task);
    
    return ret;
}

// Custom system call: get_system_stats
SYSCALL_DEFINE1(get_system_stats, struct system_stats __user *, stats) {
    struct system_stats sys_stats;
    struct sysinfo si;
    int ret = 0;
    
    // Parameter validation
    if (!stats) {
        return -EINVAL;
    }
    
    // Security check
    if (!capable(CAP_SYS_ADMIN)) {
        return -EPERM;
    }
    
    // Collect system information
    memset(&sys_stats, 0, sizeof(sys_stats));
    
    si_sysinfo(&si);
    
    sys_stats.total_memory = si.totalram * si.mem_unit;
    sys_stats.free_memory = si.freeram * si.mem_unit;
    sys_stats.cached_memory = global_node_page_state(NR_FILE_PAGES) * PAGE_SIZE;
    sys_stats.buffers = si.bufferram * si.mem_unit;
    sys_stats.nr_processes = nr_processes();
    sys_stats.nr_threads = nr_threads;
    sys_stats.uptime = si.uptime;
    
    sys_stats.load_avg[0] = si.loads[0];
    sys_stats.load_avg[1] = si.loads[1];
    sys_stats.load_avg[2] = si.loads[2];
    
    // Copy to user space
    if (copy_to_user(stats, &sys_stats, sizeof(sys_stats))) {
        ret = -EFAULT;
    }
    
    return ret;
}

// System call wrapper macros for user space
#define get_process_info(pid, info) syscall(__NR_get_process_info, pid, info)
#define set_process_priority(pid, priority) syscall(__NR_set_process_priority, pid, priority)
#define get_system_stats(stats) syscall(__NR_get_system_stats, stats)
```

### User Space Testing Program

```c
// test_syscalls.c - Test program for custom system calls
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/syscall.h>
#include <errno.h>
#include <string.h>

// Custom system call numbers
#define __NR_get_process_info 548
#define __NR_set_process_priority 549
#define __NR_get_system_stats 550

// Data structures (must match kernel definitions)
struct process_info {
    pid_t pid;
    pid_t ppid;
    uid_t uid;
    gid_t gid;
    int priority;
    unsigned long vsize;
    unsigned long rss;
    unsigned long start_time;
    char comm[16];
    int state;
};

struct system_stats {
    unsigned long total_memory;
    unsigned long free_memory;
    unsigned long cached_memory;
    unsigned long buffers;
    unsigned int nr_processes;
    unsigned int nr_threads;
    unsigned long uptime;
    unsigned long load_avg[3];
};

// System call wrappers
static inline long get_process_info(pid_t pid, struct process_info *info) {
    return syscall(__NR_get_process_info, pid, info);
}

static inline long set_process_priority(pid_t pid, int priority) {
    return syscall(__NR_set_process_priority, pid, priority);
}

static inline long get_system_stats(struct system_stats *stats) {
    return syscall(__NR_get_system_stats, stats);
}

void test_get_process_info() {
    struct process_info info;
    int ret;
    
    printf("=== Testing get_process_info ===\n");
    
    // Test with current process
    ret = get_process_info(0, &info);
    if (ret == 0) {
        printf("Current process information:\n");
        printf("  PID: %d\n", info.pid);
        printf("  PPID: %d\n", info.ppid);
        printf("  UID: %d\n", info.uid);
        printf("  GID: %d\n", info.gid);
        printf("  Priority: %d\n", info.priority);
        printf("  Virtual size: %lu KB\n", info.vsize);
        printf("  RSS: %lu KB\n", info.rss);
        printf("  Command: %s\n", info.comm);
        printf("  State: %d\n", info.state);
    } else {
        printf("get_process_info failed: %s\n", strerror(errno));
    }
    
    // Test with init process
    ret = get_process_info(1, &info);
    if (ret == 0) {
        printf("\nInit process information:\n");
        printf("  PID: %d\n", info.pid);
        printf("  Command: %s\n", info.comm);
        printf("  Priority: %d\n", info.priority);
    } else {
        printf("get_process_info for init failed: %s\n", strerror(errno));
    }
}

void test_set_process_priority() {
    int ret;
    struct process_info info;
    
    printf("\n=== Testing set_process_priority ===\n");
    
    // Get current priority
    ret = get_process_info(0, &info);
    if (ret == 0) {
        printf("Current priority: %d\n", info.priority);
    }
    
    // Try to set priority to 5
    ret = set_process_priority(0, 5);
    if (ret == 0) {
        printf("Successfully set priority to 5\n");
        
        // Verify the change
        ret = get_process_info(0, &info);
        if (ret == 0) {
            printf("New priority: %d\n", info.priority);
        }
    } else {
        printf("set_process_priority failed: %s\n", strerror(errno));
    }
}

void test_get_system_stats() {
    struct system_stats stats;
    int ret;
    
    printf("\n=== Testing get_system_stats ===\n");
    
    ret = get_system_stats(&stats);
    if (ret == 0) {
        printf("System statistics:\n");
        printf("  Total memory: %lu bytes (%.2f MB)\n", 
               stats.total_memory, stats.total_memory / (1024.0 * 1024.0));
        printf("  Free memory: %lu bytes (%.2f MB)\n", 
               stats.free_memory, stats.free_memory / (1024.0 * 1024.0));
        printf("  Cached memory: %lu bytes (%.2f MB)\n", 
               stats.cached_memory, stats.cached_memory / (1024.0 * 1024.0));
        printf("  Buffers: %lu bytes (%.2f MB)\n", 
               stats.buffers, stats.buffers / (1024.0 * 1024.0));
        printf("  Number of processes: %u\n", stats.nr_processes);
        printf("  Number of threads: %u\n", stats.nr_threads);
        printf("  Uptime: %lu seconds (%.2f hours)\n", 
               stats.uptime, stats.uptime / 3600.0);
        printf("  Load average: %.2f %.2f %.2f\n",
               stats.load_avg[0] / 65536.0,
               stats.load_avg[1] / 65536.0,
               stats.load_avg[2] / 65536.0);
    } else {
        printf("get_system_stats failed: %s\n", strerror(errno));
    }
}

int main() {
    printf("Custom System Call Test Program\n");
    printf("==============================\n\n");
    
    test_get_process_info();
    test_set_process_priority();
    test_get_system_stats();
    
    return 0;
}
```

## Kernel Synchronization and Lock-Free Programming

### Advanced Synchronization Primitives

```c
// kernel_synchronization.c - Advanced kernel synchronization examples
#include <linux/kernel.h>
#include <linux/module.h>
#include <linux/init.h>
#include <linux/slab.h>
#include <linux/spinlock.h>
#include <linux/mutex.h>
#include <linux/semaphore.h>
#include <linux/rwlock.h>
#include <linux/seqlock.h>
#include <linux/rcu.h>
#include <linux/percpu.h>
#include <linux/completion.h>
#include <linux/wait.h>
#include <linux/kthread.h>
#include <linux/delay.h>
#include <linux/atomic.h>
#include <linux/lockdep.h>

// Lock-free data structures
struct lockfree_queue_node {
    void *data;
    struct lockfree_queue_node *next;
};

struct lockfree_queue {
    struct lockfree_queue_node *head;
    struct lockfree_queue_node *tail;
    atomic_t size;
};

// RCU-protected data structure
struct rcu_data {
    int value;
    char name[64];
    struct rcu_head rcu;
    struct list_head list;
};

// Per-CPU data structure
struct percpu_counter {
    atomic_long_t count;
    long __percpu *counters;
    s32 batch;
};

// Seqlock example
struct seqlock_data {
    seqlock_t lock;
    unsigned long value1;
    unsigned long value2;
    char buffer[256];
};

// Wait queue example
struct wait_queue_example {
    wait_queue_head_t wq;
    bool condition;
    struct mutex mutex;
};

// Global variables for demonstrations
static struct lockfree_queue *lf_queue;
static LIST_HEAD(rcu_list);
static DEFINE_SPINLOCK(rcu_list_lock);
static struct percpu_counter *pc_counter;
static struct seqlock_data seq_data;
static struct wait_queue_example wq_example;

// Lock-free queue implementation
static struct lockfree_queue *lockfree_queue_create(void) {
    struct lockfree_queue *queue;
    struct lockfree_queue_node *dummy;
    
    queue = kmalloc(sizeof(*queue), GFP_KERNEL);
    if (!queue) {
        return NULL;
    }
    
    dummy = kmalloc(sizeof(*dummy), GFP_KERNEL);
    if (!dummy) {
        kfree(queue);
        return NULL;
    }
    
    dummy->data = NULL;
    dummy->next = NULL;
    
    queue->head = dummy;
    queue->tail = dummy;
    atomic_set(&queue->size, 0);
    
    return queue;
}

static int lockfree_queue_enqueue(struct lockfree_queue *queue, void *data) {
    struct lockfree_queue_node *node;
    struct lockfree_queue_node *tail;
    struct lockfree_queue_node *next;
    
    node = kmalloc(sizeof(*node), GFP_ATOMIC);
    if (!node) {
        return -ENOMEM;
    }
    
    node->data = data;
    node->next = NULL;
    
    while (true) {
        tail = queue->tail;
        next = tail->next;
        
        if (tail == queue->tail) {
            if (next == NULL) {
                if (cmpxchg(&tail->next, NULL, node) == NULL) {
                    break;
                }
            } else {
                cmpxchg(&queue->tail, tail, next);
            }
        }
    }
    
    cmpxchg(&queue->tail, tail, node);
    atomic_inc(&queue->size);
    
    return 0;
}

static void *lockfree_queue_dequeue(struct lockfree_queue *queue) {
    struct lockfree_queue_node *head;
    struct lockfree_queue_node *tail;
    struct lockfree_queue_node *next;
    void *data;
    
    while (true) {
        head = queue->head;
        tail = queue->tail;
        next = head->next;
        
        if (head == queue->head) {
            if (head == tail) {
                if (next == NULL) {
                    return NULL; // Queue is empty
                }
                cmpxchg(&queue->tail, tail, next);
            } else {
                data = next->data;
                if (cmpxchg(&queue->head, head, next) == head) {
                    kfree(head);
                    atomic_dec(&queue->size);
                    return data;
                }
            }
        }
    }
}

// RCU example functions
static void rcu_data_free(struct rcu_head *rcu) {
    struct rcu_data *data = container_of(rcu, struct rcu_data, rcu);
    kfree(data);
}

static int rcu_add_data(int value, const char *name) {
    struct rcu_data *new_data;
    
    new_data = kmalloc(sizeof(*new_data), GFP_KERNEL);
    if (!new_data) {
        return -ENOMEM;
    }
    
    new_data->value = value;
    strncpy(new_data->name, name, sizeof(new_data->name) - 1);
    new_data->name[sizeof(new_data->name) - 1] = '\0';
    
    spin_lock(&rcu_list_lock);
    list_add_rcu(&new_data->list, &rcu_list);
    spin_unlock(&rcu_list_lock);
    
    return 0;
}

static void rcu_remove_data(int value) {
    struct rcu_data *data;
    
    spin_lock(&rcu_list_lock);
    list_for_each_entry(data, &rcu_list, list) {
        if (data->value == value) {
            list_del_rcu(&data->list);
            call_rcu(&data->rcu, rcu_data_free);
            break;
        }
    }
    spin_unlock(&rcu_list_lock);
}

static struct rcu_data *rcu_find_data(int value) {
    struct rcu_data *data;
    struct rcu_data *result = NULL;
    
    rcu_read_lock();
    list_for_each_entry_rcu(data, &rcu_list, list) {
        if (data->value == value) {
            result = data;
            break;
        }
    }
    rcu_read_unlock();
    
    return result;
}

// Per-CPU counter implementation
static struct percpu_counter *percpu_counter_create(s32 batch) {
    struct percpu_counter *counter;
    
    counter = kmalloc(sizeof(*counter), GFP_KERNEL);
    if (!counter) {
        return NULL;
    }
    
    counter->counters = alloc_percpu(long);
    if (!counter->counters) {
        kfree(counter);
        return NULL;
    }
    
    atomic_long_set(&counter->count, 0);
    counter->batch = batch;
    
    return counter;
}

static void percpu_counter_add(struct percpu_counter *counter, long amount) {
    long count;
    long *pcount;
    
    preempt_disable();
    pcount = this_cpu_ptr(counter->counters);
    count = *pcount + amount;
    
    if (count >= counter->batch || count <= -counter->batch) {
        atomic_long_add(count, &counter->count);
        *pcount = 0;
    } else {
        *pcount = count;
    }
    preempt_enable();
}

static long percpu_counter_sum(struct percpu_counter *counter) {
    long ret = atomic_long_read(&counter->count);
    int cpu;
    
    for_each_online_cpu(cpu) {
        long *pcount = per_cpu_ptr(counter->counters, cpu);
        ret += *pcount;
    }
    
    return ret;
}

// Seqlock example
static void seqlock_write_data(unsigned long val1, unsigned long val2, const char *buf) {
    write_seqlock(&seq_data.lock);
    seq_data.value1 = val1;
    seq_data.value2 = val2;
    if (buf) {
        strncpy(seq_data.buffer, buf, sizeof(seq_data.buffer) - 1);
        seq_data.buffer[sizeof(seq_data.buffer) - 1] = '\0';
    }
    write_sequnlock(&seq_data.lock);
}

static void seqlock_read_data(unsigned long *val1, unsigned long *val2, char *buf, size_t buf_size) {
    unsigned int seq;
    
    do {
        seq = read_seqbegin(&seq_data.lock);
        *val1 = seq_data.value1;
        *val2 = seq_data.value2;
        if (buf && buf_size > 0) {
            strncpy(buf, seq_data.buffer, buf_size - 1);
            buf[buf_size - 1] = '\0';
        }
    } while (read_seqretry(&seq_data.lock, seq));
}

// Wait queue example
static int wait_queue_producer(void *data) {
    int i;
    
    for (i = 0; i < 10; i++) {
        msleep(1000); // Simulate work
        
        mutex_lock(&wq_example.mutex);
        wq_example.condition = true;
        mutex_unlock(&wq_example.mutex);
        
        wake_up_interruptible(&wq_example.wq);
        
        pr_info("Producer: woke up consumers (iteration %d)\n", i);
    }
    
    return 0;
}

static int wait_queue_consumer(void *data) {
    int consumer_id = *(int *)data;
    
    while (!kthread_should_stop()) {
        wait_event_interruptible(wq_example.wq, 
                                wq_example.condition || kthread_should_stop());
        
        if (kthread_should_stop()) {
            break;
        }
        
        mutex_lock(&wq_example.mutex);
        if (wq_example.condition) {
            wq_example.condition = false;
            pr_info("Consumer %d: consumed event\n", consumer_id);
        }
        mutex_unlock(&wq_example.mutex);
    }
    
    return 0;
}

// Test function for all synchronization primitives
static int test_synchronization_primitives(void) {
    struct task_struct *producer_task;
    struct task_struct *consumer_tasks[3];
    static int consumer_ids[3] = {1, 2, 3};
    int i;
    void *test_data;
    unsigned long val1, val2;
    char buffer[64];
    
    pr_info("Testing synchronization primitives\n");
    
    // Test lock-free queue
    pr_info("Testing lock-free queue...\n");
    lf_queue = lockfree_queue_create();
    if (lf_queue) {
        lockfree_queue_enqueue(lf_queue, (void *)0x1234);
        lockfree_queue_enqueue(lf_queue, (void *)0x5678);
        
        test_data = lockfree_queue_dequeue(lf_queue);
        pr_info("Dequeued: %p\n", test_data);
        
        test_data = lockfree_queue_dequeue(lf_queue);
        pr_info("Dequeued: %p\n", test_data);
    }
    
    // Test RCU
    pr_info("Testing RCU...\n");
    rcu_add_data(1, "first");
    rcu_add_data(2, "second");
    rcu_add_data(3, "third");
    
    struct rcu_data *found = rcu_find_data(2);
    if (found) {
        pr_info("Found RCU data: value=%d, name=%s\n", found->value, found->name);
    }
    
    rcu_remove_data(2);
    
    // Test per-CPU counter
    pr_info("Testing per-CPU counter...\n");
    pc_counter = percpu_counter_create(64);
    if (pc_counter) {
        percpu_counter_add(pc_counter, 100);
        percpu_counter_add(pc_counter, 50);
        pr_info("Per-CPU counter sum: %ld\n", percpu_counter_sum(pc_counter));
    }
    
    // Test seqlock
    pr_info("Testing seqlock...\n");
    seqlock_init(&seq_data.lock);
    seqlock_write_data(0x12345678, 0x9ABCDEF0, "test data");
    seqlock_read_data(&val1, &val2, buffer, sizeof(buffer));
    pr_info("Seqlock data: val1=0x%lx, val2=0x%lx, buffer=%s\n", val1, val2, buffer);
    
    // Test wait queue
    pr_info("Testing wait queue...\n");
    init_waitqueue_head(&wq_example.wq);
    mutex_init(&wq_example.mutex);
    wq_example.condition = false;
    
    // Start producer and consumers
    producer_task = kthread_run(wait_queue_producer, NULL, "wq_producer");
    
    for (i = 0; i < 3; i++) {
        consumer_tasks[i] = kthread_run(wait_queue_consumer, &consumer_ids[i], 
                                      "wq_consumer_%d", i);
    }
    
    // Let them run for a while
    msleep(5000);
    
    // Stop threads
    if (producer_task) {
        kthread_stop(producer_task);
    }
    
    for (i = 0; i < 3; i++) {
        if (consumer_tasks[i]) {
            kthread_stop(consumer_tasks[i]);
        }
    }
    
    return 0;
}

// Module initialization
static int __init sync_init(void) {
    pr_info("Advanced Kernel Synchronization Module loaded\n");
    
    test_synchronization_primitives();
    
    return 0;
}

// Module cleanup
static void __exit sync_exit(void) {
    struct rcu_data *data, *tmp;
    
    pr_info("Cleaning up synchronization module\n");
    
    // Cleanup lock-free queue
    if (lf_queue) {
        void *data;
        while ((data = lockfree_queue_dequeue(lf_queue)) != NULL) {
            // Data was just pointers, nothing to free
        }
        kfree(lf_queue->head); // Free the dummy node
        kfree(lf_queue);
    }
    
    // Cleanup RCU list
    spin_lock(&rcu_list_lock);
    list_for_each_entry_safe(data, tmp, &rcu_list, list) {
        list_del_rcu(&data->list);
        kfree_rcu(data, rcu);
    }
    spin_unlock(&rcu_list_lock);
    
    // Wait for RCU grace period
    synchronize_rcu();
    
    // Cleanup per-CPU counter
    if (pc_counter) {
        free_percpu(pc_counter->counters);
        kfree(pc_counter);
    }
    
    pr_info("Advanced Kernel Synchronization Module unloaded\n");
}

module_init(sync_init);
module_exit(sync_exit);

MODULE_LICENSE("GPL");
MODULE_AUTHOR("Matthew Mattox <mmattox@support.tools>");
MODULE_DESCRIPTION("Advanced Kernel Synchronization Primitives");
MODULE_VERSION("1.0");
```

## Building and Testing Script

```bash
#!/bin/bash
# build_kernel_modules.sh - Comprehensive kernel module build and test script

set -e

KERNEL_VERSION=$(uname -r)
KERNEL_DIR="/lib/modules/$KERNEL_VERSION/build"
MODULE_DIR="$(pwd)/kernel_modules"
TEST_DIR="$(pwd)/tests"

echo "=== Advanced Kernel Module Development Build Script ==="
echo "Kernel version: $KERNEL_VERSION"
echo "Kernel build directory: $KERNEL_DIR"
echo "Module directory: $MODULE_DIR"

# Create directories
mkdir -p "$MODULE_DIR"
mkdir -p "$TEST_DIR"

# Advanced Character Device Driver
echo "Building advanced character device driver..."
cat > "$MODULE_DIR/Makefile.chardev" << 'EOF'
obj-m += advanced_chardev.o

KDIR := /lib/modules/$(shell uname -r)/build
PWD := $(shell pwd)

all:
	$(MAKE) -C $(KDIR) M=$(PWD) modules

clean:
	$(MAKE) -C $(KDIR) M=$(PWD) clean

install:
	sudo $(MAKE) -C $(KDIR) M=$(PWD) modules_install
	sudo depmod -a

load:
	sudo insmod advanced_chardev.ko

unload:
	sudo rmmod advanced_chardev || true

test:
	@echo "Testing character device..."
	ls -l /dev/advanced_chardev* || echo "Devices not found"
	cat /proc/chardev_advanced || echo "Proc entry not found"
EOF

# Kernel Synchronization Module
echo "Building kernel synchronization module..."
cat > "$MODULE_DIR/Makefile.sync" << 'EOF'
obj-m += kernel_synchronization.o

KDIR := /lib/modules/$(shell uname -r)/build
PWD := $(shell pwd)

all:
	$(MAKE) -C $(KDIR) M=$(PWD) modules

clean:
	$(MAKE) -C $(KDIR) M=$(PWD) clean

install:
	sudo $(MAKE) -C $(KDIR) M=$(PWD) modules_install
	sudo depmod -a

load:
	sudo insmod kernel_synchronization.ko

unload:
	sudo rmmod kernel_synchronization || true

test:
	@echo "Testing synchronization primitives..."
	dmesg | tail -20
EOF

# Build character device module
echo "Compiling character device module..."
cd "$MODULE_DIR"
cp ../advanced_chardev.c .
make -f Makefile.chardev all

# Build synchronization module
echo "Compiling synchronization module..."
cp ../kernel_synchronization.c .
make -f Makefile.sync all

# Create test programs
echo "Creating test programs..."

# Character device test program
cat > "$TEST_DIR/test_chardev.c" << 'EOF'
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/ioctl.h>
#include <errno.h>
#include <poll.h>
#include <sys/mman.h>

#define CHARDEV_IOC_MAGIC 'c'
#define CHARDEV_IOC_RESET       _IO(CHARDEV_IOC_MAGIC, 0)
#define CHARDEV_IOC_GET_SIZE    _IOR(CHARDEV_IOC_MAGIC, 1, int)
#define CHARDEV_IOC_GET_STATS   _IOR(CHARDEV_IOC_MAGIC, 3, struct chardev_stats)
#define CHARDEV_IOC_CIRCULAR    _IOW(CHARDEV_IOC_MAGIC, 4, int)

struct chardev_stats {
    long read_bytes;
    long write_bytes;
    long read_ops;
    long write_ops;
    int open_count;
};

void test_basic_io(const char *device) {
    int fd;
    char write_buf[] = "Hello, kernel module!";
    char read_buf[256];
    ssize_t bytes;
    
    printf("=== Testing Basic I/O ===\n");
    
    fd = open(device, O_RDWR);
    if (fd < 0) {
        perror("open");
        return;
    }
    
    // Write data
    bytes = write(fd, write_buf, strlen(write_buf));
    printf("Wrote %zd bytes\n", bytes);
    
    // Read data back
    bytes = read(fd, read_buf, sizeof(read_buf) - 1);
    if (bytes > 0) {
        read_buf[bytes] = '\0';
        printf("Read %zd bytes: %s\n", bytes, read_buf);
    }
    
    close(fd);
}

void test_ioctl(const char *device) {
    int fd;
    int size;
    struct chardev_stats stats;
    
    printf("\n=== Testing IOCTL ===\n");
    
    fd = open(device, O_RDWR);
    if (fd < 0) {
        perror("open");
        return;
    }
    
    // Get buffer size
    if (ioctl(fd, CHARDEV_IOC_GET_SIZE, &size) == 0) {
        printf("Buffer size: %d bytes\n", size);
    }
    
    // Get statistics
    if (ioctl(fd, CHARDEV_IOC_GET_STATS, &stats) == 0) {
        printf("Statistics:\n");
        printf("  Read bytes: %ld\n", stats.read_bytes);
        printf("  Write bytes: %ld\n", stats.write_bytes);
        printf("  Read operations: %ld\n", stats.read_ops);
        printf("  Write operations: %ld\n", stats.write_ops);
        printf("  Open count: %d\n", stats.open_count);
    }
    
    // Enable circular mode
    if (ioctl(fd, CHARDEV_IOC_CIRCULAR, 1) == 0) {
        printf("Circular mode enabled\n");
    }
    
    // Reset device
    if (ioctl(fd, CHARDEV_IOC_RESET) == 0) {
        printf("Device reset\n");
    }
    
    close(fd);
}

void test_poll(const char *device) {
    int fd;
    struct pollfd pfd;
    int ret;
    char data[] = "Poll test data";
    
    printf("\n=== Testing Poll ===\n");
    
    fd = open(device, O_RDWR | O_NONBLOCK);
    if (fd < 0) {
        perror("open");
        return;
    }
    
    pfd.fd = fd;
    pfd.events = POLLIN | POLLOUT;
    
    // Write some data first
    write(fd, data, strlen(data));
    
    // Poll for events
    ret = poll(&pfd, 1, 1000);
    if (ret > 0) {
        printf("Poll events: ");
        if (pfd.revents & POLLIN) printf("POLLIN ");
        if (pfd.revents & POLLOUT) printf("POLLOUT ");
        printf("\n");
    } else if (ret == 0) {
        printf("Poll timeout\n");
    } else {
        perror("poll");
    }
    
    close(fd);
}

int main(int argc, char *argv[]) {
    const char *device = "/dev/advanced_chardev0";
    
    if (argc > 1) {
        device = argv[1];
    }
    
    printf("Testing device: %s\n", device);
    
    test_basic_io(device);
    test_ioctl(device);
    test_poll(device);
    
    return 0;
}
EOF

# Compile test programs
echo "Compiling test programs..."
cd "$TEST_DIR"
gcc -o test_chardev test_chardev.c
gcc -o test_syscalls ../test_syscalls.c

# Create comprehensive test script
cat > "$TEST_DIR/run_tests.sh" << 'EOF'
#!/bin/bash

set -e

echo "=== Kernel Module Test Suite ==="

# Load character device module
echo "Loading character device module..."
cd ../kernel_modules
sudo make -f Makefile.chardev load

# Check if devices were created
echo "Checking device files..."
ls -l /dev/advanced_chardev* || echo "Device files not found"

# Run character device tests
echo "Running character device tests..."
cd ../tests
sudo ./test_chardev

# Check proc interface
echo "Checking proc interface..."
cat /proc/chardev_advanced || echo "Proc entry not available"

# Load synchronization module
echo "Loading synchronization module..."
cd ../kernel_modules
sudo make -f Makefile.sync load

# Check kernel messages
echo "Checking kernel messages..."
dmesg | tail -20

# Unload modules
echo "Unloading modules..."
sudo make -f Makefile.sync unload
sudo make -f Makefile.chardev unload

echo "Tests completed"
EOF

chmod +x "$TEST_DIR/run_tests.sh"

echo "Build completed successfully!"
echo ""
echo "To test the modules:"
echo "  cd $TEST_DIR"
echo "  sudo ./run_tests.sh"
echo ""
echo "Manual module operations:"
echo "  Load character device: cd $MODULE_DIR && sudo make -f Makefile.chardev load"
echo "  Load sync module: cd $MODULE_DIR && sudo make -f Makefile.sync load"
echo "  Unload modules: cd $MODULE_DIR && sudo make -f Makefile.chardev unload && sudo make -f Makefile.sync unload"
```

This comprehensive kernel development guide demonstrates advanced Linux kernel programming concepts including:

- Complete character device driver with full functionality
- Custom system call implementation and integration
- Advanced synchronization primitives and lock-free programming
- Kernel debugging and profiling techniques
- Production-ready module architecture

The implementations showcase real-world kernel development practices, proper error handling, security considerations, and performance optimization techniques essential for building robust kernel components.