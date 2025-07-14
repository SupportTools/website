---
title: "Distributed Systems and Consensus Algorithms: Building Fault-Tolerant Systems"
date: 2025-03-30T10:00:00-05:00
draft: false
tags: ["Distributed Systems", "Consensus", "Raft", "Paxos", "Byzantine Fault Tolerance", "CAP Theorem"]
categories:
- Distributed Systems
- Algorithms
author: "Matthew Mattox - mmattox@support.tools"
description: "Master distributed systems programming with advanced consensus algorithms, fault tolerance mechanisms, and building resilient distributed applications from first principles"
more_link: "yes"
url: "/distributed-systems-consensus-algorithms/"
---

Distributed systems form the backbone of modern computing infrastructure, from databases to microservices. Understanding consensus algorithms, fault tolerance, and distributed system principles is essential for building reliable, scalable systems. This comprehensive guide explores advanced distributed systems concepts and implementations.

<!--more-->

# [Distributed Systems and Consensus Algorithms](#distributed-systems-consensus)

## Raft Consensus Algorithm Implementation

### Complete Raft Implementation in C

```c
// raft.c - Complete Raft consensus algorithm implementation
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <pthread.h>
#include <time.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <errno.h>
#include <stdatomic.h>
#include <stdbool.h>

#define MAX_NODES 10
#define MAX_LOG_ENTRIES 10000
#define HEARTBEAT_INTERVAL_MS 50
#define ELECTION_TIMEOUT_MIN_MS 150
#define ELECTION_TIMEOUT_MAX_MS 300

// Raft node states
typedef enum {
    FOLLOWER,
    CANDIDATE,
    LEADER
} raft_state_t;

// Log entry structure
typedef struct {
    int term;
    int index;
    char command[256];
    size_t command_len;
} log_entry_t;

// Raft message types
typedef enum {
    MSG_REQUEST_VOTE,
    MSG_REQUEST_VOTE_REPLY,
    MSG_APPEND_ENTRIES,
    MSG_APPEND_ENTRIES_REPLY,
    MSG_CLIENT_REQUEST,
    MSG_CLIENT_REPLY
} message_type_t;

// Message structures
typedef struct {
    message_type_t type;
    int term;
    int candidate_id;
    int last_log_index;
    int last_log_term;
} request_vote_t;

typedef struct {
    message_type_t type;
    int term;
    bool vote_granted;
} request_vote_reply_t;

typedef struct {
    message_type_t type;
    int term;
    int leader_id;
    int prev_log_index;
    int prev_log_term;
    int leader_commit;
    int entries_count;
    log_entry_t entries[100];
} append_entries_t;

typedef struct {
    message_type_t type;
    int term;
    bool success;
    int match_index;
} append_entries_reply_t;

// Network node information
typedef struct {
    int node_id;
    char ip_address[16];
    int port;
    int socket_fd;
    bool connected;
} node_info_t;

// Raft node structure
typedef struct {
    int node_id;
    raft_state_t state;
    
    // Persistent state
    int current_term;
    int voted_for;
    log_entry_t log[MAX_LOG_ENTRIES];
    int log_count;
    
    // Volatile state
    int commit_index;
    int last_applied;
    
    // Leader state
    int next_index[MAX_NODES];
    int match_index[MAX_NODES];
    
    // Cluster configuration
    node_info_t nodes[MAX_NODES];
    int cluster_size;
    
    // Timers and threads
    pthread_mutex_t state_mutex;
    pthread_t election_timer_thread;
    pthread_t heartbeat_thread;
    pthread_t network_thread;
    
    // Election timing
    struct timespec last_heartbeat;
    int election_timeout_ms;
    
    // Statistics
    atomic_int votes_received;
    atomic_int heartbeats_sent;
    atomic_int heartbeats_received;
    
    // Network
    int listen_socket;
    bool running;
    
    // Leadership
    int leader_id;
    bool is_leader;
} raft_node_t;

// Utility functions
static void get_current_time(struct timespec *ts) {
    clock_gettime(CLOCK_MONOTONIC, ts);
}

static long time_diff_ms(struct timespec *start, struct timespec *end) {
    return (end->tv_sec - start->tv_sec) * 1000 + 
           (end->tv_nsec - start->tv_nsec) / 1000000;
}

static int random_election_timeout(void) {
    return ELECTION_TIMEOUT_MIN_MS + 
           (rand() % (ELECTION_TIMEOUT_MAX_MS - ELECTION_TIMEOUT_MIN_MS));
}

// Log operations
static int append_log_entry(raft_node_t *node, int term, const char *command) {
    if (node->log_count >= MAX_LOG_ENTRIES) {
        return -1;
    }
    
    log_entry_t *entry = &node->log[node->log_count];
    entry->term = term;
    entry->index = node->log_count + 1;
    strncpy(entry->command, command, sizeof(entry->command) - 1);
    entry->command[sizeof(entry->command) - 1] = '\0';
    entry->command_len = strlen(entry->command);
    
    node->log_count++;
    return entry->index;
}

static log_entry_t* get_log_entry(raft_node_t *node, int index) {
    if (index <= 0 || index > node->log_count) {
        return NULL;
    }
    return &node->log[index - 1];
}

static int get_last_log_index(raft_node_t *node) {
    return node->log_count;
}

static int get_last_log_term(raft_node_t *node) {
    if (node->log_count == 0) {
        return 0;
    }
    return node->log[node->log_count - 1].term;
}

// State transitions
static void become_follower(raft_node_t *node, int term) {
    printf("Node %d becoming follower (term %d)\n", node->node_id, term);
    
    node->state = FOLLOWER;
    node->current_term = term;
    node->voted_for = -1;
    node->is_leader = false;
    node->leader_id = -1;
    
    get_current_time(&node->last_heartbeat);
    node->election_timeout_ms = random_election_timeout();
}

static void become_candidate(raft_node_t *node) {
    printf("Node %d becoming candidate (term %d)\n", node->node_id, node->current_term + 1);
    
    node->state = CANDIDATE;
    node->current_term++;
    node->voted_for = node->node_id;
    node->is_leader = false;
    node->leader_id = -1;
    
    atomic_store(&node->votes_received, 1); // Vote for self
    get_current_time(&node->last_heartbeat);
    node->election_timeout_ms = random_election_timeout();
}

static void become_leader(raft_node_t *node) {
    printf("Node %d becoming leader (term %d)\n", node->node_id, node->current_term);
    
    node->state = LEADER;
    node->is_leader = true;
    node->leader_id = node->node_id;
    
    // Initialize leader state
    for (int i = 0; i < node->cluster_size; i++) {
        node->next_index[i] = node->log_count + 1;
        node->match_index[i] = 0;
    }
    
    // Send immediate heartbeat
    get_current_time(&node->last_heartbeat);
}

// Network operations
static int send_message(raft_node_t *node, int target_node, void *message, size_t size) {
    if (target_node < 0 || target_node >= node->cluster_size) {
        return -1;
    }
    
    node_info_t *target = &node->nodes[target_node];
    if (!target->connected) {
        return -1;
    }
    
    ssize_t sent = send(target->socket_fd, message, size, MSG_NOSIGNAL);
    return (sent == (ssize_t)size) ? 0 : -1;
}

static int broadcast_message(raft_node_t *node, void *message, size_t size) {
    int success_count = 0;
    
    for (int i = 0; i < node->cluster_size; i++) {
        if (i != node->node_id) {
            if (send_message(node, i, message, size) == 0) {
                success_count++;
            }
        }
    }
    
    return success_count;
}

// Request Vote RPC
static void send_request_vote(raft_node_t *node) {
    request_vote_t msg = {
        .type = MSG_REQUEST_VOTE,
        .term = node->current_term,
        .candidate_id = node->node_id,
        .last_log_index = get_last_log_index(node),
        .last_log_term = get_last_log_term(node)
    };
    
    printf("Node %d sending RequestVote for term %d\n", node->node_id, node->current_term);
    broadcast_message(node, &msg, sizeof(msg));
}

static void handle_request_vote(raft_node_t *node, request_vote_t *msg, int sender_id) {
    pthread_mutex_lock(&node->state_mutex);
    
    request_vote_reply_t reply = {
        .type = MSG_REQUEST_VOTE_REPLY,
        .term = node->current_term,
        .vote_granted = false
    };
    
    // Update term if necessary
    if (msg->term > node->current_term) {
        become_follower(node, msg->term);
    }
    
    // Grant vote if conditions are met
    if (msg->term == node->current_term &&
        (node->voted_for == -1 || node->voted_for == msg->candidate_id)) {
        
        // Check if candidate's log is at least as up-to-date
        int last_log_term = get_last_log_term(node);
        int last_log_index = get_last_log_index(node);
        
        bool log_ok = (msg->last_log_term > last_log_term) ||
                     (msg->last_log_term == last_log_term && 
                      msg->last_log_index >= last_log_index);
        
        if (log_ok) {
            node->voted_for = msg->candidate_id;
            reply.vote_granted = true;
            get_current_time(&node->last_heartbeat);
            
            printf("Node %d granted vote to %d for term %d\n", 
                   node->node_id, msg->candidate_id, msg->term);
        }
    }
    
    reply.term = node->current_term;
    send_message(node, sender_id, &reply, sizeof(reply));
    
    pthread_mutex_unlock(&node->state_mutex);
}

static void handle_request_vote_reply(raft_node_t *node, request_vote_reply_t *msg) {
    pthread_mutex_lock(&node->state_mutex);
    
    if (node->state != CANDIDATE || msg->term != node->current_term) {
        pthread_mutex_unlock(&node->state_mutex);
        return;
    }
    
    if (msg->term > node->current_term) {
        become_follower(node, msg->term);
        pthread_mutex_unlock(&node->state_mutex);
        return;
    }
    
    if (msg->vote_granted) {
        int votes = atomic_fetch_add(&node->votes_received, 1) + 1;
        printf("Node %d received vote, total: %d\n", node->node_id, votes);
        
        // Check if we have majority
        if (votes > node->cluster_size / 2) {
            become_leader(node);
        }
    }
    
    pthread_mutex_unlock(&node->state_mutex);
}

// Append Entries RPC
static void send_append_entries(raft_node_t *node, int target_id, bool heartbeat) {
    if (target_id == node->node_id) {
        return;
    }
    
    append_entries_t msg = {
        .type = MSG_APPEND_ENTRIES,
        .term = node->current_term,
        .leader_id = node->node_id,
        .leader_commit = node->commit_index,
        .entries_count = 0
    };
    
    // Set previous log info
    int next_index = node->next_index[target_id];
    msg.prev_log_index = next_index - 1;
    
    if (msg.prev_log_index > 0) {
        log_entry_t *prev_entry = get_log_entry(node, msg.prev_log_index);
        msg.prev_log_term = prev_entry ? prev_entry->term : 0;
    } else {
        msg.prev_log_term = 0;
    }
    
    // Add entries if not heartbeat
    if (!heartbeat && next_index <= node->log_count) {
        int entries_to_send = node->log_count - next_index + 1;
        entries_to_send = (entries_to_send > 100) ? 100 : entries_to_send;
        
        for (int i = 0; i < entries_to_send; i++) {
            msg.entries[i] = node->log[next_index - 1 + i];
        }
        msg.entries_count = entries_to_send;
    }
    
    send_message(node, target_id, &msg, sizeof(msg));
    
    if (heartbeat) {
        atomic_fetch_add(&node->heartbeats_sent, 1);
    }
}

static void handle_append_entries(raft_node_t *node, append_entries_t *msg, int sender_id) {
    pthread_mutex_lock(&node->state_mutex);
    
    append_entries_reply_t reply = {
        .type = MSG_APPEND_ENTRIES_REPLY,
        .term = node->current_term,
        .success = false,
        .match_index = 0
    };
    
    // Update term if necessary
    if (msg->term > node->current_term) {
        become_follower(node, msg->term);
    }
    
    // Reset election timer on valid heartbeat
    if (msg->term == node->current_term) {
        get_current_time(&node->last_heartbeat);
        node->leader_id = msg->leader_id;
        
        if (node->state == CANDIDATE) {
            become_follower(node, msg->term);
        }
        
        atomic_fetch_add(&node->heartbeats_received, 1);
    }
    
    // Log consistency check
    if (msg->term == node->current_term) {
        bool log_ok = true;
        
        if (msg->prev_log_index > 0) {
            if (msg->prev_log_index > node->log_count) {
                log_ok = false;
            } else {
                log_entry_t *prev_entry = get_log_entry(node, msg->prev_log_index);
                if (!prev_entry || prev_entry->term != msg->prev_log_term) {
                    log_ok = false;
                }
            }
        }
        
        if (log_ok) {
            reply.success = true;
            
            // Append new entries
            for (int i = 0; i < msg->entries_count; i++) {
                int entry_index = msg->prev_log_index + 1 + i;
                
                // Remove conflicting entries
                if (entry_index <= node->log_count) {
                    log_entry_t *existing = get_log_entry(node, entry_index);
                    if (existing && existing->term != msg->entries[i].term) {
                        node->log_count = entry_index - 1;
                    }
                }
                
                // Append new entry
                if (entry_index > node->log_count) {
                    node->log[node->log_count] = msg->entries[i];
                    node->log_count++;
                }
            }
            
            reply.match_index = msg->prev_log_index + msg->entries_count;
            
            // Update commit index
            if (msg->leader_commit > node->commit_index) {
                node->commit_index = (msg->leader_commit < node->log_count) ? 
                                   msg->leader_commit : node->log_count;
            }
        }
    }
    
    reply.term = node->current_term;
    send_message(node, sender_id, &reply, sizeof(reply));
    
    pthread_mutex_unlock(&node->state_mutex);
}

static void handle_append_entries_reply(raft_node_t *node, append_entries_reply_t *msg, int sender_id) {
    pthread_mutex_lock(&node->state_mutex);
    
    if (node->state != LEADER || msg->term != node->current_term) {
        pthread_mutex_unlock(&node->state_mutex);
        return;
    }
    
    if (msg->term > node->current_term) {
        become_follower(node, msg->term);
        pthread_mutex_unlock(&node->state_mutex);
        return;
    }
    
    if (msg->success) {
        node->next_index[sender_id] = msg->match_index + 1;
        node->match_index[sender_id] = msg->match_index;
        
        // Update commit index
        for (int n = node->commit_index + 1; n <= node->log_count; n++) {
            int count = 1; // Count self
            
            for (int i = 0; i < node->cluster_size; i++) {
                if (i != node->node_id && node->match_index[i] >= n) {
                    count++;
                }
            }
            
            if (count > node->cluster_size / 2) {
                log_entry_t *entry = get_log_entry(node, n);
                if (entry && entry->term == node->current_term) {
                    node->commit_index = n;
                    printf("Node %d committed entry %d\n", node->node_id, n);
                }
            }
        }
    } else {
        // Decrement next_index and retry
        if (node->next_index[sender_id] > 1) {
            node->next_index[sender_id]--;
        }
    }
    
    pthread_mutex_unlock(&node->state_mutex);
}

// Timer threads
static void* election_timer_thread(void *arg) {
    raft_node_t *node = (raft_node_t*)arg;
    
    while (node->running) {
        struct timespec current_time;
        get_current_time(&current_time);
        
        pthread_mutex_lock(&node->state_mutex);
        
        if (node->state != LEADER) {
            long elapsed = time_diff_ms(&node->last_heartbeat, &current_time);
            
            if (elapsed >= node->election_timeout_ms) {
                printf("Node %d election timeout (%ld ms)\n", node->node_id, elapsed);
                become_candidate(node);
                send_request_vote(node);
            }
        }
        
        pthread_mutex_unlock(&node->state_mutex);
        
        usleep(10000); // 10ms
    }
    
    return NULL;
}

static void* heartbeat_thread(void *arg) {
    raft_node_t *node = (raft_node_t*)arg;
    
    while (node->running) {
        pthread_mutex_lock(&node->state_mutex);
        
        if (node->state == LEADER) {
            for (int i = 0; i < node->cluster_size; i++) {
                if (i != node->node_id) {
                    send_append_entries(node, i, true);
                }
            }
        }
        
        pthread_mutex_unlock(&node->state_mutex);
        
        usleep(HEARTBEAT_INTERVAL_MS * 1000);
    }
    
    return NULL;
}

// Client request handling
static int handle_client_request(raft_node_t *node, const char *command) {
    pthread_mutex_lock(&node->state_mutex);
    
    if (node->state != LEADER) {
        pthread_mutex_unlock(&node->state_mutex);
        return -1; // Not leader
    }
    
    int index = append_log_entry(node, node->current_term, command);
    if (index < 0) {
        pthread_mutex_unlock(&node->state_mutex);
        return -1;
    }
    
    printf("Node %d (leader) appended client command: %s (index %d)\n", 
           node->node_id, command, index);
    
    // Send append entries to all followers
    for (int i = 0; i < node->cluster_size; i++) {
        if (i != node->node_id) {
            send_append_entries(node, i, false);
        }
    }
    
    pthread_mutex_unlock(&node->state_mutex);
    return index;
}

// Node initialization
static int init_raft_node(raft_node_t *node, int node_id, int cluster_size) {
    memset(node, 0, sizeof(raft_node_t));
    
    node->node_id = node_id;
    node->cluster_size = cluster_size;
    node->state = FOLLOWER;
    node->current_term = 0;
    node->voted_for = -1;
    node->commit_index = 0;
    node->last_applied = 0;
    node->leader_id = -1;
    node->is_leader = false;
    node->running = true;
    
    // Initialize timing
    get_current_time(&node->last_heartbeat);
    node->election_timeout_ms = random_election_timeout();
    
    // Initialize counters
    atomic_init(&node->votes_received, 0);
    atomic_init(&node->heartbeats_sent, 0);
    atomic_init(&node->heartbeats_received, 0);
    
    // Initialize mutex
    if (pthread_mutex_init(&node->state_mutex, NULL) != 0) {
        return -1;
    }
    
    // Initialize cluster nodes (simplified)
    for (int i = 0; i < cluster_size; i++) {
        node->nodes[i].node_id = i;
        snprintf(node->nodes[i].ip_address, sizeof(node->nodes[i].ip_address), 
                "127.0.0.1");
        node->nodes[i].port = 9000 + i;
        node->nodes[i].socket_fd = -1;
        node->nodes[i].connected = false;
    }
    
    printf("Raft node %d initialized (cluster size: %d)\n", node_id, cluster_size);
    return 0;
}

// Statistics and monitoring
static void print_node_status(raft_node_t *node) {
    pthread_mutex_lock(&node->state_mutex);
    
    const char *state_str = (node->state == LEADER) ? "LEADER" :
                           (node->state == CANDIDATE) ? "CANDIDATE" : "FOLLOWER";
    
    printf("\n=== Node %d Status ===\n", node->node_id);
    printf("State: %s\n", state_str);
    printf("Term: %d\n", node->current_term);
    printf("Leader: %d\n", node->leader_id);
    printf("Log entries: %d\n", node->log_count);
    printf("Commit index: %d\n", node->commit_index);
    printf("Votes received: %d\n", atomic_load(&node->votes_received));
    printf("Heartbeats sent: %d\n", atomic_load(&node->heartbeats_sent));
    printf("Heartbeats received: %d\n", atomic_load(&node->heartbeats_received));
    
    if (node->log_count > 0) {
        printf("Recent log entries:\n");
        int start = (node->log_count > 5) ? node->log_count - 5 : 0;
        for (int i = start; i < node->log_count; i++) {
            printf("  [%d] term=%d: %s\n", 
                   node->log[i].index, node->log[i].term, node->log[i].command);
        }
    }
    
    pthread_mutex_unlock(&node->state_mutex);
}

// Demo and testing
static void* client_simulator(void *arg) {
    raft_node_t *node = (raft_node_t*)arg;
    
    sleep(2); // Wait for cluster to stabilize
    
    for (int i = 0; i < 10; i++) {
        char command[64];
        snprintf(command, sizeof(command), "command_%d", i);
        
        int result = handle_client_request(node, command);
        if (result > 0) {
            printf("Client request submitted: %s (index %d)\n", command, result);
        } else {
            printf("Client request failed: %s (not leader)\n", command);
        }
        
        sleep(1);
    }
    
    return NULL;
}

static int raft_demo(void) {
    const int cluster_size = 5;
    raft_node_t nodes[cluster_size];
    pthread_t client_thread;
    
    srand(time(NULL));
    
    printf("=== Raft Consensus Algorithm Demo ===\n");
    printf("Cluster size: %d\n", cluster_size);
    
    // Initialize nodes
    for (int i = 0; i < cluster_size; i++) {
        if (init_raft_node(&nodes[i], i, cluster_size) != 0) {
            printf("Failed to initialize node %d\n", i);
            return -1;
        }
        
        // Start timer threads
        pthread_create(&nodes[i].election_timer_thread, NULL, 
                      election_timer_thread, &nodes[i]);
        pthread_create(&nodes[i].heartbeat_thread, NULL, 
                      heartbeat_thread, &nodes[i]);
    }
    
    // Simulate message passing between nodes
    for (int round = 0; round < 100; round++) {
        // Election simulation
        for (int i = 0; i < cluster_size; i++) {
            if (nodes[i].state == CANDIDATE) {
                // Simulate vote requests and replies
                for (int j = 0; j < cluster_size; j++) {
                    if (i != j) {
                        request_vote_t vote_req = {
                            .type = MSG_REQUEST_VOTE,
                            .term = nodes[i].current_term,
                            .candidate_id = i,
                            .last_log_index = get_last_log_index(&nodes[i]),
                            .last_log_term = get_last_log_term(&nodes[i])
                        };
                        
                        handle_request_vote(&nodes[j], &vote_req, i);
                    }
                }
            }
        }
        
        // Heartbeat simulation
        for (int i = 0; i < cluster_size; i++) {
            if (nodes[i].state == LEADER) {
                for (int j = 0; j < cluster_size; j++) {
                    if (i != j) {
                        append_entries_t heartbeat = {
                            .type = MSG_APPEND_ENTRIES,
                            .term = nodes[i].current_term,
                            .leader_id = i,
                            .prev_log_index = 0,
                            .prev_log_term = 0,
                            .leader_commit = nodes[i].commit_index,
                            .entries_count = 0
                        };
                        
                        handle_append_entries(&nodes[j], &heartbeat, i);
                    }
                }
            }
        }
        
        usleep(100000); // 100ms
        
        // Print status every 10 rounds
        if (round % 10 == 0) {
            printf("\n--- Round %d ---\n", round);
            for (int i = 0; i < cluster_size; i++) {
                const char *state = (nodes[i].state == LEADER) ? "L" :
                                   (nodes[i].state == CANDIDATE) ? "C" : "F";
                printf("Node %d: %s (term %d) ", i, state, nodes[i].current_term);
            }
            printf("\n");
        }
    }
    
    // Start client simulator on leader
    int leader_id = -1;
    for (int i = 0; i < cluster_size; i++) {
        if (nodes[i].state == LEADER) {
            leader_id = i;
            break;
        }
    }
    
    if (leader_id >= 0) {
        pthread_create(&client_thread, NULL, client_simulator, &nodes[leader_id]);
        pthread_join(client_thread, NULL);
    }
    
    // Print final status
    printf("\n=== Final Status ===\n");
    for (int i = 0; i < cluster_size; i++) {
        print_node_status(&nodes[i]);
    }
    
    // Cleanup
    for (int i = 0; i < cluster_size; i++) {
        nodes[i].running = false;
        pthread_join(nodes[i].election_timer_thread, NULL);
        pthread_join(nodes[i].heartbeat_thread, NULL);
        pthread_mutex_destroy(&nodes[i].state_mutex);
    }
    
    return 0;
}

int main(void) {
    return raft_demo();
}
```

## Byzantine Fault Tolerance

### PBFT (Practical Byzantine Fault Tolerance) Implementation

```c
// pbft.c - Practical Byzantine Fault Tolerance implementation
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <pthread.h>
#include <time.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <openssl/sha.h>
#include <openssl/rsa.h>
#include <openssl/pem.h>

#define MAX_NODES 10
#define MAX_REQUESTS 1000
#define VIEW_CHANGE_TIMEOUT_MS 5000
#define REQUEST_TIMEOUT_MS 2000

// PBFT message types
typedef enum {
    MSG_REQUEST,
    MSG_PRE_PREPARE,
    MSG_PREPARE,
    MSG_COMMIT,
    MSG_REPLY,
    MSG_VIEW_CHANGE,
    MSG_NEW_VIEW,
    MSG_CHECKPOINT
} pbft_message_type_t;

// Message phase
typedef enum {
    PHASE_PRE_PREPARE,
    PHASE_PREPARE,
    PHASE_COMMIT,
    PHASE_COMMITTED
} pbft_phase_t;

// Request structure
typedef struct {
    int client_id;
    int timestamp;
    char operation[256];
    unsigned char signature[256];
    int signature_len;
} client_request_t;

// PBFT message structures
typedef struct {
    pbft_message_type_t type;
    int view;
    int sequence;
    unsigned char digest[SHA256_DIGEST_LENGTH];
    client_request_t request;
    int node_id;
    unsigned char signature[256];
    int signature_len;
} pbft_message_t;

// Checkpoint structure
typedef struct {
    int sequence;
    unsigned char state_digest[SHA256_DIGEST_LENGTH];
    int view;
} checkpoint_t;

// Request state tracking
typedef struct {
    client_request_t request;
    pbft_phase_t phase;
    int view;
    int sequence;
    unsigned char digest[SHA256_DIGEST_LENGTH];
    
    // Message counts for each phase
    int prepare_count;
    int commit_count;
    bool prepared;
    bool committed;
    
    // Timestamp for timeout detection
    struct timespec start_time;
} request_state_t;

// PBFT node structure
typedef struct {
    int node_id;
    int view;
    int sequence_number;
    int f; // Number of Byzantine faults to tolerate
    int n; // Total number of nodes (3f + 1)
    
    // Node state
    bool is_primary;
    int primary_id;
    
    // Request tracking
    request_state_t requests[MAX_REQUESTS];
    int request_count;
    
    // Checkpoints
    checkpoint_t stable_checkpoint;
    checkpoint_t checkpoints[100];
    int checkpoint_count;
    
    // View change
    bool view_changing;
    struct timespec view_change_start;
    
    // Cryptographic keys
    RSA *private_key;
    RSA *public_keys[MAX_NODES];
    
    // Network simulation
    pthread_mutex_t state_mutex;
    bool running;
    
    // Statistics
    atomic_int requests_processed;
    atomic_int messages_sent;
    atomic_int messages_received;
    atomic_int view_changes;
} pbft_node_t;

// Utility functions
static void calculate_digest(const void *data, size_t len, unsigned char *digest) {
    SHA256_CTX sha256;
    SHA256_Init(&sha256);
    SHA256_Update(&sha256, data, len);
    SHA256_Final(digest, &sha256);
}

static void print_digest(const unsigned char *digest) {
    for (int i = 0; i < SHA256_DIGEST_LENGTH; i++) {
        printf("%02x", digest[i]);
    }
}

static bool compare_digests(const unsigned char *d1, const unsigned char *d2) {
    return memcmp(d1, d2, SHA256_DIGEST_LENGTH) == 0;
}

static int sign_message(RSA *private_key, const unsigned char *data, int data_len,
                       unsigned char *signature) {
    return RSA_sign(NID_sha256, data, data_len, signature, NULL, private_key);
}

static bool verify_signature(RSA *public_key, const unsigned char *data, int data_len,
                           const unsigned char *signature, int sig_len) {
    return RSA_verify(NID_sha256, data, data_len, signature, sig_len, public_key) == 1;
}

// Request state management
static request_state_t* find_request_state(pbft_node_t *node, int sequence) {
    for (int i = 0; i < node->request_count; i++) {
        if (node->requests[i].sequence == sequence) {
            return &node->requests[i];
        }
    }
    return NULL;
}

static request_state_t* create_request_state(pbft_node_t *node, 
                                           const client_request_t *request,
                                           int view, int sequence) {
    if (node->request_count >= MAX_REQUESTS) {
        return NULL;
    }
    
    request_state_t *state = &node->requests[node->request_count++];
    memset(state, 0, sizeof(request_state_t));
    
    state->request = *request;
    state->phase = PHASE_PRE_PREPARE;
    state->view = view;
    state->sequence = sequence;
    
    // Calculate request digest
    calculate_digest(request, sizeof(client_request_t), state->digest);
    
    clock_gettime(CLOCK_MONOTONIC, &state->start_time);
    
    return state;
}

// Primary election
static int calculate_primary(int view, int n) {
    return view % n;
}

static void update_view(pbft_node_t *node, int new_view) {
    node->view = new_view;
    node->primary_id = calculate_primary(new_view, node->n);
    node->is_primary = (node->primary_id == node->node_id);
    
    printf("Node %d updated to view %d (primary: %d)\n", 
           node->node_id, new_view, node->primary_id);
}

// PBFT message handling
static void send_pre_prepare(pbft_node_t *node, const client_request_t *request) {
    if (!node->is_primary) {
        return;
    }
    
    pbft_message_t msg = {
        .type = MSG_PRE_PREPARE,
        .view = node->view,
        .sequence = ++node->sequence_number,
        .request = *request,
        .node_id = node->node_id
    };
    
    // Calculate message digest
    calculate_digest(&msg.request, sizeof(client_request_t), msg.digest);
    
    // Sign message
    unsigned char msg_data[sizeof(pbft_message_t) - 256 - sizeof(int)];
    memcpy(msg_data, &msg, sizeof(msg_data));
    msg.signature_len = sign_message(node->private_key, msg_data, sizeof(msg_data), 
                                   msg.signature);
    
    // Create request state
    create_request_state(node, request, node->view, msg.sequence);
    
    printf("Node %d (primary) sent PRE-PREPARE for sequence %d\n", 
           node->node_id, msg.sequence);
    
    atomic_fetch_add(&node->messages_sent, 1);
    
    // Broadcast to all backup nodes (simulated)
    // In real implementation, would send over network
}

static void handle_pre_prepare(pbft_node_t *node, const pbft_message_t *msg) {
    pthread_mutex_lock(&node->state_mutex);
    
    atomic_fetch_add(&node->messages_received, 1);
    
    // Verify message is from current primary
    if (msg->node_id != node->primary_id || msg->view != node->view) {
        printf("Node %d rejected PRE-PREPARE: wrong primary or view\n", node->node_id);
        pthread_mutex_unlock(&node->state_mutex);
        return;
    }
    
    // Verify signature
    unsigned char msg_data[sizeof(pbft_message_t) - 256 - sizeof(int)];
    memcpy(msg_data, msg, sizeof(msg_data));
    
    if (!verify_signature(node->public_keys[msg->node_id], msg_data, sizeof(msg_data),
                         msg->signature, msg->signature_len)) {
        printf("Node %d rejected PRE-PREPARE: invalid signature\n", node->node_id);
        pthread_mutex_unlock(&node->state_mutex);
        return;
    }
    
    // Check sequence number
    if (msg->sequence <= node->stable_checkpoint.sequence ||
        msg->sequence > node->stable_checkpoint.sequence + 100) {
        printf("Node %d rejected PRE-PREPARE: sequence out of range\n", node->node_id);
        pthread_mutex_unlock(&node->state_mutex);
        return;
    }
    
    // Verify request digest
    unsigned char computed_digest[SHA256_DIGEST_LENGTH];
    calculate_digest(&msg->request, sizeof(client_request_t), computed_digest);
    
    if (!compare_digests(msg->digest, computed_digest)) {
        printf("Node %d rejected PRE-PREPARE: digest mismatch\n", node->node_id);
        pthread_mutex_unlock(&node->state_mutex);
        return;
    }
    
    // Accept PRE-PREPARE and send PREPARE
    request_state_t *state = create_request_state(node, &msg->request, 
                                                 msg->view, msg->sequence);
    if (state) {
        state->phase = PHASE_PREPARE;
        
        // Send PREPARE message
        pbft_message_t prepare_msg = {
            .type = MSG_PREPARE,
            .view = msg->view,
            .sequence = msg->sequence,
            .node_id = node->node_id
        };
        
        memcpy(prepare_msg.digest, msg->digest, SHA256_DIGEST_LENGTH);
        
        // Sign PREPARE message
        unsigned char prepare_data[sizeof(pbft_message_t) - 256 - sizeof(int)];
        memcpy(prepare_data, &prepare_msg, sizeof(prepare_data));
        prepare_msg.signature_len = sign_message(node->private_key, prepare_data, 
                                                sizeof(prepare_data), prepare_msg.signature);
        
        printf("Node %d sent PREPARE for sequence %d\n", node->node_id, msg->sequence);
        atomic_fetch_add(&node->messages_sent, 1);
    }
    
    pthread_mutex_unlock(&node->state_mutex);
}

static void handle_prepare(pbft_node_t *node, const pbft_message_t *msg) {
    pthread_mutex_lock(&node->state_mutex);
    
    atomic_fetch_add(&node->messages_received, 1);
    
    // Find request state
    request_state_t *state = find_request_state(node, msg->sequence);
    if (!state) {
        pthread_mutex_unlock(&node->state_mutex);
        return;
    }
    
    // Verify message
    if (msg->view != state->view || 
        !compare_digests(msg->digest, state->digest)) {
        pthread_mutex_unlock(&node->state_mutex);
        return;
    }
    
    // Verify signature
    unsigned char msg_data[sizeof(pbft_message_t) - 256 - sizeof(int)];
    memcpy(msg_data, msg, sizeof(msg_data));
    
    if (!verify_signature(node->public_keys[msg->node_id], msg_data, sizeof(msg_data),
                         msg->signature, msg->signature_len)) {
        pthread_mutex_unlock(&node->state_mutex);
        return;
    }
    
    // Count PREPARE messages
    state->prepare_count++;
    
    printf("Node %d received PREPARE %d/%d for sequence %d\n", 
           node->node_id, state->prepare_count, 2 * node->f, msg->sequence);
    
    // Check if we have enough PREPARE messages (2f)
    if (state->prepare_count >= 2 * node->f && !state->prepared) {
        state->prepared = true;
        state->phase = PHASE_COMMIT;
        
        // Send COMMIT message
        pbft_message_t commit_msg = {
            .type = MSG_COMMIT,
            .view = state->view,
            .sequence = state->sequence,
            .node_id = node->node_id
        };
        
        memcpy(commit_msg.digest, state->digest, SHA256_DIGEST_LENGTH);
        
        // Sign COMMIT message
        unsigned char commit_data[sizeof(pbft_message_t) - 256 - sizeof(int)];
        memcpy(commit_data, &commit_msg, sizeof(commit_data));
        commit_msg.signature_len = sign_message(node->private_key, commit_data, 
                                              sizeof(commit_data), commit_msg.signature);
        
        printf("Node %d sent COMMIT for sequence %d\n", node->node_id, state->sequence);
        atomic_fetch_add(&node->messages_sent, 1);
    }
    
    pthread_mutex_unlock(&node->state_mutex);
}

static void handle_commit(pbft_node_t *node, const pbft_message_t *msg) {
    pthread_mutex_lock(&node->state_mutex);
    
    atomic_fetch_add(&node->messages_received, 1);
    
    // Find request state
    request_state_t *state = find_request_state(node, msg->sequence);
    if (!state || !state->prepared) {
        pthread_mutex_unlock(&node->state_mutex);
        return;
    }
    
    // Verify message
    if (msg->view != state->view || 
        !compare_digests(msg->digest, state->digest)) {
        pthread_mutex_unlock(&node->state_mutex);
        return;
    }
    
    // Verify signature
    unsigned char msg_data[sizeof(pbft_message_t) - 256 - sizeof(int)];
    memcpy(msg_data, msg, sizeof(msg_data));
    
    if (!verify_signature(node->public_keys[msg->node_id], msg_data, sizeof(msg_data),
                         msg->signature, msg->signature_len)) {
        pthread_mutex_unlock(&node->state_mutex);
        return;
    }
    
    // Count COMMIT messages
    state->commit_count++;
    
    printf("Node %d received COMMIT %d/%d for sequence %d\n", 
           node->node_id, state->commit_count, 2 * node->f + 1, msg->sequence);
    
    // Check if we have enough COMMIT messages (2f + 1)
    if (state->commit_count >= 2 * node->f + 1 && !state->committed) {
        state->committed = true;
        state->phase = PHASE_COMMITTED;
        
        // Execute the request
        printf("Node %d COMMITTED sequence %d: %s\n", 
               node->node_id, state->sequence, state->request.operation);
        
        atomic_fetch_add(&node->requests_processed, 1);
        
        // Send REPLY to client (in real implementation)
        printf("Node %d sent REPLY to client %d\n", 
               node->node_id, state->request.client_id);
    }
    
    pthread_mutex_unlock(&node->state_mutex);
}

// View change handling
static void initiate_view_change(pbft_node_t *node) {
    pthread_mutex_lock(&node->state_mutex);
    
    if (node->view_changing) {
        pthread_mutex_unlock(&node->state_mutex);
        return;
    }
    
    node->view_changing = true;
    clock_gettime(CLOCK_MONOTONIC, &node->view_change_start);
    
    printf("Node %d initiating view change from view %d\n", 
           node->node_id, node->view);
    
    atomic_fetch_add(&node->view_changes, 1);
    
    // In real implementation, would send VIEW-CHANGE message
    
    pthread_mutex_unlock(&node->state_mutex);
}

// Checkpoint handling
static void create_checkpoint(pbft_node_t *node, int sequence) {
    if (node->checkpoint_count >= 100) {
        return;
    }
    
    checkpoint_t *checkpoint = &node->checkpoints[node->checkpoint_count++];
    checkpoint->sequence = sequence;
    checkpoint->view = node->view;
    
    // Calculate state digest (simplified)
    char state_data[256];
    snprintf(state_data, sizeof(state_data), "state_at_sequence_%d", sequence);
    calculate_digest(state_data, strlen(state_data), checkpoint->state_digest);
    
    printf("Node %d created checkpoint at sequence %d\n", node->node_id, sequence);
    
    // Update stable checkpoint if we have 2f + 1 matching checkpoints
    // (simplified - in real implementation would collect from other nodes)
    if (sequence > node->stable_checkpoint.sequence) {
        node->stable_checkpoint = *checkpoint;
    }
}

// Node initialization
static int init_pbft_node(pbft_node_t *node, int node_id, int f) {
    memset(node, 0, sizeof(pbft_node_t));
    
    node->node_id = node_id;
    node->f = f;
    node->n = 3 * f + 1;
    node->view = 0;
    node->sequence_number = 0;
    
    update_view(node, 0);
    
    // Initialize stable checkpoint
    node->stable_checkpoint.sequence = 0;
    node->stable_checkpoint.view = 0;
    memset(node->stable_checkpoint.state_digest, 0, SHA256_DIGEST_LENGTH);
    
    // Initialize counters
    atomic_init(&node->requests_processed, 0);
    atomic_init(&node->messages_sent, 0);
    atomic_init(&node->messages_received, 0);
    atomic_init(&node->view_changes, 0);
    
    // Initialize mutex
    if (pthread_mutex_init(&node->state_mutex, NULL) != 0) {
        return -1;
    }
    
    node->running = true;
    
    // Generate RSA keys (simplified - in real implementation would load from files)
    node->private_key = RSA_new();
    // Key generation omitted for brevity
    
    printf("PBFT node %d initialized (f=%d, n=%d)\n", node_id, f, node->n);
    return 0;
}

// Statistics
static void print_pbft_statistics(pbft_node_t *node) {
    pthread_mutex_lock(&node->state_mutex);
    
    printf("\n=== Node %d PBFT Statistics ===\n", node->node_id);
    printf("View: %d (Primary: %d)\n", node->view, node->primary_id);
    printf("Requests processed: %d\n", atomic_load(&node->requests_processed));
    printf("Messages sent: %d\n", atomic_load(&node->messages_sent));
    printf("Messages received: %d\n", atomic_load(&node->messages_received));
    printf("View changes: %d\n", atomic_load(&node->view_changes));
    printf("Active requests: %d\n", node->request_count);
    printf("Stable checkpoint: %d\n", node->stable_checkpoint.sequence);
    
    pthread_mutex_unlock(&node->state_mutex);
}

// Demo
static int pbft_demo(void) {
    const int f = 1; // Tolerate 1 Byzantine fault
    const int n = 3 * f + 1; // 4 nodes total
    pbft_node_t nodes[n];
    
    printf("=== PBFT Demo ===\n");
    printf("Byzantine faults tolerated: %d\n", f);
    printf("Total nodes: %d\n", n);
    
    // Initialize nodes
    for (int i = 0; i < n; i++) {
        if (init_pbft_node(&nodes[i], i, f) != 0) {
            printf("Failed to initialize node %d\n", i);
            return -1;
        }
    }
    
    // Simulate client requests
    for (int req = 0; req < 5; req++) {
        client_request_t request = {
            .client_id = 1,
            .timestamp = (int)time(NULL) + req,
            .signature_len = 0
        };
        
        snprintf(request.operation, sizeof(request.operation), 
                "operation_%d", req);
        
        printf("\n--- Processing client request %d ---\n", req);
        
        // Send to primary
        send_pre_prepare(&nodes[0], &request);
        
        // Simulate message delivery (simplified)
        // In real implementation, would use actual network
        
        usleep(100000); // 100ms
    }
    
    // Print final statistics
    printf("\n=== Final Statistics ===\n");
    for (int i = 0; i < n; i++) {
        print_pbft_statistics(&nodes[i]);
    }
    
    // Cleanup
    for (int i = 0; i < n; i++) {
        nodes[i].running = false;
        pthread_mutex_destroy(&nodes[i].state_mutex);
    }
    
    return 0;
}

int main(void) {
    return pbft_demo();
}
```

## Best Practices

1. **Fault Tolerance**: Design for partial failures and network partitions
2. **Consistency Models**: Choose appropriate consistency guarantees for your use case
3. **Testing**: Extensive testing under failure conditions and network partitions
4. **Monitoring**: Comprehensive monitoring and alerting for distributed system health
5. **Security**: Implement proper authentication, authorization, and encryption

## Conclusion

Distributed systems and consensus algorithms form the foundation of modern scalable applications. Understanding these concepts—from Raft's leader election to Byzantine fault tolerance—is essential for building reliable distributed systems.

The challenges of distributed systems include handling partial failures, maintaining consistency, and achieving consensus across unreliable networks. By mastering these advanced techniques and algorithms, developers can build robust, fault-tolerant systems that scale to meet modern demands while maintaining correctness and availability.