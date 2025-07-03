---
title: "Container Internals Deep Dive: Namespaces, Cgroups, and Runtime Implementation"
date: 2025-02-23T10:00:00-05:00
draft: false
tags: ["Linux", "Containers", "Namespaces", "Cgroups", "Docker", "Runtime", "Isolation", "Virtualization"]
categories:
- Linux
- Containers
author: "Matthew Mattox - mmattox@support.tools"
description: "Master container internals from namespaces and cgroups to building your own container runtime, including advanced isolation techniques and security considerations"
more_link: "yes"
url: "/container-internals-namespaces-deep-dive/"
---

Containers have revolutionized application deployment and isolation, but their magic lies in fundamental Linux kernel features. Understanding namespaces, cgroups, and container runtimes at a deep level is essential for building secure, efficient containerized systems and troubleshooting complex container environments.

<!--more-->

# [Container Internals Deep Dive](#container-internals-deep-dive)

## Linux Namespaces: The Foundation of Isolation

### Understanding Namespace Types

```c
// namespace_demo.c - Linux namespace programming
#define _GNU_SOURCE
#include <sched.h>
#include <unistd.h>
#include <sys/wait.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <fcntl.h>

// Namespace types and their purposes
typedef struct {
    int flag;
    const char* name;
    const char* description;
} namespace_info_t;

static namespace_info_t namespaces[] = {
    {CLONE_NEWPID,    "pid",    "Process ID isolation"},
    {CLONE_NEWNET,    "net",    "Network stack isolation"},
    {CLONE_NEWUTS,    "uts",    "Hostname and NIS domain isolation"},
    {CLONE_NEWIPC,    "ipc",    "System V IPC isolation"},
    {CLONE_NEWNS,     "mnt",    "Mount point isolation"},
    {CLONE_NEWUSER,   "user",   "User and group ID isolation"},
    {CLONE_NEWCGROUP, "cgroup", "Cgroup root directory isolation"},
    {CLONE_NEWTIME,   "time",   "Boot and monotonic clock isolation"}
};

// Create a new namespace
int create_namespace(int namespace_flags, int (*child_func)(void*), void* arg) {
    const int STACK_SIZE = 1024 * 1024;
    char* stack = malloc(STACK_SIZE);
    char* stack_top = stack + STACK_SIZE;
    
    if (!stack) {
        perror("malloc");
        return -1;
    }
    
    pid_t child_pid = clone(child_func, stack_top, namespace_flags | SIGCHLD, arg);
    
    if (child_pid == -1) {
        perror("clone");
        free(stack);
        return -1;
    }
    
    // Wait for child
    int status;
    waitpid(child_pid, &status, 0);
    
    free(stack);
    return WEXITSTATUS(status);
}

// Demonstrate PID namespace
int pid_namespace_demo(void* arg) {
    printf("Inside PID namespace:\n");
    printf("  PID: %d (should be 1)\n", getpid());
    printf("  PPID: %d (should be 0)\n", getppid());
    
    // Show process list
    system("ps aux | head -10");
    
    return 0;
}

// Demonstrate UTS namespace
int uts_namespace_demo(void* arg) {
    const char* new_hostname = "container-host";
    
    printf("Original hostname: ");
    system("hostname");
    
    if (sethostname(new_hostname, strlen(new_hostname)) == -1) {
        perror("sethostname");
        return 1;
    }
    
    printf("New hostname: ");
    system("hostname");
    
    return 0;
}

// Demonstrate mount namespace
int mount_namespace_demo(void* arg) {
    // Create a temporary directory
    if (mkdir("/tmp/container_root", 0755) == -1 && errno != EEXIST) {
        perror("mkdir");
        return 1;
    }
    
    // Mount tmpfs as new root
    if (mount("tmpfs", "/tmp/container_root", "tmpfs", 0, "size=100m") == -1) {
        perror("mount tmpfs");
        return 1;
    }
    
    // Create basic directory structure
    mkdir("/tmp/container_root/bin", 0755);
    mkdir("/tmp/container_root/usr", 0755);
    mkdir("/tmp/container_root/etc", 0755);
    
    // Change root to new filesystem
    if (chroot("/tmp/container_root") == -1) {
        perror("chroot");
        return 1;
    }
    
    if (chdir("/") == -1) {
        perror("chdir");
        return 1;
    }
    
    printf("Inside mount namespace:\n");
    system("ls -la /");
    
    return 0;
}

// Network namespace utilities
void setup_loopback_interface() {
    // Bring up loopback interface in new network namespace
    system("ip link set dev lo up");
    system("ip addr add 127.0.0.1/8 dev lo");
}

int network_namespace_demo(void* arg) {
    printf("Network interfaces in new namespace:\n");
    system("ip link show");
    
    setup_loopback_interface();
    
    printf("\nAfter setting up loopback:\n");
    system("ip link show");
    system("ip addr show");
    
    return 0;
}

// User namespace mapping
void setup_user_namespace_mappings(pid_t child_pid) {
    char path[256];
    FILE* file;
    
    // Map root user
    snprintf(path, sizeof(path), "/proc/%d/uid_map", child_pid);
    file = fopen(path, "w");
    if (file) {
        fprintf(file, "0 %d 1", getuid());
        fclose(file);
    }
    
    // Deny setgroups
    snprintf(path, sizeof(path), "/proc/%d/setgroups", child_pid);
    file = fopen(path, "w");
    if (file) {
        fprintf(file, "deny");
        fclose(file);
    }
    
    // Map root group
    snprintf(path, sizeof(path), "/proc/%d/gid_map", child_pid);
    file = fopen(path, "w");
    if (file) {
        fprintf(file, "0 %d 1", getgid());
        fclose(file);
    }
}

int user_namespace_demo(void* arg) {
    printf("User namespace demo:\n");
    printf("  UID: %d (should be 0)\n", getuid());
    printf("  GID: %d (should be 0)\n", getgid());
    printf("  EUID: %d (should be 0)\n", geteuid());
    printf("  EGID: %d (should be 0)\n", getegid());
    
    // Try to access /etc/shadow (should fail)
    printf("  Trying to read /etc/shadow: ");
    if (access("/etc/shadow", R_OK) == 0) {
        printf("SUCCESS (unexpected!)\n");
    } else {
        printf("FAILED (expected)\n");
    }
    
    return 0;
}
```

### Advanced Namespace Operations

```c
// namespace_advanced.c - Advanced namespace management
#include <sys/types.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>

// Join existing namespace
int join_namespace(pid_t target_pid, const char* ns_type) {
    char ns_path[256];
    snprintf(ns_path, sizeof(ns_path), "/proc/%d/ns/%s", target_pid, ns_type);
    
    int fd = open(ns_path, O_RDONLY);
    if (fd == -1) {
        perror("open namespace");
        return -1;
    }
    
    if (setns(fd, 0) == -1) {
        perror("setns");
        close(fd);
        return -1;
    }
    
    close(fd);
    return 0;
}

// Create persistent namespace
int create_persistent_namespace(const char* name, int ns_flags) {
    char bind_path[256];
    snprintf(bind_path, sizeof(bind_path), "/tmp/ns_%s", name);
    
    // Create bind mount target
    int fd = open(bind_path, O_RDONLY | O_CREAT, 0644);
    if (fd == -1) {
        perror("create bind target");
        return -1;
    }
    close(fd);
    
    // Unshare namespace
    if (unshare(ns_flags) == -1) {
        perror("unshare");
        return -1;
    }
    
    // Bind mount namespace file
    char current_ns[256];
    snprintf(current_ns, sizeof(current_ns), "/proc/%d/ns/net", getpid());
    
    if (mount(current_ns, bind_path, NULL, MS_BIND, NULL) == -1) {
        perror("bind mount namespace");
        return -1;
    }
    
    printf("Created persistent namespace: %s\n", bind_path);
    return 0;
}

// Container-style namespace setup
typedef struct {
    char* hostname;
    char* root_path;
    int enable_networking;
} container_config_t;

int setup_container_namespaces(container_config_t* config) {
    // Unshare all namespaces except user (for simplicity)
    int ns_flags = CLONE_NEWPID | CLONE_NEWNET | CLONE_NEWUTS | 
                   CLONE_NEWIPC | CLONE_NEWNS;
    
    if (unshare(ns_flags) == -1) {
        perror("unshare namespaces");
        return -1;
    }
    
    // Set hostname
    if (config->hostname && 
        sethostname(config->hostname, strlen(config->hostname)) == -1) {
        perror("sethostname");
        return -1;
    }
    
    // Setup mount namespace
    if (config->root_path) {
        // Mount new root
        if (mount(config->root_path, config->root_path, NULL, MS_BIND, NULL) == -1) {
            perror("bind mount root");
            return -1;
        }
        
        // Change root
        if (chdir(config->root_path) == -1) {
            perror("chdir to new root");
            return -1;
        }
        
        if (chroot(".") == -1) {
            perror("chroot");
            return -1;
        }
        
        if (chdir("/") == -1) {
            perror("chdir to /");
            return -1;
        }
    }
    
    // Setup networking if requested
    if (config->enable_networking) {
        setup_loopback_interface();
    }
    
    return 0;
}
```

## Control Groups (Cgroups): Resource Management

### Cgroups v1 Implementation

```c
// cgroups_v1.c - Cgroups v1 resource management
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/stat.h>
#include <fcntl.h>

#define CGROUP_MOUNT "/sys/fs/cgroup"

typedef struct {
    char name[256];
    long memory_limit;      // bytes
    long cpu_shares;        // relative weight
    long cpu_quota;         // microseconds per period
    long cpu_period;        // microseconds
    char* allowed_devices;  // device whitelist
} cgroup_config_t;

// Write value to cgroup file
int write_cgroup_file(const char* controller, const char* cgroup_name, 
                     const char* file, const char* value) {
    char path[512];
    snprintf(path, sizeof(path), "%s/%s/%s/%s", 
             CGROUP_MOUNT, controller, cgroup_name, file);
    
    int fd = open(path, O_WRONLY);
    if (fd == -1) {
        perror("open cgroup file");
        return -1;
    }
    
    if (write(fd, value, strlen(value)) == -1) {
        perror("write cgroup file");
        close(fd);
        return -1;
    }
    
    close(fd);
    return 0;
}

// Read value from cgroup file
int read_cgroup_file(const char* controller, const char* cgroup_name,
                    const char* file, char* buffer, size_t size) {
    char path[512];
    snprintf(path, sizeof(path), "%s/%s/%s/%s", 
             CGROUP_MOUNT, controller, cgroup_name, file);
    
    int fd = open(path, O_RDONLY);
    if (fd == -1) {
        perror("open cgroup file");
        return -1;
    }
    
    ssize_t bytes = read(fd, buffer, size - 1);
    if (bytes == -1) {
        perror("read cgroup file");
        close(fd);
        return -1;
    }
    
    buffer[bytes] = '\0';
    close(fd);
    return 0;
}

// Create cgroup
int create_cgroup(const char* controller, const char* cgroup_name) {
    char path[512];
    snprintf(path, sizeof(path), "%s/%s/%s", 
             CGROUP_MOUNT, controller, cgroup_name);
    
    if (mkdir(path, 0755) == -1 && errno != EEXIST) {
        perror("mkdir cgroup");
        return -1;
    }
    
    return 0;
}

// Apply cgroup configuration
int apply_cgroup_config(cgroup_config_t* config) {
    char value[256];
    
    // Create cgroups for each controller
    create_cgroup("memory", config->name);
    create_cgroup("cpu", config->name);
    create_cgroup("devices", config->name);
    
    // Set memory limit
    if (config->memory_limit > 0) {
        snprintf(value, sizeof(value), "%ld", config->memory_limit);
        write_cgroup_file("memory", config->name, "memory.limit_in_bytes", value);
        
        // Disable swap for container
        write_cgroup_file("memory", config->name, "memory.swappiness", "0");
        
        // Set OOM killer behavior
        write_cgroup_file("memory", config->name, "memory.oom_control", "1");
    }
    
    // Set CPU limits
    if (config->cpu_shares > 0) {
        snprintf(value, sizeof(value), "%ld", config->cpu_shares);
        write_cgroup_file("cpu", config->name, "cpu.shares", value);
    }
    
    if (config->cpu_quota > 0 && config->cpu_period > 0) {
        snprintf(value, sizeof(value), "%ld", config->cpu_period);
        write_cgroup_file("cpu", config->name, "cpu.cfs_period_us", value);
        
        snprintf(value, sizeof(value), "%ld", config->cpu_quota);
        write_cgroup_file("cpu", config->name, "cpu.cfs_quota_us", value);
    }
    
    // Set device restrictions
    if (config->allowed_devices) {
        // Deny all devices first
        write_cgroup_file("devices", config->name, "devices.deny", "a");
        
        // Allow specific devices
        write_cgroup_file("devices", config->name, "devices.allow", config->allowed_devices);
    }
    
    return 0;
}

// Add process to cgroup
int add_process_to_cgroup(const char* controller, const char* cgroup_name, pid_t pid) {
    char value[64];
    snprintf(value, sizeof(value), "%d", pid);
    
    return write_cgroup_file(controller, cgroup_name, "cgroup.procs", value);
}

// Monitor cgroup resource usage
void monitor_cgroup_usage(const char* cgroup_name) {
    char buffer[1024];
    
    printf("=== Cgroup Resource Usage: %s ===\n", cgroup_name);
    
    // Memory usage
    if (read_cgroup_file("memory", cgroup_name, "memory.usage_in_bytes", 
                        buffer, sizeof(buffer)) == 0) {
        long usage = strtol(buffer, NULL, 10);
        printf("Memory usage: %ld bytes (%.2f MB)\n", usage, usage / 1024.0 / 1024.0);
    }
    
    // Memory limit
    if (read_cgroup_file("memory", cgroup_name, "memory.limit_in_bytes", 
                        buffer, sizeof(buffer)) == 0) {
        long limit = strtol(buffer, NULL, 10);
        printf("Memory limit: %ld bytes (%.2f MB)\n", limit, limit / 1024.0 / 1024.0);
    }
    
    // CPU usage
    if (read_cgroup_file("cpu", cgroup_name, "cpuacct.usage", 
                        buffer, sizeof(buffer)) == 0) {
        long usage = strtol(buffer, NULL, 10);
        printf("CPU usage: %ld nanoseconds (%.2f seconds)\n", usage, usage / 1e9);
    }
    
    // Process count
    if (read_cgroup_file("memory", cgroup_name, "cgroup.procs", 
                        buffer, sizeof(buffer)) == 0) {
        int count = 0;
        char* line = strtok(buffer, "\n");
        while (line) {
            count++;
            line = strtok(NULL, "\n");
        }
        printf("Process count: %d\n", count);
    }
}
```

### Cgroups v2 (Unified Hierarchy)

```c
// cgroups_v2.c - Cgroups v2 unified hierarchy
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define CGROUP_V2_MOUNT "/sys/fs/cgroup"

typedef struct {
    char name[256];
    char memory_max[64];     // "100M", "1G", "max"
    char memory_high[64];    // soft limit
    char cpu_max[64];        // "50000 100000" (quota period)
    int cpu_weight;          // 1-10000
    char io_max[256];        // "8:16 rbps=2097152 wbps=1048576"
} cgroup_v2_config_t;

// Write to cgroup v2 file
int write_cgroup_v2_file(const char* cgroup_name, const char* file, const char* value) {
    char path[512];
    snprintf(path, sizeof(path), "%s/%s/%s", CGROUP_V2_MOUNT, cgroup_name, file);
    
    FILE* fp = fopen(path, "w");
    if (!fp) {
        perror("fopen cgroup v2 file");
        return -1;
    }
    
    if (fprintf(fp, "%s", value) < 0) {
        perror("write cgroup v2 file");
        fclose(fp);
        return -1;
    }
    
    fclose(fp);
    return 0;
}

// Create cgroup v2
int create_cgroup_v2(const char* cgroup_name) {
    char path[512];
    snprintf(path, sizeof(path), "%s/%s", CGROUP_V2_MOUNT, cgroup_name);
    
    if (mkdir(path, 0755) == -1 && errno != EEXIST) {
        perror("mkdir cgroup v2");
        return -1;
    }
    
    // Enable controllers
    write_cgroup_v2_file(cgroup_name, "cgroup.subtree_control", 
                        "+cpu +memory +io +pids");
    
    return 0;
}

// Apply cgroup v2 configuration
int apply_cgroup_v2_config(cgroup_v2_config_t* config) {
    create_cgroup_v2(config->name);
    
    // Memory limits
    if (strlen(config->memory_max) > 0) {
        write_cgroup_v2_file(config->name, "memory.max", config->memory_max);
    }
    
    if (strlen(config->memory_high) > 0) {
        write_cgroup_v2_file(config->name, "memory.high", config->memory_high);
    }
    
    // CPU limits
    if (strlen(config->cpu_max) > 0) {
        write_cgroup_v2_file(config->name, "cpu.max", config->cpu_max);
    }
    
    if (config->cpu_weight > 0) {
        char weight[64];
        snprintf(weight, sizeof(weight), "%d", config->cpu_weight);
        write_cgroup_v2_file(config->name, "cpu.weight", weight);
    }
    
    // IO limits
    if (strlen(config->io_max) > 0) {
        write_cgroup_v2_file(config->name, "io.max", config->io_max);
    }
    
    return 0;
}

// Advanced cgroup v2 features
void setup_memory_events(const char* cgroup_name) {
    // Set up memory pressure events
    write_cgroup_v2_file(cgroup_name, "memory.events", "");
    
    // Configure pressure stall information
    write_cgroup_v2_file(cgroup_name, "cgroup.pressure", "1");
}

// Monitor cgroup v2 statistics
void monitor_cgroup_v2_stats(const char* cgroup_name) {
    char path[512];
    FILE* fp;
    char line[256];
    
    printf("=== Cgroup v2 Statistics: %s ===\n", cgroup_name);
    
    // Memory stats
    snprintf(path, sizeof(path), "%s/%s/memory.stat", CGROUP_V2_MOUNT, cgroup_name);
    fp = fopen(path, "r");
    if (fp) {
        printf("\nMemory Statistics:\n");
        while (fgets(line, sizeof(line), fp)) {
            if (strstr(line, "anon") || strstr(line, "file") || 
                strstr(line, "kernel") || strstr(line, "sock")) {
                printf("  %s", line);
            }
        }
        fclose(fp);
    }
    
    // CPU stats
    snprintf(path, sizeof(path), "%s/%s/cpu.stat", CGROUP_V2_MOUNT, cgroup_name);
    fp = fopen(path, "r");
    if (fp) {
        printf("\nCPU Statistics:\n");
        while (fgets(line, sizeof(line), fp)) {
            printf("  %s", line);
        }
        fclose(fp);
    }
    
    // IO stats
    snprintf(path, sizeof(path), "%s/%s/io.stat", CGROUP_V2_MOUNT, cgroup_name);
    fp = fopen(path, "r");
    if (fp) {
        printf("\nIO Statistics:\n");
        while (fgets(line, sizeof(line), fp)) {
            printf("  %s", line);
        }
        fclose(fp);
    }
    
    // Pressure information
    snprintf(path, sizeof(path), "%s/%s/memory.pressure", CGROUP_V2_MOUNT, cgroup_name);
    fp = fopen(path, "r");
    if (fp) {
        printf("\nMemory Pressure:\n");
        while (fgets(line, sizeof(line), fp)) {
            printf("  %s", line);
        }
        fclose(fp);
    }
}
```

## Building a Container Runtime

### Simple Container Implementation

```c
// simple_container.c - Basic container runtime
#define _GNU_SOURCE
#include <sched.h>
#include <unistd.h>
#include <sys/wait.h>
#include <sys/mount.h>
#include <sys/capability.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    char* name;
    char* image_path;
    char* command;
    char** args;
    char** env;
    
    // Resource limits
    long memory_limit;
    long cpu_shares;
    
    // Capabilities
    cap_value_t* capabilities;
    int num_capabilities;
    
    // Networking
    int enable_networking;
    char* ip_address;
    
    // Security
    int read_only_root;
    char** bind_mounts;
} container_spec_t;

// Capability dropping
int drop_capabilities(cap_value_t* keep_caps, int num_caps) {
    cap_t caps = cap_get_proc();
    if (!caps) {
        perror("cap_get_proc");
        return -1;
    }
    
    // Clear all capabilities
    if (cap_clear(caps) == -1) {
        perror("cap_clear");
        cap_free(caps);
        return -1;
    }
    
    // Set only allowed capabilities
    if (num_caps > 0) {
        if (cap_set_flag(caps, CAP_EFFECTIVE, num_caps, keep_caps, CAP_SET) == -1 ||
            cap_set_flag(caps, CAP_PERMITTED, num_caps, keep_caps, CAP_SET) == -1) {
            perror("cap_set_flag");
            cap_free(caps);
            return -1;
        }
    }
    
    // Apply capabilities
    if (cap_set_proc(caps) == -1) {
        perror("cap_set_proc");
        cap_free(caps);
        return -1;
    }
    
    cap_free(caps);
    return 0;
}

// Setup container filesystem
int setup_container_fs(container_spec_t* spec) {
    // Create container root directory
    char container_root[256];
    snprintf(container_root, sizeof(container_root), "/tmp/container_%s", spec->name);
    
    if (mkdir(container_root, 0755) == -1 && errno != EEXIST) {
        perror("mkdir container root");
        return -1;
    }
    
    // Mount container image
    if (mount(spec->image_path, container_root, NULL, MS_BIND, NULL) == -1) {
        perror("mount container image");
        return -1;
    }
    
    // Make read-only if requested
    if (spec->read_only_root) {
        if (mount(NULL, container_root, NULL, MS_REMOUNT | MS_RDONLY | MS_BIND, NULL) == -1) {
            perror("remount read-only");
            return -1;
        }
    }
    
    // Setup bind mounts
    if (spec->bind_mounts) {
        for (int i = 0; spec->bind_mounts[i]; i++) {
            char* mount_spec = strdup(spec->bind_mounts[i]);
            char* src = strtok(mount_spec, ":");
            char* dst = strtok(NULL, ":");
            
            char full_dst[512];
            snprintf(full_dst, sizeof(full_dst), "%s%s", container_root, dst);
            
            // Create destination directory
            mkdir(full_dst, 0755);
            
            if (mount(src, full_dst, NULL, MS_BIND, NULL) == -1) {
                perror("bind mount");
                free(mount_spec);
                return -1;
            }
            
            free(mount_spec);
        }
    }
    
    // Setup essential filesystems
    char proc_path[512], sys_path[512], dev_path[512];
    snprintf(proc_path, sizeof(proc_path), "%s/proc", container_root);
    snprintf(sys_path, sizeof(sys_path), "%s/sys", container_root);
    snprintf(dev_path, sizeof(dev_path), "%s/dev", container_root);
    
    mkdir(proc_path, 0755);
    mkdir(sys_path, 0755);
    mkdir(dev_path, 0755);
    
    mount("proc", proc_path, "proc", 0, NULL);
    mount("sysfs", sys_path, "sysfs", 0, NULL);
    mount("tmpfs", dev_path, "tmpfs", 0, "size=1m");
    
    // Create essential device nodes
    char dev_null[512], dev_zero[512];
    snprintf(dev_null, sizeof(dev_null), "%s/dev/null", container_root);
    snprintf(dev_zero, sizeof(dev_zero), "%s/dev/zero", container_root);
    
    mknod(dev_null, S_IFCHR | 0666, makedev(1, 3));
    mknod(dev_zero, S_IFCHR | 0666, makedev(1, 5));
    
    // Change root
    if (chdir(container_root) == -1) {
        perror("chdir");
        return -1;
    }
    
    if (chroot(".") == -1) {
        perror("chroot");
        return -1;
    }
    
    if (chdir("/") == -1) {
        perror("chdir to /");
        return -1;
    }
    
    return 0;
}

// Container main function
int container_main(void* arg) {
    container_spec_t* spec = (container_spec_t*)arg;
    
    // Setup cgroup
    cgroup_config_t cgroup_config = {0};
    strncpy(cgroup_config.name, spec->name, sizeof(cgroup_config.name) - 1);
    cgroup_config.memory_limit = spec->memory_limit;
    cgroup_config.cpu_shares = spec->cpu_shares;
    
    apply_cgroup_config(&cgroup_config);
    add_process_to_cgroup("memory", spec->name, getpid());
    add_process_to_cgroup("cpu", spec->name, getpid());
    
    // Setup hostname
    if (sethostname(spec->name, strlen(spec->name)) == -1) {
        perror("sethostname");
        return 1;
    }
    
    // Setup filesystem
    if (setup_container_fs(spec) == -1) {
        return 1;
    }
    
    // Setup networking
    if (spec->enable_networking) {
        setup_loopback_interface();
        
        if (spec->ip_address) {
            char cmd[256];
            snprintf(cmd, sizeof(cmd), "ip addr add %s dev lo", spec->ip_address);
            system(cmd);
        }
    }
    
    // Drop capabilities
    if (drop_capabilities(spec->capabilities, spec->num_capabilities) == -1) {
        return 1;
    }
    
    // Execute command
    if (spec->env) {
        execvpe(spec->command, spec->args, spec->env);
    } else {
        execvp(spec->command, spec->args);
    }
    
    perror("execvp");
    return 1;
}

// Run container
int run_container(container_spec_t* spec) {
    const int STACK_SIZE = 1024 * 1024;
    char* stack = malloc(STACK_SIZE);
    
    if (!stack) {
        perror("malloc");
        return -1;
    }
    
    // Create namespaces
    int flags = CLONE_NEWPID | CLONE_NEWNET | CLONE_NEWUTS | 
                CLONE_NEWIPC | CLONE_NEWNS | CLONE_NEWUSER;
    
    pid_t container_pid = clone(container_main, stack + STACK_SIZE, 
                               flags | SIGCHLD, spec);
    
    if (container_pid == -1) {
        perror("clone");
        free(stack);
        return -1;
    }
    
    // Setup user namespace mappings
    setup_user_namespace_mappings(container_pid);
    
    printf("Container %s started with PID %d\n", spec->name, container_pid);
    
    // Wait for container
    int status;
    waitpid(container_pid, &status, 0);
    
    free(stack);
    return WEXITSTATUS(status);
}
```

### Container Image Management

```c
// container_image.c - Container image handling
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <archive.h>
#include <archive_entry.h>

typedef struct {
    char name[256];
    char tag[64];
    char digest[128];
    size_t size;
    time_t created;
    char* config_json;
} container_image_t;

// Extract container image (tar format)
int extract_container_image(const char* image_path, const char* extract_path) {
    struct archive* a;
    struct archive* ext;
    struct archive_entry* entry;
    int r;
    
    a = archive_read_new();
    archive_read_support_filter_gzip(a);
    archive_read_support_format_tar(a);
    
    ext = archive_write_disk_new();
    archive_write_disk_set_options(ext, ARCHIVE_EXTRACT_TIME | ARCHIVE_EXTRACT_PERM);
    
    if ((r = archive_read_open_filename(a, image_path, 10240))) {
        fprintf(stderr, "Error opening image: %s\n", archive_error_string(a));
        return -1;
    }
    
    // Change to extraction directory
    if (chdir(extract_path) != 0) {
        perror("chdir");
        return -1;
    }
    
    while (archive_read_next_header(a, &entry) == ARCHIVE_OK) {
        const char* current_file = archive_entry_pathname(entry);
        
        printf("Extracting: %s\n", current_file);
        
        // Set full path
        char full_path[512];
        snprintf(full_path, sizeof(full_path), "%s/%s", extract_path, current_file);
        archive_entry_set_pathname(entry, full_path);
        
        r = archive_write_header(ext, entry);
        if (r < ARCHIVE_OK) {
            fprintf(stderr, "Warning: %s\n", archive_error_string(ext));
        }
        
        if (archive_entry_size(entry) > 0) {
            copy_data(a, ext);
        }
        
        r = archive_write_finish_entry(ext);
        if (r < ARCHIVE_OK) {
            fprintf(stderr, "Warning: %s\n", archive_error_string(ext));
        }
    }
    
    archive_read_close(a);
    archive_read_free(a);
    archive_write_close(ext);
    archive_write_free(ext);
    
    return 0;
}

// Copy data between archives
static int copy_data(struct archive* ar, struct archive* aw) {
    int r;
    const void* buff;
    size_t size;
    la_int64_t offset;
    
    for (;;) {
        r = archive_read_data_block(ar, &buff, &size, &offset);
        if (r == ARCHIVE_EOF)
            return ARCHIVE_OK;
        if (r < ARCHIVE_OK)
            return r;
        
        r = archive_write_data_block(aw, buff, size, offset);
        if (r < ARCHIVE_OK) {
            fprintf(stderr, "Error: %s\n", archive_error_string(aw));
            return r;
        }
    }
}

// Create container filesystem layers
int create_overlay_filesystem(const char* lower_dir, const char* upper_dir, 
                             const char* work_dir, const char* merged_dir) {
    char mount_options[1024];
    snprintf(mount_options, sizeof(mount_options), 
             "lowerdir=%s,upperdir=%s,workdir=%s", 
             lower_dir, upper_dir, work_dir);
    
    // Create directories
    mkdir(upper_dir, 0755);
    mkdir(work_dir, 0755);
    mkdir(merged_dir, 0755);
    
    // Mount overlay filesystem
    if (mount("overlay", merged_dir, "overlay", 0, mount_options) == -1) {
        perror("mount overlay");
        return -1;
    }
    
    printf("Overlay filesystem mounted at %s\n", merged_dir);
    return 0;
}

// Container registry interaction
typedef struct {
    char registry[256];
    char username[128];
    char password[128];
    char auth_token[512];
} registry_config_t;

// Simple HTTP client for registry operations
int download_image_manifest(registry_config_t* config, 
                           const char* image_name, const char* tag,
                           char* manifest_buffer, size_t buffer_size) {
    // This would implement actual HTTP client
    // For demonstration, we'll use curl system call
    char cmd[1024];
    snprintf(cmd, sizeof(cmd), 
             "curl -s -H 'Accept: application/vnd.docker.distribution.manifest.v2+json' "
             "-H 'Authorization: Bearer %s' "
             "https://%s/v2/%s/manifests/%s",
             config->auth_token, config->registry, image_name, tag);
    
    FILE* fp = popen(cmd, "r");
    if (!fp) {
        perror("popen");
        return -1;
    }
    
    size_t read = fread(manifest_buffer, 1, buffer_size - 1, fp);
    manifest_buffer[read] = '\0';
    
    int status = pclose(fp);
    return WEXITSTATUS(status);
}
```

## Advanced Container Features

### Container Networking

```c
// container_networking.c - Advanced container networking
#include <linux/netlink.h>
#include <linux/rtnetlink.h>
#include <sys/socket.h>
#include <net/if.h>

typedef struct {
    char name[32];
    char ip_address[64];
    char gateway[64];
    int mtu;
} veth_config_t;

// Create veth pair
int create_veth_pair(const char* veth1, const char* veth2) {
    // This would use netlink to create veth pair
    char cmd[256];
    snprintf(cmd, sizeof(cmd), "ip link add %s type veth peer name %s", veth1, veth2);
    
    if (system(cmd) != 0) {
        fprintf(stderr, "Failed to create veth pair\n");
        return -1;
    }
    
    return 0;
}

// Move interface to namespace
int move_interface_to_namespace(const char* interface, pid_t target_pid) {
    char cmd[256];
    snprintf(cmd, sizeof(cmd), "ip link set %s netns %d", interface, target_pid);
    
    if (system(cmd) != 0) {
        fprintf(stderr, "Failed to move interface to namespace\n");
        return -1;
    }
    
    return 0;
}

// Setup container bridge networking
int setup_bridge_networking(const char* bridge_name, 
                           const char* container_veth,
                           const char* host_veth,
                           veth_config_t* config) {
    char cmd[512];
    
    // Create bridge if it doesn't exist
    snprintf(cmd, sizeof(cmd), "ip link add %s type bridge 2>/dev/null || true", bridge_name);
    system(cmd);
    
    // Bring up bridge
    snprintf(cmd, sizeof(cmd), "ip link set %s up", bridge_name);
    system(cmd);
    
    // Create veth pair
    create_veth_pair(container_veth, host_veth);
    
    // Add host veth to bridge
    snprintf(cmd, sizeof(cmd), "ip link set %s master %s", host_veth, bridge_name);
    system(cmd);
    
    // Bring up host veth
    snprintf(cmd, sizeof(cmd), "ip link set %s up", host_veth);
    system(cmd);
    
    return 0;
}

// Configure container network interface
int configure_container_interface(veth_config_t* config) {
    char cmd[256];
    
    // Bring up interface
    snprintf(cmd, sizeof(cmd), "ip link set %s up", config->name);
    system(cmd);
    
    // Set IP address
    snprintf(cmd, sizeof(cmd), "ip addr add %s dev %s", config->ip_address, config->name);
    system(cmd);
    
    // Set MTU
    if (config->mtu > 0) {
        snprintf(cmd, sizeof(cmd), "ip link set %s mtu %d", config->name, config->mtu);
        system(cmd);
    }
    
    // Set default route
    if (strlen(config->gateway) > 0) {
        snprintf(cmd, sizeof(cmd), "ip route add default via %s", config->gateway);
        system(cmd);
    }
    
    return 0;
}
```

### Container Security

```c
// container_security.c - Advanced container security
#include <sys/prctl.h>
#include <linux/securebits.h>
#include <linux/seccomp.h>
#include <linux/filter.h>

// Seccomp filter for containers
struct sock_filter seccomp_filter[] = {
    // Allow basic syscalls
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    
    // Allow read/write/open
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_read, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_write, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_openat, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    
    // Deny dangerous syscalls
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_ptrace, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_reboot, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_kexec_load, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL),
    
    // Default allow
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
};

// Apply seccomp filter
int apply_seccomp_filter() {
    struct sock_fprog prog = {
        .len = sizeof(seccomp_filter) / sizeof(seccomp_filter[0]),
        .filter = seccomp_filter,
    };
    
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == -1) {
        perror("prctl NO_NEW_PRIVS");
        return -1;
    }
    
    if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &prog) == -1) {
        perror("prctl SECCOMP");
        return -1;
    }
    
    return 0;
}

// Setup security policies
int setup_container_security() {
    // Drop all capabilities except basic ones
    cap_value_t keep_caps[] = {
        CAP_CHOWN,
        CAP_DAC_OVERRIDE,
        CAP_FOWNER,
        CAP_SETGID,
        CAP_SETUID,
    };
    
    drop_capabilities(keep_caps, sizeof(keep_caps) / sizeof(keep_caps[0]));
    
    // Apply seccomp filter
    apply_seccomp_filter();
    
    // Disable core dumps
    if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) == -1) {
        perror("prctl DUMPABLE");
        return -1;
    }
    
    // Set process death signal
    if (prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) == -1) {
        perror("prctl PDEATHSIG");
        return -1;
    }
    
    return 0;
}
```

## Container Orchestration Basics

### Container Management

```bash
#!/bin/bash
# container_manager.sh - Simple container orchestration

CONTAINER_DIR="/tmp/containers"
BRIDGE_NAME="container0"

# Initialize container environment
init_container_env() {
    mkdir -p $CONTAINER_DIR/{running,stopped,images}
    
    # Setup bridge network
    if ! ip link show $BRIDGE_NAME &>/dev/null; then
        ip link add $BRIDGE_NAME type bridge
        ip addr add 172.17.0.1/16 dev $BRIDGE_NAME
        ip link set $BRIDGE_NAME up
        
        # Enable IP forwarding
        echo 1 > /proc/sys/net/ipv4/ip_forward
        
        # Setup iptables rules
        iptables -t nat -A POSTROUTING -s 172.17.0.0/16 ! -o $BRIDGE_NAME -j MASQUERADE
        iptables -A FORWARD -i $BRIDGE_NAME -o $BRIDGE_NAME -j ACCEPT
    fi
}

# Container lifecycle management
create_container() {
    local name=$1
    local image=$2
    local command=$3
    
    local container_id=$(uuidgen | tr -d '-' | head -c 12)
    local container_path="$CONTAINER_DIR/stopped/$container_id"
    
    mkdir -p $container_path
    
    cat > $container_path/config.json << EOF
{
    "id": "$container_id",
    "name": "$name",
    "image": "$image",
    "command": "$command",
    "created": "$(date -Iseconds)",
    "state": "created"
}
EOF
    
    echo $container_id
}

start_container() {
    local container_id=$1
    local container_path="$CONTAINER_DIR/stopped/$container_id"
    
    if [ ! -d "$container_path" ]; then
        echo "Container $container_id not found"
        return 1
    fi
    
    # Read configuration
    local config=$(cat $container_path/config.json)
    local name=$(echo $config | jq -r '.name')
    local image=$(echo $config | jq -r '.image')
    local command=$(echo $config | jq -r '.command')
    
    # Allocate IP address
    local ip_suffix=$(($RANDOM % 254 + 2))
    local container_ip="172.17.0.$ip_suffix"
    
    # Create container namespace and run
    local pid=$(nohup unshare --pid --net --uts --ipc --mount --fork \
        bash -c "
            # Setup networking
            hostname $name
            
            # Setup veth pair
            veth_host=\"veth${container_id:0:8}h\"
            veth_container=\"veth${container_id:0:8}c\"
            
            # Create veth pair in host namespace
            ip link add \$veth_host type veth peer name \$veth_container
            ip link set \$veth_host master $BRIDGE_NAME
            ip link set \$veth_host up
            
            # Move container veth to container namespace
            ip link set \$veth_container netns \$\$
            
            # Configure container interface
            ip addr add $container_ip/16 dev \$veth_container
            ip link set \$veth_container up
            ip route add default via 172.17.0.1
            
            # Execute command
            exec $command
        " > $container_path/stdout.log 2> $container_path/stderr.log & echo $!)
    
    # Move to running directory
    mv $container_path $CONTAINER_DIR/running/$container_id
    
    # Update container state
    jq '.state = "running" | .pid = '$pid' | .ip = "'$container_ip'"' \
        $CONTAINER_DIR/running/$container_id/config.json > /tmp/config.tmp
    mv /tmp/config.tmp $CONTAINER_DIR/running/$container_id/config.json
    
    echo "Container $container_id started (PID: $pid, IP: $container_ip)"
}

stop_container() {
    local container_id=$1
    local container_path="$CONTAINER_DIR/running/$container_id"
    
    if [ ! -d "$container_path" ]; then
        echo "Container $container_id not running"
        return 1
    fi
    
    local pid=$(jq -r '.pid' $container_path/config.json)
    
    # Send SIGTERM then SIGKILL
    kill -TERM $pid 2>/dev/null
    sleep 5
    kill -KILL $pid 2>/dev/null
    
    # Clean up networking
    local veth_host="veth${container_id:0:8}h"
    ip link delete $veth_host 2>/dev/null
    
    # Move to stopped directory
    mv $container_path $CONTAINER_DIR/stopped/$container_id
    
    # Update state
    jq '.state = "stopped" | .stopped = "'$(date -Iseconds)'"' \
        $CONTAINER_DIR/stopped/$container_id/config.json > /tmp/config.tmp
    mv /tmp/config.tmp $CONTAINER_DIR/stopped/$container_id/config.json
    
    echo "Container $container_id stopped"
}

list_containers() {
    echo "CONTAINER ID    NAME           STATE      IP ADDRESS      COMMAND"
    echo "============    ====           =====      ==========      ======="
    
    for state_dir in running stopped; do
        for container_path in $CONTAINER_DIR/$state_dir/*; do
            if [ -f "$container_path/config.json" ]; then
                local config=$(cat $container_path/config.json)
                local id=$(basename $container_path)
                local name=$(echo $config | jq -r '.name')
                local state=$(echo $config | jq -r '.state')
                local ip=$(echo $config | jq -r '.ip // "N/A"')
                local command=$(echo $config | jq -r '.command')
                
                printf "%-15s %-14s %-10s %-15s %s\n" \
                    "${id:0:12}" "$name" "$state" "$ip" "$command"
            fi
        done
    done
}

# Resource monitoring
monitor_containers() {
    echo "=== Container Resource Usage ==="
    
    for container_path in $CONTAINER_DIR/running/*; do
        if [ -f "$container_path/config.json" ]; then
            local config=$(cat $container_path/config.json)
            local id=$(basename $container_path)
            local name=$(echo $config | jq -r '.name')
            local pid=$(echo $config | jq -r '.pid')
            
            echo "Container: $name ($id)"
            
            if [ -d "/proc/$pid" ]; then
                # CPU usage
                local cpu_usage=$(ps -p $pid -o %cpu --no-headers)
                echo "  CPU: $cpu_usage%"
                
                # Memory usage
                local mem_usage=$(ps -p $pid -o rss --no-headers)
                echo "  Memory: $((mem_usage / 1024)) MB"
                
                # Process count
                local proc_count=$(pstree -p $pid | grep -o '([0-9]*)' | wc -l)
                echo "  Processes: $proc_count"
            else
                echo "  Status: Not running"
            fi
            echo
        fi
    done
}

# Main command interface
case "$1" in
    init)
        init_container_env
        ;;
    create)
        create_container "$2" "$3" "$4"
        ;;
    start)
        start_container "$2"
        ;;
    stop)
        stop_container "$2"
        ;;
    list)
        list_containers
        ;;
    monitor)
        monitor_containers
        ;;
    *)
        echo "Usage: $0 {init|create|start|stop|list|monitor}"
        echo "  create <name> <image> <command>"
        echo "  start <container_id>"
        echo "  stop <container_id>"
        ;;
esac
```

## Conclusion

Container technology represents a sophisticated orchestration of Linux kernel features. Understanding namespaces, cgroups, and security mechanisms at a deep level enables building robust, secure containerized systems. From simple isolation to complex orchestration, these fundamental technologies power modern cloud infrastructure.

The techniques covered here—namespace management, resource control, security hardening, and runtime implementation—provide the foundation for understanding and extending container technology. Whether you're building custom runtimes, debugging container issues, or implementing security policies, mastering these internals is essential for modern infrastructure development.

Container internals knowledge also enables better troubleshooting, performance optimization, and security analysis in production environments. As containers continue to evolve, understanding these core concepts ensures you can adapt to new technologies and solve complex challenges in containerized systems.