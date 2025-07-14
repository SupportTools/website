---
title: "Advanced Concurrency and Parallel Programming: Mastering Multi-Threading and Synchronization"
date: 2025-03-23T10:00:00-05:00
draft: false
tags: ["Linux", "Concurrency", "Parallel Programming", "Threading", "Synchronization", "OpenMP", "CUDA"]
categories:
- Linux
- Parallel Programming
author: "Matthew Mattox - mmattox@support.tools"
description: "Master advanced concurrency techniques including thread pools, lock-free algorithms, work-stealing schedulers, GPU programming, and building high-performance parallel applications"
more_link: "yes"
url: "/advanced-concurrency-parallel-programming/"
---

Modern computing demands sophisticated concurrency and parallel programming techniques to harness multi-core processors and distributed systems. This comprehensive guide explores advanced threading models, synchronization primitives, lock-free algorithms, and parallel processing frameworks for building high-performance concurrent applications.

<!--more-->

# [Advanced Concurrency and Parallel Programming](#advanced-concurrency-parallel-programming)

## Advanced Threading Models and Thread Pools

### High-Performance Thread Pool Implementation

```c
// thread_pool.c - Advanced thread pool implementation
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <pthread.h>
#include <semaphore.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <errno.h>
#include <sys/time.h>
#include <sched.h>

// Task structure
typedef struct task {
    void (*function)(void *arg);
    void *argument;
    struct task *next;
    int priority;
    struct timeval submit_time;
} task_t;

// Task queue with priority support
typedef struct {
    task_t **queues;        // Array of priority queues
    int num_priorities;
    pthread_mutex_t mutex;
    pthread_cond_t condition;
    atomic_int size;
    atomic_int total_tasks;
} task_queue_t;

// Worker thread statistics
typedef struct {
    atomic_long tasks_executed;
    atomic_long total_execution_time_ns;
    atomic_long idle_time_ns;
    struct timespec last_task_end;
    int cpu_affinity;
} worker_stats_t;

// Thread pool structure
typedef struct {
    pthread_t *threads;
    worker_stats_t *worker_stats;
    int num_threads;
    task_queue_t task_queue;
    atomic_bool shutdown;
    atomic_bool immediate_shutdown;
    
    // Work stealing support
    task_queue_t *local_queues;
    atomic_int *queue_locks;
    
    // Performance monitoring
    atomic_long total_tasks_submitted;
    atomic_long total_tasks_completed;
    struct timespec start_time;
    
    // Dynamic resizing
    pthread_mutex_t resize_mutex;
    int min_threads;
    int max_threads;
    atomic_int active_threads;
    
    // Load balancing
    atomic_int round_robin_index;
} thread_pool_t;

// Initialize task queue
int task_queue_init(task_queue_t *queue, int num_priorities) {
    queue->queues = calloc(num_priorities, sizeof(task_t*));
    if (!queue->queues) {
        return -1;
    }
    
    queue->num_priorities = num_priorities;
    atomic_init(&queue->size, 0);
    atomic_init(&queue->total_tasks, 0);
    
    if (pthread_mutex_init(&queue->mutex, NULL) != 0) {
        free(queue->queues);
        return -1;
    }
    
    if (pthread_cond_init(&queue->condition, NULL) != 0) {
        pthread_mutex_destroy(&queue->mutex);
        free(queue->queues);
        return -1;
    }
    
    return 0;
}

// Add task to priority queue
int task_queue_push(task_queue_t *queue, task_t *task) {
    if (task->priority < 0 || task->priority >= queue->num_priorities) {
        return -1;
    }
    
    pthread_mutex_lock(&queue->mutex);
    
    // Insert at head of priority queue
    task->next = queue->queues[task->priority];
    queue->queues[task->priority] = task;
    
    atomic_fetch_add(&queue->size, 1);
    atomic_fetch_add(&queue->total_tasks, 1);
    
    pthread_cond_signal(&queue->condition);
    pthread_mutex_unlock(&queue->mutex);
    
    return 0;
}

// Pop task from highest priority queue
task_t* task_queue_pop(task_queue_t *queue) {
    pthread_mutex_lock(&queue->mutex);
    
    while (atomic_load(&queue->size) == 0) {
        pthread_cond_wait(&queue->condition, &queue->mutex);
    }
    
    task_t *task = NULL;
    
    // Find highest priority non-empty queue
    for (int i = queue->num_priorities - 1; i >= 0; i--) {
        if (queue->queues[i]) {
            task = queue->queues[i];
            queue->queues[i] = task->next;
            break;
        }
    }
    
    if (task) {
        atomic_fetch_sub(&queue->size, 1);
    }
    
    pthread_mutex_unlock(&queue->mutex);
    return task;
}

// Try to pop task without blocking
task_t* task_queue_try_pop(task_queue_t *queue) {
    if (pthread_mutex_trylock(&queue->mutex) != 0) {
        return NULL;
    }
    
    task_t *task = NULL;
    
    if (atomic_load(&queue->size) > 0) {
        // Find highest priority non-empty queue
        for (int i = queue->num_priorities - 1; i >= 0; i--) {
            if (queue->queues[i]) {
                task = queue->queues[i];
                queue->queues[i] = task->next;
                atomic_fetch_sub(&queue->size, 1);
                break;
            }
        }
    }
    
    pthread_mutex_unlock(&queue->mutex);
    return task;
}

// Work stealing implementation
task_t* steal_task(thread_pool_t *pool, int worker_id) {
    int num_workers = atomic_load(&pool->active_threads);
    
    // Try to steal from other workers' local queues
    for (int i = 1; i < num_workers; i++) {
        int target = (worker_id + i) % num_workers;
        
        // Try to acquire lock on target queue
        int expected = 0;
        if (atomic_compare_exchange_weak(&pool->queue_locks[target], &expected, 1)) {
            task_t *stolen_task = task_queue_try_pop(&pool->local_queues[target]);
            atomic_store(&pool->queue_locks[target], 0);
            
            if (stolen_task) {
                return stolen_task;
            }
        }
    }
    
    return NULL;
}

// Worker thread function
void* worker_thread(void *arg) {
    thread_pool_t *pool = (thread_pool_t*)arg;
    int worker_id = atomic_fetch_add(&pool->round_robin_index, 1) % pool->max_threads;
    
    // Set CPU affinity if specified
    if (pool->worker_stats[worker_id].cpu_affinity >= 0) {
        cpu_set_t cpuset;
        CPU_ZERO(&cpuset);
        CPU_SET(pool->worker_stats[worker_id].cpu_affinity, &cpuset);
        pthread_setaffinity_np(pthread_self(), sizeof(cpu_set_t), &cpuset);
    }
    
    struct timespec idle_start, idle_end, task_start, task_end;
    
    while (!atomic_load(&pool->shutdown)) {
        task_t *task = NULL;
        
        clock_gettime(CLOCK_MONOTONIC, &idle_start);
        
        // Try local queue first (work stealing)
        if (pool->local_queues) {
            task = task_queue_try_pop(&pool->local_queues[worker_id]);
        }
        
        // Try global queue
        if (!task) {
            task = task_queue_pop(&pool->task_queue);
        }
        
        // Try work stealing
        if (!task && pool->local_queues) {
            task = steal_task(pool, worker_id);
        }
        
        if (!task) {
            if (atomic_load(&pool->immediate_shutdown)) {
                break;
            }
            continue;
        }
        
        clock_gettime(CLOCK_MONOTONIC, &idle_end);
        
        // Update idle time statistics
        long idle_ns = (idle_end.tv_sec - idle_start.tv_sec) * 1000000000L +
                      (idle_end.tv_nsec - idle_start.tv_nsec);
        atomic_fetch_add(&pool->worker_stats[worker_id].idle_time_ns, idle_ns);
        
        // Execute task
        clock_gettime(CLOCK_MONOTONIC, &task_start);
        task->function(task->argument);
        clock_gettime(CLOCK_MONOTONIC, &task_end);
        
        // Update execution statistics
        long exec_ns = (task_end.tv_sec - task_start.tv_sec) * 1000000000L +
                      (task_end.tv_nsec - task_start.tv_nsec);
        
        atomic_fetch_add(&pool->worker_stats[worker_id].tasks_executed, 1);
        atomic_fetch_add(&pool->worker_stats[worker_id].total_execution_time_ns, exec_ns);
        atomic_fetch_add(&pool->total_tasks_completed, 1);
        
        pool->worker_stats[worker_id].last_task_end = task_end;
        
        free(task);
    }
    
    return NULL;
}

// Create thread pool
thread_pool_t* thread_pool_create(int num_threads, int min_threads, int max_threads,
                                 bool enable_work_stealing, int num_priorities) {
    thread_pool_t *pool = calloc(1, sizeof(thread_pool_t));
    if (!pool) {
        return NULL;
    }
    
    pool->num_threads = num_threads;
    pool->min_threads = min_threads;
    pool->max_threads = max_threads;
    atomic_init(&pool->active_threads, num_threads);
    atomic_init(&pool->shutdown, false);
    atomic_init(&pool->immediate_shutdown, false);
    atomic_init(&pool->total_tasks_submitted, 0);
    atomic_init(&pool->total_tasks_completed, 0);
    atomic_init(&pool->round_robin_index, 0);
    
    clock_gettime(CLOCK_MONOTONIC, &pool->start_time);
    
    // Initialize main task queue
    if (task_queue_init(&pool->task_queue, num_priorities) != 0) {
        free(pool);
        return NULL;
    }
    
    // Initialize work-stealing queues
    if (enable_work_stealing) {
        pool->local_queues = calloc(max_threads, sizeof(task_queue_t));
        pool->queue_locks = calloc(max_threads, sizeof(atomic_int));
        
        if (!pool->local_queues || !pool->queue_locks) {
            free(pool->local_queues);
            free(pool->queue_locks);
            free(pool);
            return NULL;
        }
        
        for (int i = 0; i < max_threads; i++) {
            task_queue_init(&pool->local_queues[i], num_priorities);
            atomic_init(&pool->queue_locks[i], 0);
        }
    }
    
    // Allocate threads and statistics
    pool->threads = calloc(max_threads, sizeof(pthread_t));
    pool->worker_stats = calloc(max_threads, sizeof(worker_stats_t));
    
    if (!pool->threads || !pool->worker_stats) {
        free(pool->threads);
        free(pool->worker_stats);
        free(pool);
        return NULL;
    }
    
    // Initialize worker statistics
    for (int i = 0; i < max_threads; i++) {
        atomic_init(&pool->worker_stats[i].tasks_executed, 0);
        atomic_init(&pool->worker_stats[i].total_execution_time_ns, 0);
        atomic_init(&pool->worker_stats[i].idle_time_ns, 0);
        pool->worker_stats[i].cpu_affinity = -1; // No affinity by default
    }
    
    pthread_mutex_init(&pool->resize_mutex, NULL);
    
    // Create worker threads
    for (int i = 0; i < num_threads; i++) {
        if (pthread_create(&pool->threads[i], NULL, worker_thread, pool) != 0) {
            thread_pool_destroy(pool);
            return NULL;
        }
    }
    
    return pool;
}

// Submit task to thread pool
int thread_pool_submit(thread_pool_t *pool, void (*function)(void*), 
                      void *argument, int priority) {
    if (atomic_load(&pool->shutdown)) {
        return -1;
    }
    
    task_t *task = malloc(sizeof(task_t));
    if (!task) {
        return -1;
    }
    
    task->function = function;
    task->argument = argument;
    task->priority = priority;
    task->next = NULL;
    gettimeofday(&task->submit_time, NULL);
    
    // Load balancing: distribute tasks among local queues
    if (pool->local_queues) {
        int target_queue = atomic_fetch_add(&pool->round_robin_index, 1) % 
                          atomic_load(&pool->active_threads);
        
        if (task_queue_push(&pool->local_queues[target_queue], task) == 0) {
            atomic_fetch_add(&pool->total_tasks_submitted, 1);
            return 0;
        }
    }
    
    // Fallback to global queue
    if (task_queue_push(&pool->task_queue, task) == 0) {
        atomic_fetch_add(&pool->total_tasks_submitted, 1);
        return 0;
    }
    
    free(task);
    return -1;
}

// Set CPU affinity for worker thread
int thread_pool_set_affinity(thread_pool_t *pool, int worker_id, int cpu_id) {
    if (worker_id < 0 || worker_id >= pool->max_threads) {
        return -1;
    }
    
    pool->worker_stats[worker_id].cpu_affinity = cpu_id;
    
    // Apply immediately if thread is running
    if (worker_id < pool->num_threads) {
        cpu_set_t cpuset;
        CPU_ZERO(&cpuset);
        CPU_SET(cpu_id, &cpuset);
        return pthread_setaffinity_np(pool->threads[worker_id], sizeof(cpu_set_t), &cpuset);
    }
    
    return 0;
}

// Get thread pool statistics
void thread_pool_stats(thread_pool_t *pool) {
    struct timespec current_time;
    clock_gettime(CLOCK_MONOTONIC, &current_time);
    
    long uptime_ns = (current_time.tv_sec - pool->start_time.tv_sec) * 1000000000L +
                    (current_time.tv_nsec - pool->start_time.tv_nsec);
    
    printf("=== Thread Pool Statistics ===\n");
    printf("Uptime: %.3f seconds\n", uptime_ns / 1e9);
    printf("Active threads: %d\n", atomic_load(&pool->active_threads));
    printf("Tasks submitted: %ld\n", atomic_load(&pool->total_tasks_submitted));
    printf("Tasks completed: %ld\n", atomic_load(&pool->total_tasks_completed));
    printf("Tasks pending: %d\n", atomic_load(&pool->task_queue.size));
    
    long total_tasks_executed = 0;
    long total_execution_time = 0;
    long total_idle_time = 0;
    
    printf("\nPer-worker statistics:\n");
    for (int i = 0; i < pool->num_threads; i++) {
        long tasks = atomic_load(&pool->worker_stats[i].tasks_executed);
        long exec_time = atomic_load(&pool->worker_stats[i].total_execution_time_ns);
        long idle_time = atomic_load(&pool->worker_stats[i].idle_time_ns);
        
        total_tasks_executed += tasks;
        total_execution_time += exec_time;
        total_idle_time += idle_time;
        
        printf("  Worker %d: %ld tasks, %.3f ms avg exec, %.1f%% idle\n",
               i, tasks,
               tasks > 0 ? (exec_time / 1e6) / tasks : 0,
               uptime_ns > 0 ? (idle_time * 100.0) / uptime_ns : 0);
    }
    
    printf("\nOverall performance:\n");
    printf("  Total tasks executed: %ld\n", total_tasks_executed);
    printf("  Average execution time: %.3f ms\n",
           total_tasks_executed > 0 ? (total_execution_time / 1e6) / total_tasks_executed : 0);
    printf("  Throughput: %.1f tasks/second\n",
           uptime_ns > 0 ? (total_tasks_executed * 1e9) / uptime_ns : 0);
}

// Dynamic thread pool resizing
int thread_pool_resize(thread_pool_t *pool, int new_size) {
    if (new_size < pool->min_threads || new_size > pool->max_threads) {
        return -1;
    }
    
    pthread_mutex_lock(&pool->resize_mutex);
    
    int current_size = atomic_load(&pool->active_threads);
    
    if (new_size > current_size) {
        // Add threads
        for (int i = current_size; i < new_size; i++) {
            if (pthread_create(&pool->threads[i], NULL, worker_thread, pool) != 0) {
                pthread_mutex_unlock(&pool->resize_mutex);
                return -1;
            }
        }
        atomic_store(&pool->active_threads, new_size);
    } else if (new_size < current_size) {
        // Remove threads (they will exit naturally when checking shutdown flag)
        atomic_store(&pool->active_threads, new_size);
        
        // Join excess threads
        for (int i = new_size; i < current_size; i++) {
            pthread_join(pool->threads[i], NULL);
        }
    }
    
    pool->num_threads = new_size;
    pthread_mutex_unlock(&pool->resize_mutex);
    
    return 0;
}

// Destroy thread pool
void thread_pool_destroy(thread_pool_t *pool) {
    if (!pool) return;
    
    // Signal shutdown
    atomic_store(&pool->shutdown, true);
    
    // Wake up all threads
    pthread_cond_broadcast(&pool->task_queue.condition);
    
    // Wait for threads to finish
    for (int i = 0; i < pool->num_threads; i++) {
        pthread_join(pool->threads[i], NULL);
    }
    
    // Cleanup
    pthread_mutex_destroy(&pool->task_queue.mutex);
    pthread_cond_destroy(&pool->task_queue.condition);
    pthread_mutex_destroy(&pool->resize_mutex);
    
    // Free local queues
    if (pool->local_queues) {
        for (int i = 0; i < pool->max_threads; i++) {
            pthread_mutex_destroy(&pool->local_queues[i].mutex);
            pthread_cond_destroy(&pool->local_queues[i].condition);
            free(pool->local_queues[i].queues);
        }
        free(pool->local_queues);
        free(pool->queue_locks);
    }
    
    free(pool->task_queue.queues);
    free(pool->threads);
    free(pool->worker_stats);
    free(pool);
}

// Example task functions
void cpu_intensive_task(void *arg) {
    int iterations = *(int*)arg;
    volatile double result = 0.0;
    
    for (int i = 0; i < iterations; i++) {
        result += i * 3.14159;
    }
    
    printf("CPU task completed: %d iterations, result: %f\n", iterations, result);
}

void io_simulation_task(void *arg) {
    int delay_ms = *(int*)arg;
    
    printf("IO simulation starting (%d ms delay)\n", delay_ms);
    usleep(delay_ms * 1000);
    printf("IO simulation completed\n");
}

// Thread pool demo
int thread_pool_demo(void) {
    printf("=== Thread Pool Demo ===\n");
    
    // Create thread pool with work stealing
    thread_pool_t *pool = thread_pool_create(4, 2, 8, true, 3);
    if (!pool) {
        printf("Failed to create thread pool\n");
        return -1;
    }
    
    // Set CPU affinity for workers
    for (int i = 0; i < 4; i++) {
        thread_pool_set_affinity(pool, i, i % 4);
    }
    
    printf("Created thread pool with 4 workers\n");
    
    // Submit various tasks
    int cpu_work[] = {1000000, 2000000, 500000, 1500000, 3000000};
    int io_work[] = {100, 200, 50, 150, 300};
    
    // Submit CPU-intensive tasks with different priorities
    for (int i = 0; i < 5; i++) {
        thread_pool_submit(pool, cpu_intensive_task, &cpu_work[i], 2); // High priority
    }
    
    // Submit I/O simulation tasks
    for (int i = 0; i < 5; i++) {
        thread_pool_submit(pool, io_simulation_task, &io_work[i], 1); // Medium priority
    }
    
    // Wait for some tasks to complete
    sleep(2);
    
    // Show statistics
    thread_pool_stats(pool);
    
    // Resize thread pool
    printf("\nResizing thread pool to 6 workers...\n");
    thread_pool_resize(pool, 6);
    
    // Submit more tasks
    for (int i = 0; i < 3; i++) {
        thread_pool_submit(pool, cpu_intensive_task, &cpu_work[i], 1);
    }
    
    sleep(2);
    
    // Final statistics
    printf("\nFinal statistics:\n");
    thread_pool_stats(pool);
    
    // Cleanup
    thread_pool_destroy(pool);
    
    return 0;
}

int main(void) {
    return thread_pool_demo();
}
```

## Lock-Free Data Structures and Algorithms

### Advanced Lock-Free Implementations

```c
// lockfree_advanced.c - Advanced lock-free data structures
#include <stdio.h>
#include <stdlib.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <string.h>
#include <pthread.h>
#include <unistd.h>
#include <time.h>
#include <assert.h>

// Hazard pointer system for memory management
#define MAX_THREADS 64
#define MAX_HAZARD_POINTERS 8

typedef struct hazard_pointer {
    _Atomic(void*) pointer;
    atomic_bool active;
} hazard_pointer_t;

typedef struct hazard_pointer_record {
    hazard_pointer_t hazards[MAX_HAZARD_POINTERS];
    atomic_bool active;
    pthread_t thread_id;
} hazard_pointer_record_t;

static hazard_pointer_record_t hazard_pointer_table[MAX_THREADS];
static _Atomic(hazard_pointer_record_t*) hazard_pointer_head = NULL;

// Thread-local hazard pointer record
static __thread hazard_pointer_record_t* local_hazard_record = NULL;

// Get hazard pointer record for current thread
hazard_pointer_record_t* get_hazard_pointer_record(void) {
    if (local_hazard_record) {
        return local_hazard_record;
    }
    
    // Find existing record or create new one
    for (int i = 0; i < MAX_THREADS; i++) {
        if (!atomic_load(&hazard_pointer_table[i].active)) {
            bool expected = false;
            if (atomic_compare_exchange_strong(&hazard_pointer_table[i].active, 
                                             &expected, true)) {
                hazard_pointer_table[i].thread_id = pthread_self();
                local_hazard_record = &hazard_pointer_table[i];
                
                // Initialize hazard pointers
                for (int j = 0; j < MAX_HAZARD_POINTERS; j++) {
                    atomic_store(&hazard_pointer_table[i].hazards[j].pointer, NULL);
                    atomic_store(&hazard_pointer_table[i].hazards[j].active, false);
                }
                
                return local_hazard_record;
            }
        }
    }
    
    return NULL; // No available slots
}

// Set hazard pointer
void set_hazard_pointer(int index, void *pointer) {
    hazard_pointer_record_t *record = get_hazard_pointer_record();
    if (record && index < MAX_HAZARD_POINTERS) {
        atomic_store(&record->hazards[index].pointer, pointer);
        atomic_store(&record->hazards[index].active, true);
    }
}

// Clear hazard pointer
void clear_hazard_pointer(int index) {
    hazard_pointer_record_t *record = get_hazard_pointer_record();
    if (record && index < MAX_HAZARD_POINTERS) {
        atomic_store(&record->hazards[index].active, false);
        atomic_store(&record->hazards[index].pointer, NULL);
    }
}

// Check if pointer is protected by any hazard pointer
bool is_hazard_pointer(void *pointer) {
    for (int i = 0; i < MAX_THREADS; i++) {
        if (atomic_load(&hazard_pointer_table[i].active)) {
            for (int j = 0; j < MAX_HAZARD_POINTERS; j++) {
                if (atomic_load(&hazard_pointer_table[i].hazards[j].active) &&
                    atomic_load(&hazard_pointer_table[i].hazards[j].pointer) == pointer) {
                    return true;
                }
            }
        }
    }
    return false;
}

// Lock-free queue with hazard pointers
typedef struct queue_node {
    _Atomic(void*) data;
    _Atomic(struct queue_node*) next;
} queue_node_t;

typedef struct {
    _Atomic(queue_node_t*) head;
    _Atomic(queue_node_t*) tail;
    atomic_size_t size;
} lockfree_queue_t;

// Initialize lock-free queue
lockfree_queue_t* lockfree_queue_create(void) {
    lockfree_queue_t *queue = malloc(sizeof(lockfree_queue_t));
    if (!queue) return NULL;
    
    queue_node_t *dummy = malloc(sizeof(queue_node_t));
    if (!dummy) {
        free(queue);
        return NULL;
    }
    
    atomic_store(&dummy->data, NULL);
    atomic_store(&dummy->next, NULL);
    
    atomic_store(&queue->head, dummy);
    atomic_store(&queue->tail, dummy);
    atomic_store(&queue->size, 0);
    
    return queue;
}

// Enqueue operation
bool lockfree_queue_enqueue(lockfree_queue_t *queue, void *data) {
    queue_node_t *new_node = malloc(sizeof(queue_node_t));
    if (!new_node) return false;
    
    atomic_store(&new_node->data, data);
    atomic_store(&new_node->next, NULL);
    
    while (true) {
        queue_node_t *tail = atomic_load(&queue->tail);
        set_hazard_pointer(0, tail);
        
        // Verify tail is still valid
        if (tail != atomic_load(&queue->tail)) {
            continue;
        }
        
        queue_node_t *next = atomic_load(&tail->next);
        
        if (tail == atomic_load(&queue->tail)) {
            if (next == NULL) {
                // Try to link new node at end of list
                if (atomic_compare_exchange_weak(&tail->next, &next, new_node)) {
                    // Try to swing tail to new node
                    atomic_compare_exchange_weak(&queue->tail, &tail, new_node);
                    atomic_fetch_add(&queue->size, 1);
                    clear_hazard_pointer(0);
                    return true;
                }
            } else {
                // Try to swing tail to next node
                atomic_compare_exchange_weak(&queue->tail, &tail, next);
            }
        }
    }
}

// Dequeue operation
bool lockfree_queue_dequeue(lockfree_queue_t *queue, void **data) {
    while (true) {
        queue_node_t *head = atomic_load(&queue->head);
        set_hazard_pointer(0, head);
        
        // Verify head is still valid
        if (head != atomic_load(&queue->head)) {
            continue;
        }
        
        queue_node_t *tail = atomic_load(&queue->tail);
        queue_node_t *next = atomic_load(&head->next);
        set_hazard_pointer(1, next);
        
        if (head == atomic_load(&queue->head)) {
            if (head == tail) {
                if (next == NULL) {
                    // Queue is empty
                    clear_hazard_pointer(0);
                    clear_hazard_pointer(1);
                    return false;
                }
                // Try to swing tail to next node
                atomic_compare_exchange_weak(&queue->tail, &tail, next);
            } else {
                if (next == NULL) {
                    continue;
                }
                
                // Read data before CAS
                *data = atomic_load(&next->data);
                
                // Try to swing head to next node
                if (atomic_compare_exchange_weak(&queue->head, &head, next)) {
                    atomic_fetch_sub(&queue->size, 1);
                    
                    // Free old head node (with hazard pointer protection)
                    if (!is_hazard_pointer(head)) {
                        free(head);
                    }
                    
                    clear_hazard_pointer(0);
                    clear_hazard_pointer(1);
                    return true;
                }
            }
        }
    }
}

// Lock-free hash table
#define HASH_TABLE_SIZE 1024
#define HASH_LOAD_FACTOR 0.75

typedef struct hash_node {
    atomic_uintptr_t key;
    _Atomic(void*) value;
    _Atomic(struct hash_node*) next;
    atomic_bool deleted;
} hash_node_t;

typedef struct {
    _Atomic(hash_node_t*) buckets[HASH_TABLE_SIZE];
    atomic_size_t size;
    atomic_size_t capacity;
} lockfree_hashtable_t;

// Hash function
static size_t hash_function(uintptr_t key) {
    key ^= key >> 16;
    key *= 0x85ebca6b;
    key ^= key >> 13;
    key *= 0xc2b2ae35;
    key ^= key >> 16;
    return key % HASH_TABLE_SIZE;
}

// Create lock-free hash table
lockfree_hashtable_t* lockfree_hashtable_create(void) {
    lockfree_hashtable_t *table = malloc(sizeof(lockfree_hashtable_t));
    if (!table) return NULL;
    
    for (int i = 0; i < HASH_TABLE_SIZE; i++) {
        atomic_store(&table->buckets[i], NULL);
    }
    
    atomic_store(&table->size, 0);
    atomic_store(&table->capacity, HASH_TABLE_SIZE);
    
    return table;
}

// Insert key-value pair
bool lockfree_hashtable_insert(lockfree_hashtable_t *table, uintptr_t key, void *value) {
    size_t bucket = hash_function(key);
    
    hash_node_t *new_node = malloc(sizeof(hash_node_t));
    if (!new_node) return false;
    
    atomic_store(&new_node->key, key);
    atomic_store(&new_node->value, value);
    atomic_store(&new_node->deleted, false);
    
    while (true) {
        hash_node_t *head = atomic_load(&table->buckets[bucket]);
        atomic_store(&new_node->next, head);
        
        if (atomic_compare_exchange_weak(&table->buckets[bucket], &head, new_node)) {
            atomic_fetch_add(&table->size, 1);
            return true;
        }
    }
}

// Lookup value by key
bool lockfree_hashtable_lookup(lockfree_hashtable_t *table, uintptr_t key, void **value) {
    size_t bucket = hash_function(key);
    
    hash_node_t *current = atomic_load(&table->buckets[bucket]);
    set_hazard_pointer(0, current);
    
    while (current) {
        // Verify node is still valid
        if (current != atomic_load(&table->buckets[bucket])) {
            current = atomic_load(&table->buckets[bucket]);
            set_hazard_pointer(0, current);
            continue;
        }
        
        if (!atomic_load(&current->deleted) && 
            atomic_load(&current->key) == key) {
            *value = atomic_load(&current->value);
            clear_hazard_pointer(0);
            return true;
        }
        
        current = atomic_load(&current->next);
        set_hazard_pointer(0, current);
    }
    
    clear_hazard_pointer(0);
    return false;
}

// Lock-free skip list
#define MAX_LEVEL 16

typedef struct skip_node {
    atomic_long key;
    _Atomic(void*) value;
    atomic_int level;
    _Atomic(struct skip_node*) forward[MAX_LEVEL];
    atomic_bool deleted;
} skip_node_t;

typedef struct {
    skip_node_t *header;
    atomic_int max_level;
    atomic_size_t size;
} lockfree_skiplist_t;

// Random level generation
static int random_level(void) {
    int level = 1;
    while ((rand() & 0x1) && level < MAX_LEVEL) {
        level++;
    }
    return level;
}

// Create skip list
lockfree_skiplist_t* lockfree_skiplist_create(void) {
    lockfree_skiplist_t *list = malloc(sizeof(lockfree_skiplist_t));
    if (!list) return NULL;
    
    list->header = malloc(sizeof(skip_node_t));
    if (!list->header) {
        free(list);
        return NULL;
    }
    
    atomic_store(&list->header->key, LONG_MIN);
    atomic_store(&list->header->value, NULL);
    atomic_store(&list->header->level, MAX_LEVEL);
    atomic_store(&list->header->deleted, false);
    
    for (int i = 0; i < MAX_LEVEL; i++) {
        atomic_store(&list->header->forward[i], NULL);
    }
    
    atomic_store(&list->max_level, 1);
    atomic_store(&list->size, 0);
    
    return list;
}

// Insert into skip list
bool lockfree_skiplist_insert(lockfree_skiplist_t *list, long key, void *value) {
    skip_node_t *update[MAX_LEVEL];
    skip_node_t *current = list->header;
    
    // Find position to insert
    for (int i = atomic_load(&list->max_level) - 1; i >= 0; i--) {
        while (true) {
            skip_node_t *next = atomic_load(&current->forward[i]);
            if (!next || atomic_load(&next->key) >= key) {
                break;
            }
            current = next;
        }
        update[i] = current;
    }
    
    current = atomic_load(&current->forward[0]);
    
    // Check if key already exists
    if (current && atomic_load(&current->key) == key && 
        !atomic_load(&current->deleted)) {
        return false;
    }
    
    // Create new node
    int level = random_level();
    skip_node_t *new_node = malloc(sizeof(skip_node_t));
    if (!new_node) return false;
    
    atomic_store(&new_node->key, key);
    atomic_store(&new_node->value, value);
    atomic_store(&new_node->level, level);
    atomic_store(&new_node->deleted, false);
    
    // Update max level if necessary
    if (level > atomic_load(&list->max_level)) {
        for (int i = atomic_load(&list->max_level); i < level; i++) {
            update[i] = list->header;
        }
        atomic_store(&list->max_level, level);
    }
    
    // Link new node
    for (int i = 0; i < level; i++) {
        skip_node_t *next = atomic_load(&update[i]->forward[i]);
        atomic_store(&new_node->forward[i], next);
        
        if (!atomic_compare_exchange_weak(&update[i]->forward[i], &next, new_node)) {
            // Retry on failure
            free(new_node);
            return lockfree_skiplist_insert(list, key, value);
        }
    }
    
    atomic_fetch_add(&list->size, 1);
    return true;
}

// Search in skip list
bool lockfree_skiplist_search(lockfree_skiplist_t *list, long key, void **value) {
    skip_node_t *current = list->header;
    
    for (int i = atomic_load(&list->max_level) - 1; i >= 0; i--) {
        while (true) {
            skip_node_t *next = atomic_load(&current->forward[i]);
            if (!next || atomic_load(&next->key) > key) {
                break;
            }
            if (atomic_load(&next->key) == key && !atomic_load(&next->deleted)) {
                *value = atomic_load(&next->value);
                return true;
            }
            current = next;
        }
    }
    
    return false;
}

// Performance testing
typedef struct {
    void *data_structure;
    int thread_id;
    int operations;
    int operation_type; // 0=insert, 1=lookup, 2=mixed
    struct timespec start_time;
    struct timespec end_time;
    int successful_operations;
} test_thread_data_t;

void* queue_test_thread(void *arg) {
    test_thread_data_t *data = (test_thread_data_t*)arg;
    lockfree_queue_t *queue = (lockfree_queue_t*)data->data_structure;
    
    clock_gettime(CLOCK_MONOTONIC, &data->start_time);
    
    for (int i = 0; i < data->operations; i++) {
        if (data->operation_type == 0) {
            // Enqueue
            int *value = malloc(sizeof(int));
            *value = data->thread_id * 1000000 + i;
            if (lockfree_queue_enqueue(queue, value)) {
                data->successful_operations++;
            }
        } else if (data->operation_type == 1) {
            // Dequeue
            void *value;
            if (lockfree_queue_dequeue(queue, &value)) {
                data->successful_operations++;
                free(value);
            }
        } else {
            // Mixed operations
            if (i % 2 == 0) {
                int *value = malloc(sizeof(int));
                *value = data->thread_id * 1000000 + i;
                if (lockfree_queue_enqueue(queue, value)) {
                    data->successful_operations++;
                }
            } else {
                void *value;
                if (lockfree_queue_dequeue(queue, &value)) {
                    data->successful_operations++;
                    free(value);
                }
            }
        }
    }
    
    clock_gettime(CLOCK_MONOTONIC, &data->end_time);
    return NULL;
}

int benchmark_lockfree_structures(void) {
    printf("=== Lock-Free Data Structure Benchmark ===\n");
    
    const int num_threads = 8;
    const int operations_per_thread = 100000;
    
    // Test lock-free queue
    printf("\nTesting lock-free queue:\n");
    
    lockfree_queue_t *queue = lockfree_queue_create();
    pthread_t threads[num_threads];
    test_thread_data_t thread_data[num_threads];
    
    // Mixed producers and consumers
    for (int i = 0; i < num_threads; i++) {
        thread_data[i].data_structure = queue;
        thread_data[i].thread_id = i;
        thread_data[i].operations = operations_per_thread;
        thread_data[i].operation_type = (i < num_threads/2) ? 0 : 1; // Half producers, half consumers
        thread_data[i].successful_operations = 0;
        
        pthread_create(&threads[i], NULL, queue_test_thread, &thread_data[i]);
    }
    
    // Wait for completion
    for (int i = 0; i < num_threads; i++) {
        pthread_join(threads[i], NULL);
    }
    
    // Calculate results
    long total_operations = 0;
    double total_time = 0;
    
    for (int i = 0; i < num_threads; i++) {
        double thread_time = (thread_data[i].end_time.tv_sec - thread_data[i].start_time.tv_sec) +
                           (thread_data[i].end_time.tv_nsec - thread_data[i].start_time.tv_nsec) / 1e9;
        total_operations += thread_data[i].successful_operations;
        total_time += thread_time;
        
        printf("  Thread %d: %d operations in %.3f seconds (%.0f ops/sec)\n",
               i, thread_data[i].successful_operations, thread_time,
               thread_data[i].successful_operations / thread_time);
    }
    
    double avg_time = total_time / num_threads;
    printf("  Total successful operations: %ld\n", total_operations);
    printf("  Average throughput: %.0f operations/second\n", total_operations / avg_time);
    printf("  Queue final size: %zu\n", atomic_load(&queue->size));
    
    return 0;
}

int main(void) {
    srand(time(NULL));
    return benchmark_lockfree_structures();
}
```

## Parallel Processing Frameworks

### OpenMP and CUDA Integration

```c
// parallel_frameworks.c - OpenMP and parallel processing examples
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <time.h>
#include <omp.h>
#include <immintrin.h>

// Matrix operations with OpenMP
typedef struct {
    double *data;
    int rows;
    int cols;
} matrix_t;

// Create matrix
matrix_t* matrix_create(int rows, int cols) {
    matrix_t *matrix = malloc(sizeof(matrix_t));
    if (!matrix) return NULL;
    
    matrix->data = aligned_alloc(32, rows * cols * sizeof(double));
    if (!matrix->data) {
        free(matrix);
        return NULL;
    }
    
    matrix->rows = rows;
    matrix->cols = cols;
    
    return matrix;
}

// Initialize matrix with random values
void matrix_random_init(matrix_t *matrix) {
    #pragma omp parallel for
    for (int i = 0; i < matrix->rows * matrix->cols; i++) {
        matrix->data[i] = ((double)rand() / RAND_MAX) * 2.0 - 1.0;
    }
}

// Matrix multiplication with OpenMP
matrix_t* matrix_multiply_openmp(const matrix_t *a, const matrix_t *b) {
    if (a->cols != b->rows) {
        return NULL;
    }
    
    matrix_t *result = matrix_create(a->rows, b->cols);
    if (!result) return NULL;
    
    #pragma omp parallel for collapse(2) schedule(dynamic)
    for (int i = 0; i < a->rows; i++) {
        for (int j = 0; j < b->cols; j++) {
            double sum = 0.0;
            
            #pragma omp simd reduction(+:sum)
            for (int k = 0; k < a->cols; k++) {
                sum += a->data[i * a->cols + k] * b->data[k * b->cols + j];
            }
            
            result->data[i * result->cols + j] = sum;
        }
    }
    
    return result;
}

// Optimized matrix multiplication with blocking and vectorization
matrix_t* matrix_multiply_optimized(const matrix_t *a, const matrix_t *b) {
    if (a->cols != b->rows) {
        return NULL;
    }
    
    matrix_t *result = matrix_create(a->rows, b->cols);
    if (!result) return NULL;
    
    // Initialize result to zero
    memset(result->data, 0, result->rows * result->cols * sizeof(double));
    
    const int block_size = 64;
    
    #pragma omp parallel for collapse(2) schedule(dynamic)
    for (int ii = 0; ii < a->rows; ii += block_size) {
        for (int jj = 0; jj < b->cols; jj += block_size) {
            for (int kk = 0; kk < a->cols; kk += block_size) {
                
                int i_max = (ii + block_size < a->rows) ? ii + block_size : a->rows;
                int j_max = (jj + block_size < b->cols) ? jj + block_size : b->cols;
                int k_max = (kk + block_size < a->cols) ? kk + block_size : a->cols;
                
                for (int i = ii; i < i_max; i++) {
                    for (int j = jj; j < j_max; j += 4) {
                        __m256d sum = _mm256_setzero_pd();
                        
                        for (int k = kk; k < k_max; k++) {
                            __m256d a_vec = _mm256_broadcast_sd(&a->data[i * a->cols + k]);
                            __m256d b_vec = _mm256_load_pd(&b->data[k * b->cols + j]);
                            sum = _mm256_fmadd_pd(a_vec, b_vec, sum);
                        }
                        
                        __m256d old_result = _mm256_load_pd(&result->data[i * result->cols + j]);
                        __m256d new_result = _mm256_add_pd(old_result, sum);
                        _mm256_store_pd(&result->data[i * result->cols + j], new_result);
                    }
                }
            }
        }
    }
    
    return result;
}

// Parallel algorithms demonstration
void parallel_algorithms_demo(void) {
    printf("=== Parallel Algorithms Demonstration ===\n");
    
    const int array_size = 10000000;
    double *array = malloc(array_size * sizeof(double));
    
    // Initialize array
    #pragma omp parallel for
    for (int i = 0; i < array_size; i++) {
        array[i] = sin(i * 0.001) + cos(i * 0.002);
    }
    
    printf("Array size: %d elements\n", array_size);
    printf("Number of threads: %d\n", omp_get_max_threads());
    
    // Parallel reduction - sum
    double start_time = omp_get_wtime();
    double sum = 0.0;
    
    #pragma omp parallel for reduction(+:sum)
    for (int i = 0; i < array_size; i++) {
        sum += array[i];
    }
    
    double end_time = omp_get_wtime();
    
    printf("Parallel sum: %f (time: %.3f ms)\n", 
           sum, (end_time - start_time) * 1000);
    
    // Parallel scan (prefix sum)
    double *prefix_sum = malloc(array_size * sizeof(double));
    
    start_time = omp_get_wtime();
    
    // Two-phase parallel scan
    const int num_threads = omp_get_max_threads();
    double *thread_sums = calloc(num_threads, sizeof(double));
    
    // Phase 1: Local scan within each thread
    #pragma omp parallel
    {
        int tid = omp_get_thread_num();
        int chunk_size = array_size / num_threads;
        int start = tid * chunk_size;
        int end = (tid == num_threads - 1) ? array_size : start + chunk_size;
        
        if (start < end) {
            prefix_sum[start] = array[start];
            for (int i = start + 1; i < end; i++) {
                prefix_sum[i] = prefix_sum[i-1] + array[i];
            }
            thread_sums[tid] = prefix_sum[end-1];
        }
    }
    
    // Phase 2: Compute thread offsets
    for (int i = 1; i < num_threads; i++) {
        thread_sums[i] += thread_sums[i-1];
    }
    
    // Phase 3: Add offsets to local results
    #pragma omp parallel
    {
        int tid = omp_get_thread_num();
        if (tid > 0) {
            int chunk_size = array_size / num_threads;
            int start = tid * chunk_size;
            int end = (tid == num_threads - 1) ? array_size : start + chunk_size;
            
            for (int i = start; i < end; i++) {
                prefix_sum[i] += thread_sums[tid-1];
            }
        }
    }
    
    end_time = omp_get_wtime();
    
    printf("Parallel prefix sum completed (time: %.3f ms)\n", 
           (end_time - start_time) * 1000);
    
    // Parallel sort (merge sort)
    start_time = omp_get_wtime();
    
    // Create copy for sorting
    double *sort_array = malloc(array_size * sizeof(double));
    memcpy(sort_array, array, array_size * sizeof(double));
    
    // Parallel merge sort implementation
    void parallel_merge_sort(double *arr, double *temp, int left, int right, int depth) {
        if (left >= right) return;
        
        int mid = (left + right) / 2;
        
        if (depth > 0 && right - left > 1000) {
            #pragma omp task
            parallel_merge_sort(arr, temp, left, mid, depth - 1);
            
            #pragma omp task
            parallel_merge_sort(arr, temp, mid + 1, right, depth - 1);
            
            #pragma omp taskwait
        } else {
            parallel_merge_sort(arr, temp, left, mid, 0);
            parallel_merge_sort(arr, temp, mid + 1, right, 0);
        }
        
        // Merge
        int i = left, j = mid + 1, k = left;
        
        while (i <= mid && j <= right) {
            if (arr[i] <= arr[j]) {
                temp[k++] = arr[i++];
            } else {
                temp[k++] = arr[j++];
            }
        }
        
        while (i <= mid) temp[k++] = arr[i++];
        while (j <= right) temp[k++] = arr[j++];
        
        for (int idx = left; idx <= right; idx++) {
            arr[idx] = temp[idx];
        }
    }
    
    double *temp_array = malloc(array_size * sizeof(double));
    
    #pragma omp parallel
    {
        #pragma omp single
        {
            int max_depth = log2(omp_get_max_threads());
            parallel_merge_sort(sort_array, temp_array, 0, array_size - 1, max_depth);
        }
    }
    
    end_time = omp_get_wtime();
    
    printf("Parallel merge sort completed (time: %.3f ms)\n", 
           (end_time - start_time) * 1000);
    
    // Verify sort
    bool sorted = true;
    for (int i = 1; i < array_size && sorted; i++) {
        if (sort_array[i] < sort_array[i-1]) {
            sorted = false;
        }
    }
    printf("Sort verification: %s\n", sorted ? "PASSED" : "FAILED");
    
    // Cleanup
    free(array);
    free(prefix_sum);
    free(sort_array);
    free(temp_array);
    free(thread_sums);
}

// Matrix benchmark
void matrix_benchmark(void) {
    printf("\n=== Matrix Multiplication Benchmark ===\n");
    
    const int sizes[] = {256, 512, 1024};
    const int num_sizes = sizeof(sizes) / sizeof(sizes[0]);
    
    for (int s = 0; s < num_sizes; s++) {
        int size = sizes[s];
        printf("\nMatrix size: %dx%d\n", size, size);
        
        matrix_t *a = matrix_create(size, size);
        matrix_t *b = matrix_create(size, size);
        
        matrix_random_init(a);
        matrix_random_init(b);
        
        // Standard OpenMP multiplication
        double start_time = omp_get_wtime();
        matrix_t *result1 = matrix_multiply_openmp(a, b);
        double openmp_time = omp_get_wtime() - start_time;
        
        // Optimized multiplication
        start_time = omp_get_wtime();
        matrix_t *result2 = matrix_multiply_optimized(a, b);
        double optimized_time = omp_get_wtime() - start_time;
        
        // Calculate GFLOPS
        double operations = 2.0 * size * size * size;
        double openmp_gflops = operations / (openmp_time * 1e9);
        double optimized_gflops = operations / (optimized_time * 1e9);
        
        printf("  OpenMP:    %.3f seconds (%.2f GFLOPS)\n", openmp_time, openmp_gflops);
        printf("  Optimized: %.3f seconds (%.2f GFLOPS)\n", optimized_time, optimized_gflops);
        printf("  Speedup:   %.2fx\n", openmp_time / optimized_time);
        
        // Cleanup
        free(a->data); free(a);
        free(b->data); free(b);
        free(result1->data); free(result1);
        free(result2->data); free(result2);
    }
}

// OpenMP features demonstration
void openmp_features_demo(void) {
    printf("\n=== OpenMP Features Demonstration ===\n");
    
    // Task parallelism
    printf("Task parallelism (Fibonacci):\n");
    
    long fibonacci(int n) {
        if (n < 2) return n;
        
        if (n < 20) {
            return fibonacci(n-1) + fibonacci(n-2);
        }
        
        long x, y;
        
        #pragma omp task shared(x)
        x = fibonacci(n-1);
        
        #pragma omp task shared(y)
        y = fibonacci(n-2);
        
        #pragma omp taskwait
        
        return x + y;
    }
    
    double start_time = omp_get_wtime();
    long result;
    
    #pragma omp parallel
    {
        #pragma omp single
        {
            result = fibonacci(40);
        }
    }
    
    double end_time = omp_get_wtime();
    
    printf("  Fibonacci(40) = %ld (time: %.3f seconds)\n", 
           result, end_time - start_time);
    
    // Worksharing constructs
    printf("\nWorksharing constructs:\n");
    
    const int n = 1000;
    int *array = malloc(n * sizeof(int));
    
    // Parallel sections
    #pragma omp parallel sections
    {
        #pragma omp section
        {
            printf("  Section 1: Initializing first half\n");
            for (int i = 0; i < n/2; i++) {
                array[i] = i * i;
            }
        }
        
        #pragma omp section
        {
            printf("  Section 2: Initializing second half\n");
            for (int i = n/2; i < n; i++) {
                array[i] = i * i;
            }
        }
    }
    
    // Data environment
    printf("\nData environment:\n");
    
    int shared_var = 0;
    int private_var = 10;
    
    #pragma omp parallel firstprivate(private_var) shared(shared_var) num_threads(4)
    {
        int tid = omp_get_thread_num();
        private_var += tid;
        
        #pragma omp atomic
        shared_var += private_var;
        
        #pragma omp critical
        {
            printf("  Thread %d: private_var = %d\n", tid, private_var);
        }
    }
    
    printf("  Final shared_var = %d\n", shared_var);
    
    free(array);
}

int main(void) {
    srand(time(NULL));
    
    printf("OpenMP version: %d\n", _OPENMP);
    printf("Max threads: %d\n\n", omp_get_max_threads());
    
    parallel_algorithms_demo();
    matrix_benchmark();
    openmp_features_demo();
    
    return 0;
}
```

## Best Practices

1. **Thread Safety**: Design data structures and algorithms to be thread-safe from the ground up
2. **Memory Management**: Use hazard pointers or RCU for safe memory reclamation in lock-free code
3. **Load Balancing**: Implement work-stealing and dynamic load balancing for optimal performance
4. **NUMA Awareness**: Consider NUMA topology when designing parallel algorithms
5. **Profiling**: Use tools like Intel VTune or perf to identify concurrency bottlenecks

## Conclusion

Advanced concurrency and parallel programming requires deep understanding of hardware architecture, memory models, and synchronization techniques. From sophisticated thread pools and lock-free algorithms to parallel processing frameworks, these techniques enable building high-performance concurrent applications.

The future of parallel programming lies in heterogeneous computing, combining CPUs, GPUs, and specialized accelerators. By mastering these advanced concurrency techniques, developers can build applications that fully utilize modern computing resources and scale effectively across diverse hardware platforms.