---
title: "Linux IPC Mastery: Pipes, FIFOs, Message Queues, and Shared Memory"
date: 2025-07-02T22:00:00-05:00
draft: false
tags: ["Linux", "IPC", "Pipes", "Shared Memory", "Message Queues", "Systems Programming", "POSIX"]
categories:
- Linux
- Systems Programming
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Linux Inter-Process Communication mechanisms, from simple pipes to high-performance shared memory, with practical examples and performance comparisons"
more_link: "yes"
url: "/linux-pipes-ipc-mastery/"
---

Inter-Process Communication (IPC) is fundamental to building complex Linux systems. Whether you're implementing a microservice architecture, building a high-performance daemon, or creating a simple shell pipeline, understanding the various IPC mechanisms and their trade-offs is crucial. This guide explores Linux IPC from basic pipes to advanced shared memory techniques.

<!--more-->

# [Linux IPC Mastery](#linux-ipc-mastery)

## The Evolution of IPC

Linux provides multiple IPC mechanisms, each with distinct characteristics:

- **Pipes**: Simple, unidirectional byte streams
- **FIFOs**: Named pipes accessible via filesystem
- **Message Queues**: Structured message passing
- **Shared Memory**: Direct memory sharing for maximum performance
- **Sockets**: Network-transparent communication
- **Signals**: Asynchronous notifications

## Pipes: The Foundation

### Anonymous Pipes

The simplest form of IPC, perfect for parent-child communication:

```c
#include <unistd.h>
#include <stdio.h>
#include <string.h>

void basic_pipe_example() {
    int pipefd[2];
    pid_t pid;
    char write_msg[] = "Hello from parent!";
    char read_msg[100];
    
    if (pipe(pipefd) == -1) {
        perror("pipe");
        return;
    }
    
    pid = fork();
    if (pid == 0) {
        // Child: close write end, read from pipe
        close(pipefd[1]);
        
        ssize_t n = read(pipefd[0], read_msg, sizeof(read_msg));
        if (n > 0) {
            read_msg[n] = '\0';
            printf("Child received: %s\n", read_msg);
        }
        
        close(pipefd[0]);
        exit(0);
    } else {
        // Parent: close read end, write to pipe
        close(pipefd[0]);
        
        write(pipefd[1], write_msg, strlen(write_msg));
        close(pipefd[1]);
        
        wait(NULL);
    }
}

// Bidirectional communication with two pipes
typedef struct {
    int parent_to_child[2];
    int child_to_parent[2];
} bidirectional_pipe_t;

void setup_bidirectional_pipes(bidirectional_pipe_t* pipes) {
    pipe(pipes->parent_to_child);
    pipe(pipes->child_to_parent);
}

void child_setup_pipes(bidirectional_pipe_t* pipes) {
    close(pipes->parent_to_child[1]);  // Close write end
    close(pipes->child_to_parent[0]);  // Close read end
    
    // Redirect stdin/stdout for transparent communication
    dup2(pipes->parent_to_child[0], STDIN_FILENO);
    dup2(pipes->child_to_parent[1], STDOUT_FILENO);
    
    close(pipes->parent_to_child[0]);
    close(pipes->child_to_parent[1]);
}

void parent_setup_pipes(bidirectional_pipe_t* pipes) {
    close(pipes->parent_to_child[0]);  // Close read end
    close(pipes->child_to_parent[1]);  // Close write end
}
```

### Advanced Pipe Techniques

```c
#include <fcntl.h>
#include <poll.h>

// Non-blocking pipe I/O
void nonblocking_pipe() {
    int pipefd[2];
    pipe2(pipefd, O_NONBLOCK | O_CLOEXEC);
    
    // Write without blocking
    const char* data = "Non-blocking write";
    ssize_t written = write(pipefd[1], data, strlen(data));
    if (written == -1 && errno == EAGAIN) {
        printf("Pipe buffer full\n");
    }
    
    // Read without blocking
    char buffer[1024];
    ssize_t n = read(pipefd[0], buffer, sizeof(buffer));
    if (n == -1 && errno == EAGAIN) {
        printf("No data available\n");
    }
}

// Multiplexed pipe reading
void multiplex_pipes() {
    int pipe1[2], pipe2[2], pipe3[2];
    pipe(pipe1);
    pipe(pipe2);
    pipe(pipe3);
    
    struct pollfd fds[3];
    fds[0].fd = pipe1[0];
    fds[0].events = POLLIN;
    fds[1].fd = pipe2[0];
    fds[1].events = POLLIN;
    fds[2].fd = pipe3[0];
    fds[2].events = POLLIN;
    
    // Fork children to write to pipes...
    
    while (1) {
        int ret = poll(fds, 3, 5000);  // 5 second timeout
        
        if (ret > 0) {
            for (int i = 0; i < 3; i++) {
                if (fds[i].revents & POLLIN) {
                    char buffer[256];
                    ssize_t n = read(fds[i].fd, buffer, sizeof(buffer));
                    if (n > 0) {
                        buffer[n] = '\0';
                        printf("Pipe %d: %s\n", i, buffer);
                    }
                }
                
                if (fds[i].revents & POLLHUP) {
                    printf("Pipe %d closed\n", i);
                    close(fds[i].fd);
                    fds[i].fd = -1;
                }
            }
        }
    }
}

// Splice for zero-copy pipe operations
void zero_copy_pipe_transfer() {
    int in_fd = open("/tmp/source.dat", O_RDONLY);
    int out_fd = open("/tmp/dest.dat", O_WRONLY | O_CREAT, 0644);
    int pipefd[2];
    pipe(pipefd);
    
    size_t total = 0;
    while (1) {
        // Move data from file to pipe
        ssize_t n = splice(in_fd, NULL, pipefd[1], NULL, 
                          65536, SPLICE_F_MOVE);
        if (n <= 0) break;
        
        // Move data from pipe to file
        splice(pipefd[0], NULL, out_fd, NULL, n, SPLICE_F_MOVE);
        total += n;
    }
    
    printf("Transferred %zu bytes with zero copies\n", total);
}
```

## Named Pipes (FIFOs)

### Creating and Using FIFOs

```c
#include <sys/stat.h>

// Server side - creates and reads from FIFO
void fifo_server() {
    const char* fifo_path = "/tmp/myfifo";
    
    // Create FIFO with permissions
    if (mkfifo(fifo_path, 0666) == -1 && errno != EEXIST) {
        perror("mkfifo");
        return;
    }
    
    printf("Server: waiting for clients...\n");
    
    while (1) {
        int fd = open(fifo_path, O_RDONLY);
        if (fd == -1) {
            perror("open");
            break;
        }
        
        char buffer[256];
        ssize_t n;
        while ((n = read(fd, buffer, sizeof(buffer))) > 0) {
            buffer[n] = '\0';
            printf("Server received: %s", buffer);
            
            // Process request...
        }
        
        close(fd);
    }
    
    unlink(fifo_path);
}

// Client side - writes to FIFO
void fifo_client(const char* message) {
    const char* fifo_path = "/tmp/myfifo";
    
    int fd = open(fifo_path, O_WRONLY);
    if (fd == -1) {
        perror("open");
        return;
    }
    
    write(fd, message, strlen(message));
    close(fd);
}

// Bidirectional FIFO communication
typedef struct {
    char request_fifo[256];
    char response_fifo[256];
    pid_t client_pid;
} fifo_connection_t;

void fifo_rpc_server() {
    const char* server_fifo = "/tmp/server_fifo";
    mkfifo(server_fifo, 0666);
    
    int server_fd = open(server_fifo, O_RDONLY);
    
    while (1) {
        fifo_connection_t conn;
        
        // Read connection request
        if (read(server_fd, &conn, sizeof(conn)) != sizeof(conn)) {
            continue;
        }
        
        // Open client's response FIFO
        int response_fd = open(conn.response_fifo, O_WRONLY);
        
        // Process request from request FIFO
        int request_fd = open(conn.request_fifo, O_RDONLY);
        char request[1024];
        ssize_t n = read(request_fd, request, sizeof(request));
        
        if (n > 0) {
            // Process and send response
            char response[1024];
            snprintf(response, sizeof(response), 
                    "Processed: %.*s", (int)n, request);
            write(response_fd, response, strlen(response));
        }
        
        close(request_fd);
        close(response_fd);
        
        // Clean up client FIFOs
        unlink(conn.request_fifo);
        unlink(conn.response_fifo);
    }
}
```

## POSIX Message Queues

### High-Level Message Passing

```c
#include <mqueue.h>
#include <sys/stat.h>

typedef struct {
    long priority;
    pid_t sender_pid;
    int msg_type;
    char data[256];
} app_message_t;

void message_queue_server() {
    const char* queue_name = "/myapp_queue";
    struct mq_attr attr = {
        .mq_flags = 0,
        .mq_maxmsg = 10,
        .mq_msgsize = sizeof(app_message_t),
        .mq_curmsgs = 0
    };
    
    // Create message queue
    mqd_t mq = mq_open(queue_name, 
                      O_CREAT | O_RDONLY, 
                      0644, 
                      &attr);
    
    if (mq == (mqd_t)-1) {
        perror("mq_open");
        return;
    }
    
    app_message_t msg;
    unsigned int priority;
    
    while (1) {
        // Receive message with priority
        ssize_t n = mq_receive(mq, 
                              (char*)&msg, 
                              sizeof(msg), 
                              &priority);
        
        if (n == sizeof(msg)) {
            printf("Received message type %d from PID %d (priority %u): %s\n",
                   msg.msg_type, msg.sender_pid, priority, msg.data);
            
            // Process based on message type
            switch (msg.msg_type) {
                case 1:  // Request
                    // Send response...
                    break;
                case 2:  // Notification
                    // Handle notification...
                    break;
            }
        }
    }
    
    mq_close(mq);
    mq_unlink(queue_name);
}

// Asynchronous message queue with notification
void async_message_queue() {
    mqd_t mq = mq_open("/async_queue", 
                      O_CREAT | O_RDONLY | O_NONBLOCK,
                      0644, 
                      NULL);
    
    // Set up notification
    struct sigevent sev;
    sev.sigev_notify = SIGEV_THREAD;
    sev.sigev_notify_function = message_handler;
    sev.sigev_notify_attributes = NULL;
    sev.sigev_value.sival_ptr = &mq;
    
    mq_notify(mq, &sev);
    
    // Main thread continues...
}

void message_handler(union sigval sv) {
    mqd_t mq = *((mqd_t*)sv.sival_ptr);
    app_message_t msg;
    unsigned int priority;
    
    // Read all available messages
    while (mq_receive(mq, (char*)&msg, sizeof(msg), &priority) > 0) {
        printf("Async received: %s\n", msg.data);
    }
    
    // Re-register for next notification
    struct sigevent sev;
    sev.sigev_notify = SIGEV_THREAD;
    sev.sigev_notify_function = message_handler;
    sev.sigev_value.sival_ptr = sv.sival_ptr;
    mq_notify(mq, &sev);
}
```

## Shared Memory: Maximum Performance

### POSIX Shared Memory

```c
#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>

// Shared memory with synchronization
typedef struct {
    pthread_mutex_t mutex;
    pthread_cond_t data_ready;
    int writer_active;
    int readers_waiting;
    size_t data_size;
    char data[4096];
} shared_buffer_t;

void* create_shared_buffer(const char* name, size_t size) {
    int fd = shm_open(name, O_CREAT | O_RDWR, 0666);
    if (fd == -1) {
        perror("shm_open");
        return NULL;
    }
    
    // Set size
    if (ftruncate(fd, size) == -1) {
        perror("ftruncate");
        close(fd);
        return NULL;
    }
    
    // Map into memory
    void* addr = mmap(NULL, size, 
                     PROT_READ | PROT_WRITE, 
                     MAP_SHARED, 
                     fd, 0);
    
    close(fd);  // Can close fd after mmap
    
    if (addr == MAP_FAILED) {
        perror("mmap");
        return NULL;
    }
    
    // Initialize shared data structure
    shared_buffer_t* buffer = (shared_buffer_t*)addr;
    
    pthread_mutexattr_t mutex_attr;
    pthread_mutexattr_init(&mutex_attr);
    pthread_mutexattr_setpshared(&mutex_attr, PTHREAD_PROCESS_SHARED);
    pthread_mutex_init(&buffer->mutex, &mutex_attr);
    
    pthread_condattr_t cond_attr;
    pthread_condattr_init(&cond_attr);
    pthread_condattr_setpshared(&cond_attr, PTHREAD_PROCESS_SHARED);
    pthread_cond_init(&buffer->data_ready, &cond_attr);
    
    buffer->writer_active = 0;
    buffer->readers_waiting = 0;
    buffer->data_size = 0;
    
    return buffer;
}

// Lock-free shared memory ring buffer
typedef struct {
    _Atomic(uint64_t) write_pos;
    _Atomic(uint64_t) read_pos;
    char padding1[64 - 2 * sizeof(uint64_t)];
    
    _Atomic(uint64_t) cached_write_pos;
    _Atomic(uint64_t) cached_read_pos;
    char padding2[64 - 2 * sizeof(uint64_t)];
    
    size_t capacity;
    char data[];
} lockfree_ringbuf_t;

lockfree_ringbuf_t* create_lockfree_ringbuf(const char* name, 
                                           size_t capacity) {
    size_t total_size = sizeof(lockfree_ringbuf_t) + capacity;
    
    int fd = shm_open(name, O_CREAT | O_RDWR, 0666);
    ftruncate(fd, total_size);
    
    lockfree_ringbuf_t* ring = mmap(NULL, total_size,
                                   PROT_READ | PROT_WRITE,
                                   MAP_SHARED, fd, 0);
    close(fd);
    
    atomic_store(&ring->write_pos, 0);
    atomic_store(&ring->read_pos, 0);
    atomic_store(&ring->cached_write_pos, 0);
    atomic_store(&ring->cached_read_pos, 0);
    ring->capacity = capacity;
    
    return ring;
}

bool ringbuf_write(lockfree_ringbuf_t* ring, 
                  const void* data, 
                  size_t len) {
    uint64_t write_pos = atomic_load(&ring->write_pos);
    uint64_t cached_read_pos = atomic_load(&ring->cached_read_pos);
    
    // Check space
    if (write_pos - cached_read_pos + len > ring->capacity) {
        // Update cached read position
        cached_read_pos = atomic_load(&ring->read_pos);
        atomic_store(&ring->cached_read_pos, cached_read_pos);
        
        if (write_pos - cached_read_pos + len > ring->capacity) {
            return false;  // Buffer full
        }
    }
    
    // Copy data
    size_t offset = write_pos % ring->capacity;
    if (offset + len <= ring->capacity) {
        memcpy(ring->data + offset, data, len);
    } else {
        // Wrap around
        size_t first_part = ring->capacity - offset;
        memcpy(ring->data + offset, data, first_part);
        memcpy(ring->data, (char*)data + first_part, len - first_part);
    }
    
    // Update write position
    atomic_store(&ring->write_pos, write_pos + len);
    
    return true;
}
```

### System V Shared Memory

```c
#include <sys/ipc.h>
#include <sys/shm.h>

// High-performance shared memory pool
typedef struct {
    size_t block_size;
    size_t num_blocks;
    _Atomic(uint32_t) free_list;
    char padding[60];
    uint8_t blocks[];
} shm_pool_t;

shm_pool_t* create_shm_pool(key_t key, size_t block_size, 
                           size_t num_blocks) {
    size_t total_size = sizeof(shm_pool_t) + (block_size * num_blocks);
    
    int shmid = shmget(key, total_size, IPC_CREAT | 0666);
    if (shmid == -1) {
        perror("shmget");
        return NULL;
    }
    
    shm_pool_t* pool = shmat(shmid, NULL, 0);
    if (pool == (void*)-1) {
        perror("shmat");
        return NULL;
    }
    
    // Initialize pool
    pool->block_size = block_size;
    pool->num_blocks = num_blocks;
    
    // Build free list
    atomic_store(&pool->free_list, 0);
    for (uint32_t i = 0; i < num_blocks - 1; i++) {
        uint32_t* next = (uint32_t*)(pool->blocks + (i * block_size));
        *next = i + 1;
    }
    uint32_t* last = (uint32_t*)(pool->blocks + 
                                ((num_blocks - 1) * block_size));
    *last = UINT32_MAX;  // End marker
    
    return pool;
}

void* shm_pool_alloc(shm_pool_t* pool) {
    uint32_t head;
    uint32_t next;
    
    do {
        head = atomic_load(&pool->free_list);
        if (head == UINT32_MAX) {
            return NULL;  // Pool exhausted
        }
        
        next = *(uint32_t*)(pool->blocks + (head * pool->block_size));
    } while (!atomic_compare_exchange_weak(&pool->free_list, &head, next));
    
    return pool->blocks + (head * pool->block_size);
}

void shm_pool_free(shm_pool_t* pool, void* ptr) {
    uint32_t block_idx = ((uint8_t*)ptr - pool->blocks) / pool->block_size;
    uint32_t head;
    
    do {
        head = atomic_load(&pool->free_list);
        *(uint32_t*)ptr = head;
    } while (!atomic_compare_exchange_weak(&pool->free_list, 
                                         &head, block_idx));
}
```

## Advanced IPC Patterns

### Publish-Subscribe System

```c
typedef struct subscriber {
    int fd;  // FIFO or socket fd
    char name[64];
    struct subscriber* next;
} subscriber_t;

typedef struct {
    pthread_mutex_t mutex;
    GHashTable* topics;  // topic -> subscriber list
    mqd_t control_queue;
} pubsub_broker_t;

void publish_message(pubsub_broker_t* broker, 
                    const char* topic, 
                    const void* data, 
                    size_t len) {
    pthread_mutex_lock(&broker->mutex);
    
    subscriber_t* sub = g_hash_table_lookup(broker->topics, topic);
    
    while (sub) {
        // Send to each subscriber
        if (write(sub->fd, data, len) == -1) {
            if (errno == EPIPE) {
                // Subscriber disconnected, remove
                // ...
            }
        }
        sub = sub->next;
    }
    
    pthread_mutex_unlock(&broker->mutex);
}

// Zero-copy publish using splice
void publish_file(pubsub_broker_t* broker, 
                 const char* topic, 
                 int file_fd) {
    int pipefd[2];
    pipe(pipefd);
    
    struct stat st;
    fstat(file_fd, &st);
    
    pthread_mutex_lock(&broker->mutex);
    subscriber_t* sub = g_hash_table_lookup(broker->topics, topic);
    
    while (sub) {
        // Splice from file to pipe
        off_t offset = 0;
        splice(file_fd, &offset, pipefd[1], NULL, 
               st.st_size, SPLICE_F_MORE);
        
        // Splice from pipe to subscriber
        splice(pipefd[0], NULL, sub->fd, NULL,
               st.st_size, SPLICE_F_MORE);
        
        sub = sub->next;
    }
    
    pthread_mutex_unlock(&broker->mutex);
    
    close(pipefd[0]);
    close(pipefd[1]);
}
```

### Request-Response with Timeouts

```c
typedef struct {
    uint64_t request_id;
    int timeout_ms;
    void* response_buffer;
    size_t buffer_size;
    pthread_mutex_t mutex;
    pthread_cond_t cond;
    bool completed;
} pending_request_t;

typedef struct {
    int request_fd;   // Write requests
    int response_fd;  // Read responses
    pthread_t response_thread;
    GHashTable* pending;  // request_id -> pending_request_t
    _Atomic(uint64_t) next_id;
} rpc_client_t;

int rpc_call_timeout(rpc_client_t* client,
                    const void* request,
                    size_t request_len,
                    void* response,
                    size_t response_len,
                    int timeout_ms) {
    // Allocate request ID
    uint64_t id = atomic_fetch_add(&client->next_id, 1);
    
    // Prepare pending request
    pending_request_t pending = {
        .request_id = id,
        .timeout_ms = timeout_ms,
        .response_buffer = response,
        .buffer_size = response_len,
        .completed = false
    };
    pthread_mutex_init(&pending.mutex, NULL);
    pthread_cond_init(&pending.cond, NULL);
    
    // Register pending request
    g_hash_table_insert(client->pending, 
                       GUINT_TO_POINTER(id), 
                       &pending);
    
    // Send request
    struct {
        uint64_t id;
        char data[];
    } *req = alloca(sizeof(uint64_t) + request_len);
    
    req->id = id;
    memcpy(req->data, request, request_len);
    
    if (write(client->request_fd, req, 
             sizeof(uint64_t) + request_len) == -1) {
        g_hash_table_remove(client->pending, GUINT_TO_POINTER(id));
        return -1;
    }
    
    // Wait for response with timeout
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    ts.tv_sec += timeout_ms / 1000;
    ts.tv_nsec += (timeout_ms % 1000) * 1000000;
    
    pthread_mutex_lock(&pending.mutex);
    
    int ret = 0;
    while (!pending.completed && ret == 0) {
        ret = pthread_cond_timedwait(&pending.cond, 
                                    &pending.mutex, 
                                    &ts);
    }
    
    pthread_mutex_unlock(&pending.mutex);
    
    // Clean up
    g_hash_table_remove(client->pending, GUINT_TO_POINTER(id));
    pthread_mutex_destroy(&pending.mutex);
    pthread_cond_destroy(&pending.cond);
    
    return (ret == 0) ? 0 : -1;
}
```

## Performance Comparison

### IPC Benchmark Suite

```c
typedef struct {
    const char* name;
    void (*setup)(void);
    void (*cleanup)(void);
    void (*send)(const void* data, size_t len);
    void (*receive)(void* data, size_t len);
} ipc_method_t;

void benchmark_ipc_methods() {
    ipc_method_t methods[] = {
        {"Pipe", setup_pipe, cleanup_pipe, send_pipe, recv_pipe},
        {"FIFO", setup_fifo, cleanup_fifo, send_fifo, recv_fifo},
        {"MsgQueue", setup_mq, cleanup_mq, send_mq, recv_mq},
        {"SHM+Futex", setup_shm, cleanup_shm, send_shm, recv_shm},
        {"Socket", setup_socket, cleanup_socket, send_sock, recv_sock}
    };
    
    const size_t sizes[] = {64, 1024, 4096, 65536};
    const int iterations = 10000;
    
    for (int m = 0; m < sizeof(methods)/sizeof(methods[0]); m++) {
        printf("\n%s:\n", methods[m].name);
        methods[m].setup();
        
        for (int s = 0; s < sizeof(sizes)/sizeof(sizes[0]); s++) {
            void* data = malloc(sizes[s]);
            memset(data, 'A', sizes[s]);
            
            struct timespec start, end;
            clock_gettime(CLOCK_MONOTONIC, &start);
            
            pid_t pid = fork();
            if (pid == 0) {
                // Child: receiver
                void* buffer = malloc(sizes[s]);
                for (int i = 0; i < iterations; i++) {
                    methods[m].receive(buffer, sizes[s]);
                }
                free(buffer);
                exit(0);
            } else {
                // Parent: sender
                for (int i = 0; i < iterations; i++) {
                    methods[m].send(data, sizes[s]);
                }
                wait(NULL);
            }
            
            clock_gettime(CLOCK_MONOTONIC, &end);
            
            double elapsed = (end.tv_sec - start.tv_sec) + 
                           (end.tv_nsec - start.tv_nsec) / 1e9;
            double throughput = (iterations * sizes[s] * 2) / 
                              elapsed / 1024 / 1024;
            
            printf("  %zu bytes: %.2f MB/s, %.2f us/op\n",
                   sizes[s], throughput, 
                   (elapsed / iterations) * 1e6);
            
            free(data);
        }
        
        methods[m].cleanup();
    }
}
```

## Debugging IPC

### IPC Monitoring Tools

```c
// IPC stats collector
void monitor_ipc_usage() {
    // System V IPC
    system("ipcs -a");
    
    // POSIX shared memory
    DIR* dir = opendir("/dev/shm");
    struct dirent* entry;
    while ((entry = readdir(dir)) != NULL) {
        if (entry->d_name[0] != '.') {
            struct stat st;
            char path[PATH_MAX];
            snprintf(path, sizeof(path), "/dev/shm/%s", entry->d_name);
            
            if (stat(path, &st) == 0) {
                printf("Shared memory: %s (size: %ld)\n", 
                       entry->d_name, st.st_size);
            }
        }
    }
    closedir(dir);
    
    // Message queues
    DIR* mq_dir = opendir("/dev/mqueue");
    while ((entry = readdir(mq_dir)) != NULL) {
        if (entry->d_name[0] != '.') {
            printf("Message queue: %s\n", entry->d_name);
        }
    }
    closedir(mq_dir);
}

// IPC trace wrapper
#define TRACE_IPC(call) \
    ({ \
        printf("[IPC] %s:%d: " #call "\n", __FILE__, __LINE__); \
        call; \
    })
```

## Best Practices

1. **Choose the Right IPC**: 
   - Pipes for simple parent-child communication
   - Message queues for structured messages
   - Shared memory for high-performance data sharing

2. **Handle Errors Gracefully**: Always check return values and handle EINTR

3. **Clean Up Resources**: Use cleanup handlers and signal handlers

4. **Consider Security**: Set appropriate permissions on IPC objects

5. **Benchmark Your Use Case**: IPC performance varies with data size and pattern

## Conclusion

Linux IPC mechanisms provide a rich set of tools for building complex, high-performance systems. From simple pipes to lock-free shared memory, each mechanism has its place in the systems programmer's toolkit. Understanding their characteristics, performance profiles, and appropriate use cases enables you to build robust, efficient inter-process communication systems.

The key to successful IPC is choosing the right mechanism for your specific requirements, whether that's the simplicity of pipes, the structure of message queues, or the raw performance of shared memory. By mastering these techniques, you can build everything from simple command-line tools to complex distributed systems that fully leverage Linux's powerful IPC capabilities.