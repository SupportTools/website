---
title: "Advanced IPC Mechanisms: Shared Memory and Message Queues for High-Performance Enterprise Systems"
date: 2026-04-07T00:00:00-05:00
draft: false
tags: ["IPC", "Shared Memory", "Message Queues", "Systems Programming", "Performance", "Enterprise", "POSIX"]
categories:
- Systems Programming
- Inter-Process Communication
- Performance Optimization
- Enterprise Systems
author: "Matthew Mattox - mmattox@support.tools"
description: "Master advanced inter-process communication techniques using shared memory, message queues, and lock-free algorithms. Learn POSIX IPC, System V IPC, and custom high-performance communication protocols for enterprise applications."
more_link: "yes"
url: "/advanced-ipc-mechanisms-shared-memory-message-queues/"
---

Inter-process communication (IPC) is fundamental to building scalable enterprise systems. This comprehensive guide explores advanced IPC mechanisms, from high-performance shared memory implementations to sophisticated message queue architectures, enabling efficient communication between distributed system components.

<!--more-->

# [Advanced Shared Memory Programming](#shared-memory-programming)

## Section 1: High-Performance Shared Memory Architecture

Shared memory provides the fastest form of IPC by allowing multiple processes to access the same memory region directly, eliminating data copying overhead.

### Production-Grade Shared Memory Implementation

```c
// shared_memory.c - Advanced shared memory management system
#include <sys/mman.h>
#include <sys/shm.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <semaphore.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <stdint.h>
#include <stdbool.h>
#include <pthread.h>
#include <signal.h>
#include <time.h>

#define SHM_NAME_MAX 256
#define SHM_MAGIC 0xDEADBEEF
#define MAX_READERS 64
#define CACHE_LINE_SIZE 64

// Shared memory region header
struct shm_header {
    uint32_t magic;
    uint32_t version;
    size_t total_size;
    size_t data_size;
    pid_t creator_pid;
    time_t creation_time;
    
    // Reader-writer synchronization
    pthread_rwlock_t rwlock;
    pthread_rwlockattr_t rwlock_attr;
    
    // Statistics
    uint64_t read_count;
    uint64_t write_count;
    uint64_t reader_count;
    pid_t active_readers[MAX_READERS];
    
    // Data follows this header
    char data[0];
} __attribute__((aligned(CACHE_LINE_SIZE)));

// Shared memory control structure
struct shm_control {
    int fd;
    void *addr;
    size_t size;
    char name[SHM_NAME_MAX];
    struct shm_header *header;
    bool is_creator;
    bool is_mapped;
};

// Create shared memory region
struct shm_control *shm_create(const char *name, size_t data_size)
{
    struct shm_control *shm;
    size_t total_size;
    int fd;
    
    if (!name || data_size == 0) {
        errno = EINVAL;
        return NULL;
    }
    
    shm = calloc(1, sizeof(*shm));
    if (!shm) {
        return NULL;
    }
    
    // Calculate total size including header
    total_size = sizeof(struct shm_header) + data_size;
    total_size = (total_size + 4095) & ~4095;  // Page-align
    
    strncpy(shm->name, name, sizeof(shm->name) - 1);
    shm->size = total_size;
    
    // Create shared memory object
    fd = shm_open(name, O_CREAT | O_EXCL | O_RDWR, 0666);
    if (fd == -1) {
        if (errno == EEXIST) {
            // Try to open existing
            fd = shm_open(name, O_RDWR, 0666);
            if (fd == -1) {
                free(shm);
                return NULL;
            }
            shm->is_creator = false;
        } else {
            free(shm);
            return NULL;
        }
    } else {
        shm->is_creator = true;
        
        // Set size for new shared memory
        if (ftruncate(fd, total_size) == -1) {
            close(fd);
            shm_unlink(name);
            free(shm);
            return NULL;
        }
    }
    
    shm->fd = fd;
    
    // Map shared memory
    shm->addr = mmap(NULL, total_size, PROT_READ | PROT_WRITE, 
                     MAP_SHARED, fd, 0);
    if (shm->addr == MAP_FAILED) {
        close(fd);
        if (shm->is_creator) {
            shm_unlink(name);
        }
        free(shm);
        return NULL;
    }
    
    shm->header = (struct shm_header *)shm->addr;
    shm->is_mapped = true;
    
    // Initialize header if creator
    if (shm->is_creator) {
        memset(shm->header, 0, sizeof(*shm->header));
        shm->header->magic = SHM_MAGIC;
        shm->header->version = 1;
        shm->header->total_size = total_size;
        shm->header->data_size = data_size;
        shm->header->creator_pid = getpid();
        shm->header->creation_time = time(NULL);
        
        // Initialize rwlock with process-shared attribute
        pthread_rwlockattr_init(&shm->header->rwlock_attr);
        pthread_rwlockattr_setpshared(&shm->header->rwlock_attr, 
                                     PTHREAD_PROCESS_SHARED);
        pthread_rwlock_init(&shm->header->rwlock, &shm->header->rwlock_attr);
        
        // Ensure data is written to memory
        msync(shm->addr, sizeof(*shm->header), MS_SYNC);
    } else {
        // Validate existing shared memory
        if (shm->header->magic != SHM_MAGIC) {
            munmap(shm->addr, total_size);
            close(fd);
            free(shm);
            errno = EINVAL;
            return NULL;
        }
    }
    
    return shm;
}

// Attach to existing shared memory
struct shm_control *shm_attach(const char *name)
{
    struct shm_control *shm;
    struct stat sb;
    int fd;
    
    if (!name) {
        errno = EINVAL;
        return NULL;
    }
    
    shm = calloc(1, sizeof(*shm));
    if (!shm) {
        return NULL;
    }
    
    strncpy(shm->name, name, sizeof(shm->name) - 1);
    
    // Open existing shared memory
    fd = shm_open(name, O_RDWR, 0);
    if (fd == -1) {
        free(shm);
        return NULL;
    }
    
    // Get size
    if (fstat(fd, &sb) == -1) {
        close(fd);
        free(shm);
        return NULL;
    }
    
    shm->fd = fd;
    shm->size = sb.st_size;
    shm->is_creator = false;
    
    // Map shared memory
    shm->addr = mmap(NULL, shm->size, PROT_READ | PROT_WRITE,
                     MAP_SHARED, fd, 0);
    if (shm->addr == MAP_FAILED) {
        close(fd);
        free(shm);
        return NULL;
    }
    
    shm->header = (struct shm_header *)shm->addr;
    shm->is_mapped = true;
    
    // Validate shared memory
    if (shm->header->magic != SHM_MAGIC) {
        munmap(shm->addr, shm->size);
        close(fd);
        free(shm);
        errno = EINVAL;
        return NULL;
    }
    
    return shm;
}

// Read data from shared memory with reader-writer synchronization
ssize_t shm_read(struct shm_control *shm, void *buf, size_t count, off_t offset)
{
    ssize_t bytes_read;
    pid_t pid = getpid();
    int reader_slot = -1;
    
    if (!shm || !buf || !shm->is_mapped) {
        errno = EINVAL;
        return -1;
    }
    
    if (offset + count > shm->header->data_size) {
        errno = EINVAL;
        return -1;
    }
    
    // Acquire read lock
    if (pthread_rwlock_rdlock(&shm->header->rwlock) != 0) {
        return -1;
    }
    
    // Find available reader slot
    for (int i = 0; i < MAX_READERS; i++) {
        if (__atomic_compare_exchange_n(&shm->header->active_readers[i], 
                                       &(pid_t){0}, pid, false,
                                       __ATOMIC_ACQUIRE, __ATOMIC_RELAXED)) {
            reader_slot = i;
            break;
        }
    }
    
    // Update statistics
    __atomic_fetch_add(&shm->header->read_count, 1, __ATOMIC_RELAXED);
    __atomic_fetch_add(&shm->header->reader_count, 1, __ATOMIC_ACQUIRE);
    
    // Copy data
    memcpy(buf, shm->header->data + offset, count);
    bytes_read = count;
    
    // Release reader slot
    if (reader_slot >= 0) {
        __atomic_store_n(&shm->header->active_readers[reader_slot], 0, 
                         __ATOMIC_RELEASE);
    }
    
    __atomic_fetch_sub(&shm->header->reader_count, 1, __ATOMIC_RELEASE);
    
    // Release read lock
    pthread_rwlock_unlock(&shm->header->rwlock);
    
    return bytes_read;
}

// Write data to shared memory with synchronization
ssize_t shm_write(struct shm_control *shm, const void *buf, size_t count, off_t offset)
{
    ssize_t bytes_written;
    
    if (!shm || !buf || !shm->is_mapped) {
        errno = EINVAL;
        return -1;
    }
    
    if (offset + count > shm->header->data_size) {
        errno = EINVAL;
        return -1;
    }
    
    // Acquire write lock
    if (pthread_rwlock_wrlock(&shm->header->rwlock) != 0) {
        return -1;
    }
    
    // Update statistics
    __atomic_fetch_add(&shm->header->write_count, 1, __ATOMIC_RELAXED);
    
    // Copy data
    memcpy(shm->header->data + offset, buf, count);
    bytes_written = count;
    
    // Ensure data is written to memory
    msync(shm->header->data + offset, count, MS_ASYNC);
    
    // Release write lock
    pthread_rwlock_unlock(&shm->header->rwlock);
    
    return bytes_written;
}

// Get pointer to shared data for zero-copy access
void *shm_get_data_ptr(struct shm_control *shm)
{
    if (!shm || !shm->is_mapped) {
        return NULL;
    }
    
    return shm->header->data;
}

// Lock shared memory for exclusive access
int shm_lock_exclusive(struct shm_control *shm)
{
    if (!shm || !shm->is_mapped) {
        return -1;
    }
    
    return pthread_rwlock_wrlock(&shm->header->rwlock);
}

// Lock shared memory for shared access
int shm_lock_shared(struct shm_control *shm)
{
    if (!shm || !shm->is_mapped) {
        return -1;
    }
    
    return pthread_rwlock_rdlock(&shm->header->rwlock);
}

// Unlock shared memory
int shm_unlock(struct shm_control *shm)
{
    if (!shm || !shm->is_mapped) {
        return -1;
    }
    
    return pthread_rwlock_unlock(&shm->header->rwlock);
}

// Get shared memory statistics
void shm_get_stats(struct shm_control *shm, struct shm_stats *stats)
{
    if (!shm || !stats || !shm->is_mapped) {
        return;
    }
    
    stats->total_size = shm->header->total_size;
    stats->data_size = shm->header->data_size;
    stats->read_count = __atomic_load_n(&shm->header->read_count, __ATOMIC_RELAXED);
    stats->write_count = __atomic_load_n(&shm->header->write_count, __ATOMIC_RELAXED);
    stats->reader_count = __atomic_load_n(&shm->header->reader_count, __ATOMIC_ACQUIRE);
    stats->creator_pid = shm->header->creator_pid;
    stats->creation_time = shm->header->creation_time;
}

// Cleanup shared memory
void shm_destroy(struct shm_control *shm)
{
    if (!shm) {
        return;
    }
    
    if (shm->is_mapped) {
        munmap(shm->addr, shm->size);
    }
    
    if (shm->fd >= 0) {
        close(shm->fd);
    }
    
    if (shm->is_creator) {
        shm_unlink(shm->name);
    }
    
    free(shm);
}
```

## Section 2: Lock-Free Ring Buffer for Shared Memory

Lock-free data structures in shared memory enable high-performance communication without blocking synchronization.

### High-Performance Lock-Free Ring Buffer

```c
// lockfree_ringbuffer.c - Lock-free ring buffer for shared memory IPC
#include <stdatomic.h>
#include <stdint.h>
#include <stdbool.h>
#include <string.h>

#define RING_BUFFER_MAGIC 0xFEEDFACE

// Lock-free ring buffer structure
struct lockfree_ringbuffer {
    uint32_t magic;
    size_t capacity;
    size_t mask;  // capacity - 1 (for power-of-2 sizes)
    
    // Cache-aligned atomic variables
    struct {
        atomic_size_t head;
        char padding1[CACHE_LINE_SIZE - sizeof(atomic_size_t)];
    };
    
    struct {
        atomic_size_t tail;
        char padding2[CACHE_LINE_SIZE - sizeof(atomic_size_t)];
    };
    
    // Statistics
    atomic_uint64_t enqueue_count;
    atomic_uint64_t dequeue_count;
    atomic_uint64_t enqueue_failures;
    atomic_uint64_t dequeue_failures;
    
    // Data buffer follows
    char data[0];
} __attribute__((aligned(CACHE_LINE_SIZE)));

// Message header for variable-length messages
struct message_header {
    uint32_t magic;
    uint32_t size;
    uint64_t sequence;
    uint64_t timestamp;
} __attribute__((packed));

#define MESSAGE_MAGIC 0xCAFEBABE

// Initialize ring buffer
int ringbuf_init(struct lockfree_ringbuffer *rb, size_t capacity)
{
    if (!rb || capacity == 0 || (capacity & (capacity - 1)) != 0) {
        return -1;  // Capacity must be power of 2
    }
    
    rb->magic = RING_BUFFER_MAGIC;
    rb->capacity = capacity;
    rb->mask = capacity - 1;
    
    atomic_init(&rb->head, 0);
    atomic_init(&rb->tail, 0);
    atomic_init(&rb->enqueue_count, 0);
    atomic_init(&rb->dequeue_count, 0);
    atomic_init(&rb->enqueue_failures, 0);
    atomic_init(&rb->dequeue_failures, 0);
    
    return 0;
}

// Calculate total size needed for ring buffer
size_t ringbuf_size(size_t capacity)
{
    return sizeof(struct lockfree_ringbuffer) + capacity;
}

// Enqueue data (producer)
int ringbuf_enqueue(struct lockfree_ringbuffer *rb, const void *data, size_t size)
{
    if (!rb || !data || size == 0 || rb->magic != RING_BUFFER_MAGIC) {
        return -1;
    }
    
    struct message_header header = {
        .magic = MESSAGE_MAGIC,
        .size = size,
        .sequence = atomic_load(&rb->enqueue_count),
        .timestamp = get_time_ns()
    };
    
    size_t total_size = sizeof(header) + size;
    size_t current_head = atomic_load_explicit(&rb->head, memory_order_relaxed);
    size_t current_tail = atomic_load_explicit(&rb->tail, memory_order_acquire);
    
    // Check if there's enough space
    size_t available = rb->capacity - (current_head - current_tail);
    if (available < total_size) {
        atomic_fetch_add(&rb->enqueue_failures, 1);
        return -1;  // Buffer full
    }
    
    // Write header
    size_t pos = current_head & rb->mask;
    if (pos + sizeof(header) <= rb->capacity) {
        memcpy(&rb->data[pos], &header, sizeof(header));
    } else {
        // Wrap around
        size_t first_part = rb->capacity - pos;
        memcpy(&rb->data[pos], &header, first_part);
        memcpy(&rb->data[0], (char *)&header + first_part, sizeof(header) - first_part);
    }
    
    // Write data
    pos = (current_head + sizeof(header)) & rb->mask;
    if (pos + size <= rb->capacity) {
        memcpy(&rb->data[pos], data, size);
    } else {
        // Wrap around
        size_t first_part = rb->capacity - pos;
        memcpy(&rb->data[pos], data, first_part);
        memcpy(&rb->data[0], (char *)data + first_part, size - first_part);
    }
    
    // Update head pointer
    atomic_store_explicit(&rb->head, current_head + total_size, memory_order_release);
    atomic_fetch_add(&rb->enqueue_count, 1);
    
    return 0;
}

// Dequeue data (consumer)
int ringbuf_dequeue(struct lockfree_ringbuffer *rb, void *data, size_t *size)
{
    if (!rb || !data || !size || rb->magic != RING_BUFFER_MAGIC) {
        return -1;
    }
    
    size_t current_tail = atomic_load_explicit(&rb->tail, memory_order_relaxed);
    size_t current_head = atomic_load_explicit(&rb->head, memory_order_acquire);
    
    // Check if data is available
    if (current_tail == current_head) {
        atomic_fetch_add(&rb->dequeue_failures, 1);
        return -1;  // Buffer empty
    }
    
    // Read message header
    struct message_header header;
    size_t pos = current_tail & rb->mask;
    
    if (pos + sizeof(header) <= rb->capacity) {
        memcpy(&header, &rb->data[pos], sizeof(header));
    } else {
        // Wrap around
        size_t first_part = rb->capacity - pos;
        memcpy(&header, &rb->data[pos], first_part);
        memcpy((char *)&header + first_part, &rb->data[0], sizeof(header) - first_part);
    }
    
    // Validate header
    if (header.magic != MESSAGE_MAGIC) {
        atomic_fetch_add(&rb->dequeue_failures, 1);
        return -1;  // Corrupted data
    }
    
    // Check if caller's buffer is large enough
    if (*size < header.size) {
        *size = header.size;
        return -1;  // Buffer too small
    }
    
    // Read data
    pos = (current_tail + sizeof(header)) & rb->mask;
    if (pos + header.size <= rb->capacity) {
        memcpy(data, &rb->data[pos], header.size);
    } else {
        // Wrap around
        size_t first_part = rb->capacity - pos;
        memcpy(data, &rb->data[pos], first_part);
        memcpy((char *)data + first_part, &rb->data[0], header.size - first_part);
    }
    
    *size = header.size;
    
    // Update tail pointer
    size_t total_size = sizeof(header) + header.size;
    atomic_store_explicit(&rb->tail, current_tail + total_size, memory_order_release);
    atomic_fetch_add(&rb->dequeue_count, 1);
    
    return 0;
}

// Peek at next message without removing it
int ringbuf_peek(struct lockfree_ringbuffer *rb, void *data, size_t *size)
{
    if (!rb || !data || !size || rb->magic != RING_BUFFER_MAGIC) {
        return -1;
    }
    
    size_t current_tail = atomic_load_explicit(&rb->tail, memory_order_relaxed);
    size_t current_head = atomic_load_explicit(&rb->head, memory_order_acquire);
    
    // Check if data is available
    if (current_tail == current_head) {
        return -1;  // Buffer empty
    }
    
    // Read message header
    struct message_header header;
    size_t pos = current_tail & rb->mask;
    
    if (pos + sizeof(header) <= rb->capacity) {
        memcpy(&header, &rb->data[pos], sizeof(header));
    } else {
        // Wrap around
        size_t first_part = rb->capacity - pos;
        memcpy(&header, &rb->data[pos], first_part);
        memcpy((char *)&header + first_part, &rb->data[0], sizeof(header) - first_part);
    }
    
    // Validate header
    if (header.magic != MESSAGE_MAGIC) {
        return -1;  // Corrupted data
    }
    
    // Check if caller's buffer is large enough
    if (*size < header.size) {
        *size = header.size;
        return -1;  // Buffer too small
    }
    
    // Read data
    pos = (current_tail + sizeof(header)) & rb->mask;
    if (pos + header.size <= rb->capacity) {
        memcpy(data, &rb->data[pos], header.size);
    } else {
        // Wrap around
        size_t first_part = rb->capacity - pos;
        memcpy(data, &rb->data[pos], first_part);
        memcpy((char *)data + first_part, &rb->data[0], header.size - first_part);
    }
    
    *size = header.size;
    return 0;
}

// Get ring buffer statistics
void ringbuf_stats(struct lockfree_ringbuffer *rb, struct ringbuf_stats *stats)
{
    if (!rb || !stats || rb->magic != RING_BUFFER_MAGIC) {
        return;
    }
    
    size_t head = atomic_load(&rb->head);
    size_t tail = atomic_load(&rb->tail);
    
    stats->capacity = rb->capacity;
    stats->used_bytes = head - tail;
    stats->free_bytes = rb->capacity - stats->used_bytes;
    stats->enqueue_count = atomic_load(&rb->enqueue_count);
    stats->dequeue_count = atomic_load(&rb->dequeue_count);
    stats->enqueue_failures = atomic_load(&rb->enqueue_failures);
    stats->dequeue_failures = atomic_load(&rb->dequeue_failures);
}

// Check if ring buffer is empty
bool ringbuf_is_empty(struct lockfree_ringbuffer *rb)
{
    if (!rb || rb->magic != RING_BUFFER_MAGIC) {
        return true;
    }
    
    size_t head = atomic_load_explicit(&rb->head, memory_order_acquire);
    size_t tail = atomic_load_explicit(&rb->tail, memory_order_relaxed);
    
    return head == tail;
}

// Check if ring buffer is full
bool ringbuf_is_full(struct lockfree_ringbuffer *rb)
{
    if (!rb || rb->magic != RING_BUFFER_MAGIC) {
        return true;
    }
    
    size_t head = atomic_load_explicit(&rb->head, memory_order_relaxed);
    size_t tail = atomic_load_explicit(&rb->tail, memory_order_acquire);
    
    return (head - tail) >= rb->capacity;
}
```

# [Advanced Message Queue Systems](#message-queue-systems)

## Section 3: POSIX Message Queues with Priority Handling

POSIX message queues provide reliable, priority-based message delivery between processes with built-in blocking and non-blocking semantics.

### Enterprise Message Queue Implementation

```c
// message_queue.c - Advanced POSIX message queue wrapper
#include <mqueue.h>
#include <sys/stat.h>
#include <fcntl.h>

#define MQ_NAME_MAX 256
#define MQ_DEFAULT_MAXMSG 100
#define MQ_DEFAULT_MSGSIZE 8192

// Message queue configuration
struct mq_config {
    char name[MQ_NAME_MAX];
    long maxmsg;
    long msgsize;
    int flags;  // O_CREAT, O_EXCL, O_RDONLY, O_WRONLY, O_RDWR, O_NONBLOCK
    mode_t mode;
};

// Message queue control structure
struct mq_control {
    mqd_t mqd;
    struct mq_config config;
    struct mq_attr attr;
    bool is_creator;
    
    // Statistics
    uint64_t sent_count;
    uint64_t received_count;
    uint64_t send_errors;
    uint64_t receive_errors;
    
    // Timeouts
    struct timespec send_timeout;
    struct timespec receive_timeout;
};

// Create or open message queue
struct mq_control *mq_create(const struct mq_config *config)
{
    struct mq_control *mq;
    struct mq_attr attr;
    
    if (!config || !config->name[0]) {
        errno = EINVAL;
        return NULL;
    }
    
    mq = calloc(1, sizeof(*mq));
    if (!mq) {
        return NULL;
    }
    
    // Copy configuration
    mq->config = *config;
    
    // Set default values if not specified
    if (mq->config.maxmsg <= 0) {
        mq->config.maxmsg = MQ_DEFAULT_MAXMSG;
    }
    if (mq->config.msgsize <= 0) {
        mq->config.msgsize = MQ_DEFAULT_MSGSIZE;
    }
    if (mq->config.mode == 0) {
        mq->config.mode = 0666;
    }
    
    // Set up attributes
    attr.mq_flags = 0;
    attr.mq_maxmsg = mq->config.maxmsg;
    attr.mq_msgsize = mq->config.msgsize;
    attr.mq_curmsgs = 0;
    
    // Try to create the message queue
    mq->mqd = mq_open(mq->config.name, mq->config.flags | O_CREAT | O_EXCL,
                      mq->config.mode, &attr);
    
    if (mq->mqd == (mqd_t)-1) {
        if (errno == EEXIST && !(mq->config.flags & O_EXCL)) {
            // Queue exists, try to open it
            mq->mqd = mq_open(mq->config.name, mq->config.flags & ~O_CREAT,
                             mq->config.mode, NULL);
            if (mq->mqd == (mqd_t)-1) {
                free(mq);
                return NULL;
            }
            mq->is_creator = false;
        } else {
            free(mq);
            return NULL;
        }
    } else {
        mq->is_creator = true;
    }
    
    // Get actual attributes
    if (mq_getattr(mq->mqd, &mq->attr) == -1) {
        mq_close(mq->mqd);
        if (mq->is_creator) {
            mq_unlink(mq->config.name);
        }
        free(mq);
        return NULL;
    }
    
    // Set default timeouts (1 second)
    mq->send_timeout.tv_sec = 1;
    mq->send_timeout.tv_nsec = 0;
    mq->receive_timeout.tv_sec = 1;
    mq->receive_timeout.tv_nsec = 0;
    
    return mq;
}

// Send message with priority
int mq_send_msg(struct mq_control *mq, const void *msg, size_t len, 
                unsigned int priority)
{
    int ret;
    
    if (!mq || !msg || len > mq->attr.mq_msgsize) {
        errno = EINVAL;
        return -1;
    }
    
    ret = mq_send(mq->mqd, msg, len, priority);
    if (ret == 0) {
        mq->sent_count++;
    } else {
        mq->send_errors++;
    }
    
    return ret;
}

// Send message with timeout
int mq_send_msg_timed(struct mq_control *mq, const void *msg, size_t len,
                      unsigned int priority, const struct timespec *timeout)
{
    int ret;
    struct timespec abs_timeout;
    
    if (!mq || !msg || len > mq->attr.mq_msgsize) {
        errno = EINVAL;
        return -1;
    }
    
    // Calculate absolute timeout
    if (timeout) {
        clock_gettime(CLOCK_REALTIME, &abs_timeout);
        abs_timeout.tv_sec += timeout->tv_sec;
        abs_timeout.tv_nsec += timeout->tv_nsec;
        if (abs_timeout.tv_nsec >= 1000000000) {
            abs_timeout.tv_sec++;
            abs_timeout.tv_nsec -= 1000000000;
        }
    } else {
        clock_gettime(CLOCK_REALTIME, &abs_timeout);
        abs_timeout.tv_sec += mq->send_timeout.tv_sec;
        abs_timeout.tv_nsec += mq->send_timeout.tv_nsec;
        if (abs_timeout.tv_nsec >= 1000000000) {
            abs_timeout.tv_sec++;
            abs_timeout.tv_nsec -= 1000000000;
        }
    }
    
    ret = mq_timedsend(mq->mqd, msg, len, priority, &abs_timeout);
    if (ret == 0) {
        mq->sent_count++;
    } else {
        mq->send_errors++;
    }
    
    return ret;
}

// Receive message
ssize_t mq_receive_msg(struct mq_control *mq, void *msg, size_t len,
                       unsigned int *priority)
{
    ssize_t ret;
    
    if (!mq || !msg || len < mq->attr.mq_msgsize) {
        errno = EINVAL;
        return -1;
    }
    
    ret = mq_receive(mq->mqd, msg, len, priority);
    if (ret >= 0) {
        mq->received_count++;
    } else {
        mq->receive_errors++;
    }
    
    return ret;
}

// Receive message with timeout
ssize_t mq_receive_msg_timed(struct mq_control *mq, void *msg, size_t len,
                             unsigned int *priority, const struct timespec *timeout)
{
    ssize_t ret;
    struct timespec abs_timeout;
    
    if (!mq || !msg || len < mq->attr.mq_msgsize) {
        errno = EINVAL;
        return -1;
    }
    
    // Calculate absolute timeout
    if (timeout) {
        clock_gettime(CLOCK_REALTIME, &abs_timeout);
        abs_timeout.tv_sec += timeout->tv_sec;
        abs_timeout.tv_nsec += timeout->tv_nsec;
        if (abs_timeout.tv_nsec >= 1000000000) {
            abs_timeout.tv_sec++;
            abs_timeout.tv_nsec -= 1000000000;
        }
    } else {
        clock_gettime(CLOCK_REALTIME, &abs_timeout);
        abs_timeout.tv_sec += mq->receive_timeout.tv_sec;
        abs_timeout.tv_nsec += mq->receive_timeout.tv_nsec;
        if (abs_timeout.tv_nsec >= 1000000000) {
            abs_timeout.tv_sec++;
            abs_timeout.tv_nsec -= 1000000000;
        }
    }
    
    ret = mq_timedreceive(mq->mqd, msg, len, priority, &abs_timeout);
    if (ret >= 0) {
        mq->received_count++;
    } else {
        mq->receive_errors++;
    }
    
    return ret;
}

// Set message queue attributes
int mq_set_nonblock(struct mq_control *mq, bool nonblock)
{
    struct mq_attr attr;
    
    if (!mq) {
        errno = EINVAL;
        return -1;
    }
    
    attr = mq->attr;
    if (nonblock) {
        attr.mq_flags |= O_NONBLOCK;
    } else {
        attr.mq_flags &= ~O_NONBLOCK;
    }
    
    if (mq_setattr(mq->mqd, &attr, &mq->attr) == -1) {
        return -1;
    }
    
    return 0;
}

// Get message queue statistics
void mq_get_stats(struct mq_control *mq, struct mq_stats *stats)
{
    if (!mq || !stats) {
        return;
    }
    
    // Update current attributes
    mq_getattr(mq->mqd, &mq->attr);
    
    stats->maxmsg = mq->attr.mq_maxmsg;
    stats->msgsize = mq->attr.mq_msgsize;
    stats->curmsgs = mq->attr.mq_curmsgs;
    stats->sent_count = mq->sent_count;
    stats->received_count = mq->received_count;
    stats->send_errors = mq->send_errors;
    stats->receive_errors = mq->receive_errors;
}

// Cleanup message queue
void mq_destroy(struct mq_control *mq)
{
    if (!mq) {
        return;
    }
    
    if (mq->mqd != (mqd_t)-1) {
        mq_close(mq->mqd);
    }
    
    if (mq->is_creator) {
        mq_unlink(mq->config.name);
    }
    
    free(mq);
}
```

This comprehensive IPC guide demonstrates advanced techniques for building high-performance inter-process communication systems. The implementations cover shared memory with reader-writer synchronization, lock-free ring buffers, and sophisticated message queue architectures. These patterns enable efficient, scalable communication between enterprise system components while maintaining data integrity and optimal performance characteristics.