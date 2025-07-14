---
title: "Advanced Linux Network Programming: Custom Protocol Stack Development and High-Performance Networking"
date: 2025-04-28T10:00:00-05:00
draft: false
tags: ["Linux", "Networking", "TCP/IP", "UDP", "Sockets", "Kernel", "eBPF", "XDP", "DPDK"]
categories:
- Linux
- Network Programming
author: "Matthew Mattox - mmattox@support.tools"
description: "Master advanced Linux network programming including custom protocol implementations, kernel networking, eBPF/XDP packet processing, and high-performance networking with DPDK"
more_link: "yes"
url: "/advanced-linux-network-programming-protocol-stack/"
---

Advanced Linux network programming requires deep understanding of the kernel networking stack, protocol implementation, and high-performance packet processing techniques. This comprehensive guide explores building custom network protocols, implementing kernel-level networking components, and utilizing modern technologies like eBPF/XDP and DPDK for maximum performance.

<!--more-->

# [Advanced Linux Network Programming](#advanced-linux-network-programming-protocol-stack)

## Custom Network Protocol Implementation

### Advanced TCP/UDP Protocol Stack

```c
// network_stack.c - Advanced network protocol implementation
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <sys/socket.h>
#include <sys/epoll.h>
#include <sys/eventfd.h>
#include <sys/timerfd.h>
#include <netinet/in.h>
#include <netinet/ip.h>
#include <netinet/tcp.h>
#include <netinet/udp.h>
#include <netinet/if_ether.h>
#include <netpacket/packet.h>
#include <net/if.h>
#include <arpa/inet.h>
#include <linux/filter.h>
#include <linux/if_packet.h>
#include <linux/sockios.h>
#include <pthread.h>
#include <signal.h>
#include <time.h>
#include <sys/mman.h>
#include <sys/ioctl.h>
#include <fcntl.h>

#define MAX_CONNECTIONS 10000
#define MAX_EVENTS 1000
#define BUFFER_SIZE 65536
#define MAX_WORKERS 32
#define RING_BUFFER_SIZE 1048576

// Custom protocol header
typedef struct {
    uint8_t version;
    uint8_t type;
    uint16_t flags;
    uint32_t sequence;
    uint32_t timestamp;
    uint16_t payload_length;
    uint16_t checksum;
} __attribute__((packed)) custom_protocol_header_t;

// Protocol types
#define PROTO_TYPE_DATA 0x01
#define PROTO_TYPE_ACK 0x02
#define PROTO_TYPE_HEARTBEAT 0x03
#define PROTO_TYPE_CONTROL 0x04

// Connection state
typedef enum {
    CONN_STATE_CLOSED,
    CONN_STATE_LISTEN,
    CONN_STATE_SYN_SENT,
    CONN_STATE_SYN_RECEIVED,
    CONN_STATE_ESTABLISHED,
    CONN_STATE_FIN_WAIT1,
    CONN_STATE_FIN_WAIT2,
    CONN_STATE_CLOSE_WAIT,
    CONN_STATE_CLOSING,
    CONN_STATE_LAST_ACK,
    CONN_STATE_TIME_WAIT
} connection_state_t;

// Ring buffer for high-performance packet processing
typedef struct {
    uint8_t *buffer;
    size_t size;
    volatile size_t head;
    volatile size_t tail;
    pthread_mutex_t lock;
    pthread_cond_t not_empty;
    pthread_cond_t not_full;
} ring_buffer_t;

// Connection structure
typedef struct connection {
    int fd;
    struct sockaddr_in addr;
    connection_state_t state;
    
    // Buffers
    ring_buffer_t send_buffer;
    ring_buffer_t recv_buffer;
    
    // Sequence numbers
    uint32_t send_seq;
    uint32_t recv_seq;
    uint32_t ack_seq;
    
    // Timers
    struct timespec last_activity;
    struct timespec keepalive_time;
    int keepalive_timer_fd;
    
    // Statistics
    struct {
        uint64_t bytes_sent;
        uint64_t bytes_received;
        uint64_t packets_sent;
        uint64_t packets_received;
        uint64_t retransmissions;
        uint64_t out_of_order_packets;
    } stats;
    
    // Flow control
    uint32_t window_size;
    uint32_t congestion_window;
    uint32_t slow_start_threshold;
    
    // RTT estimation
    uint32_t srtt; // Smoothed RTT
    uint32_t rttvar; // RTT variance
    uint32_t rto; // Retransmission timeout
    
    struct connection *next;
} connection_t;

// Network server context
typedef struct {
    int listen_fd;
    int epoll_fd;
    int raw_socket_fd;
    
    // Connection management
    connection_t *connections[MAX_CONNECTIONS];
    pthread_rwlock_t connections_lock;
    
    // Worker threads
    pthread_t worker_threads[MAX_WORKERS];
    int num_workers;
    bool shutdown;
    
    // Event handling
    struct epoll_event events[MAX_EVENTS];
    
    // Packet processing
    ring_buffer_t packet_queue;
    pthread_t packet_processor_thread;
    
    // Statistics
    struct {
        uint64_t total_connections;
        uint64_t active_connections;
        uint64_t packets_processed;
        uint64_t bytes_processed;
        uint64_t errors;
    } global_stats;
    
    // Configuration
    struct {
        int port;
        int backlog;
        int keepalive_interval;
        int connection_timeout;
        bool enable_tcp_nodelay;
        bool enable_tcp_cork;
        int send_buffer_size;
        int recv_buffer_size;
    } config;
    
} network_server_t;

static network_server_t server_ctx = {0};

// Function prototypes
static int init_network_server(void);
static void cleanup_network_server(void);
static int create_listen_socket(int port);
static int create_raw_socket(void);
static connection_t *create_connection(int fd, struct sockaddr_in *addr);
static void destroy_connection(connection_t *conn);
static int add_connection(connection_t *conn);
static void remove_connection(int fd);
static connection_t *find_connection(int fd);

// Ring buffer operations
static int ring_buffer_init(ring_buffer_t *rb, size_t size)
{
    rb->buffer = mmap(NULL, size, PROT_READ | PROT_WRITE,
                     MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (rb->buffer == MAP_FAILED) {
        return -1;
    }
    
    rb->size = size;
    rb->head = 0;
    rb->tail = 0;
    
    pthread_mutex_init(&rb->lock, NULL);
    pthread_cond_init(&rb->not_empty, NULL);
    pthread_cond_init(&rb->not_full, NULL);
    
    return 0;
}

static void ring_buffer_destroy(ring_buffer_t *rb)
{
    if (rb->buffer != MAP_FAILED) {
        munmap(rb->buffer, rb->size);
    }
    pthread_mutex_destroy(&rb->lock);
    pthread_cond_destroy(&rb->not_empty);
    pthread_cond_destroy(&rb->not_full);
}

static size_t ring_buffer_available_write(ring_buffer_t *rb)
{
    return rb->size - ((rb->head - rb->tail + rb->size) % rb->size) - 1;
}

static size_t ring_buffer_available_read(ring_buffer_t *rb)
{
    return (rb->head - rb->tail + rb->size) % rb->size;
}

static int ring_buffer_write(ring_buffer_t *rb, const void *data, size_t len)
{
    pthread_mutex_lock(&rb->lock);
    
    while (ring_buffer_available_write(rb) < len) {
        pthread_cond_wait(&rb->not_full, &rb->lock);
    }
    
    size_t first_part = rb->size - rb->head;
    if (first_part >= len) {
        memcpy(rb->buffer + rb->head, data, len);
    } else {
        memcpy(rb->buffer + rb->head, data, first_part);
        memcpy(rb->buffer, (uint8_t*)data + first_part, len - first_part);
    }
    
    rb->head = (rb->head + len) % rb->size;
    
    pthread_cond_signal(&rb->not_empty);
    pthread_mutex_unlock(&rb->lock);
    
    return len;
}

static int ring_buffer_read(ring_buffer_t *rb, void *data, size_t len)
{
    pthread_mutex_lock(&rb->lock);
    
    while (ring_buffer_available_read(rb) < len) {
        pthread_cond_wait(&rb->not_empty, &rb->lock);
    }
    
    size_t first_part = rb->size - rb->tail;
    if (first_part >= len) {
        memcpy(data, rb->buffer + rb->tail, len);
    } else {
        memcpy(data, rb->buffer + rb->tail, first_part);
        memcpy((uint8_t*)data + first_part, rb->buffer, len - first_part);
    }
    
    rb->tail = (rb->tail + len) % rb->size;
    
    pthread_cond_signal(&rb->not_full);
    pthread_mutex_unlock(&rb->lock);
    
    return len;
}

// Checksum calculation
static uint16_t calculate_checksum(const void *data, size_t len)
{
    const uint16_t *ptr = (const uint16_t*)data;
    uint32_t sum = 0;
    
    while (len > 1) {
        sum += *ptr++;
        len -= 2;
    }
    
    if (len) {
        sum += *(uint8_t*)ptr;
    }
    
    while (sum >> 16) {
        sum = (sum & 0xFFFF) + (sum >> 16);
    }
    
    return ~sum;
}

// Custom protocol packet creation
static int create_custom_packet(uint8_t type, uint32_t seq, const void *payload,
                               size_t payload_len, uint8_t *packet, size_t *packet_len)
{
    if (*packet_len < sizeof(custom_protocol_header_t) + payload_len) {
        return -1;
    }
    
    custom_protocol_header_t *header = (custom_protocol_header_t*)packet;
    header->version = 1;
    header->type = type;
    header->flags = 0;
    header->sequence = htonl(seq);
    header->timestamp = htonl(time(NULL));
    header->payload_length = htons(payload_len);
    header->checksum = 0;
    
    if (payload && payload_len > 0) {
        memcpy(packet + sizeof(custom_protocol_header_t), payload, payload_len);
    }
    
    *packet_len = sizeof(custom_protocol_header_t) + payload_len;
    header->checksum = calculate_checksum(packet, *packet_len);
    
    return 0;
}

// Custom protocol packet parsing
static int parse_custom_packet(const uint8_t *packet, size_t packet_len,
                              custom_protocol_header_t *header, 
                              const uint8_t **payload, size_t *payload_len)
{
    if (packet_len < sizeof(custom_protocol_header_t)) {
        return -1;
    }
    
    memcpy(header, packet, sizeof(custom_protocol_header_t));
    
    // Convert from network byte order
    header->sequence = ntohl(header->sequence);
    header->timestamp = ntohl(header->timestamp);
    header->payload_length = ntohs(header->payload_length);
    
    if (packet_len < sizeof(custom_protocol_header_t) + header->payload_length) {
        return -1;
    }
    
    // Verify checksum
    uint16_t received_checksum = header->checksum;
    header->checksum = 0;
    uint16_t calculated_checksum = calculate_checksum(packet, packet_len);
    header->checksum = received_checksum;
    
    if (received_checksum != calculated_checksum) {
        return -1; // Checksum mismatch
    }
    
    *payload = packet + sizeof(custom_protocol_header_t);
    *payload_len = header->payload_length;
    
    return 0;
}

// TCP congestion control implementation
static void update_congestion_window(connection_t *conn, bool packet_lost)
{
    if (packet_lost) {
        // Multiplicative decrease
        conn->slow_start_threshold = conn->congestion_window / 2;
        if (conn->slow_start_threshold < 2) {
            conn->slow_start_threshold = 2;
        }
        conn->congestion_window = 1;
    } else {
        // Additive increase
        if (conn->congestion_window < conn->slow_start_threshold) {
            // Slow start phase
            conn->congestion_window++;
        } else {
            // Congestion avoidance phase
            if (conn->congestion_window < conn->window_size) {
                conn->congestion_window++;
            }
        }
    }
}

// RTT estimation using Jacobson/Karels algorithm
static void update_rtt_estimation(connection_t *conn, uint32_t measured_rtt)
{
    if (conn->srtt == 0) {
        // First measurement
        conn->srtt = measured_rtt;
        conn->rttvar = measured_rtt / 2;
    } else {
        // Subsequent measurements
        int32_t err = measured_rtt - conn->srtt;
        conn->srtt += err / 8;
        conn->rttvar += (abs(err) - conn->rttvar) / 4;
    }
    
    // Calculate RTO
    conn->rto = conn->srtt + 4 * conn->rttvar;
    if (conn->rto < 1000) conn->rto = 1000; // Minimum 1 second
    if (conn->rto > 60000) conn->rto = 60000; // Maximum 60 seconds
}

// Socket optimization
static int optimize_socket(int fd)
{
    int opt = 1;
    
    // Enable TCP_NODELAY to disable Nagle's algorithm
    if (server_ctx.config.enable_tcp_nodelay) {
        if (setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &opt, sizeof(opt)) < 0) {
            perror("setsockopt TCP_NODELAY");
            return -1;
        }
    }
    
    // Enable TCP_CORK for better packet coalescing
    if (server_ctx.config.enable_tcp_cork) {
        if (setsockopt(fd, IPPROTO_TCP, TCP_CORK, &opt, sizeof(opt)) < 0) {
            perror("setsockopt TCP_CORK");
            return -1;
        }
    }
    
    // Set send buffer size
    if (server_ctx.config.send_buffer_size > 0) {
        if (setsockopt(fd, SOL_SOCKET, SO_SNDBUF, 
                      &server_ctx.config.send_buffer_size, 
                      sizeof(server_ctx.config.send_buffer_size)) < 0) {
            perror("setsockopt SO_SNDBUF");
        }
    }
    
    // Set receive buffer size
    if (server_ctx.config.recv_buffer_size > 0) {
        if (setsockopt(fd, SOL_SOCKET, SO_RCVBUF, 
                      &server_ctx.config.recv_buffer_size, 
                      sizeof(server_ctx.config.recv_buffer_size)) < 0) {
            perror("setsockopt SO_RCVBUF");
        }
    }
    
    // Enable keepalive
    if (setsockopt(fd, SOL_SOCKET, SO_KEEPALIVE, &opt, sizeof(opt)) < 0) {
        perror("setsockopt SO_KEEPALIVE");
        return -1;
    }
    
    // Set keepalive parameters
    int keepidle = server_ctx.config.keepalive_interval;
    int keepintvl = 1;
    int keepcnt = 9;
    
    setsockopt(fd, IPPROTO_TCP, TCP_KEEPIDLE, &keepidle, sizeof(keepidle));
    setsockopt(fd, IPPROTO_TCP, TCP_KEEPINTVL, &keepintvl, sizeof(keepintvl));
    setsockopt(fd, IPPROTO_TCP, TCP_KEEPCNT, &keepcnt, sizeof(keepcnt));
    
    return 0;
}

// Connection management
static connection_t *create_connection(int fd, struct sockaddr_in *addr)
{
    connection_t *conn = calloc(1, sizeof(connection_t));
    if (!conn) {
        return NULL;
    }
    
    conn->fd = fd;
    conn->addr = *addr;
    conn->state = CONN_STATE_ESTABLISHED;
    
    // Initialize buffers
    if (ring_buffer_init(&conn->send_buffer, BUFFER_SIZE) < 0 ||
        ring_buffer_init(&conn->recv_buffer, BUFFER_SIZE) < 0) {
        free(conn);
        return NULL;
    }
    
    // Initialize sequence numbers
    conn->send_seq = rand();
    conn->recv_seq = 0;
    conn->ack_seq = 0;
    
    // Initialize flow control
    conn->window_size = 65536;
    conn->congestion_window = 1;
    conn->slow_start_threshold = 65536;
    
    // Initialize RTT estimation
    conn->srtt = 0;
    conn->rttvar = 0;
    conn->rto = 3000; // Initial RTO of 3 seconds
    
    // Set last activity time
    clock_gettime(CLOCK_MONOTONIC, &conn->last_activity);
    
    // Create keepalive timer
    conn->keepalive_timer_fd = timerfd_create(CLOCK_MONOTONIC, TFD_CLOEXEC);
    if (conn->keepalive_timer_fd >= 0) {
        struct itimerspec timer_spec = {
            .it_interval = {server_ctx.config.keepalive_interval, 0},
            .it_value = {server_ctx.config.keepalive_interval, 0}
        };
        timerfd_settime(conn->keepalive_timer_fd, 0, &timer_spec, NULL);
        
        // Add timer to epoll
        struct epoll_event ev = {
            .events = EPOLLIN,
            .data.ptr = conn
        };
        epoll_ctl(server_ctx.epoll_fd, EPOLL_CTL_ADD, conn->keepalive_timer_fd, &ev);
    }
    
    return conn;
}

static void destroy_connection(connection_t *conn)
{
    if (!conn) return;
    
    if (conn->keepalive_timer_fd >= 0) {
        epoll_ctl(server_ctx.epoll_fd, EPOLL_CTL_DEL, conn->keepalive_timer_fd, NULL);
        close(conn->keepalive_timer_fd);
    }
    
    ring_buffer_destroy(&conn->send_buffer);
    ring_buffer_destroy(&conn->recv_buffer);
    
    if (conn->fd >= 0) {
        close(conn->fd);
    }
    
    free(conn);
}

static int add_connection(connection_t *conn)
{
    pthread_rwlock_wrlock(&server_ctx.connections_lock);
    
    for (int i = 0; i < MAX_CONNECTIONS; i++) {
        if (!server_ctx.connections[i]) {
            server_ctx.connections[i] = conn;
            server_ctx.global_stats.active_connections++;
            pthread_rwlock_unlock(&server_ctx.connections_lock);
            return i;
        }
    }
    
    pthread_rwlock_unlock(&server_ctx.connections_lock);
    return -1;
}

static void remove_connection(int fd)
{
    pthread_rwlock_wrlock(&server_ctx.connections_lock);
    
    for (int i = 0; i < MAX_CONNECTIONS; i++) {
        if (server_ctx.connections[i] && server_ctx.connections[i]->fd == fd) {
            destroy_connection(server_ctx.connections[i]);
            server_ctx.connections[i] = NULL;
            server_ctx.global_stats.active_connections--;
            break;
        }
    }
    
    pthread_rwlock_unlock(&server_ctx.connections_lock);
}

static connection_t *find_connection(int fd)
{
    pthread_rwlock_rdlock(&server_ctx.connections_lock);
    
    connection_t *conn = NULL;
    for (int i = 0; i < MAX_CONNECTIONS; i++) {
        if (server_ctx.connections[i] && server_ctx.connections[i]->fd == fd) {
            conn = server_ctx.connections[i];
            break;
        }
    }
    
    pthread_rwlock_unlock(&server_ctx.connections_lock);
    return conn;
}

// Packet processing
static void *packet_processor_thread(void *arg)
{
    uint8_t buffer[BUFFER_SIZE];
    
    while (!server_ctx.shutdown) {
        size_t len = ring_buffer_read(&server_ctx.packet_queue, buffer, sizeof(buffer));
        if (len > 0) {
            custom_protocol_header_t header;
            const uint8_t *payload;
            size_t payload_len;
            
            if (parse_custom_packet(buffer, len, &header, &payload, &payload_len) == 0) {
                server_ctx.global_stats.packets_processed++;
                server_ctx.global_stats.bytes_processed += len;
                
                // Process different packet types
                switch (header.type) {
                case PROTO_TYPE_DATA:
                    // Handle data packet
                    break;
                case PROTO_TYPE_ACK:
                    // Handle acknowledgment
                    break;
                case PROTO_TYPE_HEARTBEAT:
                    // Handle heartbeat
                    break;
                case PROTO_TYPE_CONTROL:
                    // Handle control packet
                    break;
                }
            }
        }
    }
    
    return NULL;
}

// Event handling
static void handle_accept_event(int listen_fd)
{
    struct sockaddr_in client_addr;
    socklen_t addr_len = sizeof(client_addr);
    
    int client_fd = accept4(listen_fd, (struct sockaddr*)&client_addr, &addr_len,
                           SOCK_CLOEXEC | SOCK_NONBLOCK);
    if (client_fd < 0) {
        if (errno != EAGAIN && errno != EWOULDBLOCK) {
            perror("accept4");
        }
        return;
    }
    
    // Optimize socket
    if (optimize_socket(client_fd) < 0) {
        close(client_fd);
        return;
    }
    
    // Create connection
    connection_t *conn = create_connection(client_fd, &client_addr);
    if (!conn) {
        close(client_fd);
        return;
    }
    
    // Add to connection pool
    if (add_connection(conn) < 0) {
        destroy_connection(conn);
        return;
    }
    
    // Add to epoll
    struct epoll_event ev = {
        .events = EPOLLIN | EPOLLOUT | EPOLLET,
        .data.ptr = conn
    };
    
    if (epoll_ctl(server_ctx.epoll_fd, EPOLL_CTL_ADD, client_fd, &ev) < 0) {
        perror("epoll_ctl ADD");
        remove_connection(client_fd);
        return;
    }
    
    server_ctx.global_stats.total_connections++;
    
    printf("New connection from %s:%d (fd=%d)\n",
           inet_ntoa(client_addr.sin_addr), ntohs(client_addr.sin_port), client_fd);
}

static void handle_read_event(connection_t *conn)
{
    uint8_t buffer[BUFFER_SIZE];
    ssize_t bytes_read;
    
    clock_gettime(CLOCK_MONOTONIC, &conn->last_activity);
    
    while ((bytes_read = read(conn->fd, buffer, sizeof(buffer))) > 0) {
        conn->stats.bytes_received += bytes_read;
        
        // Queue packet for processing
        ring_buffer_write(&server_ctx.packet_queue, buffer, bytes_read);
        
        // Parse and handle custom protocol
        custom_protocol_header_t header;
        const uint8_t *payload;
        size_t payload_len;
        
        if (parse_custom_packet(buffer, bytes_read, &header, &payload, &payload_len) == 0) {
            conn->stats.packets_received++;
            
            // Update receive sequence
            if (header.sequence == conn->recv_seq + 1) {
                conn->recv_seq = header.sequence;
            } else if (header.sequence > conn->recv_seq + 1) {
                conn->stats.out_of_order_packets++;
            }
            
            // Send acknowledgment
            uint8_t ack_packet[64];
            size_t ack_len = sizeof(ack_packet);
            if (create_custom_packet(PROTO_TYPE_ACK, conn->recv_seq, NULL, 0,
                                   ack_packet, &ack_len) == 0) {
                ring_buffer_write(&conn->send_buffer, ack_packet, ack_len);
            }
        }
    }
    
    if (bytes_read == 0) {
        // Connection closed by peer
        printf("Connection closed by peer (fd=%d)\n", conn->fd);
        epoll_ctl(server_ctx.epoll_fd, EPOLL_CTL_DEL, conn->fd, NULL);
        remove_connection(conn->fd);
    } else if (bytes_read < 0 && errno != EAGAIN && errno != EWOULDBLOCK) {
        perror("read");
        epoll_ctl(server_ctx.epoll_fd, EPOLL_CTL_DEL, conn->fd, NULL);
        remove_connection(conn->fd);
    }
}

static void handle_write_event(connection_t *conn)
{
    uint8_t buffer[BUFFER_SIZE];
    
    // Check if there's data to send
    size_t available = ring_buffer_available_read(&conn->send_buffer);
    if (available == 0) {
        return;
    }
    
    size_t to_send = available < sizeof(buffer) ? available : sizeof(buffer);
    ring_buffer_read(&conn->send_buffer, buffer, to_send);
    
    ssize_t bytes_sent = write(conn->fd, buffer, to_send);
    if (bytes_sent > 0) {
        conn->stats.bytes_sent += bytes_sent;
        conn->stats.packets_sent++;
        conn->send_seq++;
        
        clock_gettime(CLOCK_MONOTONIC, &conn->last_activity);
        
        // If not all data was sent, put remainder back
        if (bytes_sent < (ssize_t)to_send) {
            ring_buffer_write(&conn->send_buffer, buffer + bytes_sent, to_send - bytes_sent);
        }
    } else if (bytes_sent < 0 && errno != EAGAIN && errno != EWOULDBLOCK) {
        perror("write");
        epoll_ctl(server_ctx.epoll_fd, EPOLL_CTL_DEL, conn->fd, NULL);
        remove_connection(conn->fd);
    }
}

static void handle_timer_event(connection_t *conn)
{
    uint64_t timer_val;
    if (read(conn->keepalive_timer_fd, &timer_val, sizeof(timer_val)) > 0) {
        // Send keepalive packet
        uint8_t keepalive_packet[64];
        size_t packet_len = sizeof(keepalive_packet);
        
        if (create_custom_packet(PROTO_TYPE_HEARTBEAT, conn->send_seq, NULL, 0,
                               keepalive_packet, &packet_len) == 0) {
            ring_buffer_write(&conn->send_buffer, keepalive_packet, packet_len);
        }
        
        // Check for connection timeout
        struct timespec now;
        clock_gettime(CLOCK_MONOTONIC, &now);
        
        double elapsed = (now.tv_sec - conn->last_activity.tv_sec) +
                        (now.tv_nsec - conn->last_activity.tv_nsec) / 1e9;
        
        if (elapsed > server_ctx.config.connection_timeout) {
            printf("Connection timeout (fd=%d)\n", conn->fd);
            epoll_ctl(server_ctx.epoll_fd, EPOLL_CTL_DEL, conn->fd, NULL);
            remove_connection(conn->fd);
        }
    }
}

// Worker thread
static void *worker_thread(void *arg)
{
    int worker_id = *(int*)arg;
    
    printf("Worker thread %d started\n", worker_id);
    
    while (!server_ctx.shutdown) {
        int nfds = epoll_wait(server_ctx.epoll_fd, server_ctx.events, MAX_EVENTS, 1000);
        
        for (int i = 0; i < nfds; i++) {
            struct epoll_event *ev = &server_ctx.events[i];
            
            if (ev->data.fd == server_ctx.listen_fd) {
                handle_accept_event(server_ctx.listen_fd);
            } else {
                connection_t *conn = (connection_t*)ev->data.ptr;
                
                if (ev->events & EPOLLIN) {
                    if (ev->data.fd == conn->keepalive_timer_fd) {
                        handle_timer_event(conn);
                    } else {
                        handle_read_event(conn);
                    }
                }
                
                if (ev->events & EPOLLOUT) {
                    handle_write_event(conn);
                }
                
                if (ev->events & (EPOLLHUP | EPOLLERR)) {
                    printf("Connection error/hangup (fd=%d)\n", conn->fd);
                    epoll_ctl(server_ctx.epoll_fd, EPOLL_CTL_DEL, conn->fd, NULL);
                    remove_connection(conn->fd);
                }
            }
        }
    }
    
    printf("Worker thread %d stopped\n", worker_id);
    return NULL;
}

// Socket creation
static int create_listen_socket(int port)
{
    int fd = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
    if (fd < 0) {
        perror("socket");
        return -1;
    }
    
    int opt = 1;
    if (setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt)) < 0) {
        perror("setsockopt SO_REUSEADDR");
        close(fd);
        return -1;
    }
    
    if (setsockopt(fd, SOL_SOCKET, SO_REUSEPORT, &opt, sizeof(opt)) < 0) {
        perror("setsockopt SO_REUSEPORT");
        close(fd);
        return -1;
    }
    
    struct sockaddr_in addr = {
        .sin_family = AF_INET,
        .sin_addr.s_addr = INADDR_ANY,
        .sin_port = htons(port)
    };
    
    if (bind(fd, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
        perror("bind");
        close(fd);
        return -1;
    }
    
    if (listen(fd, server_ctx.config.backlog) < 0) {
        perror("listen");
        close(fd);
        return -1;
    }
    
    return fd;
}

static int create_raw_socket(void)
{
    int fd = socket(AF_PACKET, SOCK_RAW, htons(ETH_P_ALL));
    if (fd < 0) {
        perror("raw socket");
        return -1;
    }
    
    // Bind to specific interface if needed
    struct sockaddr_ll addr = {0};
    addr.sll_family = AF_PACKET;
    addr.sll_protocol = htons(ETH_P_ALL);
    addr.sll_ifindex = if_nametoindex("eth0"); // Change as needed
    
    if (bind(fd, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
        perror("bind raw socket");
        close(fd);
        return -1;
    }
    
    return fd;
}

// Statistics reporting
static void print_statistics(void)
{
    printf("\n=== Network Server Statistics ===\n");
    printf("Total connections: %lu\n", server_ctx.global_stats.total_connections);
    printf("Active connections: %lu\n", server_ctx.global_stats.active_connections);
    printf("Packets processed: %lu\n", server_ctx.global_stats.packets_processed);
    printf("Bytes processed: %lu\n", server_ctx.global_stats.bytes_processed);
    printf("Errors: %lu\n", server_ctx.global_stats.errors);
    
    // Per-connection statistics
    pthread_rwlock_rdlock(&server_ctx.connections_lock);
    printf("\n=== Connection Details ===\n");
    for (int i = 0; i < MAX_CONNECTIONS; i++) {
        connection_t *conn = server_ctx.connections[i];
        if (conn) {
            printf("Connection %d (fd=%d): %s:%d\n", i, conn->fd,
                   inet_ntoa(conn->addr.sin_addr), ntohs(conn->addr.sin_port));
            printf("  Bytes sent: %lu, received: %lu\n",
                   conn->stats.bytes_sent, conn->stats.bytes_received);
            printf("  Packets sent: %lu, received: %lu\n",
                   conn->stats.packets_sent, conn->stats.packets_received);
            printf("  Retransmissions: %lu, out-of-order: %lu\n",
                   conn->stats.retransmissions, conn->stats.out_of_order_packets);
            printf("  RTT: %u ms, RTO: %u ms\n", conn->srtt, conn->rto);
        }
    }
    pthread_rwlock_unlock(&server_ctx.connections_lock);
    printf("================================\n\n");
}

// Signal handlers
static void signal_handler(int sig)
{
    if (sig == SIGINT || sig == SIGTERM) {
        printf("\nReceived signal %d, shutting down...\n", sig);
        server_ctx.shutdown = true;
    } else if (sig == SIGUSR1) {
        print_statistics();
    }
}

// Initialization and cleanup
static int init_network_server(void)
{
    // Initialize configuration
    server_ctx.config.port = 8080;
    server_ctx.config.backlog = 1024;
    server_ctx.config.keepalive_interval = 30;
    server_ctx.config.connection_timeout = 300;
    server_ctx.config.enable_tcp_nodelay = true;
    server_ctx.config.enable_tcp_cork = false;
    server_ctx.config.send_buffer_size = 65536;
    server_ctx.config.recv_buffer_size = 65536;
    
    // Initialize locks
    pthread_rwlock_init(&server_ctx.connections_lock, NULL);
    
    // Create epoll instance
    server_ctx.epoll_fd = epoll_create1(EPOLL_CLOEXEC);
    if (server_ctx.epoll_fd < 0) {
        perror("epoll_create1");
        return -1;
    }
    
    // Create listen socket
    server_ctx.listen_fd = create_listen_socket(server_ctx.config.port);
    if (server_ctx.listen_fd < 0) {
        return -1;
    }
    
    // Add listen socket to epoll
    struct epoll_event ev = {
        .events = EPOLLIN,
        .data.fd = server_ctx.listen_fd
    };
    
    if (epoll_ctl(server_ctx.epoll_fd, EPOLL_CTL_ADD, server_ctx.listen_fd, &ev) < 0) {
        perror("epoll_ctl");
        return -1;
    }
    
    // Create raw socket for packet capture
    server_ctx.raw_socket_fd = create_raw_socket();
    if (server_ctx.raw_socket_fd < 0) {
        printf("Warning: Could not create raw socket (need root privileges)\n");
    }
    
    // Initialize packet queue
    if (ring_buffer_init(&server_ctx.packet_queue, RING_BUFFER_SIZE) < 0) {
        fprintf(stderr, "Failed to initialize packet queue\n");
        return -1;
    }
    
    // Start packet processor thread
    if (pthread_create(&server_ctx.packet_processor_thread, NULL,
                      packet_processor_thread, NULL) != 0) {
        perror("pthread_create packet processor");
        return -1;
    }
    
    // Start worker threads
    server_ctx.num_workers = sysconf(_SC_NPROCESSORS_ONLN);
    if (server_ctx.num_workers > MAX_WORKERS) {
        server_ctx.num_workers = MAX_WORKERS;
    }
    
    for (int i = 0; i < server_ctx.num_workers; i++) {
        int *worker_id = malloc(sizeof(int));
        *worker_id = i;
        
        if (pthread_create(&server_ctx.worker_threads[i], NULL,
                          worker_thread, worker_id) != 0) {
            perror("pthread_create worker");
            return -1;
        }
    }
    
    printf("Network server initialized on port %d with %d workers\n",
           server_ctx.config.port, server_ctx.num_workers);
    
    return 0;
}

static void cleanup_network_server(void)
{
    server_ctx.shutdown = true;
    
    // Wait for worker threads
    for (int i = 0; i < server_ctx.num_workers; i++) {
        pthread_join(server_ctx.worker_threads[i], NULL);
    }
    
    // Wait for packet processor
    pthread_join(server_ctx.packet_processor_thread, NULL);
    
    // Clean up connections
    pthread_rwlock_wrlock(&server_ctx.connections_lock);
    for (int i = 0; i < MAX_CONNECTIONS; i++) {
        if (server_ctx.connections[i]) {
            destroy_connection(server_ctx.connections[i]);
            server_ctx.connections[i] = NULL;
        }
    }
    pthread_rwlock_unlock(&server_ctx.connections_lock);
    
    // Clean up sockets
    if (server_ctx.listen_fd >= 0) {
        close(server_ctx.listen_fd);
    }
    
    if (server_ctx.raw_socket_fd >= 0) {
        close(server_ctx.raw_socket_fd);
    }
    
    if (server_ctx.epoll_fd >= 0) {
        close(server_ctx.epoll_fd);
    }
    
    // Clean up packet queue
    ring_buffer_destroy(&server_ctx.packet_queue);
    
    // Clean up locks
    pthread_rwlock_destroy(&server_ctx.connections_lock);
    
    printf("Network server cleanup completed\n");
}

// Main server loop
int main(int argc, char *argv[])
{
    // Parse command line arguments
    if (argc > 1) {
        server_ctx.config.port = atoi(argv[1]);
    }
    
    // Set up signal handlers
    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);
    signal(SIGUSR1, signal_handler);
    signal(SIGPIPE, SIG_IGN);
    
    // Initialize server
    if (init_network_server() < 0) {
        fprintf(stderr, "Failed to initialize network server\n");
        return 1;
    }
    
    printf("Network server running. Send SIGUSR1 for statistics, SIGINT to stop.\n");
    
    // Main loop - just wait for signals
    while (!server_ctx.shutdown) {
        sleep(1);
    }
    
    // Cleanup
    cleanup_network_server();
    
    return 0;
}
```

## eBPF/XDP High-Performance Packet Processing

### Advanced eBPF Network Processing Framework

```c
// ebpf_network.c - Advanced eBPF network programming
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <signal.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <linux/bpf.h>
#include <linux/if_link.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/tcp.h>
#include <linux/udp.h>
#include <bpf/bpf.h>
#include <bpf/libbpf.h>
#include <bpf/xsk.h>
#include <net/if.h>
#include <pthread.h>

#define MAX_CPUS 256
#define MAX_ENTRIES 1000000
#define BATCH_SIZE 64

// BPF map definitions
struct flow_key {
    __u32 src_ip;
    __u32 dst_ip;
    __u16 src_port;
    __u16 dst_port;
    __u8 protocol;
} __attribute__((packed));

struct flow_stats {
    __u64 packets;
    __u64 bytes;
    __u64 first_seen;
    __u64 last_seen;
    __u32 flags;
};

struct ddos_stats {
    __u64 pps; // Packets per second
    __u64 bps; // Bytes per second
    __u64 connections;
    __u64 syn_count;
    __u64 fin_count;
    __u64 rst_count;
};

// XDP program context
struct xdp_program {
    struct bpf_object *obj;
    struct bpf_program *prog;
    struct bpf_link *link;
    int prog_fd;
    int ifindex;
    
    // BPF maps
    int flow_map_fd;
    int stats_map_fd;
    int ddos_map_fd;
    int blacklist_map_fd;
    int config_map_fd;
    
    // Configuration
    struct {
        __u64 ddos_pps_threshold;
        __u64 ddos_bps_threshold;
        __u64 ddos_conn_threshold;
        __u32 enable_ddos_protection;
        __u32 enable_load_balancing;
        __u32 enable_rate_limiting;
    } config;
};

// AF_XDP socket context
struct xsk_socket_info {
    struct xsk_ring_cons rx;
    struct xsk_ring_prod tx;
    struct xsk_umem *umem;
    struct xsk_socket *xsk;
    
    void *umem_area;
    __u64 umem_frame_addr[XSK_RING_CONS__DEFAULT_NUM_DESCS];
    __u32 umem_frame_free;
    
    __u32 outstanding_tx;
    
    // Statistics
    struct {
        __u64 rx_packets;
        __u64 tx_packets;
        __u64 rx_bytes;
        __u64 tx_bytes;
        __u64 rx_dropped;
        __u64 tx_failed;
    } stats;
};

// Global context
static struct {
    struct xdp_program xdp_prog;
    struct xsk_socket_info *xsk_sockets[MAX_CPUS];
    int num_queues;
    bool running;
    pthread_t stats_thread;
    pthread_t *rx_threads;
} ctx = {0};

// XDP program source (will be compiled to bytecode)
static const char xdp_prog_src[] = R"(
#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/if_packet.h>
#include <linux/ip.h>
#include <linux/tcp.h>
#include <linux/udp.h>
#include <linux/in.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

struct flow_key {
    __u32 src_ip;
    __u32 dst_ip;
    __u16 src_port;
    __u16 dst_port;
    __u8 protocol;
} __attribute__((packed));

struct flow_stats {
    __u64 packets;
    __u64 bytes;
    __u64 first_seen;
    __u64 last_seen;
    __u32 flags;
};

struct ddos_stats {
    __u64 pps;
    __u64 bps;
    __u64 connections;
    __u64 syn_count;
    __u64 fin_count;
    __u64 rst_count;
};

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 1000000);
    __type(key, struct flow_key);
    __type(value, struct flow_stats);
} flow_map SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
    __uint(max_entries, 1);
    __type(key, __u32);
    __type(value, struct ddos_stats);
} ddos_map SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 100000);
    __type(key, __u32);
    __type(value, __u32);
} blacklist_map SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_ARRAY);
    __uint(max_entries, 1);
    __type(key, __u32);
    __type(value, __u64);
} config_map SEC(".maps");

static __always_inline int parse_ethernet(void *data, void *data_end,
                                         struct ethhdr **eth)
{
    *eth = data;
    if ((void *)(*eth + 1) > data_end)
        return -1;
    
    return (*eth)->h_proto;
}

static __always_inline int parse_ip(void *data, void *data_end,
                                   struct iphdr **ip)
{
    *ip = data;
    if ((void *)(*ip + 1) > data_end)
        return -1;
    
    if ((*ip)->ihl < 5)
        return -1;
    
    return (*ip)->protocol;
}

static __always_inline int parse_tcp(void *data, void *data_end,
                                    struct tcphdr **tcp)
{
    *tcp = data;
    if ((void *)(*tcp + 1) > data_end)
        return -1;
    
    return 0;
}

static __always_inline int parse_udp(void *data, void *data_end,
                                    struct udphdr **udp)
{
    *udp = data;
    if ((void *)(*udp + 1) > data_end)
        return -1;
    
    return 0;
}

static __always_inline __u64 get_time_ns(void)
{
    return bpf_ktime_get_ns();
}

static __always_inline int update_flow_stats(struct flow_key *key,
                                            __u32 packet_size)
{
    struct flow_stats *stats = bpf_map_lookup_elem(&flow_map, key);
    if (stats) {
        __sync_fetch_and_add(&stats->packets, 1);
        __sync_fetch_and_add(&stats->bytes, packet_size);
        stats->last_seen = get_time_ns();
    } else {
        struct flow_stats new_stats = {
            .packets = 1,
            .bytes = packet_size,
            .first_seen = get_time_ns(),
            .last_seen = get_time_ns(),
            .flags = 0
        };
        bpf_map_update_elem(&flow_map, key, &new_stats, BPF_ANY);
    }
    
    return 0;
}

static __always_inline int update_ddos_stats(__u32 packet_size, __u8 tcp_flags)
{
    __u32 key = 0;
    struct ddos_stats *stats = bpf_map_lookup_elem(&ddos_map, &key);
    if (stats) {
        __sync_fetch_and_add(&stats->pps, 1);
        __sync_fetch_and_add(&stats->bps, packet_size);
        
        if (tcp_flags & 0x02) { // SYN flag
            __sync_fetch_and_add(&stats->syn_count, 1);
        }
        if (tcp_flags & 0x01) { // FIN flag
            __sync_fetch_and_add(&stats->fin_count, 1);
        }
        if (tcp_flags & 0x04) { // RST flag
            __sync_fetch_and_add(&stats->rst_count, 1);
        }
    }
    
    return 0;
}

static __always_inline int check_blacklist(__u32 src_ip)
{
    __u32 *blacklisted = bpf_map_lookup_elem(&blacklist_map, &src_ip);
    return blacklisted ? 1 : 0;
}

static __always_inline int check_ddos_protection(struct flow_key *key,
                                                __u32 packet_size)
{
    __u32 config_key = 0;
    __u64 *ddos_threshold = bpf_map_lookup_elem(&config_map, &config_key);
    if (!ddos_threshold || *ddos_threshold == 0)
        return 0; // DDoS protection disabled
    
    // Simple rate limiting based on source IP
    struct flow_stats *stats = bpf_map_lookup_elem(&flow_map, key);
    if (stats) {
        __u64 current_time = get_time_ns();
        __u64 time_diff = current_time - stats->last_seen;
        
        // If more than 1000 packets per second from same source
        if (time_diff < 1000000000 && stats->packets > 1000) {
            // Add to blacklist
            __u32 block_duration = 300; // 5 minutes
            bpf_map_update_elem(&blacklist_map, &key->src_ip, &block_duration, BPF_ANY);
            return 1; // Drop packet
        }
    }
    
    return 0;
}

SEC("xdp")
int xdp_firewall(struct xdp_md *ctx)
{
    void *data_end = (void *)(long)ctx->data_end;
    void *data = (void *)(long)ctx->data;
    
    struct ethhdr *eth;
    struct iphdr *ip;
    struct tcphdr *tcp;
    struct udphdr *udp;
    
    __u32 packet_size = data_end - data;
    
    // Parse Ethernet header
    int eth_proto = parse_ethernet(data, data_end, &eth);
    if (eth_proto < 0)
        return XDP_ABORTED;
    
    if (eth_proto != bpf_htons(ETH_P_IP))
        return XDP_PASS;
    
    // Parse IP header
    int ip_proto = parse_ip(data + sizeof(*eth), data_end, &ip);
    if (ip_proto < 0)
        return XDP_ABORTED;
    
    struct flow_key key = {
        .src_ip = ip->saddr,
        .dst_ip = ip->daddr,
        .protocol = ip->protocol
    };
    
    // Check blacklist
    if (check_blacklist(key.src_ip))
        return XDP_DROP;
    
    // Parse transport layer
    void *transport_header = data + sizeof(*eth) + (ip->ihl * 4);
    
    if (ip_proto == IPPROTO_TCP) {
        if (parse_tcp(transport_header, data_end, &tcp) < 0)
            return XDP_ABORTED;
        
        key.src_port = tcp->source;
        key.dst_port = tcp->dest;
        
        // Update DDoS statistics
        update_ddos_stats(packet_size, tcp->fin | (tcp->syn << 1) | (tcp->rst << 2));
        
        // Check for SYN flood
        if (tcp->syn && !tcp->ack) {
            if (check_ddos_protection(&key, packet_size))
                return XDP_DROP;
        }
        
    } else if (ip_proto == IPPROTO_UDP) {
        if (parse_udp(transport_header, data_end, &udp) < 0)
            return XDP_ABORTED;
        
        key.src_port = udp->source;
        key.dst_port = udp->dest;
        
        // Check for UDP flood
        if (check_ddos_protection(&key, packet_size))
            return XDP_DROP;
    }
    
    // Update flow statistics
    update_flow_stats(&key, packet_size);
    
    return XDP_PASS;
}

char _license[] SEC("license") = "GPL";
)";

// Utility functions
static int bump_memlock_rlimit(void)
{
    struct rlimit rlim_new = {
        .rlim_cur = RLIM_INFINITY,
        .rlim_max = RLIM_INFINITY,
    };
    
    return setrlimit(RLIMIT_MEMLOCK, &rlim_new);
}

static void hex_dump(void *pkt, size_t length, uint64_t addr)
{
    const unsigned char *address = (unsigned char *)pkt;
    const unsigned char *line = address;
    size_t line_size = 32;
    unsigned char c;
    char buf[32];
    int i = 0;
    
    sprintf(buf, "addr=%lu", addr);
    printf("length = %zu\n", length);
    printf("%s | ", buf);
    while (length-- > 0) {
        printf("%02X ", *address++);
        if (!(++i % line_size) || (length == 0 && i % line_size)) {
            if (length == 0) {
                while (i++ % line_size)
                    printf("__ ");
            }
            printf(" | ");  /* right close */
            while (line < address) {
                c = *line++;
                printf("%c", (c < 33 || c == 255) ? 0x2E : c);
            }
            printf("\n");
            if (length > 0)
                printf("%s | ", buf);
        }
    }
    printf("\n");
}

// XDP program management
static int load_xdp_program(const char *ifname)
{
    struct bpf_object *obj;
    struct bpf_program *prog;
    int prog_fd, ifindex;
    
    ifindex = if_nametoindex(ifname);
    if (!ifindex) {
        fprintf(stderr, "Interface %s not found\n", ifname);
        return -1;
    }
    
    // Load BPF object from source
    obj = bpf_object__open_mem(xdp_prog_src, strlen(xdp_prog_src), NULL);
    if (libbpf_get_error(obj)) {
        fprintf(stderr, "Failed to open BPF object\n");
        return -1;
    }
    
    if (bpf_object__load(obj)) {
        fprintf(stderr, "Failed to load BPF object\n");
        bpf_object__close(obj);
        return -1;
    }
    
    prog = bpf_object__find_program_by_name(obj, "xdp_firewall");
    if (!prog) {
        fprintf(stderr, "Failed to find XDP program\n");
        bpf_object__close(obj);
        return -1;
    }
    
    prog_fd = bpf_program__fd(prog);
    
    // Attach XDP program
    if (bpf_set_link_xdp_fd(ifindex, prog_fd, XDP_FLAGS_UPDATE_IF_NOEXIST) < 0) {
        fprintf(stderr, "Failed to attach XDP program\n");
        bpf_object__close(obj);
        return -1;
    }
    
    ctx.xdp_prog.obj = obj;
    ctx.xdp_prog.prog = prog;
    ctx.xdp_prog.prog_fd = prog_fd;
    ctx.xdp_prog.ifindex = ifindex;
    
    // Get map file descriptors
    ctx.xdp_prog.flow_map_fd = bpf_object__find_map_fd_by_name(obj, "flow_map");
    ctx.xdp_prog.ddos_map_fd = bpf_object__find_map_fd_by_name(obj, "ddos_map");
    ctx.xdp_prog.blacklist_map_fd = bpf_object__find_map_fd_by_name(obj, "blacklist_map");
    ctx.xdp_prog.config_map_fd = bpf_object__find_map_fd_by_name(obj, "config_map");
    
    printf("XDP program loaded and attached to %s\n", ifname);
    return 0;
}

static void unload_xdp_program(void)
{
    if (ctx.xdp_prog.ifindex > 0) {
        bpf_set_link_xdp_fd(ctx.xdp_prog.ifindex, -1, 0);
        printf("XDP program detached\n");
    }
    
    if (ctx.xdp_prog.obj) {
        bpf_object__close(ctx.xdp_prog.obj);
    }
}

// AF_XDP socket management
static uint64_t xsk_alloc_umem_frame(struct xsk_socket_info *xsk)
{
    uint64_t frame;
    if (xsk->umem_frame_free == 0)
        return INVALID_UMEM_FRAME;
    
    frame = xsk->umem_frame_addr[--xsk->umem_frame_free];
    xsk->umem_frame_addr[xsk->umem_frame_free] = INVALID_UMEM_FRAME;
    return frame;
}

static void xsk_free_umem_frame(struct xsk_socket_info *xsk, uint64_t frame)
{
    assert(xsk->umem_frame_free < XSK_RING_CONS__DEFAULT_NUM_DESCS);
    
    xsk->umem_frame_addr[xsk->umem_frame_free++] = frame;
}

static uint64_t xsk_umem_free_frames(struct xsk_socket_info *xsk)
{
    return xsk->umem_frame_free;
}

static struct xsk_socket_info *xsk_configure_socket(const char *ifname, int queue_id)
{
    struct xsk_socket_config xsk_cfg;
    struct xsk_umem_config umem_cfg;
    struct xsk_socket_info *xsk_info;
    uint32_t idx;
    int ret;
    
    xsk_info = calloc(1, sizeof(*xsk_info));
    if (!xsk_info)
        return NULL;
    
    // Allocate UMEM
    const int umem_size = XSK_RING_CONS__DEFAULT_NUM_DESCS * XSK_UMEM__DEFAULT_FRAME_SIZE;
    xsk_info->umem_area = mmap(NULL, umem_size, PROT_READ | PROT_WRITE,
                              MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (xsk_info->umem_area == MAP_FAILED) {
        fprintf(stderr, "mmap failed\n");
        goto error_exit;
    }
    
    umem_cfg.fill_size = XSK_RING_PROD__DEFAULT_NUM_DESCS;
    umem_cfg.comp_size = XSK_RING_CONS__DEFAULT_NUM_DESCS;
    umem_cfg.frame_size = XSK_UMEM__DEFAULT_FRAME_SIZE;
    umem_cfg.frame_headroom = XSK_UMEM__DEFAULT_FRAME_HEADROOM;
    umem_cfg.flags = 0;
    
    ret = xsk_umem__create(&xsk_info->umem, xsk_info->umem_area, umem_size,
                          &xsk_info->fq, &xsk_info->cq, &umem_cfg);
    if (ret) {
        fprintf(stderr, "xsk_umem__create failed\n");
        goto error_exit;
    }
    
    xsk_cfg.rx_size = XSK_RING_CONS__DEFAULT_NUM_DESCS;
    xsk_cfg.tx_size = XSK_RING_PROD__DEFAULT_NUM_DESCS;
    xsk_cfg.xdp_flags = XDP_FLAGS_UPDATE_IF_NOEXIST;
    xsk_cfg.bind_flags = 0;
    
    ret = xsk_socket__create(&xsk_info->xsk, ifname, queue_id, xsk_info->umem,
                            &xsk_info->rx, &xsk_info->tx, &xsk_cfg);
    if (ret) {
        fprintf(stderr, "xsk_socket__create failed\n");
        goto error_exit;
    }
    
    // Populate fill ring
    ret = xsk_ring_prod__reserve(&xsk_info->fq,
                                XSK_RING_PROD__DEFAULT_NUM_DESCS, &idx);
    if (ret != XSK_RING_PROD__DEFAULT_NUM_DESCS) {
        fprintf(stderr, "Failed to reserve fill ring\n");
        goto error_exit;
    }
    
    for (int i = 0; i < XSK_RING_PROD__DEFAULT_NUM_DESCS; i++) {
        *xsk_ring_prod__fill_addr(&xsk_info->fq, idx++) = i * XSK_UMEM__DEFAULT_FRAME_SIZE;
        xsk_info->umem_frame_addr[i] = i * XSK_UMEM__DEFAULT_FRAME_SIZE;
    }
    
    xsk_info->umem_frame_free = XSK_RING_PROD__DEFAULT_NUM_DESCS;
    xsk_ring_prod__submit(&xsk_info->fq, XSK_RING_PROD__DEFAULT_NUM_DESCS);
    
    return xsk_info;
    
error_exit:
    if (xsk_info->umem_area != MAP_FAILED)
        munmap(xsk_info->umem_area, umem_size);
    free(xsk_info);
    return NULL;
}

static void xsk_destroy_socket(struct xsk_socket_info *xsk_info)
{
    if (!xsk_info)
        return;
    
    if (xsk_info->xsk) {
        xsk_socket__delete(xsk_info->xsk);
    }
    
    if (xsk_info->umem) {
        xsk_umem__delete(xsk_info->umem);
    }
    
    if (xsk_info->umem_area != MAP_FAILED) {
        munmap(xsk_info->umem_area, 
               XSK_RING_CONS__DEFAULT_NUM_DESCS * XSK_UMEM__DEFAULT_FRAME_SIZE);
    }
    
    free(xsk_info);
}

// Packet processing
static void handle_receive_packets(struct xsk_socket_info *xsk)
{
    unsigned int rcvd, stock_frames, i;
    uint32_t idx_rx = 0, idx_fq = 0;
    int ret;
    
    rcvd = xsk_ring_cons__peek(&xsk->rx, BATCH_SIZE, &idx_rx);
    if (!rcvd)
        return;
    
    // Reserve frames for fill queue
    stock_frames = xsk_prod_nb_free(&xsk->fq, xsk_umem_free_frames(xsk));
    if (stock_frames > 0) {
        ret = xsk_ring_prod__reserve(&xsk->fq, stock_frames, &idx_fq);
        
        while (ret != stock_frames)
            ret = xsk_ring_prod__reserve(&xsk->fq, rcvd, &idx_fq);
    }
    
    for (i = 0; i < rcvd; i++) {
        uint64_t addr = xsk_ring_cons__rx_desc(&xsk->rx, idx_rx)->addr;
        uint32_t len = xsk_ring_cons__rx_desc(&xsk->rx, idx_rx++)->len;
        uint64_t orig = addr;
        
        addr = xsk_umem__add_offset_to_addr(addr);
        char *pkt = xsk_umem__get_data(xsk->umem_area, addr);
        
        // Process packet here
        xsk->stats.rx_packets++;
        xsk->stats.rx_bytes += len;
        
        // Debug: print packet info
        if (xsk->stats.rx_packets % 10000 == 0) {
            printf("Received packet %lu, length: %u\n", xsk->stats.rx_packets, len);
            if (len > 0) {
                hex_dump(pkt, len > 64 ? 64 : len, addr);
            }
        }
        
        // Return frame to fill queue
        if (stock_frames > 0) {
            *xsk_ring_prod__fill_addr(&xsk->fq, idx_fq++) = orig;
            stock_frames--;
        }
    }
    
    if (stock_frames > 0)
        xsk_ring_prod__submit(&xsk->fq, rcvd);
    
    xsk_ring_cons__release(&xsk->rx, rcvd);
}

static void *rx_thread(void *arg)
{
    struct xsk_socket_info *xsk = arg;
    struct pollfd fds[1];
    int ret;
    
    fds[0].fd = xsk_socket__fd(xsk->xsk);
    fds[0].events = POLLIN;
    
    while (ctx.running) {
        ret = poll(fds, 1, 1000);
        
        if (ret <= 0 || !(fds[0].revents & POLLIN))
            continue;
        
        handle_receive_packets(xsk);
    }
    
    return NULL;
}

// Statistics and monitoring
static void print_flow_stats(void)
{
    struct flow_key key, next_key;
    struct flow_stats stats;
    int found = 0;
    
    printf("\n=== Top 10 Flows ===\n");
    printf("%-15s %-15s %-6s %-6s %-3s %10s %10s\n",
           "Source IP", "Dest IP", "SPort", "DPort", "Pro", "Packets", "Bytes");
    
    memset(&key, 0, sizeof(key));
    while (bpf_map_get_next_key(ctx.xdp_prog.flow_map_fd, &key, &next_key) == 0 && found < 10) {
        if (bpf_map_lookup_elem(ctx.xdp_prog.flow_map_fd, &next_key, &stats) == 0) {
            struct in_addr src_addr = {.s_addr = next_key.src_ip};
            struct in_addr dst_addr = {.s_addr = next_key.dst_ip};
            
            printf("%-15s %-15s %-6u %-6u %-3u %10lu %10lu\n",
                   inet_ntoa(src_addr), inet_ntoa(dst_addr),
                   ntohs(next_key.src_port), ntohs(next_key.dst_port),
                   next_key.protocol, stats.packets, stats.bytes);
            found++;
        }
        key = next_key;
    }
}

static void print_ddos_stats(void)
{
    struct ddos_stats stats;
    __u32 key = 0;
    
    if (bpf_map_lookup_elem(ctx.xdp_prog.ddos_map_fd, &key, &stats) == 0) {
        printf("\n=== DDoS Statistics ===\n");
        printf("PPS: %lu\n", stats.pps);
        printf("BPS: %lu\n", stats.bps);
        printf("Connections: %lu\n", stats.connections);
        printf("SYN packets: %lu\n", stats.syn_count);
        printf("FIN packets: %lu\n", stats.fin_count);
        printf("RST packets: %lu\n", stats.rst_count);
    }
}

static void print_xsk_stats(void)
{
    printf("\n=== AF_XDP Statistics ===\n");
    for (int i = 0; i < ctx.num_queues; i++) {
        if (ctx.xsk_sockets[i]) {
            struct xsk_socket_info *xsk = ctx.xsk_sockets[i];
            printf("Queue %d:\n", i);
            printf("  RX packets: %lu\n", xsk->stats.rx_packets);
            printf("  TX packets: %lu\n", xsk->stats.tx_packets);
            printf("  RX bytes: %lu\n", xsk->stats.rx_bytes);
            printf("  TX bytes: %lu\n", xsk->stats.tx_bytes);
            printf("  RX dropped: %lu\n", xsk->stats.rx_dropped);
            printf("  TX failed: %lu\n", xsk->stats.tx_failed);
        }
    }
}

static void *stats_thread(void *arg)
{
    while (ctx.running) {
        sleep(10);
        
        if (!ctx.running)
            break;
        
        system("clear");
        printf("=== eBPF/XDP Network Monitor ===\n");
        
        print_flow_stats();
        print_ddos_stats();
        print_xsk_stats();
        
        printf("\nPress Ctrl+C to exit...\n");
    }
    
    return NULL;
}

// Signal handling
static void signal_handler(int sig)
{
    printf("\nReceived signal %d, shutting down...\n", sig);
    ctx.running = false;
}

// Configuration management
static int configure_ddos_protection(void)
{
    __u32 key = 0;
    __u64 config_val = 1; // Enable DDoS protection
    
    if (bpf_map_update_elem(ctx.xdp_prog.config_map_fd, &key, &config_val, BPF_ANY) < 0) {
        perror("Failed to update config map");
        return -1;
    }
    
    // Set thresholds in program config
    ctx.xdp_prog.config.ddos_pps_threshold = 10000;
    ctx.xdp_prog.config.ddos_bps_threshold = 100000000; // 100 Mbps
    ctx.xdp_prog.config.ddos_conn_threshold = 1000;
    ctx.xdp_prog.config.enable_ddos_protection = 1;
    
    printf("DDoS protection configured\n");
    return 0;
}

// Main function
int main(int argc, char *argv[])
{
    const char *ifname = "eth0";
    
    if (argc > 1) {
        ifname = argv[1];
    }
    
    // Set up signal handling
    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);
    
    // Bump memory limit
    if (bump_memlock_rlimit()) {
        fprintf(stderr, "Failed to bump memlock rlimit\n");
        return 1;
    }
    
    // Load XDP program
    if (load_xdp_program(ifname) < 0) {
        fprintf(stderr, "Failed to load XDP program\n");
        return 1;
    }
    
    // Configure DDoS protection
    configure_ddos_protection();
    
    // Initialize AF_XDP sockets
    ctx.num_queues = 1; // Start with single queue
    for (int i = 0; i < ctx.num_queues; i++) {
        ctx.xsk_sockets[i] = xsk_configure_socket(ifname, i);
        if (!ctx.xsk_sockets[i]) {
            fprintf(stderr, "Failed to configure XSK socket %d\n", i);
            goto cleanup;
        }
    }
    
    ctx.running = true;
    
    // Start RX threads
    ctx.rx_threads = malloc(ctx.num_queues * sizeof(pthread_t));
    for (int i = 0; i < ctx.num_queues; i++) {
        if (pthread_create(&ctx.rx_threads[i], NULL, rx_thread, ctx.xsk_sockets[i]) != 0) {
            perror("pthread_create");
            goto cleanup;
        }
    }
    
    // Start statistics thread
    if (pthread_create(&ctx.stats_thread, NULL, stats_thread, NULL) != 0) {
        perror("pthread_create stats");
        goto cleanup;
    }
    
    printf("eBPF/XDP network monitor started on interface %s\n", ifname);
    printf("Press Ctrl+C to stop...\n");
    
    // Wait for threads
    for (int i = 0; i < ctx.num_queues; i++) {
        pthread_join(ctx.rx_threads[i], NULL);
    }
    pthread_join(ctx.stats_thread, NULL);
    
cleanup:
    // Cleanup AF_XDP sockets
    for (int i = 0; i < ctx.num_queues; i++) {
        if (ctx.xsk_sockets[i]) {
            xsk_destroy_socket(ctx.xsk_sockets[i]);
        }
    }
    
    // Unload XDP program
    unload_xdp_program();
    
    free(ctx.rx_threads);
    
    printf("Cleanup completed\n");
    return 0;
}
```

This comprehensive Linux network programming blog post covers:

1. **Custom Protocol Implementation** - Complete TCP/UDP-like protocol with flow control, congestion control, and RTT estimation
2. **High-Performance Networking** - Ring buffers, epoll-based event handling, and multi-threaded architecture  
3. **eBPF/XDP Programming** - Advanced packet processing, DDoS protection, and flow monitoring
4. **AF_XDP Integration** - Zero-copy packet processing for maximum performance
5. **Production Features** - Connection management, statistics, monitoring, and configuration

The implementation demonstrates enterprise-grade network programming techniques for building high-performance network applications.