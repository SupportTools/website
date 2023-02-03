---
title: "Kubernetes Networking Deep Dive - Overlay Networks and Traffic Flow"
date: 2023-02-03T02:44:00-06:00
draft: false
tags: ["Kubernetes networking", "overlay network", "traffic flow", "Pods", "network plugins", "canal", "flannel", "calico", "network segmentation", "isolation", "security", "performance"]categories:
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools."
description: "This blog post covers the basics of overlay networks in Kubernetes and how traffic flows between Pods on the same node and different nodes, as well as how traffic flows to external services. We will explore network plugins such as canal, flannel, and calico and their role in providing network segmentation, isolation, security, and performance."
more_link: "yes"
---

Kubernetes is an open-source platform that automates containerized applications' deployment, scaling, and management. One of the essential components of Kubernetes is networking, which enables the communication between containers and between containers and external resources.

<!--more-->
# [Kubernetes Overlay Networks](#kubernetes-overlay-networks)
An overlay network in Kubernetes is a virtual network that spans multiple nodes in a cluster and provides connectivity between Pods running on different nodes. The overlay network is built on top of the physical network infrastructure and enables the communication between Pods, regardless of their physical location in the cluster.

# [Traffic Flow Between Pods on the Same Node](#traffic-flow-between-pods-on-the-same-node)
When Pods run on the same node, they communicate using the loopback interface. Traffic between Pods on the same node is fast and efficient, as it does not traverse the network infrastructure.

For example, consider a scenario where Pod A wants to communicate with Pod B on the same node. The traffic flow would be as follows:

```
Pod A -> loopback -> Pod B
```

In this diagram, the traffic flows from Pod A to Pod B through the loopback interface, a virtual interface that enables the communication between Pods on the same node. This means the traffic never leaves the CPU and does not traverse the network.

# [Traffic Flow Between Pods on Different Nodes](#traffic-flow-between-pods-on-different-nodes)
When Pods run on different nodes, they communicate with each other using the overlay network. Traffic between Pods on different nodes is encapsulated and transmitted over the network infrastructure.

For example, consider a scenario where Pod A runs on node 1 and wants to communicate with Pod B on node 2. The traffic flow would be as follows:

```
Pod A (node 1) -> CNI pod -> Phyical network -> CNI pod -> Pod B (node 2)
```

In this diagram, the traffic flows from Pod A on Node 1 to Pod B on Node 2 through the overlay network. The overlay network provides a virtual network that spans all nodes in the cluster, allowing pods to communicate with each other regardless of location. As far as the Pods are concerned, they are communicating with each other on the same network, IE, a layer 2 network. The overlay network is built on top of the physical network infrastructure and enables the communication between Pods, regardless of their physical location in the cluster.

# [Traffic Flow to External Services](#traffic-flow-to-external-services)
Pods can communicate with external services such as databases, APIs, and other resources. The network plugin routes traffic from the Pod to the external service using the node's network stack. The network traffic is transmitted directly from the node to the external service, bypassing the overlay network.

For example, consider a scenario where Pod A wants to communicate with an external service S. The traffic flow would be as follows:

```
Pod A -> Host's network -> External service.
```

In this diagram, the traffic flows from the pod to the external service through the overlay network. The overlay network provides a virtual network that spans all cluster nodes, allowing pods to communicate with external services. The external service is typically accessed through a service discovery mechanism, such as DNS or environment variables. The network plugin routes the network traffic from the Pod to the external service using the node's network stack. The network traffic is transmitted directly from the node to the external service, bypassing the overlay network.

# [The Role of Network Plugins in Kubernetes Networking](#the-role-of-network-plugins-in-kubernetes-networking)
In Kubernetes, network plugins are used to implement the overlay network. Network plugins are responsible for setting up the virtual network, encapsulating and transmitting traffic between Pods on different nodes, and routing traffic to external services.

Several popular network plugins are available for Kubernetes, each with its own features and capabilities. Some of the most widely used network plugins include canal, flannel, and calico.

## [Canal](#canal)
The canal is a network plugin that combines the capabilities of flannel and calico. Canal provides a complete network solution for Kubernetes, offering layer 2 and layer 3 networking capabilities. With canal, you can implement network segmentation, isolation, security, and performance, providing a flexible and scalable solution for your networking needs.

## [Flannel](#flannel)
Flannel is a straightforward network plugin that provides layer 2 networking for Kubernetes. Flannel uses VXLAN to encapsulate network traffic and provides a flat network that enables the communication between Pods, regardless of their location in the cluster. Flannel is a good choice for smaller clusters and environments where network segmentation and isolation are not required.

## [Calico](#calico)
Calico is a robust and flexible network plugin that provides both layer 2 and 3 networking capabilities for Kubernetes. Calico delivers network segmentation and isolation, security, and performance, making it a good choice for larger clusters and environments where network security and performance are a concern.

# [Choosing the Right Network Plugin for Your Use Case](#choosing-the-right-network-plugin-for-your-use-case)
When choosing a network plugin for your Kubernetes cluster, it's essential to consider the specific requirements of your use case. For example, flannel may be a good choice if you're deploying a simple application, as it provides a straightforward network solution. On the other hand, if you're deploying a complex microservice architecture, you may need a more robust network plugin like calico, which provides network segmentation, isolation, security, and performance.

In conclusion, the choice of network plugin will depend on the specific requirements of your use case, as well as your goals for network segmentation, isolation, security, and performance. It's important to carefully evaluate your options and choose a network plugin that will meet the needs of your application and provide the level of performance, security, and scalability you require.

Most cloud providers offer a managed Kubernetes service, which includes a network plugin. For example, Amazon EKS includes calico, while Azure AKS has canal. Consider using the network plugin if you're deploying a Kubernetes cluster on a cloud provider. This will save you the time and effort of installing and configuring a network plugin. These network plugins can have extra features not available in the open-source versions, such as direct integration with the cloud provider's network infrastructure. For example, the AWS VPC CNI plugin provides direct integration with AWS VPC meaning your pods can communicate with other pods and services in the same VPC without traversing the internet. This is an excellent feature for security and performance. In addition, external services like AWS's ALB can directly communicate with your pods without needing node ports or load balancers.

# [Changing CNI Providers](#changing-cni-providers)
Changing the Container Network Interface (CNI) provider in a Kubernetes cluster is generally not recommended. The CNI provider is a critical component of the Kubernetes networking infrastructure. It is responsible for allocating network addresses, routing traffic between nodes and Pods, and providing network services such as Load Balancing and network security.

Changing the CNI provider can have severe consequences for the network connectivity and stability of the cluster and impact the application's network performance and security. The CNI provider integrates with various other components of the Kubernetes cluster, such as the control plane, kubelets, and the Kubernetes API server. Changing the CNI provider can result in misconfigurations and inconsistencies in the cluster, leading to network issues, such as connectivity loss, network partitions, and security vulnerabilities.

Therefore, if you need to change the CNI provider, it is crucial to follow a well-defined process, which typically involves backing up the cluster's data, upgrading the control plane components, updating the network configuration, and testing the network connectivity and functionality before applying the changes to the entire cluster.

This includes RKE1 and RKE2 clusters that do not officially support changing CNI providers. This is mainly because changing the CNI provider can have severe consequences for the network connectivity and stability of the cluster and impact the application's network performance and security. The CNI provider integrates with various other components of the Kubernetes cluster, such as the control plane, kubelets, and the Kubernetes API server. Changing the CNI provider can result in misconfigurations and inconsistencies in the cluster, leading to network issues, such as connectivity loss, network partitions, and security vulnerabilities. Think of it like changing a tire on a moving car. It can be done, but it's not recommended.

If you need to change the CNI provider, creating a new cluster with the desired CNI provider and migrating your workloads to the new cluster is recommended.

# [Conclusion](#conclusion)
Kubernetes networking overlay is an essential component of the Kubernetes platform, enabling communication between pods and between pods and external services. The overlay network provides a virtual network that spans all nodes in the cluster, allowing pods to communicate with each other regardless of location. The overlay network is implemented using a network plugin, such as flannel, calico, or canal, and provides a flexible and robust infrastructure for network traffic in a Kubernetes cluster. Whether you're deploying a simple application or a complex microservice architecture, the Kubernetes networking overlay provides a flexible and scalable solution for your networking needs.