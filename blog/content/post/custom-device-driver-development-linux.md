---
title: "Custom Device Driver Development for Linux: From Kernel Modules to Production"
date: 2026-06-01T00:00:00-05:00
author: "Systems Engineering Team"
description: "Master Linux device driver development from kernel modules to production deployment. Learn character and block device drivers, interrupt handling, DMA operations, sysfs integration, and enterprise-grade driver architecture."
categories: ["Systems Programming", "Kernel Development", "Device Drivers"]
tags: ["Linux kernel", "device drivers", "kernel modules", "character devices", "block devices", "interrupt handling", "DMA", "sysfs", "kernel programming", "hardware abstraction"]
keywords: ["Linux device driver", "kernel module development", "character device driver", "block device driver", "interrupt handling", "DMA programming", "sysfs integration", "kernel programming", "hardware abstraction", "device driver architecture"]
draft: false
toc: true
---

Linux device driver development represents one of the most complex and critical aspects of systems programming. This comprehensive guide explores the complete spectrum of device driver development, from basic kernel modules to sophisticated production-ready drivers that interface with complex hardware systems and provide robust abstractions for user-space applications.

## Kernel Module Foundation

Understanding kernel module fundamentals is essential for device driver development, as drivers are implemented as loadable kernel modules that extend the kernel's functionality.

### Basic Kernel Module Structure

```c
#include <linux/init.h>
#include <linux/module.h>
#include <linux/kernel.h>
#include <linux/fs.h>
#include <linux/cdev.h>
#include <linux/device.h>
#include <linux/slab.h>
#include <linux/uaccess.h>
#include <linux/mutex.h>
#include <linux/wait.h>
#include <linux/sched.h>
#include <linux/interrupt.h>
#include <linux/dma-mapping.h>

// Module information
MODULE_LICENSE("GPL");
MODULE_AUTHOR("Systems Engineering Team");
MODULE_DESCRIPTION("Enterprise Device Driver Framework");
MODULE_VERSION("1.0");

// Device driver context structure
struct enterprise_device {
    struct cdev cdev;
    dev_t dev_number;
    struct class *device_class;
    struct device *device;
    
    // Hardware resources
    void __iomem *mmio_base;
    resource_size_t mmio_size;
    int irq_number;
    
    // Synchronization primitives
    struct mutex device_mutex;
    spinlock_t device_spinlock;
    wait_queue_head_t read_wait;
    wait_queue_head_t write_wait;
    
    // Data buffers
    char *buffer;
    size_t buffer_size;
    size_t buffer_head;
    size_t buffer_tail;
    
    // Statistics and monitoring
    atomic_t open_count;
    atomic_t read_count;
    atomic_t write_count;
    atomic_t interrupt_count;
    
    // Device state
    bool device_ready;
    bool dma_enabled;
    
    // DMA resources
    dma_addr_t dma_handle;
    void *dma_buffer;
    size_t dma_buffer_size;
};

static struct enterprise_device *global_device = NULL;

// Forward declarations
static int device_open(struct inode *inode, struct file *file);
static int device_release(struct inode *inode, struct file *file);
static ssize_t device_read(struct file *file, char __user *buffer, 
                          size_t count, loff_t *ppos);
static ssize_t device_write(struct file *file, const char __user *buffer,
                           size_t count, loff_t *ppos);
static long device_ioctl(struct file *file, unsigned int cmd, unsigned long arg);

// File operations structure
static struct file_operations device_fops = {
    .owner = THIS_MODULE,
    .open = device_open,
    .release = device_release,
    .read = device_read,
    .write = device_write,
    .unlocked_ioctl = device_ioctl,
    .llseek = no_llseek,
};

// Module initialization
static int __init enterprise_driver_init(void)
{
    int ret;
    
    printk(KERN_INFO "Enterprise Driver: Initializing device driver\n");
    
    // Allocate device structure
    global_device = kzalloc(sizeof(struct enterprise_device), GFP_KERNEL);
    if (!global_device) {
        printk(KERN_ERR "Enterprise Driver: Failed to allocate device structure\n");
        return -ENOMEM;
    }
    
    // Initialize synchronization primitives
    mutex_init(&global_device->device_mutex);
    spin_lock_init(&global_device->device_spinlock);
    init_waitqueue_head(&global_device->read_wait);
    init_waitqueue_head(&global_device->write_wait);
    
    // Initialize atomic counters
    atomic_set(&global_device->open_count, 0);
    atomic_set(&global_device->read_count, 0);
    atomic_set(&global_device->write_count, 0);
    atomic_set(&global_device->interrupt_count, 0);
    
    // Allocate device number
    ret = alloc_chrdev_region(&global_device->dev_number, 0, 1, "enterprise_device");
    if (ret < 0) {
        printk(KERN_ERR "Enterprise Driver: Failed to allocate device number\n");
        kfree(global_device);
        return ret;
    }
    
    // Initialize character device
    cdev_init(&global_device->cdev, &device_fops);
    global_device->cdev.owner = THIS_MODULE;
    
    // Add character device to system
    ret = cdev_add(&global_device->cdev, global_device->dev_number, 1);
    if (ret < 0) {
        printk(KERN_ERR "Enterprise Driver: Failed to add character device\n");
        unregister_chrdev_region(global_device->dev_number, 1);
        kfree(global_device);
        return ret;
    }
    
    // Create device class
    global_device->device_class = class_create(THIS_MODULE, "enterprise_class");
    if (IS_ERR(global_device->device_class)) {
        printk(KERN_ERR "Enterprise Driver: Failed to create device class\n");
        cdev_del(&global_device->cdev);
        unregister_chrdev_region(global_device->dev_number, 1);
        kfree(global_device);
        return PTR_ERR(global_device->device_class);
    }
    
    // Create device node
    global_device->device = device_create(global_device->device_class, NULL,
                                         global_device->dev_number, NULL,
                                         "enterprise_device");
    if (IS_ERR(global_device->device)) {
        printk(KERN_ERR "Enterprise Driver: Failed to create device node\n");
        class_destroy(global_device->device_class);
        cdev_del(&global_device->cdev);
        unregister_chrdev_region(global_device->dev_number, 1);
        kfree(global_device);
        return PTR_ERR(global_device->device);
    }
    
    // Allocate internal buffer
    global_device->buffer_size = PAGE_SIZE * 4; // 16KB buffer
    global_device->buffer = kzalloc(global_device->buffer_size, GFP_KERNEL);
    if (!global_device->buffer) {
        printk(KERN_ERR "Enterprise Driver: Failed to allocate buffer\n");
        device_destroy(global_device->device_class, global_device->dev_number);
        class_destroy(global_device->device_class);
        cdev_del(&global_device->cdev);
        unregister_chrdev_region(global_device->dev_number, 1);
        kfree(global_device);
        return -ENOMEM;
    }
    
    global_device->device_ready = true;
    
    printk(KERN_INFO "Enterprise Driver: Device driver initialized successfully\n");
    printk(KERN_INFO "Enterprise Driver: Major number: %d\n", 
           MAJOR(global_device->dev_number));
    
    return 0;
}

// Module cleanup
static void __exit enterprise_driver_exit(void)
{
    printk(KERN_INFO "Enterprise Driver: Cleaning up device driver\n");
    
    if (global_device) {
        // Mark device as not ready
        global_device->device_ready = false;
        
        // Wake up any waiting processes
        wake_up_interruptible(&global_device->read_wait);
        wake_up_interruptible(&global_device->write_wait);
        
        // Free DMA buffer if allocated
        if (global_device->dma_buffer) {
            dma_free_coherent(global_device->device, 
                            global_device->dma_buffer_size,
                            global_device->dma_buffer, 
                            global_device->dma_handle);
        }
        
        // Free internal buffer
        kfree(global_device->buffer);
        
        // Cleanup device infrastructure
        device_destroy(global_device->device_class, global_device->dev_number);
        class_destroy(global_device->device_class);
        cdev_del(&global_device->cdev);
        unregister_chrdev_region(global_device->dev_number, 1);
        
        // Free device structure
        kfree(global_device);
        global_device = NULL;
    }
    
    printk(KERN_INFO "Enterprise Driver: Device driver cleanup completed\n");
}

module_init(enterprise_driver_init);
module_exit(enterprise_driver_exit);
```

## Character Device Driver Implementation

Character devices provide stream-based access to hardware, making them suitable for devices like serial ports, sensors, and custom hardware interfaces.

### Advanced Character Device Operations

```c
// Device open operation with reference counting
static int device_open(struct inode *inode, struct file *file)
{
    struct enterprise_device *dev;
    
    printk(KERN_DEBUG "Enterprise Driver: Device open called\n");
    
    // Get device structure from inode
    dev = container_of(inode->i_cdev, struct enterprise_device, cdev);
    file->private_data = dev;
    
    // Check if device is ready
    if (!dev->device_ready) {
        printk(KERN_WARNING "Enterprise Driver: Device not ready\n");
        return -ENODEV;
    }
    
    // Acquire device mutex
    if (mutex_lock_interruptible(&dev->device_mutex)) {
        return -ERESTARTSYS;
    }
    
    // Increment open count
    atomic_inc(&dev->open_count);
    
    // Perform device-specific initialization if first open
    if (atomic_read(&dev->open_count) == 1) {
        // Reset buffer pointers
        dev->buffer_head = 0;
        dev->buffer_tail = 0;
        
        // Clear buffer
        memset(dev->buffer, 0, dev->buffer_size);
        
        printk(KERN_INFO "Enterprise Driver: First open, device initialized\n");
    }
    
    mutex_unlock(&dev->device_mutex);
    
    printk(KERN_DEBUG "Enterprise Driver: Device opened successfully (count: %d)\n",
           atomic_read(&dev->open_count));
    
    return 0;
}

// Device release operation
static int device_release(struct inode *inode, struct file *file)
{
    struct enterprise_device *dev = file->private_data;
    
    printk(KERN_DEBUG "Enterprise Driver: Device release called\n");
    
    if (!dev) {
        return -ENODEV;
    }
    
    // Acquire device mutex
    mutex_lock(&dev->device_mutex);
    
    // Decrement open count
    atomic_dec(&dev->open_count);
    
    // Perform cleanup if last close
    if (atomic_read(&dev->open_count) == 0) {
        // Wake up any waiting processes
        wake_up_interruptible(&dev->read_wait);
        wake_up_interruptible(&dev->write_wait);
        
        printk(KERN_INFO "Enterprise Driver: Last close, device cleaned up\n");
    }
    
    mutex_unlock(&dev->device_mutex);
    
    printk(KERN_DEBUG "Enterprise Driver: Device released (count: %d)\n",
           atomic_read(&dev->open_count));
    
    return 0;
}

// Advanced read operation with blocking and signal handling
static ssize_t device_read(struct file *file, char __user *buffer,
                          size_t count, loff_t *ppos)
{
    struct enterprise_device *dev = file->private_data;
    ssize_t bytes_read = 0;
    unsigned long flags;
    size_t available_bytes;
    size_t bytes_to_copy;
    
    if (!dev || !dev->device_ready) {
        return -ENODEV;
    }
    
    if (!buffer || count == 0) {
        return -EINVAL;
    }
    
    atomic_inc(&dev->read_count);
    
    printk(KERN_DEBUG "Enterprise Driver: Read request for %zu bytes\n", count);
    
    // Check for data availability
    while (true) {
        spin_lock_irqsave(&dev->device_spinlock, flags);
        
        // Calculate available data
        if (dev->buffer_head >= dev->buffer_tail) {
            available_bytes = dev->buffer_head - dev->buffer_tail;
        } else {
            available_bytes = dev->buffer_size - dev->buffer_tail + dev->buffer_head;
        }
        
        if (available_bytes > 0) {
            // Data is available
            bytes_to_copy = min(count, available_bytes);
            
            // Handle wrap-around case
            if (dev->buffer_tail + bytes_to_copy <= dev->buffer_size) {
                // No wrap-around
                spin_unlock_irqrestore(&dev->device_spinlock, flags);
                
                if (copy_to_user(buffer, dev->buffer + dev->buffer_tail, bytes_to_copy)) {
                    return -EFAULT;
                }
                
                spin_lock_irqsave(&dev->device_spinlock, flags);
                dev->buffer_tail = (dev->buffer_tail + bytes_to_copy) % dev->buffer_size;
                spin_unlock_irqrestore(&dev->device_spinlock, flags);
                
                bytes_read = bytes_to_copy;
                break;
            } else {
                // Handle wrap-around
                size_t first_part = dev->buffer_size - dev->buffer_tail;
                size_t second_part = bytes_to_copy - first_part;
                
                spin_unlock_irqrestore(&dev->device_spinlock, flags);
                
                if (copy_to_user(buffer, dev->buffer + dev->buffer_tail, first_part)) {
                    return -EFAULT;
                }
                
                if (copy_to_user(buffer + first_part, dev->buffer, second_part)) {
                    return -EFAULT;
                }
                
                spin_lock_irqsave(&dev->device_spinlock, flags);
                dev->buffer_tail = second_part;
                spin_unlock_irqrestore(&dev->device_spinlock, flags);
                
                bytes_read = bytes_to_copy;
                break;
            }
        } else {
            // No data available
            spin_unlock_irqrestore(&dev->device_spinlock, flags);
            
            // Check for non-blocking mode
            if (file->f_flags & O_NONBLOCK) {
                return -EAGAIN;
            }
            
            // Wait for data
            if (wait_event_interruptible(dev->read_wait, 
                                        (dev->buffer_head != dev->buffer_tail) || 
                                        !dev->device_ready)) {
                return -ERESTARTSYS;
            }
            
            // Check if device is still ready after waking up
            if (!dev->device_ready) {
                return -ENODEV;
            }
        }
    }
    
    // Wake up writers if buffer has space
    wake_up_interruptible(&dev->write_wait);
    
    printk(KERN_DEBUG "Enterprise Driver: Read %zd bytes\n", bytes_read);
    
    return bytes_read;
}

// Advanced write operation with flow control
static ssize_t device_write(struct file *file, const char __user *buffer,
                           size_t count, loff_t *ppos)
{
    struct enterprise_device *dev = file->private_data;
    ssize_t bytes_written = 0;
    unsigned long flags;
    size_t available_space;
    size_t bytes_to_copy;
    
    if (!dev || !dev->device_ready) {
        return -ENODEV;
    }
    
    if (!buffer || count == 0) {
        return -EINVAL;
    }
    
    atomic_inc(&dev->write_count);
    
    printk(KERN_DEBUG "Enterprise Driver: Write request for %zu bytes\n", count);
    
    // Check for buffer space
    while (bytes_written < count) {
        spin_lock_irqsave(&dev->device_spinlock, flags);
        
        // Calculate available space
        if (dev->buffer_head >= dev->buffer_tail) {
            available_space = dev->buffer_size - (dev->buffer_head - dev->buffer_tail) - 1;
        } else {
            available_space = dev->buffer_tail - dev->buffer_head - 1;
        }
        
        if (available_space > 0) {
            // Space is available
            bytes_to_copy = min(count - bytes_written, available_space);
            
            // Handle wrap-around case
            if (dev->buffer_head + bytes_to_copy <= dev->buffer_size) {
                // No wrap-around
                spin_unlock_irqrestore(&dev->device_spinlock, flags);
                
                if (copy_from_user(dev->buffer + dev->buffer_head, 
                                  buffer + bytes_written, bytes_to_copy)) {
                    return bytes_written > 0 ? bytes_written : -EFAULT;
                }
                
                spin_lock_irqsave(&dev->device_spinlock, flags);
                dev->buffer_head = (dev->buffer_head + bytes_to_copy) % dev->buffer_size;
                spin_unlock_irqrestore(&dev->device_spinlock, flags);
                
                bytes_written += bytes_to_copy;
            } else {
                // Handle wrap-around
                size_t first_part = dev->buffer_size - dev->buffer_head;
                size_t second_part = bytes_to_copy - first_part;
                
                spin_unlock_irqrestore(&dev->device_spinlock, flags);
                
                if (copy_from_user(dev->buffer + dev->buffer_head, 
                                  buffer + bytes_written, first_part)) {
                    return bytes_written > 0 ? bytes_written : -EFAULT;
                }
                
                if (copy_from_user(dev->buffer, buffer + bytes_written + first_part, 
                                  second_part)) {
                    return bytes_written > 0 ? bytes_written : -EFAULT;
                }
                
                spin_lock_irqsave(&dev->device_spinlock, flags);
                dev->buffer_head = second_part;
                spin_unlock_irqrestore(&dev->device_spinlock, flags);
                
                bytes_written += bytes_to_copy;
            }
            
            // Wake up readers
            wake_up_interruptible(&dev->read_wait);
        } else {
            // No space available
            spin_unlock_irqrestore(&dev->device_spinlock, flags);
            
            // Check for non-blocking mode
            if (file->f_flags & O_NONBLOCK) {
                return bytes_written > 0 ? bytes_written : -EAGAIN;
            }
            
            // Wait for space
            if (wait_event_interruptible(dev->write_wait, 
                                        (dev->buffer_head != ((dev->buffer_tail - 1 + dev->buffer_size) % dev->buffer_size)) || 
                                        !dev->device_ready)) {
                return bytes_written > 0 ? bytes_written : -ERESTARTSYS;
            }
            
            // Check if device is still ready after waking up
            if (!dev->device_ready) {
                return bytes_written > 0 ? bytes_written : -ENODEV;
            }
        }
    }
    
    printk(KERN_DEBUG "Enterprise Driver: Wrote %zd bytes\n", bytes_written);
    
    return bytes_written;
}
```

## Interrupt Handling and Hardware Interface

Proper interrupt handling is crucial for responsive device drivers that interact with real hardware.

### Advanced Interrupt Management

```c
#include <linux/interrupt.h>
#include <linux/workqueue.h>

// IOCTL command definitions
#define ENTERPRISE_IOC_MAGIC 'E'
#define ENTERPRISE_IOC_RESET        _IO(ENTERPRISE_IOC_MAGIC, 0)
#define ENTERPRISE_IOC_GET_STATUS   _IOR(ENTERPRISE_IOC_MAGIC, 1, int)
#define ENTERPRISE_IOC_SET_CONFIG   _IOW(ENTERPRISE_IOC_MAGIC, 2, struct device_config)
#define ENTERPRISE_IOC_GET_STATS    _IOR(ENTERPRISE_IOC_MAGIC, 3, struct device_stats)

// Device configuration structure
struct device_config {
    uint32_t buffer_size;
    uint32_t interrupt_rate;
    uint32_t dma_enable;
    uint32_t debug_level;
};

// Device statistics structure
struct device_stats {
    uint64_t interrupts_handled;
    uint64_t bytes_transferred;
    uint64_t errors_count;
    uint64_t uptime_seconds;
    uint32_t current_buffer_usage;
};

// Interrupt work structure
struct interrupt_work {
    struct work_struct work;
    struct enterprise_device *device;
    unsigned int irq_status;
};

// Bottom half interrupt handler using workqueue
static void interrupt_work_handler(struct work_struct *work)
{
    struct interrupt_work *irq_work = container_of(work, struct interrupt_work, work);
    struct enterprise_device *dev = irq_work->device;
    unsigned int status = irq_work->status;
    
    printk(KERN_DEBUG "Enterprise Driver: Processing interrupt work (status: 0x%x)\n", status);
    
    // Process different interrupt types
    if (status & 0x01) {
        // Data ready interrupt
        printk(KERN_DEBUG "Enterprise Driver: Data ready interrupt\n");
        
        // Simulate reading data from hardware
        // In a real driver, this would read from hardware registers
        unsigned long flags;
        char dummy_data[] = "Hardware data";
        size_t data_len = strlen(dummy_data);
        
        spin_lock_irqsave(&dev->device_spinlock, flags);
        
        // Add data to buffer if there's space
        size_t available_space;
        if (dev->buffer_head >= dev->buffer_tail) {
            available_space = dev->buffer_size - (dev->buffer_head - dev->buffer_tail) - 1;
        } else {
            available_space = dev->buffer_tail - dev->buffer_head - 1;
        }
        
        if (available_space >= data_len) {
            // Copy data to buffer
            for (size_t i = 0; i < data_len; i++) {
                dev->buffer[dev->buffer_head] = dummy_data[i];
                dev->buffer_head = (dev->buffer_head + 1) % dev->buffer_size;
            }
            
            // Wake up waiting readers
            wake_up_interruptible(&dev->read_wait);
        }
        
        spin_unlock_irqrestore(&dev->device_spinlock, flags);
    }
    
    if (status & 0x02) {
        // Error interrupt
        printk(KERN_WARNING "Enterprise Driver: Error interrupt detected\n");
        // Handle error condition
    }
    
    if (status & 0x04) {
        // DMA completion interrupt
        printk(KERN_DEBUG "Enterprise Driver: DMA completion interrupt\n");
        // Handle DMA completion
    }
    
    // Free work structure
    kfree(irq_work);
}

// Top half interrupt handler (atomic context)
static irqreturn_t enterprise_interrupt_handler(int irq, void *dev_id)
{
    struct enterprise_device *dev = (struct enterprise_device *)dev_id;
    unsigned int irq_status;
    struct interrupt_work *work;
    
    // Read interrupt status from hardware
    // In a real driver, this would read from hardware registers
    irq_status = 0x01; // Simulate data ready interrupt
    
    // Quick check if this is our interrupt
    if (irq_status == 0) {
        return IRQ_NONE; // Not our interrupt
    }
    
    // Increment interrupt counter
    atomic_inc(&dev->interrupt_count);
    
    printk(KERN_DEBUG "Enterprise Driver: Interrupt received (status: 0x%x)\n", irq_status);
    
    // Schedule bottom half processing
    work = kmalloc(sizeof(struct interrupt_work), GFP_ATOMIC);
    if (work) {
        INIT_WORK(&work->work, interrupt_work_handler);
        work->device = dev;
        work->irq_status = irq_status;
        
        // Schedule work
        schedule_work(&work->work);
    } else {
        printk(KERN_ERR "Enterprise Driver: Failed to allocate interrupt work\n");
    }
    
    // Clear interrupt in hardware
    // In a real driver, this would write to hardware registers to clear the interrupt
    
    return IRQ_HANDLED;
}

// Request interrupt resources
static int setup_interrupt_handling(struct enterprise_device *dev, int irq_number)
{
    int ret;
    
    dev->irq_number = irq_number;
    
    // Request interrupt line
    ret = request_irq(irq_number, enterprise_interrupt_handler, 
                     IRQF_SHARED, "enterprise_device", dev);
    if (ret) {
        printk(KERN_ERR "Enterprise Driver: Failed to request IRQ %d\n", irq_number);
        return ret;
    }
    
    printk(KERN_INFO "Enterprise Driver: Interrupt %d registered successfully\n", irq_number);
    
    return 0;
}

// Advanced IOCTL implementation
static long device_ioctl(struct file *file, unsigned int cmd, unsigned long arg)
{
    struct enterprise_device *dev = file->private_data;
    int ret = 0;
    struct device_config config;
    struct device_stats stats;
    
    if (!dev || !dev->device_ready) {
        return -ENODEV;
    }
    
    // Verify IOCTL magic number
    if (_IOC_TYPE(cmd) != ENTERPRISE_IOC_MAGIC) {
        return -ENOTTY;
    }
    
    // Check access permissions
    if (_IOC_DIR(cmd) & _IOC_READ) {
        ret = !access_ok(VERIFY_WRITE, (void __user *)arg, _IOC_SIZE(cmd));
        if (ret) return -EFAULT;
    }
    
    if (_IOC_DIR(cmd) & _IOC_WRITE) {
        ret = !access_ok(VERIFY_READ, (void __user *)arg, _IOC_SIZE(cmd));
        if (ret) return -EFAULT;
    }
    
    // Acquire device mutex for IOCTL operations
    if (mutex_lock_interruptible(&dev->device_mutex)) {
        return -ERESTARTSYS;
    }
    
    switch (cmd) {
        case ENTERPRISE_IOC_RESET:
            printk(KERN_INFO "Enterprise Driver: Device reset requested\n");
            
            // Reset device state
            dev->buffer_head = 0;
            dev->buffer_tail = 0;
            memset(dev->buffer, 0, dev->buffer_size);
            
            // Reset statistics
            atomic_set(&dev->read_count, 0);
            atomic_set(&dev->write_count, 0);
            atomic_set(&dev->interrupt_count, 0);
            
            // Wake up waiting processes
            wake_up_interruptible(&dev->read_wait);
            wake_up_interruptible(&dev->write_wait);
            
            break;
            
        case ENTERPRISE_IOC_GET_STATUS:
            {
                int status = dev->device_ready ? 1 : 0;
                if (copy_to_user((int __user *)arg, &status, sizeof(int))) {
                    ret = -EFAULT;
                }
            }
            break;
            
        case ENTERPRISE_IOC_SET_CONFIG:
            if (copy_from_user(&config, (struct device_config __user *)arg, 
                              sizeof(struct device_config))) {
                ret = -EFAULT;
                break;
            }
            
            printk(KERN_INFO "Enterprise Driver: Configuration update requested\n");
            
            // Validate configuration
            if (config.buffer_size > 0 && config.buffer_size <= (1024 * 1024)) {
                // Reallocate buffer if size changed
                if (config.buffer_size != dev->buffer_size) {
                    char *new_buffer = kzalloc(config.buffer_size, GFP_KERNEL);
                    if (new_buffer) {
                        kfree(dev->buffer);
                        dev->buffer = new_buffer;
                        dev->buffer_size = config.buffer_size;
                        dev->buffer_head = 0;
                        dev->buffer_tail = 0;
                        
                        printk(KERN_INFO "Enterprise Driver: Buffer resized to %u bytes\n", 
                               config.buffer_size);
                    } else {
                        ret = -ENOMEM;
                    }
                }
            } else {
                ret = -EINVAL;
            }
            
            break;
            
        case ENTERPRISE_IOC_GET_STATS:
            // Populate statistics structure
            stats.interrupts_handled = atomic_read(&dev->interrupt_count);
            stats.bytes_transferred = (atomic_read(&dev->read_count) + 
                                     atomic_read(&dev->write_count)) * 1024; // Estimate
            stats.errors_count = 0; // Would track actual errors in real driver
            stats.uptime_seconds = jiffies / HZ; // Simplified uptime
            
            // Calculate current buffer usage
            if (dev->buffer_head >= dev->buffer_tail) {
                stats.current_buffer_usage = dev->buffer_head - dev->buffer_tail;
            } else {
                stats.current_buffer_usage = dev->buffer_size - dev->buffer_tail + dev->buffer_head;
            }
            
            if (copy_to_user((struct device_stats __user *)arg, &stats, 
                            sizeof(struct device_stats))) {
                ret = -EFAULT;
            }
            
            break;
            
        default:
            ret = -ENOTTY;
            break;
    }
    
    mutex_unlock(&dev->device_mutex);
    
    return ret;
}
```

## DMA Operations and Memory Management

Direct Memory Access (DMA) operations are essential for high-performance device drivers that need to transfer large amounts of data efficiently.

### Advanced DMA Implementation

```c
#include <linux/dma-mapping.h>
#include <linux/dmaengine.h>

// DMA transfer descriptor
struct dma_transfer {
    dma_addr_t src_addr;
    dma_addr_t dst_addr;
    size_t length;
    enum dma_transfer_direction direction;
    bool completed;
    int result;
    struct completion completion;
};

// DMA controller context
struct dma_controller {
    struct dma_chan *chan;
    struct device *device;
    dma_cap_mask_t cap_mask;
    
    // DMA buffers
    void *coherent_buffer;
    dma_addr_t coherent_dma_addr;
    size_t coherent_buffer_size;
    
    // Streaming DMA mappings
    struct scatterlist *sg_list;
    int sg_count;
    
    // Statistics
    atomic_t transfers_completed;
    atomic_t transfers_failed;
    atomic_t bytes_transferred;
};

// Initialize DMA subsystem
static int initialize_dma_subsystem(struct enterprise_device *dev)
{
    int ret;
    
    // Check if device supports DMA
    if (!dev->device || !dev->device->dma_mask) {
        printk(KERN_INFO "Enterprise Driver: Device does not support DMA\n");
        return -ENODEV;
    }
    
    // Set DMA mask (support 32-bit DMA)
    ret = dma_set_mask_and_coherent(dev->device, DMA_BIT_MASK(32));
    if (ret) {
        printk(KERN_ERR "Enterprise Driver: Failed to set DMA mask\n");
        return ret;
    }
    
    // Allocate coherent DMA buffer
    dev->dma_buffer_size = PAGE_SIZE * 16; // 64KB
    dev->dma_buffer = dma_alloc_coherent(dev->device, dev->dma_buffer_size,
                                        &dev->dma_handle, GFP_KERNEL);
    if (!dev->dma_buffer) {
        printk(KERN_ERR "Enterprise Driver: Failed to allocate DMA buffer\n");
        return -ENOMEM;
    }
    
    dev->dma_enabled = true;
    
    printk(KERN_INFO "Enterprise Driver: DMA subsystem initialized\n");
    printk(KERN_INFO "Enterprise Driver: DMA buffer at 0x%llx (size: %zu)\n",
           (unsigned long long)dev->dma_handle, dev->dma_buffer_size);
    
    return 0;
}

// DMA completion callback
static void dma_transfer_complete(void *completion)
{
    struct completion *comp = (struct completion *)completion;
    complete(comp);
}

// Perform synchronous DMA transfer
static int perform_dma_transfer(struct enterprise_device *dev,
                               void *src, void *dst, size_t length,
                               enum dma_transfer_direction direction)
{
    struct dma_async_tx_descriptor *tx_desc;
    dma_cookie_t cookie;
    enum dma_status status;
    unsigned long timeout;
    struct completion completion;
    int ret = 0;
    
    if (!dev->dma_enabled) {
        return -ENODEV;
    }
    
    printk(KERN_DEBUG "Enterprise Driver: Starting DMA transfer (%zu bytes)\n", length);
    
    init_completion(&completion);
    
    // For this example, we'll use the coherent buffer
    // In a real driver, you would map the actual source/destination
    
    if (direction == DMA_TO_DEVICE) {
        // Copy data to DMA buffer
        memcpy(dev->dma_buffer, src, min(length, dev->dma_buffer_size));
    }
    
    // Create DMA transaction descriptor
    // Note: This is a simplified example. Real drivers would use proper
    // DMA engine APIs based on the hardware
    
    // Set up completion notification
    // tx_desc->callback = dma_transfer_complete;
    // tx_desc->callback_param = &completion;
    
    // Submit transaction
    // cookie = dmaengine_submit(tx_desc);
    // if (dma_submit_error(cookie)) {
    //     printk(KERN_ERR "Enterprise Driver: Failed to submit DMA transfer\n");
    //     return -EIO;
    // }
    
    // Start DMA transfer
    // dma_async_issue_pending(chan);
    
    // Wait for completion with timeout
    timeout = wait_for_completion_timeout(&completion, msecs_to_jiffies(5000));
    if (timeout == 0) {
        printk(KERN_ERR "Enterprise Driver: DMA transfer timeout\n");
        ret = -ETIMEDOUT;
        goto cleanup;
    }
    
    // Check transfer status
    // status = dma_async_is_tx_complete(chan, cookie, NULL, NULL);
    // if (status != DMA_COMPLETE) {
    //     printk(KERN_ERR "Enterprise Driver: DMA transfer failed (status: %d)\n", status);
    //     ret = -EIO;
    //     goto cleanup;
    // }
    
    if (direction == DMA_FROM_DEVICE) {
        // Copy data from DMA buffer
        memcpy(dst, dev->dma_buffer, min(length, dev->dma_buffer_size));
    }
    
    atomic_add(length, &dev->bytes_transferred);
    atomic_inc(&dev->transfers_completed);
    
    printk(KERN_DEBUG "Enterprise Driver: DMA transfer completed successfully\n");

cleanup:
    return ret;
}

// Scatter-gather DMA operations
static int setup_sg_dma_transfer(struct enterprise_device *dev,
                                struct scatterlist *sg, int nents,
                                enum dma_transfer_direction direction)
{
    int mapped_nents;
    
    // Map scatter-gather list for DMA
    mapped_nents = dma_map_sg(dev->device, sg, nents, direction);
    if (mapped_nents == 0) {
        printk(KERN_ERR "Enterprise Driver: Failed to map scatter-gather list\n");
        return -ENOMEM;
    }
    
    printk(KERN_DEBUG "Enterprise Driver: Mapped %d SG entries for DMA\n", mapped_nents);
    
    // Store for later cleanup
    dev->sg_list = sg;
    dev->sg_count = nents;
    
    return mapped_nents;
}

static void cleanup_sg_dma_transfer(struct enterprise_device *dev,
                                   enum dma_transfer_direction direction)
{
    if (dev->sg_list && dev->sg_count > 0) {
        dma_unmap_sg(dev->device, dev->sg_list, dev->sg_count, direction);
        dev->sg_list = NULL;
        dev->sg_count = 0;
    }
}

// High-level DMA API for driver users
static ssize_t dma_read_data(struct enterprise_device *dev, 
                            char __user *buffer, size_t count)
{
    ssize_t bytes_read = 0;
    size_t chunk_size;
    
    if (!dev->dma_enabled) {
        return -ENODEV;
    }
    
    while (bytes_read < count) {
        chunk_size = min(count - bytes_read, dev->dma_buffer_size);
        
        // Perform DMA transfer from device to memory
        if (perform_dma_transfer(dev, NULL, dev->dma_buffer, 
                               chunk_size, DMA_FROM_DEVICE) < 0) {
            break;
        }
        
        // Copy to user space
        if (copy_to_user(buffer + bytes_read, dev->dma_buffer, chunk_size)) {
            return -EFAULT;
        }
        
        bytes_read += chunk_size;
    }
    
    return bytes_read;
}

static ssize_t dma_write_data(struct enterprise_device *dev,
                             const char __user *buffer, size_t count)
{
    ssize_t bytes_written = 0;
    size_t chunk_size;
    
    if (!dev->dma_enabled) {
        return -ENODEV;
    }
    
    while (bytes_written < count) {
        chunk_size = min(count - bytes_written, dev->dma_buffer_size);
        
        // Copy from user space
        if (copy_from_user(dev->dma_buffer, buffer + bytes_written, chunk_size)) {
            return -EFAULT;
        }
        
        // Perform DMA transfer from memory to device
        if (perform_dma_transfer(dev, dev->dma_buffer, NULL,
                               chunk_size, DMA_TO_DEVICE) < 0) {
            break;
        }
        
        bytes_written += chunk_size;
    }
    
    return bytes_written;
}
```

## sysfs Integration and Device Management

sysfs integration provides a clean interface for device configuration and monitoring from user space.

### Comprehensive sysfs Implementation

```c
#include <linux/sysfs.h>
#include <linux/kobject.h>

// sysfs attribute structures
struct device_attribute dev_attr_buffer_size;
struct device_attribute dev_attr_debug_level;
struct device_attribute dev_attr_statistics;
struct device_attribute dev_attr_reset;
struct device_attribute dev_attr_dma_status;

// Buffer size attribute
static ssize_t buffer_size_show(struct device *dev, 
                               struct device_attribute *attr, char *buf)
{
    struct enterprise_device *device = dev_get_drvdata(dev);
    return sprintf(buf, "%zu\n", device->buffer_size);
}

static ssize_t buffer_size_store(struct device *dev,
                                struct device_attribute *attr,
                                const char *buf, size_t count)
{
    struct enterprise_device *device = dev_get_drvdata(dev);
    unsigned long new_size;
    char *new_buffer;
    int ret;
    
    ret = kstrtoul(buf, 0, &new_size);
    if (ret) {
        return ret;
    }
    
    // Validate new buffer size
    if (new_size < PAGE_SIZE || new_size > (1024 * 1024)) {
        return -EINVAL;
    }
    
    // Allocate new buffer
    new_buffer = kzalloc(new_size, GFP_KERNEL);
    if (!new_buffer) {
        return -ENOMEM;
    }
    
    // Replace old buffer
    mutex_lock(&device->device_mutex);
    
    kfree(device->buffer);
    device->buffer = new_buffer;
    device->buffer_size = new_size;
    device->buffer_head = 0;
    device->buffer_tail = 0;
    
    mutex_unlock(&device->device_mutex);
    
    printk(KERN_INFO "Enterprise Driver: Buffer size changed to %zu bytes\n", new_size);
    
    return count;
}

// Debug level attribute
static ssize_t debug_level_show(struct device *dev,
                               struct device_attribute *attr, char *buf)
{
    // Return current debug level (simplified)
    return sprintf(buf, "%d\n", 1); // Default debug level
}

static ssize_t debug_level_store(struct device *dev,
                                struct device_attribute *attr,
                                const char *buf, size_t count)
{
    unsigned long level;
    int ret;
    
    ret = kstrtoul(buf, 0, &level);
    if (ret) {
        return ret;
    }
    
    if (level > 3) {
        return -EINVAL;
    }
    
    // Set debug level (simplified)
    printk(KERN_INFO "Enterprise Driver: Debug level set to %lu\n", level);
    
    return count;
}

// Statistics attribute (read-only)
static ssize_t statistics_show(struct device *dev,
                              struct device_attribute *attr, char *buf)
{
    struct enterprise_device *device = dev_get_drvdata(dev);
    ssize_t len = 0;
    
    len += sprintf(buf + len, "Open count: %d\n", 
                   atomic_read(&device->open_count));
    len += sprintf(buf + len, "Read operations: %d\n", 
                   atomic_read(&device->read_count));
    len += sprintf(buf + len, "Write operations: %d\n", 
                   atomic_read(&device->write_count));
    len += sprintf(buf + len, "Interrupts handled: %d\n", 
                   atomic_read(&device->interrupt_count));
    len += sprintf(buf + len, "Buffer size: %zu bytes\n", 
                   device->buffer_size);
    
    // Calculate buffer usage
    size_t buffer_usage;
    if (device->buffer_head >= device->buffer_tail) {
        buffer_usage = device->buffer_head - device->buffer_tail;
    } else {
        buffer_usage = device->buffer_size - device->buffer_tail + device->buffer_head;
    }
    
    len += sprintf(buf + len, "Buffer usage: %zu/%zu bytes (%.1f%%)\n",
                   buffer_usage, device->buffer_size,
                   100.0 * buffer_usage / device->buffer_size);
    
    len += sprintf(buf + len, "DMA enabled: %s\n", 
                   device->dma_enabled ? "yes" : "no");
    
    len += sprintf(buf + len, "Device ready: %s\n", 
                   device->device_ready ? "yes" : "no");
    
    return len;
}

// Reset attribute (write-only)
static ssize_t reset_store(struct device *dev,
                          struct device_attribute *attr,
                          const char *buf, size_t count)
{
    struct enterprise_device *device = dev_get_drvdata(dev);
    
    mutex_lock(&device->device_mutex);
    
    // Reset device state
    device->buffer_head = 0;
    device->buffer_tail = 0;
    memset(device->buffer, 0, device->buffer_size);
    
    // Reset statistics
    atomic_set(&device->read_count, 0);
    atomic_set(&device->write_count, 0);
    atomic_set(&device->interrupt_count, 0);
    
    // Wake up waiting processes
    wake_up_interruptible(&device->read_wait);
    wake_up_interruptible(&device->write_wait);
    
    mutex_unlock(&device->device_mutex);
    
    printk(KERN_INFO "Enterprise Driver: Device reset via sysfs\n");
    
    return count;
}

// DMA status attribute (read-only)
static ssize_t dma_status_show(struct device *dev,
                              struct device_attribute *attr, char *buf)
{
    struct enterprise_device *device = dev_get_drvdata(dev);
    ssize_t len = 0;
    
    len += sprintf(buf + len, "DMA enabled: %s\n", 
                   device->dma_enabled ? "yes" : "no");
    
    if (device->dma_enabled) {
        len += sprintf(buf + len, "DMA buffer size: %zu bytes\n", 
                       device->dma_buffer_size);
        len += sprintf(buf + len, "DMA buffer address: 0x%llx\n", 
                       (unsigned long long)device->dma_handle);
    }
    
    return len;
}

// Create device attributes
static DEVICE_ATTR(buffer_size, 0644, buffer_size_show, buffer_size_store);
static DEVICE_ATTR(debug_level, 0644, debug_level_show, debug_level_store);
static DEVICE_ATTR(statistics, 0444, statistics_show, NULL);
static DEVICE_ATTR(reset, 0200, NULL, reset_store);
static DEVICE_ATTR(dma_status, 0444, dma_status_show, NULL);

// Attribute group
static struct attribute *enterprise_device_attrs[] = {
    &dev_attr_buffer_size.attr,
    &dev_attr_debug_level.attr,
    &dev_attr_statistics.attr,
    &dev_attr_reset.attr,
    &dev_attr_dma_status.attr,
    NULL,
};

static struct attribute_group enterprise_device_attr_group = {
    .attrs = enterprise_device_attrs,
};

// Create sysfs interface
static int create_sysfs_interface(struct enterprise_device *dev)
{
    int ret;
    
    // Create attribute group
    ret = sysfs_create_group(&dev->device->kobj, &enterprise_device_attr_group);
    if (ret) {
        printk(KERN_ERR "Enterprise Driver: Failed to create sysfs interface\n");
        return ret;
    }
    
    // Store device pointer for attribute access
    dev_set_drvdata(dev->device, dev);
    
    printk(KERN_INFO "Enterprise Driver: sysfs interface created\n");
    
    return 0;
}

// Remove sysfs interface
static void remove_sysfs_interface(struct enterprise_device *dev)
{
    sysfs_remove_group(&dev->device->kobj, &enterprise_device_attr_group);
    printk(KERN_INFO "Enterprise Driver: sysfs interface removed\n");
}
```

## Block Device Driver Architecture

Block devices require different handling compared to character devices, with emphasis on request queue management and I/O scheduling.

### Block Device Implementation

```c
#include <linux/blkdev.h>
#include <linux/bio.h>
#include <linux/genhd.h>

#define ENTERPRISE_BLOCK_MINORS 16
#define ENTERPRISE_BLOCK_SIZE 4096
#define ENTERPRISE_BLOCK_CAPACITY (1024 * 1024) // 1GB virtual device

struct enterprise_block_device {
    struct gendisk *disk;
    struct request_queue *queue;
    struct block_device_operations *ops;
    
    // Virtual storage
    char *storage;
    size_t storage_size;
    
    // Device information
    int major_number;
    int first_minor;
    char device_name[32];
    
    // Statistics
    atomic_t read_requests;
    atomic_t write_requests;
    atomic_t bytes_read;
    atomic_t bytes_written;
    
    // Synchronization
    spinlock_t lock;
};

// Block device request handler
static void enterprise_block_request(struct request_queue *q)
{
    struct enterprise_block_device *dev = q->queuedata;
    struct request *req;
    
    while ((req = blk_fetch_request(q)) != NULL) {
        // Process request
        int ret = enterprise_process_request(dev, req);
        
        // Complete request
        __blk_end_request_all(req, ret);
    }
}

// Process individual block request
static int enterprise_process_request(struct enterprise_block_device *dev, 
                                    struct request *req)
{
    int direction = rq_data_dir(req);
    sector_t start_sector = blk_rq_pos(req);
    unsigned int sectors = blk_rq_sectors(req);
    
    printk(KERN_DEBUG "Enterprise Block: %s request for %u sectors starting at %llu\n",
           direction == WRITE ? "Write" : "Read", sectors, 
           (unsigned long long)start_sector);
    
    // Validate request bounds
    if (start_sector + sectors > ENTERPRISE_BLOCK_CAPACITY / ENTERPRISE_BLOCK_SIZE) {
        printk(KERN_ERR "Enterprise Block: Request beyond device capacity\n");
        return -EIO;
    }
    
    // Process each bio in the request
    struct bio_vec bvec;
    struct req_iterator iter;
    sector_t current_sector = start_sector;
    
    rq_for_each_segment(bvec, req, iter) {
        char *buffer = page_address(bvec.bv_page) + bvec.bv_offset;
        size_t offset = current_sector * ENTERPRISE_BLOCK_SIZE;
        
        if (direction == WRITE) {
            // Write data to virtual storage
            memcpy(dev->storage + offset, buffer, bvec.bv_len);
            atomic_inc(&dev->write_requests);
            atomic_add(bvec.bv_len, &dev->bytes_written);
        } else {
            // Read data from virtual storage
            memcpy(buffer, dev->storage + offset, bvec.bv_len);
            atomic_inc(&dev->read_requests);
            atomic_add(bvec.bv_len, &dev->bytes_read);
        }
        
        current_sector += bvec.bv_len / ENTERPRISE_BLOCK_SIZE;
    }
    
    return 0; // Success
}

// Block device operations
static int enterprise_block_open(struct block_device *bdev, fmode_t mode)
{
    struct enterprise_block_device *dev = bdev->bd_disk->private_data;
    
    printk(KERN_DEBUG "Enterprise Block: Device opened\n");
    
    // Perform any necessary initialization
    return 0;
}

static void enterprise_block_release(struct gendisk *disk, fmode_t mode)
{
    struct enterprise_block_device *dev = disk->private_data;
    
    printk(KERN_DEBUG "Enterprise Block: Device released\n");
    
    // Perform any necessary cleanup
}

static int enterprise_block_ioctl(struct block_device *bdev, fmode_t mode,
                                 unsigned int cmd, unsigned long arg)
{
    struct enterprise_block_device *dev = bdev->bd_disk->private_data;
    
    switch (cmd) {
        case HDIO_GETGEO:
            // Return geometry information
            // This is a simplified implementation
            return -ENOTTY;
            
        default:
            return -ENOTTY;
    }
}

static struct block_device_operations enterprise_block_ops = {
    .owner = THIS_MODULE,
    .open = enterprise_block_open,
    .release = enterprise_block_release,
    .ioctl = enterprise_block_ioctl,
};

// Initialize block device
static int init_block_device(void)
{
    struct enterprise_block_device *dev;
    int ret;
    
    // Allocate device structure
    dev = kzalloc(sizeof(struct enterprise_block_device), GFP_KERNEL);
    if (!dev) {
        return -ENOMEM;
    }
    
    // Initialize device
    strcpy(dev->device_name, "enterprise_block");
    spin_lock_init(&dev->lock);
    
    // Allocate virtual storage
    dev->storage_size = ENTERPRISE_BLOCK_CAPACITY;
    dev->storage = vmalloc(dev->storage_size);
    if (!dev->storage) {
        kfree(dev);
        return -ENOMEM;
    }
    
    memset(dev->storage, 0, dev->storage_size);
    
    // Register block device
    dev->major_number = register_blkdev(0, dev->device_name);
    if (dev->major_number < 0) {
        printk(KERN_ERR "Enterprise Block: Failed to register block device\n");
        vfree(dev->storage);
        kfree(dev);
        return dev->major_number;
    }
    
    // Create request queue
    dev->queue = blk_init_queue(enterprise_block_request, &dev->lock);
    if (!dev->queue) {
        printk(KERN_ERR "Enterprise Block: Failed to create request queue\n");
        unregister_blkdev(dev->major_number, dev->device_name);
        vfree(dev->storage);
        kfree(dev);
        return -ENOMEM;
    }
    
    dev->queue->queuedata = dev;
    
    // Set queue properties
    blk_queue_logical_block_size(dev->queue, ENTERPRISE_BLOCK_SIZE);
    blk_queue_max_segments(dev->queue, 128);
    blk_queue_max_segment_size(dev->queue, PAGE_SIZE);
    
    // Allocate and initialize gendisk
    dev->disk = alloc_disk(ENTERPRISE_BLOCK_MINORS);
    if (!dev->disk) {
        printk(KERN_ERR "Enterprise Block: Failed to allocate gendisk\n");
        blk_cleanup_queue(dev->queue);
        unregister_blkdev(dev->major_number, dev->device_name);
        vfree(dev->storage);
        kfree(dev);
        return -ENOMEM;
    }
    
    // Configure gendisk
    dev->disk->major = dev->major_number;
    dev->disk->first_minor = 0;
    dev->disk->minors = ENTERPRISE_BLOCK_MINORS;
    dev->disk->fops = &enterprise_block_ops;
    dev->disk->queue = dev->queue;
    dev->disk->private_data = dev;
    sprintf(dev->disk->disk_name, "%s", dev->device_name);
    
    // Set capacity
    set_capacity(dev->disk, ENTERPRISE_BLOCK_CAPACITY / ENTERPRISE_BLOCK_SIZE);
    
    // Add disk to system
    add_disk(dev->disk);
    
    printk(KERN_INFO "Enterprise Block: Block device registered (major: %d)\n",
           dev->major_number);
    
    return 0;
}
```

## Conclusion

Linux device driver development requires mastery of kernel internals, hardware interfaces, and sophisticated synchronization mechanisms. The comprehensive examples presented in this guide demonstrate the essential patterns and techniques for building production-ready device drivers that provide reliable, high-performance interfaces between hardware and user-space applications.

Key principles for successful device driver development include proper resource management, robust error handling, efficient interrupt processing, and comprehensive testing across various hardware configurations. By implementing these patterns with attention to security, performance, and maintainability, developers can create device drivers that meet the demanding requirements of enterprise environments while providing stable, efficient hardware abstraction layers.

The techniques shown here form the foundation for developing drivers for complex hardware systems, from simple sensor interfaces to high-performance network adapters and storage controllers. Understanding these fundamentals enables the creation of sophisticated driver architectures that can efficiently manage hardware resources while providing clean, well-documented interfaces for system integration.