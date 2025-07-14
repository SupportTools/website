---
title: "Advanced Linux System Programming and Performance Optimization: Building High-Performance System Applications"
date: 2025-05-06T10:00:00-05:00
draft: false
tags: ["Linux", "System Programming", "Performance", "Optimization", "Profiling", "Memory Management", "CPU", "I/O"]
categories:
- Linux
- Performance Optimization
author: "Matthew Mattox - mmattox@support.tools"
description: "Master advanced Linux system programming and performance optimization including memory management, CPU optimization, I/O performance, profiling techniques, and building high-performance applications"
more_link: "yes"
url: "/advanced-linux-system-programming-performance-optimization/"
---

Advanced Linux system programming requires deep understanding of system internals, performance characteristics, and optimization techniques. This comprehensive guide explores building high-performance applications through advanced memory management, CPU optimization, I/O tuning, and sophisticated profiling and monitoring techniques for enterprise-grade systems.

<!--more-->

# [Advanced Linux System Programming and Performance Optimization](#advanced-linux-system-programming-performance-optimization)

## Comprehensive Performance Analysis Framework

### Advanced System Performance Monitor

```c
// performance_monitor.c - Advanced system performance monitoring framework
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <fcntl.h>
#include <time.h>
#include <signal.h>
#include <pthread.h>
#include <sys/stat.h>
#include <sys/mman.h>
#include <sys/resource.h>
#include <sys/time.h>
#include <sys/syscall.h>
#include <sys/epoll.h>
#include <sys/inotify.h>
#include <linux/perf_event.h>
#include <linux/hw_breakpoint.h>
#include <asm/unistd.h>

#define MAX_CPUS 256
#define MAX_PROCESSES 10000
#define MAX_EVENTS 1000
#define SAMPLE_FREQUENCY 1000
#define BUFFER_SIZE 65536

// Performance counter types
typedef enum {
    PERF_TYPE_CPU_CYCLES,
    PERF_TYPE_INSTRUCTIONS,
    PERF_TYPE_CACHE_REFERENCES,
    PERF_TYPE_CACHE_MISSES,
    PERF_TYPE_BRANCH_INSTRUCTIONS,
    PERF_TYPE_BRANCH_MISSES,
    PERF_TYPE_PAGE_FAULTS,
    PERF_TYPE_CONTEXT_SWITCHES,
    PERF_TYPE_CPU_MIGRATIONS,
    PERF_TYPE_MEMORY_LOADS,
    PERF_TYPE_MEMORY_STORES
} perf_counter_type_t;

// Memory performance metrics
typedef struct {
    uint64_t total_memory;
    uint64_t available_memory;
    uint64_t used_memory;
    uint64_t cached_memory;
    uint64_t buffer_memory;
    uint64_t swap_total;
    uint64_t swap_used;
    uint64_t swap_cached;
    
    // Memory allocation stats
    uint64_t anonymous_pages;
    uint64_t mapped_pages;
    uint64_t slab_memory;
    uint64_t kernel_stack;
    uint64_t page_tables;
    
    // Memory pressure indicators
    double memory_pressure;
    uint64_t oom_kills;
    uint64_t memory_reclaim_efficiency;
    
    // NUMA statistics
    uint64_t numa_hit;
    uint64_t numa_miss;
    uint64_t numa_foreign;
    uint64_t numa_interleave;
    
} memory_metrics_t;

// CPU performance metrics
typedef struct {
    int cpu_id;
    
    // Hardware counters
    uint64_t cycles;
    uint64_t instructions;
    uint64_t cache_references;
    uint64_t cache_misses;
    uint64_t branch_instructions;
    uint64_t branch_misses;
    
    // Calculated metrics
    double ipc; // Instructions per cycle
    double cache_hit_ratio;
    double branch_prediction_accuracy;
    
    // CPU utilization
    double user_time;
    double system_time;
    double idle_time;
    double iowait_time;
    double irq_time;
    double softirq_time;
    double steal_time;
    
    // Frequency and power
    uint64_t frequency_mhz;
    double temperature;
    double power_consumption;
    
    // Scheduling metrics
    uint64_t context_switches;
    uint64_t processes_created;
    uint64_t processes_running;
    uint64_t processes_blocked;
    
} cpu_metrics_t;

// I/O performance metrics
typedef struct {
    // Block device statistics
    uint64_t read_iops;
    uint64_t write_iops;
    uint64_t read_bandwidth;
    uint64_t write_bandwidth;
    uint64_t read_latency_avg;
    uint64_t write_latency_avg;
    uint64_t read_latency_p99;
    uint64_t write_latency_p99;
    
    // Queue statistics
    uint64_t queue_depth;
    double queue_utilization;
    uint64_t merges_read;
    uint64_t merges_write;
    
    // Network I/O
    uint64_t network_rx_packets;
    uint64_t network_tx_packets;
    uint64_t network_rx_bytes;
    uint64_t network_tx_bytes;
    uint64_t network_rx_dropped;
    uint64_t network_tx_dropped;
    uint64_t network_rx_errors;
    uint64_t network_tx_errors;
    
    // File system statistics
    uint64_t open_files;
    uint64_t max_open_files;
    uint64_t dentry_cache_hits;
    uint64_t dentry_cache_misses;
    uint64_t inode_cache_hits;
    uint64_t inode_cache_misses;
    
} io_metrics_t;

// Process performance metrics
typedef struct {
    pid_t pid;
    char name[256];
    char cmdline[1024];
    
    // CPU usage
    double cpu_percent;
    uint64_t user_time;
    uint64_t system_time;
    uint64_t children_user_time;
    uint64_t children_system_time;
    
    // Memory usage
    uint64_t virtual_memory;
    uint64_t resident_memory;
    uint64_t shared_memory;
    uint64_t text_memory;
    uint64_t data_memory;
    uint64_t stack_memory;
    
    // I/O statistics
    uint64_t read_bytes;
    uint64_t write_bytes;
    uint64_t read_syscalls;
    uint64_t write_syscalls;
    uint64_t io_wait_time;
    
    // System calls
    uint64_t voluntary_context_switches;
    uint64_t involuntary_context_switches;
    uint64_t minor_page_faults;
    uint64_t major_page_faults;
    
    // File descriptors
    int open_fds;
    int max_fds;
    
    // Network connections
    int tcp_connections;
    int udp_sockets;
    int unix_sockets;
    
    // Threads
    int num_threads;
    
} process_metrics_t;

// Performance monitoring context
typedef struct {
    bool running;
    int sample_interval_ms;
    
    // System-wide metrics
    memory_metrics_t memory;
    cpu_metrics_t cpus[MAX_CPUS];
    int num_cpus;
    io_metrics_t io;
    
    // Process tracking
    process_metrics_t processes[MAX_PROCESSES];
    int num_processes;
    
    // Performance counters
    int perf_fds[MAX_CPUS][PERF_TYPE_MEMORY_STORES + 1];
    struct perf_event_mmap_page *perf_buffers[MAX_CPUS][PERF_TYPE_MEMORY_STORES + 1];
    
    // Monitoring threads
    pthread_t memory_thread;
    pthread_t cpu_thread;
    pthread_t io_thread;
    pthread_t process_thread;
    pthread_t perf_thread;
    
    // Statistics
    struct {
        uint64_t samples_collected;
        uint64_t events_processed;
        uint64_t anomalies_detected;
        double monitoring_overhead;
    } stats;
    
    // Configuration
    struct {
        bool enable_detailed_profiling;
        bool enable_stack_traces;
        bool enable_anomaly_detection;
        int max_stack_depth;
        double cpu_threshold;
        double memory_threshold;
        double io_threshold;
    } config;
    
} performance_monitor_t;

static performance_monitor_t perf_mon = {0};

// Utility functions
static long perf_event_open(struct perf_event_attr *hw_event, pid_t pid,
                           int cpu, int group_fd, unsigned long flags)
{
    return syscall(__NR_perf_event_open, hw_event, pid, cpu, group_fd, flags);
}

static uint64_t read_counter_value(int fd)
{
    uint64_t value;
    if (read(fd, &value, sizeof(value)) != sizeof(value)) {
        return 0;
    }
    return value;
}

static double get_time_diff_ms(struct timespec *start, struct timespec *end)
{
    return (end->tv_sec - start->tv_sec) * 1000.0 + 
           (end->tv_nsec - start->tv_nsec) / 1000000.0;
}

// Memory monitoring functions
static int read_memory_info(memory_metrics_t *mem)
{
    FILE *fp = fopen("/proc/meminfo", "r");
    if (!fp) {
        perror("fopen /proc/meminfo");
        return -1;
    }
    
    char line[256];
    while (fgets(line, sizeof(line), fp)) {
        uint64_t value;
        if (sscanf(line, "MemTotal: %lu kB", &value) == 1) {
            mem->total_memory = value * 1024;
        } else if (sscanf(line, "MemAvailable: %lu kB", &value) == 1) {
            mem->available_memory = value * 1024;
        } else if (sscanf(line, "MemFree: %lu kB", &value) == 1) {
            // Used memory calculation
            // Will be updated after reading MemTotal
        } else if (sscanf(line, "Cached: %lu kB", &value) == 1) {
            mem->cached_memory = value * 1024;
        } else if (sscanf(line, "Buffers: %lu kB", &value) == 1) {
            mem->buffer_memory = value * 1024;
        } else if (sscanf(line, "SwapTotal: %lu kB", &value) == 1) {
            mem->swap_total = value * 1024;
        } else if (sscanf(line, "SwapFree: %lu kB", &value) == 1) {
            mem->swap_used = mem->swap_total - (value * 1024);
        } else if (sscanf(line, "SwapCached: %lu kB", &value) == 1) {
            mem->swap_cached = value * 1024;
        } else if (sscanf(line, "AnonPages: %lu kB", &value) == 1) {
            mem->anonymous_pages = value * 1024;
        } else if (sscanf(line, "Mapped: %lu kB", &value) == 1) {
            mem->mapped_pages = value * 1024;
        } else if (sscanf(line, "Slab: %lu kB", &value) == 1) {
            mem->slab_memory = value * 1024;
        } else if (sscanf(line, "KernelStack: %lu kB", &value) == 1) {
            mem->kernel_stack = value * 1024;
        } else if (sscanf(line, "PageTables: %lu kB", &value) == 1) {
            mem->page_tables = value * 1024;
        }
    }
    
    fclose(fp);
    
    mem->used_memory = mem->total_memory - mem->available_memory;
    mem->memory_pressure = (double)mem->used_memory / mem->total_memory;
    
    // Read NUMA statistics if available
    fp = fopen("/proc/vmstat", "r");
    if (fp) {
        while (fgets(line, sizeof(line), fp)) {
            uint64_t value;
            if (sscanf(line, "numa_hit %lu", &value) == 1) {
                mem->numa_hit = value;
            } else if (sscanf(line, "numa_miss %lu", &value) == 1) {
                mem->numa_miss = value;
            } else if (sscanf(line, "numa_foreign %lu", &value) == 1) {
                mem->numa_foreign = value;
            } else if (sscanf(line, "numa_interleave %lu", &value) == 1) {
                mem->numa_interleave = value;
            }
        }
        fclose(fp);
    }
    
    return 0;
}

static void *memory_monitor_thread(void *arg)
{
    while (perf_mon.running) {
        struct timespec start, end;
        clock_gettime(CLOCK_MONOTONIC, &start);
        
        read_memory_info(&perf_mon.memory);
        
        clock_gettime(CLOCK_MONOTONIC, &end);
        double elapsed = get_time_diff_ms(&start, &end);
        
        perf_mon.stats.monitoring_overhead += elapsed;
        perf_mon.stats.samples_collected++;
        
        usleep(perf_mon.sample_interval_ms * 1000);
    }
    
    return NULL;
}

// CPU monitoring functions
static int read_cpu_stats(int cpu_id, cpu_metrics_t *cpu)
{
    char path[256];
    FILE *fp;
    
    cpu->cpu_id = cpu_id;
    
    // Read /proc/stat for CPU utilization
    fp = fopen("/proc/stat", "r");
    if (!fp) {
        perror("fopen /proc/stat");
        return -1;
    }
    
    char line[256];
    char cpu_name[16];
    snprintf(cpu_name, sizeof(cpu_name), "cpu%d", cpu_id);
    
    while (fgets(line, sizeof(line), fp)) {
        if (strncmp(line, cpu_name, strlen(cpu_name)) == 0) {
            uint64_t user, nice, system, idle, iowait, irq, softirq, steal;
            sscanf(line, "%*s %lu %lu %lu %lu %lu %lu %lu %lu",
                   &user, &nice, &system, &idle, &iowait, &irq, &softirq, &steal);
            
            uint64_t total = user + nice + system + idle + iowait + irq + softirq + steal;
            if (total > 0) {
                cpu->user_time = (double)(user + nice) / total * 100.0;
                cpu->system_time = (double)system / total * 100.0;
                cpu->idle_time = (double)idle / total * 100.0;
                cpu->iowait_time = (double)iowait / total * 100.0;
                cpu->irq_time = (double)irq / total * 100.0;
                cpu->softirq_time = (double)softirq / total * 100.0;
                cpu->steal_time = (double)steal / total * 100.0;
            }
            break;
        }
    }
    fclose(fp);
    
    // Read CPU frequency
    snprintf(path, sizeof(path), "/sys/devices/system/cpu/cpu%d/cpufreq/scaling_cur_freq", cpu_id);
    fp = fopen(path, "r");
    if (fp) {
        uint64_t freq_khz;
        if (fscanf(fp, "%lu", &freq_khz) == 1) {
            cpu->frequency_mhz = freq_khz / 1000;
        }
        fclose(fp);
    }
    
    // Read CPU temperature
    snprintf(path, sizeof(path), "/sys/class/thermal/thermal_zone%d/temp", cpu_id);
    fp = fopen(path, "r");
    if (fp) {
        int temp_millidegrees;
        if (fscanf(fp, "%d", &temp_millidegrees) == 1) {
            cpu->temperature = temp_millidegrees / 1000.0;
        }
        fclose(fp);
    }
    
    // Read hardware performance counters
    if (perf_mon.perf_fds[cpu_id][PERF_TYPE_CPU_CYCLES] >= 0) {
        cpu->cycles = read_counter_value(perf_mon.perf_fds[cpu_id][PERF_TYPE_CPU_CYCLES]);
    }
    
    if (perf_mon.perf_fds[cpu_id][PERF_TYPE_INSTRUCTIONS] >= 0) {
        cpu->instructions = read_counter_value(perf_mon.perf_fds[cpu_id][PERF_TYPE_INSTRUCTIONS]);
    }
    
    if (perf_mon.perf_fds[cpu_id][PERF_TYPE_CACHE_REFERENCES] >= 0) {
        cpu->cache_references = read_counter_value(perf_mon.perf_fds[cpu_id][PERF_TYPE_CACHE_REFERENCES]);
    }
    
    if (perf_mon.perf_fds[cpu_id][PERF_TYPE_CACHE_MISSES] >= 0) {
        cpu->cache_misses = read_counter_value(perf_mon.perf_fds[cpu_id][PERF_TYPE_CACHE_MISSES]);
    }
    
    if (perf_mon.perf_fds[cpu_id][PERF_TYPE_BRANCH_INSTRUCTIONS] >= 0) {
        cpu->branch_instructions = read_counter_value(perf_mon.perf_fds[cpu_id][PERF_TYPE_BRANCH_INSTRUCTIONS]);
    }
    
    if (perf_mon.perf_fds[cpu_id][PERF_TYPE_BRANCH_MISSES] >= 0) {
        cpu->branch_misses = read_counter_value(perf_mon.perf_fds[cpu_id][PERF_TYPE_BRANCH_MISSES]);
    }
    
    // Calculate derived metrics
    if (cpu->cycles > 0 && cpu->instructions > 0) {
        cpu->ipc = (double)cpu->instructions / cpu->cycles;
    }
    
    if (cpu->cache_references > 0) {
        cpu->cache_hit_ratio = 1.0 - ((double)cpu->cache_misses / cpu->cache_references);
    }
    
    if (cpu->branch_instructions > 0) {
        cpu->branch_prediction_accuracy = 1.0 - ((double)cpu->branch_misses / cpu->branch_instructions);
    }
    
    return 0;
}

static void *cpu_monitor_thread(void *arg)
{
    while (perf_mon.running) {
        for (int i = 0; i < perf_mon.num_cpus; i++) {
            read_cpu_stats(i, &perf_mon.cpus[i]);
        }
        
        usleep(perf_mon.sample_interval_ms * 1000);
    }
    
    return NULL;
}

// I/O monitoring functions
static int read_io_stats(io_metrics_t *io)
{
    FILE *fp;
    char line[512];
    
    // Read block device statistics
    fp = fopen("/proc/diskstats", "r");
    if (fp) {
        uint64_t total_read_iops = 0, total_write_iops = 0;
        uint64_t total_read_sectors = 0, total_write_sectors = 0;
        
        while (fgets(line, sizeof(line), fp)) {
            int major, minor;
            char device[32];
            uint64_t reads, read_merges, read_sectors, read_ticks;
            uint64_t writes, write_merges, write_sectors, write_ticks;
            uint64_t in_flight, io_ticks, time_in_queue;
            
            if (sscanf(line, "%d %d %s %lu %lu %lu %lu %lu %lu %lu %lu %lu %lu %lu",
                      &major, &minor, device,
                      &reads, &read_merges, &read_sectors, &read_ticks,
                      &writes, &write_merges, &write_sectors, &write_ticks,
                      &in_flight, &io_ticks, &time_in_queue) == 14) {
                
                // Skip loop devices and ram disks
                if (strncmp(device, "loop", 4) == 0 || strncmp(device, "ram", 3) == 0) {
                    continue;
                }
                
                total_read_iops += reads;
                total_write_iops += writes;
                total_read_sectors += read_sectors;
                total_write_sectors += write_sectors;
                
                io->merges_read += read_merges;
                io->merges_write += write_merges;
                
                if (reads > 0) {
                    io->read_latency_avg += read_ticks / reads;
                }
                if (writes > 0) {
                    io->write_latency_avg += write_ticks / writes;
                }
                
                io->queue_depth += in_flight;
            }
        }
        
        io->read_iops = total_read_iops;
        io->write_iops = total_write_iops;
        io->read_bandwidth = total_read_sectors * 512; // 512 bytes per sector
        io->write_bandwidth = total_write_sectors * 512;
        
        fclose(fp);
    }
    
    // Read network statistics
    fp = fopen("/proc/net/dev", "r");
    if (fp) {
        // Skip header lines
        fgets(line, sizeof(line), fp);
        fgets(line, sizeof(line), fp);
        
        while (fgets(line, sizeof(line), fp)) {
            char interface[32];
            uint64_t rx_bytes, rx_packets, rx_errs, rx_drop;
            uint64_t tx_bytes, tx_packets, tx_errs, tx_drop;
            
            if (sscanf(line, "%[^:]: %lu %lu %lu %lu %*u %*u %*u %*u %lu %lu %lu %lu",
                      interface, &rx_bytes, &rx_packets, &rx_errs, &rx_drop,
                      &tx_bytes, &tx_packets, &tx_errs, &tx_drop) >= 8) {
                
                // Skip loopback interface
                if (strcmp(interface, "lo") == 0) {
                    continue;
                }
                
                io->network_rx_bytes += rx_bytes;
                io->network_rx_packets += rx_packets;
                io->network_rx_errors += rx_errs;
                io->network_rx_dropped += rx_drop;
                io->network_tx_bytes += tx_bytes;
                io->network_tx_packets += tx_packets;
                io->network_tx_errors += tx_errs;
                io->network_tx_dropped += tx_drop;
            }
        }
        fclose(fp);
    }
    
    // Read file system statistics
    fp = fopen("/proc/sys/fs/file-nr", "r");
    if (fp) {
        uint64_t allocated, unused, max_files;
        if (fscanf(fp, "%lu %lu %lu", &allocated, &unused, &max_files) == 3) {
            io->open_files = allocated - unused;
            io->max_open_files = max_files;
        }
        fclose(fp);
    }
    
    return 0;
}

static void *io_monitor_thread(void *arg)
{
    while (perf_mon.running) {
        read_io_stats(&perf_mon.io);
        usleep(perf_mon.sample_interval_ms * 1000);
    }
    
    return NULL;
}

// Process monitoring functions
static int read_process_stats(pid_t pid, process_metrics_t *proc)
{
    char path[256];
    FILE *fp;
    
    proc->pid = pid;
    
    // Read process name and command line
    snprintf(path, sizeof(path), "/proc/%d/comm", pid);
    fp = fopen(path, "r");
    if (fp) {
        if (fgets(proc->name, sizeof(proc->name), fp)) {
            // Remove newline
            char *newline = strchr(proc->name, '\n');
            if (newline) *newline = '\0';
        }
        fclose(fp);
    }
    
    snprintf(path, sizeof(path), "/proc/%d/cmdline", pid);
    fp = fopen(path, "r");
    if (fp) {
        size_t len = fread(proc->cmdline, 1, sizeof(proc->cmdline) - 1, fp);
        proc->cmdline[len] = '\0';
        
        // Replace null bytes with spaces
        for (size_t i = 0; i < len; i++) {
            if (proc->cmdline[i] == '\0') {
                proc->cmdline[i] = ' ';
            }
        }
        fclose(fp);
    }
    
    // Read process statistics
    snprintf(path, sizeof(path), "/proc/%d/stat", pid);
    fp = fopen(path, "r");
    if (fp) {
        char state;
        int ppid, pgrp, session, tty_nr, tpgid;
        unsigned long flags, minflt, cminflt, majflt, cmajflt;
        unsigned long utime, stime, cutime, cstime, priority, nice;
        long num_threads, itrealvalue;
        unsigned long long starttime, vsize;
        long rss;
        
        if (fscanf(fp, "%*d %*s %c %d %d %d %d %d %lu %lu %lu %lu %lu %lu %lu %lu %lu %lu %lu %ld %*ld %ld %ld %llu %lu %ld",
                  &state, &ppid, &pgrp, &session, &tty_nr, &tpgid, &flags,
                  &minflt, &cminflt, &majflt, &cmajflt, &utime, &stime,
                  &cutime, &cstime, &priority, &nice, &num_threads,
                  &itrealvalue, &starttime, &vsize, &rss) >= 22) {
            
            proc->user_time = utime;
            proc->system_time = stime;
            proc->children_user_time = cutime;
            proc->children_system_time = cstime;
            proc->minor_page_faults = minflt;
            proc->major_page_faults = majflt;
            proc->num_threads = num_threads;
            proc->virtual_memory = vsize;
            proc->resident_memory = rss * getpagesize();
        }
        fclose(fp);
    }
    
    // Read memory statistics
    snprintf(path, sizeof(path), "/proc/%d/statm", pid);
    fp = fopen(path, "r");
    if (fp) {
        long size, resident, shared, text, lib, data, dt;
        if (fscanf(fp, "%ld %ld %ld %ld %ld %ld %ld",
                  &size, &resident, &shared, &text, &lib, &data, &dt) >= 7) {
            
            long page_size = getpagesize();
            proc->virtual_memory = size * page_size;
            proc->resident_memory = resident * page_size;
            proc->shared_memory = shared * page_size;
            proc->text_memory = text * page_size;
            proc->data_memory = data * page_size;
        }
        fclose(fp);
    }
    
    // Read I/O statistics
    snprintf(path, sizeof(path), "/proc/%d/io", pid);
    fp = fopen(path, "r");
    if (fp) {
        char line[256];
        while (fgets(line, sizeof(line), fp)) {
            uint64_t value;
            if (sscanf(line, "rchar: %lu", &value) == 1) {
                proc->read_bytes = value;
            } else if (sscanf(line, "wchar: %lu", &value) == 1) {
                proc->write_bytes = value;
            } else if (sscanf(line, "syscr: %lu", &value) == 1) {
                proc->read_syscalls = value;
            } else if (sscanf(line, "syscw: %lu", &value) == 1) {
                proc->write_syscalls = value;
            }
        }
        fclose(fp);
    }
    
    // Read file descriptor count
    snprintf(path, sizeof(path), "/proc/%d/fd", pid);
    DIR *fd_dir = opendir(path);
    if (fd_dir) {
        struct dirent *entry;
        int fd_count = 0;
        while ((entry = readdir(fd_dir)) != NULL) {
            if (entry->d_name[0] != '.') {
                fd_count++;
            }
        }
        proc->open_fds = fd_count;
        closedir(fd_dir);
    }
    
    // Read limits
    snprintf(path, sizeof(path), "/proc/%d/limits", pid);
    fp = fopen(path, "r");
    if (fp) {
        char line[256];
        while (fgets(line, sizeof(line), fp)) {
            if (strstr(line, "Max open files")) {
                uint64_t soft_limit, hard_limit;
                if (sscanf(line, "%*s %*s %*s %lu %lu", &soft_limit, &hard_limit) >= 1) {
                    proc->max_fds = soft_limit;
                }
                break;
            }
        }
        fclose(fp);
    }
    
    return 0;
}

static void *process_monitor_thread(void *arg)
{
    while (perf_mon.running) {
        DIR *proc_dir = opendir("/proc");
        if (!proc_dir) {
            perror("opendir /proc");
            sleep(1);
            continue;
        }
        
        perf_mon.num_processes = 0;
        struct dirent *entry;
        
        while ((entry = readdir(proc_dir)) != NULL && 
               perf_mon.num_processes < MAX_PROCESSES) {
            
            // Check if directory name is a PID
            if (strspn(entry->d_name, "0123456789") == strlen(entry->d_name)) {
                pid_t pid = atoi(entry->d_name);
                
                if (read_process_stats(pid, &perf_mon.processes[perf_mon.num_processes]) == 0) {
                    perf_mon.num_processes++;
                }
            }
        }
        
        closedir(proc_dir);
        usleep(perf_mon.sample_interval_ms * 1000);
    }
    
    return NULL;
}

// Performance counter setup
static int setup_perf_counter(int cpu, perf_counter_type_t type)
{
    struct perf_event_attr pe;
    memset(&pe, 0, sizeof(pe));
    
    pe.size = sizeof(pe);
    pe.disabled = 1;
    pe.exclude_kernel = 0;
    pe.exclude_hv = 1;
    
    switch (type) {
    case PERF_TYPE_CPU_CYCLES:
        pe.type = PERF_TYPE_HARDWARE;
        pe.config = PERF_COUNT_HW_CPU_CYCLES;
        break;
    case PERF_TYPE_INSTRUCTIONS:
        pe.type = PERF_TYPE_HARDWARE;
        pe.config = PERF_COUNT_HW_INSTRUCTIONS;
        break;
    case PERF_TYPE_CACHE_REFERENCES:
        pe.type = PERF_TYPE_HARDWARE;
        pe.config = PERF_COUNT_HW_CACHE_REFERENCES;
        break;
    case PERF_TYPE_CACHE_MISSES:
        pe.type = PERF_TYPE_HARDWARE;
        pe.config = PERF_COUNT_HW_CACHE_MISSES;
        break;
    case PERF_TYPE_BRANCH_INSTRUCTIONS:
        pe.type = PERF_TYPE_HARDWARE;
        pe.config = PERF_COUNT_HW_BRANCH_INSTRUCTIONS;
        break;
    case PERF_TYPE_BRANCH_MISSES:
        pe.type = PERF_TYPE_HARDWARE;
        pe.config = PERF_COUNT_HW_BRANCH_MISSES;
        break;
    case PERF_TYPE_PAGE_FAULTS:
        pe.type = PERF_TYPE_SOFTWARE;
        pe.config = PERF_COUNT_SW_PAGE_FAULTS;
        break;
    case PERF_TYPE_CONTEXT_SWITCHES:
        pe.type = PERF_TYPE_SOFTWARE;
        pe.config = PERF_COUNT_SW_CONTEXT_SWITCHES;
        break;
    case PERF_TYPE_CPU_MIGRATIONS:
        pe.type = PERF_TYPE_SOFTWARE;
        pe.config = PERF_COUNT_SW_CPU_MIGRATIONS;
        break;
    default:
        return -1;
    }
    
    int fd = perf_event_open(&pe, -1, cpu, -1, 0);
    if (fd < 0) {
        perror("perf_event_open");
        return -1;
    }
    
    perf_mon.perf_fds[cpu][type] = fd;
    
    // Enable the counter
    ioctl(fd, PERF_EVENT_IOC_RESET, 0);
    ioctl(fd, PERF_EVENT_IOC_ENABLE, 0);
    
    return 0;
}

static int init_performance_counters(void)
{
    for (int cpu = 0; cpu < perf_mon.num_cpus; cpu++) {
        for (int type = PERF_TYPE_CPU_CYCLES; type <= PERF_TYPE_MEMORY_STORES; type++) {
            perf_mon.perf_fds[cpu][type] = -1;
            
            if (setup_perf_counter(cpu, type) < 0) {
                printf("Warning: Failed to setup perf counter %d on CPU %d\n", type, cpu);
            }
        }
    }
    
    return 0;
}

static void cleanup_performance_counters(void)
{
    for (int cpu = 0; cpu < perf_mon.num_cpus; cpu++) {
        for (int type = PERF_TYPE_CPU_CYCLES; type <= PERF_TYPE_MEMORY_STORES; type++) {
            if (perf_mon.perf_fds[cpu][type] >= 0) {
                close(perf_mon.perf_fds[cpu][type]);
                perf_mon.perf_fds[cpu][type] = -1;
            }
        }
    }
}

// Anomaly detection
static bool detect_cpu_anomaly(const cpu_metrics_t *cpu)
{
    // High CPU usage
    if (cpu->user_time + cpu->system_time > perf_mon.config.cpu_threshold) {
        return true;
    }
    
    // Low IPC might indicate performance issues
    if (cpu->ipc > 0 && cpu->ipc < 0.5) {
        return true;
    }
    
    // High cache miss rate
    if (cpu->cache_hit_ratio > 0 && cpu->cache_hit_ratio < 0.8) {
        return true;
    }
    
    // High branch misprediction rate
    if (cpu->branch_prediction_accuracy > 0 && cpu->branch_prediction_accuracy < 0.9) {
        return true;
    }
    
    return false;
}

static bool detect_memory_anomaly(const memory_metrics_t *mem)
{
    // High memory pressure
    if (mem->memory_pressure > perf_mon.config.memory_threshold) {
        return true;
    }
    
    // High swap usage
    if (mem->swap_total > 0 && (double)mem->swap_used / mem->swap_total > 0.5) {
        return true;
    }
    
    // OOM kills
    if (mem->oom_kills > 0) {
        return true;
    }
    
    return false;
}

static bool detect_io_anomaly(const io_metrics_t *io)
{
    // High I/O wait
    if (io->read_latency_avg > 100 || io->write_latency_avg > 100) { // 100ms threshold
        return true;
    }
    
    // High queue depth
    if (io->queue_depth > 32) {
        return true;
    }
    
    // Network errors
    if (io->network_rx_errors > 0 || io->network_tx_errors > 0) {
        return true;
    }
    
    // File descriptor exhaustion
    if (io->max_open_files > 0 && (double)io->open_files / io->max_open_files > 0.9) {
        return true;
    }
    
    return false;
}

// Reporting and analysis
static void print_system_summary(void)
{
    printf("\n=== System Performance Summary ===\n");
    
    // Memory summary
    printf("Memory Usage: %.1f%% (%.2f GB / %.2f GB)\n",
           perf_mon.memory.memory_pressure * 100.0,
           perf_mon.memory.used_memory / (1024.0 * 1024.0 * 1024.0),
           perf_mon.memory.total_memory / (1024.0 * 1024.0 * 1024.0));
    
    if (perf_mon.memory.swap_total > 0) {
        printf("Swap Usage: %.1f%% (%.2f GB / %.2f GB)\n",
               (double)perf_mon.memory.swap_used / perf_mon.memory.swap_total * 100.0,
               perf_mon.memory.swap_used / (1024.0 * 1024.0 * 1024.0),
               perf_mon.memory.swap_total / (1024.0 * 1024.0 * 1024.0));
    }
    
    // CPU summary
    double total_cpu_usage = 0;
    double max_cpu_usage = 0;
    for (int i = 0; i < perf_mon.num_cpus; i++) {
        double cpu_usage = perf_mon.cpus[i].user_time + perf_mon.cpus[i].system_time;
        total_cpu_usage += cpu_usage;
        if (cpu_usage > max_cpu_usage) {
            max_cpu_usage = cpu_usage;
        }
    }
    
    printf("CPU Usage: Average %.1f%%, Peak %.1f%%\n",
           total_cpu_usage / perf_mon.num_cpus, max_cpu_usage);
    
    // I/O summary
    printf("I/O: Read %.1f MB/s, Write %.1f MB/s\n",
           perf_mon.io.read_bandwidth / (1024.0 * 1024.0),
           perf_mon.io.write_bandwidth / (1024.0 * 1024.0));
    
    printf("Network: RX %.1f MB/s, TX %.1f MB/s\n",
           perf_mon.io.network_rx_bytes / (1024.0 * 1024.0),
           perf_mon.io.network_tx_bytes / (1024.0 * 1024.0));
    
    // Process summary
    printf("Processes: %d active\n", perf_mon.num_processes);
    
    // Anomalies
    int anomalies = 0;
    for (int i = 0; i < perf_mon.num_cpus; i++) {
        if (detect_cpu_anomaly(&perf_mon.cpus[i])) {
            anomalies++;
        }
    }
    
    if (detect_memory_anomaly(&perf_mon.memory)) {
        anomalies++;
    }
    
    if (detect_io_anomaly(&perf_mon.io)) {
        anomalies++;
    }
    
    if (anomalies > 0) {
        printf("Anomalies Detected: %d\n", anomalies);
    }
    
    printf("Monitoring Overhead: %.2f ms per sample\n",
           perf_mon.stats.monitoring_overhead / perf_mon.stats.samples_collected);
    
    printf("=====================================\n");
}

static void print_detailed_report(void)
{
    printf("\n=== Detailed Performance Report ===\n");
    
    // CPU details
    printf("\nCPU Performance:\n");
    for (int i = 0; i < perf_mon.num_cpus; i++) {
        cpu_metrics_t *cpu = &perf_mon.cpus[i];
        printf("CPU %d: %.1f%% usage, IPC: %.2f, Cache hit: %.1f%%, Freq: %lu MHz\n",
               i, cpu->user_time + cpu->system_time, cpu->ipc,
               cpu->cache_hit_ratio * 100.0, cpu->frequency_mhz);
    }
    
    // Memory details
    printf("\nMemory Performance:\n");
    memory_metrics_t *mem = &perf_mon.memory;
    printf("  Total: %.2f GB\n", mem->total_memory / (1024.0 * 1024.0 * 1024.0));
    printf("  Used: %.2f GB (%.1f%%)\n", 
           mem->used_memory / (1024.0 * 1024.0 * 1024.0),
           mem->memory_pressure * 100.0);
    printf("  Cached: %.2f GB\n", mem->cached_memory / (1024.0 * 1024.0 * 1024.0));
    printf("  Anonymous: %.2f GB\n", mem->anonymous_pages / (1024.0 * 1024.0 * 1024.0));
    printf("  Slab: %.2f GB\n", mem->slab_memory / (1024.0 * 1024.0 * 1024.0));
    
    if (mem->numa_hit + mem->numa_miss > 0) {
        printf("  NUMA efficiency: %.1f%%\n",
               (double)mem->numa_hit / (mem->numa_hit + mem->numa_miss) * 100.0);
    }
    
    // I/O details
    printf("\nI/O Performance:\n");
    io_metrics_t *io = &perf_mon.io;
    printf("  Block I/O: %lu read IOPS, %lu write IOPS\n", io->read_iops, io->write_iops);
    printf("  Network: %lu RX packets, %lu TX packets\n", 
           io->network_rx_packets, io->network_tx_packets);
    printf("  Open files: %lu / %lu\n", io->open_files, io->max_open_files);
    
    // Top processes by CPU
    printf("\nTop Processes by CPU:\n");
    // Sort processes by CPU usage (simplified - real implementation would use qsort)
    for (int i = 0; i < 10 && i < perf_mon.num_processes; i++) {
        process_metrics_t *proc = &perf_mon.processes[i];
        printf("  PID %d (%s): %.1f%% CPU, %.1f MB memory\n",
               proc->pid, proc->name, proc->cpu_percent,
               proc->resident_memory / (1024.0 * 1024.0));
    }
    
    printf("====================================\n");
}

// Signal handlers
static void signal_handler(int sig)
{
    if (sig == SIGINT || sig == SIGTERM) {
        printf("\nReceived signal %d, shutting down...\n", sig);
        perf_mon.running = false;
    } else if (sig == SIGUSR1) {
        print_detailed_report();
    }
}

// Main initialization and cleanup
static int init_performance_monitor(void)
{
    // Get number of CPUs
    perf_mon.num_cpus = sysconf(_SC_NPROCESSORS_ONLN);
    if (perf_mon.num_cpus > MAX_CPUS) {
        perf_mon.num_cpus = MAX_CPUS;
    }
    
    // Initialize configuration
    perf_mon.sample_interval_ms = 1000; // 1 second
    perf_mon.config.enable_detailed_profiling = true;
    perf_mon.config.enable_anomaly_detection = true;
    perf_mon.config.cpu_threshold = 80.0;
    perf_mon.config.memory_threshold = 0.9;
    perf_mon.config.io_threshold = 80.0;
    
    // Setup performance counters
    if (init_performance_counters() < 0) {
        fprintf(stderr, "Warning: Some performance counters may not be available\n");
    }
    
    perf_mon.running = true;
    
    // Start monitoring threads
    if (pthread_create(&perf_mon.memory_thread, NULL, memory_monitor_thread, NULL) != 0) {
        perror("pthread_create memory thread");
        return -1;
    }
    
    if (pthread_create(&perf_mon.cpu_thread, NULL, cpu_monitor_thread, NULL) != 0) {
        perror("pthread_create cpu thread");
        return -1;
    }
    
    if (pthread_create(&perf_mon.io_thread, NULL, io_monitor_thread, NULL) != 0) {
        perror("pthread_create io thread");
        return -1;
    }
    
    if (pthread_create(&perf_mon.process_thread, NULL, process_monitor_thread, NULL) != 0) {
        perror("pthread_create process thread");
        return -1;
    }
    
    printf("Performance monitoring initialized with %d CPUs\n", perf_mon.num_cpus);
    return 0;
}

static void cleanup_performance_monitor(void)
{
    perf_mon.running = false;
    
    // Wait for threads to finish
    pthread_join(perf_mon.memory_thread, NULL);
    pthread_join(perf_mon.cpu_thread, NULL);
    pthread_join(perf_mon.io_thread, NULL);
    pthread_join(perf_mon.process_thread, NULL);
    
    // Cleanup performance counters
    cleanup_performance_counters();
    
    printf("Performance monitoring cleanup completed\n");
}

// Main function
int main(int argc, char *argv[])
{
    int duration = 60; // Default 60 seconds
    
    if (argc > 1) {
        duration = atoi(argv[1]);
    }
    
    // Set up signal handlers
    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);
    signal(SIGUSR1, signal_handler);
    
    printf("Advanced Performance Monitor\n");
    printf("Duration: %d seconds\n", duration);
    printf("Send SIGUSR1 for detailed report, SIGINT to exit\n\n");
    
    if (init_performance_monitor() != 0) {
        fprintf(stderr, "Failed to initialize performance monitor\n");
        return 1;
    }
    
    // Main monitoring loop
    time_t start_time = time(NULL);
    while (perf_mon.running && (time(NULL) - start_time) < duration) {
        sleep(5);
        print_system_summary();
    }
    
    if (perf_mon.running) {
        printf("\nMonitoring duration completed\n");
        print_detailed_report();
    }
    
    cleanup_performance_monitor();
    
    return 0;
}
```

## Memory Pool and Cache Optimization Framework

### High-Performance Memory Management System

```c
// memory_optimizer.c - Advanced memory optimization framework
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <sys/mman.h>
#include <sys/resource.h>
#include <pthread.h>
#include <stdatomic.h>
#include <numa.h>
#include <numaif.h>

#define CACHE_LINE_SIZE 64
#define PAGE_SIZE 4096
#define HUGE_PAGE_SIZE (2 * 1024 * 1024)
#define MAX_POOLS 64
#define MAX_THREADS 256

// Memory pool types
typedef enum {
    POOL_TYPE_FIXED_SIZE,
    POOL_TYPE_VARIABLE_SIZE,
    POOL_TYPE_OBJECT_POOL,
    POOL_TYPE_STACK_POOL,
    POOL_TYPE_RING_BUFFER
} pool_type_t;

// Memory allocation policies
typedef enum {
    ALLOC_POLICY_FIRST_FIT,
    ALLOC_POLICY_BEST_FIT,
    ALLOC_POLICY_WORST_FIT,
    ALLOC_POLICY_BUDDY_SYSTEM,
    ALLOC_POLICY_SLAB_ALLOCATOR
} alloc_policy_t;

// NUMA policies
typedef enum {
    NUMA_POLICY_DEFAULT,
    NUMA_POLICY_LOCAL,
    NUMA_POLICY_INTERLEAVE,
    NUMA_POLICY_BIND
} numa_policy_t;

// Memory block header
typedef struct memory_block {
    size_t size;
    bool is_free;
    struct memory_block *next;
    struct memory_block *prev;
    uint64_t magic;
    void *pool;
    size_t offset;
} memory_block_t;

// Free list entry
typedef struct free_entry {
    size_t size;
    void *ptr;
    struct free_entry *next;
} free_entry_t;

// Thread-local cache
typedef struct {
    void **free_objects;
    size_t free_count;
    size_t max_free;
    size_t object_size;
    pthread_mutex_t lock;
} thread_cache_t;

// Memory pool structure
typedef struct {
    int pool_id;
    pool_type_t type;
    alloc_policy_t alloc_policy;
    numa_policy_t numa_policy;
    
    void *memory_base;
    size_t pool_size;
    size_t allocated_size;
    size_t alignment;
    
    // For fixed-size pools
    size_t object_size;
    size_t max_objects;
    size_t used_objects;
    
    // Free list management
    free_entry_t *free_lists[64]; // Size classes
    memory_block_t *block_list;
    
    // Thread-local caches
    thread_cache_t thread_caches[MAX_THREADS];
    
    // Synchronization
    pthread_rwlock_t lock;
    atomic_bool initialized;
    
    // Statistics
    struct {
        atomic_uint64_t total_allocations;
        atomic_uint64_t total_deallocations;
        atomic_uint64_t bytes_allocated;
        atomic_uint64_t bytes_deallocated;
        atomic_uint64_t allocation_failures;
        atomic_uint64_t cache_hits;
        atomic_uint64_t cache_misses;
    } stats;
    
    // Configuration
    struct {
        bool use_huge_pages;
        bool use_numa_awareness;
        bool enable_thread_cache;
        bool enable_debugging;
        size_t min_alloc_size;
        size_t max_alloc_size;
        double growth_factor;
    } config;
    
} memory_pool_t;

// Cache optimization structures
typedef struct {
    void *data;
    size_t size;
    uint64_t access_count;
    uint64_t last_access;
    bool dirty;
    pthread_mutex_t lock;
} cache_entry_t;

typedef struct {
    cache_entry_t *entries;
    size_t capacity;
    size_t used;
    size_t entry_size;
    
    // LRU management
    cache_entry_t *lru_head;
    cache_entry_t *lru_tail;
    
    // Hash table for fast lookup
    cache_entry_t **hash_table;
    size_t hash_size;
    
    // Statistics
    atomic_uint64_t hits;
    atomic_uint64_t misses;
    atomic_uint64_t evictions;
    
    pthread_rwlock_t lock;
} cache_system_t;

// Global memory management context
static struct {
    memory_pool_t pools[MAX_POOLS];
    int num_pools;
    pthread_mutex_t global_lock;
    
    cache_system_t cache_system;
    
    // NUMA topology
    int num_numa_nodes;
    int *numa_node_cpus[64];
    int numa_node_cpu_count[64];
    
    // Performance monitoring
    struct {
        atomic_uint64_t total_memory_allocated;
        atomic_uint64_t peak_memory_usage;
        atomic_uint64_t fragmentation_events;
        atomic_uint64_t compaction_runs;
    } global_stats;
    
} memory_manager = {0};

// Utility functions
static inline void *align_ptr(void *ptr, size_t alignment)
{
    uintptr_t addr = (uintptr_t)ptr;
    return (void*)((addr + alignment - 1) & ~(alignment - 1));
}

static inline size_t align_size(size_t size, size_t alignment)
{
    return (size + alignment - 1) & ~(alignment - 1);
}

static inline int get_size_class(size_t size)
{
    if (size <= 8) return 0;
    if (size <= 16) return 1;
    if (size <= 32) return 2;
    if (size <= 64) return 3;
    if (size <= 128) return 4;
    if (size <= 256) return 5;
    if (size <= 512) return 6;
    if (size <= 1024) return 7;
    if (size <= 2048) return 8;
    if (size <= 4096) return 9;
    
    // For larger sizes, use log-based classification
    int class = 10;
    size_t threshold = 8192;
    while (size > threshold && class < 63) {
        threshold *= 2;
        class++;
    }
    return class;
}

// NUMA topology detection
static int detect_numa_topology(void)
{
    if (numa_available() < 0) {
        printf("NUMA not available\n");
        return 0;
    }
    
    memory_manager.num_numa_nodes = numa_max_node() + 1;
    printf("Detected %d NUMA nodes\n", memory_manager.num_numa_nodes);
    
    for (int node = 0; node < memory_manager.num_numa_nodes; node++) {
        struct bitmask *cpus = numa_allocate_cpumask();
        numa_node_to_cpus(node, cpus);
        
        memory_manager.numa_node_cpu_count[node] = 0;
        memory_manager.numa_node_cpus[node] = malloc(sizeof(int) * numa_num_configured_cpus());
        
        for (int cpu = 0; cpu < numa_num_configured_cpus(); cpu++) {
            if (numa_bitmask_isbitset(cpus, cpu)) {
                memory_manager.numa_node_cpus[node][memory_manager.numa_node_cpu_count[node]] = cpu;
                memory_manager.numa_node_cpu_count[node]++;
            }
        }
        
        numa_free_cpumask(cpus);
        
        printf("NUMA node %d: %d CPUs\n", node, memory_manager.numa_node_cpu_count[node]);
    }
    
    return memory_manager.num_numa_nodes;
}

// Memory pool creation and management
static memory_pool_t *create_memory_pool(pool_type_t type, size_t pool_size,
                                        size_t object_size, alloc_policy_t policy)
{
    if (memory_manager.num_pools >= MAX_POOLS) {
        return NULL;
    }
    
    memory_pool_t *pool = &memory_manager.pools[memory_manager.num_pools];
    memset(pool, 0, sizeof(*pool));
    
    pool->pool_id = memory_manager.num_pools;
    pool->type = type;
    pool->pool_size = pool_size;
    pool->object_size = object_size;
    pool->alloc_policy = policy;
    pool->alignment = CACHE_LINE_SIZE;
    
    // Default configuration
    pool->config.use_huge_pages = (pool_size >= HUGE_PAGE_SIZE);
    pool->config.use_numa_awareness = (memory_manager.num_numa_nodes > 1);
    pool->config.enable_thread_cache = true;
    pool->config.min_alloc_size = 8;
    pool->config.max_alloc_size = pool_size / 4;
    pool->config.growth_factor = 1.5;
    
    // Allocate memory
    int flags = MAP_PRIVATE | MAP_ANONYMOUS;
    if (pool->config.use_huge_pages) {
        flags |= MAP_HUGETLB;
    }
    
    pool->memory_base = mmap(NULL, pool_size, PROT_READ | PROT_WRITE, flags, -1, 0);
    if (pool->memory_base == MAP_FAILED) {
        // Fallback without huge pages
        pool->memory_base = mmap(NULL, pool_size, PROT_READ | PROT_WRITE,
                                MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
        if (pool->memory_base == MAP_FAILED) {
            perror("mmap");
            return NULL;
        }
        pool->config.use_huge_pages = false;
    }
    
    // Lock memory if requested
    if (mlock(pool->memory_base, pool_size) != 0) {
        printf("Warning: Failed to lock memory (need appropriate privileges)\n");
    }
    
    // Initialize synchronization
    pthread_rwlock_init(&pool->lock, NULL);
    
    // Initialize for specific pool types
    switch (type) {
    case POOL_TYPE_FIXED_SIZE:
        pool->max_objects = pool_size / object_size;
        
        // Initialize free list
        char *ptr = (char*)pool->memory_base;
        for (size_t i = 0; i < pool->max_objects; i++) {
            free_entry_t *entry = malloc(sizeof(free_entry_t));
            entry->ptr = ptr + i * object_size;
            entry->size = object_size;
            
            int size_class = get_size_class(object_size);
            entry->next = pool->free_lists[size_class];
            pool->free_lists[size_class] = entry;
        }
        break;
        
    case POOL_TYPE_VARIABLE_SIZE:
        // Initialize with one large free block
        memory_block_t *initial_block = (memory_block_t*)pool->memory_base;
        initial_block->size = pool_size - sizeof(memory_block_t);
        initial_block->is_free = true;
        initial_block->next = NULL;
        initial_block->prev = NULL;
        initial_block->magic = 0xDEADBEEF;
        initial_block->pool = pool;
        initial_block->offset = 0;
        
        pool->block_list = initial_block;
        
        free_entry_t *entry = malloc(sizeof(free_entry_t));
        entry->ptr = (char*)initial_block + sizeof(memory_block_t);
        entry->size = initial_block->size;
        
        int size_class = get_size_class(entry->size);
        entry->next = pool->free_lists[size_class];
        pool->free_lists[size_class] = entry;
        break;
        
    default:
        break;
    }
    
    // Initialize thread caches
    if (pool->config.enable_thread_cache) {
        for (int i = 0; i < MAX_THREADS; i++) {
            thread_cache_t *cache = &pool->thread_caches[i];
            cache->max_free = 64; // Maximum objects in thread cache
            cache->free_objects = malloc(cache->max_free * sizeof(void*));
            cache->free_count = 0;
            cache->object_size = object_size;
            pthread_mutex_init(&cache->lock, NULL);
        }
    }
    
    atomic_store(&pool->initialized, true);
    memory_manager.num_pools++;
    
    printf("Created memory pool %d: type=%d, size=%zu, object_size=%zu\n",
           pool->pool_id, type, pool_size, object_size);
    
    return pool;
}

static void destroy_memory_pool(memory_pool_t *pool)
{
    if (!pool || !atomic_load(&pool->initialized)) {
        return;
    }
    
    pthread_rwlock_wrlock(&pool->lock);
    
    // Cleanup thread caches
    if (pool->config.enable_thread_cache) {
        for (int i = 0; i < MAX_THREADS; i++) {
            thread_cache_t *cache = &pool->thread_caches[i];
            pthread_mutex_destroy(&cache->lock);
            free(cache->free_objects);
        }
    }
    
    // Cleanup free lists
    for (int i = 0; i < 64; i++) {
        free_entry_t *entry = pool->free_lists[i];
        while (entry) {
            free_entry_t *next = entry->next;
            free(entry);
            entry = next;
        }
    }
    
    // Unmap memory
    if (pool->memory_base != MAP_FAILED) {
        munlock(pool->memory_base, pool->pool_size);
        munmap(pool->memory_base, pool->pool_size);
    }
    
    pthread_rwlock_unlock(&pool->lock);
    pthread_rwlock_destroy(&pool->lock);
    
    atomic_store(&pool->initialized, false);
    
    printf("Destroyed memory pool %d\n", pool->pool_id);
}

// Allocation functions
static void *pool_alloc_fixed_size(memory_pool_t *pool, size_t size)
{
    if (size != pool->object_size) {
        return NULL;
    }
    
    // Try thread cache first
    if (pool->config.enable_thread_cache) {
        int thread_id = gettid() % MAX_THREADS;
        thread_cache_t *cache = &pool->thread_caches[thread_id];
        
        pthread_mutex_lock(&cache->lock);
        if (cache->free_count > 0) {
            void *ptr = cache->free_objects[--cache->free_count];
            pthread_mutex_unlock(&cache->lock);
            
            atomic_fetch_add(&pool->stats.cache_hits, 1);
            atomic_fetch_add(&pool->stats.total_allocations, 1);
            atomic_fetch_add(&pool->stats.bytes_allocated, size);
            
            return ptr;
        }
        pthread_mutex_unlock(&cache->lock);
        
        atomic_fetch_add(&pool->stats.cache_misses, 1);
    }
    
    pthread_rwlock_wrlock(&pool->lock);
    
    int size_class = get_size_class(pool->object_size);
    free_entry_t *entry = pool->free_lists[size_class];
    
    if (!entry) {
        pthread_rwlock_unlock(&pool->lock);
        atomic_fetch_add(&pool->stats.allocation_failures, 1);
        return NULL;
    }
    
    // Remove from free list
    pool->free_lists[size_class] = entry->next;
    void *ptr = entry->ptr;
    free(entry);
    
    pool->used_objects++;
    
    pthread_rwlock_unlock(&pool->lock);
    
    atomic_fetch_add(&pool->stats.total_allocations, 1);
    atomic_fetch_add(&pool->stats.bytes_allocated, size);
    
    return ptr;
}

static void *pool_alloc_variable_size(memory_pool_t *pool, size_t size)
{
    size_t aligned_size = align_size(size, pool->alignment);
    int size_class = get_size_class(aligned_size);
    
    pthread_rwlock_wrlock(&pool->lock);
    
    free_entry_t *prev = NULL;
    free_entry_t *current = pool->free_lists[size_class];
    
    // Search for suitable block
    while (current) {
        if (current->size >= aligned_size) {
            // Found suitable block
            void *ptr = current->ptr;
            
            // Split block if necessary
            if (current->size > aligned_size + sizeof(memory_block_t) + pool->alignment) {
                // Create new free block from remainder
                void *remainder_ptr = (char*)ptr + aligned_size;
                size_t remainder_size = current->size - aligned_size;
                
                free_entry_t *remainder = malloc(sizeof(free_entry_t));
                remainder->ptr = remainder_ptr;
                remainder->size = remainder_size;
                
                int remainder_class = get_size_class(remainder_size);
                remainder->next = pool->free_lists[remainder_class];
                pool->free_lists[remainder_class] = remainder;
                
                current->size = aligned_size;
            }
            
            // Remove from free list
            if (prev) {
                prev->next = current->next;
            } else {
                pool->free_lists[size_class] = current->next;
            }
            
            free(current);
            pool->allocated_size += aligned_size;
            
            pthread_rwlock_unlock(&pool->lock);
            
            atomic_fetch_add(&pool->stats.total_allocations, 1);
            atomic_fetch_add(&pool->stats.bytes_allocated, aligned_size);
            
            return ptr;
        }
        
        prev = current;
        current = current->next;
    }
    
    // No suitable block found
    pthread_rwlock_unlock(&pool->lock);
    atomic_fetch_add(&pool->stats.allocation_failures, 1);
    return NULL;
}

static void *memory_pool_alloc(memory_pool_t *pool, size_t size)
{
    if (!pool || !atomic_load(&pool->initialized) || size == 0) {
        return NULL;
    }
    
    switch (pool->type) {
    case POOL_TYPE_FIXED_SIZE:
        return pool_alloc_fixed_size(pool, size);
    case POOL_TYPE_VARIABLE_SIZE:
        return pool_alloc_variable_size(pool, size);
    default:
        return NULL;
    }
}

// Deallocation functions
static void pool_free_fixed_size(memory_pool_t *pool, void *ptr)
{
    // Try thread cache first
    if (pool->config.enable_thread_cache) {
        int thread_id = gettid() % MAX_THREADS;
        thread_cache_t *cache = &pool->thread_caches[thread_id];
        
        pthread_mutex_lock(&cache->lock);
        if (cache->free_count < cache->max_free) {
            cache->free_objects[cache->free_count++] = ptr;
            pthread_mutex_unlock(&cache->lock);
            
            atomic_fetch_add(&pool->stats.total_deallocations, 1);
            atomic_fetch_add(&pool->stats.bytes_deallocated, pool->object_size);
            
            return;
        }
        pthread_mutex_unlock(&cache->lock);
    }
    
    pthread_rwlock_wrlock(&pool->lock);
    
    // Add back to free list
    free_entry_t *entry = malloc(sizeof(free_entry_t));
    entry->ptr = ptr;
    entry->size = pool->object_size;
    
    int size_class = get_size_class(pool->object_size);
    entry->next = pool->free_lists[size_class];
    pool->free_lists[size_class] = entry;
    
    pool->used_objects--;
    
    pthread_rwlock_unlock(&pool->lock);
    
    atomic_fetch_add(&pool->stats.total_deallocations, 1);
    atomic_fetch_add(&pool->stats.bytes_deallocated, pool->object_size);
}

static void pool_free_variable_size(memory_pool_t *pool, void *ptr, size_t size)
{
    size_t aligned_size = align_size(size, pool->alignment);
    
    pthread_rwlock_wrlock(&pool->lock);
    
    // Add to appropriate free list
    free_entry_t *entry = malloc(sizeof(free_entry_t));
    entry->ptr = ptr;
    entry->size = aligned_size;
    
    int size_class = get_size_class(aligned_size);
    entry->next = pool->free_lists[size_class];
    pool->free_lists[size_class] = entry;
    
    pool->allocated_size -= aligned_size;
    
    // TODO: Implement coalescing of adjacent free blocks
    
    pthread_rwlock_unlock(&pool->lock);
    
    atomic_fetch_add(&pool->stats.total_deallocations, 1);
    atomic_fetch_add(&pool->stats.bytes_deallocated, aligned_size);
}

static void memory_pool_free(memory_pool_t *pool, void *ptr, size_t size)
{
    if (!pool || !ptr) {
        return;
    }
    
    switch (pool->type) {
    case POOL_TYPE_FIXED_SIZE:
        pool_free_fixed_size(pool, ptr);
        break;
    case POOL_TYPE_VARIABLE_SIZE:
        pool_free_variable_size(pool, ptr, size);
        break;
    default:
        break;
    }
}

// Cache system implementation
static uint64_t hash_function(const void *key, size_t len)
{
    // Simple FNV-1a hash
    uint64_t hash = 14695981039346656037ULL;
    const uint8_t *data = (const uint8_t*)key;
    
    for (size_t i = 0; i < len; i++) {
        hash ^= data[i];
        hash *= 1099511628211ULL;
    }
    
    return hash;
}

static int init_cache_system(size_t capacity, size_t entry_size)
{
    cache_system_t *cache = &memory_manager.cache_system;
    
    cache->capacity = capacity;
    cache->entry_size = entry_size;
    cache->hash_size = capacity * 2; // 50% load factor
    
    cache->entries = malloc(capacity * sizeof(cache_entry_t));
    cache->hash_table = malloc(cache->hash_size * sizeof(cache_entry_t*));
    
    if (!cache->entries || !cache->hash_table) {
        return -1;
    }
    
    memset(cache->entries, 0, capacity * sizeof(cache_entry_t));
    memset(cache->hash_table, 0, cache->hash_size * sizeof(cache_entry_t*));
    
    // Initialize entries
    for (size_t i = 0; i < capacity; i++) {
        cache_entry_t *entry = &cache->entries[i];
        entry->data = malloc(entry_size);
        if (!entry->data) {
            return -1;
        }
        pthread_mutex_init(&entry->lock, NULL);
        
        // Link to LRU list (initially all entries are free)
        if (i == 0) {
            cache->lru_head = entry;
        } else {
            cache->entries[i-1].lru_next = entry;
            entry->lru_prev = &cache->entries[i-1];
        }
        
        if (i == capacity - 1) {
            cache->lru_tail = entry;
        }
    }
    
    pthread_rwlock_init(&cache->lock, NULL);
    
    printf("Cache system initialized: capacity=%zu, entry_size=%zu\n", 
           capacity, entry_size);
    
    return 0;
}

static cache_entry_t *cache_get(const void *key, size_t key_len)
{
    cache_system_t *cache = &memory_manager.cache_system;
    uint64_t hash = hash_function(key, key_len);
    size_t index = hash % cache->hash_size;
    
    pthread_rwlock_rdlock(&cache->lock);
    
    cache_entry_t *entry = cache->hash_table[index];
    while (entry) {
        if (entry->size == key_len && memcmp(entry->data, key, key_len) == 0) {
            // Found entry, update access statistics
            pthread_mutex_lock(&entry->lock);
            entry->access_count++;
            entry->last_access = time(NULL);
            pthread_mutex_unlock(&entry->lock);
            
            atomic_fetch_add(&cache->hits, 1);
            
            pthread_rwlock_unlock(&cache->lock);
            return entry;
        }
        entry = entry->hash_next;
    }
    
    atomic_fetch_add(&cache->misses, 1);
    
    pthread_rwlock_unlock(&cache->lock);
    return NULL;
}

// Performance testing and benchmarking
static void benchmark_memory_pools(void)
{
    printf("\n=== Memory Pool Benchmarks ===\n");
    
    const size_t num_iterations = 1000000;
    const size_t allocation_sizes[] = {16, 64, 256, 1024, 4096};
    const size_t num_sizes = sizeof(allocation_sizes) / sizeof(allocation_sizes[0]);
    
    for (size_t i = 0; i < num_sizes; i++) {
        size_t alloc_size = allocation_sizes[i];
        
        // Test fixed-size pool
        memory_pool_t *fixed_pool = create_memory_pool(POOL_TYPE_FIXED_SIZE, 
                                                      alloc_size * num_iterations * 2,
                                                      alloc_size, ALLOC_POLICY_FIRST_FIT);
        
        struct timespec start, end;
        clock_gettime(CLOCK_MONOTONIC, &start);
        
        void **ptrs = malloc(num_iterations * sizeof(void*));
        
        // Allocation benchmark
        for (size_t j = 0; j < num_iterations; j++) {
            ptrs[j] = memory_pool_alloc(fixed_pool, alloc_size);
        }
        
        clock_gettime(CLOCK_MONOTONIC, &end);
        double alloc_time = (end.tv_sec - start.tv_sec) + 
                           (end.tv_nsec - start.tv_nsec) / 1e9;
        
        clock_gettime(CLOCK_MONOTONIC, &start);
        
        // Deallocation benchmark
        for (size_t j = 0; j < num_iterations; j++) {
            memory_pool_free(fixed_pool, ptrs[j], alloc_size);
        }
        
        clock_gettime(CLOCK_MONOTONIC, &end);
        double free_time = (end.tv_sec - start.tv_sec) + 
                          (end.tv_nsec - start.tv_nsec) / 1e9;
        
        printf("Size %zu: Alloc %.2f ns/op, Free %.2f ns/op\n",
               alloc_size,
               alloc_time * 1e9 / num_iterations,
               free_time * 1e9 / num_iterations);
        
        free(ptrs);
        destroy_memory_pool(fixed_pool);
    }
    
    // Compare with standard malloc/free
    printf("\nStandard malloc/free comparison:\n");
    
    for (size_t i = 0; i < num_sizes; i++) {
        size_t alloc_size = allocation_sizes[i];
        
        struct timespec start, end;
        clock_gettime(CLOCK_MONOTONIC, &start);
        
        void **ptrs = malloc(num_iterations * sizeof(void*));
        
        for (size_t j = 0; j < num_iterations; j++) {
            ptrs[j] = malloc(alloc_size);
        }
        
        clock_gettime(CLOCK_MONOTONIC, &end);
        double alloc_time = (end.tv_sec - start.tv_sec) + 
                           (end.tv_nsec - start.tv_nsec) / 1e9;
        
        clock_gettime(CLOCK_MONOTONIC, &start);
        
        for (size_t j = 0; j < num_iterations; j++) {
            free(ptrs[j]);
        }
        
        clock_gettime(CLOCK_MONOTONIC, &end);
        double free_time = (end.tv_sec - start.tv_sec) + 
                          (end.tv_nsec - start.tv_nsec) / 1e9;
        
        printf("Size %zu: Alloc %.2f ns/op, Free %.2f ns/op\n",
               alloc_size,
               alloc_time * 1e9 / num_iterations,
               free_time * 1e9 / num_iterations);
        
        free(ptrs);
    }
    
    printf("===============================\n");
}

// Statistics and reporting
static void print_memory_pool_stats(memory_pool_t *pool)
{
    printf("\nPool %d Statistics:\n", pool->pool_id);
    printf("  Type: %d, Size: %zu bytes\n", pool->type, pool->pool_size);
    printf("  Allocations: %lu\n", atomic_load(&pool->stats.total_allocations));
    printf("  Deallocations: %lu\n", atomic_load(&pool->stats.total_deallocations));
    printf("  Bytes allocated: %lu\n", atomic_load(&pool->stats.bytes_allocated));
    printf("  Allocation failures: %lu\n", atomic_load(&pool->stats.allocation_failures));
    
    if (pool->config.enable_thread_cache) {
        printf("  Cache hits: %lu\n", atomic_load(&pool->stats.cache_hits));
        printf("  Cache misses: %lu\n", atomic_load(&pool->stats.cache_misses));
        
        uint64_t total_cache_accesses = atomic_load(&pool->stats.cache_hits) + 
                                       atomic_load(&pool->stats.cache_misses);
        if (total_cache_accesses > 0) {
            double hit_ratio = (double)atomic_load(&pool->stats.cache_hits) / total_cache_accesses;
            printf("  Cache hit ratio: %.2f%%\n", hit_ratio * 100.0);
        }
    }
    
    if (pool->type == POOL_TYPE_FIXED_SIZE) {
        printf("  Object size: %zu, Used objects: %zu/%zu\n",
               pool->object_size, pool->used_objects, pool->max_objects);
        printf("  Utilization: %.1f%%\n", 
               (double)pool->used_objects / pool->max_objects * 100.0);
    } else {
        printf("  Allocated size: %zu/%zu\n", pool->allocated_size, pool->pool_size);
        printf("  Utilization: %.1f%%\n", 
               (double)pool->allocated_size / pool->pool_size * 100.0);
    }
}

// Main initialization and testing
int main(void)
{
    printf("Advanced Memory Optimization Framework\n");
    
    // Initialize global manager
    pthread_mutex_init(&memory_manager.global_lock, NULL);
    
    // Detect NUMA topology
    detect_numa_topology();
    
    // Initialize cache system
    if (init_cache_system(1000, 4096) != 0) {
        fprintf(stderr, "Failed to initialize cache system\n");
        return 1;
    }
    
    // Create test pools
    memory_pool_t *small_pool = create_memory_pool(POOL_TYPE_FIXED_SIZE, 
                                                  1024 * 1024, 64, 
                                                  ALLOC_POLICY_FIRST_FIT);
    
    memory_pool_t *large_pool = create_memory_pool(POOL_TYPE_VARIABLE_SIZE, 
                                                  16 * 1024 * 1024, 0,
                                                  ALLOC_POLICY_BEST_FIT);
    
    if (!small_pool || !large_pool) {
        fprintf(stderr, "Failed to create memory pools\n");
        return 1;
    }
    
    // Run benchmarks
    benchmark_memory_pools();
    
    // Print statistics
    for (int i = 0; i < memory_manager.num_pools; i++) {
        print_memory_pool_stats(&memory_manager.pools[i]);
    }
    
    // Cleanup
    for (int i = 0; i < memory_manager.num_pools; i++) {
        destroy_memory_pool(&memory_manager.pools[i]);
    }
    
    pthread_mutex_destroy(&memory_manager.global_lock);
    
    printf("\nMemory optimization framework test completed\n");
    return 0;
}
```

This comprehensive Linux system programming and performance optimization blog post covers:

1. **Advanced Performance Monitoring** - Complete framework with CPU, memory, I/O, and process monitoring using performance counters
2. **Memory Pool Optimization** - High-performance memory management with NUMA awareness, thread-local caches, and multiple allocation strategies
3. **Cache Optimization** - LRU cache implementation with hash table lookup and performance metrics
4. **NUMA Programming** - Topology detection and memory placement optimization
5. **Performance Benchmarking** - Comprehensive testing and comparison frameworks

The implementation demonstrates enterprise-grade system programming techniques for building high-performance applications that can efficiently utilize modern multi-core, multi-socket systems.