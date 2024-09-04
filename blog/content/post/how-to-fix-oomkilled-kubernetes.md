---
title: "How To Fix OOMKilled in Kubernetes"  
date: 2024-09-21T19:26:00-05:00  
draft: false  
tags: ["Kubernetes", "OOMKilled", "Memory", "Troubleshooting", "Containers"]  
categories:  
- Kubernetes  
- Troubleshooting  
author: "Matthew Mattox - mmattox@support.tools."  
description: "Learn how to troubleshoot and fix OOMKilled errors in Kubernetes, ensuring your applications run smoothly without memory issues."  
more_link: "yes"  
url: "/how-to-fix-oomkilled-kubernetes/"  
---

One of the most common issues Kubernetes users encounter is the **OOMKilled** error, which occurs when a pod gets terminated because it ran out of memory. This error can disrupt application performance and cause instability in your environment. In this post, we’ll cover the reasons behind OOMKilled errors and the steps you can take to fix them.

<!--more-->

### What is OOMKilled?

OOMKilled stands for "Out Of Memory Killed." It happens when a container exceeds the memory limits specified for it, and the Linux kernel’s out-of-memory (OOM) killer terminates the process to free up memory. This is Kubernetes’s way of ensuring the stability of the node by stopping processes that consume too much memory.

When a pod is killed due to memory exhaustion, you can confirm this by checking its status:

```bash
kubectl describe pod <pod-name>
```

Look for a reason like `OOMKilled` under the container’s termination state.

### Common Causes of OOMKilled Errors

1. **Memory Limits Set Too Low**: If you set the memory limits too low for a pod, it will hit the limit and be killed by the OOM killer.
2. **Memory Leaks**: The application inside the pod could have a memory leak, causing it to consume more memory over time.
3. **Unoptimized Code**: Some applications may not manage memory efficiently, leading to high memory usage.
4. **Unbounded Memory Usage**: If memory requests and limits are not defined, a container can consume more memory than the node can provide.

### Step 1: Check the Pod’s Resource Limits

The first step in fixing an OOMKilled error is to check whether memory limits are set for the pod. Use the following command to inspect the resource requests and limits:

```bash
kubectl describe pod <pod-name> | grep -A 5 "Limits"
```

If no memory limits are set, the pod can consume more memory than the node can handle. To prevent this, define appropriate memory limits in the pod’s YAML configuration.

```yaml
resources:
  requests:
    memory: "512Mi"
  limits:
    memory: "1Gi"
```

This sets a memory request of 512Mi and a limit of 1Gi. The request guarantees that the container gets at least 512Mi, while the limit prevents it from using more than 1Gi.

### Step 2: Increase Memory Limits

If you find that the pod is hitting the memory limit frequently, increasing the memory limits might resolve the issue. Adjust the `limits` section of the pod's configuration:

```yaml
resources:
  limits:
    memory: "2Gi"
```

Make sure to test different memory values until you find the right balance for your application.

### Step 3: Investigate Memory Usage

If increasing memory limits does not solve the problem, investigate the memory usage of the container to ensure it’s not suffering from a memory leak. You can monitor the container’s memory usage with the following command:

```bash
kubectl top pod <pod-name>
```

This will show the memory usage of each container in the pod. If the memory usage is consistently increasing without bounds, it might indicate a memory leak in the application.

### Step 4: Optimize the Application

If your application is leaking memory or using too much memory, consider optimizing its memory management. Profiling the application with memory management tools like **go tool pprof** for Go applications or **VisualVM** for Java applications can help identify the cause of the memory overuse.

### Step 5: Use Horizontal Pod Autoscaling (HPA)

To prevent OOMKilled errors when traffic spikes or workloads increase, consider using **Horizontal Pod Autoscaling (HPA)**. HPA automatically scales the number of pods based on CPU and memory usage, ensuring your application can handle increased traffic without exceeding memory limits.

Here’s an example of creating an HPA based on memory usage:

```bash
kubectl autoscale deployment <deployment-name> --min=2 --max=10 --memory=80%
```

This scales the deployment based on memory usage, preventing memory exhaustion in individual pods.

### Step 6: Adjust Node Resource Allocation

Sometimes, the issue might be with the node itself running out of memory due to other pods consuming resources. You can reserve memory for system processes using **kube-reserved** and **system-reserved** settings. Adjusting these in your Kubelet configuration can prevent resource contention between system daemons and application pods.

Example settings for reserving memory for system processes:

```yaml
kube-reserved:
  memory: "300Mi"
system-reserved:
  memory: "200Mi"
```

This ensures that Kubernetes system components always have enough memory to function, reducing the chance of OOMKilled errors for your pods.

### Final Thoughts

OOMKilled errors in Kubernetes can be disruptive, but by setting proper memory limits, investigating memory usage, optimizing your application, and configuring autoscaling, you can prevent these issues and keep your applications running smoothly. Remember to monitor your pods regularly and adjust resource allocations as needed to maintain a stable environment.
