---
title: "Linux Kernel Module Development: From Hello World to Device Drivers"
date: 2025-02-12T10:00:00-05:00
draft: false
tags: ["Linux", "Kernel", "Drivers", "Modules", "Device Drivers", "Systems Programming", "Kernel Development"]
categories:
- Linux
- Kernel Development
author: "Matthew Mattox - mmattox@support.tools"
description: "Master Linux kernel module development from basic modules to complex device drivers, including character devices, memory management, interrupt handling, and kernel debugging techniques"
more_link: "yes"
url: "/linux-kernel-module-development/"
---

Kernel module development opens the door to extending Linux functionality without recompiling the kernel. From simple modules to complex device drivers, understanding kernel programming is essential for systems programmers. This guide explores kernel module development, device driver creation, and advanced kernel programming techniques.

<!--more-->

# [Linux Kernel Module Development](#linux-kernel-modules)

## Kernel Module Fundamentals

### Basic Module Structure

```c
// hello_module.c - Basic kernel module
#include <linux/init.h>
#include <linux/module.h>
#include <linux/kernel.h>
#include <linux/version.h>

MODULE_LICENSE("GPL");
MODULE_AUTHOR("Your Name");
MODULE_DESCRIPTION("A simple kernel module");
MODULE_VERSION("1.0");

// Module parameters
static int debug_level = 1;
module_param(debug_level, int, 0644);
MODULE_PARM_DESC(debug_level, "Debug level (0-3)");

static char *device_name = "mydevice";
module_param(device_name, charp, 0644);
MODULE_PARM_DESC(device_name, "Device name to use");

// Init function - called when module is loaded
static int __init hello_init(void)
{
    printk(KERN_INFO "Hello: Module loaded\n");
    printk(KERN_INFO "Hello: Debug level = %d\n", debug_level);
    printk(KERN_INFO "Hello: Device name = %s\n", device_name);
    
    // Check kernel version
    printk(KERN_INFO "Hello: Kernel version %d.%d.%d\n",
           LINUX_VERSION_MAJOR,
           LINUX_VERSION_PATCHLEVEL,
           LINUX_VERSION_SUBLEVEL);
    
    return 0;  // Success
}

// Exit function - called when module is removed
static void __exit hello_exit(void)
{
    printk(KERN_INFO "Hello: Module unloaded\n");
}

// Register init and exit functions
module_init(hello_init);
module_exit(hello_exit);
```

### Makefile for Kernel Modules

```makefile
# Makefile for kernel module compilation

# Module name
obj-m += hello_module.o

# For modules with multiple source files
# complex-objs := file1.o file2.o file3.o
# obj-m += complex.o

# Kernel source directory
KDIR ?= /lib/modules/$(shell uname -r)/build

# Module source directory
PWD := $(shell pwd)

# Build targets
all:
	$(MAKE) -C $(KDIR) M=$(PWD) modules

clean:
	$(MAKE) -C $(KDIR) M=$(PWD) clean

install:
	$(MAKE) -C $(KDIR) M=$(PWD) modules_install
	depmod -a

# Debug build
debug:
	$(MAKE) -C $(KDIR) M=$(PWD) modules EXTRA_CFLAGS="-g -DDEBUG"

# Check coding style
checkstyle:
	$(KDIR)/scripts/checkpatch.pl --no-tree -f *.c

# Generate tags for navigation
tags:
	ctags -R . $(KDIR)/include

.PHONY: all clean install debug checkstyle tags
```

### Advanced Module Techniques

```c
// advanced_module.c - Demonstrates advanced techniques
#include <linux/module.h>
#include <linux/kernel.h>
#include <linux/slab.h>
#include <linux/list.h>
#include <linux/spinlock.h>
#include <linux/kthread.h>
#include <linux/delay.h>

// Custom data structure
struct my_data {
    struct list_head list;
    int id;
    char name[32];
    spinlock_t lock;
};

// Global list and lock
static LIST_HEAD(data_list);
static DEFINE_SPINLOCK(list_lock);
static struct task_struct *worker_thread;

// Kernel thread function
static int worker_thread_fn(void *data)
{
    int counter = 0;
    
    while (!kthread_should_stop()) {
        struct my_data *entry;
        
        // Create new entry
        entry = kmalloc(sizeof(*entry), GFP_KERNEL);
        if (!entry) {
            pr_err("Failed to allocate memory\n");
            continue;
        }
        
        // Initialize entry
        entry->id = counter++;
        snprintf(entry->name, sizeof(entry->name), "entry_%d", entry->id);
        spin_lock_init(&entry->lock);
        
        // Add to list
        spin_lock(&list_lock);
        list_add_tail(&entry->list, &data_list);
        spin_unlock(&list_lock);
        
        pr_info("Added entry %d\n", entry->id);
        
        // Sleep for a while
        msleep(1000);
        
        // Cleanup old entries
        if (counter % 10 == 0) {
            struct my_data *pos, *tmp;
            
            spin_lock(&list_lock);
            list_for_each_entry_safe(pos, tmp, &data_list, list) {
                if (pos->id < counter - 20) {
                    list_del(&pos->list);
                    kfree(pos);
                    pr_info("Removed old entry %d\n", pos->id);
                }
            }
            spin_unlock(&list_lock);
        }
    }
    
    return 0;
}

static int __init advanced_init(void)
{
    pr_info("Advanced module loading\n");
    
    // Create kernel thread
    worker_thread = kthread_create(worker_thread_fn, NULL, "my_worker");
    if (IS_ERR(worker_thread)) {
        pr_err("Failed to create kernel thread\n");
        return PTR_ERR(worker_thread);
    }
    
    // Start the thread
    wake_up_process(worker_thread);
    
    return 0;
}

static void __exit advanced_exit(void)
{
    struct my_data *pos, *tmp;
    
    pr_info("Advanced module unloading\n");
    
    // Stop kernel thread
    if (worker_thread) {
        kthread_stop(worker_thread);
    }
    
    // Clean up list
    spin_lock(&list_lock);
    list_for_each_entry_safe(pos, tmp, &data_list, list) {
        list_del(&pos->list);
        kfree(pos);
    }
    spin_unlock(&list_lock);
}

module_init(advanced_init);
module_exit(advanced_exit);

MODULE_LICENSE("GPL");
MODULE_DESCRIPTION("Advanced kernel module example");
```

## Character Device Drivers

### Basic Character Device

```c
// chardev.c - Character device driver
#include <linux/module.h>
#include <linux/fs.h>
#include <linux/cdev.h>
#include <linux/device.h>
#include <linux/uaccess.h>
#include <linux/slab.h>
#include <linux/mutex.h>

#define DEVICE_NAME "mychardev"
#define CLASS_NAME "mycharclass"
#define BUFFER_SIZE 1024

// Device structure
struct mychar_dev {
    struct cdev cdev;
    struct class *class;
    struct device *device;
    dev_t dev_num;
    struct mutex lock;
    char *buffer;
    size_t buffer_size;
    size_t data_size;
};

static struct mychar_dev *mydev;

// File operations
static int mychar_open(struct inode *inode, struct file *filp)
{
    struct mychar_dev *dev;
    
    // Get device structure
    dev = container_of(inode->i_cdev, struct mychar_dev, cdev);
    filp->private_data = dev;
    
    pr_info("Device opened\n");
    return 0;
}

static int mychar_release(struct inode *inode, struct file *filp)
{
    pr_info("Device closed\n");
    return 0;
}

static ssize_t mychar_read(struct file *filp, char __user *buf,
                          size_t count, loff_t *f_pos)
{
    struct mychar_dev *dev = filp->private_data;
    ssize_t retval = 0;
    
    if (mutex_lock_interruptible(&dev->lock))
        return -ERESTARTSYS;
    
    if (*f_pos >= dev->data_size)
        goto out;
    
    if (*f_pos + count > dev->data_size)
        count = dev->data_size - *f_pos;
    
    if (copy_to_user(buf, dev->buffer + *f_pos, count)) {
        retval = -EFAULT;
        goto out;
    }
    
    *f_pos += count;
    retval = count;
    
    pr_info("Read %zu bytes from position %lld\n", count, *f_pos);
    
out:
    mutex_unlock(&dev->lock);
    return retval;
}

static ssize_t mychar_write(struct file *filp, const char __user *buf,
                           size_t count, loff_t *f_pos)
{
    struct mychar_dev *dev = filp->private_data;
    ssize_t retval = 0;
    
    if (mutex_lock_interruptible(&dev->lock))
        return -ERESTARTSYS;
    
    if (*f_pos >= dev->buffer_size) {
        retval = -ENOSPC;
        goto out;
    }
    
    if (*f_pos + count > dev->buffer_size)
        count = dev->buffer_size - *f_pos;
    
    if (copy_from_user(dev->buffer + *f_pos, buf, count)) {
        retval = -EFAULT;
        goto out;
    }
    
    *f_pos += count;
    if (*f_pos > dev->data_size)
        dev->data_size = *f_pos;
    
    retval = count;
    
    pr_info("Wrote %zu bytes to position %lld\n", count, *f_pos);
    
out:
    mutex_unlock(&dev->lock);
    return retval;
}

static loff_t mychar_llseek(struct file *filp, loff_t offset, int whence)
{
    struct mychar_dev *dev = filp->private_data;
    loff_t newpos;
    
    switch (whence) {
    case SEEK_SET:
        newpos = offset;
        break;
    case SEEK_CUR:
        newpos = filp->f_pos + offset;
        break;
    case SEEK_END:
        newpos = dev->data_size + offset;
        break;
    default:
        return -EINVAL;
    }
    
    if (newpos < 0)
        return -EINVAL;
    
    filp->f_pos = newpos;
    return newpos;
}

// ioctl implementation
static long mychar_ioctl(struct file *filp, unsigned int cmd, unsigned long arg)
{
    struct mychar_dev *dev = filp->private_data;
    int retval = 0;
    
    // Define ioctl commands
    #define MYCHAR_IOC_MAGIC 'k'
    #define MYCHAR_IOCRESET    _IO(MYCHAR_IOC_MAGIC, 0)
    #define MYCHAR_IOCGSIZE    _IOR(MYCHAR_IOC_MAGIC, 1, size_t)
    #define MYCHAR_IOCSSIZE    _IOW(MYCHAR_IOC_MAGIC, 2, size_t)
    
    switch (cmd) {
    case MYCHAR_IOCRESET:
        mutex_lock(&dev->lock);
        dev->data_size = 0;
        memset(dev->buffer, 0, dev->buffer_size);
        mutex_unlock(&dev->lock);
        pr_info("Device reset\n");
        break;
        
    case MYCHAR_IOCGSIZE:
        if (put_user(dev->data_size, (size_t __user *)arg))
            retval = -EFAULT;
        break;
        
    case MYCHAR_IOCSSIZE:
        if (get_user(dev->data_size, (size_t __user *)arg))
            retval = -EFAULT;
        break;
        
    default:
        retval = -ENOTTY;
    }
    
    return retval;
}

static const struct file_operations mychar_fops = {
    .owner = THIS_MODULE,
    .open = mychar_open,
    .release = mychar_release,
    .read = mychar_read,
    .write = mychar_write,
    .llseek = mychar_llseek,
    .unlocked_ioctl = mychar_ioctl,
};

static int __init mychar_init(void)
{
    int retval;
    
    // Allocate device structure
    mydev = kzalloc(sizeof(*mydev), GFP_KERNEL);
    if (!mydev)
        return -ENOMEM;
    
    // Allocate buffer
    mydev->buffer_size = BUFFER_SIZE;
    mydev->buffer = kzalloc(mydev->buffer_size, GFP_KERNEL);
    if (!mydev->buffer) {
        kfree(mydev);
        return -ENOMEM;
    }
    
    mutex_init(&mydev->lock);
    
    // Allocate device number
    retval = alloc_chrdev_region(&mydev->dev_num, 0, 1, DEVICE_NAME);
    if (retval < 0) {
        pr_err("Failed to allocate device number\n");
        goto fail_alloc;
    }
    
    // Initialize cdev
    cdev_init(&mydev->cdev, &mychar_fops);
    mydev->cdev.owner = THIS_MODULE;
    
    // Add cdev
    retval = cdev_add(&mydev->cdev, mydev->dev_num, 1);
    if (retval < 0) {
        pr_err("Failed to add cdev\n");
        goto fail_cdev;
    }
    
    // Create class
    mydev->class = class_create(THIS_MODULE, CLASS_NAME);
    if (IS_ERR(mydev->class)) {
        pr_err("Failed to create class\n");
        retval = PTR_ERR(mydev->class);
        goto fail_class;
    }
    
    // Create device
    mydev->device = device_create(mydev->class, NULL, mydev->dev_num,
                                 NULL, DEVICE_NAME);
    if (IS_ERR(mydev->device)) {
        pr_err("Failed to create device\n");
        retval = PTR_ERR(mydev->device);
        goto fail_device;
    }
    
    pr_info("Character device registered: %s\n", DEVICE_NAME);
    return 0;
    
fail_device:
    class_destroy(mydev->class);
fail_class:
    cdev_del(&mydev->cdev);
fail_cdev:
    unregister_chrdev_region(mydev->dev_num, 1);
fail_alloc:
    kfree(mydev->buffer);
    kfree(mydev);
    return retval;
}

static void __exit mychar_exit(void)
{
    device_destroy(mydev->class, mydev->dev_num);
    class_destroy(mydev->class);
    cdev_del(&mydev->cdev);
    unregister_chrdev_region(mydev->dev_num, 1);
    kfree(mydev->buffer);
    kfree(mydev);
    
    pr_info("Character device unregistered\n");
}

module_init(mychar_init);
module_exit(mychar_exit);

MODULE_LICENSE("GPL");
MODULE_DESCRIPTION("Character device driver example");
```

## Memory Management in Kernel

### Kernel Memory Allocation

```c
// kmem_example.c - Kernel memory management
#include <linux/module.h>
#include <linux/slab.h>
#include <linux/vmalloc.h>
#include <linux/mm.h>
#include <linux/highmem.h>
#include <linux/gfp.h>

// Custom cache for frequent allocations
static struct kmem_cache *my_cache;

struct my_object {
    int id;
    char data[128];
    struct list_head list;
    atomic_t refcount;
};

// Cache constructor
static void my_object_ctor(void *obj)
{
    struct my_object *myobj = obj;
    
    memset(myobj, 0, sizeof(*myobj));
    INIT_LIST_HEAD(&myobj->list);
    atomic_set(&myobj->refcount, 1);
}

// Memory allocation examples
static void demonstrate_memory_allocation(void)
{
    void *ptr;
    struct page *page;
    
    // kmalloc - physically contiguous memory
    ptr = kmalloc(1024, GFP_KERNEL);
    if (ptr) {
        pr_info("kmalloc: allocated 1KB at %p\n", ptr);
        kfree(ptr);
    }
    
    // kzalloc - zeroed memory
    ptr = kzalloc(4096, GFP_KERNEL);
    if (ptr) {
        pr_info("kzalloc: allocated 4KB zeroed memory\n");
        kfree(ptr);
    }
    
    // vmalloc - virtually contiguous memory
    ptr = vmalloc(1024 * 1024);  // 1MB
    if (ptr) {
        pr_info("vmalloc: allocated 1MB at %p\n", ptr);
        vfree(ptr);
    }
    
    // Page allocation
    page = alloc_pages(GFP_KERNEL, 2);  // 4 pages (16KB)
    if (page) {
        void *addr = page_address(page);
        pr_info("alloc_pages: allocated 4 pages at %p\n", addr);
        __free_pages(page, 2);
    }
    
    // High memory allocation
    page = alloc_page(GFP_HIGHUSER);
    if (page) {
        void *addr = kmap(page);
        if (addr) {
            pr_info("High memory page mapped at %p\n", addr);
            kunmap(page);
        }
        __free_page(page);
    }
    
    // Atomic allocation (can be called from interrupt context)
    ptr = kmalloc(256, GFP_ATOMIC);
    if (ptr) {
        pr_info("Atomic allocation succeeded\n");
        kfree(ptr);
    }
}

// Memory pool implementation
struct memory_pool {
    void **elements;
    int size;
    int count;
    spinlock_t lock;
};

static struct memory_pool *create_memory_pool(int size, size_t element_size)
{
    struct memory_pool *pool;
    int i;
    
    pool = kzalloc(sizeof(*pool), GFP_KERNEL);
    if (!pool)
        return NULL;
    
    pool->elements = kzalloc(size * sizeof(void *), GFP_KERNEL);
    if (!pool->elements) {
        kfree(pool);
        return NULL;
    }
    
    spin_lock_init(&pool->lock);
    pool->size = size;
    
    // Pre-allocate elements
    for (i = 0; i < size; i++) {
        pool->elements[i] = kmalloc(element_size, GFP_KERNEL);
        if (!pool->elements[i])
            break;
        pool->count++;
    }
    
    pr_info("Created memory pool with %d elements\n", pool->count);
    return pool;
}

static void *pool_alloc(struct memory_pool *pool)
{
    void *element = NULL;
    unsigned long flags;
    
    spin_lock_irqsave(&pool->lock, flags);
    if (pool->count > 0) {
        element = pool->elements[--pool->count];
        pool->elements[pool->count] = NULL;
    }
    spin_unlock_irqrestore(&pool->lock, flags);
    
    return element;
}

static void pool_free(struct memory_pool *pool, void *element)
{
    unsigned long flags;
    
    spin_lock_irqsave(&pool->lock, flags);
    if (pool->count < pool->size) {
        pool->elements[pool->count++] = element;
    } else {
        kfree(element);  // Pool full, free the element
    }
    spin_unlock_irqrestore(&pool->lock, flags);
}

// DMA memory allocation
static void demonstrate_dma_allocation(void)
{
    struct device *dev = NULL;  // Would be actual device in real driver
    dma_addr_t dma_handle;
    void *cpu_addr;
    
    // Coherent DMA allocation
    cpu_addr = dma_alloc_coherent(dev, 4096, &dma_handle, GFP_KERNEL);
    if (cpu_addr) {
        pr_info("DMA coherent: CPU addr %p, DMA addr %pad\n",
                cpu_addr, &dma_handle);
        
        // Use the buffer...
        
        dma_free_coherent(dev, 4096, cpu_addr, dma_handle);
    }
}

static int __init kmem_init(void)
{
    pr_info("Kernel memory example loading\n");
    
    // Create slab cache
    my_cache = kmem_cache_create("my_object_cache",
                                sizeof(struct my_object),
                                0,  // Alignment
                                SLAB_HWCACHE_ALIGN | SLAB_PANIC,
                                my_object_ctor);
    
    if (!my_cache) {
        pr_err("Failed to create slab cache\n");
        return -ENOMEM;
    }
    
    // Demonstrate allocations
    demonstrate_memory_allocation();
    
    // Allocate from cache
    struct my_object *obj = kmem_cache_alloc(my_cache, GFP_KERNEL);
    if (obj) {
        obj->id = 42;
        pr_info("Allocated object from cache: id=%d\n", obj->id);
        kmem_cache_free(my_cache, obj);
    }
    
    return 0;
}

static void __exit kmem_exit(void)
{
    // Destroy cache
    if (my_cache)
        kmem_cache_destroy(my_cache);
    
    pr_info("Kernel memory example unloaded\n");
}

module_init(kmem_init);
module_exit(kmem_exit);

MODULE_LICENSE("GPL");
MODULE_DESCRIPTION("Kernel memory management examples");
```

## Interrupt Handling

### Interrupt Handler Implementation

```c
// interrupt_driver.c - Interrupt handling example
#include <linux/module.h>
#include <linux/interrupt.h>
#include <linux/workqueue.h>
#include <linux/timer.h>
#include <linux/delay.h>

#define IRQ_NUM 16  // Example IRQ number

// Device structure
struct my_irq_dev {
    int irq;
    atomic_t irq_count;
    struct tasklet_struct tasklet;
    struct work_struct work;
    struct workqueue_struct *wq;
    struct timer_list timer;
    spinlock_t lock;
    unsigned long flags;
};

static struct my_irq_dev *irq_dev;

// Top half - interrupt handler (must be fast)
static irqreturn_t my_interrupt_handler(int irq, void *dev_id)
{
    struct my_irq_dev *dev = dev_id;
    unsigned long flags;
    
    // Minimal work in interrupt context
    spin_lock_irqsave(&dev->lock, flags);
    
    // Increment interrupt count
    atomic_inc(&dev->irq_count);
    
    // Schedule bottom half processing
    tasklet_schedule(&dev->tasklet);
    
    // Queue work for later
    queue_work(dev->wq, &dev->work);
    
    spin_unlock_irqrestore(&dev->lock, flags);
    
    return IRQ_HANDLED;
}

// Bottom half - tasklet (runs in softirq context)
static void my_tasklet_handler(unsigned long data)
{
    struct my_irq_dev *dev = (struct my_irq_dev *)data;
    int count = atomic_read(&dev->irq_count);
    
    pr_info("Tasklet: Processing interrupt %d\n", count);
    
    // Do more processing here
    // Note: Cannot sleep in tasklet context
}

// Bottom half - work queue (can sleep)
static void my_work_handler(struct work_struct *work)
{
    struct my_irq_dev *dev = container_of(work, struct my_irq_dev, work);
    
    pr_info("Work queue: Processing interrupt\n");
    
    // Can do sleeping operations here
    msleep(10);
    
    // Access hardware, allocate memory, etc.
}

// Timer handler
static void my_timer_handler(struct timer_list *t)
{
    struct my_irq_dev *dev = from_timer(dev, t, timer);
    
    pr_info("Timer expired, interrupt count: %d\n",
            atomic_read(&dev->irq_count));
    
    // Restart timer
    mod_timer(&dev->timer, jiffies + msecs_to_jiffies(5000));
}

// Threaded interrupt handler
static irqreturn_t my_threaded_handler(int irq, void *dev_id)
{
    struct my_irq_dev *dev = dev_id;
    
    pr_info("Threaded handler: Processing in process context\n");
    
    // Can sleep here
    msleep(1);
    
    return IRQ_HANDLED;
}

// MSI interrupt setup
static int setup_msi_interrupt(struct pci_dev *pdev)
{
    int ret;
    int nvec = 4;  // Request 4 MSI vectors
    
    // Enable MSI
    ret = pci_alloc_irq_vectors(pdev, 1, nvec, PCI_IRQ_MSI);
    if (ret < 0) {
        pr_err("Failed to allocate MSI vectors\n");
        return ret;
    }
    
    pr_info("Allocated %d MSI vectors\n", ret);
    
    // Request IRQ for each vector
    for (int i = 0; i < ret; i++) {
        int irq = pci_irq_vector(pdev, i);
        
        ret = request_irq(irq, my_interrupt_handler, 0,
                         "my_msi_handler", irq_dev);
        if (ret) {
            pr_err("Failed to request IRQ %d\n", irq);
            // Cleanup previous IRQs
            while (--i >= 0) {
                free_irq(pci_irq_vector(pdev, i), irq_dev);
            }
            pci_free_irq_vectors(pdev);
            return ret;
        }
    }
    
    return 0;
}

static int __init interrupt_init(void)
{
    int ret;
    
    pr_info("Interrupt driver loading\n");
    
    // Allocate device structure
    irq_dev = kzalloc(sizeof(*irq_dev), GFP_KERNEL);
    if (!irq_dev)
        return -ENOMEM;
    
    // Initialize
    atomic_set(&irq_dev->irq_count, 0);
    spin_lock_init(&irq_dev->lock);
    
    // Initialize tasklet
    tasklet_init(&irq_dev->tasklet, my_tasklet_handler,
                 (unsigned long)irq_dev);
    
    // Initialize work queue
    irq_dev->wq = create_singlethread_workqueue("my_irq_wq");
    if (!irq_dev->wq) {
        ret = -ENOMEM;
        goto fail_wq;
    }
    
    INIT_WORK(&irq_dev->work, my_work_handler);
    
    // Initialize timer
    timer_setup(&irq_dev->timer, my_timer_handler, 0);
    mod_timer(&irq_dev->timer, jiffies + msecs_to_jiffies(5000));
    
    // Request interrupt (shared)
    ret = request_irq(IRQ_NUM, my_interrupt_handler,
                     IRQF_SHARED, "my_interrupt", irq_dev);
    if (ret) {
        pr_err("Failed to request IRQ %d\n", IRQ_NUM);
        goto fail_irq;
    }
    
    // Alternative: Request threaded IRQ
    /*
    ret = request_threaded_irq(IRQ_NUM,
                              my_interrupt_handler,  // Top half
                              my_threaded_handler,   // Bottom half
                              IRQF_SHARED,
                              "my_threaded_irq",
                              irq_dev);
    */
    
    pr_info("Interrupt handler registered for IRQ %d\n", IRQ_NUM);
    return 0;
    
fail_irq:
    del_timer_sync(&irq_dev->timer);
    destroy_workqueue(irq_dev->wq);
fail_wq:
    kfree(irq_dev);
    return ret;
}

static void __exit interrupt_exit(void)
{
    pr_info("Interrupt driver unloading\n");
    
    // Free IRQ
    free_irq(IRQ_NUM, irq_dev);
    
    // Stop timer
    del_timer_sync(&irq_dev->timer);
    
    // Stop tasklet
    tasklet_kill(&irq_dev->tasklet);
    
    // Flush and destroy workqueue
    flush_workqueue(irq_dev->wq);
    destroy_workqueue(irq_dev->wq);
    
    kfree(irq_dev);
}

module_init(interrupt_init);
module_exit(interrupt_exit);

MODULE_LICENSE("GPL");
MODULE_DESCRIPTION("Interrupt handling example");
```

## Kernel Synchronization

### Locking Primitives

```c
// sync_example.c - Kernel synchronization primitives
#include <linux/module.h>
#include <linux/spinlock.h>
#include <linux/mutex.h>
#include <linux/rwsem.h>
#include <linux/completion.h>
#include <linux/atomic.h>
#include <linux/percpu.h>
#include <linux/rcu.h>

// Spinlock example
static DEFINE_SPINLOCK(my_spinlock);
static int shared_counter = 0;

static void spinlock_example(void)
{
    unsigned long flags;
    
    // Interrupt-safe spinlock
    spin_lock_irqsave(&my_spinlock, flags);
    shared_counter++;
    spin_unlock_irqrestore(&my_spinlock, flags);
    
    // Non-interrupt context
    spin_lock(&my_spinlock);
    shared_counter--;
    spin_unlock(&my_spinlock);
    
    // Try lock
    if (spin_trylock(&my_spinlock)) {
        // Got the lock
        shared_counter++;
        spin_unlock(&my_spinlock);
    }
}

// Mutex example
static DEFINE_MUTEX(my_mutex);

static void mutex_example(void)
{
    // Can sleep while waiting
    mutex_lock(&my_mutex);
    
    // Do work that might sleep
    msleep(10);
    
    mutex_unlock(&my_mutex);
    
    // Interruptible lock
    if (mutex_lock_interruptible(&my_mutex) == 0) {
        // Got the lock
        mutex_unlock(&my_mutex);
    }
    
    // Try lock
    if (mutex_trylock(&my_mutex)) {
        // Got the lock
        mutex_unlock(&my_mutex);
    }
}

// Read-write semaphore
static DECLARE_RWSEM(my_rwsem);
static int shared_data = 0;

static void rwsem_reader(void)
{
    down_read(&my_rwsem);
    
    // Multiple readers can access simultaneously
    pr_info("Reader: shared_data = %d\n", shared_data);
    
    up_read(&my_rwsem);
}

static void rwsem_writer(void)
{
    down_write(&my_rwsem);
    
    // Exclusive access for writing
    shared_data++;
    pr_info("Writer: updated shared_data to %d\n", shared_data);
    
    up_write(&my_rwsem);
}

// Completion example
static DECLARE_COMPLETION(my_completion);

static int completion_thread(void *data)
{
    pr_info("Thread: Doing work...\n");
    msleep(2000);
    pr_info("Thread: Work done, signaling completion\n");
    
    complete(&my_completion);
    
    return 0;
}

static void completion_example(void)
{
    struct task_struct *thread;
    
    // Start thread
    thread = kthread_run(completion_thread, NULL, "completion_thread");
    
    // Wait for completion
    pr_info("Waiting for thread to complete...\n");
    wait_for_completion(&my_completion);
    pr_info("Thread completed!\n");
    
    // Reinitialize for next use
    reinit_completion(&my_completion);
}

// Atomic operations
static atomic_t atomic_counter = ATOMIC_INIT(0);

static void atomic_example(void)
{
    int old_val, new_val;
    
    // Increment
    atomic_inc(&atomic_counter);
    
    // Decrement and test
    if (atomic_dec_and_test(&atomic_counter)) {
        pr_info("Counter reached zero\n");
    }
    
    // Add and return old value
    old_val = atomic_fetch_add(5, &atomic_counter);
    
    // Compare and swap
    old_val = 5;
    new_val = 10;
    if (atomic_cmpxchg(&atomic_counter, old_val, new_val) == old_val) {
        pr_info("Successfully changed from %d to %d\n", old_val, new_val);
    }
}

// Per-CPU variables
static DEFINE_PER_CPU(int, per_cpu_counter);

static void per_cpu_example(void)
{
    int cpu;
    
    // Increment on current CPU
    get_cpu();
    __this_cpu_inc(per_cpu_counter);
    put_cpu();
    
    // Access specific CPU's variable
    for_each_possible_cpu(cpu) {
        int *counter = per_cpu_ptr(&per_cpu_counter, cpu);
        pr_info("CPU %d counter: %d\n", cpu, *counter);
    }
}

// RCU (Read-Copy-Update)
struct rcu_data {
    struct rcu_head rcu;
    int value;
};

static struct rcu_data __rcu *global_data;

static void rcu_callback(struct rcu_head *head)
{
    struct rcu_data *data = container_of(head, struct rcu_data, rcu);
    kfree(data);
}

static void rcu_example(void)
{
    struct rcu_data *new_data, *old_data;
    
    // Allocate new data
    new_data = kzalloc(sizeof(*new_data), GFP_KERNEL);
    new_data->value = 42;
    
    // Update pointer
    old_data = rcu_dereference(global_data);
    rcu_assign_pointer(global_data, new_data);
    
    // Free old data after grace period
    if (old_data)
        call_rcu(&old_data->rcu, rcu_callback);
    
    // Reader side
    rcu_read_lock();
    {
        struct rcu_data *data = rcu_dereference(global_data);
        if (data)
            pr_info("RCU data value: %d\n", data->value);
    }
    rcu_read_unlock();
}

static int __init sync_init(void)
{
    pr_info("Synchronization examples loading\n");
    
    spinlock_example();
    mutex_example();
    atomic_example();
    per_cpu_example();
    
    return 0;
}

static void __exit sync_exit(void)
{
    pr_info("Synchronization examples unloading\n");
}

module_init(sync_init);
module_exit(sync_exit);

MODULE_LICENSE("GPL");
MODULE_DESCRIPTION("Kernel synchronization examples");
```

## Kernel Debugging

### Debugging Techniques

```c
// debug_module.c - Kernel debugging techniques
#include <linux/module.h>
#include <linux/kernel.h>
#include <linux/debugfs.h>
#include <linux/seq_file.h>
#include <linux/kallsyms.h>
#include <linux/kprobes.h>
#include <linux/ftrace.h>

// Debug levels
#define DBG_LEVEL_ERROR   0
#define DBG_LEVEL_WARNING 1
#define DBG_LEVEL_INFO    2
#define DBG_LEVEL_DEBUG   3

static int debug_level = DBG_LEVEL_INFO;
module_param(debug_level, int, 0644);

// Custom debug macros
#define DBG_PRINT(level, fmt, ...) \
    do { \
        if (level <= debug_level) \
            pr_info("[%s:%d] " fmt, __func__, __LINE__, ##__VA_ARGS__); \
    } while (0)

#define DBG_ERROR(fmt, ...)   DBG_PRINT(DBG_LEVEL_ERROR, fmt, ##__VA_ARGS__)
#define DBG_WARNING(fmt, ...) DBG_PRINT(DBG_LEVEL_WARNING, fmt, ##__VA_ARGS__)
#define DBG_INFO(fmt, ...)    DBG_PRINT(DBG_LEVEL_INFO, fmt, ##__VA_ARGS__)
#define DBG_DEBUG(fmt, ...)   DBG_PRINT(DBG_LEVEL_DEBUG, fmt, ##__VA_ARGS__)

// Debugfs interface
static struct dentry *debug_dir;
static struct dentry *debug_file;
static int debug_value = 0;

static int debug_show(struct seq_file *m, void *v)
{
    seq_printf(m, "Debug value: %d\n", debug_value);
    seq_printf(m, "Debug level: %d\n", debug_level);
    
    // Show kernel symbols
    unsigned long symbol_addr;
    symbol_addr = kallsyms_lookup_name("printk");
    seq_printf(m, "printk address: %px\n", (void *)symbol_addr);
    
    // Stack trace
    seq_printf(m, "\nCall stack:\n");
    dump_stack();
    
    return 0;
}

static int debug_open(struct inode *inode, struct file *file)
{
    return single_open(file, debug_show, NULL);
}

static ssize_t debug_write(struct file *file, const char __user *buf,
                          size_t count, loff_t *ppos)
{
    char kbuf[32];
    int val;
    
    if (count > sizeof(kbuf) - 1)
        return -EINVAL;
    
    if (copy_from_user(kbuf, buf, count))
        return -EFAULT;
    
    kbuf[count] = '\0';
    
    if (kstrtoint(kbuf, 0, &val) == 0) {
        debug_value = val;
        DBG_INFO("Debug value set to %d\n", debug_value);
    }
    
    return count;
}

static const struct file_operations debug_fops = {
    .open    = debug_open,
    .read    = seq_read,
    .write   = debug_write,
    .llseek  = seq_lseek,
    .release = single_release,
};

// Kprobe example
static struct kprobe kp = {
    .symbol_name = "do_fork",
};

static int handler_pre(struct kprobe *p, struct pt_regs *regs)
{
    DBG_DEBUG("do_fork called\n");
    return 0;
}

// Ftrace example
static void notrace my_trace_function(unsigned long ip, unsigned long parent_ip,
                                     struct ftrace_ops *op, struct pt_regs *regs)
{
    // Be very careful here - this runs for every function call!
    // Only do minimal work
}

static struct ftrace_ops my_ftrace_ops = {
    .func = my_trace_function,
    .flags = FTRACE_OPS_FL_SAVE_REGS,
};

// WARN_ON and BUG_ON examples
static void debug_assertions(void)
{
    int condition = 0;
    
    // WARN_ON - continues execution
    WARN_ON(condition == 0);
    WARN_ON_ONCE(condition == 0);  // Only warns once
    
    // BUG_ON - stops kernel execution (use sparingly!)
    // BUG_ON(condition == 0);  // Don't actually run this!
    
    // Better alternative
    if (unlikely(condition == 0)) {
        WARN(1, "Condition failed: %d\n", condition);
        return;
    }
}

// Memory dump
static void dump_memory(void *addr, size_t size)
{
    print_hex_dump(KERN_INFO, "Memory: ", DUMP_PREFIX_OFFSET,
                   16, 1, addr, size, true);
}

// Dynamic debug
static void dynamic_debug_example(void)
{
    pr_debug("This is a dynamic debug message\n");
    
    // Can be enabled at runtime:
    // echo 'module debug_module +p' > /sys/kernel/debug/dynamic_debug/control
}

static int __init debug_init(void)
{
    DBG_INFO("Debug module loading\n");
    
    // Create debugfs directory
    debug_dir = debugfs_create_dir("my_debug", NULL);
    if (!debug_dir) {
        pr_err("Failed to create debugfs directory\n");
        return -ENOMEM;
    }
    
    // Create debugfs file
    debug_file = debugfs_create_file("debug_info", 0644, debug_dir,
                                    NULL, &debug_fops);
    
    // Register kprobe
    kp.pre_handler = handler_pre;
    if (register_kprobe(&kp) < 0) {
        pr_err("Failed to register kprobe\n");
    }
    
    // Test debugging
    debug_assertions();
    
    return 0;
}

static void __exit debug_exit(void)
{
    DBG_INFO("Debug module unloading\n");
    
    // Cleanup
    unregister_kprobe(&kp);
    debugfs_remove_recursive(debug_dir);
}

module_init(debug_init);
module_exit(debug_exit);

MODULE_LICENSE("GPL");
MODULE_DESCRIPTION("Kernel debugging techniques");
```

## PCI Device Driver

### Basic PCI Driver

```c
// pci_driver.c - PCI device driver example
#include <linux/module.h>
#include <linux/pci.h>
#include <linux/interrupt.h>
#include <linux/dma-mapping.h>

#define VENDOR_ID 0x10ec  // Example: Realtek
#define DEVICE_ID 0x8168  // Example: RTL8168

// Device private data
struct my_pci_dev {
    struct pci_dev *pdev;
    void __iomem *mmio_base;
    int irq;
    
    // DMA
    dma_addr_t dma_handle;
    void *dma_buffer;
    size_t dma_size;
    
    // Registers
    u32 __iomem *ctrl_reg;
    u32 __iomem *status_reg;
    u32 __iomem *data_reg;
};

// PCI device IDs
static const struct pci_device_id my_pci_ids[] = {
    { PCI_DEVICE(VENDOR_ID, DEVICE_ID) },
    { 0, }
};
MODULE_DEVICE_TABLE(pci, my_pci_ids);

// Interrupt handler
static irqreturn_t my_pci_isr(int irq, void *data)
{
    struct my_pci_dev *dev = data;
    u32 status;
    
    // Read interrupt status
    status = ioread32(dev->status_reg);
    
    if (!(status & 0x01)) {
        return IRQ_NONE;  // Not our interrupt
    }
    
    // Clear interrupt
    iowrite32(status, dev->status_reg);
    
    // Handle interrupt
    pr_info("PCI interrupt: status=0x%08x\n", status);
    
    return IRQ_HANDLED;
}

// Device initialization
static int my_pci_probe(struct pci_dev *pdev, const struct pci_device_id *id)
{
    struct my_pci_dev *dev;
    int ret;
    
    pr_info("PCI probe: vendor=0x%04x, device=0x%04x\n",
            pdev->vendor, pdev->device);
    
    // Allocate private data
    dev = kzalloc(sizeof(*dev), GFP_KERNEL);
    if (!dev)
        return -ENOMEM;
    
    dev->pdev = pdev;
    pci_set_drvdata(pdev, dev);
    
    // Enable PCI device
    ret = pci_enable_device(pdev);
    if (ret) {
        pr_err("Failed to enable PCI device\n");
        goto err_free;
    }
    
    // Request PCI regions
    ret = pci_request_regions(pdev, "my_pci_driver");
    if (ret) {
        pr_err("Failed to request PCI regions\n");
        goto err_disable;
    }
    
    // Set DMA mask
    ret = dma_set_mask_and_coherent(&pdev->dev, DMA_BIT_MASK(64));
    if (ret) {
        ret = dma_set_mask_and_coherent(&pdev->dev, DMA_BIT_MASK(32));
        if (ret) {
            pr_err("Failed to set DMA mask\n");
            goto err_regions;
        }
    }
    
    // Map BAR0
    dev->mmio_base = pci_iomap(pdev, 0, 0);
    if (!dev->mmio_base) {
        pr_err("Failed to map BAR0\n");
        ret = -ENOMEM;
        goto err_regions;
    }
    
    // Setup register pointers
    dev->ctrl_reg = dev->mmio_base + 0x00;
    dev->status_reg = dev->mmio_base + 0x04;
    dev->data_reg = dev->mmio_base + 0x08;
    
    // Enable bus mastering
    pci_set_master(pdev);
    
    // Allocate DMA buffer
    dev->dma_size = 4096;
    dev->dma_buffer = dma_alloc_coherent(&pdev->dev, dev->dma_size,
                                        &dev->dma_handle, GFP_KERNEL);
    if (!dev->dma_buffer) {
        pr_err("Failed to allocate DMA buffer\n");
        ret = -ENOMEM;
        goto err_unmap;
    }
    
    // Request MSI/MSI-X
    ret = pci_alloc_irq_vectors(pdev, 1, 1, PCI_IRQ_MSI | PCI_IRQ_LEGACY);
    if (ret < 0) {
        pr_err("Failed to allocate IRQ vectors\n");
        goto err_dma;
    }
    
    // Request IRQ
    dev->irq = pci_irq_vector(pdev, 0);
    ret = request_irq(dev->irq, my_pci_isr, IRQF_SHARED,
                     "my_pci_driver", dev);
    if (ret) {
        pr_err("Failed to request IRQ\n");
        goto err_vectors;
    }
    
    // Initialize device
    iowrite32(0x01, dev->ctrl_reg);  // Enable device
    
    pr_info("PCI device initialized successfully\n");
    return 0;
    
err_vectors:
    pci_free_irq_vectors(pdev);
err_dma:
    dma_free_coherent(&pdev->dev, dev->dma_size,
                     dev->dma_buffer, dev->dma_handle);
err_unmap:
    pci_iounmap(pdev, dev->mmio_base);
err_regions:
    pci_release_regions(pdev);
err_disable:
    pci_disable_device(pdev);
err_free:
    kfree(dev);
    return ret;
}

// Device removal
static void my_pci_remove(struct pci_dev *pdev)
{
    struct my_pci_dev *dev = pci_get_drvdata(pdev);
    
    pr_info("PCI device removal\n");
    
    // Disable device
    iowrite32(0x00, dev->ctrl_reg);
    
    // Free IRQ
    free_irq(dev->irq, dev);
    pci_free_irq_vectors(pdev);
    
    // Free DMA buffer
    dma_free_coherent(&pdev->dev, dev->dma_size,
                     dev->dma_buffer, dev->dma_handle);
    
    // Unmap and release
    pci_iounmap(pdev, dev->mmio_base);
    pci_release_regions(pdev);
    pci_disable_device(pdev);
    
    kfree(dev);
}

// Power management
static int my_pci_suspend(struct device *dev)
{
    struct pci_dev *pdev = to_pci_dev(dev);
    struct my_pci_dev *mydev = pci_get_drvdata(pdev);
    
    pr_info("PCI suspend\n");
    
    // Save device state
    iowrite32(0x00, mydev->ctrl_reg);  // Disable device
    
    return 0;
}

static int my_pci_resume(struct device *dev)
{
    struct pci_dev *pdev = to_pci_dev(dev);
    struct my_pci_dev *mydev = pci_get_drvdata(pdev);
    
    pr_info("PCI resume\n");
    
    // Restore device state
    iowrite32(0x01, mydev->ctrl_reg);  // Enable device
    
    return 0;
}

static SIMPLE_DEV_PM_OPS(my_pci_pm_ops, my_pci_suspend, my_pci_resume);

// PCI driver structure
static struct pci_driver my_pci_driver = {
    .name     = "my_pci_driver",
    .id_table = my_pci_ids,
    .probe    = my_pci_probe,
    .remove   = my_pci_remove,
    .driver.pm = &my_pci_pm_ops,
};

module_pci_driver(my_pci_driver);

MODULE_LICENSE("GPL");
MODULE_DESCRIPTION("Example PCI device driver");
MODULE_AUTHOR("Your Name");
```

## Best Practices

1. **Memory Management**: Always check allocations, use appropriate GFP flags
2. **Locking**: Choose the right synchronization primitive, avoid deadlocks
3. **Error Handling**: Check all return values, clean up on failure
4. **Debugging**: Use pr_debug, debugfs, and ftrace for diagnostics
5. **Compatibility**: Handle different kernel versions appropriately
6. **Security**: Validate user input, check capabilities
7. **Performance**: Minimize time in interrupt context, use per-CPU data

## Conclusion

Kernel module development is a powerful way to extend Linux functionality. From simple loadable modules to complex device drivers, understanding kernel programming opens up low-level system programming possibilities. The techniques covered here—memory management, synchronization, interrupt handling, and device drivers—provide the foundation for kernel development.

Remember that kernel code runs with full privileges and mistakes can crash the system. Always test thoroughly in virtual machines or dedicated test systems before deploying kernel modules to production. With careful development and testing, kernel modules can provide efficient, low-level solutions that would be impossible to implement in user space.