---
title: "Advanced Process and Thread Management Techniques in Linux"
date: 2026-04-14T00:00:00-05:00
author: "Systems Engineering Team"
description: "Master advanced process and thread management in Linux systems. Learn sophisticated scheduling strategies, resource control, IPC mechanisms, thread pools, and enterprise-grade process orchestration techniques."
categories: ["Systems Programming", "Process Management", "Threading"]
tags: ["process management", "thread management", "Linux scheduling", "cgroups", "namespaces", "IPC", "thread pools", "resource control", "process orchestration", "enterprise systems"]
keywords: ["Linux process management", "thread management", "process scheduling", "cgroups", "namespaces", "IPC mechanisms", "thread pools", "resource control", "process orchestration", "enterprise process management"]
draft: false
toc: true
---

Advanced process and thread management forms the backbone of high-performance enterprise systems. This comprehensive guide explores sophisticated techniques for controlling, orchestrating, and optimizing processes and threads in Linux environments, covering everything from low-level scheduling mechanisms to enterprise-scale process orchestration patterns.

## Advanced Process Creation and Control

Modern Linux systems provide sophisticated mechanisms for process creation, control, and monitoring that go far beyond basic fork() and exec() operations.

### Process Creation with Fine-Grained Control

```c
#define _GNU_SOURCE
#include <sched.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <unistd.h>
#include <signal.h>
#include <fcntl.h>

typedef struct {
    pid_t pid;
    int clone_flags;
    cpu_set_t cpu_affinity;
    int priority;
    int nice_value;
    
    // Resource limits
    struct rlimit memory_limit;
    struct rlimit cpu_limit;
    struct rlimit file_limit;
    
    // Namespace information
    char *mount_namespace;
    char *net_namespace;
    char *pid_namespace;
    char *user_namespace;
    
    // Control structures
    int control_pipe[2];
    int status_pipe[2];
    
    // Security context
    uid_t uid;
    gid_t gid;
    char *security_label;
    
    // Monitoring
    struct timespec start_time;
    struct rusage resource_usage;
} advanced_process_t;

// Stack for clone() system call
#define STACK_SIZE (1024 * 1024)

// Child process entry point with comprehensive setup
int child_process_main(void *arg) {
    advanced_process_t *proc = (advanced_process_t*)arg;
    
    // Set process title
    prctl(PR_SET_NAME, "managed_process", 0, 0, 0);
    
    // Set up death signal to parent
    prctl(PR_SET_PDEATHSIG, SIGTERM);
    
    // Apply CPU affinity
    if (sched_setaffinity(0, sizeof(cpu_set_t), &proc->cpu_affinity) < 0) {
        perror("Failed to set CPU affinity");
    }
    
    // Set scheduling priority
    struct sched_param param;
    param.sched_priority = proc->priority;
    if (sched_setscheduler(0, SCHED_FIFO, &param) < 0) {
        // Fallback to nice value
        if (setpriority(PRIO_PROCESS, 0, proc->nice_value) < 0) {
            perror("Failed to set process priority");
        }
    }
    
    // Apply resource limits
    setrlimit(RLIMIT_AS, &proc->memory_limit);
    setrlimit(RLIMIT_CPU, &proc->cpu_limit);
    setrlimit(RLIMIT_NOFILE, &proc->file_limit);
    
    // Set user/group ID
    if (proc->gid != 0 && setgid(proc->gid) < 0) {
        perror("Failed to set GID");
        return -1;
    }
    
    if (proc->uid != 0 && setuid(proc->uid) < 0) {
        perror("Failed to set UID");
        return -1;
    }
    
    // Signal readiness to parent
    char ready_signal = 1;
    write(proc->status_pipe[1], &ready_signal, 1);
    close(proc->status_pipe[1]);
    
    // Wait for start signal from parent
    char start_signal;
    read(proc->control_pipe[0], &start_signal, 1);
    close(proc->control_pipe[0]);
    
    // Execute main program logic here
    // This would be replaced with actual application code
    
    return 0;
}

// Create advanced process with full control
advanced_process_t* create_advanced_process(int clone_flags, 
                                           const cpu_set_t *cpu_affinity,
                                           int priority,
                                           const struct rlimit *limits) {
    advanced_process_t *proc = calloc(1, sizeof(advanced_process_t));
    if (!proc) return NULL;
    
    proc->clone_flags = clone_flags;
    
    if (cpu_affinity) {
        proc->cpu_affinity = *cpu_affinity;
    } else {
        CPU_ZERO(&proc->cpu_affinity);
        CPU_SET(0, &proc->cpu_affinity); // Default to CPU 0
    }
    
    proc->priority = priority;
    proc->nice_value = 0;
    
    // Set default resource limits
    if (limits) {
        proc->memory_limit = limits[0];
        proc->cpu_limit = limits[1];
        proc->file_limit = limits[2];
    } else {
        // Set reasonable defaults
        proc->memory_limit.rlim_cur = 1024 * 1024 * 1024; // 1GB
        proc->memory_limit.rlim_max = 2048 * 1024 * 1024; // 2GB
        proc->cpu_limit.rlim_cur = 300; // 5 minutes
        proc->cpu_limit.rlim_max = 600; // 10 minutes
        proc->file_limit.rlim_cur = 1024;
        proc->file_limit.rlim_max = 2048;
    }
    
    // Create communication pipes
    if (pipe(proc->control_pipe) < 0 || pipe(proc->status_pipe) < 0) {
        free(proc);
        return NULL;
    }
    
    // Allocate stack for child
    void *child_stack = malloc(STACK_SIZE);
    if (!child_stack) {
        close(proc->control_pipe[0]);
        close(proc->control_pipe[1]);
        close(proc->status_pipe[0]);
        close(proc->status_pipe[1]);
        free(proc);
        return NULL;
    }
    
    // Create process using clone()
    proc->pid = clone(child_process_main, 
                     (char*)child_stack + STACK_SIZE,
                     proc->clone_flags | SIGCHLD,
                     proc);
    
    if (proc->pid < 0) {
        perror("Failed to create process");
        free(child_stack);
        close(proc->control_pipe[0]);
        close(proc->control_pipe[1]);
        close(proc->status_pipe[0]);
        close(proc->status_pipe[1]);
        free(proc);
        return NULL;
    }
    
    // Close child ends of pipes
    close(proc->control_pipe[0]);
    close(proc->status_pipe[1]);
    
    // Wait for child readiness
    char ready_signal;
    read(proc->status_pipe[0], &ready_signal, 1);
    close(proc->status_pipe[0]);
    
    clock_gettime(CLOCK_MONOTONIC, &proc->start_time);
    
    return proc;
}

// Start the created process
void start_advanced_process(advanced_process_t *proc) {
    char start_signal = 1;
    write(proc->control_pipe[1], &start_signal, 1);
    close(proc->control_pipe[1]);
}

// Monitor process resource usage
void update_process_stats(advanced_process_t *proc) {
    if (getrusage(RUSAGE_CHILDREN, &proc->resource_usage) < 0) {
        perror("Failed to get resource usage");
    }
}
```

## Container and Namespace Management

Linux namespaces provide powerful isolation mechanisms that are essential for modern container and security architectures.

### Comprehensive Namespace Management

```c
#include <sys/mount.h>
#include <sys/stat.h>

typedef struct {
    char *name;
    int type; // CLONE_NEWPID, CLONE_NEWNET, etc.
    int fd;   // File descriptor for the namespace
    bool active;
} namespace_t;

typedef struct {
    namespace_t namespaces[8]; // Support for all namespace types
    int namespace_count;
    char *container_root;
    bool isolated;
    
    // Network configuration for NEWNET
    char *veth_pair[2];
    char *bridge_name;
    char *ip_address;
    
    // Mount configuration for NEWNS
    char **bind_mounts;
    char **mount_targets;
    int mount_count;
} namespace_manager_t;

// Initialize namespace manager
namespace_manager_t* create_namespace_manager(const char *container_name) {
    namespace_manager_t *manager = calloc(1, sizeof(namespace_manager_t));
    if (!manager) return NULL;
    
    manager->container_root = malloc(256);
    snprintf(manager->container_root, 256, "/var/lib/containers/%s", container_name);
    
    // Create container directory
    mkdir(manager->container_root, 0755);
    
    return manager;
}

// Add namespace to management
int add_namespace(namespace_manager_t *manager, const char *name, int type) {
    if (manager->namespace_count >= 8) return -1;
    
    namespace_t *ns = &manager->namespaces[manager->namespace_count];
    ns->name = strdup(name);
    ns->type = type;
    ns->fd = -1;
    ns->active = false;
    
    manager->namespace_count++;
    return 0;
}

// Create isolated process with custom namespaces
pid_t create_namespaced_process(namespace_manager_t *manager,
                               int (*child_func)(void*),
                               void *child_arg) {
    int clone_flags = SIGCHLD;
    
    // Build clone flags based on configured namespaces
    for (int i = 0; i < manager->namespace_count; i++) {
        clone_flags |= manager->namespaces[i].type;
    }
    
    void *child_stack = malloc(STACK_SIZE);
    if (!child_stack) return -1;
    
    pid_t child_pid = clone(child_func,
                           (char*)child_stack + STACK_SIZE,
                           clone_flags,
                           child_arg);
    
    if (child_pid > 0) {
        // Save namespace file descriptors for later access
        save_namespace_fds(manager, child_pid);
    }
    
    return child_pid;
}

// Save namespace file descriptors for management
void save_namespace_fds(namespace_manager_t *manager, pid_t pid) {
    char ns_path[256];
    
    for (int i = 0; i < manager->namespace_count; i++) {
        const char *ns_name = get_namespace_name(manager->namespaces[i].type);
        snprintf(ns_path, sizeof(ns_path), "/proc/%d/ns/%s", pid, ns_name);
        
        manager->namespaces[i].fd = open(ns_path, O_RDONLY);
        if (manager->namespaces[i].fd >= 0) {
            manager->namespaces[i].active = true;
        }
    }
}

// Get namespace name from type
const char* get_namespace_name(int type) {
    switch (type) {
        case CLONE_NEWPID: return "pid";
        case CLONE_NEWNET: return "net";
        case CLONE_NEWNS: return "mnt";
        case CLONE_NEWUTS: return "uts";
        case CLONE_NEWIPC: return "ipc";
        case CLONE_NEWUSER: return "user";
        case CLONE_NEWCGROUP: return "cgroup";
        default: return "unknown";
    }
}

// Enter existing namespace
int enter_namespace(namespace_manager_t *manager, const char *ns_name) {
    for (int i = 0; i < manager->namespace_count; i++) {
        if (strcmp(manager->namespaces[i].name, ns_name) == 0 &&
            manager->namespaces[i].active) {
            
            if (setns(manager->namespaces[i].fd, manager->namespaces[i].type) < 0) {
                perror("Failed to enter namespace");
                return -1;
            }
            return 0;
        }
    }
    return -1;
}

// Set up network namespace with veth pair
int setup_network_namespace(namespace_manager_t *manager) {
    // This is a simplified version - real implementation would use netlink
    char cmd[512];
    
    // Create veth pair
    snprintf(cmd, sizeof(cmd), 
             "ip link add %s type veth peer name %s",
             manager->veth_pair[0], manager->veth_pair[1]);
    system(cmd);
    
    // Move one end to namespace
    snprintf(cmd, sizeof(cmd),
             "ip link set %s netns %d",
             manager->veth_pair[1], getpid());
    system(cmd);
    
    // Configure IP address
    if (manager->ip_address) {
        snprintf(cmd, sizeof(cmd),
                 "ip addr add %s dev %s",
                 manager->ip_address, manager->veth_pair[1]);
        system(cmd);
        
        snprintf(cmd, sizeof(cmd),
                 "ip link set %s up",
                 manager->veth_pair[1]);
        system(cmd);
    }
    
    return 0;
}

// Set up mount namespace with bind mounts
int setup_mount_namespace(namespace_manager_t *manager) {
    // Create new mount namespace
    if (unshare(CLONE_NEWNS) < 0) {
        perror("Failed to create mount namespace");
        return -1;
    }
    
    // Make all mounts private to prevent propagation
    if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL) < 0) {
        perror("Failed to make mounts private");
        return -1;
    }
    
    // Set up bind mounts
    for (int i = 0; i < manager->mount_count; i++) {
        if (mount(manager->bind_mounts[i], manager->mount_targets[i],
                 NULL, MS_BIND, NULL) < 0) {
            fprintf(stderr, "Failed to bind mount %s to %s\n",
                   manager->bind_mounts[i], manager->mount_targets[i]);
        }
    }
    
    return 0;
}
```

## Advanced Thread Management

Sophisticated thread management requires understanding of thread affinity, scheduling policies, and coordination mechanisms.

### High-Performance Thread Pool Implementation

```c
#include <pthread.h>
#include <semaphore.h>
#include <stdatomic.h>

typedef struct task {
    void (*function)(void *arg);
    void *argument;
    int priority;
    struct timespec submit_time;
    struct task *next;
} task_t;

typedef struct {
    pthread_t thread_id;
    int cpu_affinity;
    bool active;
    atomic_size_t tasks_completed;
    atomic_size_t tasks_failed;
    struct timespec total_execution_time;
    
    // Thread-local statistics
    double average_task_time;
    size_t cache_misses;
    size_t context_switches;
} worker_thread_t;

typedef struct {
    worker_thread_t *workers;
    int num_workers;
    int max_workers;
    int min_workers;
    
    // Task queue with priority support
    task_t *task_queue_head;
    task_t *task_queue_tail;
    task_t *high_priority_queue;
    atomic_size_t queue_size;
    size_t max_queue_size;
    
    // Synchronization
    pthread_mutex_t queue_mutex;
    pthread_cond_t work_available;
    pthread_cond_t queue_not_full;
    
    // Thread pool control
    atomic_bool shutdown;
    atomic_bool immediate_shutdown;
    
    // Adaptive scaling
    atomic_size_t idle_workers;
    atomic_size_t busy_workers;
    time_t last_scale_time;
    int scale_interval;
    
    // Load balancing
    int load_balance_strategy; // 0: round-robin, 1: least-loaded, 2: work-stealing
    atomic_size_t next_worker;
    
    // Performance monitoring
    atomic_size_t total_tasks_submitted;
    atomic_size_t total_tasks_completed;
    atomic_size_t tasks_rejected;
    double average_queue_wait_time;
} thread_pool_t;

// Create thread pool with advanced configuration
thread_pool_t* create_thread_pool(int initial_workers, int max_workers,
                                 int max_queue_size, int load_balance_strategy) {
    thread_pool_t *pool = calloc(1, sizeof(thread_pool_t));
    if (!pool) return NULL;
    
    pool->num_workers = initial_workers;
    pool->max_workers = max_workers;
    pool->min_workers = initial_workers;
    pool->max_queue_size = max_queue_size;
    pool->load_balance_strategy = load_balance_strategy;
    pool->scale_interval = 30; // 30 seconds
    
    pool->workers = calloc(max_workers, sizeof(worker_thread_t));
    if (!pool->workers) {
        free(pool);
        return NULL;
    }
    
    // Initialize synchronization primitives
    pthread_mutex_init(&pool->queue_mutex, NULL);
    pthread_cond_init(&pool->work_available, NULL);
    pthread_cond_init(&pool->queue_not_full, NULL);
    
    atomic_store(&pool->shutdown, false);
    atomic_store(&pool->immediate_shutdown, false);
    atomic_store(&pool->queue_size, 0);
    atomic_store(&pool->idle_workers, 0);
    atomic_store(&pool->busy_workers, 0);
    atomic_store(&pool->next_worker, 0);
    
    // Create initial worker threads
    for (int i = 0; i < initial_workers; i++) {
        create_worker_thread(pool, i);
    }
    
    return pool;
}

// Worker thread function with advanced features
void* worker_thread_function(void *arg) {
    thread_pool_t *pool = (thread_pool_t*)arg;
    int worker_id = atomic_fetch_add(&pool->next_worker, 1) % pool->max_workers;
    worker_thread_t *worker = &pool->workers[worker_id];
    
    worker->thread_id = pthread_self();
    worker->active = true;
    
    // Set CPU affinity if specified
    if (worker->cpu_affinity >= 0) {
        cpu_set_t cpuset;
        CPU_ZERO(&cpuset);
        CPU_SET(worker->cpu_affinity, &cpuset);
        pthread_setaffinity_np(worker->thread_id, sizeof(cpu_set_t), &cpuset);
    }
    
    // Set thread name for debugging
    char thread_name[16];
    snprintf(thread_name, sizeof(thread_name), "worker_%d", worker_id);
    pthread_setname_np(worker->thread_id, thread_name);
    
    while (!atomic_load(&pool->shutdown)) {
        task_t *task = NULL;
        
        pthread_mutex_lock(&pool->queue_mutex);
        
        // Wait for work or shutdown signal
        while (pool->task_queue_head == NULL && 
               pool->high_priority_queue == NULL &&
               !atomic_load(&pool->shutdown)) {
            
            atomic_fetch_add(&pool->idle_workers, 1);
            pthread_cond_wait(&pool->work_available, &pool->queue_mutex);
            atomic_fetch_sub(&pool->idle_workers, 1);
        }
        
        if (atomic_load(&pool->shutdown)) {
            pthread_mutex_unlock(&pool->queue_mutex);
            break;
        }
        
        // Dequeue task (high priority first)
        if (pool->high_priority_queue) {
            task = pool->high_priority_queue;
            pool->high_priority_queue = task->next;
        } else if (pool->task_queue_head) {
            task = pool->task_queue_head;
            pool->task_queue_head = task->next;
            if (pool->task_queue_head == NULL) {
                pool->task_queue_tail = NULL;
            }
        }
        
        if (task) {
            atomic_fetch_sub(&pool->queue_size, 1);
            pthread_cond_signal(&pool->queue_not_full);
        }
        
        pthread_mutex_unlock(&pool->queue_mutex);
        
        if (task) {
            atomic_fetch_add(&pool->busy_workers, 1);
            
            struct timespec start_time, end_time;
            clock_gettime(CLOCK_MONOTONIC, &start_time);
            
            // Execute task
            if (task->function) {
                task->function(task->argument);
                atomic_fetch_add(&worker->tasks_completed, 1);
                atomic_fetch_add(&pool->total_tasks_completed, 1);
            }
            
            clock_gettime(CLOCK_MONOTONIC, &end_time);
            
            // Update statistics
            double execution_time = (end_time.tv_sec - start_time.tv_sec) +
                                   (end_time.tv_nsec - start_time.tv_nsec) / 1e9;
            
            worker->average_task_time = (worker->average_task_time * 0.9) + 
                                       (execution_time * 0.1);
            
            free(task);
            atomic_fetch_sub(&pool->busy_workers, 1);
        }
    }
    
    worker->active = false;
    return NULL;
}

// Submit task with priority
int submit_task(thread_pool_t *pool, void (*function)(void*), 
               void *argument, int priority) {
    if (atomic_load(&pool->shutdown)) {
        return -1; // Pool is shutting down
    }
    
    task_t *task = malloc(sizeof(task_t));
    if (!task) return -1;
    
    task->function = function;
    task->argument = argument;
    task->priority = priority;
    task->next = NULL;
    clock_gettime(CLOCK_MONOTONIC, &task->submit_time);
    
    pthread_mutex_lock(&pool->queue_mutex);
    
    // Check queue size limit
    while (atomic_load(&pool->queue_size) >= pool->max_queue_size &&
           !atomic_load(&pool->shutdown)) {
        pthread_cond_wait(&pool->queue_not_full, &pool->queue_mutex);
    }
    
    if (atomic_load(&pool->shutdown)) {
        pthread_mutex_unlock(&pool->queue_mutex);
        free(task);
        return -1;
    }
    
    // Add to appropriate queue based on priority
    if (priority > 0) {
        // High priority queue (LIFO for high priority)
        task->next = pool->high_priority_queue;
        pool->high_priority_queue = task;
    } else {
        // Normal priority queue (FIFO)
        if (pool->task_queue_tail) {
            pool->task_queue_tail->next = task;
        } else {
            pool->task_queue_head = task;
        }
        pool->task_queue_tail = task;
    }
    
    atomic_fetch_add(&pool->queue_size, 1);
    atomic_fetch_add(&pool->total_tasks_submitted, 1);
    
    pthread_cond_signal(&pool->work_available);
    pthread_mutex_unlock(&pool->queue_mutex);
    
    // Trigger adaptive scaling check
    check_adaptive_scaling(pool);
    
    return 0;
}

// Adaptive thread pool scaling
void check_adaptive_scaling(thread_pool_t *pool) {
    time_t current_time = time(NULL);
    if (current_time - pool->last_scale_time < pool->scale_interval) {
        return; // Too soon to scale
    }
    
    pool->last_scale_time = current_time;
    
    size_t queue_size = atomic_load(&pool->queue_size);
    size_t idle_workers = atomic_load(&pool->idle_workers);
    size_t busy_workers = atomic_load(&pool->busy_workers);
    
    // Scale up if queue is building up and we have capacity
    if (queue_size > pool->num_workers * 2 && 
        pool->num_workers < pool->max_workers &&
        idle_workers < 2) {
        
        printf("Scaling up thread pool: %d -> %d workers\n", 
               pool->num_workers, pool->num_workers + 1);
        
        create_worker_thread(pool, pool->num_workers);
        pool->num_workers++;
    }
    
    // Scale down if too many idle workers
    else if (idle_workers > pool->num_workers / 2 && 
             pool->num_workers > pool->min_workers &&
             queue_size < pool->num_workers / 4) {
        
        printf("Scaling down thread pool: %d -> %d workers\n",
               pool->num_workers, pool->num_workers - 1);
        
        // Signal a worker to exit (simplified)
        pool->num_workers--;
    }
}

// Create individual worker thread
void create_worker_thread(thread_pool_t *pool, int worker_index) {
    worker_thread_t *worker = &pool->workers[worker_index];
    
    // Set CPU affinity for NUMA optimization
    worker->cpu_affinity = worker_index % sysconf(_SC_NPROCESSORS_ONLN);
    
    pthread_create(&worker->thread_id, NULL, worker_thread_function, pool);
}
```

## Inter-Process Communication (IPC) Mechanisms

Advanced IPC mechanisms are essential for coordinating complex multi-process applications.

### High-Performance Shared Memory IPC

```c
#include <sys/shm.h>
#include <sys/sem.h>
#include <sys/msg.h>
#include <mqueue.h>

// Shared memory ring buffer for high-throughput IPC
typedef struct {
    atomic_size_t head;
    atomic_size_t tail;
    size_t size;
    size_t mask; // size - 1, for power-of-2 sizes
    char padding1[64]; // Cache line padding
    
    // Producer/consumer control
    atomic_bool producer_waiting;
    atomic_bool consumer_waiting;
    char padding2[64];
    
    // Statistics
    atomic_size_t messages_sent;
    atomic_size_t messages_received;
    atomic_size_t buffer_overruns;
    
    // Data buffer follows
    char data[];
} shm_ring_buffer_t;

typedef struct {
    key_t shm_key;
    int shm_id;
    shm_ring_buffer_t *buffer;
    size_t buffer_size;
    size_t message_size;
    
    // Synchronization
    int sem_id;
    
    // Process identification
    pid_t producer_pid;
    pid_t consumer_pid;
    bool is_producer;
} shm_ipc_context_t;

// Create shared memory IPC context
shm_ipc_context_t* create_shm_ipc(key_t key, size_t buffer_size, 
                                 size_t message_size, bool is_producer) {
    shm_ipc_context_t *ctx = malloc(sizeof(shm_ipc_context_t));
    if (!ctx) return NULL;
    
    ctx->shm_key = key;
    ctx->buffer_size = buffer_size;
    ctx->message_size = message_size;
    ctx->is_producer = is_producer;
    
    // Ensure buffer size is power of 2
    size_t actual_size = 1;
    while (actual_size < buffer_size) {
        actual_size <<= 1;
    }
    
    size_t total_size = sizeof(shm_ring_buffer_t) + 
                       (actual_size * message_size);
    
    // Create or attach to shared memory
    ctx->shm_id = shmget(key, total_size, 
                        is_producer ? (IPC_CREAT | 0666) : 0);
    if (ctx->shm_id < 0) {
        perror("Failed to create/attach shared memory");
        free(ctx);
        return NULL;
    }
    
    ctx->buffer = (shm_ring_buffer_t*)shmat(ctx->shm_id, NULL, 0);
    if (ctx->buffer == (void*)-1) {
        perror("Failed to attach shared memory");
        free(ctx);
        return NULL;
    }
    
    // Initialize buffer if producer
    if (is_producer) {
        atomic_store(&ctx->buffer->head, 0);
        atomic_store(&ctx->buffer->tail, 0);
        ctx->buffer->size = actual_size;
        ctx->buffer->mask = actual_size - 1;
        atomic_store(&ctx->buffer->producer_waiting, false);
        atomic_store(&ctx->buffer->consumer_waiting, false);
        atomic_store(&ctx->buffer->messages_sent, 0);
        atomic_store(&ctx->buffer->messages_received, 0);
        atomic_store(&ctx->buffer->buffer_overruns, 0);
        
        ctx->buffer->producer_pid = getpid();
    } else {
        ctx->buffer->consumer_pid = getpid();
    }
    
    // Create semaphore for synchronization
    ctx->sem_id = semget(key + 1, 2, 
                        is_producer ? (IPC_CREAT | 0666) : 0);
    if (ctx->sem_id < 0) {
        perror("Failed to create/access semaphore");
        shmdt(ctx->buffer);
        free(ctx);
        return NULL;
    }
    
    // Initialize semaphores if producer
    if (is_producer) {
        union semun {
            int val;
            struct semid_ds *buf;
            unsigned short *array;
        } sem_union;
        
        sem_union.val = 0;
        semctl(ctx->sem_id, 0, SETVAL, sem_union); // Producer semaphore
        semctl(ctx->sem_id, 1, SETVAL, sem_union); // Consumer semaphore
    }
    
    return ctx;
}

// Send message through shared memory ring buffer
int shm_send_message(shm_ipc_context_t *ctx, const void *message) {
    if (!ctx->is_producer) return -1;
    
    shm_ring_buffer_t *buffer = ctx->buffer;
    size_t head = atomic_load(&buffer->head);
    size_t tail = atomic_load(&buffer->tail);
    
    // Check if buffer is full
    if (((head + 1) & buffer->mask) == tail) {
        atomic_fetch_add(&buffer->buffer_overruns, 1);
        
        // Optionally wait for space
        atomic_store(&buffer->producer_waiting, true);
        
        struct sembuf sem_op = {1, -1, 0}; // Wait on consumer semaphore
        if (semop(ctx->sem_id, &sem_op, 1) < 0) {
            return -1;
        }
        
        atomic_store(&buffer->producer_waiting, false);
        
        // Recheck after waiting
        head = atomic_load(&buffer->head);
        tail = atomic_load(&buffer->tail);
        
        if (((head + 1) & buffer->mask) == tail) {
            return -1; // Still full
        }
    }
    
    // Copy message to buffer
    char *slot = buffer->data + (head * ctx->message_size);
    memcpy(slot, message, ctx->message_size);
    
    // Memory barrier to ensure write completes before updating head
    atomic_thread_fence(memory_order_release);
    
    // Update head pointer
    atomic_store(&buffer->head, (head + 1) & buffer->mask);
    atomic_fetch_add(&buffer->messages_sent, 1);
    
    // Signal consumer if waiting
    if (atomic_load(&buffer->consumer_waiting)) {
        struct sembuf sem_op = {0, 1, 0}; // Signal producer semaphore
        semop(ctx->sem_id, &sem_op, 1);
    }
    
    return 0;
}

// Receive message from shared memory ring buffer
int shm_receive_message(shm_ipc_context_t *ctx, void *message) {
    if (ctx->is_producer) return -1;
    
    shm_ring_buffer_t *buffer = ctx->buffer;
    size_t head = atomic_load(&buffer->head);
    size_t tail = atomic_load(&buffer->tail);
    
    // Check if buffer is empty
    if (head == tail) {
        // Optionally wait for data
        atomic_store(&buffer->consumer_waiting, true);
        
        struct sembuf sem_op = {0, -1, 0}; // Wait on producer semaphore
        if (semop(ctx->sem_id, &sem_op, 1) < 0) {
            return -1;
        }
        
        atomic_store(&buffer->consumer_waiting, false);
        
        // Recheck after waiting
        head = atomic_load(&buffer->head);
        tail = atomic_load(&buffer->tail);
        
        if (head == tail) {
            return -1; // Still empty
        }
    }
    
    // Memory barrier to ensure read happens after head check
    atomic_thread_fence(memory_order_acquire);
    
    // Copy message from buffer
    char *slot = buffer->data + (tail * ctx->message_size);
    memcpy(message, slot, ctx->message_size);
    
    // Update tail pointer
    atomic_store(&buffer->tail, (tail + 1) & buffer->mask);
    atomic_fetch_add(&buffer->messages_received, 1);
    
    // Signal producer if waiting
    if (atomic_load(&buffer->producer_waiting)) {
        struct sembuf sem_op = {1, 1, 0}; // Signal consumer semaphore
        semop(ctx->sem_id, &sem_op, 1);
    }
    
    return 0;
}

// Message queue with priority support
typedef struct {
    mqd_t mq_descriptor;
    char queue_name[64];
    struct mq_attr attributes;
    bool is_sender;
    
    // Statistics
    atomic_size_t messages_sent;
    atomic_size_t messages_received;
    atomic_size_t send_failures;
    atomic_size_t receive_failures;
} priority_mq_context_t;

priority_mq_context_t* create_priority_mq(const char *name, 
                                         int max_messages,
                                         int message_size,
                                         bool is_sender) {
    priority_mq_context_t *ctx = malloc(sizeof(priority_mq_context_t));
    if (!ctx) return NULL;
    
    snprintf(ctx->queue_name, sizeof(ctx->queue_name), "/%s", name);
    ctx->is_sender = is_sender;
    
    // Set queue attributes
    ctx->attributes.mq_flags = 0;
    ctx->attributes.mq_maxmsg = max_messages;
    ctx->attributes.mq_msgsize = message_size;
    ctx->attributes.mq_curmsgs = 0;
    
    // Open message queue
    int flags = is_sender ? (O_WRONLY | O_CREAT) : O_RDONLY;
    ctx->mq_descriptor = mq_open(ctx->queue_name, flags, 0644, &ctx->attributes);
    
    if (ctx->mq_descriptor == (mqd_t)-1) {
        perror("Failed to open message queue");
        free(ctx);
        return NULL;
    }
    
    atomic_store(&ctx->messages_sent, 0);
    atomic_store(&ctx->messages_received, 0);
    atomic_store(&ctx->send_failures, 0);
    atomic_store(&ctx->receive_failures, 0);
    
    return ctx;
}

// Send priority message
int send_priority_message(priority_mq_context_t *ctx, 
                         const void *message, 
                         size_t message_size,
                         unsigned int priority) {
    if (!ctx->is_sender) return -1;
    
    if (mq_send(ctx->mq_descriptor, (const char*)message, 
               message_size, priority) < 0) {
        atomic_fetch_add(&ctx->send_failures, 1);
        return -1;
    }
    
    atomic_fetch_add(&ctx->messages_sent, 1);
    return 0;
}

// Receive priority message
ssize_t receive_priority_message(priority_mq_context_t *ctx,
                                void *message,
                                size_t buffer_size,
                                unsigned int *priority) {
    if (ctx->is_sender) return -1;
    
    ssize_t bytes_received = mq_receive(ctx->mq_descriptor, (char*)message,
                                       buffer_size, priority);
    
    if (bytes_received < 0) {
        atomic_fetch_add(&ctx->receive_failures, 1);
        return -1;
    }
    
    atomic_fetch_add(&ctx->messages_received, 1);
    return bytes_received;
}
```

## Resource Control and Monitoring

Advanced resource control using cgroups and comprehensive monitoring provides the foundation for enterprise-grade process management.

### Cgroups Integration and Resource Limits

```c
#include <sys/stat.h>
#include <sys/types.h>
#include <fcntl.h>

typedef struct {
    char *cgroup_path;
    char *cgroup_name;
    pid_t managed_pids[1024];
    int num_pids;
    
    // Resource limits
    uint64_t memory_limit;
    uint64_t cpu_shares;
    uint64_t cpu_quota;
    uint64_t cpu_period;
    uint64_t blkio_weight;
    
    // Current usage
    uint64_t memory_usage;
    uint64_t cpu_usage;
    uint64_t blkio_usage;
    
    // Monitoring
    bool monitoring_enabled;
    pthread_t monitor_thread;
    int monitor_interval;
} cgroup_manager_t;

// Create and configure cgroup
cgroup_manager_t* create_cgroup(const char *cgroup_name) {
    cgroup_manager_t *manager = calloc(1, sizeof(cgroup_manager_t));
    if (!manager) return NULL;
    
    manager->cgroup_name = strdup(cgroup_name);
    manager->cgroup_path = malloc(256);
    
    // Create cgroup directory structure
    snprintf(manager->cgroup_path, 256, "/sys/fs/cgroup/%s", cgroup_name);
    
    // Create memory cgroup
    char path[512];
    snprintf(path, sizeof(path), "/sys/fs/cgroup/memory/%s", cgroup_name);
    mkdir(path, 0755);
    
    // Create CPU cgroup
    snprintf(path, sizeof(path), "/sys/fs/cgroup/cpu/%s", cgroup_name);
    mkdir(path, 0755);
    
    // Create blkio cgroup
    snprintf(path, sizeof(path), "/sys/fs/cgroup/blkio/%s", cgroup_name);
    mkdir(path, 0755);
    
    // Set default values
    manager->memory_limit = 1024 * 1024 * 1024; // 1GB
    manager->cpu_shares = 1024; // Default shares
    manager->cpu_quota = 100000; // 100ms
    manager->cpu_period = 100000; // 100ms period
    manager->blkio_weight = 500; // Default weight
    
    return manager;
}

// Apply resource limits to cgroup
int apply_cgroup_limits(cgroup_manager_t *manager) {
    char path[512];
    char value[64];
    int fd;
    
    // Set memory limit
    snprintf(path, sizeof(path), 
             "/sys/fs/cgroup/memory/%s/memory.limit_in_bytes", 
             manager->cgroup_name);
    fd = open(path, O_WRONLY);
    if (fd >= 0) {
        snprintf(value, sizeof(value), "%lu", manager->memory_limit);
        write(fd, value, strlen(value));
        close(fd);
    }
    
    // Set CPU shares
    snprintf(path, sizeof(path), 
             "/sys/fs/cgroup/cpu/%s/cpu.shares", 
             manager->cgroup_name);
    fd = open(path, O_WRONLY);
    if (fd >= 0) {
        snprintf(value, sizeof(value), "%lu", manager->cpu_shares);
        write(fd, value, strlen(value));
        close(fd);
    }
    
    // Set CPU quota
    snprintf(path, sizeof(path), 
             "/sys/fs/cgroup/cpu/%s/cpu.cfs_quota_us", 
             manager->cgroup_name);
    fd = open(path, O_WRONLY);
    if (fd >= 0) {
        snprintf(value, sizeof(value), "%lu", manager->cpu_quota);
        write(fd, value, strlen(value));
        close(fd);
    }
    
    // Set CPU period
    snprintf(path, sizeof(path), 
             "/sys/fs/cgroup/cpu/%s/cpu.cfs_period_us", 
             manager->cgroup_name);
    fd = open(path, O_WRONLY);
    if (fd >= 0) {
        snprintf(value, sizeof(value), "%lu", manager->cpu_period);
        write(fd, value, strlen(value));
        close(fd);
    }
    
    // Set blkio weight
    snprintf(path, sizeof(path), 
             "/sys/fs/cgroup/blkio/%s/blkio.weight", 
             manager->cgroup_name);
    fd = open(path, O_WRONLY);
    if (fd >= 0) {
        snprintf(value, sizeof(value), "%lu", manager->blkio_weight);
        write(fd, value, strlen(value));
        close(fd);
    }
    
    return 0;
}

// Add process to cgroup
int add_process_to_cgroup(cgroup_manager_t *manager, pid_t pid) {
    if (manager->num_pids >= 1024) return -1;
    
    char path[512];
    char pid_str[32];
    int fd;
    
    snprintf(pid_str, sizeof(pid_str), "%d", pid);
    
    // Add to memory cgroup
    snprintf(path, sizeof(path), 
             "/sys/fs/cgroup/memory/%s/cgroup.procs", 
             manager->cgroup_name);
    fd = open(path, O_WRONLY);
    if (fd >= 0) {
        write(fd, pid_str, strlen(pid_str));
        close(fd);
    }
    
    // Add to CPU cgroup
    snprintf(path, sizeof(path), 
             "/sys/fs/cgroup/cpu/%s/cgroup.procs", 
             manager->cgroup_name);
    fd = open(path, O_WRONLY);
    if (fd >= 0) {
        write(fd, pid_str, strlen(pid_str));
        close(fd);
    }
    
    // Add to blkio cgroup
    snprintf(path, sizeof(path), 
             "/sys/fs/cgroup/blkio/%s/cgroup.procs", 
             manager->cgroup_name);
    fd = open(path, O_WRONLY);
    if (fd >= 0) {
        write(fd, pid_str, strlen(pid_str));
        close(fd);
    }
    
    manager->managed_pids[manager->num_pids++] = pid;
    return 0;
}

// Monitor cgroup resource usage
void* cgroup_monitor_thread(void *arg) {
    cgroup_manager_t *manager = (cgroup_manager_t*)arg;
    char path[512];
    char buffer[1024];
    FILE *fp;
    
    while (manager->monitoring_enabled) {
        // Read memory usage
        snprintf(path, sizeof(path), 
                 "/sys/fs/cgroup/memory/%s/memory.usage_in_bytes", 
                 manager->cgroup_name);
        fp = fopen(path, "r");
        if (fp) {
            if (fgets(buffer, sizeof(buffer), fp)) {
                manager->memory_usage = strtoull(buffer, NULL, 10);
            }
            fclose(fp);
        }
        
        // Read CPU usage
        snprintf(path, sizeof(path), 
                 "/sys/fs/cgroup/cpu/%s/cpuacct.usage", 
                 manager->cgroup_name);
        fp = fopen(path, "r");
        if (fp) {
            if (fgets(buffer, sizeof(buffer), fp)) {
                manager->cpu_usage = strtoull(buffer, NULL, 10);
            }
            fclose(fp);
        }
        
        // Check for memory pressure
        if (manager->memory_usage > manager->memory_limit * 0.9) {
            printf("Warning: Memory usage approaching limit for cgroup %s\n",
                   manager->cgroup_name);
        }
        
        sleep(manager->monitor_interval);
    }
    
    return NULL;
}

// Start monitoring
void start_cgroup_monitoring(cgroup_manager_t *manager, int interval_seconds) {
    manager->monitor_interval = interval_seconds;
    manager->monitoring_enabled = true;
    
    pthread_create(&manager->monitor_thread, NULL, 
                   cgroup_monitor_thread, manager);
}

// Generate resource usage report
void generate_cgroup_report(cgroup_manager_t *manager) {
    printf("=== Cgroup Resource Report ===\n");
    printf("Cgroup: %s\n", manager->cgroup_name);
    printf("Managed processes: %d\n", manager->num_pids);
    
    printf("\n--- Memory ---\n");
    printf("Limit: %lu bytes (%.2f MB)\n", 
           manager->memory_limit, manager->memory_limit / 1048576.0);
    printf("Usage: %lu bytes (%.2f MB)\n", 
           manager->memory_usage, manager->memory_usage / 1048576.0);
    printf("Utilization: %.1f%%\n", 
           100.0 * manager->memory_usage / manager->memory_limit);
    
    printf("\n--- CPU ---\n");
    printf("Shares: %lu\n", manager->cpu_shares);
    printf("Quota: %lu us\n", manager->cpu_quota);
    printf("Period: %lu us\n", manager->cpu_period);
    printf("Usage: %lu ns\n", manager->cpu_usage);
    
    printf("\n--- Block I/O ---\n");
    printf("Weight: %lu\n", manager->blkio_weight);
    
    printf("=============================\n");
}
```

## Conclusion

Advanced process and thread management techniques provide the foundation for building robust, scalable enterprise systems. The comprehensive strategies presented in this guide demonstrate how to leverage Linux's sophisticated process control mechanisms, from fine-grained resource management through cgroups to high-performance inter-process communication and adaptive thread pool management.

Key principles for successful implementation include understanding the underlying kernel mechanisms, implementing robust error handling and monitoring, optimizing for specific workload characteristics, and maintaining comprehensive observability. By combining these techniques with proper resource isolation, security controls, and performance monitoring, developers can create systems that efficiently manage complex multi-process architectures while maintaining predictable performance characteristics under varying load conditions.

The patterns and implementations shown here form the basis for building sophisticated process orchestration systems, container runtime environments, and high-performance computing clusters that can scale to meet enterprise demands while providing the reliability and observability required for production deployment.