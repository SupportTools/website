---
title: "K3s Built-in Load Balancer Explained"
date: 2025-01-10T00:00:00-05:00
draft: true
tags: ["K3s", "Load Balancer", "Networking"]
categories:
- K3s
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Understanding how K3s implements its lightweight load balancer and how it enhances cluster networking."
more_link: "yes"
url: "/training/k3s/load-balancer/"
---

K3s is a lightweight Kubernetes distribution that simplifies deployment and management. One of its powerful built-in components is the load balancer, which ensures that requests are efficiently routed to available servers, providing redundancy and failover capabilities.

<!--more-->

# [Introduction](#introduction)
## What is the K3s Load Balancer?
K3s includes a simple TCP load balancer designed for environments where an external load balancer may not be available. This built-in load balancer ensures that connections to the control plane or API server are distributed across multiple servers, improving fault tolerance.

## How It Works
The K3s load balancer operates as a failover-based proxy rather than a true load balancer. It forwards traffic to available backend servers, only switching to another server when a connection fails. This lightweight approach avoids the complexity of full-fledged load balancing solutions while still providing basic redundancy.

### Single Server Architecture
![K3s Single Server Architecture](https://cdn.support.tools/training/k3s/k3s-architecture-single-server.svg)

In a single server setup, worker nodes connect directly to the single control plane node. While this setup doesn't utilize the load balancer's failover capabilities, it still uses the local proxy on `127.0.0.1:6443` for consistent connectivity.

### High Availability Architecture
![K3s HA Architecture with Embedded Load Balancer](https://cdn.support.tools/training/k3s/k3s-architecture-ha-embedded.svg)

In a high-availability setup, the embedded load balancer becomes crucial. It maintains connections to all server nodes and provides automatic failover capabilities. Each agent node runs its own load balancer instance, which proxies all API server traffic through the local endpoint.

# [How K3s Uses This Load Balancer](#how-k3s-uses-this-load-balancer)
## Components of the Load Balancer
The load balancer consists of:
- **Configuration Management:** Stores server addresses in a configuration file for persistence.
- **Failover Mechanism:** Switches to the next available server when the current one fails.
- **Proxy Functionality:** Routes incoming TCP connections to the appropriate backend server.
- **Health Checks:** Regularly monitors backend servers to determine their availability.

## Load Balancer in Action
When a K3s agent starts, it attempts to connect to the control plane using the load balancer. The load balancer maintains a list of available servers and ensures that traffic is always forwarded to a responsive server. If a failure is detected, it seamlessly fails over to another node.

# [Configuring and Customizing the Load Balancer](#configuring-the-load-balancer)
## Load Balancer Configuration File Location
The load balancer configuration is stored in:
```
/var/lib/rancher/rke2/agent/etc/rke2-agent-load-balancer.json
```
An example of the configuration file contents:
```json
{
  "ServerURL": "https://172.28.2.23:6443",
  "ServerAddresses": [
    "172.28.2.22:6443",
    "172.28.2.21:6443",
    "172.28.2.23:6443"
  ]
}
```

## Enabling HTTP Proxy Support
The load balancer allows proxy configurations via environment variables. If the `K3S_AGENT_HTTP_PROXY_ALLOWED` variable is set, the load balancer will attempt to use an HTTP proxy for outgoing connections.

## Updating the Load Balancer Configuration
The configuration file persists across restarts and can be updated dynamically. If changes are detected, the load balancer updates its server list without requiring a restart.

```go
func (lb *LoadBalancer) updateConfig() error {
    if configBytes, err := os.ReadFile(lb.configFile); err == nil {
        config := &lbConfig{}
        if err := json.Unmarshal(configBytes, config); err == nil {
            if config.ServerURL == lb.scheme+"://"+lb.servers.getDefaultAddress() {
                lb.Update(config.ServerAddresses)
                return nil
            }
        }
    }
    return lb.writeConfig()
}
```
## Starting the Load Balancer

The k3s agent starts the load balancer as part of its initialization process. Here's a detailed look at how it works:

1. **Initial Connection Setup**
   - The agent process initializes the load balancer on startup
   - It listens on `127.0.0.1:6443` by default for local API server traffic
   - The load balancer reads the server URL from the agent configuration

2. **Server Discovery Process**
   - The load balancer connects to the initial server URL provided during agent startup
   - It retrieves a list of all available server endpoints from the cluster
   - This list is cached locally and updated periodically

3. **Server List Management**
   ```go
   type LoadBalancer struct {
       servers     *serversList
       serverURL   string
       listenPort int
       localAddr  string
   }
   ```

4. **Connection Handling and Local API Endpoint**
   - Incoming requests to `127.0.0.1:6443` are proxied to the active server
   - The load balancer maintains persistent connections to minimize latency
   - Connection pooling is used to optimize performance

   The local endpoint (`127.0.0.1:6443`) is used by several critical components:
   - **Kubelet**: Uses this endpoint to communicate with the API server for:
     * Pod lifecycle management
     * Node status updates
     * Volume attachment/detachment
     * Container runtime operations
   - **Kube-proxy**: Connects through this endpoint to:
     * Watch for Service and Endpoint changes
     * Update local iptables/ipvs rules
   - **CNI plugins**: Access the API server for:
     * Network configuration retrieval
     * Pod network setup and teardown
   - **Node-local components**: Various components like:
     * Local monitoring agents
     * Log collectors
     * Custom controllers running on the node
   
   This local tunnel ensures that all node components have a stable, reliable connection to the Kubernetes API server, regardless of which master node is currently active.

5. **Failover Mechanism**
   - The load balancer continuously monitors server health
   - If the active server becomes unresponsive:
     * The connection is marked as failed
     * A new server is selected from the available list
     * Traffic is automatically redirected to the new server
     * The process is transparent to the kubelet and other components

6. **Health Checking**
   ```go
   func (lb *LoadBalancer) checkHealth(server string) bool {
       conn, err := net.DialTimeout("tcp", server, healthCheckTimeout)
       if err != nil {
           return false
       }
       conn.Close()
       return true
   }
   ```

This built-in load balancer ensures high availability by:
- Maintaining an up-to-date list of available servers
- Implementing automatic failover between master servers
- Providing local API endpoint stability through `127.0.0.1:6443`
- Handling reconnection logic transparently

# [Code Reference](#code-reference)
The source code for the K3s load balancer can be found here: [K3s Load Balancer Source Code](https://github.com/k3s-io/k3s/blob/master/pkg/agent/loadbalancer/)

# [Agent Nodes](#agent-nodes)
## Role of Agent Nodes
Agent nodes run the kubelet, container runtime, and CNI, but do not have datastore or control-plane components. They register with the Kubernetes API through a client-side load balancer.

## Agent Registration Process
1. The `k3s agent` process initiates a websocket connection to the `k3s server`.
2. The agent maintains a list of available servers and uses the local load balancer to establish a stable connection.
3. If the connection to the current server fails, the agent fails over to another available server from the list.

## Kubelet to API Server Communication
The kubelet on worker nodes communicates with the kube-apiserver through a sophisticated proxying mechanism:

1. **Local Connection Flow**
   ```
   Kubelet -> 127.0.0.1:6443 -> Load Balancer -> Active Master Node:6443
   ```
   - Kubelet is configured to use `https://127.0.0.1:6443` as its API server endpoint
   - All API requests are first sent to this local address
   - The k3s load balancer receives these requests and proxies them to the active master

2. **Connection Process**
   - When kubelet starts, it reads its configuration which points to `127.0.0.1:6443`
   - The load balancer maintains a secure tunnel to the active master node
   - All kubelet API calls (pod updates, node status, etc.) flow through this tunnel
   - TLS certificates and authentication are handled transparently

3. **Benefits of Local Proxying**
   - **High Availability**: If a master node fails, the load balancer automatically switches to another master
   - **Connection Reuse**: The load balancer maintains persistent connections, reducing overhead
   - **Simplified Configuration**: Kubelet doesn't need to know about multiple masters
   - **Security**: All external connections are managed by the load balancer

4. **Example Configuration**
   ```yaml
   apiVersion: kubelet.config.k8s.io/v1beta1
   kind: KubeletConfiguration
   authentication:
     x509:
       clientCAFile: /var/lib/rancher/k3s/server/tls/client-ca.crt
   clusterDomain: "cluster.local"
   # Note how the API server URL points to localhost
   apiServerEndpoint: "127.0.0.1:6443"
   ```

5. **Traffic Flow Example**
   When kubelet needs to:
   - Create a pod: Request flows through local proxy to active master
   - Update node status: Connects via local endpoint
   - Watch for changes: Maintains persistent connection through tunnel
   - Handle volume operations: All API calls use the same local endpoint

## Agent Node Configuration
Agents will register using the cluster secret and a randomly generated node password stored in:
```
/etc/rancher/node/password
```
The server stores passwords as Kubernetes secrets in the `kube-system` namespace using the naming format:
```
<host>.node-password.k3s
```

# [Benefits of Using the K3s Load Balancer](#benefits)
- **Lightweight and Efficient:** Unlike HAProxy or Envoy, this load balancer is built for simplicity.
- **Automatic Failover:** Ensures API server availability in multi-node setups.
- **Zero External Dependencies:** No need for external cloud-based load balancers.
- **Integrated with K3s:** Works seamlessly within the K3s ecosystem.

# [Conclusion](#conclusion)
The K3s built-in load balancer is an essential component for ensuring cluster stability in lightweight Kubernetes environments. While it may not replace advanced load balancing solutions, it provides a practical, built-in method for handling API server traffic efficiently.

By leveraging this built-in feature, K3s users can maintain high availability without the overhead of additional infrastructure.

For more information on K3s and its load balancer, visit the official [K3s documentation](https://rancher.com/docs/k3s/latest/en/).
