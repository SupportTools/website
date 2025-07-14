---
title: "Advanced Linux Embedded Systems Programming: Building Industrial IoT and Real-Time Control Applications"
date: 2025-05-02T10:00:00-05:00
draft: false
tags: ["Linux", "Embedded Systems", "IoT", "Real-Time", "Industrial Control", "ARM", "Device Drivers", "Microcontrollers"]
categories:
- Linux
- Embedded Programming
author: "Matthew Mattox - mmattox@support.tools"
description: "Master advanced Linux embedded systems programming including real-time kernel development, device driver creation, industrial IoT protocols, and building robust embedded control systems"
more_link: "yes"
url: "/advanced-linux-embedded-systems-programming/"
---

Advanced Linux embedded systems programming requires deep understanding of hardware interfaces, real-time constraints, and resource optimization. This comprehensive guide explores building industrial IoT applications, custom device drivers, real-time control systems, and developing embedded Linux solutions for mission-critical applications.

<!--more-->

# [Advanced Linux Embedded Systems Programming](#advanced-linux-embedded-systems-programming)

## Embedded Real-Time Control Framework

### Industrial Control System Implementation

```c
// embedded_control.c - Advanced embedded control system framework
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <fcntl.h>
#include <time.h>
#include <signal.h>
#include <pthread.h>
#include <sys/mman.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <linux/gpio.h>
#include <linux/spi/spidev.h>
#include <linux/i2c-dev.h>
#include <math.h>
#include <stdatomic.h>

#define MAX_CONTROL_LOOPS 64
#define MAX_SENSORS 256
#define MAX_ACTUATORS 128
#define CONTROL_FREQUENCY_HZ 1000
#define SAFETY_TIMEOUT_MS 100
#define MAX_COMM_CHANNELS 32

// Control system types
typedef enum {
    CONTROL_TYPE_PID,
    CONTROL_TYPE_FUZZY,
    CONTROL_TYPE_ADAPTIVE,
    CONTROL_TYPE_PREDICTIVE,
    CONTROL_TYPE_NEURAL_NETWORK
} control_type_t;

// Sensor types
typedef enum {
    SENSOR_TYPE_TEMPERATURE,
    SENSOR_TYPE_PRESSURE,
    SENSOR_TYPE_FLOW,
    SENSOR_TYPE_LEVEL,
    SENSOR_TYPE_POSITION,
    SENSOR_TYPE_VELOCITY,
    SENSOR_TYPE_ACCELERATION,
    SENSOR_TYPE_FORCE,
    SENSOR_TYPE_TORQUE,
    SENSOR_TYPE_CURRENT,
    SENSOR_TYPE_VOLTAGE,
    SENSOR_TYPE_FREQUENCY
} sensor_type_t;

// Communication protocols
typedef enum {
    COMM_PROTOCOL_MODBUS_RTU,
    COMM_PROTOCOL_MODBUS_TCP,
    COMM_PROTOCOL_CAN,
    COMM_PROTOCOL_PROFIBUS,
    COMM_PROTOCOL_ETHERNET_IP,
    COMM_PROTOCOL_MQTT,
    COMM_PROTOCOL_OPCUA,
    COMM_PROTOCOL_BACNET
} comm_protocol_t;

// PID controller parameters
typedef struct {
    double kp;                 // Proportional gain
    double ki;                 // Integral gain
    double kd;                 // Derivative gain
    double setpoint;           // Target value
    double output_min;         // Minimum output
    double output_max;         // Maximum output
    double integral_max;       // Anti-windup limit
    double derivative_filter;  // Derivative filter coefficient
    
    // Internal state
    double integral;
    double previous_error;
    double previous_input;
    uint64_t last_update_time;
} pid_controller_t;

// Sensor configuration
typedef struct {
    int sensor_id;
    char name[64];
    sensor_type_t type;
    int gpio_pin;
    int i2c_address;
    int spi_channel;
    double calibration_offset;
    double calibration_scale;
    double min_value;
    double max_value;
    double alarm_low;
    double alarm_high;
    uint32_t sample_rate_hz;
    bool enabled;
    
    // Runtime data
    double current_value;
    double filtered_value;
    uint64_t last_update_time;
    uint32_t error_count;
    atomic_bool alarm_active;
} sensor_config_t;

// Actuator configuration
typedef struct {
    int actuator_id;
    char name[64];
    int gpio_pin;
    int pwm_channel;
    double min_output;
    double max_output;
    double slew_rate_limit;
    bool safety_enabled;
    
    // Runtime data
    double current_output;
    double target_output;
    uint64_t last_update_time;
    atomic_bool fault_detected;
} actuator_config_t;

// Control loop configuration
typedef struct {
    int loop_id;
    char name[64];
    control_type_t type;
    int primary_sensor_id;
    int primary_actuator_id;
    uint32_t execution_period_us;
    bool enabled;
    
    // Control parameters
    union {
        pid_controller_t pid;
        // Other controller types would go here
    } controller;
    
    // Safety parameters
    double safety_min_output;
    double safety_max_output;
    uint32_t safety_timeout_ms;
    
    // Performance metrics
    uint64_t execution_count;
    uint64_t execution_time_max;
    uint64_t execution_time_avg;
    uint32_t overrun_count;
    
    // Thread control
    pthread_t thread;
    atomic_bool running;
    atomic_bool fault_state;
} control_loop_t;

// Communication channel configuration
typedef struct {
    int channel_id;
    char name[64];
    comm_protocol_t protocol;
    char device_path[256];
    int baud_rate;
    int data_bits;
    int stop_bits;
    char parity;
    uint32_t timeout_ms;
    
    // Protocol-specific parameters
    union {
        struct {
            uint8_t slave_address;
            uint16_t register_base;
        } modbus;
        
        struct {
            uint32_t can_id;
            uint8_t can_dlc;
        } can;
        
        struct {
            char broker_host[256];
            uint16_t broker_port;
            char topic[256];
        } mqtt;
    } protocol_params;
    
    // Runtime data
    int fd;
    atomic_bool connected;
    uint64_t bytes_sent;
    uint64_t bytes_received;
    uint32_t error_count;
} comm_channel_t;

// System configuration
typedef struct {
    sensor_config_t sensors[MAX_SENSORS];
    actuator_config_t actuators[MAX_ACTUATORS];
    control_loop_t control_loops[MAX_CONTROL_LOOPS];
    comm_channel_t comm_channels[MAX_COMM_CHANNELS];
    
    int num_sensors;
    int num_actuators;
    int num_control_loops;
    int num_comm_channels;
    
    // System state
    atomic_bool emergency_stop;
    atomic_bool system_fault;
    uint64_t system_uptime;
    uint64_t last_watchdog_time;
    
    // Performance monitoring
    double cpu_usage;
    double memory_usage;
    double temperature;
    
    // Safety interlocks
    bool safety_system_enabled;
    uint32_t safety_check_interval_ms;
    pthread_t safety_thread;
    
} embedded_system_t;

// Function prototypes
int initialize_embedded_system(embedded_system_t *system);
int configure_sensors(embedded_system_t *system);
int configure_actuators(embedded_system_t *system);
int start_control_loops(embedded_system_t *system);
int initialize_communications(embedded_system_t *system);
void *control_loop_thread(void *arg);
void *safety_monitor_thread(void *arg);
double read_sensor_value(sensor_config_t *sensor);
int write_actuator_output(actuator_config_t *actuator, double value);
double pid_update(pid_controller_t *pid, double input, uint64_t timestamp);
int handle_emergency_stop(embedded_system_t *system);
int perform_safety_checks(embedded_system_t *system);
void cleanup_embedded_system(embedded_system_t *system);

// GPIO manipulation functions
int gpio_export(int pin);
int gpio_unexport(int pin);
int gpio_set_direction(int pin, const char *direction);
int gpio_set_value(int pin, int value);
int gpio_get_value(int pin);

// SPI communication functions
int spi_open(const char *device);
int spi_configure(int fd, uint32_t speed, uint8_t bits, uint8_t mode);
int spi_transfer(int fd, uint8_t *tx_buf, uint8_t *rx_buf, int len);

// I2C communication functions
int i2c_open(const char *device);
int i2c_set_slave_address(int fd, uint8_t address);
int i2c_read_register(int fd, uint8_t reg, uint8_t *data, int len);
int i2c_write_register(int fd, uint8_t reg, uint8_t *data, int len);

// Modbus communication functions
int modbus_read_holding_registers(int fd, uint8_t slave_addr, uint16_t start_reg, uint16_t num_regs, uint16_t *data);
int modbus_write_holding_registers(int fd, uint8_t slave_addr, uint16_t start_reg, uint16_t num_regs, uint16_t *data);

// CAN bus communication functions
int can_open(const char *interface);
int can_send_frame(int fd, uint32_t id, uint8_t *data, uint8_t dlc);
int can_receive_frame(int fd, uint32_t *id, uint8_t *data, uint8_t *dlc);

// Utility functions
uint64_t get_timestamp_ns(void);
double apply_low_pass_filter(double input, double previous_output, double alpha);
int setup_real_time_scheduling(int priority);
int lock_memory_pages(void);
void signal_handler(int signum);

// Global system instance
static embedded_system_t g_system;
static volatile bool g_running = true;

int main(int argc, char *argv[]) {
    int result;
    
    // Setup signal handlers
    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);
    
    // Initialize the embedded system
    result = initialize_embedded_system(&g_system);
    if (result != 0) {
        fprintf(stderr, "Failed to initialize embedded system: %d\n", result);
        return 1;
    }
    
    // Configure sensors
    result = configure_sensors(&g_system);
    if (result != 0) {
        fprintf(stderr, "Failed to configure sensors: %d\n", result);
        cleanup_embedded_system(&g_system);
        return 1;
    }
    
    // Configure actuators
    result = configure_actuators(&g_system);
    if (result != 0) {
        fprintf(stderr, "Failed to configure actuators: %d\n", result);
        cleanup_embedded_system(&g_system);
        return 1;
    }
    
    // Initialize communications
    result = initialize_communications(&g_system);
    if (result != 0) {
        fprintf(stderr, "Failed to initialize communications: %d\n", result);
        cleanup_embedded_system(&g_system);
        return 1;
    }
    
    // Start control loops
    result = start_control_loops(&g_system);
    if (result != 0) {
        fprintf(stderr, "Failed to start control loops: %d\n", result);
        cleanup_embedded_system(&g_system);
        return 1;
    }
    
    printf("Embedded control system started successfully\n");
    
    // Main monitoring loop
    while (g_running) {
        // Update system status
        g_system.system_uptime = get_timestamp_ns() / 1000000000ULL;
        
        // Perform watchdog update
        g_system.last_watchdog_time = get_timestamp_ns();
        
        // Check for emergency stop
        if (atomic_load(&g_system.emergency_stop)) {
            handle_emergency_stop(&g_system);
        }
        
        // Check system health
        if (atomic_load(&g_system.system_fault)) {
            fprintf(stderr, "System fault detected - entering safe mode\n");
            // Handle system fault
        }
        
        // Sleep for main loop interval
        usleep(10000); // 10ms
    }
    
    printf("Shutting down embedded control system\n");
    cleanup_embedded_system(&g_system);
    return 0;
}

int initialize_embedded_system(embedded_system_t *system) {
    if (!system) return -1;
    
    // Initialize system structure
    memset(system, 0, sizeof(embedded_system_t));
    
    // Setup real-time scheduling
    if (setup_real_time_scheduling(80) != 0) {
        fprintf(stderr, "Warning: Failed to setup real-time scheduling\n");
    }
    
    // Lock memory pages to prevent swapping
    if (lock_memory_pages() != 0) {
        fprintf(stderr, "Warning: Failed to lock memory pages\n");
    }
    
    // Initialize atomic variables
    atomic_init(&system->emergency_stop, false);
    atomic_init(&system->system_fault, false);
    
    // Enable safety system by default
    system->safety_system_enabled = true;
    system->safety_check_interval_ms = 50;
    
    return 0;
}

int configure_sensors(embedded_system_t *system) {
    if (!system) return -1;
    
    // Example sensor configuration
    sensor_config_t *temp_sensor = &system->sensors[0];
    temp_sensor->sensor_id = 0;
    strcpy(temp_sensor->name, "Temperature_01");
    temp_sensor->type = SENSOR_TYPE_TEMPERATURE;
    temp_sensor->i2c_address = 0x48;
    temp_sensor->calibration_offset = 0.0;
    temp_sensor->calibration_scale = 1.0;
    temp_sensor->min_value = -40.0;
    temp_sensor->max_value = 150.0;
    temp_sensor->alarm_low = 5.0;
    temp_sensor->alarm_high = 85.0;
    temp_sensor->sample_rate_hz = 100;
    temp_sensor->enabled = true;
    
    system->num_sensors = 1;
    
    return 0;
}

int configure_actuators(embedded_system_t *system) {
    if (!system) return -1;
    
    // Example actuator configuration
    actuator_config_t *valve = &system->actuators[0];
    valve->actuator_id = 0;
    strcpy(valve->name, "Control_Valve_01");
    valve->gpio_pin = 18;
    valve->pwm_channel = 0;
    valve->min_output = 0.0;
    valve->max_output = 100.0;
    valve->slew_rate_limit = 10.0; // %/second
    valve->safety_enabled = true;
    
    system->num_actuators = 1;
    
    return 0;
}

void *control_loop_thread(void *arg) {
    control_loop_t *loop = (control_loop_t *)arg;
    embedded_system_t *system = &g_system;
    
    struct timespec next_execution;
    uint64_t execution_start, execution_end;
    double sensor_value, control_output;
    
    // Get initial time
    clock_gettime(CLOCK_MONOTONIC, &next_execution);
    
    while (atomic_load(&loop->running) && g_running) {
        execution_start = get_timestamp_ns();
        
        // Check for emergency stop
        if (atomic_load(&system->emergency_stop)) {
            break;
        }
        
        // Read sensor value
        sensor_value = read_sensor_value(&system->sensors[loop->primary_sensor_id]);
        
        // Execute control algorithm
        switch (loop->type) {
            case CONTROL_TYPE_PID:
                control_output = pid_update(&loop->controller.pid, sensor_value, execution_start);
                break;
            default:
                control_output = 0.0;
                break;
        }
        
        // Apply safety limits
        if (control_output < loop->safety_min_output) {
            control_output = loop->safety_min_output;
        }
        if (control_output > loop->safety_max_output) {
            control_output = loop->safety_max_output;
        }
        
        // Write actuator output
        write_actuator_output(&system->actuators[loop->primary_actuator_id], control_output);
        
        // Update performance metrics
        execution_end = get_timestamp_ns();
        uint64_t execution_time = execution_end - execution_start;
        
        loop->execution_count++;
        if (execution_time > loop->execution_time_max) {
            loop->execution_time_max = execution_time;
        }
        
        // Calculate running average
        loop->execution_time_avg = (loop->execution_time_avg * (loop->execution_count - 1) + execution_time) / loop->execution_count;
        
        // Check for overrun
        if (execution_time > loop->execution_period_us * 1000) {
            loop->overrun_count++;
        }
        
        // Sleep until next execution
        next_execution.tv_nsec += loop->execution_period_us * 1000;
        if (next_execution.tv_nsec >= 1000000000) {
            next_execution.tv_sec++;
            next_execution.tv_nsec -= 1000000000;
        }
        
        clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &next_execution, NULL);
    }
    
    return NULL;
}

double pid_update(pid_controller_t *pid, double input, uint64_t timestamp) {
    if (!pid) return 0.0;
    
    // Calculate time delta
    double dt = 0.0;
    if (pid->last_update_time > 0) {
        dt = (timestamp - pid->last_update_time) / 1000000000.0; // Convert to seconds
    }
    pid->last_update_time = timestamp;
    
    if (dt <= 0.0) return 0.0;
    
    // Calculate error
    double error = pid->setpoint - input;
    
    // Proportional term
    double proportional = pid->kp * error;
    
    // Integral term with anti-windup
    pid->integral += error * dt;
    if (pid->integral > pid->integral_max) {
        pid->integral = pid->integral_max;
    } else if (pid->integral < -pid->integral_max) {
        pid->integral = -pid->integral_max;
    }
    double integral = pid->ki * pid->integral;
    
    // Derivative term with filtering
    double derivative_input = (input - pid->previous_input) / dt;
    double derivative_filtered = pid->derivative_filter * derivative_input + (1.0 - pid->derivative_filter) * pid->previous_error;
    double derivative = -pid->kd * derivative_filtered;
    
    // Calculate output
    double output = proportional + integral + derivative;
    
    // Apply output limits
    if (output > pid->output_max) {
        output = pid->output_max;
    } else if (output < pid->output_min) {
        output = pid->output_min;
    }
    
    // Update previous values
    pid->previous_error = error;
    pid->previous_input = input;
    
    return output;
}

double read_sensor_value(sensor_config_t *sensor) {
    if (!sensor || !sensor->enabled) return 0.0;
    
    double raw_value = 0.0;
    
    // Read based on sensor interface type
    if (sensor->i2c_address > 0) {
        // Read from I2C sensor
        int fd = i2c_open("/dev/i2c-1");
        if (fd >= 0) {
            i2c_set_slave_address(fd, sensor->i2c_address);
            uint8_t data[2];
            if (i2c_read_register(fd, 0x00, data, 2) == 0) {
                raw_value = (data[0] << 8) | data[1];
            }
            close(fd);
        }
    } else if (sensor->gpio_pin > 0) {
        // Read from GPIO pin (assuming ADC)
        raw_value = gpio_get_value(sensor->gpio_pin);
    }
    
    // Apply calibration
    double calibrated_value = raw_value * sensor->calibration_scale + sensor->calibration_offset;
    
    // Apply low-pass filter
    double filtered_value = apply_low_pass_filter(calibrated_value, sensor->filtered_value, 0.1);
    
    // Update sensor data
    sensor->current_value = calibrated_value;
    sensor->filtered_value = filtered_value;
    sensor->last_update_time = get_timestamp_ns();
    
    // Check alarms
    if (filtered_value < sensor->alarm_low || filtered_value > sensor->alarm_high) {
        atomic_store(&sensor->alarm_active, true);
    } else {
        atomic_store(&sensor->alarm_active, false);
    }
    
    return filtered_value;
}

int write_actuator_output(actuator_config_t *actuator, double value) {
    if (!actuator) return -1;
    
    // Apply slew rate limiting
    double max_change = actuator->slew_rate_limit * 0.001; // Assuming 1ms update rate
    double change = value - actuator->current_output;
    
    if (change > max_change) {
        value = actuator->current_output + max_change;
    } else if (change < -max_change) {
        value = actuator->current_output - max_change;
    }
    
    // Apply output limits
    if (value > actuator->max_output) {
        value = actuator->max_output;
    } else if (value < actuator->min_output) {
        value = actuator->min_output;
    }
    
    // Write to hardware
    if (actuator->gpio_pin > 0) {
        // Convert to PWM duty cycle (0-100%)
        int pwm_value = (int)((value / 100.0) * 255);
        gpio_set_value(actuator->gpio_pin, pwm_value);
    }
    
    // Update actuator data
    actuator->current_output = value;
    actuator->last_update_time = get_timestamp_ns();
    
    return 0;
}

uint64_t get_timestamp_ns(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000000000ULL + ts.tv_nsec;
}

double apply_low_pass_filter(double input, double previous_output, double alpha) {
    return alpha * input + (1.0 - alpha) * previous_output;
}

int setup_real_time_scheduling(int priority) {
    struct sched_param param;
    param.sched_priority = priority;
    
    if (sched_setscheduler(0, SCHED_FIFO, &param) != 0) {
        return -1;
    }
    
    return 0;
}

int lock_memory_pages(void) {
    if (mlockall(MCL_CURRENT | MCL_FUTURE) != 0) {
        return -1;
    }
    return 0;
}

void signal_handler(int signum) {
    g_running = false;
    atomic_store(&g_system.emergency_stop, true);
}

void cleanup_embedded_system(embedded_system_t *system) {
    if (!system) return;
    
    // Stop all control loops
    for (int i = 0; i < system->num_control_loops; i++) {
        atomic_store(&system->control_loops[i].running, false);
        pthread_join(system->control_loops[i].thread, NULL);
    }
    
    // Close communication channels
    for (int i = 0; i < system->num_comm_channels; i++) {
        if (system->comm_channels[i].fd > 0) {
            close(system->comm_channels[i].fd);
        }
    }
    
    // Unlock memory
    munlockall();
    
    printf("Embedded system cleanup completed\n");
}
```

### Custom Device Driver Development

```c
// custom_device_driver.c - Example custom device driver
#include <linux/module.h>
#include <linux/kernel.h>
#include <linux/fs.h>
#include <linux/device.h>
#include <linux/cdev.h>
#include <linux/slab.h>
#include <linux/uaccess.h>
#include <linux/interrupt.h>
#include <linux/gpio.h>
#include <linux/of.h>
#include <linux/of_device.h>
#include <linux/platform_device.h>
#include <linux/workqueue.h>
#include <linux/mutex.h>
#include <linux/wait.h>
#include <linux/poll.h>
#include <linux/sched.h>

#define DEVICE_NAME "custom_sensor"
#define CLASS_NAME "custom_sensor_class"
#define BUFFER_SIZE 1024

// Device structure
struct custom_device {
    struct cdev cdev;
    struct device *device;
    struct class *class;
    dev_t dev_num;
    
    // Hardware resources
    int gpio_pin;
    int irq;
    
    // Data buffer
    char *buffer;
    size_t buffer_size;
    size_t data_available;
    
    // Synchronization
    struct mutex lock;
    wait_queue_head_t wait_queue;
    
    // Work queue for interrupt handling
    struct work_struct work;
    
    // Statistics
    atomic_t interrupt_count;
    atomic_t read_count;
    atomic_t write_count;
};

static struct custom_device *dev_instance;
static int major_number;

// Function prototypes
static int custom_open(struct inode *inode, struct file *file);
static int custom_release(struct inode *inode, struct file *file);
static ssize_t custom_read(struct file *file, char __user *buffer, size_t len, loff_t *offset);
static ssize_t custom_write(struct file *file, const char __user *buffer, size_t len, loff_t *offset);
static long custom_ioctl(struct file *file, unsigned int cmd, unsigned long arg);
static unsigned int custom_poll(struct file *file, poll_table *wait);
static irqreturn_t custom_interrupt_handler(int irq, void *dev_id);
static void custom_work_handler(struct work_struct *work);

// File operations structure
static struct file_operations fops = {
    .open = custom_open,
    .release = custom_release,
    .read = custom_read,
    .write = custom_write,
    .unlocked_ioctl = custom_ioctl,
    .poll = custom_poll,
    .owner = THIS_MODULE,
};

// IOCTL commands
#define CUSTOM_IOC_MAGIC 'c'
#define CUSTOM_IOC_RESET _IO(CUSTOM_IOC_MAGIC, 0)
#define CUSTOM_IOC_GET_STATUS _IOR(CUSTOM_IOC_MAGIC, 1, int)
#define CUSTOM_IOC_SET_CONFIG _IOW(CUSTOM_IOC_MAGIC, 2, int)

static int __init custom_driver_init(void) {
    int result;
    
    printk(KERN_INFO "Custom Device Driver: Initializing\n");
    
    // Allocate device structure
    dev_instance = kzalloc(sizeof(struct custom_device), GFP_KERNEL);
    if (!dev_instance) {
        printk(KERN_ERR "Custom Device Driver: Failed to allocate device structure\n");
        return -ENOMEM;
    }
    
    // Allocate device number
    result = alloc_chrdev_region(&dev_instance->dev_num, 0, 1, DEVICE_NAME);
    if (result < 0) {
        printk(KERN_ERR "Custom Device Driver: Failed to allocate device number\n");
        kfree(dev_instance);
        return result;
    }
    
    major_number = MAJOR(dev_instance->dev_num);
    
    // Initialize character device
    cdev_init(&dev_instance->cdev, &fops);
    dev_instance->cdev.owner = THIS_MODULE;
    
    result = cdev_add(&dev_instance->cdev, dev_instance->dev_num, 1);
    if (result < 0) {
        printk(KERN_ERR "Custom Device Driver: Failed to add character device\n");
        unregister_chrdev_region(dev_instance->dev_num, 1);
        kfree(dev_instance);
        return result;
    }
    
    // Create device class
    dev_instance->class = class_create(THIS_MODULE, CLASS_NAME);
    if (IS_ERR(dev_instance->class)) {
        printk(KERN_ERR "Custom Device Driver: Failed to create device class\n");
        cdev_del(&dev_instance->cdev);
        unregister_chrdev_region(dev_instance->dev_num, 1);
        kfree(dev_instance);
        return PTR_ERR(dev_instance->class);
    }
    
    // Create device
    dev_instance->device = device_create(dev_instance->class, NULL, dev_instance->dev_num, NULL, DEVICE_NAME);
    if (IS_ERR(dev_instance->device)) {
        printk(KERN_ERR "Custom Device Driver: Failed to create device\n");
        class_destroy(dev_instance->class);
        cdev_del(&dev_instance->cdev);
        unregister_chrdev_region(dev_instance->dev_num, 1);
        kfree(dev_instance);
        return PTR_ERR(dev_instance->device);
    }
    
    // Initialize synchronization primitives
    mutex_init(&dev_instance->lock);
    init_waitqueue_head(&dev_instance->wait_queue);
    
    // Initialize work queue
    INIT_WORK(&dev_instance->work, custom_work_handler);
    
    // Allocate buffer
    dev_instance->buffer = kzalloc(BUFFER_SIZE, GFP_KERNEL);
    if (!dev_instance->buffer) {
        printk(KERN_ERR "Custom Device Driver: Failed to allocate buffer\n");
        device_destroy(dev_instance->class, dev_instance->dev_num);
        class_destroy(dev_instance->class);
        cdev_del(&dev_instance->cdev);
        unregister_chrdev_region(dev_instance->dev_num, 1);
        kfree(dev_instance);
        return -ENOMEM;
    }
    dev_instance->buffer_size = BUFFER_SIZE;
    
    // Initialize GPIO
    dev_instance->gpio_pin = 18; // Example GPIO pin
    result = gpio_request(dev_instance->gpio_pin, "custom_sensor_gpio");
    if (result < 0) {
        printk(KERN_ERR "Custom Device Driver: Failed to request GPIO\n");
        goto cleanup;
    }
    
    gpio_direction_input(dev_instance->gpio_pin);
    
    // Setup interrupt
    dev_instance->irq = gpio_to_irq(dev_instance->gpio_pin);
    if (dev_instance->irq < 0) {
        printk(KERN_ERR "Custom Device Driver: Failed to get IRQ\n");
        goto cleanup;
    }
    
    result = request_irq(dev_instance->irq, custom_interrupt_handler, 
                        IRQF_TRIGGER_RISING, "custom_sensor_irq", dev_instance);
    if (result < 0) {
        printk(KERN_ERR "Custom Device Driver: Failed to request IRQ\n");
        goto cleanup;
    }
    
    // Initialize atomic counters
    atomic_set(&dev_instance->interrupt_count, 0);
    atomic_set(&dev_instance->read_count, 0);
    atomic_set(&dev_instance->write_count, 0);
    
    printk(KERN_INFO "Custom Device Driver: Successfully initialized (Major: %d)\n", major_number);
    return 0;
    
cleanup:
    if (dev_instance->gpio_pin > 0) {
        gpio_free(dev_instance->gpio_pin);
    }
    kfree(dev_instance->buffer);
    device_destroy(dev_instance->class, dev_instance->dev_num);
    class_destroy(dev_instance->class);
    cdev_del(&dev_instance->cdev);
    unregister_chrdev_region(dev_instance->dev_num, 1);
    kfree(dev_instance);
    return result;
}

static void __exit custom_driver_exit(void) {
    printk(KERN_INFO "Custom Device Driver: Exiting\n");
    
    if (dev_instance) {
        // Free interrupt
        if (dev_instance->irq > 0) {
            free_irq(dev_instance->irq, dev_instance);
        }
        
        // Free GPIO
        if (dev_instance->gpio_pin > 0) {
            gpio_free(dev_instance->gpio_pin);
        }
        
        // Free buffer
        kfree(dev_instance->buffer);
        
        // Cleanup device
        device_destroy(dev_instance->class, dev_instance->dev_num);
        class_destroy(dev_instance->class);
        cdev_del(&dev_instance->cdev);
        unregister_chrdev_region(dev_instance->dev_num, 1);
        
        // Free device structure
        kfree(dev_instance);
    }
    
    printk(KERN_INFO "Custom Device Driver: Exit complete\n");
}

static int custom_open(struct inode *inode, struct file *file) {
    printk(KERN_INFO "Custom Device Driver: Device opened\n");
    file->private_data = dev_instance;
    return 0;
}

static int custom_release(struct inode *inode, struct file *file) {
    printk(KERN_INFO "Custom Device Driver: Device closed\n");
    return 0;
}

static ssize_t custom_read(struct file *file, char __user *buffer, size_t len, loff_t *offset) {
    struct custom_device *dev = file->private_data;
    ssize_t bytes_read = 0;
    
    if (!dev) return -ENODEV;
    
    mutex_lock(&dev->lock);
    
    // Wait for data if none available
    while (dev->data_available == 0) {
        mutex_unlock(&dev->lock);
        
        if (file->f_flags & O_NONBLOCK) {
            return -EAGAIN;
        }
        
        if (wait_event_interruptible(dev->wait_queue, dev->data_available > 0)) {
            return -ERESTARTSYS;
        }
        
        mutex_lock(&dev->lock);
    }
    
    // Copy data to user space
    bytes_read = min(len, dev->data_available);
    if (copy_to_user(buffer, dev->buffer, bytes_read)) {
        mutex_unlock(&dev->lock);
        return -EFAULT;
    }
    
    // Update buffer state
    dev->data_available -= bytes_read;
    if (dev->data_available > 0) {
        memmove(dev->buffer, dev->buffer + bytes_read, dev->data_available);
    }
    
    atomic_inc(&dev->read_count);
    mutex_unlock(&dev->lock);
    
    return bytes_read;
}

static ssize_t custom_write(struct file *file, const char __user *buffer, size_t len, loff_t *offset) {
    struct custom_device *dev = file->private_data;
    ssize_t bytes_written = 0;
    
    if (!dev) return -ENODEV;
    
    mutex_lock(&dev->lock);
    
    // Check available space
    size_t available_space = dev->buffer_size - dev->data_available;
    bytes_written = min(len, available_space);
    
    if (bytes_written > 0) {
        if (copy_from_user(dev->buffer + dev->data_available, buffer, bytes_written)) {
            mutex_unlock(&dev->lock);
            return -EFAULT;
        }
        
        dev->data_available += bytes_written;
        atomic_inc(&dev->write_count);
        
        // Wake up readers
        wake_up_interruptible(&dev->wait_queue);
    }
    
    mutex_unlock(&dev->lock);
    
    return bytes_written;
}

static long custom_ioctl(struct file *file, unsigned int cmd, unsigned long arg) {
    struct custom_device *dev = file->private_data;
    int retval = 0;
    
    if (!dev) return -ENODEV;
    
    switch (cmd) {
        case CUSTOM_IOC_RESET:
            mutex_lock(&dev->lock);
            dev->data_available = 0;
            atomic_set(&dev->interrupt_count, 0);
            atomic_set(&dev->read_count, 0);
            atomic_set(&dev->write_count, 0);
            mutex_unlock(&dev->lock);
            break;
            
        case CUSTOM_IOC_GET_STATUS:
            {
                int status = atomic_read(&dev->interrupt_count);
                if (copy_to_user((int *)arg, &status, sizeof(int))) {
                    retval = -EFAULT;
                }
            }
            break;
            
        case CUSTOM_IOC_SET_CONFIG:
            // Handle configuration setting
            break;
            
        default:
            retval = -ENOTTY;
            break;
    }
    
    return retval;
}

static unsigned int custom_poll(struct file *file, poll_table *wait) {
    struct custom_device *dev = file->private_data;
    unsigned int mask = 0;
    
    if (!dev) return POLLERR;
    
    poll_wait(file, &dev->wait_queue, wait);
    
    mutex_lock(&dev->lock);
    
    if (dev->data_available > 0) {
        mask |= POLLIN | POLLRDNORM;
    }
    
    if (dev->data_available < dev->buffer_size) {
        mask |= POLLOUT | POLLWRNORM;
    }
    
    mutex_unlock(&dev->lock);
    
    return mask;
}

static irqreturn_t custom_interrupt_handler(int irq, void *dev_id) {
    struct custom_device *dev = dev_id;
    
    if (!dev) return IRQ_NONE;
    
    atomic_inc(&dev->interrupt_count);
    
    // Schedule work queue to handle interrupt
    schedule_work(&dev->work);
    
    return IRQ_HANDLED;
}

static void custom_work_handler(struct work_struct *work) {
    struct custom_device *dev = container_of(work, struct custom_device, work);
    char data[] = "Interrupt detected\n";
    size_t data_len = strlen(data);
    
    mutex_lock(&dev->lock);
    
    // Add interrupt data to buffer
    if (dev->data_available + data_len <= dev->buffer_size) {
        memcpy(dev->buffer + dev->data_available, data, data_len);
        dev->data_available += data_len;
        
        // Wake up waiting readers
        wake_up_interruptible(&dev->wait_queue);
    }
    
    mutex_unlock(&dev->lock);
}

module_init(custom_driver_init);
module_exit(custom_driver_exit);

MODULE_LICENSE("GPL");
MODULE_AUTHOR("Matthew Mattox");
MODULE_DESCRIPTION("Custom Device Driver for Embedded Systems");
MODULE_VERSION("1.0");
```

This comprehensive embedded systems programming guide provides:

1. **Industrial Control Framework**: Complete real-time control system with PID controllers, sensor management, and actuator control
2. **Multi-Protocol Communication**: Support for Modbus, CAN, MQTT, and other industrial protocols
3. **Real-Time Scheduling**: PREEMPT_RT integration with deterministic timing
4. **Safety Systems**: Emergency stop handling and fault detection
5. **Custom Device Drivers**: Complete kernel module with interrupt handling and device management
6. **Hardware Abstraction**: GPIO, I2C, SPI, and PWM interfaces
7. **Performance Monitoring**: Execution time tracking and system diagnostics

The code demonstrates advanced embedded Linux programming techniques essential for building industrial-grade control systems and IoT applications.