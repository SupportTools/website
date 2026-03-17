---
title: "Linux IPC Deep Dive: Pipes, FIFOs, Message Queues, and Shared Memory Segments"
date: 2030-04-08T00:00:00-05:00
draft: false
tags: ["Linux", "IPC", "Systems Programming", "Performance", "Shared Memory", "Message Queues", "POSIX"]
categories: ["Linux", "Systems Programming", "Performance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Linux IPC mechanisms: System V and POSIX pipes, FIFOs, message queues, and shared memory segments. Performance characteristics, synchronization patterns, and IPC behavior in containerized environments."
more_link: "yes"
url: "/linux-ipc-pipes-fifos-message-queues-shared-memory/"
---

Inter-Process Communication (IPC) is one of the fundamental building blocks of systems programming, yet it is frequently misused or applied inappropriately. Choosing pipes when shared memory is needed, or shared memory when message queues would be safer, leads to subtle bugs, poor performance, or both. This guide covers the complete Linux IPC toolkit with accurate performance characteristics, correct synchronization patterns, and the specific behaviors that change in containerized environments.

<!--more-->

## IPC Mechanism Overview

Linux provides two generations of IPC primitives:

**System V IPC** (original UNIX IPC, older API):
- Semaphores (`semget`, `semop`, `semctl`)
- Message queues (`msgget`, `msgsnd`, `msgrcv`)
- Shared memory (`shmget`, `shmat`, `shmdt`)

**POSIX IPC** (newer, cleaner API):
- Semaphores (`sem_open`, `sem_post`, `sem_wait`)
- Message queues (`mq_open`, `mq_send`, `mq_receive`)
- Shared memory (`shm_open`, `mmap`)

**Additional mechanisms**:
- Anonymous pipes (`pipe`, `pipe2`)
- Named pipes/FIFOs (`mkfifo`)
- Unix domain sockets
- Signals
- `eventfd`, `signalfd`, `timerfd`
- `io_uring` (Linux 5.1+)

### Performance Characteristics at a Glance

| Mechanism          | Latency  | Throughput | Synchronization | Use Case |
|-------------------|----------|------------|-----------------|----------|
| Anonymous pipe    | 1-10 µs  | 1-4 GB/s   | Implicit (blocking) | Parent-child stream |
| FIFO              | 2-15 µs  | 0.5-2 GB/s | Implicit (blocking) | Unrelated process stream |
| POSIX MQ          | 5-20 µs  | 0.1-0.5 GB/s | Built-in | Message passing |
| System V MQ       | 5-25 µs  | 0.1-0.4 GB/s | Built-in | Legacy message passing |
| POSIX shared memory| 0.1-1 µs | 10+ GB/s  | Explicit (semaphores) | High-bandwidth data sharing |
| System V SHM      | 0.1-1 µs | 10+ GB/s   | Explicit (semaphores) | Same as above |
| Unix socket       | 5-30 µs  | 0.5-3 GB/s | Protocol-level | Full-duplex messaging |

## Anonymous Pipes

### Fundamentals

A pipe is a unidirectional byte stream backed by a kernel ring buffer. The default pipe buffer size is 65,536 bytes (64 KB) on Linux 2.6.11+.

```c
// pipe_example.c
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/wait.h>
#include <errno.h>

#define PIPE_BUF_SIZE (1024 * 1024)  // 1 MB transfer

int main(void) {
    int pipefd[2];
    pid_t pid;
    char *buf;

    if (pipe(pipefd) == -1) {
        perror("pipe");
        exit(EXIT_FAILURE);
    }

    // Increase pipe capacity for high-throughput scenarios
    // Maximum is /proc/sys/fs/pipe-max-size (default 1 MB)
    if (fcntl(pipefd[1], F_SETPIPE_SZ, PIPE_BUF_SIZE) == -1) {
        perror("fcntl F_SETPIPE_SZ");
        // Non-fatal: continue with default size
    }

    pid = fork();
    if (pid == -1) {
        perror("fork");
        exit(EXIT_FAILURE);
    }

    if (pid == 0) {
        // Child: reader
        close(pipefd[1]);  // Close write end

        buf = malloc(PIPE_BUF_SIZE);
        if (!buf) { perror("malloc"); exit(EXIT_FAILURE); }

        ssize_t total = 0, n;
        while ((n = read(pipefd[0], buf + total, PIPE_BUF_SIZE - total)) > 0) {
            total += n;
        }

        printf("Child received %zd bytes\n", total);
        free(buf);
        close(pipefd[0]);
        exit(EXIT_SUCCESS);
    }

    // Parent: writer
    close(pipefd[0]);  // Close read end

    buf = malloc(PIPE_BUF_SIZE);
    if (!buf) { perror("malloc"); exit(EXIT_FAILURE); }
    memset(buf, 'A', PIPE_BUF_SIZE);

    ssize_t total_written = 0;
    while (total_written < PIPE_BUF_SIZE) {
        ssize_t n = write(pipefd[1], buf + total_written,
                          PIPE_BUF_SIZE - total_written);
        if (n == -1) {
            if (errno == EINTR) continue;
            perror("write");
            break;
        }
        total_written += n;
    }

    printf("Parent sent %zd bytes\n", total_written);
    free(buf);
    close(pipefd[1]);  // EOF signal to child

    wait(NULL);
    return 0;
}
```

### Pipe Atomicity Guarantee

Writes smaller than `PIPE_BUF` (4096 bytes) are atomic — they complete fully or not at all without interleaving with other writers. Writes larger than `PIPE_BUF` are not atomic and may be interleaved:

```c
#include <limits.h>  // PIPE_BUF

// Safe: atomic write
write(pipefd[1], data, PIPE_BUF);  // 4096 bytes max

// Not atomic: may be interleaved if multiple writers
write(pipefd[1], large_data, 65536);

// Check the guarantee
printf("PIPE_BUF = %d bytes\n", PIPE_BUF);  // 4096 on Linux
```

### Non-Blocking Pipe I/O with poll

```c
#include <fcntl.h>
#include <poll.h>

void set_nonblocking(int fd) {
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags == -1) { perror("fcntl F_GETFL"); return; }
    if (fcntl(fd, F_SETFL, flags | O_NONBLOCK) == -1) {
        perror("fcntl F_SETFL");
    }
}

// Event-driven pipe reading
int pipe_reader_loop(int pipefd) {
    struct pollfd pfd = {
        .fd = pipefd,
        .events = POLLIN,
    };

    char buf[4096];
    while (1) {
        int ret = poll(&pfd, 1, -1);  // Block until data available
        if (ret == -1) {
            if (errno == EINTR) continue;
            perror("poll");
            return -1;
        }

        if (pfd.revents & POLLIN) {
            ssize_t n = read(pipefd, buf, sizeof(buf));
            if (n > 0) {
                process_data(buf, n);
            } else if (n == 0) {
                // EOF: all write ends closed
                return 0;
            } else if (errno != EAGAIN && errno != EWOULDBLOCK) {
                perror("read");
                return -1;
            }
        }

        if (pfd.revents & (POLLHUP | POLLERR)) {
            return 0;
        }
    }
}
```

## Named Pipes (FIFOs)

FIFOs are like anonymous pipes but exist as filesystem entries, allowing unrelated processes to communicate:

```c
// fifo_server.c
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#define FIFO_PATH "/tmp/myapp.fifo"
#define MSG_SIZE 256

int main(void) {
    // Create FIFO if it doesn't exist
    if (mkfifo(FIFO_PATH, 0666) == -1 && errno != EEXIST) {
        perror("mkfifo");
        exit(EXIT_FAILURE);
    }

    printf("Server: waiting for client...\n");

    // Opening a FIFO blocks until the other end is opened
    // Use O_RDWR to avoid blocking when no writer exists yet
    int fd = open(FIFO_PATH, O_RDONLY);
    if (fd == -1) {
        perror("open FIFO for reading");
        exit(EXIT_FAILURE);
    }

    char buf[MSG_SIZE];
    ssize_t n;
    while ((n = read(fd, buf, sizeof(buf) - 1)) > 0) {
        buf[n] = '\0';
        printf("Server received: %s\n", buf);
    }

    close(fd);
    unlink(FIFO_PATH);  // Remove FIFO when done
    return 0;
}
```

```c
// fifo_client.c
int main(void) {
    int fd = open(FIFO_PATH, O_WRONLY);
    if (fd == -1) {
        perror("open FIFO for writing");
        exit(EXIT_FAILURE);
    }

    const char *messages[] = {
        "Hello from client",
        "Message 2",
        "Goodbye",
    };

    for (int i = 0; i < 3; i++) {
        if (write(fd, messages[i], strlen(messages[i])) == -1) {
            perror("write");
            break;
        }
    }

    close(fd);  // Signals EOF to server
    return 0;
}
```

### FIFO Limitations

- No message boundaries: bytes flow as a stream, no packet framing
- Single reader, single (logical) writer
- Subject to broken pipe (`SIGPIPE`) when reader exits

For multiple concurrent writers, use message queues instead.

## POSIX Message Queues

POSIX message queues provide message-oriented (not stream-oriented) communication with priority support and guaranteed message boundaries:

```c
// posix_mq_producer.c
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <mqueue.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <time.h>

#define QUEUE_NAME "/myapp_queue"
#define MAX_MSG_SIZE 2048
#define MAX_MSGS 10

typedef struct {
    uint64_t sequence;
    uint32_t type;
    uint32_t payload_len;
    char     payload[MAX_MSG_SIZE - 16];
} Message;

int main(void) {
    struct mq_attr attr = {
        .mq_flags   = 0,
        .mq_maxmsg  = MAX_MSGS,
        .mq_msgsize = MAX_MSG_SIZE,
        .mq_curmsgs = 0,
    };

    // Create or open queue with O_CREAT
    mqd_t mq = mq_open(QUEUE_NAME, O_CREAT | O_WRONLY, 0644, &attr);
    if (mq == (mqd_t)-1) {
        perror("mq_open");
        exit(EXIT_FAILURE);
    }

    Message msg = {
        .sequence    = 1,
        .type        = 0x0001,
        .payload_len = 12,
    };
    strcpy(msg.payload, "Hello, Queue");

    // Send with priority 0 (lower = lower priority, max = sysconf(_SC_MQ_PRIO_MAX))
    if (mq_send(mq, (char *)&msg, sizeof(msg), 0) == -1) {
        perror("mq_send");
        mq_close(mq);
        exit(EXIT_FAILURE);
    }

    printf("Producer sent message %lu\n", msg.sequence);
    mq_close(mq);
    return 0;
}
```

```c
// posix_mq_consumer.c
#include <mqueue.h>
#include <signal.h>

static volatile sig_atomic_t running = 1;

void sigint_handler(int sig) {
    (void)sig;
    running = 0;
}

int main(void) {
    signal(SIGINT, sigint_handler);

    // Open existing queue for reading
    mqd_t mq = mq_open(QUEUE_NAME, O_RDONLY);
    if (mq == (mqd_t)-1) {
        perror("mq_open");
        exit(EXIT_FAILURE);
    }

    Message msg;
    unsigned int priority;

    while (running) {
        // Use timed receive to allow signal handling
        struct timespec ts;
        clock_gettime(CLOCK_REALTIME, &ts);
        ts.tv_sec += 1;  // 1 second timeout

        ssize_t n = mq_timedreceive(mq, (char *)&msg, sizeof(msg), &priority, &ts);
        if (n == -1) {
            if (errno == ETIMEDOUT) continue;
            if (errno == EINTR) continue;
            perror("mq_timedreceive");
            break;
        }

        printf("Consumer received: seq=%lu type=0x%04x priority=%u payload=%s\n",
               msg.sequence, msg.type, priority, msg.payload);
    }

    mq_close(mq);
    mq_unlink(QUEUE_NAME);  // Remove queue from system
    return 0;
}
```

### POSIX MQ Notifications

```c
// Non-blocking notification when a message arrives
void mq_notification_handler(union sigval sv) {
    mqd_t mq = (mqd_t)sv.sival_int;
    Message msg;
    unsigned int priority;

    // Re-register notification FIRST (notifications are one-shot)
    struct sigevent sev = {
        .sigev_notify          = SIGEV_THREAD,
        .sigev_value.sival_int = (int)mq,
        .sigev_notify_function = mq_notification_handler,
    };
    mq_notify(mq, &sev);

    // Drain all available messages
    while (1) {
        ssize_t n = mq_receive(mq, (char *)&msg, sizeof(msg), &priority);
        if (n == -1) {
            if (errno == EAGAIN) break;  // Queue empty
            perror("mq_receive");
            break;
        }
        process_message(&msg, priority);
    }
}

void register_mq_notification(mqd_t mq) {
    struct sigevent sev = {
        .sigev_notify          = SIGEV_THREAD,
        .sigev_value.sival_int = (int)mq,
        .sigev_notify_function = mq_notification_handler,
    };

    if (mq_notify(mq, &sev) == -1) {
        perror("mq_notify");
    }
}
```

## POSIX Shared Memory

Shared memory provides the highest throughput IPC by allowing multiple processes to access the same memory region directly, without data copying through the kernel. The trade-off is that synchronization becomes the application's responsibility.

### Creating and Mapping Shared Memory

```c
// posix_shm_producer.c
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <semaphore.h>
#include <unistd.h>
#include <stdatomic.h>

#define SHM_NAME  "/myapp_shm"
#define SEM_WRITE "/myapp_sem_write"
#define SEM_READ  "/myapp_sem_read"

// Layout of the shared memory region
typedef struct {
    atomic_uint   sequence;
    uint32_t      data_size;
    char          data[4096];
    _Bool         producer_done;
} SharedBuffer;

int main(void) {
    // Create shared memory object
    int shm_fd = shm_open(SHM_NAME, O_CREAT | O_RDWR, 0644);
    if (shm_fd == -1) {
        perror("shm_open");
        exit(EXIT_FAILURE);
    }

    // Set the size of the shared memory
    if (ftruncate(shm_fd, sizeof(SharedBuffer)) == -1) {
        perror("ftruncate");
        close(shm_fd);
        shm_unlink(SHM_NAME);
        exit(EXIT_FAILURE);
    }

    // Map shared memory into address space
    SharedBuffer *shm = mmap(
        NULL,
        sizeof(SharedBuffer),
        PROT_READ | PROT_WRITE,
        MAP_SHARED,
        shm_fd,
        0
    );

    if (shm == MAP_FAILED) {
        perror("mmap");
        close(shm_fd);
        shm_unlink(SHM_NAME);
        exit(EXIT_FAILURE);
    }

    close(shm_fd);  // fd no longer needed after mmap

    // Initialize the shared memory
    atomic_init(&shm->sequence, 0);
    shm->producer_done = false;

    // Create semaphores for synchronization
    // sem_write: initially 1 (producer can write)
    // sem_read:  initially 0 (consumer must wait for producer)
    sem_t *sem_write = sem_open(SEM_WRITE, O_CREAT, 0644, 1);
    sem_t *sem_read  = sem_open(SEM_READ,  O_CREAT, 0644, 0);

    if (sem_write == SEM_FAILED || sem_read == SEM_FAILED) {
        perror("sem_open");
        exit(EXIT_FAILURE);
    }

    // Produce 5 messages
    for (int i = 0; i < 5; i++) {
        // Wait for permission to write (consumer has consumed last message)
        sem_wait(sem_write);

        // Write data
        snprintf(shm->data, sizeof(shm->data), "Message %d from producer", i);
        shm->data_size = strlen(shm->data);
        atomic_fetch_add(&shm->sequence, 1);

        printf("Producer wrote: %s (seq=%u)\n",
               shm->data, atomic_load(&shm->sequence));

        // Signal consumer that data is ready
        sem_post(sem_read);
    }

    // Signal completion
    sem_wait(sem_write);
    shm->producer_done = true;
    sem_post(sem_read);

    // Cleanup
    sem_close(sem_write);
    sem_close(sem_read);
    sem_unlink(SEM_WRITE);
    sem_unlink(SEM_READ);
    munmap(shm, sizeof(SharedBuffer));
    shm_unlink(SHM_NAME);

    return 0;
}
```

```c
// posix_shm_consumer.c
int main(void) {
    // Open existing shared memory
    int shm_fd = shm_open(SHM_NAME, O_RDWR, 0);
    if (shm_fd == -1) {
        perror("shm_open");
        exit(EXIT_FAILURE);
    }

    SharedBuffer *shm = mmap(NULL, sizeof(SharedBuffer),
                              PROT_READ | PROT_WRITE, MAP_SHARED, shm_fd, 0);
    if (shm == MAP_FAILED) { perror("mmap"); exit(EXIT_FAILURE); }
    close(shm_fd);

    sem_t *sem_write = sem_open(SEM_WRITE, 0);
    sem_t *sem_read  = sem_open(SEM_READ,  0);

    while (1) {
        // Wait for producer to write
        sem_wait(sem_read);

        if (shm->producer_done) {
            printf("Consumer: producer signaled completion\n");
            sem_post(sem_write);  // Release for cleanup
            break;
        }

        printf("Consumer read (seq=%u): %.*s\n",
               atomic_load(&shm->sequence),
               (int)shm->data_size, shm->data);

        // Signal producer that we've consumed the data
        sem_post(sem_write);
    }

    sem_close(sem_write);
    sem_close(sem_read);
    munmap(shm, sizeof(SharedBuffer));
    return 0;
}
```

## High-Performance Ring Buffer in Shared Memory

For real production workloads, a single-slot shared memory buffer is too slow. A lock-free ring buffer using atomic operations achieves much higher throughput:

```c
// shm_ringbuf.h
#ifndef SHM_RINGBUF_H
#define SHM_RINGBUF_H

#include <stdatomic.h>
#include <stdint.h>
#include <string.h>
#include <stdbool.h>

#define RING_CAPACITY 256  // Must be power of 2
#define RING_MASK     (RING_CAPACITY - 1)
#define SLOT_SIZE     4096

// Cache line size — align to avoid false sharing
#define CACHE_LINE 64

// Shared ring buffer structure
// Designed for single-producer, single-consumer (SPSC) use
typedef struct {
    // Producer writes here
    _Alignas(CACHE_LINE) atomic_uint_fast64_t write_idx;

    // Consumer reads from here (separate cache line)
    _Alignas(CACHE_LINE) atomic_uint_fast64_t read_idx;

    // Data slots
    char slots[RING_CAPACITY][SLOT_SIZE];
    uint32_t slot_sizes[RING_CAPACITY];
} __attribute__((aligned(CACHE_LINE))) RingBuffer;

// Returns true if slot was written, false if ring is full
static inline bool ring_try_push(RingBuffer *rb, const void *data, uint32_t size) {
    if (size > SLOT_SIZE) return false;

    uint64_t write = atomic_load_explicit(&rb->write_idx, memory_order_relaxed);
    uint64_t read  = atomic_load_explicit(&rb->read_idx,  memory_order_acquire);

    // Check for space
    if (write - read >= RING_CAPACITY) {
        return false;  // Full
    }

    uint64_t slot = write & RING_MASK;
    memcpy(rb->slots[slot], data, size);
    rb->slot_sizes[slot] = size;

    // Release store: makes the write visible to consumer
    atomic_store_explicit(&rb->write_idx, write + 1, memory_order_release);
    return true;
}

// Returns size read, or 0 if empty
static inline uint32_t ring_try_pop(RingBuffer *rb, void *data) {
    uint64_t read  = atomic_load_explicit(&rb->read_idx,  memory_order_relaxed);
    uint64_t write = atomic_load_explicit(&rb->write_idx, memory_order_acquire);

    if (read == write) {
        return 0;  // Empty
    }

    uint64_t slot = read & RING_MASK;
    uint32_t size = rb->slot_sizes[slot];
    memcpy(data, rb->slots[slot], size);

    // Release store: makes slot available to producer
    atomic_store_explicit(&rb->read_idx, read + 1, memory_order_release);
    return size;
}

// Spin-wait variant (suitable for dedicated consumer thread)
static inline uint32_t ring_pop_blocking(RingBuffer *rb, void *data) {
    uint32_t size;
    while ((size = ring_try_pop(rb, data)) == 0) {
        // CPU hint: we're spinning
        #if defined(__x86_64__) || defined(__i386__)
            __asm__ volatile("pause" ::: "memory");
        #elif defined(__aarch64__)
            __asm__ volatile("yield" ::: "memory");
        #endif
    }
    return size;
}

#endif // SHM_RINGBUF_H
```

## System V IPC

System V IPC is the older API but is still encountered in legacy systems and some performance-critical applications:

### System V Message Queues

```c
// sysv_mq.c
#include <sys/types.h>
#include <sys/ipc.h>
#include <sys/msg.h>

#define SHM_KEY 0x12345678

// System V message must start with a long mtype
typedef struct {
    long mtype;     // Message type (must be > 0)
    char mtext[256];
} SysvMessage;

int create_or_get_queue(key_t key) {
    // IPC_CREAT | IPC_EXCL fails if already exists
    // IPC_CREAT alone creates or returns existing
    int msqid = msgget(key, IPC_CREAT | 0666);
    if (msqid == -1) {
        perror("msgget");
    }
    return msqid;
}

int send_message(int msqid, long type, const char *text) {
    SysvMessage msg;
    msg.mtype = type;
    strncpy(msg.mtext, text, sizeof(msg.mtext) - 1);
    msg.mtext[sizeof(msg.mtext) - 1] = '\0';

    // msgsnd with 0 flags: blocks if queue is full
    // IPC_NOWAIT: returns EAGAIN immediately if full
    if (msgsnd(msqid, &msg, strlen(msg.mtext) + 1, 0) == -1) {
        perror("msgsnd");
        return -1;
    }
    return 0;
}

int receive_message(int msqid, long type, char *buf, size_t buflen) {
    SysvMessage msg;

    // msgtyp > 0: receive message of exactly that type
    // msgtyp = 0: receive any message (FIFO)
    // msgtyp < 0: receive message of lowest type <= |msgtyp|
    ssize_t n = msgrcv(msqid, &msg, sizeof(msg.mtext), type, 0);
    if (n == -1) {
        perror("msgrcv");
        return -1;
    }

    strncpy(buf, msg.mtext, buflen - 1);
    buf[buflen - 1] = '\0';
    return (int)n;
}

void cleanup_queue(int msqid) {
    if (msgctl(msqid, IPC_RMID, NULL) == -1) {
        perror("msgctl IPC_RMID");
    }
}
```

### Listing and Cleaning Up System V IPC Resources

```bash
# List all System V IPC objects
ipcs -a

# List message queues
ipcs -q

# List shared memory segments
ipcs -m

# List semaphores
ipcs -s

# Remove a specific IPC object
ipcrm -q <msqid>    # Remove message queue
ipcrm -m <shmid>    # Remove shared memory segment
ipcrm -s <semid>    # Remove semaphore set

# Remove ALL IPC objects for current user (dangerous in shared systems)
ipcrm --all
```

## IPC in Containerized Environments

Container networking and IPC add important constraints:

### IPC Namespaces

By default, each container has its own IPC namespace. System V and POSIX IPC objects created in one container are NOT visible in another:

```bash
# Container 1: create a shared memory segment
docker run --rm -it ubuntu bash
# Inside container:
# python3 -c "import sysv_ipc; m = sysv_ipc.SharedMemory(1234, sysv_ipc.IPC_CREAT, size=4096); print('Created SHM', m.id)"

# Container 2 (different namespace): cannot see it
docker run --rm -it ubuntu bash
# python3 -c "import sysv_ipc; m = sysv_ipc.SharedMemory(1234); print(m.id)"
# Raises sysv_ipc.ExistentialError: No shared memory segment with that key
```

### Sharing IPC Between Containers

```bash
# Share IPC namespace between two containers
docker run -d --name app1 --ipc=shareable ubuntu sleep 3600
docker run -d --name app2 --ipc=container:app1 ubuntu sleep 3600

# Verify they share the same IPC namespace
docker inspect app1 --format '{{ .HostConfig.IpcMode }}'
docker inspect app2 --format '{{ .HostConfig.IpcMode }}'
```

### Kubernetes Pod IPC Sharing

Containers within the same Kubernetes Pod already share a network namespace, but IPC namespace sharing requires explicit configuration:

```yaml
# pod-shared-ipc.yaml
apiVersion: v1
kind: Pod
metadata:
  name: shared-ipc-demo
spec:
  # Share IPC namespace across all containers in this pod
  shareProcessNamespace: true  # This also shares PID namespace

  containers:
    - name: producer
      image: your-registry/shm-producer:latest
      # When using POSIX shared memory in a container,
      # /dev/shm size defaults to 64 MB
      # Increase it for high-throughput scenarios
      resources:
        limits:
          memory: "512Mi"
      volumeMounts:
        - name: dshm
          mountPath: /dev/shm

    - name: consumer
      image: your-registry/shm-consumer:latest
      volumeMounts:
        - name: dshm
          mountPath: /dev/shm

  volumes:
    # tmpfs-backed /dev/shm with increased size
    - name: dshm
      emptyDir:
        medium: Memory
        sizeLimit: 256Mi
```

### POSIX Shared Memory in Containers

POSIX shared memory (`/dev/shm`) works within a pod because containers in the same pod share a network namespace. The memory resides in the pod's tmpfs:

```bash
# Check /dev/shm size in a running container
kubectl exec -it my-pod -c producer -- df -h /dev/shm

# Check POSIX MQ limits in a container
kubectl exec -it my-pod -- cat /proc/sys/fs/mqueue/msg_max
kubectl exec -it my-pod -- cat /proc/sys/fs/mqueue/msgsize_max

# Increase POSIX MQ limits (requires privileged pod or node-level configuration)
sysctl -w fs.mqueue.msg_max=100
sysctl -w fs.mqueue.msgsize_max=65536
```

## Choosing the Right IPC Mechanism

### Decision Framework

```
Is the data a byte stream or discrete messages?
│
├── Byte stream → Pipe or FIFO
│   ├── Related processes (parent-child) → Anonymous pipe
│   └── Unrelated processes → FIFO
│
└── Discrete messages → Message queue or shared memory
    │
    ├── Need message persistence/priority? → POSIX MQ
    │
    └── Maximum throughput required?
        ├── Yes → Shared memory with semaphores
        └── No, need simplicity → POSIX MQ

Is latency critical (<1 µs)?
└── Yes → Shared memory with lock-free ring buffer
```

### Performance Benchmarking

```c
// ipc_benchmark.c
#include <time.h>
#include <stdio.h>

#define ITERATIONS 1000000

double benchmark_pipe(void) {
    int pipefd[2];
    pipe(pipefd);

    struct timespec start, end;
    clock_gettime(CLOCK_MONOTONIC, &start);

    char buf[64];
    for (int i = 0; i < ITERATIONS; i++) {
        write(pipefd[1], buf, sizeof(buf));
        read(pipefd[0], buf, sizeof(buf));
    }

    clock_gettime(CLOCK_MONOTONIC, &end);
    close(pipefd[0]); close(pipefd[1]);

    double elapsed = (end.tv_sec - start.tv_sec) * 1e9
                   + (end.tv_nsec - start.tv_nsec);
    return elapsed / ITERATIONS;  // ns per round trip
}
```

## Key Takeaways

Linux IPC mechanisms span a wide range of trade-offs between simplicity, performance, and safety:

1. **Anonymous pipes** are the simplest and best choice for streaming data between parent and child processes. The 65 KB default buffer is often insufficient for high-throughput workloads — increase it with `F_SETPIPE_SZ` up to `/proc/sys/fs/pipe-max-size`.

2. **FIFOs** extend pipe semantics to unrelated processes via the filesystem. They are appropriate for simple command-response patterns but suffer from lack of message boundaries and single-reader limitations.

3. **POSIX message queues** provide message framing, priority support, and notification capabilities. Use them when you need discrete messages, bounded queue depth, or non-blocking notification patterns. The `/dev/mqueue` filesystem provides introspection.

4. **POSIX shared memory** delivers the lowest latency and highest throughput by eliminating kernel copies entirely. The trade-off is explicit synchronization. For single-producer/single-consumer scenarios, a lock-free ring buffer with atomic indices outperforms semaphore-based approaches by an order of magnitude.

5. **Containers change IPC semantics**. Each container has its own IPC namespace by default. POSIX shared memory works within a pod (shared namespace) but not across pods. `/dev/shm` is limited to 64 MB by default in containers — increase it via an `emptyDir` volume with `medium: Memory` for shared memory-intensive workloads.

6. **Never use System V IPC in new code**. The POSIX interfaces provide the same capabilities with a cleaner API and better integration with modern tooling. System V resources survive reboots on some systems and are easy to leak, creating resource exhaustion problems.
