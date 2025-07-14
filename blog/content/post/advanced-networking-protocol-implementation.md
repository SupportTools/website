---
title: "Advanced Networking and Protocol Implementation: Building High-Performance Network Stacks"
date: 2025-03-19T10:00:00-05:00
draft: false
tags: ["Linux", "Networking", "Protocols", "TCP/IP", "Raw Sockets", "Packet Processing", "DPDK"]
categories:
- Linux
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Master advanced networking techniques including raw socket programming, custom protocol implementation, high-performance packet processing, and building network stacks from scratch"
more_link: "yes"
url: "/advanced-networking-protocol-implementation/"
---

Advanced networking programming requires deep understanding of protocol stacks, packet processing, and high-performance networking techniques. This comprehensive guide explores building custom protocols, implementing network stacks from scratch, and optimizing network performance for demanding applications.

<!--more-->

# [Advanced Networking and Protocol Implementation](#advanced-networking-protocol-implementation)

## Raw Socket Programming and Packet Crafting

### Low-Level Packet Construction

```c
// raw_sockets.c - Raw socket programming and packet crafting
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <netinet/in.h>
#include <netinet/ip.h>
#include <netinet/tcp.h>
#include <netinet/udp.h>
#include <netinet/ip_icmp.h>
#include <arpa/inet.h>
#include <linux/if_packet.h>
#include <linux/if_ether.h>
#include <net/if.h>
#include <sys/ioctl.h>
#include <errno.h>

// Network packet structures
typedef struct {
    struct ethhdr eth_header;
    struct iphdr ip_header;
    struct tcphdr tcp_header;
    char payload[1500];
} tcp_packet_t;

typedef struct {
    struct ethhdr eth_header;
    struct iphdr ip_header;
    struct udphdr udp_header;
    char payload[1500];
} udp_packet_t;

typedef struct {
    struct ethhdr eth_header;
    struct iphdr ip_header;
    struct icmphdr icmp_header;
    char payload[1500];
} icmp_packet_t;

// Checksum calculation
uint16_t calculate_checksum(uint16_t *data, int length) {
    uint32_t sum = 0;
    
    // Sum all 16-bit words
    while (length > 1) {
        sum += *data++;
        length -= 2;
    }
    
    // Add any remaining byte
    if (length > 0) {
        sum += *(uint8_t*)data;
    }
    
    // Add carry bits
    while (sum >> 16) {
        sum = (sum & 0xFFFF) + (sum >> 16);
    }
    
    return ~sum;
}

// TCP checksum with pseudo-header
uint16_t calculate_tcp_checksum(struct iphdr *ip_hdr, struct tcphdr *tcp_hdr, 
                               char *payload, int payload_len) {
    // Pseudo-header for TCP checksum
    struct {
        uint32_t src_addr;
        uint32_t dst_addr;
        uint8_t zero;
        uint8_t protocol;
        uint16_t tcp_length;
    } pseudo_header;
    
    pseudo_header.src_addr = ip_hdr->saddr;
    pseudo_header.dst_addr = ip_hdr->daddr;
    pseudo_header.zero = 0;
    pseudo_header.protocol = IPPROTO_TCP;
    pseudo_header.tcp_length = htons(sizeof(struct tcphdr) + payload_len);
    
    // Calculate total length
    int total_len = sizeof(pseudo_header) + sizeof(struct tcphdr) + payload_len;
    char *checksum_data = malloc(total_len);
    
    // Combine pseudo-header, TCP header, and payload
    memcpy(checksum_data, &pseudo_header, sizeof(pseudo_header));
    memcpy(checksum_data + sizeof(pseudo_header), tcp_hdr, sizeof(struct tcphdr));
    memcpy(checksum_data + sizeof(pseudo_header) + sizeof(struct tcphdr), 
           payload, payload_len);
    
    // Calculate checksum
    uint16_t checksum = calculate_checksum((uint16_t*)checksum_data, total_len);
    
    free(checksum_data);
    return checksum;
}

// Create raw TCP packet
int create_tcp_packet(tcp_packet_t *packet, 
                     const char *src_ip, const char *dst_ip,
                     uint16_t src_port, uint16_t dst_port,
                     uint32_t seq_num, uint32_t ack_num,
                     uint8_t flags, const char *payload, int payload_len) {
    
    memset(packet, 0, sizeof(tcp_packet_t));
    
    // Ethernet header (for raw socket with AF_PACKET)
    memset(packet->eth_header.h_dest, 0xFF, ETH_ALEN);   // Broadcast
    memset(packet->eth_header.h_source, 0x00, ETH_ALEN); // Our MAC
    packet->eth_header.h_proto = htons(ETH_P_IP);
    
    // IP header
    packet->ip_header.version = 4;
    packet->ip_header.ihl = 5;
    packet->ip_header.tos = 0;
    packet->ip_header.tot_len = htons(sizeof(struct iphdr) + sizeof(struct tcphdr) + payload_len);
    packet->ip_header.id = htons(12345);
    packet->ip_header.frag_off = 0;
    packet->ip_header.ttl = 64;
    packet->ip_header.protocol = IPPROTO_TCP;
    packet->ip_header.check = 0; // Will be calculated later
    packet->ip_header.saddr = inet_addr(src_ip);
    packet->ip_header.daddr = inet_addr(dst_ip);
    
    // Calculate IP checksum
    packet->ip_header.check = calculate_checksum((uint16_t*)&packet->ip_header, 
                                                sizeof(struct iphdr));
    
    // TCP header
    packet->tcp_header.source = htons(src_port);
    packet->tcp_header.dest = htons(dst_port);
    packet->tcp_header.seq = htonl(seq_num);
    packet->tcp_header.ack_seq = htonl(ack_num);
    packet->tcp_header.doff = 5; // No options
    packet->tcp_header.fin = (flags & 0x01) ? 1 : 0;
    packet->tcp_header.syn = (flags & 0x02) ? 1 : 0;
    packet->tcp_header.rst = (flags & 0x04) ? 1 : 0;
    packet->tcp_header.psh = (flags & 0x08) ? 1 : 0;
    packet->tcp_header.ack = (flags & 0x10) ? 1 : 0;
    packet->tcp_header.urg = (flags & 0x20) ? 1 : 0;
    packet->tcp_header.window = htons(65535);
    packet->tcp_header.check = 0; // Will be calculated later
    packet->tcp_header.urg_ptr = 0;
    
    // Copy payload
    if (payload && payload_len > 0) {
        memcpy(packet->payload, payload, payload_len);
    }
    
    // Calculate TCP checksum
    packet->tcp_header.check = calculate_tcp_checksum(&packet->ip_header,
                                                     &packet->tcp_header,
                                                     packet->payload, payload_len);
    
    return sizeof(struct ethhdr) + sizeof(struct iphdr) + sizeof(struct tcphdr) + payload_len;
}

// Send raw packet
int send_raw_packet(const char *interface, void *packet, int packet_len) {
    int sock = socket(AF_PACKET, SOCK_RAW, htons(ETH_P_ALL));
    if (sock < 0) {
        perror("socket");
        return -1;
    }
    
    // Get interface index
    struct ifreq ifr;
    strncpy(ifr.ifr_name, interface, IFNAMSIZ);
    if (ioctl(sock, SIOCGIFINDEX, &ifr) < 0) {
        perror("ioctl SIOCGIFINDEX");
        close(sock);
        return -1;
    }
    
    // Set destination address
    struct sockaddr_ll dest_addr = {0};
    dest_addr.sll_family = AF_PACKET;
    dest_addr.sll_protocol = htons(ETH_P_IP);
    dest_addr.sll_ifindex = ifr.ifr_ifindex;
    dest_addr.sll_halen = ETH_ALEN;
    memset(dest_addr.sll_addr, 0xFF, ETH_ALEN); // Broadcast
    
    // Send packet
    ssize_t sent = sendto(sock, packet, packet_len, 0,
                         (struct sockaddr*)&dest_addr, sizeof(dest_addr));
    
    if (sent < 0) {
        perror("sendto");
        close(sock);
        return -1;
    }
    
    printf("Sent %zd bytes\n", sent);
    close(sock);
    return 0;
}

// Packet capture and analysis
typedef struct {
    int socket_fd;
    char interface[IFNAMSIZ];
    void (*packet_handler)(const char *packet, int len, struct sockaddr_ll *addr);
} packet_capture_t;

// Packet handler callback
void analyze_packet(const char *packet, int len, struct sockaddr_ll *addr) {
    printf("\n=== Packet Analysis ===\n");
    printf("Packet length: %d bytes\n", len);
    printf("Interface index: %d\n", addr->sll_ifindex);
    
    // Parse Ethernet header
    struct ethhdr *eth_hdr = (struct ethhdr*)packet;
    printf("Ethernet Header:\n");
    printf("  Destination MAC: %02x:%02x:%02x:%02x:%02x:%02x\n",
           eth_hdr->h_dest[0], eth_hdr->h_dest[1], eth_hdr->h_dest[2],
           eth_hdr->h_dest[3], eth_hdr->h_dest[4], eth_hdr->h_dest[5]);
    printf("  Source MAC: %02x:%02x:%02x:%02x:%02x:%02x\n",
           eth_hdr->h_source[0], eth_hdr->h_source[1], eth_hdr->h_source[2],
           eth_hdr->h_source[3], eth_hdr->h_source[4], eth_hdr->h_source[5]);
    printf("  Protocol: 0x%04x\n", ntohs(eth_hdr->h_proto));
    
    // Parse IP header if it's an IP packet
    if (ntohs(eth_hdr->h_proto) == ETH_P_IP) {
        struct iphdr *ip_hdr = (struct iphdr*)(packet + sizeof(struct ethhdr));
        
        printf("IP Header:\n");
        printf("  Version: %d\n", ip_hdr->version);
        printf("  Header Length: %d bytes\n", ip_hdr->ihl * 4);
        printf("  Total Length: %d\n", ntohs(ip_hdr->tot_len));
        printf("  Protocol: %d\n", ip_hdr->protocol);
        printf("  TTL: %d\n", ip_hdr->ttl);
        
        struct in_addr src_addr = {ip_hdr->saddr};
        struct in_addr dst_addr = {ip_hdr->daddr};
        printf("  Source IP: %s\n", inet_ntoa(src_addr));
        printf("  Destination IP: %s\n", inet_ntoa(dst_addr));
        
        // Parse transport layer
        int ip_header_len = ip_hdr->ihl * 4;
        char *transport_data = (char*)packet + sizeof(struct ethhdr) + ip_header_len;
        
        switch (ip_hdr->protocol) {
            case IPPROTO_TCP: {
                struct tcphdr *tcp_hdr = (struct tcphdr*)transport_data;
                printf("TCP Header:\n");
                printf("  Source Port: %d\n", ntohs(tcp_hdr->source));
                printf("  Destination Port: %d\n", ntohs(tcp_hdr->dest));
                printf("  Sequence Number: %u\n", ntohl(tcp_hdr->seq));
                printf("  Acknowledgment: %u\n", ntohl(tcp_hdr->ack_seq));
                printf("  Flags: %s%s%s%s%s%s\n",
                       tcp_hdr->fin ? "FIN " : "",
                       tcp_hdr->syn ? "SYN " : "",
                       tcp_hdr->rst ? "RST " : "",
                       tcp_hdr->psh ? "PSH " : "",
                       tcp_hdr->ack ? "ACK " : "",
                       tcp_hdr->urg ? "URG " : "");
                break;
            }
            case IPPROTO_UDP: {
                struct udphdr *udp_hdr = (struct udphdr*)transport_data;
                printf("UDP Header:\n");
                printf("  Source Port: %d\n", ntohs(udp_hdr->source));
                printf("  Destination Port: %d\n", ntohs(udp_hdr->dest));
                printf("  Length: %d\n", ntohs(udp_hdr->len));
                break;
            }
            case IPPROTO_ICMP: {
                struct icmphdr *icmp_hdr = (struct icmphdr*)transport_data;
                printf("ICMP Header:\n");
                printf("  Type: %d\n", icmp_hdr->type);
                printf("  Code: %d\n", icmp_hdr->code);
                break;
            }
        }
    }
}

// Start packet capture
int start_packet_capture(const char *interface) {
    int sock = socket(AF_PACKET, SOCK_RAW, htons(ETH_P_ALL));
    if (sock < 0) {
        perror("socket");
        return -1;
    }
    
    // Bind to specific interface
    struct ifreq ifr;
    strncpy(ifr.ifr_name, interface, IFNAMSIZ);
    if (ioctl(sock, SIOCGIFINDEX, &ifr) < 0) {
        perror("ioctl SIOCGIFINDEX");
        close(sock);
        return -1;
    }
    
    struct sockaddr_ll bind_addr = {0};
    bind_addr.sll_family = AF_PACKET;
    bind_addr.sll_protocol = htons(ETH_P_ALL);
    bind_addr.sll_ifindex = ifr.ifr_ifindex;
    
    if (bind(sock, (struct sockaddr*)&bind_addr, sizeof(bind_addr)) < 0) {
        perror("bind");
        close(sock);
        return -1;
    }
    
    printf("Starting packet capture on interface %s...\n", interface);
    printf("Press Ctrl+C to stop\n\n");
    
    char buffer[65536];
    struct sockaddr_ll addr;
    socklen_t addr_len = sizeof(addr);
    
    while (1) {
        ssize_t len = recvfrom(sock, buffer, sizeof(buffer), 0,
                              (struct sockaddr*)&addr, &addr_len);
        
        if (len < 0) {
            if (errno == EINTR) break;
            perror("recvfrom");
            break;
        }
        
        analyze_packet(buffer, len, &addr);
    }
    
    close(sock);
    return 0;
}

// Network interface manipulation
void get_interface_info(const char *interface) {
    int sock = socket(AF_INET, SOCK_DGRAM, 0);
    if (sock < 0) {
        perror("socket");
        return;
    }
    
    struct ifreq ifr;
    strncpy(ifr.ifr_name, interface, IFNAMSIZ);
    
    printf("Interface Information: %s\n", interface);
    
    // Get IP address
    if (ioctl(sock, SIOCGIFADDR, &ifr) == 0) {
        struct sockaddr_in *addr = (struct sockaddr_in*)&ifr.ifr_addr;
        printf("  IP Address: %s\n", inet_ntoa(addr->sin_addr));
    }
    
    // Get netmask
    if (ioctl(sock, SIOCGIFNETMASK, &ifr) == 0) {
        struct sockaddr_in *mask = (struct sockaddr_in*)&ifr.ifr_netmask;
        printf("  Netmask: %s\n", inet_ntoa(mask->sin_addr));
    }
    
    // Get MAC address
    if (ioctl(sock, SIOCGIFHWADDR, &ifr) == 0) {
        unsigned char *mac = (unsigned char*)ifr.ifr_hwaddr.sa_data;
        printf("  MAC Address: %02x:%02x:%02x:%02x:%02x:%02x\n",
               mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    }
    
    // Get MTU
    if (ioctl(sock, SIOCGIFMTU, &ifr) == 0) {
        printf("  MTU: %d\n", ifr.ifr_mtu);
    }
    
    // Get flags
    if (ioctl(sock, SIOCGIFFLAGS, &ifr) == 0) {
        printf("  Flags: ");
        if (ifr.ifr_flags & IFF_UP) printf("UP ");
        if (ifr.ifr_flags & IFF_BROADCAST) printf("BROADCAST ");
        if (ifr.ifr_flags & IFF_LOOPBACK) printf("LOOPBACK ");
        if (ifr.ifr_flags & IFF_POINTOPOINT) printf("POINTOPOINT ");
        if (ifr.ifr_flags & IFF_MULTICAST) printf("MULTICAST ");
        printf("\n");
    }
    
    close(sock);
}

int main(int argc, char *argv[]) {
    if (argc < 2) {
        printf("Raw Socket Programming Demo\n");
        printf("===========================\n\n");
        printf("Usage: %s <command> [args]\n\n", argv[0]);
        printf("Commands:\n");
        printf("  capture <interface>     - Capture and analyze packets\n");
        printf("  info <interface>        - Get interface information\n");
        printf("  tcp <src_ip> <dst_ip> <src_port> <dst_port> <interface>\n");
        printf("                          - Send TCP SYN packet\n");
        return 1;
    }
    
    if (getuid() != 0) {
        printf("This program requires root privileges for raw socket access\n");
        return 1;
    }
    
    if (strcmp(argv[1], "capture") == 0 && argc > 2) {
        start_packet_capture(argv[2]);
    } else if (strcmp(argv[1], "info") == 0 && argc > 2) {
        get_interface_info(argv[2]);
    } else if (strcmp(argv[1], "tcp") == 0 && argc > 6) {
        tcp_packet_t packet;
        const char *payload = "Hello, World!";
        int packet_len = create_tcp_packet(&packet, argv[2], argv[3],
                                         atoi(argv[4]), atoi(argv[5]),
                                         12345, 0, 0x02, payload, strlen(payload));
        
        printf("Sending TCP SYN packet from %s:%s to %s:%s\n",
               argv[2], argv[4], argv[3], argv[5]);
        
        send_raw_packet(argv[6], &packet, packet_len);
    } else {
        printf("Invalid command or missing arguments\n");
        return 1;
    }
    
    return 0;
}
```

## Custom Protocol Implementation

### Building a Custom Network Protocol

```c
// custom_protocol.c - Custom network protocol implementation
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <pthread.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <time.h>
#include <errno.h>
#include <poll.h>

// Custom protocol definitions
#define CUSTOM_PROTOCOL_VERSION 1
#define CUSTOM_PROTOCOL_PORT 9999
#define MAX_PAYLOAD_SIZE 1024
#define MAX_CONNECTIONS 100

// Message types
typedef enum {
    MSG_HELLO = 1,
    MSG_DATA = 2,
    MSG_ACK = 3,
    MSG_ERROR = 4,
    MSG_HEARTBEAT = 5,
    MSG_GOODBYE = 6
} message_type_t;

// Protocol header
typedef struct __attribute__((packed)) {
    uint8_t version;
    uint8_t type;
    uint16_t flags;
    uint32_t sequence_number;
    uint32_t payload_length;
    uint32_t checksum;
    uint64_t timestamp;
} protocol_header_t;

// Complete message
typedef struct {
    protocol_header_t header;
    char payload[MAX_PAYLOAD_SIZE];
} protocol_message_t;

// Connection state
typedef struct {
    int socket_fd;
    struct sockaddr_in address;
    uint32_t next_sequence;
    uint32_t expected_sequence;
    time_t last_activity;
    int state;
} connection_t;

// Server state
typedef struct {
    int listen_socket;
    connection_t connections[MAX_CONNECTIONS];
    int connection_count;
    pthread_mutex_t connections_mutex;
    int running;
} server_state_t;

// Calculate simple checksum
uint32_t calculate_message_checksum(const protocol_message_t *message) {
    uint32_t checksum = 0;
    const uint8_t *data = (const uint8_t*)message;
    size_t len = sizeof(protocol_header_t) + message->header.payload_length;
    
    // Skip checksum field in calculation
    for (size_t i = 0; i < len; i++) {
        if (i >= offsetof(protocol_header_t, checksum) && 
            i < offsetof(protocol_header_t, checksum) + sizeof(uint32_t)) {
            continue;
        }
        checksum += data[i];
    }
    
    return checksum;
}

// Create protocol message
int create_message(protocol_message_t *message, message_type_t type,
                  uint32_t sequence, const char *payload, size_t payload_len) {
    
    if (payload_len > MAX_PAYLOAD_SIZE) {
        return -1;
    }
    
    memset(message, 0, sizeof(protocol_message_t));
    
    // Fill header
    message->header.version = CUSTOM_PROTOCOL_VERSION;
    message->header.type = type;
    message->header.flags = 0;
    message->header.sequence_number = htonl(sequence);
    message->header.payload_length = htonl(payload_len);
    message->header.timestamp = htobe64(time(NULL));
    
    // Copy payload
    if (payload && payload_len > 0) {
        memcpy(message->payload, payload, payload_len);
    }
    
    // Calculate checksum
    message->header.checksum = htonl(calculate_message_checksum(message));
    
    return sizeof(protocol_header_t) + payload_len;
}

// Validate message
int validate_message(const protocol_message_t *message, size_t message_len) {
    // Check minimum size
    if (message_len < sizeof(protocol_header_t)) {
        return -1;
    }
    
    // Check version
    if (message->header.version != CUSTOM_PROTOCOL_VERSION) {
        printf("Invalid protocol version: %d\n", message->header.version);
        return -1;
    }
    
    // Check payload length
    uint32_t payload_len = ntohl(message->header.payload_length);
    if (payload_len > MAX_PAYLOAD_SIZE) {
        printf("Payload too large: %u\n", payload_len);
        return -1;
    }
    
    if (message_len != sizeof(protocol_header_t) + payload_len) {
        printf("Message length mismatch\n");
        return -1;
    }
    
    // Verify checksum
    uint32_t received_checksum = ntohl(message->header.checksum);
    protocol_message_t temp_message = *message;
    temp_message.header.checksum = 0;
    uint32_t calculated_checksum = calculate_message_checksum(&temp_message);
    
    if (received_checksum != calculated_checksum) {
        printf("Checksum mismatch: received %u, calculated %u\n",
               received_checksum, calculated_checksum);
        return -1;
    }
    
    return 0;
}

// Send message with proper framing
int send_message(int socket_fd, const protocol_message_t *message) {
    size_t message_len = sizeof(protocol_header_t) + ntohl(message->header.payload_length);
    
    ssize_t sent = send(socket_fd, message, message_len, MSG_NOSIGNAL);
    if (sent < 0) {
        perror("send");
        return -1;
    }
    
    if ((size_t)sent != message_len) {
        printf("Partial send: %zd of %zu bytes\n", sent, message_len);
        return -1;
    }
    
    return 0;
}

// Receive complete message
int receive_message(int socket_fd, protocol_message_t *message) {
    // First, receive the header
    ssize_t received = recv(socket_fd, &message->header, sizeof(protocol_header_t), MSG_WAITALL);
    if (received <= 0) {
        return received;
    }
    
    if (received != sizeof(protocol_header_t)) {
        printf("Incomplete header received: %zd bytes\n", received);
        return -1;
    }
    
    // Validate header fields
    uint32_t payload_len = ntohl(message->header.payload_length);
    if (payload_len > MAX_PAYLOAD_SIZE) {
        printf("Invalid payload length: %u\n", payload_len);
        return -1;
    }
    
    // Receive payload if present
    if (payload_len > 0) {
        received = recv(socket_fd, message->payload, payload_len, MSG_WAITALL);
        if (received <= 0) {
            return received;
        }
        
        if ((size_t)received != payload_len) {
            printf("Incomplete payload received: %zd of %u bytes\n", received, payload_len);
            return -1;
        }
    }
    
    // Validate complete message
    size_t total_len = sizeof(protocol_header_t) + payload_len;
    if (validate_message(message, total_len) < 0) {
        return -1;
    }
    
    return total_len;
}

// Handle client message
void handle_client_message(connection_t *conn, const protocol_message_t *message) {
    uint32_t sequence = ntohl(message->header.sequence_number);
    uint32_t payload_len = ntohl(message->header.payload_length);
    
    printf("Received message: type=%d, seq=%u, len=%u\n",
           message->header.type, sequence, payload_len);
    
    switch (message->header.type) {
        case MSG_HELLO: {
            printf("Client hello from %s\n", inet_ntoa(conn->address.sin_addr));
            
            // Send ACK
            protocol_message_t ack_message;
            create_message(&ack_message, MSG_ACK, conn->next_sequence++, NULL, 0);
            send_message(conn->socket_fd, &ack_message);
            break;
        }
        
        case MSG_DATA: {
            printf("Data message: %.*s\n", payload_len, message->payload);
            
            // Send ACK
            protocol_message_t ack_message;
            create_message(&ack_message, MSG_ACK, conn->next_sequence++, NULL, 0);
            send_message(conn->socket_fd, &ack_message);
            break;
        }
        
        case MSG_HEARTBEAT: {
            printf("Heartbeat from client\n");
            
            // Send heartbeat response
            protocol_message_t heartbeat_message;
            create_message(&heartbeat_message, MSG_HEARTBEAT, conn->next_sequence++, NULL, 0);
            send_message(conn->socket_fd, &heartbeat_message);
            break;
        }
        
        case MSG_GOODBYE: {
            printf("Client goodbye\n");
            
            // Send ACK and close connection
            protocol_message_t ack_message;
            create_message(&ack_message, MSG_ACK, conn->next_sequence++, NULL, 0);
            send_message(conn->socket_fd, &ack_message);
            
            close(conn->socket_fd);
            conn->socket_fd = -1;
            break;
        }
        
        default:
            printf("Unknown message type: %d\n", message->header.type);
            
            // Send error response
            protocol_message_t error_message;
            const char *error_text = "Unknown message type";
            create_message(&error_message, MSG_ERROR, conn->next_sequence++,
                         error_text, strlen(error_text));
            send_message(conn->socket_fd, &error_message);
            break;
    }
    
    conn->last_activity = time(NULL);
}

// Server thread function
void* server_thread(void *arg) {
    server_state_t *server = (server_state_t*)arg;
    
    printf("Server thread started\n");
    
    while (server->running) {
        // Prepare pollfd array
        struct pollfd poll_fds[MAX_CONNECTIONS + 1];
        int poll_count = 0;
        
        // Add listen socket
        poll_fds[0].fd = server->listen_socket;
        poll_fds[0].events = POLLIN;
        poll_count = 1;
        
        // Add client connections
        pthread_mutex_lock(&server->connections_mutex);
        for (int i = 0; i < server->connection_count; i++) {
            if (server->connections[i].socket_fd >= 0) {
                poll_fds[poll_count].fd = server->connections[i].socket_fd;
                poll_fds[poll_count].events = POLLIN;
                poll_count++;
            }
        }
        pthread_mutex_unlock(&server->connections_mutex);
        
        // Wait for activity
        int poll_result = poll(poll_fds, poll_count, 1000); // 1 second timeout
        
        if (poll_result < 0) {
            if (errno == EINTR) continue;
            perror("poll");
            break;
        }
        
        if (poll_result == 0) {
            // Timeout - check for inactive connections
            time_t now = time(NULL);
            pthread_mutex_lock(&server->connections_mutex);
            for (int i = 0; i < server->connection_count; i++) {
                if (server->connections[i].socket_fd >= 0 &&
                    now - server->connections[i].last_activity > 60) {
                    printf("Closing inactive connection\n");
                    close(server->connections[i].socket_fd);
                    server->connections[i].socket_fd = -1;
                }
            }
            pthread_mutex_unlock(&server->connections_mutex);
            continue;
        }
        
        // Check listen socket for new connections
        if (poll_fds[0].revents & POLLIN) {
            struct sockaddr_in client_addr;
            socklen_t addr_len = sizeof(client_addr);
            
            int client_fd = accept(server->listen_socket,
                                 (struct sockaddr*)&client_addr, &addr_len);
            
            if (client_fd >= 0) {
                printf("New connection from %s:%d\n",
                       inet_ntoa(client_addr.sin_addr), ntohs(client_addr.sin_port));
                
                // Add to connections list
                pthread_mutex_lock(&server->connections_mutex);
                if (server->connection_count < MAX_CONNECTIONS) {
                    connection_t *conn = &server->connections[server->connection_count++];
                    conn->socket_fd = client_fd;
                    conn->address = client_addr;
                    conn->next_sequence = 1;
                    conn->expected_sequence = 1;
                    conn->last_activity = time(NULL);
                    conn->state = 0;
                }
                pthread_mutex_unlock(&server->connections_mutex);
            }
        }
        
        // Check client connections for data
        for (int i = 1; i < poll_count; i++) {
            if (poll_fds[i].revents & POLLIN) {
                // Find corresponding connection
                pthread_mutex_lock(&server->connections_mutex);
                connection_t *conn = NULL;
                for (int j = 0; j < server->connection_count; j++) {
                    if (server->connections[j].socket_fd == poll_fds[i].fd) {
                        conn = &server->connections[j];
                        break;
                    }
                }
                
                if (conn) {
                    protocol_message_t message;
                    int result = receive_message(conn->socket_fd, &message);
                    
                    if (result > 0) {
                        handle_client_message(conn, &message);
                    } else if (result == 0) {
                        printf("Client disconnected\n");
                        close(conn->socket_fd);
                        conn->socket_fd = -1;
                    } else {
                        printf("Error receiving message from client\n");
                        close(conn->socket_fd);
                        conn->socket_fd = -1;
                    }
                }
                pthread_mutex_unlock(&server->connections_mutex);
            }
        }
    }
    
    printf("Server thread exiting\n");
    return NULL;
}

// Start custom protocol server
int start_server(uint16_t port) {
    server_state_t server = {0};
    
    // Create listen socket
    server.listen_socket = socket(AF_INET, SOCK_STREAM, 0);
    if (server.listen_socket < 0) {
        perror("socket");
        return -1;
    }
    
    // Set socket options
    int reuse = 1;
    setsockopt(server.listen_socket, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
    
    // Bind socket
    struct sockaddr_in server_addr = {0};
    server_addr.sin_family = AF_INET;
    server_addr.sin_addr.s_addr = INADDR_ANY;
    server_addr.sin_port = htons(port);
    
    if (bind(server.listen_socket, (struct sockaddr*)&server_addr, sizeof(server_addr)) < 0) {
        perror("bind");
        close(server.listen_socket);
        return -1;
    }
    
    // Listen for connections
    if (listen(server.listen_socket, 10) < 0) {
        perror("listen");
        close(server.listen_socket);
        return -1;
    }
    
    printf("Custom protocol server listening on port %d\n", port);
    
    // Initialize server state
    pthread_mutex_init(&server.connections_mutex, NULL);
    server.running = 1;
    
    // Start server thread
    pthread_t server_thread_id;
    pthread_create(&server_thread_id, NULL, server_thread, &server);
    
    // Wait for shutdown signal
    printf("Press Enter to shutdown server...\n");
    getchar();
    
    // Shutdown server
    server.running = 0;
    pthread_join(server_thread_id, NULL);
    
    // Cleanup
    pthread_mutex_lock(&server.connections_mutex);
    for (int i = 0; i < server.connection_count; i++) {
        if (server.connections[i].socket_fd >= 0) {
            close(server.connections[i].socket_fd);
        }
    }
    pthread_mutex_unlock(&server.connections_mutex);
    
    close(server.listen_socket);
    pthread_mutex_destroy(&server.connections_mutex);
    
    return 0;
}

// Custom protocol client
int run_client(const char *server_ip, uint16_t port) {
    int sock = socket(AF_INET, SOCK_STREAM, 0);
    if (sock < 0) {
        perror("socket");
        return -1;
    }
    
    // Connect to server
    struct sockaddr_in server_addr = {0};
    server_addr.sin_family = AF_INET;
    server_addr.sin_port = htons(port);
    inet_pton(AF_INET, server_ip, &server_addr.sin_addr);
    
    if (connect(sock, (struct sockaddr*)&server_addr, sizeof(server_addr)) < 0) {
        perror("connect");
        close(sock);
        return -1;
    }
    
    printf("Connected to server %s:%d\n", server_ip, port);
    
    uint32_t sequence = 1;
    
    // Send hello message
    protocol_message_t hello_message;
    const char *hello_payload = "Hello from client!";
    create_message(&hello_message, MSG_HELLO, sequence++,
                  hello_payload, strlen(hello_payload));
    send_message(sock, &hello_message);
    
    // Send some data messages
    for (int i = 0; i < 3; i++) {
        protocol_message_t data_message;
        char data_payload[256];
        snprintf(data_payload, sizeof(data_payload), "Data message #%d", i + 1);
        
        create_message(&data_message, MSG_DATA, sequence++,
                      data_payload, strlen(data_payload));
        send_message(sock, &data_message);
        
        // Wait for ACK
        protocol_message_t response;
        if (receive_message(sock, &response) > 0) {
            printf("Received ACK for message #%d\n", i + 1);
        }
        
        sleep(1);
    }
    
    // Send goodbye message
    protocol_message_t goodbye_message;
    create_message(&goodbye_message, MSG_GOODBYE, sequence++, NULL, 0);
    send_message(sock, &goodbye_message);
    
    // Wait for final ACK
    protocol_message_t response;
    receive_message(sock, &response);
    
    close(sock);
    return 0;
}

int main(int argc, char *argv[]) {
    if (argc < 2) {
        printf("Custom Protocol Implementation Demo\n");
        printf("==================================\n\n");
        printf("Usage: %s <mode> [args]\n\n", argv[0]);
        printf("Modes:\n");
        printf("  server [port]              - Start server (default port: %d)\n", CUSTOM_PROTOCOL_PORT);
        printf("  client <server_ip> [port]  - Connect as client\n");
        return 1;
    }
    
    if (strcmp(argv[1], "server") == 0) {
        uint16_t port = CUSTOM_PROTOCOL_PORT;
        if (argc > 2) {
            port = atoi(argv[2]);
        }
        return start_server(port);
    } else if (strcmp(argv[1], "client") == 0 && argc > 2) {
        uint16_t port = CUSTOM_PROTOCOL_PORT;
        if (argc > 3) {
            port = atoi(argv[3]);
        }
        return run_client(argv[2], port);
    } else {
        printf("Invalid mode or missing arguments\n");
        return 1;
    }
}
```

## High-Performance Packet Processing

### Zero-Copy Networking Implementation

```bash
#!/bin/bash
# high_performance_networking.sh - High-performance networking techniques

# Setup high-performance networking environment
setup_high_performance_networking() {
    echo "=== Setting up High-Performance Networking Environment ==="
    
    # Install required packages
    echo "Installing required packages..."
    apt-get update
    apt-get install -y \
        dpdk \
        dpdk-dev \
        libdpdk-dev \
        hugepages \
        libnuma-dev \
        python3-pyelftools
    
    # Configure hugepages
    echo "Configuring hugepages..."
    echo 1024 > /sys/kernel/mm/hugepages/hugepages-2048kB/nr_hugepages
    
    # Mount hugepages
    mkdir -p /mnt/huge
    mount -t hugetlbfs nodev /mnt/huge
    
    # Configure DPDK
    echo "Configuring DPDK..."
    
    # Setup DPDK environment
    export RTE_SDK=/usr/share/dpdk
    export RTE_TARGET=x86_64-native-linuxapp-gcc
    
    # Load required modules
    modprobe uio
    modprobe uio_pci_generic
    
    echo "High-performance networking environment setup complete"
}

# CPU and memory optimization
optimize_cpu_memory() {
    echo "=== CPU and Memory Optimization ==="
    
    # CPU frequency scaling
    echo "Setting CPU frequency scaling to performance..."
    for cpu in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
        if [ -f "$cpu" ]; then
            echo performance > "$cpu" 2>/dev/null
        fi
    done
    
    # Disable CPU idle states
    echo "Disabling CPU idle states..."
    for cpu in /sys/devices/system/cpu/cpu*/cpuidle/state*/disable; do
        if [ -f "$cpu" ]; then
            echo 1 > "$cpu" 2>/dev/null
        fi
    done
    
    # Set CPU affinity for interrupts
    echo "Optimizing interrupt handling..."
    
    # Move interrupts to CPU 0
    for irq in /proc/irq/*/smp_affinity; do
        if [ -f "$irq" ]; then
            echo 1 > "$irq" 2>/dev/null
        fi
    done
    
    # Disable NUMA balancing
    echo 0 > /proc/sys/kernel/numa_balancing 2>/dev/null
    
    # Memory optimization
    echo "Optimizing memory settings..."
    
    # Disable swap
    swapoff -a
    
    # Set vm settings
    echo 10 > /proc/sys/vm/dirty_ratio
    echo 5 > /proc/sys/vm/dirty_background_ratio
    echo 0 > /proc/sys/vm/swappiness
    
    echo "CPU and memory optimization complete"
}

# Network interface optimization
optimize_network_interfaces() {
    local interface=${1:-"eth0"}
    
    echo "=== Network Interface Optimization: $interface ==="
    
    # Check if interface exists
    if ! ip link show "$interface" >/dev/null 2>&1; then
        echo "Interface $interface not found"
        return 1
    fi
    
    # Set interface up
    ip link set "$interface" up
    
    # Increase ring buffer sizes
    echo "Optimizing ring buffer sizes..."
    ethtool -G "$interface" rx 4096 tx 4096 2>/dev/null || echo "Cannot set ring buffer sizes"
    
    # Enable receive checksum offloading
    ethtool -K "$interface" rx on 2>/dev/null
    ethtool -K "$interface" tx on 2>/dev/null
    
    # Enable TCP segmentation offload
    ethtool -K "$interface" tso on 2>/dev/null
    ethtool -K "$interface" gso on 2>/dev/null
    
    # Enable receive packet steering
    ethtool -K "$interface" rxhash on 2>/dev/null
    
    # Configure receive side scaling
    local num_queues=$(ethtool -l "$interface" 2>/dev/null | grep -A4 "Current hardware settings" | grep "Combined" | awk '{print $2}')
    if [ -n "$num_queues" ] && [ "$num_queues" -gt 1 ]; then
        echo "Configuring RSS with $num_queues queues"
        ethtool -X "$interface" equal "$num_queues" 2>/dev/null
    fi
    
    # Set interrupt coalescing
    ethtool -C "$interface" rx-usecs 50 tx-usecs 50 2>/dev/null
    
    # Increase network buffer sizes
    echo "Optimizing network buffer sizes..."
    
    # TCP buffer sizes
    sysctl -w net.core.rmem_max=134217728
    sysctl -w net.core.wmem_max=134217728
    sysctl -w net.ipv4.tcp_rmem="4096 87380 134217728"
    sysctl -w net.ipv4.tcp_wmem="4096 16384 134217728"
    
    # UDP buffer sizes
    sysctl -w net.core.netdev_max_backlog=5000
    sysctl -w net.core.netdev_budget=600
    
    echo "Network interface optimization complete"
}

# Analyze network performance
analyze_network_performance() {
    local interface=${1:-"eth0"}
    local duration=${2:-30}
    
    echo "=== Network Performance Analysis: $interface ==="
    echo "Duration: ${duration} seconds"
    
    # Get baseline statistics
    local stats_before="/tmp/net_stats_before_$$"
    cat /proc/net/dev > "$stats_before"
    
    sleep "$duration"
    
    # Get final statistics
    local stats_after="/tmp/net_stats_after_$$"
    cat /proc/net/dev > "$stats_after"
    
    # Calculate deltas
    echo "Network interface statistics:"
    awk -v interface="$interface:" -v duration="$duration" '
    BEGIN { found = 0 }
    FNR == NR {
        if ($1 == interface) {
            rx_bytes_before = $2
            rx_packets_before = $3
            rx_errors_before = $4
            rx_dropped_before = $5
            tx_bytes_before = $10
            tx_packets_before = $11
            tx_errors_before = $12
            tx_dropped_before = $13
            found = 1
        }
        next
    }
    {
        if ($1 == interface && found) {
            rx_bytes_after = $2
            rx_packets_after = $3
            rx_errors_after = $4
            rx_dropped_after = $5
            tx_bytes_after = $10
            tx_packets_after = $11
            tx_errors_after = $12
            tx_dropped_after = $13
            
            rx_bytes_delta = rx_bytes_after - rx_bytes_before
            rx_packets_delta = rx_packets_after - rx_packets_before
            tx_bytes_delta = tx_bytes_after - tx_bytes_before
            tx_packets_delta = tx_packets_after - tx_packets_before
            
            printf "  RX: %.2f MB/s (%d packets/s)\n", rx_bytes_delta / duration / 1024 / 1024, rx_packets_delta / duration
            printf "  TX: %.2f MB/s (%d packets/s)\n", tx_bytes_delta / duration / 1024 / 1024, tx_packets_delta / duration
            printf "  RX Errors: %d, Dropped: %d\n", rx_errors_after - rx_errors_before, rx_dropped_after - rx_dropped_before
            printf "  TX Errors: %d, Dropped: %d\n", tx_errors_after - tx_errors_before, tx_dropped_after - tx_dropped_before
        }
    }' "$stats_before" "$stats_after"
    
    # Cleanup
    rm -f "$stats_before" "$stats_after"
    
    # Show current interface settings
    echo
    echo "Current interface settings:"
    ethtool "$interface" 2>/dev/null | grep -E "(Speed|Duplex|Link detected)"
    
    echo
    echo "Ring buffer settings:"
    ethtool -g "$interface" 2>/dev/null
    
    echo
    echo "Offload settings:"
    ethtool -k "$interface" 2>/dev/null | grep -E "(tcp-segmentation-offload|receive-hashing|checksum)"
}

# Benchmark network throughput
benchmark_network_throughput() {
    local mode=${1:-"help"}
    local host=${2:-"localhost"}
    local port=${3:-5001}
    local duration=${4:-10}
    
    echo "=== Network Throughput Benchmark ==="
    
    case "$mode" in
        "server")
            echo "Starting iperf3 server on port $port..."
            iperf3 -s -p "$port"
            ;;
        "client")
            echo "Running iperf3 client test to $host:$port for ${duration}s..."
            iperf3 -c "$host" -p "$port" -t "$duration" -P 4
            ;;
        "udp_server")
            echo "Starting UDP iperf3 server on port $port..."
            iperf3 -s -p "$port"
            ;;
        "udp_client")
            echo "Running UDP iperf3 client test to $host:$port for ${duration}s..."
            iperf3 -c "$host" -p "$port" -t "$duration" -u -b 1G
            ;;
        *)
            echo "Usage: benchmark_network_throughput <mode> [host] [port] [duration]"
            echo "Modes:"
            echo "  server     - Start TCP server"
            echo "  client     - Run TCP client test"
            echo "  udp_server - Start UDP server"
            echo "  udp_client - Run UDP client test"
            return 1
            ;;
    esac
}

# DPDK setup and testing
setup_dpdk() {
    echo "=== DPDK Setup and Testing ==="
    
    # Check if DPDK is available
    if ! command -v dpdk-devbind.py >/dev/null; then
        echo "DPDK not found. Please install DPDK first."
        return 1
    fi
    
    # Show available NICs
    echo "Available network interfaces:"
    dpdk-devbind.py --status-dev net
    
    echo
    echo "To bind an interface to DPDK:"
    echo "1. Bring down the interface: ip link set <interface> down"
    echo "2. Bind to DPDK driver: dpdk-devbind.py --bind=uio_pci_generic <pci_address>"
    echo "3. Run DPDK application"
    echo
    echo "To unbind from DPDK:"
    echo "dpdk-devbind.py --bind=<original_driver> <pci_address>"
    
    # Create simple DPDK test application
    cat > /tmp/dpdk_test.c << 'EOF'
#include <rte_eal.h>
#include <rte_ethdev.h>
#include <rte_mbuf.h>
#include <rte_lcore.h>

#define NUM_MBUFS 8191
#define MBUF_CACHE_SIZE 250
#define BURST_SIZE 32

static struct rte_mempool *mbuf_pool;

static int packet_capture_loop(void *arg) {
    uint16_t port_id = *(uint16_t*)arg;
    struct rte_mbuf *bufs[BURST_SIZE];
    
    printf("Starting packet capture on port %u\n", port_id);
    
    while (1) {
        uint16_t nb_rx = rte_eth_rx_burst(port_id, 0, bufs, BURST_SIZE);
        
        if (nb_rx > 0) {
            printf("Received %u packets\n", nb_rx);
            
            for (uint16_t i = 0; i < nb_rx; i++) {
                rte_pktmbuf_free(bufs[i]);
            }
        }
    }
    
    return 0;
}

int main(int argc, char *argv[]) {
    int ret = rte_eal_init(argc, argv);
    if (ret < 0) {
        printf("Error initializing EAL\n");
        return -1;
    }
    
    uint16_t nb_ports = rte_eth_dev_count_avail();
    printf("Found %u ports\n", nb_ports);
    
    if (nb_ports == 0) {
        printf("No Ethernet ports found\n");
        return -1;
    }
    
    // Create mbuf pool
    mbuf_pool = rte_pktmbuf_pool_create("MBUF_POOL", NUM_MBUFS,
                                       MBUF_CACHE_SIZE, 0,
                                       RTE_MBUF_DEFAULT_BUF_SIZE,
                                       rte_socket_id());
    
    if (mbuf_pool == NULL) {
        printf("Cannot create mbuf pool\n");
        return -1;
    }
    
    // Configure first port
    uint16_t port_id = 0;
    struct rte_eth_conf port_conf = {0};
    
    ret = rte_eth_dev_configure(port_id, 1, 1, &port_conf);
    if (ret < 0) {
        printf("Cannot configure port %u\n", port_id);
        return -1;
    }
    
    ret = rte_eth_rx_queue_setup(port_id, 0, 128,
                                rte_eth_dev_socket_id(port_id),
                                NULL, mbuf_pool);
    if (ret < 0) {
        printf("Cannot setup RX queue\n");
        return -1;
    }
    
    ret = rte_eth_tx_queue_setup(port_id, 0, 512,
                                rte_eth_dev_socket_id(port_id),
                                NULL);
    if (ret < 0) {
        printf("Cannot setup TX queue\n");
        return -1;
    }
    
    ret = rte_eth_dev_start(port_id);
    if (ret < 0) {
        printf("Cannot start port %u\n", port_id);
        return -1;
    }
    
    rte_eth_promiscuous_enable(port_id);
    
    printf("Port %u started successfully\n", port_id);
    
    // Launch packet capture on main core
    packet_capture_loop(&port_id);
    
    return 0;
}
EOF
    
    echo "DPDK test application created at /tmp/dpdk_test.c"
    echo "To compile: gcc -o dpdk_test dpdk_test.c -ldpdk"
}

# Main function
main() {
    local action=${1:-"help"}
    
    case "$action" in
        "setup")
            setup_high_performance_networking
            ;;
        "optimize_cpu")
            optimize_cpu_memory
            ;;
        "optimize_net")
            optimize_network_interfaces "$2"
            ;;
        "analyze")
            analyze_network_performance "$2" "$3"
            ;;
        "benchmark")
            benchmark_network_throughput "$2" "$3" "$4" "$5"
            ;;
        "dpdk")
            setup_dpdk
            ;;
        "all")
            setup_high_performance_networking
            optimize_cpu_memory
            optimize_network_interfaces "eth0"
            ;;
        *)
            echo "High-Performance Networking Tools"
            echo "================================="
            echo
            echo "Usage: $0 <command> [args]"
            echo
            echo "Commands:"
            echo "  setup              - Setup high-performance networking environment"
            echo "  optimize_cpu       - Optimize CPU and memory settings"
            echo "  optimize_net <if>  - Optimize network interface"
            echo "  analyze <if> [dur] - Analyze network performance"
            echo "  benchmark <mode>   - Run network throughput benchmarks"
            echo "  dpdk               - Setup DPDK environment"
            echo "  all                - Run setup and optimizations"
            ;;
    esac
}

main "$@"
```

## Best Practices

1. **Zero-Copy Techniques**: Minimize memory copies in the data path
2. **CPU Affinity**: Bind network interrupts and processing threads to specific CPUs
3. **Kernel Bypass**: Use DPDK or similar frameworks for maximum performance
4. **Protocol Design**: Design protocols for efficiency and extensibility
5. **Testing**: Comprehensive testing under realistic network conditions

## Conclusion

Advanced networking and protocol implementation requires deep understanding of packet processing, network stacks, and performance optimization techniques. From raw socket programming to custom protocol design and high-performance packet processing, these techniques enable building sophisticated network applications.

The future of high-performance networking lies in kernel bypass technologies, hardware acceleration, and intelligent protocol design. By mastering these advanced techniques, developers can build network applications that meet the demanding requirements of modern distributed systems and real-time applications.