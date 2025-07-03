---
title: "Linux Network Programming Mastery: From Sockets to High-Performance Servers"
date: 2025-02-09T10:00:00-05:00
draft: false
tags: ["Linux", "Networking", "Sockets", "TCP/IP", "epoll", "Performance", "Systems Programming"]
categories:
- Linux
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Master Linux network programming from basic sockets to advanced techniques including epoll, io_uring, zero-copy networking, and building high-performance network servers"
more_link: "yes"
url: "/linux-network-programming-mastery/"
---

Network programming is at the heart of modern distributed systems. Linux provides powerful APIs and kernel features for building everything from simple TCP clients to massive-scale web servers. This guide explores advanced network programming techniques, performance optimization strategies, and the latest kernel innovations like io_uring.

<!--more-->

# [Linux Network Programming Mastery](#linux-network-programming)

## Socket Programming Fundamentals

### Beyond Basic Sockets

```c
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <fcntl.h>
#include <unistd.h>

// Advanced socket creation with options
int create_server_socket(const char* bind_addr, int port) {
    int sock = socket(AF_INET, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
    if (sock < 0) {
        perror("socket");
        return -1;
    }
    
    // Enable address reuse
    int reuse = 1;
    setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
    setsockopt(sock, SOL_SOCKET, SO_REUSEPORT, &reuse, sizeof(reuse));
    
    // TCP optimizations
    int nodelay = 1;
    setsockopt(sock, IPPROTO_TCP, TCP_NODELAY, &nodelay, sizeof(nodelay));
    
    // Enable TCP Fast Open
    int qlen = 10;
    setsockopt(sock, SOL_TCP, TCP_FASTOPEN, &qlen, sizeof(qlen));
    
    // Set send/receive buffer sizes
    int bufsize = 256 * 1024;  // 256KB
    setsockopt(sock, SOL_SOCKET, SO_SNDBUF, &bufsize, sizeof(bufsize));
    setsockopt(sock, SOL_SOCKET, SO_RCVBUF, &bufsize, sizeof(bufsize));
    
    // Enable keepalive with custom parameters
    int keepalive = 1;
    int keepidle = 60;     // Start keepalives after 60 seconds
    int keepintvl = 10;    // Interval between keepalives
    int keepcnt = 6;       // Number of keepalives before death
    
    setsockopt(sock, SOL_SOCKET, SO_KEEPALIVE, &keepalive, sizeof(keepalive));
    setsockopt(sock, IPPROTO_TCP, TCP_KEEPIDLE, &keepidle, sizeof(keepidle));
    setsockopt(sock, IPPROTO_TCP, TCP_KEEPINTVL, &keepintvl, sizeof(keepintvl));
    setsockopt(sock, IPPROTO_TCP, TCP_KEEPCNT, &keepcnt, sizeof(keepcnt));
    
    // Bind to address
    struct sockaddr_in addr = {
        .sin_family = AF_INET,
        .sin_port = htons(port),
    };
    inet_pton(AF_INET, bind_addr, &addr.sin_addr);
    
    if (bind(sock, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
        perror("bind");
        close(sock);
        return -1;
    }
    
    // Listen with larger backlog
    if (listen(sock, SOMAXCONN) < 0) {
        perror("listen");
        close(sock);
        return -1;
    }
    
    return sock;
}

// Zero-copy socket operations
ssize_t zero_copy_send_file(int out_sock, int in_fd, off_t offset, size_t count) {
    // Use sendfile for zero-copy transfer
    ssize_t sent = sendfile(out_sock, in_fd, &offset, count);
    
    if (sent < 0 && errno == EINVAL) {
        // Fallback to splice for non-regular files
        int pipefd[2];
        if (pipe(pipefd) < 0) {
            return -1;
        }
        
        ssize_t spliced = splice(in_fd, &offset, pipefd[1], NULL, 
                                count, SPLICE_F_MOVE);
        if (spliced > 0) {
            sent = splice(pipefd[0], NULL, out_sock, NULL, 
                         spliced, SPLICE_F_MOVE | SPLICE_F_MORE);
        }
        
        close(pipefd[0]);
        close(pipefd[1]);
    }
    
    return sent;
}

// Advanced accept with connection info
typedef struct {
    int fd;
    struct sockaddr_storage addr;
    socklen_t addr_len;
    char ip_str[INET6_ADDRSTRLEN];
    int port;
} connection_t;

int accept_connection(int server_sock, connection_t* conn) {
    conn->addr_len = sizeof(conn->addr);
    
    // Accept with flags
    conn->fd = accept4(server_sock, 
                      (struct sockaddr*)&conn->addr, 
                      &conn->addr_len,
                      SOCK_NONBLOCK | SOCK_CLOEXEC);
    
    if (conn->fd < 0) {
        return -1;
    }
    
    // Extract connection info
    if (conn->addr.ss_family == AF_INET) {
        struct sockaddr_in* s = (struct sockaddr_in*)&conn->addr;
        inet_ntop(AF_INET, &s->sin_addr, conn->ip_str, sizeof(conn->ip_str));
        conn->port = ntohs(s->sin_port);
    } else if (conn->addr.ss_family == AF_INET6) {
        struct sockaddr_in6* s = (struct sockaddr_in6*)&conn->addr;
        inet_ntop(AF_INET6, &s->sin6_addr, conn->ip_str, sizeof(conn->ip_str));
        conn->port = ntohs(s->sin6_port);
    }
    
    // Get socket info
    int sndbuf, rcvbuf;
    socklen_t optlen = sizeof(sndbuf);
    getsockopt(conn->fd, SOL_SOCKET, SO_SNDBUF, &sndbuf, &optlen);
    getsockopt(conn->fd, SOL_SOCKET, SO_RCVBUF, &rcvbuf, &optlen);
    
    printf("Accepted connection from %s:%d (fd=%d, sndbuf=%d, rcvbuf=%d)\n",
           conn->ip_str, conn->port, conn->fd, sndbuf, rcvbuf);
    
    return 0;
}
```

### IPv6 and Dual-Stack Programming

```c
// Create dual-stack socket (IPv4 and IPv6)
int create_dual_stack_socket(int port) {
    int sock = socket(AF_INET6, SOCK_STREAM, 0);
    if (sock < 0) {
        perror("socket");
        return -1;
    }
    
    // Disable IPv6-only to enable dual-stack
    int no = 0;
    setsockopt(sock, IPPROTO_IPV6, IPV6_V6ONLY, &no, sizeof(no));
    
    // Reuse address
    int yes = 1;
    setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
    
    // Bind to all interfaces
    struct sockaddr_in6 addr = {
        .sin6_family = AF_INET6,
        .sin6_port = htons(port),
        .sin6_addr = in6addr_any
    };
    
    if (bind(sock, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
        perror("bind");
        close(sock);
        return -1;
    }
    
    listen(sock, SOMAXCONN);
    return sock;
}

// Address-family agnostic connection
int connect_to_host(const char* hostname, const char* service) {
    struct addrinfo hints = {
        .ai_family = AF_UNSPEC,     // IPv4 or IPv6
        .ai_socktype = SOCK_STREAM,
        .ai_flags = AI_ADDRCONFIG   // Only return supported address families
    };
    
    struct addrinfo* result;
    int ret = getaddrinfo(hostname, service, &hints, &result);
    if (ret != 0) {
        fprintf(stderr, "getaddrinfo: %s\n", gai_strerror(ret));
        return -1;
    }
    
    int sock = -1;
    
    // Try each address until one connects
    for (struct addrinfo* rp = result; rp != NULL; rp = rp->ai_next) {
        sock = socket(rp->ai_family, rp->ai_socktype | SOCK_NONBLOCK, 
                     rp->ai_protocol);
        if (sock < 0) {
            continue;
        }
        
        // Non-blocking connect with timeout
        if (connect(sock, rp->ai_addr, rp->ai_addrlen) == 0) {
            break;  // Success
        }
        
        if (errno == EINPROGRESS) {
            // Wait for connection with timeout
            fd_set wfds;
            FD_ZERO(&wfds);
            FD_SET(sock, &wfds);
            
            struct timeval tv = {.tv_sec = 5, .tv_usec = 0};
            
            if (select(sock + 1, NULL, &wfds, NULL, &tv) > 0) {
                int error;
                socklen_t len = sizeof(error);
                getsockopt(sock, SOL_SOCKET, SO_ERROR, &error, &len);
                
                if (error == 0) {
                    break;  // Connected
                }
            }
        }
        
        close(sock);
        sock = -1;
    }
    
    freeaddrinfo(result);
    return sock;
}
```

## High-Performance I/O Models

### epoll: Scalable Event Notification

```c
#include <sys/epoll.h>

typedef struct {
    int epfd;
    struct epoll_event* events;
    int max_events;
    GHashTable* connections;  // fd -> connection_data
} epoll_server_t;

// Edge-triggered epoll server
epoll_server_t* epoll_server_create(int max_events) {
    epoll_server_t* server = calloc(1, sizeof(epoll_server_t));
    
    server->epfd = epoll_create1(EPOLL_CLOEXEC);
    if (server->epfd < 0) {
        free(server);
        return NULL;
    }
    
    server->max_events = max_events;
    server->events = calloc(max_events, sizeof(struct epoll_event));
    server->connections = g_hash_table_new_full(
        g_direct_hash, g_direct_equal, NULL, free
    );
    
    return server;
}

// Add socket to epoll with edge-triggered mode
int epoll_add_socket(epoll_server_t* server, int fd, void* data) {
    struct epoll_event ev = {
        .events = EPOLLIN | EPOLLOUT | EPOLLET | EPOLLRDHUP,
        .data.ptr = data
    };
    
    if (epoll_ctl(server->epfd, EPOLL_CTL_ADD, fd, &ev) < 0) {
        return -1;
    }
    
    return 0;
}

// High-performance event loop
void epoll_event_loop(epoll_server_t* server, int listen_fd) {
    // Add listening socket
    struct epoll_event ev = {
        .events = EPOLLIN,
        .data.fd = listen_fd
    };
    epoll_ctl(server->epfd, EPOLL_CTL_ADD, listen_fd, &ev);
    
    while (1) {
        int nready = epoll_wait(server->epfd, server->events, 
                               server->max_events, -1);
        
        for (int i = 0; i < nready; i++) {
            struct epoll_event* e = &server->events[i];
            
            if (e->data.fd == listen_fd) {
                // Accept new connections
                while (1) {
                    connection_t* conn = malloc(sizeof(connection_t));
                    if (accept_connection(listen_fd, conn) < 0) {
                        free(conn);
                        if (errno == EAGAIN || errno == EWOULDBLOCK) {
                            break;  // No more connections
                        }
                        continue;
                    }
                    
                    // Add to epoll
                    epoll_add_socket(server, conn->fd, conn);
                    g_hash_table_insert(server->connections, 
                                       GINT_TO_POINTER(conn->fd), conn);
                }
            } else {
                // Handle client connection
                connection_t* conn = e->data.ptr;
                
                if (e->events & (EPOLLHUP | EPOLLERR | EPOLLRDHUP)) {
                    // Connection closed
                    close(conn->fd);
                    g_hash_table_remove(server->connections, 
                                       GINT_TO_POINTER(conn->fd));
                    continue;
                }
                
                if (e->events & EPOLLIN) {
                    // Data available to read
                    handle_read(conn);
                }
                
                if (e->events & EPOLLOUT) {
                    // Socket ready for writing
                    handle_write(conn);
                }
            }
        }
    }
}

// Efficient buffer management
typedef struct {
    char* data;
    size_t size;
    size_t used;
    size_t read_pos;
} buffer_t;

void handle_read(connection_t* conn) {
    buffer_t* buf = get_connection_buffer(conn);
    
    while (1) {
        // Ensure buffer has space
        if (buf->used == buf->size) {
            buf->size *= 2;
            buf->data = realloc(buf->data, buf->size);
        }
        
        ssize_t n = recv(conn->fd, 
                        buf->data + buf->used, 
                        buf->size - buf->used,
                        MSG_DONTWAIT);
        
        if (n > 0) {
            buf->used += n;
            
            // Process complete messages
            process_buffer(conn, buf);
        } else if (n == 0) {
            // Connection closed
            close_connection(conn);
            break;
        } else {
            if (errno == EAGAIN || errno == EWOULDBLOCK) {
                // No more data available
                break;
            } else if (errno == EINTR) {
                // Interrupted, retry
                continue;
            } else {
                // Error
                perror("recv");
                close_connection(conn);
                break;
            }
        }
    }
}
```

### io_uring: The Future of Linux I/O

```c
#include <liburing.h>

typedef struct {
    struct io_uring ring;
    int listen_fd;
    GHashTable* connections;
} uring_server_t;

// Initialize io_uring
uring_server_t* uring_server_create(unsigned entries) {
    uring_server_t* server = calloc(1, sizeof(uring_server_t));
    
    struct io_uring_params params = {
        .flags = IORING_SETUP_SQPOLL | IORING_SETUP_SQ_AFF,
        .sq_thread_cpu = 0,
        .sq_thread_idle = 2000  // 2 seconds
    };
    
    if (io_uring_queue_init_params(entries, &server->ring, &params) < 0) {
        free(server);
        return NULL;
    }
    
    // Enable rings features
    if (params.features & IORING_FEAT_FAST_POLL) {
        printf("Fast poll supported\n");
    }
    
    server->connections = g_hash_table_new_full(
        g_direct_hash, g_direct_equal, NULL, free
    );
    
    return server;
}

// Submit accept operation
void uring_submit_accept(uring_server_t* server) {
    struct io_uring_sqe* sqe = io_uring_get_sqe(&server->ring);
    
    connection_t* conn = calloc(1, sizeof(connection_t));
    conn->addr_len = sizeof(conn->addr);
    
    io_uring_prep_accept(sqe, server->listen_fd, 
                        (struct sockaddr*)&conn->addr,
                        &conn->addr_len, 
                        SOCK_NONBLOCK | SOCK_CLOEXEC);
    
    io_uring_sqe_set_data(sqe, conn);
    io_uring_sqe_set_flags(sqe, IOSQE_ASYNC);
}

// Submit read operation
void uring_submit_read(uring_server_t* server, connection_t* conn) {
    struct io_uring_sqe* sqe = io_uring_get_sqe(&server->ring);
    
    buffer_t* buf = get_connection_buffer(conn);
    
    io_uring_prep_recv(sqe, conn->fd,
                      buf->data + buf->used,
                      buf->size - buf->used,
                      MSG_DONTWAIT);
    
    io_uring_sqe_set_data(sqe, conn);
}

// Submit write operation with linked operations
void uring_submit_write_chain(uring_server_t* server, 
                             connection_t* conn,
                             struct iovec* iovs, 
                             int iovcnt) {
    struct io_uring_sqe* sqe;
    
    // First: write data
    sqe = io_uring_get_sqe(&server->ring);
    io_uring_prep_writev(sqe, conn->fd, iovs, iovcnt, 0);
    io_uring_sqe_set_data(sqe, conn);
    io_uring_sqe_set_flags(sqe, IOSQE_IO_LINK);
    
    // Then: fsync if needed
    sqe = io_uring_get_sqe(&server->ring);
    io_uring_prep_fsync(sqe, conn->fd, IORING_FSYNC_DATASYNC);
    io_uring_sqe_set_data(sqe, conn);
    io_uring_sqe_set_flags(sqe, IOSQE_IO_LINK);
    
    // Finally: submit next read
    uring_submit_read(server, conn);
}

// High-performance io_uring event loop
void uring_event_loop(uring_server_t* server) {
    // Submit initial accept
    uring_submit_accept(server);
    io_uring_submit(&server->ring);
    
    struct io_uring_cqe* cqe;
    
    while (1) {
        // Wait for completion
        if (io_uring_wait_cqe(&server->ring, &cqe) < 0) {
            continue;
        }
        
        // Process completion
        connection_t* conn = io_uring_cqe_get_data(cqe);
        int res = cqe->res;
        
        if (res < 0) {
            // Handle error
            if (res == -EAGAIN || res == -EINTR) {
                // Retry operation
                uring_submit_read(server, conn);
            } else {
                // Fatal error, close connection
                close(conn->fd);
                free(conn);
            }
        } else {
            // Success, handle based on operation type
            if (conn->fd == 0) {
                // Accept completed
                conn->fd = res;
                g_hash_table_insert(server->connections,
                                   GINT_TO_POINTER(conn->fd), conn);
                
                // Submit first read
                uring_submit_read(server, conn);
                
                // Submit next accept
                uring_submit_accept(server);
            } else {
                // Read/write completed
                if (res == 0) {
                    // EOF, close connection
                    close(conn->fd);
                    g_hash_table_remove(server->connections,
                                       GINT_TO_POINTER(conn->fd));
                } else {
                    // Process data and submit next operation
                    process_data(conn, res);
                    uring_submit_read(server, conn);
                }
            }
        }
        
        // Mark CQE as seen
        io_uring_cqe_seen(&server->ring, cqe);
        
        // Submit all queued operations
        io_uring_submit(&server->ring);
    }
}
```

## Advanced TCP Features

### TCP_FASTOPEN and TFO

```c
// Enable TCP Fast Open on server
void enable_tcp_fastopen_server(int sock) {
    int qlen = 16;  // Max queue length for TFO
    if (setsockopt(sock, SOL_TCP, TCP_FASTOPEN, &qlen, sizeof(qlen)) < 0) {
        perror("TCP_FASTOPEN");
    }
}

// Client-side TFO
ssize_t tcp_fastopen_connect(const char* host, int port, 
                            const void* data, size_t len) {
    int sock = socket(AF_INET, SOCK_STREAM, 0);
    
    struct sockaddr_in addr = {
        .sin_family = AF_INET,
        .sin_port = htons(port)
    };
    inet_pton(AF_INET, host, &addr.sin_addr);
    
    // Send data with SYN
    ssize_t sent = sendto(sock, data, len, MSG_FASTOPEN,
                         (struct sockaddr*)&addr, sizeof(addr));
    
    if (sent < 0) {
        if (errno == EINPROGRESS) {
            // Connection in progress, data will be sent after connect
            return 0;
        }
        return -1;
    }
    
    return sent;
}

// TCP_USER_TIMEOUT for better failure detection
void set_tcp_user_timeout(int sock, unsigned int timeout_ms) {
    setsockopt(sock, IPPROTO_TCP, TCP_USER_TIMEOUT, 
              &timeout_ms, sizeof(timeout_ms));
}

// TCP_CONGESTION control algorithm selection
void set_tcp_congestion_control(int sock, const char* algorithm) {
    if (setsockopt(sock, IPPROTO_TCP, TCP_CONGESTION,
                  algorithm, strlen(algorithm)) < 0) {
        perror("TCP_CONGESTION");
    }
}

// Get TCP connection info
void print_tcp_info(int sock) {
    struct tcp_info info;
    socklen_t len = sizeof(info);
    
    if (getsockopt(sock, IPPROTO_TCP, TCP_INFO, &info, &len) == 0) {
        printf("TCP Info:\n");
        printf("  State: %u\n", info.tcpi_state);
        printf("  CA state: %u\n", info.tcpi_ca_state);
        printf("  Retransmits: %u\n", info.tcpi_retransmits);
        printf("  Probes: %u\n", info.tcpi_probes);
        printf("  Backoff: %u\n", info.tcpi_backoff);
        printf("  RTT: %u us\n", info.tcpi_rtt);
        printf("  RTT variance: %u us\n", info.tcpi_rttvar);
        printf("  Send MSS: %u\n", info.tcpi_snd_mss);
        printf("  Receive MSS: %u\n", info.tcpi_rcv_mss);
        printf("  Send congestion window: %u\n", info.tcpi_snd_cwnd);
        printf("  Bytes acked: %llu\n", info.tcpi_bytes_acked);
        printf("  Bytes received: %llu\n", info.tcpi_bytes_received);
        printf("  Segs out: %u\n", info.tcpi_segs_out);
        printf("  Segs in: %u\n", info.tcpi_segs_in);
    }
}
```

### Socket Buffer Management

```c
// Dynamic socket buffer tuning
void tune_socket_buffers(int sock) {
    // Get current TCP info
    struct tcp_info info;
    socklen_t len = sizeof(info);
    getsockopt(sock, IPPROTO_TCP, TCP_INFO, &info, &len);
    
    // Calculate optimal buffer size based on BDP
    // Buffer = Bandwidth * RTT
    unsigned int rtt_ms = info.tcpi_rtt / 1000;  // Convert to ms
    unsigned int bandwidth_mbps = 1000;  // Assume 1Gbps
    
    size_t optimal_buffer = (bandwidth_mbps * 1000000 / 8) * rtt_ms / 1000;
    
    // Apply with min/max limits
    size_t min_buffer = 64 * 1024;    // 64KB
    size_t max_buffer = 16 * 1024 * 1024;  // 16MB
    
    optimal_buffer = (optimal_buffer < min_buffer) ? min_buffer : optimal_buffer;
    optimal_buffer = (optimal_buffer > max_buffer) ? max_buffer : optimal_buffer;
    
    setsockopt(sock, SOL_SOCKET, SO_SNDBUF, &optimal_buffer, sizeof(optimal_buffer));
    setsockopt(sock, SOL_SOCKET, SO_RCVBUF, &optimal_buffer, sizeof(optimal_buffer));
}

// Memory-mapped socket buffers (experimental)
typedef struct {
    void* tx_ring;
    void* rx_ring;
    size_t ring_size;
    int sock;
} mmap_socket_t;

mmap_socket_t* create_packet_mmap_socket() {
    mmap_socket_t* ms = calloc(1, sizeof(mmap_socket_t));
    
    // Create raw socket for packet mmap
    ms->sock = socket(AF_PACKET, SOCK_RAW, htons(ETH_P_ALL));
    if (ms->sock < 0) {
        free(ms);
        return NULL;
    }
    
    // Setup ring buffer
    struct tpacket_req3 req = {
        .tp_block_size = 1 << 22,  // 4MB blocks
        .tp_block_nr = 16,
        .tp_frame_size = 1 << 11,   // 2KB frames
        .tp_frame_nr = (1 << 22) / (1 << 11) * 16,
        .tp_retire_blk_tov = 60,
        .tp_feature_req_word = TP_FT_REQ_FILL_RXHASH
    };
    
    setsockopt(ms->sock, SOL_PACKET, PACKET_RX_RING, 
              &req, sizeof(req));
    
    // Map ring buffer
    ms->ring_size = req.tp_block_size * req.tp_block_nr;
    ms->rx_ring = mmap(NULL, ms->ring_size,
                      PROT_READ | PROT_WRITE,
                      MAP_SHARED, ms->sock, 0);
    
    if (ms->rx_ring == MAP_FAILED) {
        close(ms->sock);
        free(ms);
        return NULL;
    }
    
    return ms;
}
```

## UDP and Multicast Programming

### High-Performance UDP

```c
// Create UDP socket with optimal settings
int create_udp_socket(int port) {
    int sock = socket(AF_INET, SOCK_DGRAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
    
    // Increase buffer sizes for high-throughput
    int bufsize = 4 * 1024 * 1024;  // 4MB
    setsockopt(sock, SOL_SOCKET, SO_RCVBUF, &bufsize, sizeof(bufsize));
    setsockopt(sock, SOL_SOCKET, SO_SNDBUF, &bufsize, sizeof(bufsize));
    
    // Enable SO_REUSEADDR
    int reuse = 1;
    setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
    
    // Bind
    struct sockaddr_in addr = {
        .sin_family = AF_INET,
        .sin_port = htons(port),
        .sin_addr.s_addr = INADDR_ANY
    };
    bind(sock, (struct sockaddr*)&addr, sizeof(addr));
    
    return sock;
}

// Efficient UDP receive with recvmmsg
void udp_receive_multiple(int sock) {
    #define VLEN 32
    #define BUFSIZE 1500
    
    struct mmsghdr msgs[VLEN];
    struct iovec iovecs[VLEN];
    char bufs[VLEN][BUFSIZE];
    struct sockaddr_in addrs[VLEN];
    
    // Setup message structures
    for (int i = 0; i < VLEN; i++) {
        iovecs[i].iov_base = bufs[i];
        iovecs[i].iov_len = BUFSIZE;
        
        msgs[i].msg_hdr.msg_name = &addrs[i];
        msgs[i].msg_hdr.msg_namelen = sizeof(addrs[i]);
        msgs[i].msg_hdr.msg_iov = &iovecs[i];
        msgs[i].msg_hdr.msg_iovlen = 1;
        msgs[i].msg_hdr.msg_control = NULL;
        msgs[i].msg_hdr.msg_controllen = 0;
        msgs[i].msg_hdr.msg_flags = 0;
    }
    
    // Receive multiple messages
    int retval = recvmmsg(sock, msgs, VLEN, MSG_DONTWAIT, NULL);
    
    if (retval > 0) {
        for (int i = 0; i < retval; i++) {
            char addr_str[INET_ADDRSTRLEN];
            inet_ntop(AF_INET, &addrs[i].sin_addr, 
                     addr_str, sizeof(addr_str));
            
            printf("Received %d bytes from %s:%d\n",
                   msgs[i].msg_len, addr_str, ntohs(addrs[i].sin_port));
            
            // Process message
            process_udp_message(bufs[i], msgs[i].msg_len);
        }
    }
}

// Multicast setup
void setup_multicast_receiver(int sock, const char* mcast_addr, int port) {
    // Join multicast group
    struct ip_mreq mreq;
    inet_pton(AF_INET, mcast_addr, &mreq.imr_multiaddr);
    mreq.imr_interface.s_addr = INADDR_ANY;
    
    setsockopt(sock, IPPROTO_IP, IP_ADD_MEMBERSHIP, &mreq, sizeof(mreq));
    
    // Set multicast TTL
    int ttl = 64;
    setsockopt(sock, IPPROTO_IP, IP_MULTICAST_TTL, &ttl, sizeof(ttl));
    
    // Disable loopback
    int loop = 0;
    setsockopt(sock, IPPROTO_IP, IP_MULTICAST_LOOP, &loop, sizeof(loop));
}

// Source-specific multicast (SSM)
void setup_ssm_receiver(int sock, const char* source, 
                       const char* group, int port) {
    struct ip_mreq_source mreq;
    
    inet_pton(AF_INET, source, &mreq.imr_sourceaddr);
    inet_pton(AF_INET, group, &mreq.imr_multiaddr);
    mreq.imr_interface.s_addr = INADDR_ANY;
    
    setsockopt(sock, IPPROTO_IP, IP_ADD_SOURCE_MEMBERSHIP, 
              &mreq, sizeof(mreq));
}
```

## Raw Sockets and Packet Crafting

### Custom Protocol Implementation

```c
#include <netinet/ip.h>
#include <netinet/tcp.h>
#include <linux/if_ether.h>

// Calculate checksums
uint16_t calculate_checksum(uint16_t* data, int len) {
    uint32_t sum = 0;
    
    while (len > 1) {
        sum += *data++;
        len -= 2;
    }
    
    if (len == 1) {
        sum += *(uint8_t*)data;
    }
    
    sum = (sum >> 16) + (sum & 0xFFFF);
    sum += (sum >> 16);
    
    return ~sum;
}

// Craft custom TCP packet
void send_raw_tcp_packet(const char* src_ip, int src_port,
                        const char* dst_ip, int dst_port,
                        const char* data, size_t data_len) {
    // Create raw socket
    int sock = socket(AF_INET, SOCK_RAW, IPPROTO_RAW);
    if (sock < 0) {
        perror("socket");
        return;
    }
    
    // Tell kernel we're providing IP header
    int on = 1;
    setsockopt(sock, IPPROTO_IP, IP_HDRINCL, &on, sizeof(on));
    
    // Allocate packet buffer
    size_t packet_size = sizeof(struct iphdr) + sizeof(struct tcphdr) + data_len;
    uint8_t* packet = calloc(1, packet_size);
    
    // IP header
    struct iphdr* iph = (struct iphdr*)packet;
    iph->version = 4;
    iph->ihl = 5;
    iph->tos = 0;
    iph->tot_len = htons(packet_size);
    iph->id = htons(54321);
    iph->frag_off = 0;
    iph->ttl = 64;
    iph->protocol = IPPROTO_TCP;
    iph->check = 0;  // Will calculate later
    inet_pton(AF_INET, src_ip, &iph->saddr);
    inet_pton(AF_INET, dst_ip, &iph->daddr);
    
    // TCP header
    struct tcphdr* tcph = (struct tcphdr*)(packet + sizeof(struct iphdr));
    tcph->source = htons(src_port);
    tcph->dest = htons(dst_port);
    tcph->seq = htonl(1);
    tcph->ack_seq = 0;
    tcph->doff = 5;
    tcph->syn = 1;
    tcph->window = htons(65535);
    tcph->check = 0;  // Will calculate later
    tcph->urg_ptr = 0;
    
    // Copy data
    if (data_len > 0) {
        memcpy(packet + sizeof(struct iphdr) + sizeof(struct tcphdr), 
               data, data_len);
    }
    
    // Calculate IP checksum
    iph->check = calculate_checksum((uint16_t*)iph, sizeof(struct iphdr));
    
    // Calculate TCP checksum (with pseudo header)
    struct {
        uint32_t src_addr;
        uint32_t dst_addr;
        uint8_t zero;
        uint8_t protocol;
        uint16_t tcp_len;
    } pseudo_header;
    
    pseudo_header.src_addr = iph->saddr;
    pseudo_header.dst_addr = iph->daddr;
    pseudo_header.zero = 0;
    pseudo_header.protocol = IPPROTO_TCP;
    pseudo_header.tcp_len = htons(sizeof(struct tcphdr) + data_len);
    
    // Create buffer for checksum calculation
    size_t pseudo_size = sizeof(pseudo_header) + sizeof(struct tcphdr) + data_len;
    uint8_t* pseudo_packet = malloc(pseudo_size);
    
    memcpy(pseudo_packet, &pseudo_header, sizeof(pseudo_header));
    memcpy(pseudo_packet + sizeof(pseudo_header), tcph, 
           sizeof(struct tcphdr) + data_len);
    
    tcph->check = calculate_checksum((uint16_t*)pseudo_packet, pseudo_size);
    free(pseudo_packet);
    
    // Send packet
    struct sockaddr_in dest = {
        .sin_family = AF_INET,
        .sin_port = htons(dst_port)
    };
    inet_pton(AF_INET, dst_ip, &dest.sin_addr);
    
    if (sendto(sock, packet, packet_size, 0, 
              (struct sockaddr*)&dest, sizeof(dest)) < 0) {
        perror("sendto");
    }
    
    free(packet);
    close(sock);
}

// Packet capture with BPF filter
void capture_packets(const char* filter_expr) {
    // Create packet socket
    int sock = socket(AF_PACKET, SOCK_RAW, htons(ETH_P_ALL));
    if (sock < 0) {
        perror("socket");
        return;
    }
    
    // Compile and attach BPF filter
    struct sock_fprog bpf;
    struct sock_filter bpf_code[] = {
        // Example: capture only TCP packets
        { 0x28, 0, 0, 0x0000000c },  // ldh [12]
        { 0x15, 0, 8, 0x000086dd },  // jeq #0x86dd, IPv6
        { 0x30, 0, 0, 0x00000014 },  // ldb [20]
        { 0x15, 2, 0, 0x00000006 },  // jeq #0x6, TCP
        { 0x15, 1, 0, 0x00000011 },  // jeq #0x11, UDP
        { 0x15, 0, 5, 0x00000001 },  // jeq #0x1, ICMP
        { 0x28, 0, 0, 0x0000000c },  // ldh [12]
        { 0x15, 0, 3, 0x00000800 },  // jeq #0x800, IPv4
        { 0x30, 0, 0, 0x00000017 },  // ldb [23]
        { 0x15, 0, 1, 0x00000006 },  // jeq #0x6, TCP
        { 0x6, 0, 0, 0x00040000 },   // ret #262144
        { 0x6, 0, 0, 0x00000000 },   // ret #0
    };
    
    bpf.len = sizeof(bpf_code) / sizeof(struct sock_filter);
    bpf.filter = bpf_code;
    
    setsockopt(sock, SOL_SOCKET, SO_ATTACH_FILTER, &bpf, sizeof(bpf));
    
    // Capture packets
    uint8_t buffer[65536];
    
    while (1) {
        ssize_t len = recv(sock, buffer, sizeof(buffer), 0);
        if (len > 0) {
            // Parse Ethernet header
            struct ethhdr* eth = (struct ethhdr*)buffer;
            
            printf("Packet captured: %zu bytes, proto=0x%04x\n",
                   len, ntohs(eth->h_proto));
            
            // Process based on protocol
            if (ntohs(eth->h_proto) == ETH_P_IP) {
                struct iphdr* iph = (struct iphdr*)(buffer + sizeof(struct ethhdr));
                printf("  IPv4: src=%08x dst=%08x proto=%d\n",
                       ntohl(iph->saddr), ntohl(iph->daddr), iph->protocol);
            }
        }
    }
    
    close(sock);
}
```

## Network Performance Optimization

### Zero-Copy Networking

```c
// MSG_ZEROCOPY for TCP
void tcp_zerocopy_send(int sock, void* buf, size_t len) {
    // Enable MSG_ZEROCOPY
    int on = 1;
    setsockopt(sock, SOL_SOCKET, SO_ZEROCOPY, &on, sizeof(on));
    
    // Send with MSG_ZEROCOPY flag
    ssize_t sent = send(sock, buf, len, MSG_ZEROCOPY);
    
    if (sent < 0) {
        perror("send");
        return;
    }
    
    // Check for completion notification
    struct msghdr msg = {0};
    struct sock_extended_err* serr;
    struct cmsghdr* cmsg;
    char control[100];
    
    msg.msg_control = control;
    msg.msg_controllen = sizeof(control);
    
    if (recvmsg(sock, &msg, MSG_ERRQUEUE) < 0) {
        return;
    }
    
    // Process completion
    for (cmsg = CMSG_FIRSTHDR(&msg); cmsg; cmsg = CMSG_NXTHDR(&msg, cmsg)) {
        if (cmsg->cmsg_level == SOL_IP && cmsg->cmsg_type == IP_RECVERR) {
            serr = (struct sock_extended_err*)CMSG_DATA(cmsg);
            if (serr->ee_origin == SO_EE_ORIGIN_ZEROCOPY) {
                printf("Zerocopy completed: %u-%u\n",
                       serr->ee_info, serr->ee_data);
            }
        }
    }
}

// Kernel bypass with AF_XDP
#include <linux/if_xdp.h>

typedef struct {
    void* umem_area;
    size_t umem_size;
    struct xsk_ring_prod fq;
    struct xsk_ring_prod tx;
    struct xsk_ring_cons cq;
    struct xsk_ring_cons rx;
    int xsk_fd;
} xdp_socket_t;

xdp_socket_t* create_xdp_socket(const char* ifname, int queue_id) {
    xdp_socket_t* xsk = calloc(1, sizeof(xdp_socket_t));
    
    // Allocate UMEM
    xsk->umem_size = 1 << 24;  // 16MB
    xsk->umem_area = mmap(NULL, xsk->umem_size,
                         PROT_READ | PROT_WRITE,
                         MAP_PRIVATE | MAP_ANONYMOUS | MAP_HUGETLB,
                         -1, 0);
    
    // Create XDP socket
    struct sockaddr_xdp sxdp = {
        .sxdp_family = AF_XDP,
        .sxdp_ifindex = if_nametoindex(ifname),
        .sxdp_queue_id = queue_id,
    };
    
    xsk->xsk_fd = socket(AF_XDP, SOCK_RAW, 0);
    
    // Setup UMEM
    struct xdp_umem_reg mr = {
        .addr = (uint64_t)xsk->umem_area,
        .len = xsk->umem_size,
        .chunk_size = 2048,
        .headroom = 0,
    };
    
    setsockopt(xsk->xsk_fd, SOL_XDP, XDP_UMEM_REG, &mr, sizeof(mr));
    
    // Setup rings
    int ring_size = 2048;
    setsockopt(xsk->xsk_fd, SOL_XDP, XDP_UMEM_FILL_RING, 
              &ring_size, sizeof(ring_size));
    setsockopt(xsk->xsk_fd, SOL_XDP, XDP_UMEM_COMPLETION_RING,
              &ring_size, sizeof(ring_size));
    setsockopt(xsk->xsk_fd, SOL_XDP, XDP_RX_RING,
              &ring_size, sizeof(ring_size));
    setsockopt(xsk->xsk_fd, SOL_XDP, XDP_TX_RING,
              &ring_size, sizeof(ring_size));
    
    // Bind socket
    bind(xsk->xsk_fd, (struct sockaddr*)&sxdp, sizeof(sxdp));
    
    return xsk;
}
```

### CPU Affinity and NUMA

```c
// Set CPU affinity for network processing
void set_network_cpu_affinity(pthread_t thread, int cpu) {
    cpu_set_t cpuset;
    CPU_ZERO(&cpuset);
    CPU_SET(cpu, &cpuset);
    
    pthread_setaffinity_np(thread, sizeof(cpuset), &cpuset);
}

// NUMA-aware network buffer allocation
void* allocate_numa_network_buffer(size_t size, int numa_node) {
    // Bind to NUMA node
    struct bitmask* bm = numa_bitmask_alloc(numa_num_possible_nodes());
    numa_bitmask_setbit(bm, numa_node);
    numa_set_membind(bm);
    
    // Allocate memory
    void* buffer = mmap(NULL, size,
                       PROT_READ | PROT_WRITE,
                       MAP_PRIVATE | MAP_ANONYMOUS | MAP_HUGETLB,
                       -1, 0);
    
    // Restore default binding
    numa_set_membind(numa_all_nodes_ptr);
    numa_bitmask_free(bm);
    
    return buffer;
}

// Interrupt affinity management
void set_network_irq_affinity(const char* ifname, int cpu) {
    char path[256];
    char command[512];
    
    // Find IRQ numbers for network interface
    snprintf(command, sizeof(command),
             "grep %s /proc/interrupts | awk '{print $1}' | tr -d ':'",
             ifname);
    
    FILE* fp = popen(command, "r");
    if (!fp) return;
    
    char irq[16];
    while (fgets(irq, sizeof(irq), fp)) {
        irq[strcspn(irq, "\n")] = 0;
        
        // Set IRQ affinity
        snprintf(path, sizeof(path), "/proc/irq/%s/smp_affinity", irq);
        
        FILE* affinity = fopen(path, "w");
        if (affinity) {
            fprintf(affinity, "%x\n", 1 << cpu);
            fclose(affinity);
        }
    }
    
    pclose(fp);
}
```

## Network Security

### TLS/SSL Integration

```c
#include <openssl/ssl.h>
#include <openssl/err.h>

// TLS server setup
SSL_CTX* create_tls_server_context() {
    SSL_CTX* ctx = SSL_CTX_new(TLS_server_method());
    
    if (!ctx) {
        ERR_print_errors_fp(stderr);
        return NULL;
    }
    
    // Set minimum TLS version
    SSL_CTX_set_min_proto_version(ctx, TLS1_2_VERSION);
    
    // Load certificate and key
    if (SSL_CTX_use_certificate_file(ctx, "server.crt", SSL_FILETYPE_PEM) <= 0 ||
        SSL_CTX_use_PrivateKey_file(ctx, "server.key", SSL_FILETYPE_PEM) <= 0) {
        ERR_print_errors_fp(stderr);
        SSL_CTX_free(ctx);
        return NULL;
    }
    
    // Verify private key
    if (!SSL_CTX_check_private_key(ctx)) {
        fprintf(stderr, "Private key verification failed\n");
        SSL_CTX_free(ctx);
        return NULL;
    }
    
    // Set cipher suites (modern secure ciphers only)
    SSL_CTX_set_cipher_list(ctx,
        "ECDHE-ECDSA-AES256-GCM-SHA384:"
        "ECDHE-RSA-AES256-GCM-SHA384:"
        "ECDHE-ECDSA-CHACHA20-POLY1305:"
        "ECDHE-RSA-CHACHA20-POLY1305:"
        "ECDHE-ECDSA-AES128-GCM-SHA256:"
        "ECDHE-RSA-AES128-GCM-SHA256");
    
    // Enable session caching
    SSL_CTX_set_session_cache_mode(ctx, SSL_SESS_CACHE_SERVER);
    SSL_CTX_sess_set_cache_size(ctx, 1024);
    
    // Set DH parameters for perfect forward secrecy
    DH* dh = DH_new();
    if (DH_generate_parameters_ex(dh, 2048, DH_GENERATOR_2, NULL)) {
        SSL_CTX_set_tmp_dh(ctx, dh);
    }
    DH_free(dh);
    
    return ctx;
}

// Non-blocking TLS with epoll
typedef struct {
    int fd;
    SSL* ssl;
    int want_read;
    int want_write;
    buffer_t in_buf;
    buffer_t out_buf;
} tls_connection_t;

void handle_tls_io(tls_connection_t* conn, uint32_t events) {
    if (conn->want_read && (events & EPOLLIN)) {
        // Try SSL_read
        char buffer[4096];
        int ret = SSL_read(conn->ssl, buffer, sizeof(buffer));
        
        if (ret > 0) {
            // Process decrypted data
            buffer_append(&conn->in_buf, buffer, ret);
            conn->want_read = 0;
        } else {
            int err = SSL_get_error(conn->ssl, ret);
            if (err == SSL_ERROR_WANT_READ) {
                conn->want_read = 1;
            } else if (err == SSL_ERROR_WANT_WRITE) {
                conn->want_write = 1;
            }
        }
    }
    
    if (conn->want_write && (events & EPOLLOUT)) {
        // Try SSL_write
        if (conn->out_buf.used > 0) {
            int ret = SSL_write(conn->ssl, 
                               conn->out_buf.data,
                               conn->out_buf.used);
            
            if (ret > 0) {
                // Remove written data
                buffer_consume(&conn->out_buf, ret);
                conn->want_write = 0;
            } else {
                int err = SSL_get_error(conn->ssl, ret);
                if (err == SSL_ERROR_WANT_READ) {
                    conn->want_read = 1;
                } else if (err == SSL_ERROR_WANT_WRITE) {
                    conn->want_write = 1;
                }
            }
        }
    }
}
```

## Network Monitoring and Debugging

### Traffic Analysis

```c
// Network statistics collection
typedef struct {
    _Atomic(uint64_t) bytes_sent;
    _Atomic(uint64_t) bytes_received;
    _Atomic(uint64_t) packets_sent;
    _Atomic(uint64_t) packets_received;
    _Atomic(uint64_t) connections_accepted;
    _Atomic(uint64_t) connections_closed;
    _Atomic(uint64_t) errors;
} network_stats_t;

static network_stats_t g_stats = {0};

// Per-connection statistics
typedef struct {
    struct timespec connect_time;
    uint64_t bytes_sent;
    uint64_t bytes_received;
    uint32_t rtt_samples[100];
    int rtt_index;
} connection_stats_t;

void update_connection_rtt(connection_stats_t* stats, uint32_t rtt_us) {
    stats->rtt_samples[stats->rtt_index++ % 100] = rtt_us;
}

uint32_t get_average_rtt(connection_stats_t* stats) {
    uint64_t sum = 0;
    int count = (stats->rtt_index < 100) ? stats->rtt_index : 100;
    
    for (int i = 0; i < count; i++) {
        sum += stats->rtt_samples[i];
    }
    
    return count > 0 ? sum / count : 0;
}

// Packet capture for debugging
void debug_packet_dump(const uint8_t* data, size_t len) {
    printf("Packet dump (%zu bytes):\n", len);
    
    for (size_t i = 0; i < len; i += 16) {
        printf("%04zx: ", i);
        
        // Hex dump
        for (size_t j = 0; j < 16; j++) {
            if (i + j < len) {
                printf("%02x ", data[i + j]);
            } else {
                printf("   ");
            }
            if (j == 7) printf(" ");
        }
        
        printf(" |");
        
        // ASCII dump
        for (size_t j = 0; j < 16 && i + j < len; j++) {
            uint8_t c = data[i + j];
            printf("%c", (c >= 32 && c < 127) ? c : '.');
        }
        
        printf("|\n");
    }
}

// Network diagnostic tool
void diagnose_network_issue(int sock) {
    // Get socket error
    int error;
    socklen_t len = sizeof(error);
    getsockopt(sock, SOL_SOCKET, SO_ERROR, &error, &len);
    
    if (error != 0) {
        printf("Socket error: %s\n", strerror(error));
    }
    
    // Get TCP info
    struct tcp_info info;
    len = sizeof(info);
    if (getsockopt(sock, IPPROTO_TCP, TCP_INFO, &info, &len) == 0) {
        printf("TCP diagnostics:\n");
        printf("  State: %u\n", info.tcpi_state);
        printf("  Retransmits: %u\n", info.tcpi_retransmits);
        printf("  Lost packets: %u\n", info.tcpi_lost);
        printf("  Reordering: %u\n", info.tcpi_reordering);
        printf("  RTT: %u us (variance: %u)\n", 
               info.tcpi_rtt, info.tcpi_rttvar);
        printf("  Send buffer: %u bytes\n", info.tcpi_snd_ssthresh);
        printf("  Congestion window: %u\n", info.tcpi_snd_cwnd);
    }
    
    // Check system limits
    struct rlimit rlim;
    getrlimit(RLIMIT_NOFILE, &rlim);
    printf("File descriptor limit: %lu (max: %lu)\n", 
           rlim.rlim_cur, rlim.rlim_max);
    
    // Check network buffers
    FILE* fp = fopen("/proc/net/sockstat", "r");
    if (fp) {
        char line[256];
        while (fgets(line, sizeof(line), fp)) {
            printf("  %s", line);
        }
        fclose(fp);
    }
}
```

## Best Practices

1. **Use Non-blocking I/O**: Always use non-blocking sockets for scalable servers
2. **Buffer Management**: Pool buffers to reduce allocation overhead
3. **Error Handling**: Handle EAGAIN, EINTR, and partial reads/writes
4. **TCP Tuning**: Adjust socket options based on network characteristics
5. **Zero-Copy**: Use sendfile, splice, and MSG_ZEROCOPY when possible
6. **CPU Affinity**: Pin network threads to specific CPUs
7. **Monitoring**: Track metrics for performance analysis

## Conclusion

Linux network programming offers a rich set of APIs and features for building high-performance network applications. From basic sockets to advanced techniques like io_uring and XDP, from TCP optimizations to zero-copy networking, mastering these tools enables you to build network applications that can handle millions of connections and gigabits of throughput.

The key to successful network programming is understanding the trade-offs between different approaches, measuring performance carefully, and choosing the right tool for each use case. Whether you're building a web server, a real-time communication system, or a network monitoring tool, the techniques covered here provide the foundation for creating efficient, scalable network applications on Linux.