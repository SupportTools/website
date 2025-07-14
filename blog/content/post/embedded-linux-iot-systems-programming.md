---
title: "Embedded Linux and IoT Systems Programming: Building Connected Device Platforms"
date: 2025-03-26T10:00:00-05:00
draft: false
tags: ["Linux", "Embedded", "IoT", "Device Drivers", "Real-Time", "ARM", "Buildroot", "Yocto"]
categories:
- Linux
- Embedded Systems
author: "Matthew Mattox - mmattox@support.tools"
description: "Master embedded Linux development for IoT devices, including custom kernel configurations, device tree programming, real-time constraints, and building complete embedded systems"
more_link: "yes"
url: "/embedded-linux-iot-systems-programming/"
---

Embedded Linux has become the foundation for countless IoT devices, from industrial controllers to smart home systems. This comprehensive guide explores embedded Linux development, device driver programming, real-time considerations, and building complete IoT platforms with modern tools and techniques.

<!--more-->

# [Embedded Linux and IoT Systems Programming](#embedded-linux-iot-systems)

## Custom Kernel Configuration and Device Tree Programming

### Advanced Kernel Configuration for Embedded Systems

```bash
#!/bin/bash
# embedded_kernel_config.sh - Embedded kernel configuration and building

# Kernel configuration for embedded systems
configure_embedded_kernel() {
    local arch=${1:-"arm64"}
    local board=${2:-"rpi4"}
    local kernel_dir=${3:-"/usr/src/linux"}
    
    echo "=== Configuring Embedded Kernel ==="
    echo "Architecture: $arch"
    echo "Board: $board"
    echo "Kernel directory: $kernel_dir"
    
    cd "$kernel_dir" || exit 1
    
    # Set architecture and cross-compiler
    export ARCH="$arch"
    case "$arch" in
        "arm")
            export CROSS_COMPILE=arm-linux-gnueabihf-
            ;;
        "arm64")
            export CROSS_COMPILE=aarch64-linux-gnu-
            ;;
        "x86_64")
            unset CROSS_COMPILE
            ;;
    esac
    
    # Start with appropriate defconfig
    case "$board" in
        "rpi4")
            make bcm2711_defconfig
            ;;
        "imx8")
            make imx_v8_defconfig
            ;;
        "beaglebone")
            make omap2plus_defconfig
            ;;
        *)
            make defconfig
            ;;
    esac
    
    # Embedded-specific optimizations
    echo "Applying embedded optimizations..."
    
    # Enable/disable features via scripts
    scripts/config --enable CONFIG_EMBEDDED
    scripts/config --enable CONFIG_EXPERT
    
    # Size optimizations
    scripts/config --enable CONFIG_CC_OPTIMIZE_FOR_SIZE
    scripts/config --disable CONFIG_DEBUG_KERNEL
    scripts/config --disable CONFIG_DEBUG_INFO
    scripts/config --disable CONFIG_IKCONFIG
    scripts/config --disable CONFIG_IKCONFIG_PROC
    
    # Real-time features
    scripts/config --enable CONFIG_PREEMPT
    scripts/config --enable CONFIG_HIGH_RES_TIMERS
    scripts/config --enable CONFIG_NO_HZ
    scripts/config --enable CONFIG_HRTIMERS
    
    # Device tree support
    scripts/config --enable CONFIG_OF
    scripts/config --enable CONFIG_OF_FLATTREE
    scripts/config --enable CONFIG_OF_EARLY_FLATTREE
    scripts/config --enable CONFIG_OF_DYNAMIC
    scripts/config --enable CONFIG_OF_OVERLAY
    
    # GPIO and device support
    scripts/config --enable CONFIG_GPIOLIB
    scripts/config --enable CONFIG_GPIO_SYSFS
    scripts/config --enable CONFIG_I2C
    scripts/config --enable CONFIG_SPI
    scripts/config --enable CONFIG_PWM
    
    # Networking for IoT
    scripts/config --enable CONFIG_WIRELESS
    scripts/config --enable CONFIG_CFG80211
    scripts/config --enable CONFIG_MAC80211
    scripts/config --enable CONFIG_RFKILL
    scripts/config --enable CONFIG_BT
    
    # USB and storage
    scripts/config --enable CONFIG_USB
    scripts/config --enable CONFIG_USB_STORAGE
    scripts/config --enable CONFIG_MMC
    scripts/config --enable CONFIG_MMC_BLOCK
    
    # Security features
    scripts/config --enable CONFIG_SECURITY
    scripts/config --enable CONFIG_SECURITYFS
    scripts/config --enable CONFIG_SECURITY_SELINUX
    scripts/config --enable CONFIG_ENCRYPTED_KEYS
    
    # Container support (if needed)
    scripts/config --enable CONFIG_NAMESPACES
    scripts/config --enable CONFIG_CGROUPS
    scripts/config --enable CONFIG_OVERLAY_FS
    
    # Save configuration
    make savedefconfig
    cp defconfig "configs/${board}_defconfig"
    
    echo "Kernel configuration completed"
}

# Build kernel with device tree
build_kernel_with_devicetree() {
    local arch=${1:-"arm64"}
    local board=${2:-"rpi4"}
    local jobs=${3:-$(nproc)}
    
    echo "=== Building Kernel and Device Tree ==="
    
    # Build kernel
    echo "Building kernel..."
    make -j"$jobs" Image modules
    
    # Build device tree
    echo "Building device trees..."
    make -j"$jobs" dtbs
    
    # Install modules to staging area
    local staging_dir="/tmp/kernel_staging"
    mkdir -p "$staging_dir"
    
    make INSTALL_MOD_PATH="$staging_dir" modules_install
    
    # Copy kernel and device tree files
    local output_dir="/tmp/kernel_output"
    mkdir -p "$output_dir"
    
    case "$arch" in
        "arm64")
            cp arch/arm64/boot/Image "$output_dir/"
            cp arch/arm64/boot/dts/broadcom/*.dtb "$output_dir/" 2>/dev/null || true
            ;;
        "arm")
            cp arch/arm/boot/zImage "$output_dir/"
            cp arch/arm/boot/dts/*.dtb "$output_dir/" 2>/dev/null || true
            ;;
    esac
    
    # Create boot files
    echo "Creating boot files..."
    cat > "$output_dir/config.txt" << EOF
# Raspberry Pi configuration
enable_uart=1
arm_64bit=1
device_tree_address=0x03000000
device_tree_end=0x03020000
EOF
    
    echo "Kernel build completed"
    echo "Output directory: $output_dir"
    echo "Staging directory: $staging_dir"
}

# Device tree compilation and validation
validate_device_tree() {
    local dts_file=$1
    local dtb_file=${2:-"/tmp/test.dtb"}
    
    echo "=== Device Tree Validation ==="
    echo "Source: $dts_file"
    echo "Binary: $dtb_file"
    
    if [ ! -f "$dts_file" ]; then
        echo "Device tree source not found: $dts_file"
        return 1
    fi
    
    # Compile device tree
    echo "Compiling device tree..."
    dtc -I dts -O dtb -o "$dtb_file" "$dts_file" || return 1
    
    # Validate syntax
    echo "Validating device tree syntax..."
    dtc -I dtb -O dts "$dtb_file" > /tmp/validation.dts
    
    # Check for common issues
    echo "Checking for common issues..."
    
    # Check for missing compatible strings
    if ! grep -q "compatible" "$dts_file"; then
        echo "WARNING: No compatible strings found"
    fi
    
    # Check for proper reg properties
    grep -n "reg = " "$dts_file" | while read line; do
        echo "Register property: $line"
    done
    
    # Check interrupt mappings
    grep -n "interrupt" "$dts_file" | while read line; do
        echo "Interrupt property: $line"
    done
    
    echo "Device tree validation completed"
}

# Generate custom device tree
generate_custom_device_tree() {
    local board=${1:-"custom"}
    local output_file=${2:-"/tmp/custom.dts"}
    
    echo "=== Generating Custom Device Tree ==="
    
    cat > "$output_file" << 'EOF'
/dts-v1/;

/ {
    model = "Custom IoT Board";
    compatible = "custom,iot-board", "brcm,bcm2711";
    
    #address-cells = <2>;
    #size-cells = <1>;
    
    memory@0 {
        device_type = "memory";
        reg = <0x0 0x00000000 0x40000000>; // 1GB RAM
    };
    
    chosen {
        bootargs = "console=ttyS0,115200 root=/dev/mmcblk0p2 rootwait rw";
        stdout-path = "serial0:115200n8";
    };
    
    aliases {
        serial0 = &uart0;
        serial1 = &uart1;
        i2c0 = &i2c0;
        i2c1 = &i2c1;
        spi0 = &spi0;
    };
    
    // CPU definition
    cpus {
        #address-cells = <1>;
        #size-cells = <0>;
        
        cpu@0 {
            device_type = "cpu";
            compatible = "arm,cortex-a72";
            reg = <0>;
            enable-method = "psci";
        };
        
        cpu@1 {
            device_type = "cpu";
            compatible = "arm,cortex-a72";
            reg = <1>;
            enable-method = "psci";
        };
    };
    
    // Memory-mapped peripherals
    soc {
        compatible = "simple-bus";
        #address-cells = <1>;
        #size-cells = <1>;
        ranges = <0x7e000000 0x0 0xfe000000 0x1800000>;
        
        // UART
        uart0: serial@7e201000 {
            compatible = "arm,pl011", "arm,primecell";
            reg = <0x7e201000 0x1000>;
            interrupts = <2 25 4>;
            clocks = <&clocks 19>, <&clocks 20>;
            clock-names = "uartclk", "apb_pclk";
            status = "okay";
        };
        
        // I2C
        i2c0: i2c@7e205000 {
            compatible = "brcm,bcm2711-i2c", "brcm,bcm2835-i2c";
            reg = <0x7e205000 0x1000>;
            interrupts = <2 21 4>;
            clocks = <&clocks 20>;
            #address-cells = <1>;
            #size-cells = <0>;
            status = "okay";
            
            // Temperature sensor
            temp_sensor: temp@48 {
                compatible = "ti,tmp102";
                reg = <0x48>;
                status = "okay";
            };
            
            // EEPROM
            eeprom: eeprom@50 {
                compatible = "atmel,24c64";
                reg = <0x50>;
                pagesize = <32>;
                status = "okay";
            };
        };
        
        // SPI
        spi0: spi@7e204000 {
            compatible = "brcm,bcm2711-spi", "brcm,bcm2835-spi";
            reg = <0x7e204000 0x1000>;
            interrupts = <2 22 4>;
            clocks = <&clocks 20>;
            #address-cells = <1>;
            #size-cells = <0>;
            status = "okay";
            
            // SPI flash
            spidev0: spidev@0 {
                compatible = "rohm,dh2228fv";
                reg = <0>;
                spi-max-frequency = <1000000>;
                status = "okay";
            };
        };
        
        // GPIO
        gpio: gpio@7e200000 {
            compatible = "brcm,bcm2711-gpio", "brcm,bcm2835-gpio";
            reg = <0x7e200000 0x1000>;
            interrupts = <2 17 4>, <2 18 4>, <2 19 4>, <2 20 4>;
            gpio-controller;
            #gpio-cells = <2>;
            interrupt-controller;
            #interrupt-cells = <2>;
            status = "okay";
        };
        
        // PWM
        pwm: pwm@7e20c000 {
            compatible = "brcm,bcm2711-pwm", "brcm,bcm2835-pwm";
            reg = <0x7e20c000 0x28>;
            clocks = <&clocks 30>;
            assigned-clocks = <&clocks 30>;
            assigned-clock-rates = <10000000>;
            #pwm-cells = <2>;
            status = "okay";
        };
    };
    
    // External devices
    leds {
        compatible = "gpio-leds";
        
        status_led: status {
            label = "status";
            gpios = <&gpio 18 0>;
            linux,default-trigger = "heartbeat";
        };
        
        error_led: error {
            label = "error";
            gpios = <&gpio 19 0>;
            linux,default-trigger = "none";
        };
    };
    
    // GPIO buttons
    buttons {
        compatible = "gpio-keys";
        
        reset_button: reset {
            label = "reset";
            gpios = <&gpio 21 1>;
            linux,code = <0x198>; // KEY_RESTART
            debounce-interval = <50>;
        };
    };
    
    // Regulators
    regulators {
        compatible = "simple-bus";
        
        vdd_3v3_reg: regulator@0 {
            compatible = "regulator-fixed";
            regulator-name = "VDD_3V3";
            regulator-min-microvolt = <3300000>;
            regulator-max-microvolt = <3300000>;
            regulator-always-on;
        };
    };
    
    // Custom IoT device
    iot_device {
        compatible = "custom,iot-device";
        gpios = <&gpio 22 0>, <&gpio 23 0>;
        gpio-names = "enable", "reset";
        interrupt-parent = <&gpio>;
        interrupts = <24 2>; // GPIO 24, falling edge
        status = "okay";
    };
};

// Clock definitions
&clocks {
    // Define custom clocks if needed
};
EOF
    
    echo "Custom device tree generated: $output_file"
    
    # Validate the generated device tree
    validate_device_tree "$output_file"
}

# Device tree overlay for runtime modifications
create_device_tree_overlay() {
    local overlay_name=${1:-"custom-overlay"}
    local output_file="/tmp/${overlay_name}.dts"
    
    echo "=== Creating Device Tree Overlay ==="
    
    cat > "$output_file" << 'EOF'
/dts-v1/;
/plugin/;

/ {
    compatible = "brcm,bcm2835";
    
    fragment@0 {
        target = <&i2c1>;
        __overlay__ {
            #address-cells = <1>;
            #size-cells = <0>;
            status = "okay";
            
            // Add new I2C device
            accel: accelerometer@68 {
                compatible = "invensense,mpu6050";
                reg = <0x68>;
                interrupt-parent = <&gpio>;
                interrupts = <25 2>;
                status = "okay";
            };
        };
    };
    
    fragment@1 {
        target = <&spi0>;
        __overlay__ {
            #address-cells = <1>;
            #size-cells = <0>;
            status = "okay";
            
            // Add new SPI device
            adc: adc@1 {
                compatible = "microchip,mcp3008";
                reg = <1>;
                spi-max-frequency = <1000000>;
                status = "okay";
            };
        };
    };
    
    fragment@2 {
        target-path = "/";
        __overlay__ {
            // Custom GPIO configuration
            custom_gpios {
                compatible = "gpio-leds";
                
                data_led: data {
                    label = "data";
                    gpios = <&gpio 26 0>;
                    linux,default-trigger = "none";
                };
            };
        };
    };
};
EOF
    
    echo "Device tree overlay created: $output_file"
    
    # Compile overlay
    local dtbo_file="/tmp/${overlay_name}.dtbo"
    dtc -I dts -O dtb -@ -o "$dtbo_file" "$output_file"
    
    echo "Compiled overlay: $dtbo_file"
    
    # Show how to apply overlay
    echo "To apply overlay at runtime:"
    echo "  mkdir -p /sys/kernel/config/device-tree/overlays/$overlay_name"
    echo "  cat $dtbo_file > /sys/kernel/config/device-tree/overlays/$overlay_name/dtbo"
    echo "  echo 1 > /sys/kernel/config/device-tree/overlays/$overlay_name/status"
}
```

### Custom Device Driver Development

```c
// custom_iot_driver.c - Custom IoT device driver
#include <linux/module.h>
#include <linux/kernel.h>
#include <linux/init.h>
#include <linux/fs.h>
#include <linux/device.h>
#include <linux/cdev.h>
#include <linux/uaccess.h>
#include <linux/gpio.h>
#include <linux/interrupt.h>
#include <linux/platform_device.h>
#include <linux/of.h>
#include <linux/of_gpio.h>
#include <linux/i2c.h>
#include <linux/spi/spi.h>
#include <linux/pwm.h>
#include <linux/workqueue.h>
#include <linux/mutex.h>
#include <linux/wait.h>
#include <linux/poll.h>
#include <linux/slab.h>

#define DEVICE_NAME "iot_device"
#define CLASS_NAME "iot"
#define MAX_DEVICES 4

// Device data structure
struct iot_device_data {
    struct cdev cdev;
    struct device *device;
    struct class *class;
    dev_t dev_number;
    
    // GPIO resources
    int enable_gpio;
    int reset_gpio;
    int irq_gpio;
    int irq_number;
    
    // I2C/SPI resources
    struct i2c_client *i2c_client;
    struct spi_device *spi_device;
    
    // PWM resources
    struct pwm_device *pwm;
    
    // Device state
    struct mutex device_mutex;
    wait_queue_head_t read_queue;
    bool data_ready;
    
    // Work queue for deferred processing
    struct workqueue_struct *workqueue;
    struct work_struct irq_work;
    
    // Data buffers
    u8 *tx_buffer;
    u8 *rx_buffer;
    size_t buffer_size;
    
    // Statistics
    atomic_t interrupt_count;
    atomic_t read_count;
    atomic_t write_count;
};

static struct iot_device_data *iot_devices[MAX_DEVICES];
static int major_number;
static struct class *iot_class;

// Device tree compatible string
static const struct of_device_id iot_device_of_match[] = {
    { .compatible = "custom,iot-device" },
    { }
};
MODULE_DEVICE_TABLE(of, iot_device_of_match);

// GPIO operations
static int iot_gpio_init(struct iot_device_data *dev_data, struct device_node *np) {
    int ret;
    
    // Get GPIO numbers from device tree
    dev_data->enable_gpio = of_get_named_gpio(np, "gpios", 0);
    dev_data->reset_gpio = of_get_named_gpio(np, "gpios", 1);
    dev_data->irq_gpio = of_get_named_gpio(np, "interrupts", 0);
    
    if (!gpio_is_valid(dev_data->enable_gpio) || 
        !gpio_is_valid(dev_data->reset_gpio)) {
        pr_err("Invalid GPIO configuration\n");
        return -EINVAL;
    }
    
    // Request GPIOs
    ret = gpio_request(dev_data->enable_gpio, "iot_enable");
    if (ret) {
        pr_err("Failed to request enable GPIO\n");
        return ret;
    }
    
    ret = gpio_request(dev_data->reset_gpio, "iot_reset");
    if (ret) {
        pr_err("Failed to request reset GPIO\n");
        gpio_free(dev_data->enable_gpio);
        return ret;
    }
    
    if (gpio_is_valid(dev_data->irq_gpio)) {
        ret = gpio_request(dev_data->irq_gpio, "iot_irq");
        if (ret) {
            pr_err("Failed to request IRQ GPIO\n");
            gpio_free(dev_data->enable_gpio);
            gpio_free(dev_data->reset_gpio);
            return ret;
        }
        
        // Configure as input for interrupt
        gpio_direction_input(dev_data->irq_gpio);
        dev_data->irq_number = gpio_to_irq(dev_data->irq_gpio);
    }
    
    // Configure enable and reset GPIOs as outputs
    gpio_direction_output(dev_data->enable_gpio, 0);
    gpio_direction_output(dev_data->reset_gpio, 1);
    
    return 0;
}

// Device reset sequence
static void iot_device_reset(struct iot_device_data *dev_data) {
    gpio_set_value(dev_data->reset_gpio, 0);
    msleep(10);
    gpio_set_value(dev_data->reset_gpio, 1);
    msleep(50);
}

// Device enable/disable
static void iot_device_enable(struct iot_device_data *dev_data, bool enable) {
    gpio_set_value(dev_data->enable_gpio, enable ? 1 : 0);
    if (enable) {
        msleep(10);
    }
}

// Interrupt handler
static irqreturn_t iot_device_irq_handler(int irq, void *data) {
    struct iot_device_data *dev_data = (struct iot_device_data *)data;
    
    // Increment interrupt counter
    atomic_inc(&dev_data->interrupt_count);
    
    // Schedule work for bottom half processing
    queue_work(dev_data->workqueue, &dev_data->irq_work);
    
    return IRQ_HANDLED;
}

// Work queue handler for interrupt processing
static void iot_irq_work_handler(struct work_struct *work) {
    struct iot_device_data *dev_data = container_of(work, 
                                                   struct iot_device_data, 
                                                   irq_work);
    
    mutex_lock(&dev_data->device_mutex);
    
    // Simulate data processing
    dev_data->data_ready = true;
    
    // Wake up waiting readers
    wake_up_interruptible(&dev_data->read_queue);
    
    mutex_unlock(&dev_data->device_mutex);
    
    pr_debug("Interrupt work completed\n");
}

// I2C operations
static int iot_i2c_read_reg(struct iot_device_data *dev_data, u8 reg, u8 *value) {
    struct i2c_msg msgs[2];
    int ret;
    
    if (!dev_data->i2c_client) {
        return -ENODEV;
    }
    
    // Write register address
    msgs[0].addr = dev_data->i2c_client->addr;
    msgs[0].flags = 0;
    msgs[0].len = 1;
    msgs[0].buf = &reg;
    
    // Read register value
    msgs[1].addr = dev_data->i2c_client->addr;
    msgs[1].flags = I2C_M_RD;
    msgs[1].len = 1;
    msgs[1].buf = value;
    
    ret = i2c_transfer(dev_data->i2c_client->adapter, msgs, 2);
    return (ret == 2) ? 0 : ret;
}

static int iot_i2c_write_reg(struct iot_device_data *dev_data, u8 reg, u8 value) {
    u8 buffer[2] = {reg, value};
    int ret;
    
    if (!dev_data->i2c_client) {
        return -ENODEV;
    }
    
    ret = i2c_master_send(dev_data->i2c_client, buffer, 2);
    return (ret == 2) ? 0 : ret;
}

// SPI operations
static int iot_spi_transfer(struct iot_device_data *dev_data, 
                           const u8 *tx_buf, u8 *rx_buf, size_t len) {
    struct spi_transfer xfer = {
        .tx_buf = tx_buf,
        .rx_buf = rx_buf,
        .len = len,
        .speed_hz = 1000000,
        .bits_per_word = 8,
    };
    struct spi_message msg;
    
    if (!dev_data->spi_device) {
        return -ENODEV;
    }
    
    spi_message_init(&msg);
    spi_message_add_tail(&xfer, &msg);
    
    return spi_sync(dev_data->spi_device, &msg);
}

// PWM operations
static int iot_pwm_set_duty_cycle(struct iot_device_data *dev_data, 
                                 unsigned int period_ns, unsigned int duty_ns) {
    struct pwm_state state;
    
    if (!dev_data->pwm) {
        return -ENODEV;
    }
    
    pwm_get_state(dev_data->pwm, &state);
    state.period = period_ns;
    state.duty_cycle = duty_ns;
    state.enabled = true;
    
    return pwm_apply_state(dev_data->pwm, &state);
}

// Character device operations
static int iot_device_open(struct inode *inode, struct file *file) {
    struct iot_device_data *dev_data;
    
    dev_data = container_of(inode->i_cdev, struct iot_device_data, cdev);
    file->private_data = dev_data;
    
    // Enable device
    iot_device_enable(dev_data, true);
    
    pr_info("IoT device opened\n");
    return 0;
}

static int iot_device_release(struct inode *inode, struct file *file) {
    struct iot_device_data *dev_data = file->private_data;
    
    // Disable device
    iot_device_enable(dev_data, false);
    
    pr_info("IoT device released\n");
    return 0;
}

static ssize_t iot_device_read(struct file *file, char __user *buffer, 
                              size_t length, loff_t *offset) {
    struct iot_device_data *dev_data = file->private_data;
    ssize_t bytes_read = 0;
    int ret;
    
    atomic_inc(&dev_data->read_count);
    
    if (mutex_lock_interruptible(&dev_data->device_mutex)) {
        return -ERESTARTSYS;
    }
    
    // Wait for data if none available
    while (!dev_data->data_ready) {
        mutex_unlock(&dev_data->device_mutex);
        
        if (file->f_flags & O_NONBLOCK) {
            return -EAGAIN;
        }
        
        ret = wait_event_interruptible(dev_data->read_queue, dev_data->data_ready);
        if (ret) {
            return ret;
        }
        
        if (mutex_lock_interruptible(&dev_data->device_mutex)) {
            return -ERESTARTSYS;
        }
    }
    
    // Simulate reading device data
    length = min(length, dev_data->buffer_size);
    
    // Example: read from I2C device
    if (dev_data->i2c_client) {
        for (size_t i = 0; i < length && i < dev_data->buffer_size; i++) {
            u8 value;
            ret = iot_i2c_read_reg(dev_data, i, &value);
            if (ret) {
                break;
            }
            dev_data->rx_buffer[i] = value;
        }
    } else {
        // Generate dummy data
        for (size_t i = 0; i < length; i++) {
            dev_data->rx_buffer[i] = i & 0xFF;
        }
    }
    
    if (copy_to_user(buffer, dev_data->rx_buffer, length)) {
        mutex_unlock(&dev_data->device_mutex);
        return -EFAULT;
    }
    
    bytes_read = length;
    dev_data->data_ready = false;
    
    mutex_unlock(&dev_data->device_mutex);
    
    return bytes_read;
}

static ssize_t iot_device_write(struct file *file, const char __user *buffer, 
                               size_t length, loff_t *offset) {
    struct iot_device_data *dev_data = file->private_data;
    ssize_t bytes_written = 0;
    int ret;
    
    atomic_inc(&dev_data->write_count);
    
    if (length > dev_data->buffer_size) {
        return -EINVAL;
    }
    
    if (mutex_lock_interruptible(&dev_data->device_mutex)) {
        return -ERESTARTSYS;
    }
    
    if (copy_from_user(dev_data->tx_buffer, buffer, length)) {
        mutex_unlock(&dev_data->device_mutex);
        return -EFAULT;
    }
    
    // Example: write to I2C device
    if (dev_data->i2c_client && length >= 2) {
        for (size_t i = 0; i < length - 1; i += 2) {
            u8 reg = dev_data->tx_buffer[i];
            u8 value = dev_data->tx_buffer[i + 1];
            ret = iot_i2c_write_reg(dev_data, reg, value);
            if (ret) {
                break;
            }
        }
    }
    
    // Example: SPI transfer
    if (dev_data->spi_device) {
        ret = iot_spi_transfer(dev_data, dev_data->tx_buffer, 
                              dev_data->rx_buffer, length);
        if (ret) {
            pr_err("SPI transfer failed: %d\n", ret);
        }
    }
    
    bytes_written = length;
    mutex_unlock(&dev_data->device_mutex);
    
    return bytes_written;
}

static unsigned int iot_device_poll(struct file *file, poll_table *wait) {
    struct iot_device_data *dev_data = file->private_data;
    unsigned int mask = 0;
    
    poll_wait(file, &dev_data->read_queue, wait);
    
    if (dev_data->data_ready) {
        mask |= POLLIN | POLLRDNORM;
    }
    
    mask |= POLLOUT | POLLWRNORM; // Always writable
    
    return mask;
}

// IOCTL commands
#define IOT_IOCTL_MAGIC 'i'
#define IOT_IOCTL_RESET _IO(IOT_IOCTL_MAGIC, 0)
#define IOT_IOCTL_GET_STATUS _IOR(IOT_IOCTL_MAGIC, 1, int)
#define IOT_IOCTL_SET_PWM _IOW(IOT_IOCTL_MAGIC, 2, int)
#define IOT_IOCTL_GET_STATS _IOR(IOT_IOCTL_MAGIC, 3, int)

static long iot_device_ioctl(struct file *file, unsigned int cmd, unsigned long arg) {
    struct iot_device_data *dev_data = file->private_data;
    int ret = 0;
    
    switch (cmd) {
        case IOT_IOCTL_RESET:
            iot_device_reset(dev_data);
            break;
            
        case IOT_IOCTL_GET_STATUS: {
            int status = gpio_get_value(dev_data->enable_gpio);
            if (copy_to_user((int __user *)arg, &status, sizeof(status))) {
                ret = -EFAULT;
            }
            break;
        }
        
        case IOT_IOCTL_SET_PWM: {
            int duty_cycle;
            if (copy_from_user(&duty_cycle, (int __user *)arg, sizeof(duty_cycle))) {
                ret = -EFAULT;
                break;
            }
            
            ret = iot_pwm_set_duty_cycle(dev_data, 1000000, duty_cycle * 10000);
            break;
        }
        
        case IOT_IOCTL_GET_STATS: {
            struct {
                int interrupts;
                int reads;
                int writes;
            } stats;
            
            stats.interrupts = atomic_read(&dev_data->interrupt_count);
            stats.reads = atomic_read(&dev_data->read_count);
            stats.writes = atomic_read(&dev_data->write_count);
            
            if (copy_to_user((void __user *)arg, &stats, sizeof(stats))) {
                ret = -EFAULT;
            }
            break;
        }
        
        default:
            ret = -ENOTTY;
    }
    
    return ret;
}

static const struct file_operations iot_device_fops = {
    .owner = THIS_MODULE,
    .open = iot_device_open,
    .release = iot_device_release,
    .read = iot_device_read,
    .write = iot_device_write,
    .poll = iot_device_poll,
    .unlocked_ioctl = iot_device_ioctl,
};

// Platform driver probe function
static int iot_device_probe(struct platform_device *pdev) {
    struct iot_device_data *dev_data;
    struct device_node *np = pdev->dev.of_node;
    int ret;
    static int device_index = 0;
    
    if (device_index >= MAX_DEVICES) {
        return -ENODEV;
    }
    
    pr_info("Probing IoT device %d\n", device_index);
    
    // Allocate device data
    dev_data = devm_kzalloc(&pdev->dev, sizeof(*dev_data), GFP_KERNEL);
    if (!dev_data) {
        return -ENOMEM;
    }
    
    // Allocate buffers
    dev_data->buffer_size = 1024;
    dev_data->tx_buffer = devm_kzalloc(&pdev->dev, dev_data->buffer_size, GFP_KERNEL);
    dev_data->rx_buffer = devm_kzalloc(&pdev->dev, dev_data->buffer_size, GFP_KERNEL);
    
    if (!dev_data->tx_buffer || !dev_data->rx_buffer) {
        return -ENOMEM;
    }
    
    // Initialize synchronization primitives
    mutex_init(&dev_data->device_mutex);
    init_waitqueue_head(&dev_data->read_queue);
    
    // Initialize counters
    atomic_set(&dev_data->interrupt_count, 0);
    atomic_set(&dev_data->read_count, 0);
    atomic_set(&dev_data->write_count, 0);
    
    // Initialize GPIO
    ret = iot_gpio_init(dev_data, np);
    if (ret) {
        return ret;
    }
    
    // Create character device
    dev_data->dev_number = MKDEV(major_number, device_index);
    cdev_init(&dev_data->cdev, &iot_device_fops);
    dev_data->cdev.owner = THIS_MODULE;
    
    ret = cdev_add(&dev_data->cdev, dev_data->dev_number, 1);
    if (ret) {
        pr_err("Failed to add character device\n");
        goto cleanup_gpio;
    }
    
    // Create device file
    dev_data->device = device_create(iot_class, &pdev->dev, 
                                   dev_data->dev_number, dev_data,
                                   DEVICE_NAME "%d", device_index);
    if (IS_ERR(dev_data->device)) {
        ret = PTR_ERR(dev_data->device);
        goto cleanup_cdev;
    }
    
    // Create work queue
    dev_data->workqueue = create_singlethread_workqueue("iot_wq");
    if (!dev_data->workqueue) {
        ret = -ENOMEM;
        goto cleanup_device;
    }
    
    INIT_WORK(&dev_data->irq_work, iot_irq_work_handler);
    
    // Request interrupt
    if (dev_data->irq_number > 0) {
        ret = request_irq(dev_data->irq_number, iot_device_irq_handler,
                         IRQF_TRIGGER_FALLING, "iot_device", dev_data);
        if (ret) {
            pr_err("Failed to request IRQ %d\n", dev_data->irq_number);
            goto cleanup_workqueue;
        }
    }
    
    // Store device data
    platform_set_drvdata(pdev, dev_data);
    iot_devices[device_index] = dev_data;
    device_index++;
    
    // Reset and enable device
    iot_device_reset(dev_data);
    iot_device_enable(dev_data, true);
    
    pr_info("IoT device %d probed successfully\n", device_index - 1);
    return 0;
    
cleanup_workqueue:
    destroy_workqueue(dev_data->workqueue);
cleanup_device:
    device_destroy(iot_class, dev_data->dev_number);
cleanup_cdev:
    cdev_del(&dev_data->cdev);
cleanup_gpio:
    gpio_free(dev_data->enable_gpio);
    gpio_free(dev_data->reset_gpio);
    if (gpio_is_valid(dev_data->irq_gpio)) {
        gpio_free(dev_data->irq_gpio);
    }
    
    return ret;
}

// Platform driver remove function
static int iot_device_remove(struct platform_device *pdev) {
    struct iot_device_data *dev_data = platform_get_drvdata(pdev);
    
    pr_info("Removing IoT device\n");
    
    // Disable device
    iot_device_enable(dev_data, false);
    
    // Free interrupt
    if (dev_data->irq_number > 0) {
        free_irq(dev_data->irq_number, dev_data);
    }
    
    // Cleanup work queue
    destroy_workqueue(dev_data->workqueue);
    
    // Remove character device
    device_destroy(iot_class, dev_data->dev_number);
    cdev_del(&dev_data->cdev);
    
    // Free GPIOs
    gpio_free(dev_data->enable_gpio);
    gpio_free(dev_data->reset_gpio);
    if (gpio_is_valid(dev_data->irq_gpio)) {
        gpio_free(dev_data->irq_gpio);
    }
    
    return 0;
}

static struct platform_driver iot_device_driver = {
    .driver = {
        .name = "iot-device",
        .of_match_table = iot_device_of_match,
    },
    .probe = iot_device_probe,
    .remove = iot_device_remove,
};

// Module initialization
static int __init iot_device_init(void) {
    int ret;
    
    pr_info("Initializing IoT device driver\n");
    
    // Allocate major number
    ret = alloc_chrdev_region(&major_number, 0, MAX_DEVICES, DEVICE_NAME);
    if (ret < 0) {
        pr_err("Failed to allocate major number\n");
        return ret;
    }
    
    major_number = MAJOR(major_number);
    pr_info("IoT device driver assigned major number %d\n", major_number);
    
    // Create device class
    iot_class = class_create(THIS_MODULE, CLASS_NAME);
    if (IS_ERR(iot_class)) {
        ret = PTR_ERR(iot_class);
        goto cleanup_chrdev;
    }
    
    // Register platform driver
    ret = platform_driver_register(&iot_device_driver);
    if (ret) {
        pr_err("Failed to register platform driver\n");
        goto cleanup_class;
    }
    
    pr_info("IoT device driver initialized successfully\n");
    return 0;
    
cleanup_class:
    class_destroy(iot_class);
cleanup_chrdev:
    unregister_chrdev_region(MKDEV(major_number, 0), MAX_DEVICES);
    return ret;
}

// Module cleanup
static void __exit iot_device_exit(void) {
    pr_info("Exiting IoT device driver\n");
    
    platform_driver_unregister(&iot_device_driver);
    class_destroy(iot_class);
    unregister_chrdev_region(MKDEV(major_number, 0), MAX_DEVICES);
    
    pr_info("IoT device driver exited\n");
}

module_init(iot_device_init);
module_exit(iot_device_exit);

MODULE_LICENSE("GPL");
MODULE_AUTHOR("Your Name");
MODULE_DESCRIPTION("Custom IoT Device Driver");
MODULE_VERSION("1.0");
```

## Building Embedded Linux Systems

### Buildroot and Yocto Integration

```bash
#!/bin/bash
# embedded_build_systems.sh - Buildroot and Yocto build system setup

# Buildroot setup and configuration
setup_buildroot() {
    local buildroot_version=${1:-"2023.02"}
    local target_board=${2:-"raspberrypi4_64"}
    local output_dir=${3:-"/tmp/buildroot_output"}
    
    echo "=== Setting up Buildroot ==="
    echo "Version: $buildroot_version"
    echo "Target: $target_board"
    echo "Output: $output_dir"
    
    # Download and extract Buildroot
    local buildroot_dir="/tmp/buildroot-$buildroot_version"
    
    if [ ! -d "$buildroot_dir" ]; then
        echo "Downloading Buildroot..."
        wget -O "/tmp/buildroot-$buildroot_version.tar.gz" \
            "https://buildroot.org/downloads/buildroot-$buildroot_version.tar.gz"
        
        tar -xzf "/tmp/buildroot-$buildroot_version.tar.gz" -C /tmp/
    fi
    
    cd "$buildroot_dir" || exit 1
    
    # Configure for target board
    echo "Configuring Buildroot for $target_board..."
    make "${target_board}_defconfig"
    
    # Customize configuration
    echo "Applying custom configuration..."
    
    # Enable additional packages
    cat >> .config << 'EOF'
# Custom IoT packages
BR2_PACKAGE_DROPBEAR=y
BR2_PACKAGE_OPENSSH=y
BR2_PACKAGE_WIRELESS_TOOLS=y
BR2_PACKAGE_WPA_SUPPLICANT=y
BR2_PACKAGE_CURL=y
BR2_PACKAGE_WGET=y
BR2_PACKAGE_PYTHON3=y
BR2_PACKAGE_PYTHON3_PY_PIP=y
BR2_PACKAGE_NODEJS=y
BR2_PACKAGE_MOSQUITTO=y
BR2_PACKAGE_NGINX=y
BR2_PACKAGE_SQLITE=y
BR2_PACKAGE_BLUEZ5_UTILS=y
BR2_PACKAGE_I2C_TOOLS=y
BR2_PACKAGE_SPI_TOOLS=y
BR2_PACKAGE_GPSD=y
BR2_PACKAGE_LMSENSORS=y
BR2_PACKAGE_STRESS_NG=y
EOF
    
    # Update configuration
    make oldconfig
    
    # Set output directory
    export BR2_EXTERNAL_OUTPUT_DIR="$output_dir"
    make O="$output_dir" defconfig
    
    echo "Buildroot configured. Run 'make' to build."
    echo "Build command: make O=$output_dir -j$(nproc)"
}

# Build Buildroot system
build_buildroot() {
    local output_dir=${1:-"/tmp/buildroot_output"}
    local jobs=${2:-$(nproc)}
    
    echo "=== Building Buildroot System ==="
    echo "Output directory: $output_dir"
    echo "Parallel jobs: $jobs"
    
    # Start build
    make O="$output_dir" -j"$jobs" 2>&1 | tee "$output_dir/build.log"
    
    if [ $? -eq 0 ]; then
        echo "Build completed successfully"
        echo "Images available in: $output_dir/images/"
        ls -la "$output_dir/images/"
    else
        echo "Build failed. Check $output_dir/build.log"
        return 1
    fi
}

# Create custom Buildroot package
create_custom_buildroot_package() {
    local package_name=${1:-"iot-app"}
    local buildroot_dir=${2:-"/tmp/buildroot-2023.02"}
    
    echo "=== Creating Custom Buildroot Package: $package_name ==="
    
    local package_dir="$buildroot_dir/package/$package_name"
    mkdir -p "$package_dir"
    
    # Create package Config.in
    cat > "$package_dir/Config.in" << EOF
config BR2_PACKAGE_${package_name^^}
	bool "$package_name"
	depends on BR2_TOOLCHAIN_HAS_THREADS
	help
	  Custom IoT application package
	  
	  https://example.com/$package_name
EOF
    
    # Create package Makefile
    cat > "$package_dir/${package_name}.mk" << 'EOF'
################################################################################
#
# iot-app
#
################################################################################

IOT_APP_VERSION = 1.0.0
IOT_APP_SITE = $(TOPDIR)/../iot-app
IOT_APP_SITE_METHOD = local
IOT_APP_LICENSE = MIT
IOT_APP_LICENSE_FILES = LICENSE

define IOT_APP_BUILD_CMDS
	$(MAKE) CC="$(TARGET_CC)" LD="$(TARGET_LD)" -C $(@D)
endef

define IOT_APP_INSTALL_TARGET_CMDS
	$(INSTALL) -D -m 0755 $(@D)/iot-app $(TARGET_DIR)/usr/bin/iot-app
	$(INSTALL) -D -m 0644 $(@D)/iot-app.conf $(TARGET_DIR)/etc/iot-app.conf
	$(INSTALL) -D -m 0755 $(@D)/S99iot-app $(TARGET_DIR)/etc/init.d/S99iot-app
endef

$(eval $(generic-package))
EOF
    
    # Update main package Config.in
    echo "source \"package/$package_name/Config.in\"" >> "$buildroot_dir/package/Config.in"
    
    # Create sample application
    local app_dir="/tmp/iot-app"
    mkdir -p "$app_dir"
    
    cat > "$app_dir/iot-app.c" << 'EOF'
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <signal.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <fcntl.h>

static volatile int running = 1;

void signal_handler(int sig) {
    running = 0;
}

int main(void) {
    signal(SIGTERM, signal_handler);
    signal(SIGINT, signal_handler);
    
    printf("IoT Application starting...\n");
    
    while (running) {
        printf("IoT App: Running...\n");
        sleep(30);
    }
    
    printf("IoT Application exiting...\n");
    return 0;
}
EOF
    
    cat > "$app_dir/Makefile" << 'EOF'
CC ?= gcc
CFLAGS = -Wall -Wextra -O2

all: iot-app

iot-app: iot-app.c
	$(CC) $(CFLAGS) -o $@ $<

clean:
	rm -f iot-app

install: iot-app
	install -D -m 0755 iot-app $(DESTDIR)/usr/bin/iot-app

.PHONY: all clean install
EOF
    
    cat > "$app_dir/iot-app.conf" << 'EOF'
# IoT Application Configuration
LOG_LEVEL=info
DEVICE_ID=iot001
SERVER_URL=mqtt://localhost:1883
EOF
    
    cat > "$app_dir/S99iot-app" << 'EOF'
#!/bin/sh

DAEMON="iot-app"
PIDFILE="/var/run/$DAEMON.pid"

case "$1" in
    start)
        echo -n "Starting $DAEMON: "
        start-stop-daemon -S -q -p $PIDFILE -x /usr/bin/$DAEMON -- -d
        echo "OK"
        ;;
    stop)
        echo -n "Stopping $DAEMON: "
        start-stop-daemon -K -q -p $PIDFILE
        echo "OK"
        ;;
    restart)
        $0 stop
        $0 start
        ;;
    *)
        echo "Usage: $0 {start|stop|restart}"
        exit 1
esac

exit $?
EOF
    
    chmod +x "$app_dir/S99iot-app"
    
    echo "Custom package created: $package_name"
    echo "Source directory: $app_dir"
    echo "Package directory: $package_dir"
}

# Yocto Project setup
setup_yocto() {
    local yocto_release=${1:-"kirkstone"}
    local machine=${2:-"raspberrypi4-64"}
    local build_dir=${3:-"/tmp/yocto_build"}
    
    echo "=== Setting up Yocto Project ==="
    echo "Release: $yocto_release"
    echo "Machine: $machine"
    echo "Build directory: $build_dir"
    
    # Create build directory
    mkdir -p "$build_dir"
    cd "$build_dir" || exit 1
    
    # Clone Poky
    if [ ! -d "poky" ]; then
        echo "Cloning Poky..."
        git clone -b "$yocto_release" https://git.yoctoproject.org/poky.git
    fi
    
    # Clone meta-openembedded
    if [ ! -d "meta-openembedded" ]; then
        echo "Cloning meta-openembedded..."
        git clone -b "$yocto_release" https://github.com/openembedded/meta-openembedded.git
    fi
    
    # Clone Raspberry Pi layer
    if [ ! -d "meta-raspberrypi" ]; then
        echo "Cloning meta-raspberrypi..."
        git clone -b "$yocto_release" https://github.com/agherzan/meta-raspberrypi.git
    fi
    
    # Source environment
    source poky/oe-init-build-env
    
    # Configure build
    echo "Configuring Yocto build..."
    
    # Update local.conf
    cat >> conf/local.conf << EOF

# Machine configuration
MACHINE = "$machine"

# Distribution features
DISTRO_FEATURES += "wifi bluetooth systemd"
VIRTUAL-RUNTIME_init_manager = "systemd"

# Package management
PACKAGE_CLASSES = "package_rpm"

# Additional image features
IMAGE_FEATURES += "dev-pkgs tools-debug ssh-server-openssh"

# Disk space monitoring
BB_DISKMON_DIRS = "\\
    STOPTASKS,\${TMPDIR},1G,100M \\
    STOPTASKS,\${DL_DIR},1G,100M \\
    STOPTASKS,\${SSTATE_DIR},1G,100M \\
    STOPTASKS,/tmp,100M,100M \\
    ABORT,\${TMPDIR},100M,1K \\
    ABORT,\${DL_DIR},100M,1K \\
    ABORT,\${SSTATE_DIR},100M,1K \\
    ABORT,/tmp,10M,1K"

# Parallel compilation
BB_NUMBER_THREADS = "$(nproc)"
PARALLEL_MAKE = "-j $(nproc)"
EOF
    
    # Update bblayers.conf
    cat >> conf/bblayers.conf << EOF

# Additional layers
BBLAYERS += " \\
  $build_dir/meta-openembedded/meta-oe \\
  $build_dir/meta-openembedded/meta-python \\
  $build_dir/meta-openembedded/meta-networking \\
  $build_dir/meta-raspberrypi \\
  "
EOF
    
    echo "Yocto Project configured"
    echo "To build: bitbake core-image-base"
}

# Create custom Yocto layer
create_yocto_layer() {
    local layer_name=${1:-"meta-iot"}
    local build_dir=${2:-"/tmp/yocto_build"}
    
    echo "=== Creating Custom Yocto Layer: $layer_name ==="
    
    cd "$build_dir" || exit 1
    
    # Create layer
    source poky/oe-init-build-env
    bitbake-layers create-layer "$layer_name"
    
    # Add layer to build
    bitbake-layers add-layer "$layer_name"
    
    # Create custom recipe
    local recipe_dir="$layer_name/recipes-iot/iot-service"
    mkdir -p "$recipe_dir"
    
    cat > "$recipe_dir/iot-service_1.0.bb" << 'EOF'
DESCRIPTION = "IoT Service Application"
LICENSE = "MIT"
LIC_FILES_CHKSUM = "file://LICENSE;md5=..."

SRC_URI = "file://iot-service.c \
           file://iot-service.service \
           file://LICENSE"

S = "${WORKDIR}"

do_compile() {
    ${CC} ${CFLAGS} ${LDFLAGS} -o iot-service iot-service.c
}

do_install() {
    install -d ${D}${bindir}
    install -m 0755 iot-service ${D}${bindir}
    
    install -d ${D}${systemd_unitdir}/system
    install -m 0644 iot-service.service ${D}${systemd_unitdir}/system
}

FILES_${PN} = "${bindir}/iot-service"
FILES_${PN} += "${systemd_unitdir}/system/iot-service.service"

SYSTEMD_SERVICE_${PN} = "iot-service.service"
SYSTEMD_AUTO_ENABLE = "enable"

inherit systemd
EOF
    
    # Create recipe files
    mkdir -p "$recipe_dir/files"
    
    cat > "$recipe_dir/files/iot-service.c" << 'EOF'
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <signal.h>
#include <syslog.h>

static volatile int running = 1;

void signal_handler(int sig) {
    running = 0;
}

int main(void) {
    signal(SIGTERM, signal_handler);
    signal(SIGINT, signal_handler);
    
    openlog("iot-service", LOG_PID | LOG_CONS, LOG_DAEMON);
    syslog(LOG_INFO, "IoT Service starting");
    
    while (running) {
        syslog(LOG_DEBUG, "IoT Service running");
        sleep(60);
    }
    
    syslog(LOG_INFO, "IoT Service stopping");
    closelog();
    
    return 0;
}
EOF
    
    cat > "$recipe_dir/files/iot-service.service" << 'EOF'
[Unit]
Description=IoT Service
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/iot-service
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
    
    cat > "$recipe_dir/files/LICENSE" << 'EOF'
MIT License

Copyright (c) 2024

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
EOF
    
    # Create custom image recipe
    local image_dir="$layer_name/recipes-core/images"
    mkdir -p "$image_dir"
    
    cat > "$image_dir/iot-image.bb" << 'EOF'
DESCRIPTION = "Custom IoT Image"

require recipes-core/images/core-image-base.bb

IMAGE_FEATURES += "ssh-server-dropbear"

IMAGE_INSTALL += " \
    iot-service \
    python3 \
    python3-pip \
    curl \
    wget \
    wireless-tools \
    wpa-supplicant \
    bluez5 \
    i2c-tools \
    spi-tools \
    gpio-utils \
    "

export IMAGE_BASENAME = "iot-image"
EOF
    
    echo "Custom Yocto layer created: $layer_name"
    echo "To build custom image: bitbake iot-image"
}

# Cross-compilation environment setup
setup_cross_compilation() {
    local target_arch=${1:-"aarch64"}
    local sysroot_dir=${2:-"/tmp/sysroot"}
    
    echo "=== Setting up Cross-Compilation Environment ==="
    echo "Target architecture: $target_arch"
    echo "Sysroot directory: $sysroot_dir"
    
    # Install cross-compiler
    case "$target_arch" in
        "aarch64")
            apt-get update
            apt-get install -y gcc-aarch64-linux-gnu g++-aarch64-linux-gnu
            export CROSS_COMPILE=aarch64-linux-gnu-
            export CC=aarch64-linux-gnu-gcc
            export CXX=aarch64-linux-gnu-g++
            ;;
        "arm")
            apt-get update
            apt-get install -y gcc-arm-linux-gnueabihf g++-arm-linux-gnueabihf
            export CROSS_COMPILE=arm-linux-gnueabihf-
            export CC=arm-linux-gnueabihf-gcc
            export CXX=arm-linux-gnueabihf-g++
            ;;
        *)
            echo "Unsupported architecture: $target_arch"
            return 1
            ;;
    esac
    
    # Setup sysroot
    mkdir -p "$sysroot_dir"
    export SYSROOT="$sysroot_dir"
    
    # Create example cross-compilation script
    cat > /tmp/cross_compile.sh << EOF
#!/bin/bash

# Cross-compilation environment
export CROSS_COMPILE=$CROSS_COMPILE
export CC=$CC
export CXX=$CXX
export SYSROOT=$SYSROOT

# Compiler flags
export CFLAGS="--sysroot=\$SYSROOT -I\$SYSROOT/usr/include"
export CXXFLAGS="--sysroot=\$SYSROOT -I\$SYSROOT/usr/include"
export LDFLAGS="--sysroot=\$SYSROOT -L\$SYSROOT/usr/lib"

# PKG_CONFIG settings
export PKG_CONFIG_DIR=
export PKG_CONFIG_LIBDIR=\$SYSROOT/usr/lib/pkgconfig:\$SYSROOT/usr/share/pkgconfig
export PKG_CONFIG_SYSROOT_DIR=\$SYSROOT

echo "Cross-compilation environment configured for $target_arch"
echo "CC: \$CC"
echo "CXX: \$CXX"
echo "SYSROOT: \$SYSROOT"
EOF
    
    chmod +x /tmp/cross_compile.sh
    
    echo "Cross-compilation environment setup complete"
    echo "Source /tmp/cross_compile.sh to use"
}

# Main function
main() {
    local action=${1:-"help"}
    
    case "$action" in
        "buildroot_setup")
            setup_buildroot "$2" "$3" "$4"
            ;;
        "buildroot_build")
            build_buildroot "$2" "$3"
            ;;
        "buildroot_package")
            create_custom_buildroot_package "$2" "$3"
            ;;
        "yocto_setup")
            setup_yocto "$2" "$3" "$4"
            ;;
        "yocto_layer")
            create_yocto_layer "$2" "$3"
            ;;
        "cross_compile")
            setup_cross_compilation "$2" "$3"
            ;;
        *)
            echo "Embedded Linux Build Systems"
            echo "============================="
            echo
            echo "Usage: $0 <command> [args]"
            echo
            echo "Commands:"
            echo "  buildroot_setup [version] [board] [output]  - Setup Buildroot"
            echo "  buildroot_build [output] [jobs]             - Build Buildroot system"
            echo "  buildroot_package [name] [buildroot_dir]    - Create custom package"
            echo "  yocto_setup [release] [machine] [build_dir] - Setup Yocto Project"
            echo "  yocto_layer [name] [build_dir]              - Create custom layer"
            echo "  cross_compile [arch] [sysroot]              - Setup cross-compilation"
            ;;
    esac
}

main "$@"
```

## Best Practices

1. **Resource Constraints**: Design for limited memory, storage, and processing power
2. **Power Management**: Implement aggressive power saving techniques for battery-powered devices
3. **Real-Time Requirements**: Use RT kernels and proper scheduling for time-critical applications
4. **Security**: Implement secure boot, encrypted storage, and regular security updates
5. **Maintainability**: Design for remote updates and diagnostics

## Conclusion

Embedded Linux and IoT systems programming requires specialized knowledge of hardware constraints, real-time requirements, and system integration. From custom kernel configurations and device drivers to complete embedded Linux distributions, these techniques enable building sophisticated IoT platforms.

The future of embedded Linux lies in edge computing, AI acceleration, and enhanced security features. By mastering these embedded development techniques, engineers can build the next generation of intelligent, connected devices that power the modern IoT ecosystem.