---
title: "Networking 101"
date: 2024-10-24
draft: false
tags: ["networking", "training", "core concepts"]
categories: ["training"]
author: "Matthew Mattox - mmattox@support.tools"
description: "An introduction to networking basics."
more_link: "/training//networking/networking-101/"
---

# Introduction to Networking 101

Networking is a foundational component of modern technology, enabling communication between devices and systems. In this post, we will explore key networking concepts and provide the knowledge needed to understand how devices interact in a networked environment.

---

## 1. What is TCP/IP?

TCP/IP (Transmission Control Protocol/Internet Protocol) is the backbone of the internet and most local networks. It defines how data is broken into packets, transmitted, and reassembled at the destination.

- **TCP**: Ensures reliable delivery by establishing a connection before transmitting data.
- **IP**: Handles addressing and routing to ensure data reaches the correct destination.

> **Example**: When you load a webpage, TCP breaks the page's data into packets, and IP routes them from the server to your browser.

---

## 2. Understanding Subnets

A **subnet** divides a larger network into smaller, more manageable segments. It controls which devices can communicate directly and helps manage traffic within networks.

- **Subnet Mask**: Defines which portion of an IP address refers to the network and which part refers to individual devices.
- **Example Subnet**: `192.168.1.0/24` allows 256 addresses (from `192.168.1.0` to `192.168.1.255`).

> **Why use subnets?**  
> Subnetting improves performance by reducing network congestion and adds security by isolating groups of devices.

---

## 3. Firewalls: The Network’s Gatekeeper

A **firewall** is a security system that monitors and controls incoming and outgoing network traffic based on predefined rules. It helps block unauthorized access while permitting legitimate traffic.

- **Types of Firewalls**:
  1. **Packet-Filtering Firewalls**: Inspect each packet in isolation.
  2. **Stateful Firewalls**: Track the state of connections and allow only valid responses.
  3. **Application Firewalls**: Filter based on specific applications, such as HTTP or FTP.

> **Example**: A firewall might block all incoming traffic on port 23 (Telnet) but allow traffic on port 80 (HTTP).

---

## 4. Basic Network Tools

Here are some essential networking tools you can use for troubleshooting and monitoring:

- **ping**: Checks connectivity between two devices.
  ```bash
  ping 8.8.8.8
  ```

- **traceroute**: Displays the route packets take to reach a destination.
  ```bash
  traceroute google.com
  ```

- **netstat**: Shows network connections and statistics.
  ```bash
  netstat -a
  ```

- **nslookup**: Queries DNS to find the IP address of a domain.
  ```bash
  nslookup example.com
  ```

---

## 5. Common Networking Protocols

There are several important protocols that facilitate communication across networks:

- **HTTP/HTTPS**: Transfer of web pages (unsecure vs secure).
- **FTP/SFTP**: File transfers between systems.
- **DNS**: Resolves domain names to IP addresses.
- **DHCP**: Automatically assigns IP addresses to devices on a network.

> **Example**: When you type `www.example.com` into your browser, DNS resolves it to an IP address so the browser can connect to the correct server.

---

## 6. Understanding Network Layers (OSI Model)

The **OSI (Open Systems Interconnection) Model** breaks networking into seven layers, each with specific functions.

1. **Physical Layer**: Transmission of raw data over physical media.
2. **Data Link Layer**: Error detection and MAC addressing.
3. **Network Layer**: Routing and IP addressing (e.g., IP).
4. **Transport Layer**: Reliable transmission (e.g., TCP).
5. **Session Layer**: Manages sessions between devices.
6. **Presentation Layer**: Data translation and encryption.
7. **Application Layer**: User-facing applications (e.g., HTTP).

---

## 7. Network Security Best Practices

To protect networks, follow these best practices:

1. **Use Firewalls and Intrusion Detection Systems**.
2. **Segment Networks** with VLANs and subnets.
3. **Encrypt Data** using protocols like HTTPS and TLS.
4. **Apply Access Controls** to limit who can access devices and systems.
5. **Monitor Traffic** for unusual activity.

---

## 8. Conclusion

Networking is a critical skill for IT professionals, as it underpins all modern communication. By understanding core concepts like TCP/IP, subnets, firewalls, and essential protocols, you can build, troubleshoot, and secure networks effectively.

---

## Next Steps

Ready to dive deeper? Check out these related posts:
- [Introduction to VLANs](../vlans/)
- [How Firewalls Work](../firewalls/)
- [DNS Deep Dive](../dns/)

---

If you have questions or feedback, feel free to reach out at **mmattox@support.tools**. Happy learning!
