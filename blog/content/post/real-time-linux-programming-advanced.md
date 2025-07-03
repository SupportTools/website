---
title: "Real-Time Linux Programming: Advanced Techniques for Deterministic Systems"
date: 2025-03-12T10:00:00-05:00
draft: false
tags: ["Linux", "Real-Time", "RT", "Scheduling", "Latency", "Deterministic", "PREEMPT_RT"]
categories:
- Linux
- Real-Time Systems
author: "Matthew Mattox - mmattox@support.tools"
description: "Master real-time Linux programming with advanced techniques for building deterministic systems, including RT scheduling, latency optimization, and lock-free programming"
more_link: "yes"
url: "/real-time-linux-programming-advanced/"
---

Real-time Linux programming demands precision, predictability, and deep understanding of system behavior. Building deterministic systems requires mastering specialized techniques, from RT scheduling policies to lock-free algorithms and latency optimization. This comprehensive guide explores advanced real-time programming techniques for mission-critical applications.

<!--more-->

# [Real-Time Linux Programming](#real-time-linux-programming)

## Real-Time Scheduling and Priority Management

### RT Scheduling Policies

```c
// rt_scheduling.c - Real-time scheduling management
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sched.h>
#include <pthread.h>
#include <sys/mman.h>
#include <sys/resource.h>
#include <errno.h>
#include <time.h>
#include <signal.h>

// RT thread configuration
typedef struct {
    int policy;
    int priority;
    int cpu_affinity;
    size_t stack_size;
    void *(*thread_func)(void *);
    void *thread_arg;
    char name[16];
} rt_thread_config_t;

// RT thread control block
typedef struct {
    pthread_t thread_id;
    rt_thread_config_t config;
    struct timespec start_time;
    volatile int should_stop;
    pthread_mutex_t control_mutex;
    pthread_cond_t control_cond;
} rt_thread_t;

// Initialize RT thread system
int rt_system_init(void) {
    // Lock all current and future memory pages
    if (mlockall(MCL_CURRENT | MCL_FUTURE) != 0) {
        perror("mlockall");
        return -1;
    }
    
    // Set high priority for main thread
    struct sched_param param;
    param.sched_priority = sched_get_priority_max(SCHED_FIFO) - 1;
    
    if (sched_setscheduler(0, SCHED_FIFO, &param) != 0) {
        perror("sched_setscheduler");
        return -1;
    }
    
    printf("RT system initialized successfully\n");
    printf("  Memory locked: Yes\n");
    printf("  Main thread priority: %d (SCHED_FIFO)\n", param.sched_priority);
    
    return 0;
}

// Create RT thread with specific configuration
rt_thread_t* rt_thread_create(rt_thread_config_t *config) {
    rt_thread_t *rt_thread = malloc(sizeof(rt_thread_t));
    if (!rt_thread) {
        return NULL;
    }
    
    memcpy(&rt_thread->config, config, sizeof(rt_thread_config_t));
    rt_thread->should_stop = 0;
    
    // Initialize synchronization primitives
    pthread_mutex_init(&rt_thread->control_mutex, NULL);
    pthread_cond_init(&rt_thread->control_cond, NULL);
    
    // Set thread attributes
    pthread_attr_t attr;
    pthread_attr_init(&attr);
    
    // Set scheduling policy and priority
    struct sched_param param;
    param.sched_priority = config->priority;
    
    pthread_attr_setschedpolicy(&attr, config->policy);
    pthread_attr_setschedparam(&attr, &param);
    pthread_attr_setinheritsched(&attr, PTHREAD_EXPLICIT_SCHED);
    
    // Set stack size if specified
    if (config->stack_size > 0) {
        pthread_attr_setstacksize(&attr, config->stack_size);
    }
    
    // Create thread
    int ret = pthread_create(&rt_thread->thread_id, &attr, 
                           config->thread_func, config->thread_arg);
    pthread_attr_destroy(&attr);
    
    if (ret != 0) {
        free(rt_thread);
        errno = ret;
        return NULL;
    }
    
    // Set CPU affinity if specified
    if (config->cpu_affinity >= 0) {
        cpu_set_t cpuset;
        CPU_ZERO(&cpuset);
        CPU_SET(config->cpu_affinity, &cpuset);
        
        pthread_setaffinity_np(rt_thread->thread_id, sizeof(cpuset), &cpuset);
    }
    
    // Set thread name
    pthread_setname_np(rt_thread->thread_id, config->name);
    
    // Record start time
    clock_gettime(CLOCK_MONOTONIC, &rt_thread->start_time);
    
    return rt_thread;
}

// RT thread wrapper function
void* rt_thread_wrapper(void *arg) {
    rt_thread_config_t *config = (rt_thread_config_t *)arg;
    
    // Verify scheduling parameters
    int policy;
    struct sched_param param;
    
    if (pthread_getschedparam(pthread_self(), &policy, &param) == 0) {
        printf("RT Thread [%s] started:\n", config->name);
        printf("  Policy: %s\n", 
               (policy == SCHED_FIFO) ? "SCHED_FIFO" :
               (policy == SCHED_RR) ? "SCHED_RR" :
               (policy == SCHED_OTHER) ? "SCHED_OTHER" : "UNKNOWN");
        printf("  Priority: %d\n", param.sched_priority);
        
        // Check CPU affinity
        cpu_set_t cpuset;
        if (pthread_getaffinity_np(pthread_self(), sizeof(cpuset), &cpuset) == 0) {
            printf("  CPU Affinity: ");
            for (int i = 0; i < CPU_SETSIZE; i++) {
                if (CPU_ISSET(i, &cpuset)) {
                    printf("%d ", i);
                }
            }
            printf("\n");
        }
    }
    
    // Call actual thread function
    return config->thread_func(config->thread_arg);
}

// Latency measurement utilities
typedef struct {
    struct timespec timestamp;
    unsigned long latency_ns;
    int cpu;
    int priority;
} latency_sample_t;

typedef struct {
    latency_sample_t *samples;
    size_t capacity;
    size_t count;
    size_t index;
    pthread_mutex_t mutex;
    
    // Statistics
    unsigned long min_latency;
    unsigned long max_latency;
    unsigned long total_latency;
    unsigned long samples_over_threshold;
    unsigned long threshold_ns;
} latency_tracker_t;

// Create latency tracker
latency_tracker_t* latency_tracker_create(size_t capacity, unsigned long threshold_ns) {
    latency_tracker_t *tracker = malloc(sizeof(latency_tracker_t));
    if (!tracker) return NULL;
    
    tracker->samples = malloc(capacity * sizeof(latency_sample_t));
    if (!tracker->samples) {
        free(tracker);
        return NULL;
    }
    
    tracker->capacity = capacity;
    tracker->count = 0;
    tracker->index = 0;
    tracker->min_latency = ULONG_MAX;
    tracker->max_latency = 0;
    tracker->total_latency = 0;
    tracker->samples_over_threshold = 0;
    tracker->threshold_ns = threshold_ns;
    
    pthread_mutex_init(&tracker->mutex, NULL);
    
    return tracker;
}

// Record latency sample
void latency_tracker_record(latency_tracker_t *tracker, 
                           struct timespec *start, 
                           struct timespec *end) {
    unsigned long latency_ns = (end->tv_sec - start->tv_sec) * 1000000000UL + 
                              (end->tv_nsec - start->tv_nsec);
    
    pthread_mutex_lock(&tracker->mutex);
    
    // Store sample
    latency_sample_t *sample = &tracker->samples[tracker->index];
    sample->timestamp = *end;
    sample->latency_ns = latency_ns;
    sample->cpu = sched_getcpu();
    
    struct sched_param param;
    int policy;
    pthread_getschedparam(pthread_self(), &policy, &param);
    sample->priority = param.sched_priority;
    
    // Update statistics
    if (latency_ns < tracker->min_latency) {
        tracker->min_latency = latency_ns;
    }
    if (latency_ns > tracker->max_latency) {
        tracker->max_latency = latency_ns;
    }
    
    tracker->total_latency += latency_ns;
    
    if (latency_ns > tracker->threshold_ns) {
        tracker->samples_over_threshold++;
    }
    
    // Advance circular buffer
    tracker->index = (tracker->index + 1) % tracker->capacity;
    if (tracker->count < tracker->capacity) {
        tracker->count++;
    }
    
    pthread_mutex_unlock(&tracker->mutex);
}

// Get latency statistics
void latency_tracker_stats(latency_tracker_t *tracker) {
    pthread_mutex_lock(&tracker->mutex);
    
    printf("Latency Statistics:\n");
    printf("  Samples: %zu\n", tracker->count);
    printf("  Min latency: %lu ns (%.2f μs)\n", 
           tracker->min_latency, tracker->min_latency / 1000.0);
    printf("  Max latency: %lu ns (%.2f μs)\n", 
           tracker->max_latency, tracker->max_latency / 1000.0);
    
    if (tracker->count > 0) {
        unsigned long avg_latency = tracker->total_latency / tracker->count;
        printf("  Avg latency: %lu ns (%.2f μs)\n", 
               avg_latency, avg_latency / 1000.0);
        
        double threshold_percent = (tracker->samples_over_threshold * 100.0) / tracker->count;
        printf("  Samples over threshold (%lu ns): %lu (%.2f%%)\n",
               tracker->threshold_ns, tracker->samples_over_threshold, threshold_percent);
    }
    
    pthread_mutex_unlock(&tracker->mutex);
}

// Example RT periodic task
void* periodic_rt_task(void *arg) {
    int period_us = *(int *)arg;
    struct timespec period = {
        .tv_sec = period_us / 1000000,
        .tv_nsec = (period_us % 1000000) * 1000
    };
    
    struct timespec next_activation, now, start_time, end_time;
    clock_gettime(CLOCK_MONOTONIC, &next_activation);
    
    latency_tracker_t *tracker = latency_tracker_create(10000, 100000); // 100μs threshold
    
    printf("Periodic RT task started (period: %d μs)\n", period_us);
    
    for (int iteration = 0; iteration < 1000; iteration++) {
        // Wait for next period
        clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &next_activation, NULL);
        
        clock_gettime(CLOCK_MONOTONIC, &start_time);
        
        // Simulate work (replace with actual RT work)
        volatile int dummy = 0;
        for (int i = 0; i < 10000; i++) {
            dummy += i;
        }
        
        clock_gettime(CLOCK_MONOTONIC, &end_time);
        
        // Record timing
        latency_tracker_record(tracker, &start_time, &end_time);
        
        // Calculate next activation time
        next_activation.tv_nsec += period.tv_nsec;
        if (next_activation.tv_nsec >= 1000000000) {
            next_activation.tv_sec += 1;
            next_activation.tv_nsec -= 1000000000;
        }
        next_activation.tv_sec += period.tv_sec;
    }
    
    latency_tracker_stats(tracker);
    free(tracker->samples);
    free(tracker);
    
    return NULL;
}

// Example usage
int main(void) {
    // Initialize RT system
    if (rt_system_init() != 0) {
        return 1;
    }
    
    // Create RT thread configuration
    rt_thread_config_t config = {
        .policy = SCHED_FIFO,
        .priority = 80,
        .cpu_affinity = 1,
        .stack_size = 8192,
        .thread_func = periodic_rt_task,
        .thread_arg = &(int){1000}, // 1ms period
        .name = "rt-periodic"
    };
    
    // Create and start RT thread
    rt_thread_t *rt_thread = rt_thread_create(&config);
    if (!rt_thread) {
        perror("rt_thread_create");
        return 1;
    }
    
    // Wait for thread completion
    pthread_join(rt_thread->thread_id, NULL);
    
    // Cleanup
    pthread_mutex_destroy(&rt_thread->control_mutex);
    pthread_cond_destroy(&rt_thread->control_cond);
    free(rt_thread);
    
    return 0;
}
```

## Lock-Free Programming Techniques

### Atomic Operations and Memory Ordering

```c
// lockfree_programming.c - Lock-free data structures and algorithms
#include <stdio.h>
#include <stdlib.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <pthread.h>
#include <unistd.h>
#include <time.h>

// Lock-free ring buffer
typedef struct {
    void **buffer;
    size_t capacity;
    _Atomic size_t head;
    _Atomic size_t tail;
    size_t mask;
} lockfree_ring_buffer_t;

// Create lock-free ring buffer (capacity must be power of 2)
lockfree_ring_buffer_t* lockfree_ring_buffer_create(size_t capacity) {
    // Ensure capacity is power of 2
    if ((capacity & (capacity - 1)) != 0) {
        return NULL;
    }
    
    lockfree_ring_buffer_t *rb = malloc(sizeof(lockfree_ring_buffer_t));
    if (!rb) return NULL;
    
    rb->buffer = calloc(capacity, sizeof(void *));
    if (!rb->buffer) {
        free(rb);
        return NULL;
    }
    
    rb->capacity = capacity;
    rb->mask = capacity - 1;
    atomic_store(&rb->head, 0);
    atomic_store(&rb->tail, 0);
    
    return rb;
}

// Enqueue item (producer side)
bool lockfree_ring_buffer_enqueue(lockfree_ring_buffer_t *rb, void *item) {
    size_t current_tail = atomic_load_explicit(&rb->tail, memory_order_relaxed);
    size_t next_tail = (current_tail + 1) & rb->mask;
    
    // Check if buffer is full
    if (next_tail == atomic_load_explicit(&rb->head, memory_order_acquire)) {
        return false; // Buffer full
    }
    
    // Store item
    rb->buffer[current_tail] = item;
    
    // Update tail with release semantics
    atomic_store_explicit(&rb->tail, next_tail, memory_order_release);
    
    return true;
}

// Dequeue item (consumer side)
bool lockfree_ring_buffer_dequeue(lockfree_ring_buffer_t *rb, void **item) {
    size_t current_head = atomic_load_explicit(&rb->head, memory_order_relaxed);
    
    // Check if buffer is empty
    if (current_head == atomic_load_explicit(&rb->tail, memory_order_acquire)) {
        return false; // Buffer empty
    }
    
    // Load item
    *item = rb->buffer[current_head];
    
    // Update head with release semantics
    size_t next_head = (current_head + 1) & rb->mask;
    atomic_store_explicit(&rb->head, next_head, memory_order_release);
    
    return true;
}

// Lock-free stack using CAS
typedef struct lockfree_stack_node {
    void *data;
    struct lockfree_stack_node *next;
} lockfree_stack_node_t;

typedef struct {
    _Atomic(lockfree_stack_node_t *) head;
    _Atomic size_t size;
} lockfree_stack_t;

// Create lock-free stack
lockfree_stack_t* lockfree_stack_create(void) {
    lockfree_stack_t *stack = malloc(sizeof(lockfree_stack_t));
    if (!stack) return NULL;
    
    atomic_store(&stack->head, NULL);
    atomic_store(&stack->size, 0);
    
    return stack;
}

// Push item onto stack
bool lockfree_stack_push(lockfree_stack_t *stack, void *data) {
    lockfree_stack_node_t *node = malloc(sizeof(lockfree_stack_node_t));
    if (!node) return false;
    
    node->data = data;
    
    lockfree_stack_node_t *old_head;
    do {
        old_head = atomic_load(&stack->head);
        node->next = old_head;
    } while (!atomic_compare_exchange_weak(&stack->head, &old_head, node));
    
    atomic_fetch_add(&stack->size, 1);
    return true;
}

// Pop item from stack
bool lockfree_stack_pop(lockfree_stack_t *stack, void **data) {
    lockfree_stack_node_t *old_head;
    lockfree_stack_node_t *new_head;
    
    do {
        old_head = atomic_load(&stack->head);
        if (!old_head) {
            return false; // Stack empty
        }
        new_head = old_head->next;
    } while (!atomic_compare_exchange_weak(&stack->head, &old_head, new_head));
    
    *data = old_head->data;
    free(old_head);
    
    atomic_fetch_sub(&stack->size, 1);
    return true;
}

// Lock-free hash table (simplified)
#define HASH_TABLE_SIZE 1024

typedef struct hash_entry {
    _Atomic(struct hash_entry *) next;
    atomic_uintptr_t key;
    _Atomic(void *) value;
} hash_entry_t;

typedef struct {
    _Atomic(hash_entry_t *) buckets[HASH_TABLE_SIZE];
    _Atomic size_t size;
} lockfree_hash_table_t;

// Simple hash function
static size_t hash_function(uintptr_t key) {
    return (key * 2654435761UL) % HASH_TABLE_SIZE;
}

// Create lock-free hash table
lockfree_hash_table_t* lockfree_hash_table_create(void) {
    lockfree_hash_table_t *table = malloc(sizeof(lockfree_hash_table_t));
    if (!table) return NULL;
    
    for (int i = 0; i < HASH_TABLE_SIZE; i++) {
        atomic_store(&table->buckets[i], NULL);
    }
    atomic_store(&table->size, 0);
    
    return table;
}

// Insert key-value pair
bool lockfree_hash_table_insert(lockfree_hash_table_t *table, 
                                uintptr_t key, void *value) {
    size_t bucket_index = hash_function(key);
    
    hash_entry_t *new_entry = malloc(sizeof(hash_entry_t));
    if (!new_entry) return false;
    
    atomic_store(&new_entry->key, key);
    atomic_store(&new_entry->value, value);
    
    hash_entry_t *old_head;
    do {
        old_head = atomic_load(&table->buckets[bucket_index]);
        atomic_store(&new_entry->next, old_head);
    } while (!atomic_compare_exchange_weak(&table->buckets[bucket_index], 
                                          &old_head, new_entry));
    
    atomic_fetch_add(&table->size, 1);
    return true;
}

// Lookup value by key
bool lockfree_hash_table_lookup(lockfree_hash_table_t *table, 
                               uintptr_t key, void **value) {
    size_t bucket_index = hash_function(key);
    
    hash_entry_t *current = atomic_load(&table->buckets[bucket_index]);
    
    while (current) {
        if (atomic_load(&current->key) == key) {
            *value = atomic_load(&current->value);
            return true;
        }
        current = atomic_load(&current->next);
    }
    
    return false;
}

// RCU (Read-Copy-Update) implementation
typedef struct rcu_data {
    _Atomic(void *) ptr;
    _Atomic size_t grace_period;
} rcu_data_t;

static _Atomic size_t global_grace_period = 0;
static _Atomic size_t readers_count = 0;

// RCU read lock
void rcu_read_lock(void) {
    atomic_fetch_add(&readers_count, 1);
    atomic_thread_fence(memory_order_acquire);
}

// RCU read unlock
void rcu_read_unlock(void) {
    atomic_thread_fence(memory_order_release);
    atomic_fetch_sub(&readers_count, 1);
}

// RCU synchronize (wait for grace period)
void rcu_synchronize(void) {
    size_t grace_period = atomic_fetch_add(&global_grace_period, 1) + 1;
    
    // Wait for all readers to complete
    while (atomic_load(&readers_count) > 0) {
        sched_yield();
    }
    
    // Additional memory barrier
    atomic_thread_fence(memory_order_seq_cst);
}

// Update RCU-protected data
void rcu_assign_pointer(rcu_data_t *rcu_data, void *new_ptr) {
    atomic_store_explicit(&rcu_data->ptr, new_ptr, memory_order_release);
    atomic_store(&rcu_data->grace_period, atomic_load(&global_grace_period));
}

// Read RCU-protected data
void* rcu_dereference(rcu_data_t *rcu_data) {
    return atomic_load_explicit(&rcu_data->ptr, memory_order_consume);
}

// Performance testing for lock-free structures
typedef struct {
    int thread_id;
    lockfree_ring_buffer_t *rb;
    int operations;
    struct timespec start_time;
    struct timespec end_time;
} test_thread_data_t;

void* producer_thread(void *arg) {
    test_thread_data_t *data = (test_thread_data_t *)arg;
    
    clock_gettime(CLOCK_MONOTONIC, &data->start_time);
    
    for (int i = 0; i < data->operations; i++) {
        while (!lockfree_ring_buffer_enqueue(data->rb, (void *)(uintptr_t)i)) {
            // Busy wait or yield
            sched_yield();
        }
    }
    
    clock_gettime(CLOCK_MONOTONIC, &data->end_time);
    return NULL;
}

void* consumer_thread(void *arg) {
    test_thread_data_t *data = (test_thread_data_t *)arg;
    
    clock_gettime(CLOCK_MONOTONIC, &data->start_time);
    
    void *item;
    for (int i = 0; i < data->operations; i++) {
        while (!lockfree_ring_buffer_dequeue(data->rb, &item)) {
            // Busy wait or yield
            sched_yield();
        }
    }
    
    clock_gettime(CLOCK_MONOTONIC, &data->end_time);
    return NULL;
}

// Benchmark lock-free ring buffer
void benchmark_lockfree_ring_buffer(void) {
    const int operations = 1000000;
    const int num_producers = 2;
    const int num_consumers = 2;
    
    lockfree_ring_buffer_t *rb = lockfree_ring_buffer_create(1024);
    
    pthread_t producers[num_producers];
    pthread_t consumers[num_consumers];
    test_thread_data_t producer_data[num_producers];
    test_thread_data_t consumer_data[num_consumers];
    
    printf("Benchmarking lock-free ring buffer:\n");
    printf("  Operations: %d\n", operations);
    printf("  Producers: %d\n", num_producers);
    printf("  Consumers: %d\n", num_consumers);
    
    // Start producer threads
    for (int i = 0; i < num_producers; i++) {
        producer_data[i].thread_id = i;
        producer_data[i].rb = rb;
        producer_data[i].operations = operations / num_producers;
        pthread_create(&producers[i], NULL, producer_thread, &producer_data[i]);
    }
    
    // Start consumer threads
    for (int i = 0; i < num_consumers; i++) {
        consumer_data[i].thread_id = i;
        consumer_data[i].rb = rb;
        consumer_data[i].operations = operations / num_consumers;
        pthread_create(&consumers[i], NULL, consumer_thread, &consumer_data[i]);
    }
    
    // Wait for completion
    for (int i = 0; i < num_producers; i++) {
        pthread_join(producers[i], NULL);
    }
    for (int i = 0; i < num_consumers; i++) {
        pthread_join(consumers[i], NULL);
    }
    
    // Calculate and display results
    double total_time = 0;
    for (int i = 0; i < num_producers; i++) {
        double thread_time = (producer_data[i].end_time.tv_sec - producer_data[i].start_time.tv_sec) +
                           (producer_data[i].end_time.tv_nsec - producer_data[i].start_time.tv_nsec) / 1e9;
        total_time += thread_time;
    }
    
    double avg_time = total_time / num_producers;
    double ops_per_sec = operations / avg_time;
    
    printf("Results:\n");
    printf("  Average time: %.3f seconds\n", avg_time);
    printf("  Operations per second: %.0f\n", ops_per_sec);
    
    free(rb->buffer);
    free(rb);
}

int main(void) {
    printf("Lock-Free Programming Examples\n");
    printf("==============================\n\n");
    
    benchmark_lockfree_ring_buffer();
    
    return 0;
}
```

## RT Kernel Analysis and Tuning

### RT Kernel Configuration

```bash
#!/bin/bash
# rt_kernel_tuning.sh - Real-time kernel analysis and tuning

# Check RT kernel capabilities
check_rt_kernel() {
    echo "=== Real-Time Kernel Analysis ==="
    
    # Check if PREEMPT_RT is enabled
    if grep -q "PREEMPT_RT" /boot/config-$(uname -r) 2>/dev/null; then
        echo "✓ PREEMPT_RT kernel detected"
    elif grep -q "CONFIG_PREEMPT=y" /boot/config-$(uname -r) 2>/dev/null; then
        echo "⚠ Preemptible kernel (not full RT)"
    else
        echo "✗ Non-preemptible kernel"
    fi
    
    # Check kernel version and RT patch
    echo "Kernel version: $(uname -r)"
    
    # Check for RT-related configuration
    echo
    echo "RT-related kernel configuration:"
    if [ -f "/boot/config-$(uname -r)" ]; then
        grep -E "(PREEMPT|RT|IRQ|LATENCY|HIGH_RES)" /boot/config-$(uname -r) | head -20
    else
        echo "Kernel config not available"
    fi
    
    # Check RT scheduling classes
    echo
    echo "Available scheduling policies:"
    echo "  SCHED_OTHER: $(chrt -m | grep OTHER | awk '{print $3}')"
    echo "  SCHED_FIFO: $(chrt -m | grep FIFO | awk '{print $3 "-" $5}')"
    echo "  SCHED_RR: $(chrt -m | grep RR | awk '{print $3 "-" $5}')"
    
    # Check for RT-related features
    echo
    echo "RT kernel features:"
    [ -f /sys/kernel/debug/tracing/events/irq ] && echo "✓ IRQ tracing available"
    [ -f /proc/sys/kernel/sched_rt_period_us ] && echo "✓ RT bandwidth control available"
    [ -f /sys/devices/system/clocksource/clocksource0/current_clocksource ] && \
        echo "✓ High-resolution timers: $(cat /sys/devices/system/clocksource/clocksource0/current_clocksource)"
}

# Analyze interrupt latency
analyze_interrupt_latency() {
    local duration=${1:-30}
    
    echo "=== Interrupt Latency Analysis ==="
    echo "Duration: ${duration} seconds"
    
    # Check if cyclictest is available
    if ! command -v cyclictest >/dev/null; then
        echo "Installing rt-tests..."
        apt-get update && apt-get install -y rt-tests
    fi
    
    # Run cyclictest for latency measurement
    echo "Running cyclictest..."
    cyclictest -t1 -p99 -i1000 -l$((duration * 1000)) -q | \
    while read line; do
        if [[ $line =~ T:[[:space:]]*0.*C:[[:space:]]*([0-9]+).*Min:[[:space:]]*([0-9]+).*Act:[[:space:]]*([0-9]+).*Avg:[[:space:]]*([0-9]+).*Max:[[:space:]]*([0-9]+) ]]; then
            cycles=${BASH_REMATCH[1]}
            min_lat=${BASH_REMATCH[2]}
            act_lat=${BASH_REMATCH[3]}
            avg_lat=${BASH_REMATCH[4]}
            max_lat=${BASH_REMATCH[5]}
            
            printf "Cycles: %6d, Min: %3d μs, Current: %3d μs, Avg: %3d μs, Max: %3d μs\n" \
                   $cycles $min_lat $act_lat $avg_lat $max_lat
        fi
    done
    
    echo "Latency test completed"
}

# RT system tuning
tune_rt_system() {
    echo "=== Real-Time System Tuning ==="
    
    # CPU frequency scaling
    echo "Configuring CPU frequency scaling..."
    for cpu in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
        if [ -f "$cpu" ]; then
            echo performance > "$cpu" 2>/dev/null || echo "Cannot set performance governor for $(dirname $cpu)"
        fi
    done
    
    # Disable CPU idle states for RT cores
    echo "Disabling CPU idle states..."
    for cpu in /sys/devices/system/cpu/cpu*/cpuidle/state*/disable; do
        if [ -f "$cpu" ]; then
            echo 1 > "$cpu" 2>/dev/null
        fi
    done
    
    # RT scheduling parameters
    echo "Configuring RT scheduling parameters..."
    
    # RT throttling (disable for hard RT)
    echo -1 > /proc/sys/kernel/sched_rt_runtime_us 2>/dev/null || \
        echo "Cannot disable RT throttling"
    
    # Set RT period
    echo 1000000 > /proc/sys/kernel/sched_rt_period_us 2>/dev/null || \
        echo "Cannot set RT period"
    
    # Memory management tuning
    echo "Configuring memory management..."
    
    # Disable swap
    swapoff -a 2>/dev/null || echo "No swap to disable"
    
    # Virtual memory tuning
    echo 1 > /proc/sys/vm/swappiness 2>/dev/null
    echo 10 > /proc/sys/vm/dirty_ratio 2>/dev/null
    echo 5 > /proc/sys/vm/dirty_background_ratio 2>/dev/null
    
    # Interrupt handling
    echo "Configuring interrupt handling..."
    
    # Move IRQs away from RT CPUs (example for CPU 1-3 as RT)
    for irq in /proc/irq/*/smp_affinity; do
        if [ -f "$irq" ]; then
            echo 1 > "$irq" 2>/dev/null  # Bind to CPU 0
        fi
    done
    
    # Kernel parameters
    echo "Setting kernel parameters..."
    
    # Disable watchdog
    echo 0 > /proc/sys/kernel/nmi_watchdog 2>/dev/null
    
    # Reduce kernel timer frequency
    echo 100 > /proc/sys/kernel/timer_migration 2>/dev/null
    
    echo "RT system tuning completed"
}

# Isolate CPUs for RT use
isolate_rt_cpus() {
    local rt_cpus=${1:-"1-3"}
    
    echo "=== CPU Isolation for RT ==="
    echo "RT CPUs: $rt_cpus"
    
    # Check current isolation
    if [ -f /sys/devices/system/cpu/isolated ]; then
        echo "Currently isolated CPUs: $(cat /sys/devices/system/cpu/isolated)"
    fi
    
    # Show how to configure isolation
    echo "To isolate CPUs for RT use, add to kernel command line:"
    echo "  isolcpus=$rt_cpus nohz_full=$rt_cpus rcu_nocbs=$rt_cpus"
    echo
    echo "Current kernel command line:"
    cat /proc/cmdline
    echo
    
    # Move kernel threads away from RT CPUs
    echo "Moving kernel threads away from RT CPUs..."
    
    # Get list of kernel threads
    for thread in $(ps -eo pid,comm | awk '/\[.*\]$/ {print $1}'); do
        if [ -f "/proc/$thread/task" ]; then
            for task in /proc/$thread/task/*/; do
                if [ -d "$task" ]; then
                    local task_id=$(basename "$task")
                    taskset -pc 0 "$task_id" 2>/dev/null || true
                fi
            done
        fi
    done
    
    echo "Kernel thread migration completed"
}

# RT application monitoring
monitor_rt_applications() {
    local duration=${2:-60}
    
    echo "=== RT Application Monitoring ==="
    echo "Duration: ${duration} seconds"
    
    # Monitor RT processes
    echo "Current RT processes:"
    ps -eo pid,tid,class,rtprio,pri,psr,comm | grep -E "(FF|RR)" | head -20
    echo
    
    # Monitor context switches
    echo "Context switch monitoring..."
    local cs_start=$(awk '/ctxt/ {print $2}' /proc/stat)
    sleep $duration
    local cs_end=$(awk '/ctxt/ {print $2}' /proc/stat)
    local cs_rate=$(( (cs_end - cs_start) / duration ))
    
    echo "Context switches per second: $cs_rate"
    
    # Monitor interrupts
    echo "Interrupt monitoring..."
    local int_start=$(awk '/intr/ {print $2}' /proc/stat)
    sleep 1
    local int_end=$(awk '/intr/ {print $2}' /proc/stat)
    local int_rate=$((int_end - int_start))
    
    echo "Interrupts per second: $int_rate"
    
    # Check for scheduling latency
    if [ -f /sys/kernel/debug/tracing/trace ]; then
        echo "Checking scheduling latency..."
        echo 1 > /sys/kernel/debug/tracing/events/sched/enable 2>/dev/null
        sleep 5
        echo 0 > /sys/kernel/debug/tracing/events/sched/enable 2>/dev/null
        
        echo "Recent scheduling events:"
        tail -20 /sys/kernel/debug/tracing/trace 2>/dev/null | head -10
    fi
}

# RT performance test
run_rt_performance_test() {
    echo "=== RT Performance Test ==="
    
    # Compile and run a simple RT test
    cat > /tmp/rt_test.c << 'EOF'
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <sched.h>
#include <time.h>
#include <sys/mman.h>

int main() {
    struct sched_param param;
    struct timespec start, end, period = {0, 1000000}; // 1ms
    
    // Set RT priority
    param.sched_priority = 90;
    sched_setscheduler(0, SCHED_FIFO, &param);
    
    // Lock memory
    mlockall(MCL_CURRENT | MCL_FUTURE);
    
    // Run for 1000 iterations
    clock_gettime(CLOCK_MONOTONIC, &start);
    
    for (int i = 0; i < 1000; i++) {
        clock_nanosleep(CLOCK_MONOTONIC, 0, &period, NULL);
    }
    
    clock_gettime(CLOCK_MONOTONIC, &end);
    
    double elapsed = (end.tv_sec - start.tv_sec) + 
                    (end.tv_nsec - start.tv_nsec) / 1e9;
    
    printf("RT test completed:\n");
    printf("  Expected time: 1.000 seconds\n");
    printf("  Actual time: %.6f seconds\n", elapsed);
    printf("  Jitter: %.6f seconds\n", elapsed - 1.0);
    
    return 0;
}
EOF
    
    gcc -o /tmp/rt_test /tmp/rt_test.c -lrt
    
    if [ $? -eq 0 ]; then
        echo "Running RT performance test..."
        /tmp/rt_test
        rm -f /tmp/rt_test /tmp/rt_test.c
    else
        echo "Failed to compile RT test"
    fi
}

# Main function
main() {
    local action=${1:-"check"}
    
    case "$action" in
        "check")
            check_rt_kernel
            ;;
        "latency")
            analyze_interrupt_latency $2
            ;;
        "tune")
            tune_rt_system
            ;;
        "isolate")
            isolate_rt_cpus $2
            ;;
        "monitor")
            monitor_rt_applications $2
            ;;
        "test")
            run_rt_performance_test
            ;;
        "all")
            check_rt_kernel
            echo
            tune_rt_system
            echo
            run_rt_performance_test
            ;;
        *)
            echo "Usage: $0 <check|latency|tune|isolate|monitor|test|all> [args]"
            ;;
    esac
}

main "$@"
```

## Best Practices

1. **Determinism First**: Design for predictable behavior over peak performance
2. **Memory Management**: Use memory locking and avoid dynamic allocation in RT paths
3. **Priority Inversion**: Use priority inheritance and careful lock design
4. **CPU Isolation**: Dedicate CPUs to RT tasks and move interrupts away
5. **Testing**: Comprehensive latency testing under stress conditions

## Conclusion

Real-time Linux programming requires mastering specialized techniques for building deterministic systems. From RT scheduling policies and lock-free programming to kernel tuning and latency optimization, these advanced techniques enable the development of mission-critical real-time applications.

Success in real-time programming comes from understanding the complete system stack, from hardware constraints to kernel behavior and application design. The techniques covered here provide the foundation for building robust, deterministic real-time systems on Linux platforms.