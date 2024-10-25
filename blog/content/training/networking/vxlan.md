---
title: "Understanding VXLAN"
date: 2024-10-24
draft: false
tags: ["vxlan", "networking", "training", "virtualization"]
categories: ["training", "networking"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep dive into VXLAN and its role in modern network virtualization."
more_link: "/training/networking/vxlan/"
---

# Understanding VXLAN: Virtual Extensible LAN

Virtual Extensible LAN (VXLAN) is a network virtualization technology that helps extend Layer 2 networks over Layer 3 infrastructure. It’s a key enabler in modern data centers, especially in cloud environments, providing scalable overlay networks for virtual machines and containers.

---

## 1. What is VXLAN?

VXLAN is a **network overlay protocol** that allows you to create a virtual Layer 2 network over a physical Layer 3 network. It encapsulates Ethernet frames in UDP packets, enabling the deployment of virtual networks across large, distributed environments.

- **VXLAN Header**: Encapsulates the original Ethernet frame.
- **UDP Encapsulation**: Uses UDP for transport over Layer 3 networks.
- **VXLAN Network Identifier (VNI)**: A 24-bit ID allowing up to 16 million unique VXLAN segments.

---

## What does VXLAN look like?

### IP Packet
![IP Packet](https://cdn.support.tools/training/networking/hq720.jpg)

### VXLAN Packet
![VXLAN Packet](https://cdn.support.tools/training/networking/vxlan.png)

---

## 2. Why VXLAN?  

Traditional VLANs are limited to **4096 VLAN IDs**, which restricts scalability, especially in large cloud or multi-tenant environments. VXLAN solves this issue by providing **16 million unique VXLAN IDs (VNIs)**.

### Benefits of VXLAN:
1. **Scalability**: Supports millions of unique network segments.
2. **Flexibility**: Works over existing Layer 3 networks.
3. **Mobility**: Enables seamless VM and container movement between hosts.
4. **Multi-Tenant Isolation**: Provides network segmentation for tenants in cloud environments.

---

## 3. How VXLAN Works

VXLAN works by **encapsulating Layer 2 frames** inside Layer 3 packets using **UDP encapsulation**. This enables the transport of Ethernet frames over IP networks.

1. **Encapsulation**: Ethernet frames are encapsulated into UDP packets.
2. **Routing**: These UDP packets are routed over the existing Layer 3 network.
3. **Decapsulation**: At the destination, the original Ethernet frame is extracted.

---

## 4. VXLAN Components

- **VTEP (VXLAN Tunnel Endpoint)**: 
  - Handles encapsulation and decapsulation of Ethernet frames.
  - Each host in a VXLAN environment requires a VTEP.

- **VNI (VXLAN Network Identifier)**:
  - A unique 24-bit identifier for VXLAN segments, supporting up to **16 million segments**.

- **Flood and Learn**:
  - VXLAN relies on multicast or control-plane protocols (like EVPN) to handle Layer 2 broadcasts and MAC address learning.

---

## 5. VXLAN Packet Format

A VXLAN packet contains the following headers:
- **Ethernet Header** (Original Layer 2 frame)
- **VXLAN Header** (Includes VNI)
- **UDP Header** (Transport over Layer 3)
- **IP Header** (Routing information for Layer 3)
- **Ethernet Header** (Outer Ethernet header)

---

## 6. VXLAN vs VLAN

| **Feature**     | **VLAN**                         | **VXLAN**                          |
|-----------------|----------------------------------|------------------------------------|
| ID Limit        | 4096 VLANs                       | 16 million VNIs                   |
| Layer           | Layer 2                          | Layer 2 over Layer 3              |
| Encapsulation   | None                             | UDP encapsulation of Ethernet     |
| Use Case        | Small to medium-sized networks  | Large, distributed environments   |

---

## 7. Use Cases of VXLAN

1. **Cloud Data Centers**: 
   - VXLAN allows multiple tenants to operate isolated networks on shared infrastructure.
2. **Kubernetes Networking**: 
   - VXLAN is used in CNI plugins like Calico or Flannel to manage pod networking across nodes.
3. **Virtual Machine Migration**:
   - Ensures seamless connectivity when VMs are moved across different physical hosts.

---

## 8. Configuring VXLAN with Linux

You can create a VXLAN interface on Linux using the following commands:

### Step 1: Create a VXLAN Interface
```bash
ip link add vxlan0 type vxlan id 42 dev eth0 dstport 4789
```

### Step 2: Assign an IP Address
```bash
ip addr add 192.168.100.1/24 dev vxlan0
```

### Step 3: Bring Up the Interface
```bash
ip link set vxlan0 up
```

---

## 9. VXLAN in Kubernetes (Example with Flannel)

Many **CNI plugins** in Kubernetes, such as Flannel, use VXLAN to provide network connectivity between pods across nodes.

1. **Flannel Configuration Example**:
   ```yaml
   apiVersion: networking.k8s.io/v1
   kind: NetworkPolicy
   metadata:
     name: flannel-vxlan-config
   spec:
     backend: vxlan
   ```

2. **Benefit**: 
   - Pods can communicate seamlessly across nodes by leveraging VXLAN-based networking.

---

## 10. Troubleshooting VXLAN

Here are a few commands to diagnose and troubleshoot VXLAN issues:

- **Check VXLAN Interface**:
  ```bash
  ip link show vxlan0
  ```

- **Check Routing Table**:
  ```bash
  ip route show
  ```

- **Capture VXLAN Traffic** (using `tcpdump`):
  ```bash
  tcpdump -i eth0 udp port 4789
  ```

---

## 11. Security Considerations

While VXLAN provides network segmentation, it’s important to consider:
- **Encryption**: VXLAN itself doesn’t provide encryption. Use IPsec or TLS to secure traffic.
- **Control Plane Security**: Protect control plane protocols like EVPN from unauthorized access.

---

## 12. Conclusion

VXLAN plays a critical role in **network virtualization**, enabling scalable and flexible networking in cloud and data center environments. Whether you’re working with Kubernetes, virtual machines, or multi-tenant networks, understanding VXLAN is essential for modern network engineers.

---

## Next Steps

Interested in more networking topics? Check out these related posts:
- [Networking 101](../networking-101/)
- [Kubernetes Networking with Flannel](../kubernetes-flannel/)
- [Multi-Cloud Networking](../multi-cloud-networking/)

---
