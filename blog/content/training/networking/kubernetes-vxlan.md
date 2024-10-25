---
title: "How Kubernetes Uses VXLAN for Overlay Networking"
date: 2024-10-24
draft: false
tags: ["kubernetes", "vxlan", "overlay network", "networking"]
categories: ["training", "kubernetes", "networking"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep dive into how Kubernetes leverages VXLAN for pod networking across nodes."
more_link: "/training/networking/kubernetes-vxlan/"
---

# How Kubernetes Uses VXLAN for Overlay Networking

Kubernetes needs to create a **virtual network** that connects pods across multiple nodes seamlessly. Since these pods reside in isolated networks, **overlay networks**—like those implemented with **VXLAN**—allow them to communicate over a physical Layer 3 infrastructure.

In this post, we explore **how Kubernetes uses VXLAN** to build an overlay network, enabling communication between pods across nodes.

---

## 1. What is an Overlay Network?

In Kubernetes, an **overlay network** abstracts the physical network, allowing **pods on different nodes** to communicate as if they were on the **same Layer 2 network**. VXLAN is one of the most popular protocols for building this overlay.

- **Challenge**: Nodes are typically connected via a Layer 3 network, and each node gets its own subnet.
- **Solution**: VXLAN creates a Layer 2 overlay across these Layer 3 networks, encapsulating Ethernet frames in UDP packets to transport them across nodes.

---

## 2. How VXLAN Works in Kubernetes Networking

1. **VXLAN Encapsulation**: 
   - Kubernetes encapsulates **pod-to-pod traffic** into **VXLAN packets**.
   - These packets are routed between nodes over the existing Layer 3 infrastructure.

2. **VTEP (VXLAN Tunnel Endpoint)**:
   - Each Kubernetes node acts as a **VTEP**, handling VXLAN encapsulation and decapsulation for packets.
   - The VTEP encapsulates the original Ethernet frame from the pod into a VXLAN packet and sends it across the network.

3. **Pod Communication Flow Using VXLAN**:
   - **Source Pod**: Sends an Ethernet frame.
   - **VTEP on Source Node**: Encapsulates the frame in a VXLAN packet.
   - **VTEP on Destination Node**: Decapsulates the packet and forwards the original Ethernet frame to the destination pod.

---

## 3. VXLAN Packet Flow in Kubernetes

Here’s an example of a packet’s journey between two pods on different nodes:

### Example Packet Flow
1. **Pod A** on **Node 1** sends traffic to **Pod B** on **Node 2**.
2. The **CNI plugin** on Node 1 (e.g., **Flannel**) encapsulates the Ethernet frame in a VXLAN packet.
3. The VXLAN packet travels over the **Layer 3 network** (e.g., IP network between nodes).
4. **Node 2** receives the VXLAN packet and decapsulates it.
5. The original Ethernet frame is delivered to **Pod B** on Node 2.

---

## 4. VXLAN in Kubernetes CNI Plugins

Several **CNI (Container Network Interface) plugins** use VXLAN to handle pod-to-pod communication:

### Flannel (VXLAN Backend)
- **Flannel** uses VXLAN to create an overlay network between nodes.
- Each node is assigned a **VTEP** and a **subnet** for its pods.
- Flannel encapsulates pod traffic into VXLAN packets and routes them between nodes.

**Flannel VXLAN Configuration Example**:
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: kube-flannel-cfg
  namespace: kube-system
data:
  net-conf.json: |
    {
      "Network": "10.244.0.0/16",
      "Backend": {
        "Type": "vxlan"
      }
    }
```

### Calico (Optional VXLAN Mode)
- **Calico** supports VXLAN for networking when IP routing is not possible or desirable.
- Calico can also use **BGP** for routing, but VXLAN is useful in environments with **network restrictions**.

---

## 5. Routing with VXLAN in Kubernetes

In a VXLAN-based overlay network, Kubernetes uses **VXLAN routing** to ensure traffic between pods on different nodes reaches its destination. Here’s how it works:

- Each node maintains a **routing table** that maps **pod IPs to nodes**.
- When a pod sends traffic to another pod on a different node:
  - The source node **looks up the destination pod’s IP** in the routing table.
  - It **encapsulates the packet** using VXLAN and sends it to the correct destination node.

### Example of Kubernetes Routing Table:
```bash
ip route show
10.244.1.0/24 via 192.168.1.2 dev vxlan0
10.244.2.0/24 via 192.168.1.3 dev vxlan0
```
- **10.244.1.0/24**: Subnet for Node 1.
- **10.244.2.0/24**: Subnet for Node 2.
- **192.168.1.x**: IP addresses of the nodes.

---

## 6. Monitoring VXLAN Traffic

To monitor VXLAN traffic in Kubernetes, you can use `tcpdump`:

```bash
tcpdump -i eth0 udp port 4789
```

This command captures VXLAN packets traveling between nodes.

---

## 7. Troubleshooting VXLAN Issues in Kubernetes

1. **Check VXLAN Interface**:
   ```bash
   ip link show vxlan0
   ```

2. **Check Node Routing Tables**:
   ```bash
   ip route show
   ```

3. **Verify Flannel or Calico Configuration**:
   - Ensure that the correct **VXLAN backend** is configured.

4. **Connectivity Test Between Pods**:
   ```bash
   kubectl exec -it pod-a -- ping 10.244.2.15
   ```

---

## 8. Security Considerations for VXLAN in Kubernetes

- **VXLAN Traffic Encryption**:
  - VXLAN does not provide encryption natively. Use **IPsec** or **WireGuard** to encrypt traffic between nodes.
  
- **Firewall Rules**:
  - Ensure that **UDP port 4789** (VXLAN) is open between nodes.

---

## 9. Conclusion

VXLAN plays a crucial role in **Kubernetes networking**, providing a scalable and flexible way to connect pods across nodes. By encapsulating Layer 2 traffic over a Layer 3 network, VXLAN enables seamless communication in complex environments like cloud data centers and multi-node clusters.

---

## Next Steps

Explore related topics:
- [Networking 101](../networking-101/)
- [Kubernetes CNI Plugins Overview](../cni-plugins/)
- [Monitoring Kubernetes Networking with Prometheus](../monitoring-kubernetes/)

---
