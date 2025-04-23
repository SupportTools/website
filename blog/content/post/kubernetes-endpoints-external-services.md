---
title: "Leveraging Kubernetes Endpoints to Connect to External Services"
date: 2025-04-23T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Endpoints", "Services", "Networking"]
categories:
  - Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Discover how to use Kubernetes Endpoint objects to bridge your in-cluster applications with external services, providing a unified and manageable access point."
more_link: "yes"
url: "/kubernetes-endpoints-external-services/"
---

Learn how Kubernetes Endpoints facilitate communication between your in-cluster applications and services residing outside the Kubernetes environment.

<!--more-->

# Connecting Kubernetes to the Outside World with Endpoints

## Section 1: Understanding Kubernetes Services and Endpoints

If you've been working with Kubernetes, you're likely familiar with Services. But have you ever delved into the underlying Endpoint objects? Let's clarify these key concepts:

*   **Kubernetes Service:** A Service exposes an application running on one or more Pods as a network service. It provides a stable IP address and DNS name for accessing the application.

*   **Kubernetes Endpoint:** An Endpoint object lists the actual IP addresses and ports of the Pods backing a Service. Kubernetes automatically manages these Endpoints, ensuring the Service always points to healthy and available Pods.

In essence, for every Service, there's a corresponding Endpoint object, dynamically managed by Kubernetes.

## Section 2: The Power of Endpoints for External Services

In real-world scenarios, Kubernetes rarely operates in isolation. You might have:

*   **Public Cloud Environments:** Kubernetes for cloud-native apps alongside managed database services like RDS or Cloud SQL.
*   **On-Premise Environments:** Kubernetes for modern applications coexisting with traditional applications on VMware, OpenStack, or other platforms.

So, how do you connect your Kubernetes-based applications to these external services?

The answer lies in manually creating Endpoint objects. By defining an Endpoint with the IP addresses and port numbers of your external services, you can then create a Kubernetes Service that utilizes this Endpoint. This effectively brings your external service into the Kubernetes ecosystem.

## Section 3: Practical Use Case: Ceph Object Storage

Let's consider a real-world example: accessing a Ceph object storage cluster from within Kubernetes.

In a setup with Red Hat Ceph Object Storage (Ceph) running outside Kubernetes, and accessed via multiple Rados Gateway \(RGW\) services. To provide a single, reliable access point for applications running inside Kubernetes (like Presto, Spark, and Jupyter), a Kubernetes Endpoint object can be created.

This Endpoint object lists all the Ceph RGW endpoints. Subsequently, a Kubernetes Service is created, utilizing this Endpoint. This provides a Kubernetes-native, load-balanced endpoint for the Ceph object storage service.

Alternative solutions, such as external load balancers, introduce single points of failure, limit performance, and add extra network hops.

## Section 4: Conclusion

Kubernetes Endpoint objects offer a simple, effective, and Kubernetes-native way to connect your in-cluster applications to external services. Whether it's databases, legacy systems, or other infrastructure components, Endpoints provide a crucial bridge, allowing you to leverage the power of Kubernetes while integrating with your existing environment. Consider using this approach for accessing any external service, such as a database running outside of your Kubernetes cluster.
