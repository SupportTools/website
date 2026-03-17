---
title: "Linux File Descriptor Management: ulimits, epoll, and High-Concurrency I/O Patterns"
date: 2030-04-11T00:00:00-05:00
draft: false
tags: ["Linux", "Performance", "epoll", "File Descriptors", "I/O", "Systems Programming", "High Concurrency"]
categories: ["Linux", "Systems Programming", "Performance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Linux file descriptor management: tuning ulimits and kernel limits, epoll vs select/poll performance comparison, edge-triggered vs level-triggered epoll, inotify for filesystem events, and eventfd/timerfd patterns for high-concurrency I/O applications."
more_link: "yes"
url: "/linux-file-descriptor-management-ulimits-epoll-high-concurrency/"
---

Every TCP connection, open file, pipe, and IPC mechanism consumes a file descriptor. When you're building high-concurrency servers that handle tens of thousands of simultaneous connections, file descriptor management becomes a first-class engineering concern. The difference between a server that handles 10,000 concurrent connections and one that handles 100,000 often comes down to I/O event notification mechanisms and correct ulimit configuration — not application logic.

This guide covers the complete picture from kernel limits through epoll internals to production patterns for high-concurrency servers.

<!--more-->

## File Descriptor Fundamentals

### What Is a File Descriptor?

A file descriptor (FD) is a non-negative integer that represents an open file description in the kernel. "File" in Linux means any I/O resource: regular files, directories, sockets, pipes, character devices, timers, and event notification channels.

```bash
# Every process starts with three standard FDs:
# 0 = stdin
# 1 = stdout
# 2 = stderr

# List open FDs for a running process
ls -la /proc/$(pgrep nginx | head -1)/fd/ | head -20

# Count open FDs
ls /proc/$(pgrep nginx | head -1)/fd/ | wc -l

# See what each FD points to
readlink /proc/$(pgrep nginx | head -1)/fd/{0,1,2,3,4,5}
```

### The File Descriptor Table

```c
// Conceptual kernel data structure (simplified)
struct process {
    struct files_struct *files;
};

struct files_struct {
    // The FD table: each index is an FD, each value is a pointer to a file object
    struct file *fd_array[NR_OPEN_DEFAULT];  // Initially 64 slots, expands dynamically
};

struct file {
    struct path     f_path;
    struct inode    *f_inode;
    const struct file_operations *f_op;
    unsigned int    f_flags;
    loff_t          f_pos;       // Current file position
    struct fown_struct f_owner;  // For SIGIO notification
    void            *private_data;
};
```

## Kernel and Process Limits

### The Three Limits That Matter

```bash
# 1. System-wide: maximum FDs across ALL processes
cat /proc/sys/fs/file-max
# 9223372036854775807 (effectively unlimited on modern kernels, but often set to ~800000)

# 2. System-wide: current open FDs / maximum / maximum inodes
cat /proc/sys/fs/file-nr
# 32864	0	9223372036854775807
# Currently open  Unused (always 0 in Linux 2.6+)  Maximum

# 3. Per-process soft and hard limits
ulimit -n        # soft limit (default often 1024 or 65536)
ulimit -Hn       # hard limit (ceiling for soft limit)
```

### Configuring Limits for Production

```bash
# Temporary: set for current shell and its children
ulimit -n 1048576

# Persistent: add to /etc/security/limits.conf
cat >> /etc/security/limits.conf << 'EOF'
# Increase FD limits for high-concurrency services
www-data    soft    nofile    1048576
www-data    hard    nofile    1048576
nginx       soft    nofile    1048576
nginx       hard    nofile    1048576
# Wildcard for all users (use cautiously)
*           soft    nofile    65536
*           hard    nofile    1048576
EOF

# For systemd services, set in the unit file
cat >> /etc/systemd/system/my-server.service << 'EOF'
[Service]
LimitNOFILE=1048576
EOF

# Reload systemd to apply
systemctl daemon-reload
systemctl restart my-server

# Verify the service has the correct limit
cat /proc/$(pgrep my-server)/limits | grep "open files"
# Max open files            1048576              1048576              files
```

### System-Wide Tuning

```bash
# /etc/sysctl.conf additions for high-concurrency servers

# Maximum FDs system-wide
fs.file-max = 1048576

# Maximum per-process limit that can be set via ulimit
fs.nr_open = 1048576

# Backlog queue for accepted connections
net.core.somaxconn = 65536

# Maximum SYN_RECV connections in backlog
net.ipv4.tcp_max_syn_backlog = 65536

# Maximum number of sockets in TIME_WAIT
net.ipv4.tcp_max_tw_buckets = 1048576

# Local port range for outbound connections
net.ipv4.ip_local_port_range = 1024 65535

# Apply immediately
sysctl -p
```

## select, poll, and Their Limitations

### select: The O(n) Problem

```c
#include <sys/select.h>

// select scans ALL fd_sets up to nfds
// This requires copying FD sets to kernel and back on every call
// Time complexity: O(n) per call, O(n^2) total if n connections are active
int select_server_example(void) {
    fd_set readfds;
    int max_fd = 0;
    int connections[FD_SETSIZE];  // FD_SETSIZE = 1024 (hard limit!)
    int conn_count = 0;

    int server_fd = create_server_socket();
    connections[conn_count++] = server_fd;

    while (1) {
        FD_ZERO(&readfds);
        for (int i = 0; i < conn_count; i++) {
            FD_SET(connections[i], &readfds);
            if (connections[i] > max_fd) max_fd = connections[i];
        }

        // select returns the number of ready FDs
        // But it modifies readfds in place — you must rebuild it each time
        struct timeval tv = {.tv_sec = 1, .tv_usec = 0};
        int ready = select(max_fd + 1, &readfds, NULL, NULL, &tv);

        if (ready <= 0) continue;

        for (int i = 0; i < conn_count; i++) {
            if (FD_ISSET(connections[i], &readfds)) {
                // Handle ready FD
                handle_fd(connections[i]);
            }
        }
    }
    // select has FD_SETSIZE limit (1024) — cannot handle more connections
}
```

### poll: Better API, Same Problem

```c
#include <poll.h>

// poll uses a dynamic array instead of a fixed-size bitmap
// No FD_SETSIZE limit, but still O(n) per call
void poll_example(void) {
    struct pollfd *fds;
    int nfds = 0, nfds_allocated = 64;

    fds = malloc(nfds_allocated * sizeof(struct pollfd));

    while (1) {
        // poll also copies the entire array to/from kernel each call
        int ready = poll(fds, nfds, 1000 /* ms timeout */);

        if (ready < 0) { perror("poll"); break; }
        if (ready == 0) continue;

        for (int i = 0; i < nfds; i++) {
            if (fds[i].revents & POLLIN) {
                handle_readable(fds[i].fd);
            }
            if (fds[i].revents & (POLLERR | POLLHUP)) {
                close_connection(fds[i].fd);
                // Remove from array
                fds[i] = fds[--nfds];
                i--;
            }
        }
    }
}
// Problem: for 10,000 connections, every poll() call copies 160KB (10000 * 16 bytes)
```

## epoll: O(1) Event Notification

epoll maintains an in-kernel set of FDs. You add FDs once and receive only the events that occur, without copying the entire FD set each call.

### epoll System Calls

```c
// 1. epoll_create1: create epoll file descriptor
int epfd = epoll_create1(EPOLL_CLOEXEC);

// 2. epoll_ctl: add/modify/remove FDs from the epoll set
struct epoll_event event;
event.events = EPOLLIN | EPOLLERR | EPOLLHUP;
event.data.fd = fd;  // or event.data.ptr for pointer to context
epoll_ctl(epfd, EPOLL_CTL_ADD, fd, &event);
epoll_ctl(epfd, EPOLL_CTL_MOD, fd, &event);
epoll_ctl(epfd, EPOLL_CTL_DEL, fd, NULL);

// 3. epoll_wait: wait for events
struct epoll_event events[MAX_EVENTS];
int n = epoll_wait(epfd, events, MAX_EVENTS, timeout_ms);
for (int i = 0; i < n; i++) {
    handle_event(&events[i]);
}
```

### Level-Triggered vs Edge-Triggered

Level-triggered (LT) and edge-triggered (ET) are fundamentally different notification semantics:

```
Level-Triggered (default):
"Notify me as long as data is available"
                    ┌────────────┐
Data in buffer:     │ 1000 bytes │
                    └────────────┘
epoll events: ▲  ▲  ▲  ▲  (repeats until buffer is empty)

Edge-Triggered (EPOLLET):
"Notify me when NEW data arrives"
                    ┌────────────┐
Data in buffer:     │ 1000 bytes │
                    └────────────┘
epoll events: ▲ (once only, even if you only read 500 bytes)
```

### Complete Edge-Triggered epoll Server

```c
// epoll_server.c — High-performance edge-triggered server
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <netinet/in.h>
#include <sys/epoll.h>
#include <sys/socket.h>

#define MAX_EVENTS    1024
#define BACKLOG       65536
#define BUFFER_SIZE   65536

static void set_nonblocking(int fd) {
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags == -1) { perror("fcntl F_GETFL"); exit(1); }
    if (fcntl(fd, F_SETFL, flags | O_NONBLOCK) == -1) {
        perror("fcntl F_SETFL");
        exit(1);
    }
}

typedef struct {
    int fd;
    char *read_buf;
    size_t read_buf_size;
    size_t bytes_read;
} Connection;

static Connection* new_connection(int fd) {
    Connection *c = calloc(1, sizeof(Connection));
    c->fd = fd;
    c->read_buf_size = BUFFER_SIZE;
    c->read_buf = malloc(BUFFER_SIZE);
    return c;
}

static void free_connection(Connection *c) {
    close(c->fd);
    free(c->read_buf);
    free(c);
}

// Handle a readable event on a connection.
// With ET mode, we MUST read ALL available data until EAGAIN.
static int handle_read(int epfd, Connection *c) {
    while (1) {
        ssize_t n = read(c->fd,
                         c->read_buf + c->bytes_read,
                         c->read_buf_size - c->bytes_read);

        if (n > 0) {
            c->bytes_read += n;

            // Grow buffer if needed
            if (c->bytes_read == c->read_buf_size) {
                c->read_buf_size *= 2;
                c->read_buf = realloc(c->read_buf, c->read_buf_size);
            }
        } else if (n == 0) {
            // EOF: client closed connection
            return -1;
        } else {
            if (errno == EAGAIN || errno == EWOULDBLOCK) {
                // No more data available right now — stop reading
                // With ET, we'll be notified when more arrives
                break;
            } else if (errno == EINTR) {
                continue;  // Retry after signal
            } else {
                perror("read");
                return -1;
            }
        }
    }

    // Process the data we've read
    // (For an HTTP server, you'd parse the request here)
    process_request(c);
    c->bytes_read = 0;  // Reset for next request

    return 0;
}

int main(void) {
    int server_fd = socket(AF_INET, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);

    int opt = 1;
    setsockopt(server_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));
    setsockopt(server_fd, SOL_SOCKET, SO_REUSEPORT, &opt, sizeof(opt));

    struct sockaddr_in addr = {
        .sin_family = AF_INET,
        .sin_addr.s_addr = INADDR_ANY,
        .sin_port = htons(8080),
    };
    bind(server_fd, (struct sockaddr *)&addr, sizeof(addr));
    listen(server_fd, BACKLOG);

    // Create epoll instance
    int epfd = epoll_create1(EPOLL_CLOEXEC);

    // Add server socket to epoll
    struct epoll_event ev = {
        .events  = EPOLLIN,
        .data.fd = server_fd,
    };
    epoll_ctl(epfd, EPOLL_CTL_ADD, server_fd, &ev);

    struct epoll_event events[MAX_EVENTS];

    printf("Listening on :8080\n");

    while (1) {
        int nfds = epoll_wait(epfd, events, MAX_EVENTS, -1);

        for (int i = 0; i < nfds; i++) {
            int fd = events[i].data.fd;

            if (fd == server_fd) {
                // Accept all pending connections
                while (1) {
                    int conn_fd = accept4(server_fd, NULL, NULL,
                                          SOCK_NONBLOCK | SOCK_CLOEXEC);
                    if (conn_fd == -1) {
                        if (errno == EAGAIN || errno == EWOULDBLOCK) break;
                        if (errno == EINTR) continue;
                        perror("accept4");
                        break;
                    }

                    Connection *c = new_connection(conn_fd);

                    // Add connection with ET mode and one-shot
                    // EPOLLONESHOT requires re-arming after each event,
                    // which is great for thread pools
                    struct epoll_event cev = {
                        .events   = EPOLLIN | EPOLLET | EPOLLONESHOT | EPOLLRDHUP,
                        .data.ptr = c,
                    };
                    epoll_ctl(epfd, EPOLL_CTL_ADD, conn_fd, &cev);
                }
            } else {
                Connection *c = (Connection *)events[i].data.ptr;

                if (events[i].events & (EPOLLRDHUP | EPOLLERR | EPOLLHUP)) {
                    // Connection closed or error
                    epoll_ctl(epfd, EPOLL_CTL_DEL, c->fd, NULL);
                    free_connection(c);
                    continue;
                }

                if (events[i].events & EPOLLIN) {
                    if (handle_read(epfd, c) < 0) {
                        epoll_ctl(epfd, EPOLL_CTL_DEL, c->fd, NULL);
                        free_connection(c);
                        continue;
                    }

                    // Re-arm the event (required for EPOLLONESHOT)
                    struct epoll_event cev = {
                        .events   = EPOLLIN | EPOLLET | EPOLLONESHOT | EPOLLRDHUP,
                        .data.ptr = c,
                    };
                    epoll_ctl(epfd, EPOLL_CTL_MOD, c->fd, &cev);
                }
            }
        }
    }
}
```

## inotify: Filesystem Event Monitoring

inotify provides efficient kernel-level notification for filesystem changes, used by file watchers, hot-reload systems, and log rotation triggers:

```c
// inotify_watcher.c
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/inotify.h>
#include <errno.h>

#define EVENT_SIZE  sizeof(struct inotify_event)
#define BUF_LEN     (1024 * (EVENT_SIZE + 16))

int main(int argc, char *argv[]) {
    if (argc < 2) {
        fprintf(stderr, "Usage: %s <path> [path...]\n", argv[0]);
        return 1;
    }

    int inotify_fd = inotify_init1(IN_NONBLOCK | IN_CLOEXEC);
    if (inotify_fd == -1) { perror("inotify_init1"); return 1; }

    // Watch each path
    for (int i = 1; i < argc; i++) {
        int wd = inotify_add_watch(inotify_fd, argv[i],
            IN_CREATE     |   // File created in watched directory
            IN_DELETE     |   // File deleted
            IN_MODIFY     |   // File content modified
            IN_MOVED_FROM |   // File moved away from watched dir
            IN_MOVED_TO   |   // File moved into watched dir
            IN_CLOSE_WRITE    // File opened for write then closed
        );
        if (wd == -1) {
            perror("inotify_add_watch");
            continue;
        }
        printf("Watching %s (wd=%d)\n", argv[i], wd);
    }

    // Use epoll to wait for inotify events
    int epfd = epoll_create1(EPOLL_CLOEXEC);
    struct epoll_event ev = {.events = EPOLLIN, .data.fd = inotify_fd};
    epoll_ctl(epfd, EPOLL_CTL_ADD, inotify_fd, &ev);

    char buf[BUF_LEN] __attribute__((aligned(__alignof__(struct inotify_event))));

    while (1) {
        struct epoll_event events[8];
        int nfds = epoll_wait(epfd, events, 8, -1);

        if (nfds <= 0) continue;

        ssize_t len = read(inotify_fd, buf, sizeof(buf));
        if (len <= 0) {
            if (errno == EAGAIN) continue;
            perror("read inotify");
            break;
        }

        // Process all events in the buffer
        const struct inotify_event *event;
        for (char *ptr = buf; ptr < buf + len;
             ptr += EVENT_SIZE + event->len) {

            event = (const struct inotify_event *)ptr;

            printf("wd=%d mask=0x%08x cookie=%u",
                   event->wd, event->mask, event->cookie);

            if (event->len) printf(" name=%s", event->name);

            if (event->mask & IN_CREATE)      printf(" [CREATE]");
            if (event->mask & IN_DELETE)      printf(" [DELETE]");
            if (event->mask & IN_MODIFY)      printf(" [MODIFY]");
            if (event->mask & IN_MOVED_FROM)  printf(" [MOVED_FROM]");
            if (event->mask & IN_MOVED_TO)    printf(" [MOVED_TO]");
            if (event->mask & IN_CLOSE_WRITE) printf(" [CLOSE_WRITE]");
            if (event->mask & IN_ISDIR)       printf(" [DIR]");
            if (event->mask & IN_Q_OVERFLOW)  printf(" [QUEUE_OVERFLOW]");
            printf("\n");
        }
    }

    close(inotify_fd);
    close(epfd);
    return 0;
}
```

```bash
# Kernel limit for inotify watches
cat /proc/sys/fs/inotify/max_user_watches
# 65536 (default)

# Increase for large directory trees
sysctl -w fs.inotify.max_user_watches=524288
sysctl -w fs.inotify.max_user_instances=256
sysctl -w fs.inotify.max_queued_events=32768

# Persist in sysctl.conf
echo "fs.inotify.max_user_watches=524288" >> /etc/sysctl.conf
```

## eventfd and timerfd

`eventfd` provides an efficient event notification channel (essentially a counter) without requiring a full socket pair:

```c
#include <sys/eventfd.h>
#include <sys/timerfd.h>

// eventfd: lightweight event notification
void eventfd_example(void) {
    // Create an eventfd counter, initial value 0
    // EFD_NONBLOCK: don't block if no events
    // EFD_CLOEXEC: close on exec
    int efd = eventfd(0, EFD_NONBLOCK | EFD_CLOEXEC);

    // Add to epoll
    int epfd = epoll_create1(EPOLL_CLOEXEC);
    struct epoll_event ev = {.events = EPOLLIN, .data.fd = efd};
    epoll_ctl(epfd, EPOLL_CTL_ADD, efd, &ev);

    // Signal the event from another thread/process
    // (can be called from signal handler too)
    uint64_t value = 1;
    write(efd, &value, sizeof(value));

    // Receive the event
    struct epoll_event events[1];
    epoll_wait(epfd, events, 1, -1);

    uint64_t count;
    read(efd, &count, sizeof(count));  // Resets counter to 0
    printf("Received %lu events\n", count);

    close(efd);
    close(epfd);
}

// timerfd: timer as a file descriptor (integrates with epoll)
void timerfd_example(void) {
    int tfd = timerfd_create(CLOCK_MONOTONIC, TFD_NONBLOCK | TFD_CLOEXEC);

    struct itimerspec its = {
        .it_interval = {.tv_sec = 1, .tv_nsec = 0},  // Repeat every 1 second
        .it_value    = {.tv_sec = 1, .tv_nsec = 0},  // First fire after 1 second
    };
    timerfd_settime(tfd, 0, &its, NULL);

    int epfd = epoll_create1(EPOLL_CLOEXEC);
    struct epoll_event ev = {.events = EPOLLIN, .data.fd = tfd};
    epoll_ctl(epfd, EPOLL_CTL_ADD, tfd, &ev);

    struct epoll_event events[1];
    for (int i = 0; i < 5; i++) {
        epoll_wait(epfd, events, 1, -1);

        uint64_t expirations;
        read(tfd, &expirations, sizeof(expirations));
        printf("Timer fired %lu times\n", expirations);
    }

    close(tfd);
    close(epfd);
}
```

## Go Perspective: How net/http Uses epoll

Go's runtime uses epoll internally through the netpoller:

```go
// Understanding Go's netpoller — what happens when you call net.Listen
package main

import (
    "fmt"
    "net"
    "runtime"
)

// Go's net package transparently manages epoll
// Every goroutine blocked on I/O parks the goroutine (not the OS thread)
// while the netpoller waits for epoll events

func demonstrateGoNetpoller() {
    // This creates an OS socket and adds it to Go's internal epoll set
    ln, err := net.Listen("tcp", ":8080")
    if err != nil {
        panic(err)
    }
    defer ln.Close()

    // Each Accept() call creates a new goroutine — lightweight (2KB stack)
    // not a new OS thread. 100,000 goroutines is feasible.
    for {
        conn, err := ln.Accept()
        if err != nil {
            break
        }
        go handleConn(conn)  // New goroutine per connection
    }
}

// Setting GOMAXPROCS affects how many OS threads run goroutines
// For I/O-bound servers, I/O concurrency >> CPU concurrency
func tuneForIO() {
    // Default GOMAXPROCS = number of CPUs
    // For I/O-heavy workloads, more goroutines blocking on I/O is fine
    // because they're parked, not consuming OS threads
    fmt.Printf("GOMAXPROCS: %d\n", runtime.GOMAXPROCS(0))
    fmt.Printf("NumCPU: %d\n", runtime.NumCPU())
    fmt.Printf("NumGoroutine: %d\n", runtime.NumGoroutine())
}
```

### Tuning Go's netpoller

```go
// For extremely high-concurrency servers, tune these settings:
package main

import (
    "net/http"
    "time"
)

func buildHighConcurrencyServer() *http.Server {
    return &http.Server{
        Addr:    ":8080",
        Handler: http.DefaultServeMux,

        // These timeouts map to specific epoll wait durations
        ReadTimeout:       15 * time.Second,
        WriteTimeout:      15 * time.Second,
        IdleTimeout:       120 * time.Second,
        ReadHeaderTimeout: 5 * time.Second,

        // Controls the size of the accept backlog
        // Increase if you see "connection refused" under burst load
        // This is also controlled by net.core.somaxconn kernel parameter
    }
}
```

## Monitoring File Descriptor Usage

```bash
# Real-time FD usage monitoring
watch -n 1 'cat /proc/sys/fs/file-nr; echo; ls /proc/$(pgrep my-server)/fd/ | wc -l'

# Find processes with high FD usage
for pid in $(ls /proc | grep -E '^[0-9]+$'); do
    count=$(ls /proc/$pid/fd 2>/dev/null | wc -l)
    if [ "$count" -gt 500 ]; then
        name=$(cat /proc/$pid/comm 2>/dev/null)
        echo "$count  $pid  $name"
    fi
done | sort -rn | head -20

# Check for FD leaks in a process (watch the count grow)
PID=$(pgrep my-server)
while true; do
    COUNT=$(ls /proc/$PID/fd/ 2>/dev/null | wc -l)
    echo "$(date +%H:%M:%S) FDs: $COUNT"
    sleep 5
done
```

```yaml
# Prometheus alert for FD exhaustion
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: fd-exhaustion-alerts
spec:
  groups:
    - name: fd.rules
      rules:
        - alert: ProcessNearFDLimit
          expr: |
            process_open_fds / process_max_fds > 0.80
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Process {{ $labels.job }} is using {{ humanizePercentage $value }} of its FD limit"

        - alert: SystemFDExhaustion
          expr: |
            node_filefd_allocated / node_filefd_maximum > 0.90
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "System is at {{ humanizePercentage $value }} FD capacity"
```

## Key Takeaways

File descriptor management underlies every high-concurrency server on Linux:

1. **The three limits**: `/proc/sys/fs/file-max` (system total), `fs.nr_open` (per-process maximum), and the `ulimit -n` soft/hard limits. All three must be configured for high-concurrency applications. Missing any one will cap your server at a lower limit than expected.

2. **epoll scales where select and poll do not**. The difference is architectural: select and poll scan all registered FDs on every call (O(n)), while epoll only returns FDs that have events (O(1) registration, O(events) notification). At 1,000 connections, select and epoll are comparable. At 100,000 connections, select becomes unusable.

3. **Edge-triggered (EPOLLET) requires exhaustive reads**. With ET mode, you receive exactly one notification when data arrives. You MUST read in a loop until EAGAIN. Failing to do so leaves data in the kernel buffer that you'll never be notified about again — the classic edge-triggered bug.

4. **EPOLLONESHOT enables thread pool integration**. Adding EPOLLONESHOT to your event flags means a socket generates exactly one event before being deactivated. After processing, re-arm it with EPOLL_CTL_MOD. This prevents multiple threads from receiving events for the same connection simultaneously, eliminating a common race condition.

5. **inotify is the correct mechanism for filesystem watching**. Tools that poll directories with repeated `stat()` calls waste syscalls unnecessarily. inotify delivers kernel-level notifications with no polling cost. Remember to increase `fs.inotify.max_user_watches` when watching large directory trees — the default of 65,536 is insufficient for projects with many files.

6. **timerfd and eventfd integrate cleanly with epoll**. Rather than managing separate timer threads or signal handlers, timerfd provides timer events through the same epoll loop as network I/O. eventfd provides a file-descriptor-based inter-thread notification that avoids the complexity of pipes or mutexes for simple signaling.
