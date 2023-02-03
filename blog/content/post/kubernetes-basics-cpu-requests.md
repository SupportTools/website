---
title: "Kubernetes Networking: Understanding the Basics"
date: 2023-02-02T19:52:00-06:00
draft: false
tags: ["Kubernetes", "CPU requests", "compute capacity", "Service Level Agreement (SLA)", "pod", "runtime", "example"]
categories:
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools."
description: "Learn about CPU requests in Kubernetes and how they guarantee the minimum amount of compute capacity required by your application to run. CPU requests are always guaranteed at runtime and provide a Service Level Agreement (SLA) between the pod and Kubernetes. This blog post explains CPU requests and provides an example to demonstrate how they work."
more_link: "yes"
---

Learn about CPU requests in Kubernetes and how they guarantee the minimum amount of compute capacity required by your application to run. CPU requests are always guaranteed at runtime and provide a Service Level Agreement (SLA) between the pod and Kubernetes. This blog post explains CPU requests and provides an example to demonstrate how they work.

<!--more-->
# [Introduction](#introduction)
CPU requests in Kubernetes specify the minimum amount of compute capacity required by your application to run. You can specify CPU requests for each container in your pod, and the sum of all CPU requests is used by the scheduler to find a node in the Kubernetes cluster with enough resources available.

Once the pod runs on a node, its CPU requests are guaranteed/reserved.

# [Guaranteed/Reserved](#guaranteedreserved)
The terms "guaranteed" and "reserved" may have different interpretations based on our cultural and personal understanding. To clarify, when pods use CPU requests and are scheduled onto a node, Kubernetes provides them with a Service Level Agreement (SLA). The SLA between the pod and Kubernetes can be phrased as follows:

"Whenever you need your CPU requests, you immediately get them assigned and have them available. However, every other pod on the node can use your CPU requests as long as you do not need them."

In this way, CPU requests are always guaranteed at runtime. Whenever the original pod does not need its CPU requests, they are available in a pool to be used by every other pod on the node. Whenever the original pod needs its CPU requests, the CPU scheduler immediately assigns the compute capacity to the pod.

# [Example](#example)
In this example, I will use the containerstack CPU stress test tool to generate constant CPU load for four pods deployed on a three-node Azure Kubernetes Service cluster. Each node has four cores and 16 GB of memory available. The Kubernetes template deploys all four pods onto the same node and keeps the CPU stress test running for one hour. Each pod has a CPU request of 0.5.

To demonstrate CPU requests, I will also use a pod that is idling around and does not use its CPU requests. I selected the azure-ip-masq-agent, which has CPU requests of 100m.

# [Conclusion](#conclusion)
In this blog post, I explained what CPU requests in Kubernetes are and how they work. CPU requests guarantee the minimum amount of compute capacity required by your application to run, and they are always guaranteed at runtime. I also provided an example to demonstrate CPU requests in action.