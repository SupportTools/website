---
title: "Exposing Services in Kubernetes Using External IPs"
date: 2019-12-20T08:00:00-05:00
draft: false
tags: ["Kubernetes", "Networking", "Bare Metal"]
categories:
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to expose your Kubernetes services using External IPs, a neat solution for bare metal clusters."
more_link: "yes"
---

Exposing services in Kubernetes effectively and securely is a common challenge, especially when working with bare metal deployments. NodePort might be the go-to solution for many, but it comes with its own set of limitations, such as the need to expose high-numbered ports and adjust firewall rules accordingly. Fortunately, Kubernetes offers another way to expose services using their original port numbers through the External IP service type. This post dives into how to leverage External IPs for service exposure in a Kubernetes cluster.

<!--more-->
## [External IP Service in Kubernetes: An Overview](#external-ip-service-in-kubernetes-an-overview)

When operating a bare metal Kubernetes cluster, figuring out how to expose services to the internet can be tricky. While NodePort allocates high ports that require firewall adjustments, the External IP service type allows services to be exposed on their original ports, such as MySQL on port 3306 instead of a high port like 32767.

## [Understanding the External IP Service in Kubernetes](#understanding-the-external-ip-service-in-kubernetes)

In the realm of Kubernetes, the concept of an External IP service plays a crucial role in the exposure of services to the outside world. Drawing from the official Kubernetes documentation, the External IP service is characterized by its ability to facilitate access to Kubernetes services via specified external IPs. These IPs act as conduits through which traffic is directed into the cluster, targeting the service port and subsequently being routed to the appropriate service endpoints. A notable aspect of external IPs is that their management falls outside the purview of Kubernetes itself, requiring the cluster administrator to undertake this responsibility.

This arrangement necessitates a thorough understanding of the IP addresses utilized for accessing the Kubernetes cluster. By leveraging the External IP service type, administrators can directly associate a service with the IP intended for cluster access. This direct association simplifies access control and service exposure, enhancing the overall manageability of services within the cluster.

An essential prerequisite for effectively implementing External IP services is a foundational knowledge of Kubernetes networking principles. For those less acquainted with these concepts, resources such as Mark Betz's detailed blog post on Kubernetes networking offer valuable insights. The cornerstone of Kubernetes networking is the Overlay network. This networking model ensures that irrespective of the entry point to the cluster, be it through a master or worker node, there exists a seamless pathway to access any component within the cluster.

### [Illustrating Kubernetes External IP Flow](#illustrating-kubernetes-external-ip-flow)

The operational dynamics of External IP services can be elucidated through a practical illustration involving two nodes within a Kubernetes cluster. Consider a scenario where Node 1 and Node 2 are assigned unique IP addresses — 1.2.3.4 and 1.2.3.6, respectively. In this setup, the IP address 1.2.3.4 on Node 1 is designated for an httpd service, despite the actual pod residing on Node 2. Conversely, the IP address 1.2.3.6 is allocated to an nginx service hosted directly on Node 1. This configuration is made feasible by the underlying Overlay network, which bridges the physical separation between services and their associated pods.

When a request is made to the IP address 1.2.3.4, the traffic is intelligently routed to the httpd service, resulting in the expected service response. Similarly, accessing IP address 1.2.3.6 yields a response from the nginx service. This example underscores the effectiveness of the Overlay network in ensuring that services can be accessed through their designated External IPs, regardless of the actual pod locations within the cluster.

This enhanced understanding of External IP services underscores the importance of strategic IP management and network configuration in Kubernetes. By aligning service exposure with the network's inherent capabilities, cluster administrators can achieve optimal efficiency and accessibility for their services, paving the way for more streamlined and secure interactions with the Kubernetes cluster.

## [Why not use an Ingress?](#why-not-use-an-ingress)

While Ingress serves as a pivotal tool for exposing services in Kubernetes, it primarily caters to L7 (Layer 7) routing, making it inherently designed for HTTP (port 80) and HTTPS (port 443) traffic. This specialization towards web traffic leverages host-based routing, akin to virtual hosting in traditional web servers, which poses limitations when dealing with services that operate on other ports.

The nature of Ingress restricts its utility for non-web protocols or services requiring exposure on arbitrary ports, which are common in enterprise and specialized applications. Although some Ingress controllers offer capabilities or workarounds to accommodate L4 (Layer 4) routing, thus extending their utility beyond HTTP/HTTPS, these solutions often come with their own set of complexities and limitations. It's worth noting that my explorations in this area are limited; thus, while theoretical possibilities exist to stretch Ingress beyond its primary use case, practical implementations might not always be straightforward or feasible.

This limitation underscores the rationale behind considering alternatives like External IPs for service exposure, particularly in scenarios where services operate on non-standard web ports or demand a higher level of network control. By opting for External IPs, administrators gain the flexibility to expose any service directly on its native port, circumventing the constraints imposed by the Ingress' design. This approach not only simplifies the architecture for certain use cases but also enhances the cluster's capability to support a broader range of applications and services.

## [Weighing the Pros and Cons of External IPs for Service Exposure](#weighing-the-pros-and-cons-of-external-ips-for-service-exposure)

## [Advantages of External IPs](#advantages-of-external-ips)

The utilization of External IPs in Kubernetes offers a significant advantage: unparalleled control over the IP addresses used for exposing services. This control extends to the selection of IPs from your Autonomous System Number (ASN), allowing for a more cohesive and autonomous network management strategy. This capability contrasts sharply with the reliance on IP addresses provisioned by cloud providers, presenting an opportunity for enhanced network identity and independence.

## [Disadvantages of External IPs](#disadvantages-of-external-ips)

However, the application of External IPs is not without its drawbacks. A notable limitation lies in the lack of inherent high availability in simpler External IP setups. In the event of a node failure, the associated service becomes unreachable, necessitating manual intervention for restoration. This characteristic underscores a critical vulnerability in scenarios where continuous service availability is paramount.

Additionally, the management of External IPs requires a hands-on approach. Unlike the dynamic provisioning of resources seen in other Kubernetes services, External IPs demand manual configuration and oversight. This manual management extends from initial setup to ongoing adjustments, potentially increasing the administrative burden on cluster operators.

The trade-offs associated with External IPs highlight a fundamental decision point for administrators: the choice between the granular control offered by direct IP management and the complexities of ensuring high availability and ease of management. While External IPs provide a powerful mechanism for service exposure, especially in environments where specific IP usage is critical, they also underscore the necessity for robust operational practices to mitigate their inherent disadvantages.

## [Implementing the External IP Service: A Practical Guide](#implementing-the-external-ip-service-a-practical-guide)

### [Setting Up Your Kubernetes Cluster](#setting-up-your-kubernetes-cluster)

For the purpose of this demonstration, let's envisage a straightforward cluster configuration, using a schematic representation as our guide. Although this example may not mirror a real-world scenario with perfect fidelity, it offers clarity by distinctly outlining each component's role within the setup. In more complex or realistic applications, you might find scenarios where a MySQL database is exposed via one external IP while a Kafka cluster utilizes another.

Image Placeholder for Cluster Setup Diagram

To bring this tutorial to life, I've set up two virtual machines (VMs) that will serve as the backbone of our Kubernetes cluster. The first VM, named k3s-external-ip-master, acts as the Kubernetes master node, sporting an IP address of 1.2.4.120. The second VM, k3s-external-ip-worker, serves as a worker node, with an IP address of 1.2.4.114. This setup provides a simple yet effective environment for exploring the nuances of the External IP service in Kubernetes.

The decision to utilize two VMs is driven by the aim to demonstrate Kubernetes' flexibility in managing services across multiple nodes. By assigning distinct roles and IP addresses to each VM, we create a microcosm of a larger, more complex cluster. This approach not only simplifies the learning curve but also illustrates the core principles of service exposure and network management in Kubernetes.

In subsequent sections, we'll delve into the specifics of deploying services and exposing them through External IPs, leveraging this two-node cluster as our operational base. This hands-on example will underscore the practicality of External IPs in real-world Kubernetes applications, offering insights into both their potential and their limitations.