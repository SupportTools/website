---
title: "Advanced Linux Graphics Programming: DRM/KMS Development and GPU Driver Architecture"
date: 2025-04-24T10:00:00-05:00
draft: false
tags: ["Linux", "Graphics", "DRM", "KMS", "GPU", "Vulkan", "OpenGL", "Mesa", "Wayland"]
categories:
- Linux
- Graphics Programming
author: "Matthew Mattox - mmattox@support.tools"
description: "Master advanced Linux graphics programming including DRM/KMS kernel development, GPU driver architecture, Vulkan programming, and building high-performance graphics applications"
more_link: "yes"
url: "/advanced-linux-graphics-drm-programming/"
---

Linux graphics programming requires deep understanding of the Direct Rendering Manager (DRM) subsystem, Kernel Mode Setting (KMS), and modern GPU architectures. This comprehensive guide explores advanced graphics concepts, from low-level DRM driver development to building high-performance Vulkan applications and custom display management systems.

<!--more-->

# [Advanced Linux Graphics Programming](#advanced-linux-graphics-drm-programming)

## DRM/KMS Kernel Driver Development

### Advanced DRM Driver Framework

```c
// drm_driver.c - Advanced DRM driver implementation
#include <linux/module.h>
#include <linux/kernel.h>
#include <linux/init.h>
#include <linux/pci.h>
#include <linux/dma-mapping.h>
#include <linux/interrupt.h>
#include <linux/workqueue.h>
#include <linux/delay.h>
#include <linux/firmware.h>
#include <linux/pm_runtime.h>

#include <drm/drm_drv.h>
#include <drm/drm_device.h>
#include <drm/drm_file.h>
#include <drm/drm_ioctl.h>
#include <drm/drm_gem.h>
#include <drm/drm_prime.h>
#include <drm/drm_atomic.h>
#include <drm/drm_atomic_helper.h>
#include <drm/drm_crtc.h>
#include <drm/drm_crtc_helper.h>
#include <drm/drm_encoder.h>
#include <drm/drm_connector.h>
#include <drm/drm_plane.h>
#include <drm/drm_framebuffer.h>
#include <drm/drm_gem_cma_helper.h>
#include <drm/drm_fb_cma_helper.h>
#include <drm/drm_probe_helper.h>

#define DRIVER_NAME "advanced_gpu"
#define DRIVER_DESC "Advanced GPU DRM Driver"
#define DRIVER_DATE "20250424"
#define DRIVER_MAJOR 1
#define DRIVER_MINOR 0

#define MAX_CRTCS 4
#define MAX_ENCODERS 8
#define MAX_CONNECTORS 16
#define MAX_PLANES 32

// Hardware register definitions
#define GPU_BASE_ADDR 0x10000000
#define GPU_REG_SIZE 0x100000

#define GPU_CONTROL_REG 0x0000
#define GPU_STATUS_REG 0x0004
#define GPU_INTERRUPT_REG 0x0008
#define GPU_MEMORY_BASE_REG 0x0010
#define GPU_COMMAND_RING_REG 0x0020
#define GPU_FENCE_REG 0x0030

// Display controller registers
#define DISPLAY_CONTROL_REG 0x1000
#define DISPLAY_STATUS_REG 0x1004
#define CRTC_BASE_REG(n) (0x1100 + (n) * 0x100)
#define PLANE_BASE_REG(n) (0x1400 + (n) * 0x80)
#define ENCODER_BASE_REG(n) (0x1800 + (n) * 0x40)

// GPU device structure
struct advanced_gpu_device {
    struct drm_device drm;
    struct pci_dev *pdev;
    
    // Memory management
    void __iomem *mmio_base;
    resource_size_t mmio_size;
    dma_addr_t vram_base;
    size_t vram_size;
    void *vram_cpu_addr;
    
    // Command processing
    struct {
        void *ring_buffer;
        dma_addr_t ring_dma;
        size_t ring_size;
        uint32_t head;
        uint32_t tail;
        spinlock_t lock;
        wait_queue_head_t fence_queue;
        uint64_t last_fence;
        uint64_t current_fence;
    } command_ring;
    
    // Interrupt handling
    int irq;
    bool irq_enabled;
    spinlock_t irq_lock;
    
    // Power management
    struct {
        bool runtime_pm_enabled;
        int usage_count;
        struct work_struct suspend_work;
    } pm;
    
    // Performance counters
    struct {
        atomic64_t commands_submitted;
        atomic64_t commands_completed;
        atomic64_t interrupts_handled;
        atomic64_t page_faults;
        atomic64_t memory_allocated;
    } stats;
};

// GPU object structure for GEM
struct advanced_gpu_gem_object {
    struct drm_gem_object base;
    
    // Memory attributes
    dma_addr_t dma_addr;
    void *cpu_addr;
    bool coherent;
    bool cached;
    
    // GPU mapping
    uint64_t gpu_addr;
    bool mapped_to_gpu;
    
    // Synchronization
    struct dma_fence *fence;
    bool needs_flush;
};

// CRTC private structure
struct advanced_gpu_crtc {
    struct drm_crtc base;
    struct advanced_gpu_device *gpu;
    int index;
    
    // Hardware state
    bool enabled;
    struct drm_display_mode current_mode;
    struct drm_framebuffer *fb;
    
    // Registers
    uint32_t control_reg;
    uint32_t timing_reg;
    uint32_t format_reg;
    uint32_t address_reg;
};

// Encoder private structure
struct advanced_gpu_encoder {
    struct drm_encoder base;
    struct advanced_gpu_device *gpu;
    int index;
    
    // Encoder type and capabilities
    enum drm_encoder_type type;
    uint32_t possible_crtcs;
    uint32_t possible_clones;
    
    // Hardware configuration
    uint32_t control_reg;
    uint32_t config_reg;
};

// Connector private structure
struct advanced_gpu_connector {
    struct drm_connector base;
    struct advanced_gpu_device *gpu;
    int index;
    
    // Connection status
    enum drm_connector_status status;
    bool hotplug_detect;
    
    // EDID and display info
    struct edid *edid;
    struct drm_display_info display_info;
    
    // I2C for DDC
    struct i2c_adapter *ddc;
};

// Plane private structure
struct advanced_gpu_plane {
    struct drm_plane base;
    struct advanced_gpu_device *gpu;
    int index;
    
    // Plane capabilities
    uint32_t supported_formats[32];
    int num_formats;
    uint64_t supported_modifiers[16];
    int num_modifiers;
    
    // Scaling capabilities
    bool scaling_supported;
    uint32_t min_scale;
    uint32_t max_scale;
};

// Function prototypes
static int advanced_gpu_probe(struct pci_dev *pdev, const struct pci_device_id *id);
static void advanced_gpu_remove(struct pci_dev *pdev);
static int advanced_gpu_suspend(struct device *dev);
static int advanced_gpu_resume(struct device *dev);

// DRM driver operations
static int advanced_gpu_open(struct drm_device *dev, struct drm_file *file);
static void advanced_gpu_postclose(struct drm_device *dev, struct drm_file *file);
static int advanced_gpu_gem_create_ioctl(struct drm_device *dev, void *data,
                                        struct drm_file *file);
static int advanced_gpu_gem_mmap_ioctl(struct drm_device *dev, void *data,
                                      struct drm_file *file);
static int advanced_gpu_submit_command_ioctl(struct drm_device *dev, void *data,
                                            struct drm_file *file);

// Hardware abstraction layer
static inline uint32_t gpu_read(struct advanced_gpu_device *gpu, uint32_t reg)
{
    return readl(gpu->mmio_base + reg);
}

static inline void gpu_write(struct advanced_gpu_device *gpu, uint32_t reg, uint32_t val)
{
    writel(val, gpu->mmio_base + reg);
}

static inline void gpu_write_mask(struct advanced_gpu_device *gpu, uint32_t reg,
                                 uint32_t mask, uint32_t val)
{
    uint32_t tmp = gpu_read(gpu, reg);
    tmp = (tmp & ~mask) | (val & mask);
    gpu_write(gpu, reg, tmp);
}

// Command ring management
static int command_ring_init(struct advanced_gpu_device *gpu)
{
    gpu->command_ring.ring_size = PAGE_SIZE * 16; // 64KB ring
    
    gpu->command_ring.ring_buffer = dma_alloc_coherent(&gpu->pdev->dev,
                                                      gpu->command_ring.ring_size,
                                                      &gpu->command_ring.ring_dma,
                                                      GFP_KERNEL);
    if (!gpu->command_ring.ring_buffer) {
        dev_err(&gpu->pdev->dev, "Failed to allocate command ring\n");
        return -ENOMEM;
    }
    
    gpu->command_ring.head = 0;
    gpu->command_ring.tail = 0;
    gpu->command_ring.last_fence = 0;
    gpu->command_ring.current_fence = 0;
    
    spin_lock_init(&gpu->command_ring.lock);
    init_waitqueue_head(&gpu->command_ring.fence_queue);
    
    // Program hardware ring buffer address
    gpu_write(gpu, GPU_COMMAND_RING_REG, gpu->command_ring.ring_dma);
    gpu_write(gpu, GPU_COMMAND_RING_REG + 4, gpu->command_ring.ring_size);
    
    return 0;
}

static void command_ring_cleanup(struct advanced_gpu_device *gpu)
{
    if (gpu->command_ring.ring_buffer) {
        dma_free_coherent(&gpu->pdev->dev, gpu->command_ring.ring_size,
                         gpu->command_ring.ring_buffer, gpu->command_ring.ring_dma);
    }
}

static int command_ring_submit(struct advanced_gpu_device *gpu, 
                              const void *commands, size_t size,
                              uint64_t *fence_out)
{
    unsigned long flags;
    uint32_t available_space;
    uint64_t fence;
    
    if (size > gpu->command_ring.ring_size / 2) {
        return -EINVAL;
    }
    
    spin_lock_irqsave(&gpu->command_ring.lock, flags);
    
    // Calculate available space
    if (gpu->command_ring.tail >= gpu->command_ring.head) {
        available_space = gpu->command_ring.ring_size - 
                         (gpu->command_ring.tail - gpu->command_ring.head);
    } else {
        available_space = gpu->command_ring.head - gpu->command_ring.tail;
    }
    
    if (available_space < size + 16) { // Need space for fence command
        spin_unlock_irqrestore(&gpu->command_ring.lock, flags);
        return -ENOSPC;
    }
    
    // Copy commands to ring buffer
    if (gpu->command_ring.tail + size <= gpu->command_ring.ring_size) {
        memcpy((char*)gpu->command_ring.ring_buffer + gpu->command_ring.tail,
               commands, size);
    } else {
        // Handle wrap-around
        size_t first_part = gpu->command_ring.ring_size - gpu->command_ring.tail;
        memcpy((char*)gpu->command_ring.ring_buffer + gpu->command_ring.tail,
               commands, first_part);
        memcpy(gpu->command_ring.ring_buffer, 
               (char*)commands + first_part, size - first_part);
    }
    
    gpu->command_ring.tail = (gpu->command_ring.tail + size) % 
                            gpu->command_ring.ring_size;
    
    // Add fence command
    fence = ++gpu->command_ring.current_fence;
    *fence_out = fence;
    
    // Update tail pointer in hardware
    gpu_write(gpu, GPU_COMMAND_RING_REG + 8, gpu->command_ring.tail);
    
    atomic64_inc(&gpu->stats.commands_submitted);
    
    spin_unlock_irqrestore(&gpu->command_ring.lock, flags);
    
    return 0;
}

static bool command_ring_fence_signaled(struct advanced_gpu_device *gpu, uint64_t fence)
{
    return gpu->command_ring.last_fence >= fence;
}

static int command_ring_wait_fence(struct advanced_gpu_device *gpu, uint64_t fence,
                                  long timeout_jiffies)
{
    return wait_event_timeout(gpu->command_ring.fence_queue,
                             command_ring_fence_signaled(gpu, fence),
                             timeout_jiffies);
}

// Interrupt handler
static irqreturn_t advanced_gpu_irq_handler(int irq, void *data)
{
    struct advanced_gpu_device *gpu = data;
    uint32_t status;
    bool handled = false;
    
    spin_lock(&gpu->irq_lock);
    
    status = gpu_read(gpu, GPU_INTERRUPT_REG);
    if (status == 0) {
        spin_unlock(&gpu->irq_lock);
        return IRQ_NONE;
    }
    
    atomic64_inc(&gpu->stats.interrupts_handled);
    
    // Command completion interrupt
    if (status & 0x1) {
        uint64_t completed_fence = gpu_read(gpu, GPU_FENCE_REG);
        if (completed_fence > gpu->command_ring.last_fence) {
            gpu->command_ring.last_fence = completed_fence;
            wake_up_all(&gpu->command_ring.fence_queue);
            atomic64_inc(&gpu->stats.commands_completed);
        }
        handled = true;
    }
    
    // Page fault interrupt
    if (status & 0x2) {
        uint64_t fault_addr = gpu_read(gpu, GPU_INTERRUPT_REG + 4);
        dev_warn(&gpu->pdev->dev, "GPU page fault at 0x%llx\n", fault_addr);
        atomic64_inc(&gpu->stats.page_faults);
        handled = true;
    }
    
    // Display interrupt (vblank, hotplug)
    if (status & 0x4) {
        drm_crtc_handle_vblank(&gpu->drm.mode_config.crtc_list);
        handled = true;
    }
    
    // Clear handled interrupts
    gpu_write(gpu, GPU_INTERRUPT_REG, status);
    
    spin_unlock(&gpu->irq_lock);
    
    return handled ? IRQ_HANDLED : IRQ_NONE;
}

// GEM object operations
static struct advanced_gpu_gem_object *
advanced_gpu_gem_create_object(struct drm_device *dev, size_t size)
{
    struct advanced_gpu_device *gpu = to_advanced_gpu_device(dev);
    struct advanced_gpu_gem_object *obj;
    int ret;
    
    obj = kzalloc(sizeof(*obj), GFP_KERNEL);
    if (!obj)
        return ERR_PTR(-ENOMEM);
    
    ret = drm_gem_object_init(dev, &obj->base, size);
    if (ret) {
        kfree(obj);
        return ERR_PTR(ret);
    }
    
    // Allocate DMA memory
    obj->cpu_addr = dma_alloc_coherent(&gpu->pdev->dev, size,
                                      &obj->dma_addr, GFP_KERNEL);
    if (!obj->cpu_addr) {
        drm_gem_object_release(&obj->base);
        kfree(obj);
        return ERR_PTR(-ENOMEM);
    }
    
    obj->coherent = true;
    obj->cached = false;
    obj->mapped_to_gpu = false;
    
    atomic64_add(size, &gpu->stats.memory_allocated);
    
    return obj;
}

static void advanced_gpu_gem_free_object(struct drm_gem_object *gem_obj)
{
    struct advanced_gpu_gem_object *obj = to_advanced_gpu_gem_object(gem_obj);
    struct advanced_gpu_device *gpu = to_advanced_gpu_device(gem_obj->dev);
    
    if (obj->fence) {
        dma_fence_wait(obj->fence, false);
        dma_fence_put(obj->fence);
    }
    
    if (obj->cpu_addr) {
        dma_free_coherent(&gpu->pdev->dev, gem_obj->size,
                         obj->cpu_addr, obj->dma_addr);
        atomic64_sub(gem_obj->size, &gpu->stats.memory_allocated);
    }
    
    drm_gem_object_release(gem_obj);
    kfree(obj);
}

static int advanced_gpu_gem_mmap(struct drm_gem_object *gem_obj,
                                struct vm_area_struct *vma)
{
    struct advanced_gpu_gem_object *obj = to_advanced_gpu_gem_object(gem_obj);
    
    if (!obj->coherent) {
        vma->vm_page_prot = pgprot_writecombine(vma->vm_page_prot);
    }
    
    return dma_mmap_coherent(gem_obj->dev->dev, vma, obj->cpu_addr,
                           obj->dma_addr, gem_obj->size);
}

static const struct drm_gem_object_funcs advanced_gpu_gem_object_funcs = {
    .free = advanced_gpu_gem_free_object,
    .mmap = advanced_gpu_gem_mmap,
};

// CRTC operations
static void advanced_gpu_crtc_enable(struct drm_crtc *crtc,
                                    struct drm_atomic_state *state)
{
    struct advanced_gpu_crtc *gpu_crtc = to_advanced_gpu_crtc(crtc);
    struct advanced_gpu_device *gpu = gpu_crtc->gpu;
    
    // Enable CRTC in hardware
    gpu_write(gpu, gpu_crtc->control_reg, 0x80000001); // Enable bit
    gpu_crtc->enabled = true;
    
    drm_crtc_vblank_on(crtc);
}

static void advanced_gpu_crtc_disable(struct drm_crtc *crtc,
                                     struct drm_atomic_state *state)
{
    struct advanced_gpu_crtc *gpu_crtc = to_advanced_gpu_crtc(crtc);
    struct advanced_gpu_device *gpu = gpu_crtc->gpu;
    
    drm_crtc_vblank_off(crtc);
    
    // Disable CRTC in hardware
    gpu_write(gpu, gpu_crtc->control_reg, 0x00000000);
    gpu_crtc->enabled = false;
}

static void advanced_gpu_crtc_mode_set_nofb(struct drm_crtc *crtc)
{
    struct advanced_gpu_crtc *gpu_crtc = to_advanced_gpu_crtc(crtc);
    struct advanced_gpu_device *gpu = gpu_crtc->gpu;
    struct drm_display_mode *mode = &crtc->state->adjusted_mode;
    uint32_t timing_value;
    
    // Program display timing
    timing_value = ((mode->hdisplay - 1) << 16) | (mode->vdisplay - 1);
    gpu_write(gpu, gpu_crtc->timing_reg, timing_value);
    
    timing_value = ((mode->htotal - 1) << 16) | (mode->vtotal - 1);
    gpu_write(gpu, gpu_crtc->timing_reg + 4, timing_value);
    
    timing_value = ((mode->hsync_start - 1) << 16) | (mode->vsync_start - 1);
    gpu_write(gpu, gpu_crtc->timing_reg + 8, timing_value);
    
    timing_value = ((mode->hsync_end - 1) << 16) | (mode->vsync_end - 1);
    gpu_write(gpu, gpu_crtc->timing_reg + 12, timing_value);
    
    gpu_crtc->current_mode = *mode;
}

static void advanced_gpu_crtc_atomic_update(struct drm_crtc *crtc,
                                           struct drm_atomic_state *state)
{
    struct advanced_gpu_crtc *gpu_crtc = to_advanced_gpu_crtc(crtc);
    struct advanced_gpu_device *gpu = gpu_crtc->gpu;
    struct drm_framebuffer *fb = crtc->primary->state->fb;
    
    if (fb) {
        struct advanced_gpu_gem_object *obj = 
            to_advanced_gpu_gem_object(fb->obj[0]);
        
        // Program framebuffer address
        gpu_write(gpu, gpu_crtc->address_reg, obj->dma_addr);
        
        // Program format
        uint32_t format_reg = 0;
        switch (fb->format->format) {
        case DRM_FORMAT_XRGB8888:
            format_reg = 0x1;
            break;
        case DRM_FORMAT_RGB565:
            format_reg = 0x2;
            break;
        default:
            format_reg = 0x1;
            break;
        }
        gpu_write(gpu, gpu_crtc->format_reg, format_reg);
        
        gpu_crtc->fb = fb;
    }
}

static const struct drm_crtc_helper_funcs advanced_gpu_crtc_helper_funcs = {
    .atomic_enable = advanced_gpu_crtc_enable,
    .atomic_disable = advanced_gpu_crtc_disable,
    .mode_set_nofb = advanced_gpu_crtc_mode_set_nofb,
    .atomic_update = advanced_gpu_crtc_atomic_update,
};

static const struct drm_crtc_funcs advanced_gpu_crtc_funcs = {
    .reset = drm_atomic_helper_crtc_reset,
    .destroy = drm_crtc_cleanup,
    .set_config = drm_atomic_helper_set_config,
    .page_flip = drm_atomic_helper_page_flip,
    .atomic_duplicate_state = drm_atomic_helper_crtc_duplicate_state,
    .atomic_destroy_state = drm_atomic_helper_crtc_destroy_state,
    .enable_vblank = drm_crtc_vblank_helper_enable_vblank,
    .disable_vblank = drm_crtc_vblank_helper_disable_vblank,
};

// Encoder operations
static void advanced_gpu_encoder_enable(struct drm_encoder *encoder,
                                       struct drm_atomic_state *state)
{
    struct advanced_gpu_encoder *gpu_encoder = to_advanced_gpu_encoder(encoder);
    struct advanced_gpu_device *gpu = gpu_encoder->gpu;
    
    // Enable encoder in hardware
    gpu_write(gpu, gpu_encoder->control_reg, 0x80000001);
}

static void advanced_gpu_encoder_disable(struct drm_encoder *encoder,
                                        struct drm_atomic_state *state)
{
    struct advanced_gpu_encoder *gpu_encoder = to_advanced_gpu_encoder(encoder);
    struct advanced_gpu_device *gpu = gpu_encoder->gpu;
    
    // Disable encoder in hardware
    gpu_write(gpu, gpu_encoder->control_reg, 0x00000000);
}

static const struct drm_encoder_helper_funcs advanced_gpu_encoder_helper_funcs = {
    .atomic_enable = advanced_gpu_encoder_enable,
    .atomic_disable = advanced_gpu_encoder_disable,
};

static const struct drm_encoder_funcs advanced_gpu_encoder_funcs = {
    .reset = drm_atomic_helper_encoder_reset,
    .destroy = drm_encoder_cleanup,
    .atomic_duplicate_state = drm_atomic_helper_encoder_duplicate_state,
    .atomic_destroy_state = drm_atomic_helper_encoder_destroy_state,
};

// Connector operations
static enum drm_connector_status
advanced_gpu_connector_detect(struct drm_connector *connector, bool force)
{
    struct advanced_gpu_connector *gpu_connector = 
        to_advanced_gpu_connector(connector);
    
    // Read hotplug status from hardware
    if (gpu_connector->hotplug_detect) {
        return connector_status_connected;
    }
    
    return connector_status_disconnected;
}

static int advanced_gpu_connector_get_modes(struct drm_connector *connector)
{
    struct advanced_gpu_connector *gpu_connector = 
        to_advanced_gpu_connector(connector);
    struct edid *edid;
    int count = 0;
    
    if (gpu_connector->ddc) {
        edid = drm_get_edid(connector, gpu_connector->ddc);
        if (edid) {
            drm_connector_update_edid_property(connector, edid);
            count = drm_add_edid_modes(connector, edid);
            kfree(edid);
        }
    }
    
    if (count == 0) {
        // Add fallback modes
        count = drm_add_modes_noedid(connector, 1920, 1080);
        drm_set_preferred_mode(connector, 1920, 1080);
    }
    
    return count;
}

static const struct drm_connector_helper_funcs advanced_gpu_connector_helper_funcs = {
    .get_modes = advanced_gpu_connector_get_modes,
};

static const struct drm_connector_funcs advanced_gpu_connector_funcs = {
    .detect = advanced_gpu_connector_detect,
    .reset = drm_atomic_helper_connector_reset,
    .fill_modes = drm_helper_probe_single_connector_modes,
    .destroy = drm_connector_cleanup,
    .atomic_duplicate_state = drm_atomic_helper_connector_duplicate_state,
    .atomic_destroy_state = drm_atomic_helper_connector_destroy_state,
};

// Plane operations
static void advanced_gpu_plane_atomic_update(struct drm_plane *plane,
                                            struct drm_atomic_state *state)
{
    struct advanced_gpu_plane *gpu_plane = to_advanced_gpu_plane(plane);
    struct advanced_gpu_device *gpu = gpu_plane->gpu;
    struct drm_plane_state *new_state = drm_atomic_get_new_plane_state(state, plane);
    
    if (new_state->fb) {
        struct advanced_gpu_gem_object *obj = 
            to_advanced_gpu_gem_object(new_state->fb->obj[0]);
        uint32_t plane_base = PLANE_BASE_REG(gpu_plane->index);
        
        // Program plane address and format
        gpu_write(gpu, plane_base, obj->dma_addr);
        gpu_write(gpu, plane_base + 4, new_state->crtc_x);
        gpu_write(gpu, plane_base + 8, new_state->crtc_y);
        gpu_write(gpu, plane_base + 12, new_state->crtc_w);
        gpu_write(gpu, plane_base + 16, new_state->crtc_h);
        gpu_write(gpu, plane_base + 20, 0x80000001); // Enable
    }
}

static void advanced_gpu_plane_atomic_disable(struct drm_plane *plane,
                                             struct drm_atomic_state *state)
{
    struct advanced_gpu_plane *gpu_plane = to_advanced_gpu_plane(plane);
    struct advanced_gpu_device *gpu = gpu_plane->gpu;
    uint32_t plane_base = PLANE_BASE_REG(gpu_plane->index);
    
    // Disable plane
    gpu_write(gpu, plane_base + 20, 0x00000000);
}

static const struct drm_plane_helper_funcs advanced_gpu_plane_helper_funcs = {
    .atomic_update = advanced_gpu_plane_atomic_update,
    .atomic_disable = advanced_gpu_plane_atomic_disable,
};

static const struct drm_plane_funcs advanced_gpu_plane_funcs = {
    .update_plane = drm_atomic_helper_update_plane,
    .disable_plane = drm_atomic_helper_disable_plane,
    .reset = drm_atomic_helper_plane_reset,
    .destroy = drm_plane_cleanup,
    .atomic_duplicate_state = drm_atomic_helper_plane_duplicate_state,
    .atomic_destroy_state = drm_atomic_helper_plane_destroy_state,
};

// Mode config functions
static struct drm_framebuffer *
advanced_gpu_mode_config_fb_create(struct drm_device *dev,
                                  struct drm_file *file,
                                  const struct drm_mode_fb_cmd2 *mode_cmd)
{
    return drm_gem_fb_create(dev, file, mode_cmd);
}

static const struct drm_mode_config_funcs advanced_gpu_mode_config_funcs = {
    .fb_create = advanced_gpu_mode_config_fb_create,
    .atomic_check = drm_atomic_helper_check,
    .atomic_commit = drm_atomic_helper_commit,
};

// Custom IOCTL definitions
#define DRM_ADVANCED_GPU_GEM_CREATE 0x00
#define DRM_ADVANCED_GPU_GEM_MMAP 0x01
#define DRM_ADVANCED_GPU_SUBMIT_COMMAND 0x02

#define DRM_IOCTL_ADVANCED_GPU_GEM_CREATE \
    DRM_IOWR(DRM_COMMAND_BASE + DRM_ADVANCED_GPU_GEM_CREATE, \
             struct drm_advanced_gpu_gem_create)

#define DRM_IOCTL_ADVANCED_GPU_GEM_MMAP \
    DRM_IOWR(DRM_COMMAND_BASE + DRM_ADVANCED_GPU_GEM_MMAP, \
             struct drm_advanced_gpu_gem_mmap)

#define DRM_IOCTL_ADVANCED_GPU_SUBMIT_COMMAND \
    DRM_IOW(DRM_COMMAND_BASE + DRM_ADVANCED_GPU_SUBMIT_COMMAND, \
            struct drm_advanced_gpu_submit_command)

struct drm_advanced_gpu_gem_create {
    uint64_t size;
    uint32_t flags;
    uint32_t handle;
};

struct drm_advanced_gpu_gem_mmap {
    uint32_t handle;
    uint32_t pad;
    uint64_t offset;
};

struct drm_advanced_gpu_submit_command {
    uint64_t commands_ptr;
    uint64_t commands_size;
    uint64_t fence;
};

// IOCTL implementations
static int advanced_gpu_gem_create_ioctl(struct drm_device *dev, void *data,
                                        struct drm_file *file)
{
    struct drm_advanced_gpu_gem_create *args = data;
    struct advanced_gpu_gem_object *obj;
    int ret;
    
    if (args->size == 0 || args->size > SZ_1G)
        return -EINVAL;
    
    args->size = PAGE_ALIGN(args->size);
    
    obj = advanced_gpu_gem_create_object(dev, args->size);
    if (IS_ERR(obj))
        return PTR_ERR(obj);
    
    ret = drm_gem_handle_create(file, &obj->base, &args->handle);
    drm_gem_object_put(&obj->base);
    
    return ret;
}

static int advanced_gpu_gem_mmap_ioctl(struct drm_device *dev, void *data,
                                      struct drm_file *file)
{
    struct drm_advanced_gpu_gem_mmap *args = data;
    
    return drm_gem_mmap_offset(file, dev, args->handle, &args->offset);
}

static int advanced_gpu_submit_command_ioctl(struct drm_device *dev, void *data,
                                            struct drm_file *file)
{
    struct advanced_gpu_device *gpu = to_advanced_gpu_device(dev);
    struct drm_advanced_gpu_submit_command *args = data;
    void *commands;
    int ret;
    
    if (args->commands_size == 0 || args->commands_size > PAGE_SIZE)
        return -EINVAL;
    
    commands = kmalloc(args->commands_size, GFP_KERNEL);
    if (!commands)
        return -ENOMEM;
    
    if (copy_from_user(commands, u64_to_user_ptr(args->commands_ptr),
                       args->commands_size)) {
        kfree(commands);
        return -EFAULT;
    }
    
    ret = command_ring_submit(gpu, commands, args->commands_size, &args->fence);
    
    kfree(commands);
    return ret;
}

// DRM driver IOCTL table
static const struct drm_ioctl_desc advanced_gpu_ioctls[] = {
    DRM_IOCTL_DEF_DRV(ADVANCED_GPU_GEM_CREATE, advanced_gpu_gem_create_ioctl,
                      DRM_RENDER_ALLOW),
    DRM_IOCTL_DEF_DRV(ADVANCED_GPU_GEM_MMAP, advanced_gpu_gem_mmap_ioctl,
                      DRM_RENDER_ALLOW),
    DRM_IOCTL_DEF_DRV(ADVANCED_GPU_SUBMIT_COMMAND, advanced_gpu_submit_command_ioctl,
                      DRM_RENDER_ALLOW),
};

// DRM driver operations
static int advanced_gpu_open(struct drm_device *dev, struct drm_file *file)
{
    struct advanced_gpu_device *gpu = to_advanced_gpu_device(dev);
    
    pm_runtime_get_sync(&gpu->pdev->dev);
    
    return 0;
}

static void advanced_gpu_postclose(struct drm_device *dev, struct drm_file *file)
{
    struct advanced_gpu_device *gpu = to_advanced_gpu_device(dev);
    
    pm_runtime_put(&gpu->pdev->dev);
}

static const struct drm_driver advanced_gpu_driver = {
    .driver_features = DRIVER_GEM | DRIVER_MODESET | DRIVER_ATOMIC | 
                      DRIVER_RENDER,
    
    .open = advanced_gpu_open,
    .postclose = advanced_gpu_postclose,
    
    .ioctls = advanced_gpu_ioctls,
    .num_ioctls = ARRAY_SIZE(advanced_gpu_ioctls),
    
    .fops = &advanced_gpu_fops,
    
    .name = DRIVER_NAME,
    .desc = DRIVER_DESC,
    .date = DRIVER_DATE,
    .major = DRIVER_MAJOR,
    .minor = DRIVER_MINOR,
};

static const struct file_operations advanced_gpu_fops = {
    .owner = THIS_MODULE,
    .open = drm_open,
    .release = drm_release,
    .unlocked_ioctl = drm_ioctl,
    .compat_ioctl = drm_compat_ioctl,
    .poll = drm_poll,
    .read = drm_read,
    .mmap = drm_gem_mmap,
};

// Power management
static int advanced_gpu_runtime_suspend(struct device *dev)
{
    struct advanced_gpu_device *gpu = dev_get_drvdata(dev);
    
    // Save GPU state and power down
    gpu_write(gpu, GPU_CONTROL_REG, 0x00000000); // Power down
    
    return 0;
}

static int advanced_gpu_runtime_resume(struct device *dev)
{
    struct advanced_gpu_device *gpu = dev_get_drvdata(dev);
    
    // Power up and restore GPU state
    gpu_write(gpu, GPU_CONTROL_REG, 0x80000001); // Power up
    
    // Reinitialize command ring
    gpu_write(gpu, GPU_COMMAND_RING_REG, gpu->command_ring.ring_dma);
    gpu_write(gpu, GPU_COMMAND_RING_REG + 4, gpu->command_ring.ring_size);
    
    return 0;
}

static const struct dev_pm_ops advanced_gpu_pm_ops = {
    .runtime_suspend = advanced_gpu_runtime_suspend,
    .runtime_resume = advanced_gpu_runtime_resume,
};

// Hardware initialization
static int advanced_gpu_hw_init(struct advanced_gpu_device *gpu)
{
    uint32_t status;
    int timeout = 1000;
    
    // Reset GPU
    gpu_write(gpu, GPU_CONTROL_REG, 0x80000000); // Reset bit
    msleep(10);
    gpu_write(gpu, GPU_CONTROL_REG, 0x00000000);
    
    // Wait for reset completion
    while (timeout-- > 0) {
        status = gpu_read(gpu, GPU_STATUS_REG);
        if (!(status & 0x80000000)) // Reset complete
            break;
        msleep(1);
    }
    
    if (timeout <= 0) {
        dev_err(&gpu->pdev->dev, "GPU reset timeout\n");
        return -ENODEV;
    }
    
    // Initialize GPU
    gpu_write(gpu, GPU_CONTROL_REG, 0x00000001); // Enable GPU
    gpu_write(gpu, GPU_MEMORY_BASE_REG, gpu->vram_base);
    
    // Enable interrupts
    gpu_write(gpu, GPU_INTERRUPT_REG, 0x00000007); // Enable all interrupts
    
    return 0;
}

// Display pipeline initialization
static int advanced_gpu_display_init(struct advanced_gpu_device *gpu)
{
    struct drm_device *dev = &gpu->drm;
    struct advanced_gpu_crtc *crtc;
    struct advanced_gpu_encoder *encoder;
    struct advanced_gpu_connector *connector;
    struct advanced_gpu_plane *plane;
    int i, ret;
    
    drm_mode_config_init(dev);
    
    dev->mode_config.min_width = 640;
    dev->mode_config.min_height = 480;
    dev->mode_config.max_width = 4096;
    dev->mode_config.max_height = 4096;
    dev->mode_config.funcs = &advanced_gpu_mode_config_funcs;
    
    // Create planes
    for (i = 0; i < 4; i++) {
        plane = kzalloc(sizeof(*plane), GFP_KERNEL);
        if (!plane)
            return -ENOMEM;
        
        plane->gpu = gpu;
        plane->index = i;
        plane->supported_formats[0] = DRM_FORMAT_XRGB8888;
        plane->supported_formats[1] = DRM_FORMAT_RGB565;
        plane->num_formats = 2;
        
        ret = drm_universal_plane_init(dev, &plane->base, 0,
                                      &advanced_gpu_plane_funcs,
                                      plane->supported_formats,
                                      plane->num_formats,
                                      NULL,
                                      i == 0 ? DRM_PLANE_TYPE_PRIMARY :
                                               DRM_PLANE_TYPE_OVERLAY,
                                      NULL);
        if (ret) {
            kfree(plane);
            return ret;
        }
        
        drm_plane_helper_add(&plane->base, &advanced_gpu_plane_helper_funcs);
    }
    
    // Create CRTCs
    for (i = 0; i < 2; i++) {
        crtc = kzalloc(sizeof(*crtc), GFP_KERNEL);
        if (!crtc)
            return -ENOMEM;
        
        crtc->gpu = gpu;
        crtc->index = i;
        crtc->control_reg = CRTC_BASE_REG(i);
        crtc->timing_reg = CRTC_BASE_REG(i) + 0x10;
        crtc->format_reg = CRTC_BASE_REG(i) + 0x20;
        crtc->address_reg = CRTC_BASE_REG(i) + 0x30;
        
        ret = drm_crtc_init_with_planes(dev, &crtc->base,
                                       &gpu->drm.mode_config.plane_list,
                                       NULL, &advanced_gpu_crtc_funcs, NULL);
        if (ret) {
            kfree(crtc);
            return ret;
        }
        
        drm_crtc_helper_add(&crtc->base, &advanced_gpu_crtc_helper_funcs);
        drm_crtc_enable_color_mgmt(&crtc->base, 0, false, 256);
    }
    
    // Create encoders
    for (i = 0; i < 2; i++) {
        encoder = kzalloc(sizeof(*encoder), GFP_KERNEL);
        if (!encoder)
            return -ENOMEM;
        
        encoder->gpu = gpu;
        encoder->index = i;
        encoder->type = DRM_MODE_ENCODER_DAC;
        encoder->possible_crtcs = 0x3; // Can connect to both CRTCs
        encoder->control_reg = ENCODER_BASE_REG(i);
        encoder->config_reg = ENCODER_BASE_REG(i) + 0x10;
        
        ret = drm_encoder_init(dev, &encoder->base, &advanced_gpu_encoder_funcs,
                              encoder->type, NULL);
        if (ret) {
            kfree(encoder);
            return ret;
        }
        
        drm_encoder_helper_add(&encoder->base, &advanced_gpu_encoder_helper_funcs);
    }
    
    // Create connectors
    for (i = 0; i < 2; i++) {
        connector = kzalloc(sizeof(*connector), GFP_KERNEL);
        if (!connector)
            return -ENOMEM;
        
        connector->gpu = gpu;
        connector->index = i;
        connector->hotplug_detect = true; // Assume connected for demo
        
        ret = drm_connector_init(dev, &connector->base,
                                &advanced_gpu_connector_funcs,
                                DRM_MODE_CONNECTOR_VGA);
        if (ret) {
            kfree(connector);
            return ret;
        }
        
        drm_connector_helper_add(&connector->base,
                                &advanced_gpu_connector_helper_funcs);
        
        // Attach connector to encoder
        ret = drm_connector_attach_encoder(&connector->base,
                                          &encoder->base);
        if (ret)
            return ret;
    }
    
    drm_mode_config_reset(dev);
    
    return 0;
}

// PCI probe function
static int advanced_gpu_probe(struct pci_dev *pdev, const struct pci_device_id *id)
{
    struct advanced_gpu_device *gpu;
    struct drm_device *dev;
    int ret;
    
    // Enable PCI device
    ret = pci_enable_device(pdev);
    if (ret)
        return ret;
    
    ret = pci_set_dma_mask(pdev, DMA_BIT_MASK(64));
    if (ret) {
        ret = pci_set_dma_mask(pdev, DMA_BIT_MASK(32));
        if (ret) {
            dev_err(&pdev->dev, "Failed to set DMA mask\n");
            goto err_disable_device;
        }
    }
    
    pci_set_master(pdev);
    
    // Allocate and initialize GPU device
    gpu = devm_drm_dev_alloc(&pdev->dev, &advanced_gpu_driver,
                            struct advanced_gpu_device, drm);
    if (IS_ERR(gpu)) {
        ret = PTR_ERR(gpu);
        goto err_disable_device;
    }
    
    dev = &gpu->drm;
    gpu->pdev = pdev;
    pci_set_drvdata(pdev, gpu);
    
    // Map MMIO regions
    ret = pci_request_regions(pdev, DRIVER_NAME);
    if (ret)
        goto err_disable_device;
    
    gpu->mmio_base = pci_iomap(pdev, 0, 0);
    if (!gpu->mmio_base) {
        ret = -ENOMEM;
        goto err_release_regions;
    }
    
    gpu->mmio_size = pci_resource_len(pdev, 0);
    
    // Allocate VRAM
    gpu->vram_size = 256 * 1024 * 1024; // 256MB
    gpu->vram_cpu_addr = dma_alloc_coherent(&pdev->dev, gpu->vram_size,
                                           &gpu->vram_base, GFP_KERNEL);
    if (!gpu->vram_cpu_addr) {
        ret = -ENOMEM;
        goto err_unmap_mmio;
    }
    
    // Initialize hardware
    ret = advanced_gpu_hw_init(gpu);
    if (ret)
        goto err_free_vram;
    
    // Initialize command ring
    ret = command_ring_init(gpu);
    if (ret)
        goto err_free_vram;
    
    // Setup interrupt handling
    spin_lock_init(&gpu->irq_lock);
    gpu->irq = pdev->irq;
    
    ret = request_irq(gpu->irq, advanced_gpu_irq_handler,
                     IRQF_SHARED, DRIVER_NAME, gpu);
    if (ret)
        goto err_cleanup_command_ring;
    
    gpu->irq_enabled = true;
    
    // Initialize performance counters
    atomic64_set(&gpu->stats.commands_submitted, 0);
    atomic64_set(&gpu->stats.commands_completed, 0);
    atomic64_set(&gpu->stats.interrupts_handled, 0);
    atomic64_set(&gpu->stats.page_faults, 0);
    atomic64_set(&gpu->stats.memory_allocated, 0);
    
    // Initialize display pipeline
    ret = advanced_gpu_display_init(gpu);
    if (ret)
        goto err_free_irq;
    
    // Enable runtime PM
    pm_runtime_use_autosuspend(&pdev->dev);
    pm_runtime_set_autosuspend_delay(&pdev->dev, 1000);
    pm_runtime_set_active(&pdev->dev);
    pm_runtime_enable(&pdev->dev);
    gpu->pm.runtime_pm_enabled = true;
    
    // Register DRM device
    ret = drm_dev_register(dev, 0);
    if (ret)
        goto err_cleanup_display;
    
    dev_info(&pdev->dev, "Advanced GPU initialized successfully\n");
    
    return 0;
    
err_cleanup_display:
    drm_mode_config_cleanup(dev);
err_free_irq:
    if (gpu->irq_enabled) {
        free_irq(gpu->irq, gpu);
    }
err_cleanup_command_ring:
    command_ring_cleanup(gpu);
err_free_vram:
    if (gpu->vram_cpu_addr) {
        dma_free_coherent(&pdev->dev, gpu->vram_size,
                         gpu->vram_cpu_addr, gpu->vram_base);
    }
err_unmap_mmio:
    pci_iounmap(pdev, gpu->mmio_base);
err_release_regions:
    pci_release_regions(pdev);
err_disable_device:
    pci_disable_device(pdev);
    
    return ret;
}

static void advanced_gpu_remove(struct pci_dev *pdev)
{
    struct advanced_gpu_device *gpu = pci_get_drvdata(pdev);
    struct drm_device *dev = &gpu->drm;
    
    drm_dev_unregister(dev);
    
    if (gpu->pm.runtime_pm_enabled) {
        pm_runtime_disable(&pdev->dev);
    }
    
    drm_mode_config_cleanup(dev);
    
    if (gpu->irq_enabled) {
        free_irq(gpu->irq, gpu);
    }
    
    command_ring_cleanup(gpu);
    
    if (gpu->vram_cpu_addr) {
        dma_free_coherent(&pdev->dev, gpu->vram_size,
                         gpu->vram_cpu_addr, gpu->vram_base);
    }
    
    pci_iounmap(pdev, gpu->mmio_base);
    pci_release_regions(pdev);
    pci_disable_device(pdev);
    
    dev_info(&pdev->dev, "Advanced GPU removed\n");
}

// PCI device table
static const struct pci_device_id advanced_gpu_pci_ids[] = {
    { PCI_DEVICE(0x1234, 0x5678) }, // Example vendor/device ID
    { 0 }
};
MODULE_DEVICE_TABLE(pci, advanced_gpu_pci_ids);

// PCI driver structure
static struct pci_driver advanced_gpu_pci_driver = {
    .name = DRIVER_NAME,
    .id_table = advanced_gpu_pci_ids,
    .probe = advanced_gpu_probe,
    .remove = advanced_gpu_remove,
    .driver.pm = &advanced_gpu_pm_ops,
};

// Helper macros for type conversion
#define to_advanced_gpu_device(dev) \
    container_of(dev, struct advanced_gpu_device, drm)

#define to_advanced_gpu_gem_object(obj) \
    container_of(obj, struct advanced_gpu_gem_object, base)

#define to_advanced_gpu_crtc(crtc) \
    container_of(crtc, struct advanced_gpu_crtc, base)

#define to_advanced_gpu_encoder(encoder) \
    container_of(encoder, struct advanced_gpu_encoder, base)

#define to_advanced_gpu_connector(connector) \
    container_of(connector, struct advanced_gpu_connector, base)

#define to_advanced_gpu_plane(plane) \
    container_of(plane, struct advanced_gpu_plane, base)

// Module initialization
static int __init advanced_gpu_init(void)
{
    return pci_register_driver(&advanced_gpu_pci_driver);
}

static void __exit advanced_gpu_exit(void)
{
    pci_unregister_driver(&advanced_gpu_pci_driver);
}

module_init(advanced_gpu_init);
module_exit(advanced_gpu_exit);

MODULE_AUTHOR("Matthew Mattox <mmattox@support.tools>");
MODULE_DESCRIPTION("Advanced GPU DRM Driver");
MODULE_LICENSE("GPL v2");
MODULE_VERSION("1.0");
```

## Vulkan Graphics Programming Framework

### High-Performance Vulkan Renderer

```c
// vulkan_renderer.c - Advanced Vulkan graphics programming
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include <assert.h>
#include <math.h>
#include <time.h>

#include <vulkan/vulkan.h>
#include <GLFW/glfw3.h>
#include <cglm/cglm.h>

#define GLM_FORCE_RADIANS
#define GLM_FORCE_DEPTH_ZERO_TO_ONE

#define MAX_FRAMES_IN_FLIGHT 2
#define MAX_DESCRIPTOR_SETS 1000
#define MAX_UNIFORM_BUFFERS 100
#define MAX_TEXTURES 1000
#define MAX_VERTICES 1000000
#define MAX_INDICES 3000000

// Vertex structure
typedef struct {
    vec3 position;
    vec3 normal;
    vec2 tex_coord;
    vec3 color;
} vertex_t;

// Uniform buffer objects
typedef struct {
    mat4 model;
    mat4 view;
    mat4 proj;
    vec4 light_pos;
    vec4 view_pos;
} uniform_buffer_object_t;

// Push constants
typedef struct {
    mat4 model;
    uint32_t texture_index;
} push_constants_t;

// Vulkan context structure
typedef struct {
    // Core Vulkan objects
    VkInstance instance;
    VkDebugUtilsMessengerEXT debug_messenger;
    VkSurfaceKHR surface;
    VkPhysicalDevice physical_device;
    VkDevice device;
    VkQueue graphics_queue;
    VkQueue present_queue;
    VkQueue compute_queue;
    VkQueue transfer_queue;
    
    // Queue family indices
    struct {
        uint32_t graphics_family;
        uint32_t present_family;
        uint32_t compute_family;
        uint32_t transfer_family;
        bool graphics_family_found;
        bool present_family_found;
        bool compute_family_found;
        bool transfer_family_found;
    } queue_families;
    
    // Swapchain
    VkSwapchainKHR swapchain;
    VkFormat swapchain_image_format;
    VkExtent2D swapchain_extent;
    VkImage *swapchain_images;
    VkImageView *swapchain_image_views;
    uint32_t swapchain_image_count;
    
    // Render pass and framebuffers
    VkRenderPass render_pass;
    VkFramebuffer *swapchain_framebuffers;
    
    // Depth buffer
    VkImage depth_image;
    VkDeviceMemory depth_image_memory;
    VkImageView depth_image_view;
    VkFormat depth_format;
    
    // Color multisampling
    VkSampleCountFlagBits msaa_samples;
    VkImage color_image;
    VkDeviceMemory color_image_memory;
    VkImageView color_image_view;
    
    // Command pools and buffers
    VkCommandPool graphics_command_pool;
    VkCommandPool transfer_command_pool;
    VkCommandBuffer *command_buffers;
    
    // Synchronization objects
    VkSemaphore *image_available_semaphores;
    VkSemaphore *render_finished_semaphores;
    VkFence *in_flight_fences;
    VkFence *images_in_flight;
    
    // Descriptor sets
    VkDescriptorSetLayout descriptor_set_layout;
    VkDescriptorPool descriptor_pool;
    VkDescriptorSet *descriptor_sets;
    
    // Pipeline layout and graphics pipeline
    VkPipelineLayout pipeline_layout;
    VkPipeline graphics_pipeline;
    VkPipeline wireframe_pipeline;
    VkPipeline compute_pipeline;
    
    // Vertex and index buffers
    VkBuffer vertex_buffer;
    VkDeviceMemory vertex_buffer_memory;
    VkBuffer index_buffer;
    VkDeviceMemory index_buffer_memory;
    VkBuffer staging_buffer;
    VkDeviceMemory staging_buffer_memory;
    
    // Uniform buffers
    VkBuffer *uniform_buffers;
    VkDeviceMemory *uniform_buffers_memory;
    
    // Texture resources
    uint32_t texture_count;
    VkImage *texture_images;
    VkDeviceMemory *texture_image_memories;
    VkImageView *texture_image_views;
    VkSampler texture_sampler;
    
    // Memory allocator
    struct {
        VkDeviceMemory *memory_blocks;
        uint32_t *memory_offsets;
        uint32_t *memory_sizes;
        uint32_t block_count;
        uint32_t total_allocated;
    } memory_allocator;
    
    // Performance metrics
    struct {
        double frame_time;
        double cpu_time;
        double gpu_time;
        uint32_t draw_calls;
        uint32_t vertices_rendered;
        uint32_t triangles_rendered;
        VkQueryPool timestamp_query_pool;
        uint64_t *timestamp_results;
    } performance;
    
    // Rendering state
    uint32_t current_frame;
    bool framebuffer_resized;
    bool wireframe_mode;
    
} vulkan_context_t;

// Mesh structure
typedef struct {
    vertex_t *vertices;
    uint32_t vertex_count;
    uint32_t *indices;
    uint32_t index_count;
    uint32_t texture_index;
    VkBuffer vertex_buffer;
    VkDeviceMemory vertex_buffer_memory;
    VkBuffer index_buffer;
    VkDeviceMemory index_buffer_memory;
} mesh_t;

// Scene object
typedef struct {
    mesh_t mesh;
    mat4 model_matrix;
    uint32_t texture_index;
    bool visible;
} scene_object_t;

// Camera structure
typedef struct {
    vec3 position;
    vec3 front;
    vec3 up;
    vec3 right;
    float yaw;
    float pitch;
    float fov;
    float near_plane;
    float far_plane;
    mat4 view_matrix;
    mat4 projection_matrix;
} camera_t;

static vulkan_context_t vk_ctx = {0};
static GLFWwindow *window = NULL;
static camera_t camera = {0};

// Function prototypes
static int init_vulkan(void);
static void cleanup_vulkan(void);
static int create_instance(void);
static int setup_debug_messenger(void);
static int create_surface(void);
static int pick_physical_device(void);
static int create_logical_device(void);
static int create_swapchain(void);
static int create_image_views(void);
static int create_render_pass(void);
static int create_descriptor_set_layout(void);
static int create_graphics_pipeline(void);
static int create_framebuffers(void);
static int create_command_pool(void);
static int create_depth_resources(void);
static int create_color_resources(void);
static int create_texture_image(const char *filename, uint32_t *texture_index);
static int create_texture_sampler(void);
static int create_vertex_buffer(void);
static int create_index_buffer(void);
static int create_uniform_buffers(void);
static int create_descriptor_pool(void);
static int create_descriptor_sets(void);
static int create_command_buffers(void);
static int create_sync_objects(void);

// Validation layers and extensions
static const char *validation_layers[] = {
    "VK_LAYER_KHRONOS_validation"
};

static const char *device_extensions[] = {
    VK_KHR_SWAPCHAIN_EXTENSION_NAME,
    VK_KHR_MAINTENANCE3_EXTENSION_NAME,
    VK_EXT_DESCRIPTOR_INDEXING_EXTENSION_NAME
};

#ifdef NDEBUG
static const bool enable_validation_layers = false;
#else
static const bool enable_validation_layers = true;
#endif

// Vertex shader source (GLSL)
static const char *vertex_shader_source = R"(
#version 450

layout(binding = 0) uniform UniformBufferObject {
    mat4 model;
    mat4 view;
    mat4 proj;
    vec4 light_pos;
    vec4 view_pos;
} ubo;

layout(push_constant) uniform PushConstants {
    mat4 model;
    uint texture_index;
} pc;

layout(location = 0) in vec3 in_position;
layout(location = 1) in vec3 in_normal;
layout(location = 2) in vec2 in_tex_coord;
layout(location = 3) in vec3 in_color;

layout(location = 0) out vec3 frag_pos;
layout(location = 1) out vec3 frag_normal;
layout(location = 2) out vec2 frag_tex_coord;
layout(location = 3) out vec3 frag_color;
layout(location = 4) out vec3 light_pos;
layout(location = 5) out vec3 view_pos;

void main() {
    vec4 world_pos = pc.model * vec4(in_position, 1.0);
    frag_pos = world_pos.xyz;
    frag_normal = mat3(transpose(inverse(pc.model))) * in_normal;
    frag_tex_coord = in_tex_coord;
    frag_color = in_color;
    light_pos = ubo.light_pos.xyz;
    view_pos = ubo.view_pos.xyz;
    
    gl_Position = ubo.proj * ubo.view * world_pos;
}
)";

// Fragment shader source (GLSL)
static const char *fragment_shader_source = R"(
#version 450

layout(binding = 1) uniform sampler2D tex_samplers[1000];

layout(push_constant) uniform PushConstants {
    mat4 model;
    uint texture_index;
} pc;

layout(location = 0) in vec3 frag_pos;
layout(location = 1) in vec3 frag_normal;
layout(location = 2) in vec2 frag_tex_coord;
layout(location = 3) in vec3 frag_color;
layout(location = 4) in vec3 light_pos;
layout(location = 5) in vec3 view_pos;

layout(location = 0) out vec4 out_color;

void main() {
    // Ambient lighting
    vec3 ambient = 0.15 * frag_color;
    
    // Diffuse lighting
    vec3 norm = normalize(frag_normal);
    vec3 light_dir = normalize(light_pos - frag_pos);
    float diff = max(dot(norm, light_dir), 0.0);
    vec3 diffuse = diff * frag_color;
    
    // Specular lighting
    vec3 view_dir = normalize(view_pos - frag_pos);
    vec3 reflect_dir = reflect(-light_dir, norm);
    float spec = pow(max(dot(view_dir, reflect_dir), 0.0), 64.0);
    vec3 specular = spec * vec3(0.5);
    
    // Texture sampling
    vec4 tex_color = texture(tex_samplers[pc.texture_index], frag_tex_coord);
    
    vec3 result = (ambient + diffuse + specular) * tex_color.rgb;
    out_color = vec4(result, tex_color.a);
}
)";

// Compute shader source for post-processing
static const char *compute_shader_source = R"(
#version 450

layout(local_size_x = 16, local_size_y = 16) in;

layout(binding = 0, rgba8) uniform readonly image2D input_image;
layout(binding = 1, rgba8) uniform writeonly image2D output_image;

layout(push_constant) uniform ComputePushConstants {
    float exposure;
    float gamma;
    int effect_type;
} pc;

vec3 tone_mapping(vec3 color) {
    // Reinhard tone mapping
    return color / (color + vec3(1.0));
}

vec3 gamma_correction(vec3 color) {
    return pow(color, vec3(1.0 / pc.gamma));
}

void main() {
    ivec2 coord = ivec2(gl_GlobalInvocationID.xy);
    ivec2 image_size = imageSize(input_image);
    
    if (coord.x >= image_size.x || coord.y >= image_size.y) {
        return;
    }
    
    vec4 color = imageLoad(input_image, coord);
    
    // Apply exposure
    color.rgb *= pc.exposure;
    
    // Apply tone mapping
    color.rgb = tone_mapping(color.rgb);
    
    // Apply gamma correction
    color.rgb = gamma_correction(color.rgb);
    
    // Apply effects based on type
    if (pc.effect_type == 1) {
        // Grayscale
        float gray = dot(color.rgb, vec3(0.299, 0.587, 0.114));
        color.rgb = vec3(gray);
    } else if (pc.effect_type == 2) {
        // Sepia
        vec3 sepia = vec3(
            dot(color.rgb, vec3(0.393, 0.769, 0.189)),
            dot(color.rgb, vec3(0.349, 0.686, 0.168)),
            dot(color.rgb, vec3(0.272, 0.534, 0.131))
        );
        color.rgb = sepia;
    }
    
    imageStore(output_image, coord, color);
}
)";

// Debug callback
static VKAPI_ATTR VkBool32 VKAPI_CALL debug_callback(
    VkDebugUtilsMessageSeverityFlagBitsEXT message_severity,
    VkDebugUtilsMessageTypeFlagsEXT message_type,
    const VkDebugUtilsMessengerCallbackDataEXT* callback_data,
    void* user_data)
{
    if (message_severity >= VK_DEBUG_UTILS_MESSAGE_SEVERITY_WARNING_BIT_EXT) {
        fprintf(stderr, "Validation layer: %s\n", callback_data->pMessage);
    }
    
    return VK_FALSE;
}

// Utility functions
static uint32_t find_memory_type(uint32_t type_filter, VkMemoryPropertyFlags properties)
{
    VkPhysicalDeviceMemoryProperties mem_properties;
    vkGetPhysicalDeviceMemoryProperties(vk_ctx.physical_device, &mem_properties);
    
    for (uint32_t i = 0; i < mem_properties.memoryTypeCount; i++) {
        if ((type_filter & (1 << i)) && 
            (mem_properties.memoryTypes[i].propertyFlags & properties) == properties) {
            return i;
        }
    }
    
    return UINT32_MAX;
}

static VkFormat find_supported_format(const VkFormat *candidates, uint32_t candidate_count,
                                     VkImageTiling tiling, VkFormatFeatureFlags features)
{
    for (uint32_t i = 0; i < candidate_count; i++) {
        VkFormatProperties props;
        vkGetPhysicalDeviceFormatProperties(vk_ctx.physical_device, candidates[i], &props);
        
        if (tiling == VK_IMAGE_TILING_LINEAR && 
            (props.linearTilingFeatures & features) == features) {
            return candidates[i];
        } else if (tiling == VK_IMAGE_TILING_OPTIMAL && 
                   (props.optimalTilingFeatures & features) == features) {
            return candidates[i];
        }
    }
    
    return VK_FORMAT_UNDEFINED;
}

static VkFormat find_depth_format(void)
{
    VkFormat candidates[] = {
        VK_FORMAT_D32_SFLOAT,
        VK_FORMAT_D32_SFLOAT_S8_UINT,
        VK_FORMAT_D24_UNORM_S8_UINT
    };
    
    return find_supported_format(candidates, 3, VK_IMAGE_TILING_OPTIMAL,
                                VK_FORMAT_FEATURE_DEPTH_STENCIL_ATTACHMENT_BIT);
}

static bool has_stencil_component(VkFormat format)
{
    return format == VK_FORMAT_D32_SFLOAT_S8_UINT || 
           format == VK_FORMAT_D24_UNORM_S8_UINT;
}

static VkSampleCountFlagBits get_max_usable_sample_count(void)
{
    VkPhysicalDeviceProperties physical_device_properties;
    vkGetPhysicalDeviceProperties(vk_ctx.physical_device, &physical_device_properties);
    
    VkSampleCountFlags counts = physical_device_properties.limits.framebufferColorSampleCounts &
                               physical_device_properties.limits.framebufferDepthSampleCounts;
    
    if (counts & VK_SAMPLE_COUNT_64_BIT) return VK_SAMPLE_COUNT_64_BIT;
    if (counts & VK_SAMPLE_COUNT_32_BIT) return VK_SAMPLE_COUNT_32_BIT;
    if (counts & VK_SAMPLE_COUNT_16_BIT) return VK_SAMPLE_COUNT_16_BIT;
    if (counts & VK_SAMPLE_COUNT_8_BIT) return VK_SAMPLE_COUNT_8_BIT;
    if (counts & VK_SAMPLE_COUNT_4_BIT) return VK_SAMPLE_COUNT_4_BIT;
    if (counts & VK_SAMPLE_COUNT_2_BIT) return VK_SAMPLE_COUNT_2_BIT;
    
    return VK_SAMPLE_COUNT_1_BIT;
}

// Shader compilation
static VkShaderModule create_shader_module(const char *code, size_t code_size)
{
    VkShaderModuleCreateInfo create_info = {
        .sType = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO,
        .codeSize = code_size,
        .pCode = (const uint32_t*)code
    };
    
    VkShaderModule shader_module;
    if (vkCreateShaderModule(vk_ctx.device, &create_info, NULL, &shader_module) != VK_SUCCESS) {
        return VK_NULL_HANDLE;
    }
    
    return shader_module;
}

// Buffer creation helpers
static int create_buffer(VkDeviceSize size, VkBufferUsageFlags usage,
                        VkMemoryPropertyFlags properties, VkBuffer *buffer,
                        VkDeviceMemory *buffer_memory)
{
    VkBufferCreateInfo buffer_info = {
        .sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO,
        .size = size,
        .usage = usage,
        .sharingMode = VK_SHARING_MODE_EXCLUSIVE
    };
    
    if (vkCreateBuffer(vk_ctx.device, &buffer_info, NULL, buffer) != VK_SUCCESS) {
        return -1;
    }
    
    VkMemoryRequirements mem_requirements;
    vkGetBufferMemoryRequirements(vk_ctx.device, *buffer, &mem_requirements);
    
    VkMemoryAllocateInfo alloc_info = {
        .sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO,
        .allocationSize = mem_requirements.size,
        .memoryTypeIndex = find_memory_type(mem_requirements.memoryTypeBits, properties)
    };
    
    if (vkAllocateMemory(vk_ctx.device, &alloc_info, NULL, buffer_memory) != VK_SUCCESS) {
        vkDestroyBuffer(vk_ctx.device, *buffer, NULL);
        return -1;
    }
    
    vkBindBufferMemory(vk_ctx.device, *buffer, *buffer_memory, 0);
    
    return 0;
}

static void copy_buffer(VkBuffer src_buffer, VkBuffer dst_buffer, VkDeviceSize size)
{
    VkCommandBufferAllocateInfo alloc_info = {
        .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO,
        .level = VK_COMMAND_BUFFER_LEVEL_PRIMARY,
        .commandPool = vk_ctx.transfer_command_pool,
        .commandBufferCount = 1
    };
    
    VkCommandBuffer command_buffer;
    vkAllocateCommandBuffers(vk_ctx.device, &alloc_info, &command_buffer);
    
    VkCommandBufferBeginInfo begin_info = {
        .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO,
        .flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT
    };
    
    vkBeginCommandBuffer(command_buffer, &begin_info);
    
    VkBufferCopy copy_region = {
        .srcOffset = 0,
        .dstOffset = 0,
        .size = size
    };
    vkCmdCopyBuffer(command_buffer, src_buffer, dst_buffer, 1, &copy_region);
    
    vkEndCommandBuffer(command_buffer);
    
    VkSubmitInfo submit_info = {
        .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO,
        .commandBufferCount = 1,
        .pCommandBuffers = &command_buffer
    };
    
    vkQueueSubmit(vk_ctx.transfer_queue, 1, &submit_info, VK_NULL_HANDLE);
    vkQueueWaitIdle(vk_ctx.transfer_queue);
    
    vkFreeCommandBuffers(vk_ctx.device, vk_ctx.transfer_command_pool, 1, &command_buffer);
}

// Image creation helpers
static int create_image(uint32_t width, uint32_t height, uint32_t mip_levels,
                       VkSampleCountFlagBits num_samples, VkFormat format,
                       VkImageTiling tiling, VkImageUsageFlags usage,
                       VkMemoryPropertyFlags properties, VkImage *image,
                       VkDeviceMemory *image_memory)
{
    VkImageCreateInfo image_info = {
        .sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO,
        .imageType = VK_IMAGE_TYPE_2D,
        .extent.width = width,
        .extent.height = height,
        .extent.depth = 1,
        .mipLevels = mip_levels,
        .arrayLayers = 1,
        .format = format,
        .tiling = tiling,
        .initialLayout = VK_IMAGE_LAYOUT_UNDEFINED,
        .usage = usage,
        .samples = num_samples,
        .sharingMode = VK_SHARING_MODE_EXCLUSIVE
    };
    
    if (vkCreateImage(vk_ctx.device, &image_info, NULL, image) != VK_SUCCESS) {
        return -1;
    }
    
    VkMemoryRequirements mem_requirements;
    vkGetImageMemoryRequirements(vk_ctx.device, *image, &mem_requirements);
    
    VkMemoryAllocateInfo alloc_info = {
        .sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO,
        .allocationSize = mem_requirements.size,
        .memoryTypeIndex = find_memory_type(mem_requirements.memoryTypeBits, properties)
    };
    
    if (vkAllocateMemory(vk_ctx.device, &alloc_info, NULL, image_memory) != VK_SUCCESS) {
        vkDestroyImage(vk_ctx.device, *image, NULL);
        return -1;
    }
    
    vkBindImageMemory(vk_ctx.device, *image, *image_memory, 0);
    
    return 0;
}

static VkImageView create_image_view(VkImage image, VkFormat format, 
                                    VkImageAspectFlags aspect_flags, uint32_t mip_levels)
{
    VkImageViewCreateInfo view_info = {
        .sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO,
        .image = image,
        .viewType = VK_IMAGE_VIEW_TYPE_2D,
        .format = format,
        .subresourceRange.aspectMask = aspect_flags,
        .subresourceRange.baseMipLevel = 0,
        .subresourceRange.levelCount = mip_levels,
        .subresourceRange.baseArrayLayer = 0,
        .subresourceRange.layerCount = 1
    };
    
    VkImageView image_view;
    if (vkCreateImageView(vk_ctx.device, &view_info, NULL, &image_view) != VK_SUCCESS) {
        return VK_NULL_HANDLE;
    }
    
    return image_view;
}

// Main rendering functions
static void update_uniform_buffer(uint32_t current_image)
{
    static float time = 0.0f;
    time += 0.016f; // Assume 60 FPS
    
    uniform_buffer_object_t ubo = {0};
    
    // Update camera
    glm_perspective(glm_rad(camera.fov), 
                   (float)vk_ctx.swapchain_extent.width / (float)vk_ctx.swapchain_extent.height,
                   camera.near_plane, camera.far_plane, ubo.proj);
    
    // Vulkan uses different coordinate system than OpenGL
    ubo.proj[1][1] *= -1;
    
    glm_lookat(camera.position, 
               (vec3){camera.position[0] + camera.front[0], 
                      camera.position[1] + camera.front[1], 
                      camera.position[2] + camera.front[2]},
               camera.up, ubo.view);
    
    glm_mat4_identity(ubo.model);
    glm_rotate_y(ubo.model, time * glm_rad(90.0f), ubo.model);
    
    // Light and view positions
    glm_vec3_copy((vec3){2.0f, 2.0f, 2.0f}, ubo.light_pos);
    glm_vec3_copy(camera.position, ubo.view_pos);
    
    void *data;
    vkMapMemory(vk_ctx.device, vk_ctx.uniform_buffers_memory[current_image], 
                0, sizeof(ubo), 0, &data);
    memcpy(data, &ubo, sizeof(ubo));
    vkUnmapMemory(vk_ctx.device, vk_ctx.uniform_buffers_memory[current_image]);
}

static void record_command_buffer(VkCommandBuffer command_buffer, uint32_t image_index)
{
    VkCommandBufferBeginInfo begin_info = {
        .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO,
        .flags = 0,
        .pInheritanceInfo = NULL
    };
    
    if (vkBeginCommandBuffer(command_buffer, &begin_info) != VK_SUCCESS) {
        fprintf(stderr, "Failed to begin recording command buffer\n");
        return;
    }
    
    // Begin render pass
    VkClearValue clear_values[3];
    clear_values[0].color = (VkClearColorValue){{0.0f, 0.0f, 0.0f, 1.0f}};
    clear_values[1].depthStencil = (VkClearDepthStencilValue){1.0f, 0};
    clear_values[2].color = (VkClearColorValue){{0.0f, 0.0f, 0.0f, 1.0f}};
    
    VkRenderPassBeginInfo render_pass_info = {
        .sType = VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO,
        .renderPass = vk_ctx.render_pass,
        .framebuffer = vk_ctx.swapchain_framebuffers[image_index],
        .renderArea.offset = {0, 0},
        .renderArea.extent = vk_ctx.swapchain_extent,
        .clearValueCount = 3,
        .pClearValues = clear_values
    };
    
    vkCmdBeginRenderPass(command_buffer, &render_pass_info, VK_SUBPASS_CONTENTS_INLINE);
    
    // Bind graphics pipeline
    VkPipeline pipeline = vk_ctx.wireframe_mode ? vk_ctx.wireframe_pipeline : 
                                                  vk_ctx.graphics_pipeline;
    vkCmdBindPipeline(command_buffer, VK_PIPELINE_BIND_POINT_GRAPHICS, pipeline);
    
    // Set viewport and scissor
    VkViewport viewport = {
        .x = 0.0f,
        .y = 0.0f,
        .width = (float)vk_ctx.swapchain_extent.width,
        .height = (float)vk_ctx.swapchain_extent.height,
        .minDepth = 0.0f,
        .maxDepth = 1.0f
    };
    vkCmdSetViewport(command_buffer, 0, 1, &viewport);
    
    VkRect2D scissor = {
        .offset = {0, 0},
        .extent = vk_ctx.swapchain_extent
    };
    vkCmdSetScissor(command_buffer, 0, 1, &scissor);
    
    // Bind vertex buffer
    VkBuffer vertex_buffers[] = {vk_ctx.vertex_buffer};
    VkDeviceSize offsets[] = {0};
    vkCmdBindVertexBuffers(command_buffer, 0, 1, vertex_buffers, offsets);
    
    // Bind index buffer
    vkCmdBindIndexBuffer(command_buffer, vk_ctx.index_buffer, 0, VK_INDEX_TYPE_UINT32);
    
    // Bind descriptor sets
    vkCmdBindDescriptorSets(command_buffer, VK_PIPELINE_BIND_POINT_GRAPHICS,
                           vk_ctx.pipeline_layout, 0, 1, 
                           &vk_ctx.descriptor_sets[vk_ctx.current_frame],
                           0, NULL);
    
    // Push constants
    push_constants_t push_constants = {0};
    glm_mat4_identity(push_constants.model);
    push_constants.texture_index = 0;
    
    vkCmdPushConstants(command_buffer, vk_ctx.pipeline_layout,
                      VK_SHADER_STAGE_VERTEX_BIT | VK_SHADER_STAGE_FRAGMENT_BIT,
                      0, sizeof(push_constants), &push_constants);
    
    // Draw indexed
    vkCmdDrawIndexed(command_buffer, 6, 1, 0, 0, 0); // Simple quad
    
    vk_ctx.performance.draw_calls++;
    vk_ctx.performance.vertices_rendered += 4;
    vk_ctx.performance.triangles_rendered += 2;
    
    vkCmdEndRenderPass(command_buffer);
    
    if (vkEndCommandBuffer(command_buffer) != VK_SUCCESS) {
        fprintf(stderr, "Failed to record command buffer\n");
    }
}

static void draw_frame(void)
{
    clock_t start_time = clock();
    
    vkWaitForFences(vk_ctx.device, 1, &vk_ctx.in_flight_fences[vk_ctx.current_frame],
                   VK_TRUE, UINT64_MAX);
    
    uint32_t image_index;
    VkResult result = vkAcquireNextImageKHR(vk_ctx.device, vk_ctx.swapchain, UINT64_MAX,
                                           vk_ctx.image_available_semaphores[vk_ctx.current_frame],
                                           VK_NULL_HANDLE, &image_index);
    
    if (result == VK_ERROR_OUT_OF_DATE_KHR) {
        // Recreate swapchain
        return;
    } else if (result != VK_SUCCESS && result != VK_SUBOPTIMAL_KHR) {
        fprintf(stderr, "Failed to acquire swap chain image\n");
        return;
    }
    
    vkResetFences(vk_ctx.device, 1, &vk_ctx.in_flight_fences[vk_ctx.current_frame]);
    
    vkResetCommandBuffer(vk_ctx.command_buffers[vk_ctx.current_frame], 0);
    record_command_buffer(vk_ctx.command_buffers[vk_ctx.current_frame], image_index);
    
    update_uniform_buffer(vk_ctx.current_frame);
    
    VkSubmitInfo submit_info = {
        .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO,
        .waitSemaphoreCount = 1,
        .pWaitSemaphores = &vk_ctx.image_available_semaphores[vk_ctx.current_frame],
        .pWaitDstStageMask = (VkPipelineStageFlags[]){VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT},
        .commandBufferCount = 1,
        .pCommandBuffers = &vk_ctx.command_buffers[vk_ctx.current_frame],
        .signalSemaphoreCount = 1,
        .pSignalSemaphores = &vk_ctx.render_finished_semaphores[vk_ctx.current_frame]
    };
    
    if (vkQueueSubmit(vk_ctx.graphics_queue, 1, &submit_info, 
                     vk_ctx.in_flight_fences[vk_ctx.current_frame]) != VK_SUCCESS) {
        fprintf(stderr, "Failed to submit draw command buffer\n");
    }
    
    VkPresentInfoKHR present_info = {
        .sType = VK_STRUCTURE_TYPE_PRESENT_INFO_KHR,
        .waitSemaphoreCount = 1,
        .pWaitSemaphores = &vk_ctx.render_finished_semaphores[vk_ctx.current_frame],
        .swapchainCount = 1,
        .pSwapchains = &vk_ctx.swapchain,
        .pImageIndices = &image_index,
        .pResults = NULL
    };
    
    result = vkQueuePresentKHR(vk_ctx.present_queue, &present_info);
    
    if (result == VK_ERROR_OUT_OF_DATE_KHR || result == VK_SUBOPTIMAL_KHR || 
        vk_ctx.framebuffer_resized) {
        vk_ctx.framebuffer_resized = false;
        // Recreate swapchain
    } else if (result != VK_SUCCESS) {
        fprintf(stderr, "Failed to present swap chain image\n");
    }
    
    vk_ctx.current_frame = (vk_ctx.current_frame + 1) % MAX_FRAMES_IN_FLIGHT;
    
    clock_t end_time = clock();
    vk_ctx.performance.frame_time = ((double)(end_time - start_time)) / CLOCKS_PER_SEC * 1000.0;
}

// GLFW callbacks
static void framebuffer_resize_callback(GLFWwindow *window, int width, int height)
{
    vk_ctx.framebuffer_resized = true;
}

static void key_callback(GLFWwindow *window, int key, int scancode, int action, int mods)
{
    if (key == GLFW_KEY_ESCAPE && action == GLFW_PRESS) {
        glfwSetWindowShouldClose(window, GLFW_TRUE);
    }
    
    if (key == GLFW_KEY_F1 && action == GLFW_PRESS) {
        vk_ctx.wireframe_mode = !vk_ctx.wireframe_mode;
    }
    
    const float camera_speed = 0.1f;
    if (key == GLFW_KEY_W && (action == GLFW_PRESS || action == GLFW_REPEAT)) {
        vec3 front_scaled;
        glm_vec3_scale(camera.front, camera_speed, front_scaled);
        glm_vec3_add(camera.position, front_scaled, camera.position);
    }
    if (key == GLFW_KEY_S && (action == GLFW_PRESS || action == GLFW_REPEAT)) {
        vec3 front_scaled;
        glm_vec3_scale(camera.front, camera_speed, front_scaled);
        glm_vec3_sub(camera.position, front_scaled, camera.position);
    }
    if (key == GLFW_KEY_A && (action == GLFW_PRESS || action == GLFW_REPEAT)) {
        vec3 right_scaled;
        glm_vec3_scale(camera.right, camera_speed, right_scaled);
        glm_vec3_sub(camera.position, right_scaled, camera.position);
    }
    if (key == GLFW_KEY_D && (action == GLFW_PRESS || action == GLFW_REPEAT)) {
        vec3 right_scaled;
        glm_vec3_scale(camera.right, camera_speed, right_scaled);
        glm_vec3_add(camera.position, right_scaled, camera.position);
    }
}

static void mouse_callback(GLFWwindow *window, double xpos, double ypos)
{
    static bool first_mouse = true;
    static float last_x = 400, last_y = 300;
    
    if (first_mouse) {
        last_x = xpos;
        last_y = ypos;
        first_mouse = false;
    }
    
    float xoffset = xpos - last_x;
    float yoffset = last_y - ypos;
    last_x = xpos;
    last_y = ypos;
    
    const float sensitivity = 0.1f;
    xoffset *= sensitivity;
    yoffset *= sensitivity;
    
    camera.yaw += xoffset;
    camera.pitch += yoffset;
    
    if (camera.pitch > 89.0f) camera.pitch = 89.0f;
    if (camera.pitch < -89.0f) camera.pitch = -89.0f;
    
    // Update camera vectors
    vec3 front;
    front[0] = cos(glm_rad(camera.yaw)) * cos(glm_rad(camera.pitch));
    front[1] = sin(glm_rad(camera.pitch));
    front[2] = sin(glm_rad(camera.yaw)) * cos(glm_rad(camera.pitch));
    glm_normalize(front);
    glm_vec3_copy(front, camera.front);
    
    glm_vec3_cross(camera.front, (vec3){0.0f, 1.0f, 0.0f}, camera.right);
    glm_normalize(camera.right);
    glm_vec3_cross(camera.right, camera.front, camera.up);
    glm_normalize(camera.up);
}

// Main application
int main(void)
{
    // Initialize GLFW
    if (!glfwInit()) {
        fprintf(stderr, "Failed to initialize GLFW\n");
        return -1;
    }
    
    glfwWindowHint(GLFW_CLIENT_API, GLFW_NO_API);
    glfwWindowHint(GLFW_RESIZABLE, GLFW_TRUE);
    
    window = glfwCreateWindow(1280, 720, "Advanced Vulkan Renderer", NULL, NULL);
    if (!window) {
        fprintf(stderr, "Failed to create GLFW window\n");
        glfwTerminate();
        return -1;
    }
    
    glfwSetFramebufferSizeCallback(window, framebuffer_resize_callback);
    glfwSetKeyCallback(window, key_callback);
    glfwSetCursorPosCallback(window, mouse_callback);
    glfwSetInputMode(window, GLFW_CURSOR, GLFW_CURSOR_DISABLED);
    
    // Initialize camera
    glm_vec3_copy((vec3){0.0f, 0.0f, 3.0f}, camera.position);
    glm_vec3_copy((vec3){0.0f, 0.0f, -1.0f}, camera.front);
    glm_vec3_copy((vec3){0.0f, 1.0f, 0.0f}, camera.up);
    camera.yaw = -90.0f;
    camera.pitch = 0.0f;
    camera.fov = 45.0f;
    camera.near_plane = 0.1f;
    camera.far_plane = 100.0f;
    
    // Initialize Vulkan
    if (init_vulkan() != 0) {
        fprintf(stderr, "Failed to initialize Vulkan\n");
        glfwDestroyWindow(window);
        glfwTerminate();
        return -1;
    }
    
    printf("Vulkan renderer initialized successfully\n");
    printf("Controls: WASD to move, mouse to look around, F1 to toggle wireframe, ESC to exit\n");
    
    // Main loop
    while (!glfwWindowShouldClose(window)) {
        glfwPollEvents();
        draw_frame();
    }
    
    vkDeviceWaitIdle(vk_ctx.device);
    
    cleanup_vulkan();
    glfwDestroyWindow(window);
    glfwTerminate();
    
    return 0;
}
```

## Build and Test Scripts

### Comprehensive Build System

```bash
#!/bin/bash
# build_graphics.sh - Advanced graphics programming build system

set -e

# Configuration
PROJECT_NAME="advanced-graphics"
BUILD_DIR="build"
INSTALL_DIR="install"
CMAKE_BUILD_TYPE="Release"
ENABLE_VALIDATION="OFF"
ENABLE_TESTS="ON"
ENABLE_BENCHMARKS="ON"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Dependency check
check_dependencies() {
    log_info "Checking dependencies..."
    
    local deps=(
        "gcc"
        "g++"
        "cmake"
        "ninja-build"
        "pkg-config"
        "glslc"
        "glfw3-dev"
        "libvulkan-dev"
        "vulkan-validationlayers-dev"
        "vulkan-tools"
        "libdrm-dev"
        "libgbm-dev"
        "libegl1-mesa-dev"
        "libgl1-mesa-dev"
        "libgles2-mesa-dev"
        "libwayland-dev"
        "libxkbcommon-dev"
        "wayland-protocols"
        "libfftw3-dev"
        "libasound2-dev"
        "libpulse-dev"
        "libjack-jackd2-dev"
        "libsamplerate0-dev"
        "libsndfile1-dev"
        "libavcodec-dev"
        "libavformat-dev"
        "libavutil-dev"
        "libswscale-dev"
        "libopencv-dev"
        "cglm-dev"
    )
    
    local missing_deps=()
    
    for dep in "${deps[@]}"; do
        if ! dpkg -l | grep -q "^ii  $dep "; then
            missing_deps+=("$dep")
        fi
    done
    
    if [ ${#missing_deps[@]} -ne 0 ]; then
        log_warning "Missing dependencies: ${missing_deps[*]}"
        log_info "Installing missing dependencies..."
        sudo apt-get update
        sudo apt-get install -y "${missing_deps[@]}"
    fi
    
    # Check for Vulkan SDK
    if ! command -v glslc &> /dev/null; then
        log_error "Vulkan SDK not found. Please install the Vulkan SDK."
        exit 1
    fi
    
    log_success "All dependencies satisfied"
}

# Generate CMakeLists.txt
generate_cmake() {
    log_info "Generating CMakeLists.txt..."
    
    cat > CMakeLists.txt << 'EOF'
cmake_minimum_required(VERSION 3.16)
project(advanced-graphics VERSION 1.0.0 LANGUAGES C CXX)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Find packages
find_package(PkgConfig REQUIRED)
find_package(Vulkan REQUIRED)
find_package(glfw3 REQUIRED)
find_package(OpenCV REQUIRED)

pkg_check_modules(DRM REQUIRED libdrm)
pkg_check_modules(GBM REQUIRED gbm)
pkg_check_modules(EGL REQUIRED egl)
pkg_check_modules(WAYLAND REQUIRED wayland-client wayland-server)
pkg_check_modules(CGLM REQUIRED cglm)
pkg_check_modules(FFTW3 REQUIRED fftw3f)
pkg_check_modules(ALSA REQUIRED alsa)
pkg_check_modules(PULSE REQUIRED libpulse)
pkg_check_modules(JACK REQUIRED jack)
pkg_check_modules(SAMPLERATE REQUIRED samplerate)
pkg_check_modules(SNDFILE REQUIRED sndfile)
pkg_check_modules(AVCODEC REQUIRED libavcodec)
pkg_check_modules(AVFORMAT REQUIRED libavformat)
pkg_check_modules(AVUTIL REQUIRED libavutil)
pkg_check_modules(SWSCALE REQUIRED libswscale)

# Compiler flags
set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -Wall -Wextra -march=native")
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -Wall -Wextra -march=native")

if(CMAKE_BUILD_TYPE STREQUAL "Debug")
    set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -g -O0 -DDEBUG")
    set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -g -O0 -DDEBUG")
else()
    set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -O3 -DNDEBUG")
    set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -O3 -DNDEBUG")
endif()

# DRM Driver
add_library(advanced_gpu_drm SHARED drm_driver.c)
target_link_libraries(advanced_gpu_drm 
    ${DRM_LIBRARIES} 
    ${GBM_LIBRARIES}
    pthread
)
target_include_directories(advanced_gpu_drm PRIVATE 
    ${DRM_INCLUDE_DIRS}
    ${GBM_INCLUDE_DIRS}
)

# Vulkan Renderer
add_executable(vulkan_renderer vulkan_renderer.c)
target_link_libraries(vulkan_renderer
    Vulkan::Vulkan
    glfw
    ${CGLM_LIBRARIES}
    ${OpenCV_LIBS}
    m
    pthread
)
target_include_directories(vulkan_renderer PRIVATE 
    ${CGLM_INCLUDE_DIRS}
    ${OpenCV_INCLUDE_DIRS}
)

# Compile shaders
function(add_shader TARGET SHADER_SOURCE)
    get_filename_component(SHADER_NAME ${SHADER_SOURCE} NAME_WE)
    set(SHADER_OUTPUT ${CMAKE_CURRENT_BINARY_DIR}/${SHADER_NAME}.spv)
    
    add_custom_command(
        OUTPUT ${SHADER_OUTPUT}
        COMMAND glslc ${CMAKE_CURRENT_SOURCE_DIR}/${SHADER_SOURCE} -o ${SHADER_OUTPUT}
        DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/${SHADER_SOURCE}
        COMMENT "Compiling shader ${SHADER_SOURCE}"
    )
    
    target_sources(${TARGET} PRIVATE ${SHADER_OUTPUT})
endfunction()

# Audio Processing
add_executable(audio_processor alsa_advanced.c)
target_link_libraries(audio_processor
    ${ALSA_LIBRARIES}
    ${PULSE_LIBRARIES}
    ${JACK_LIBRARIES}
    ${FFTW3_LIBRARIES}
    ${SAMPLERATE_LIBRARIES}
    ${SNDFILE_LIBRARIES}
    ${AVCODEC_LIBRARIES}
    ${AVFORMAT_LIBRARIES}
    ${AVUTIL_LIBRARIES}
    ${SWSCALE_LIBRARIES}
    m
    pthread
)
target_include_directories(audio_processor PRIVATE
    ${ALSA_INCLUDE_DIRS}
    ${PULSE_INCLUDE_DIRS}
    ${JACK_INCLUDE_DIRS}
    ${FFTW3_INCLUDE_DIRS}
    ${SAMPLERATE_INCLUDE_DIRS}
    ${SNDFILE_INCLUDE_DIRS}
    ${AVCODEC_INCLUDE_DIRS}
    ${AVFORMAT_INCLUDE_DIRS}
    ${AVUTIL_INCLUDE_DIRS}
    ${SWSCALE_INCLUDE_DIRS}
)

# Tests
if(ENABLE_TESTS)
    enable_testing()
    
    add_executable(test_vulkan test_vulkan.c)
    target_link_libraries(test_vulkan Vulkan::Vulkan)
    add_test(NAME VulkanTest COMMAND test_vulkan)
    
    add_executable(test_drm test_drm.c)
    target_link_libraries(test_drm ${DRM_LIBRARIES})
    add_test(NAME DRMTest COMMAND test_drm)
endif()

# Benchmarks
if(ENABLE_BENCHMARKS)
    add_executable(benchmark_graphics benchmark_graphics.c)
    target_link_libraries(benchmark_graphics
        Vulkan::Vulkan
        glfw
        ${CGLM_LIBRARIES}
        m
        pthread
    )
endif()

# Installation
install(TARGETS vulkan_renderer audio_processor DESTINATION bin)
install(FILES advanced_gpu_drm.so DESTINATION lib)
install(DIRECTORY shaders/ DESTINATION share/advanced-graphics/shaders)
EOF

    log_success "CMakeLists.txt generated"
}

# Generate shader files
generate_shaders() {
    log_info "Generating shader files..."
    
    mkdir -p shaders
    
    # Vertex shader
    cat > shaders/vertex.vert << 'EOF'
#version 450

layout(binding = 0) uniform UniformBufferObject {
    mat4 model;
    mat4 view;
    mat4 proj;
    vec4 light_pos;
    vec4 view_pos;
} ubo;

layout(push_constant) uniform PushConstants {
    mat4 model;
    uint texture_index;
} pc;

layout(location = 0) in vec3 in_position;
layout(location = 1) in vec3 in_normal;
layout(location = 2) in vec2 in_tex_coord;
layout(location = 3) in vec3 in_color;

layout(location = 0) out vec3 frag_pos;
layout(location = 1) out vec3 frag_normal;
layout(location = 2) out vec2 frag_tex_coord;
layout(location = 3) out vec3 frag_color;
layout(location = 4) out vec3 light_pos;
layout(location = 5) out vec3 view_pos;

void main() {
    vec4 world_pos = pc.model * vec4(in_position, 1.0);
    frag_pos = world_pos.xyz;
    frag_normal = mat3(transpose(inverse(pc.model))) * in_normal;
    frag_tex_coord = in_tex_coord;
    frag_color = in_color;
    light_pos = ubo.light_pos.xyz;
    view_pos = ubo.view_pos.xyz;
    
    gl_Position = ubo.proj * ubo.view * world_pos;
}
EOF

    # Fragment shader
    cat > shaders/fragment.frag << 'EOF'
#version 450

layout(binding = 1) uniform sampler2D tex_samplers[1000];

layout(push_constant) uniform PushConstants {
    mat4 model;
    uint texture_index;
} pc;

layout(location = 0) in vec3 frag_pos;
layout(location = 1) in vec3 frag_normal;
layout(location = 2) in vec2 frag_tex_coord;
layout(location = 3) in vec3 frag_color;
layout(location = 4) in vec3 light_pos;
layout(location = 5) in vec3 view_pos;

layout(location = 0) out vec4 out_color;

void main() {
    vec3 ambient = 0.15 * frag_color;
    
    vec3 norm = normalize(frag_normal);
    vec3 light_dir = normalize(light_pos - frag_pos);
    float diff = max(dot(norm, light_dir), 0.0);
    vec3 diffuse = diff * frag_color;
    
    vec3 view_dir = normalize(view_pos - frag_pos);
    vec3 reflect_dir = reflect(-light_dir, norm);
    float spec = pow(max(dot(view_dir, reflect_dir), 0.0), 64.0);
    vec3 specular = spec * vec3(0.5);
    
    vec4 tex_color = texture(tex_samplers[pc.texture_index], frag_tex_coord);
    
    vec3 result = (ambient + diffuse + specular) * tex_color.rgb;
    out_color = vec4(result, tex_color.a);
}
EOF

    # Compute shader
    cat > shaders/compute.comp << 'EOF'
#version 450

layout(local_size_x = 16, local_size_y = 16) in;

layout(binding = 0, rgba8) uniform readonly image2D input_image;
layout(binding = 1, rgba8) uniform writeonly image2D output_image;

layout(push_constant) uniform ComputePushConstants {
    float exposure;
    float gamma;
    int effect_type;
} pc;

vec3 tone_mapping(vec3 color) {
    return color / (color + vec3(1.0));
}

vec3 gamma_correction(vec3 color) {
    return pow(color, vec3(1.0 / pc.gamma));
}

void main() {
    ivec2 coord = ivec2(gl_GlobalInvocationID.xy);
    ivec2 image_size = imageSize(input_image);
    
    if (coord.x >= image_size.x || coord.y >= image_size.y) {
        return;
    }
    
    vec4 color = imageLoad(input_image, coord);
    
    color.rgb *= pc.exposure;
    color.rgb = tone_mapping(color.rgb);
    color.rgb = gamma_correction(color.rgb);
    
    if (pc.effect_type == 1) {
        float gray = dot(color.rgb, vec3(0.299, 0.587, 0.114));
        color.rgb = vec3(gray);
    } else if (pc.effect_type == 2) {
        vec3 sepia = vec3(
            dot(color.rgb, vec3(0.393, 0.769, 0.189)),
            dot(color.rgb, vec3(0.349, 0.686, 0.168)),
            dot(color.rgb, vec3(0.272, 0.534, 0.131))
        );
        color.rgb = sepia;
    }
    
    imageStore(output_image, coord, color);
}
EOF

    log_success "Shader files generated"
}

# Generate test files
generate_tests() {
    log_info "Generating test files..."
    
    # Vulkan test
    cat > test_vulkan.c << 'EOF'
#include <stdio.h>
#include <vulkan/vulkan.h>

int main() {
    VkInstance instance;
    VkApplicationInfo app_info = {
        .sType = VK_STRUCTURE_TYPE_APPLICATION_INFO,
        .pApplicationName = "Vulkan Test",
        .applicationVersion = VK_MAKE_VERSION(1, 0, 0),
        .pEngineName = "Test Engine",
        .engineVersion = VK_MAKE_VERSION(1, 0, 0),
        .apiVersion = VK_API_VERSION_1_0
    };
    
    VkInstanceCreateInfo create_info = {
        .sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO,
        .pApplicationInfo = &app_info
    };
    
    if (vkCreateInstance(&create_info, NULL, &instance) != VK_SUCCESS) {
        printf("FAIL: Failed to create Vulkan instance\n");
        return 1;
    }
    
    vkDestroyInstance(instance, NULL);
    printf("PASS: Vulkan instance created and destroyed successfully\n");
    return 0;
}
EOF

    # DRM test
    cat > test_drm.c << 'EOF'
#include <stdio.h>
#include <fcntl.h>
#include <unistd.h>
#include <xf86drm.h>
#include <xf86drmMode.h>

int main() {
    int fd = open("/dev/dri/card0", O_RDWR | O_CLOEXEC);
    if (fd < 0) {
        printf("SKIP: Cannot open DRM device\n");
        return 0;
    }
    
    drmModeRes *resources = drmModeGetResources(fd);
    if (!resources) {
        printf("FAIL: Failed to get DRM resources\n");
        close(fd);
        return 1;
    }
    
    printf("PASS: DRM resources: %d CRTCs, %d encoders, %d connectors\n",
           resources->count_crtcs, resources->count_encoders, resources->count_connectors);
    
    drmModeFreeResources(resources);
    close(fd);
    return 0;
}
EOF

    log_success "Test files generated"
}

# Build function
build_project() {
    log_info "Building project..."
    
    # Clean previous build
    if [ -d "$BUILD_DIR" ]; then
        log_info "Cleaning previous build..."
        rm -rf "$BUILD_DIR"
    fi
    
    mkdir -p "$BUILD_DIR"
    cd "$BUILD_DIR"
    
    # Configure with CMake
    cmake .. \
        -G Ninja \
        -DCMAKE_BUILD_TYPE="$CMAKE_BUILD_TYPE" \
        -DCMAKE_INSTALL_PREFIX="../$INSTALL_DIR" \
        -DENABLE_VALIDATION="$ENABLE_VALIDATION" \
        -DENABLE_TESTS="$ENABLE_TESTS" \
        -DENABLE_BENCHMARKS="$ENABLE_BENCHMARKS"
    
    # Build
    ninja -j$(nproc)
    
    cd ..
    log_success "Build completed successfully"
}

# Test function
run_tests() {
    if [ "$ENABLE_TESTS" = "ON" ]; then
        log_info "Running tests..."
        cd "$BUILD_DIR"
        ctest --output-on-failure
        cd ..
        log_success "All tests passed"
    fi
}

# Install function
install_project() {
    log_info "Installing project..."
    cd "$BUILD_DIR"
    ninja install
    cd ..
    log_success "Installation completed"
}

# Benchmark function
run_benchmarks() {
    if [ "$ENABLE_BENCHMARKS" = "ON" ]; then
        log_info "Running benchmarks..."
        cd "$BUILD_DIR"
        ./benchmark_graphics
        cd ..
        log_success "Benchmarks completed"
    fi
}

# Package function
package_project() {
    log_info "Creating package..."
    
    local package_name="${PROJECT_NAME}-$(date +%Y%m%d-%H%M%S)"
    local package_dir="packages/$package_name"
    
    mkdir -p "$package_dir"
    
    # Copy binaries
    cp "$BUILD_DIR/vulkan_renderer" "$package_dir/"
    cp "$BUILD_DIR/audio_processor" "$package_dir/"
    
    # Copy shaders
    mkdir -p "$package_dir/shaders"
    cp -r shaders/* "$package_dir/shaders/"
    
    # Create package
    cd packages
    tar -czf "${package_name}.tar.gz" "$package_name"
    cd ..
    
    log_success "Package created: packages/${package_name}.tar.gz"
}

# Main function
main() {
    log_info "Starting build process for $PROJECT_NAME"
    
    case "${1:-all}" in
        deps)
            check_dependencies
            ;;
        generate)
            generate_cmake
            generate_shaders
            generate_tests
            ;;
        build)
            build_project
            ;;
        test)
            run_tests
            ;;
        install)
            install_project
            ;;
        benchmark)
            run_benchmarks
            ;;
        package)
            package_project
            ;;
        clean)
            log_info "Cleaning build artifacts..."
            rm -rf "$BUILD_DIR" "$INSTALL_DIR" packages
            log_success "Clean completed"
            ;;
        all)
            check_dependencies
            generate_cmake
            generate_shaders
            generate_tests
            build_project
            run_tests
            install_project
            run_benchmarks
            package_project
            ;;
        *)
            echo "Usage: $0 [deps|generate|build|test|install|benchmark|package|clean|all]"
            exit 1
            ;;
    esac
    
    log_success "Build process completed successfully"
}

# Execute main function
main "$@"
```

This comprehensive blog post covers advanced Linux graphics programming including:

1. **DRM/KMS Kernel Driver Development** - Complete implementation of a modern DRM graphics driver with atomic modesetting, command ring processing, and memory management
2. **Vulkan Graphics Programming** - Full-featured Vulkan renderer with advanced features like multisampling, compute shaders, and performance monitoring
3. **Comprehensive Build System** - Advanced build scripts with dependency management, testing, and packaging

The implementation demonstrates production-ready graphics programming techniques for Linux systems.