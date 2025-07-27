---
title: "Why Not Using Liveness and Readiness Probes in Kubernetes Can Hurt Your Applications"
date: 2024-08-20T02:40:00-05:00
draft: false
tags: ["Kubernetes", "Best Practices", "Probes"]
categories:
- Kubernetes
- Best Practices
author: "Matthew Mattox - mmattox@support.tools"
description: "Understanding the importance of Liveness and Readiness Probes in Kubernetes and how they contribute to the resilience and reliability of your applications."
more_link: "yes"
url: "/not-using-liveness-readiness-probes/"
---

When deploying applications on Kubernetes, ensuring their reliability and resilience is critical. A key aspect of achieving this is the proper use of **Liveness** and **Readiness** probes. These probes help Kubernetes monitor the health of your Pods and react appropriately when things go wrong. However, they are often overlooked or misconfigured, leading to avoidable issues in production environments.

In this post, we’ll explore why Liveness and Readiness probes are essential, how they work, and provide examples of how to implement them in your Kubernetes deployments.

<!--more-->

## [What Are Liveness and Readiness Probes?](#what-are-liveness-and-readiness-probes)

### Liveness Probes

**Liveness probes** tell Kubernetes when to restart a container that has entered a broken state. A container might be running, but if it\'s malfunctioning or stuck, it may not be able to recover on its own. Liveness probes detect this condition and instruct Kubernetes to kill the container and start a new one. This ensures that your application continues running smoothly without manual intervention.

### Readiness Probes

**Readiness probes** inform Kubernetes when a container is ready to start accepting traffic. During application startup, there might be initialization tasks that need to complete before the container can handle requests. Readiness probes prevent traffic from being routed to the container until it is fully ready, which helps avoid errors during deployment or restarts.

By using these probes, you can significantly improve the robustness of your applications in Kubernetes, ensuring they can recover from faults and are only available when they\'re ready to serve traffic.

## [Why Not Using Probes is a Bad Idea](#why-not-using-probes-is-a-bad-idea)

Without Liveness and Readiness probes, Kubernetes has no way of knowing whether your containers are functioning correctly. This can lead to several issues:

- **Unresponsive Containers**: If a container becomes unresponsive but doesn\'t crash, Kubernetes won\'t automatically restart it. This could lead to prolonged downtime or degraded performance.
  
- **Premature Traffic Routing**: Without Readiness probes, Kubernetes might send traffic to a container that isn\'t fully initialized, leading to failed requests and poor user experience.

- **Increased Manual Intervention**: In the absence of these probes, you\'ll likely need to manually monitor your containers and intervene when something goes wrong, which is time-consuming and error-prone.

## [Configuring Liveness and Readiness Probes](#configuring-liveness-and-readiness-probes)

Configuring these probes in your Kubernetes deployments is straightforward. Here’s an example of a simple Pod configuration with both Liveness and Readiness probes:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: probes-demo
spec:
  containers:
    - name: probes-demo
      image: nginx:latest
      livenessProbe:
        httpGet:
          path: /
          port: 80
      readinessProbe:
        httpGet:
          path: /
          port: 80
```

### Example Breakdown

- **Liveness Probe**: This example uses an HTTP GET request to check the root (`/`) of the container. If the probe fails (for example, by returning a non-200 status code), Kubernetes will consider the container unhealthy and restart it.

- **Readiness Probe**: Similarly, this probe also performs an HTTP GET request to the root (`/`) of the container. Kubernetes will only mark the Pod as ready to receive traffic once this probe passes.

### Other Probe Types

Kubernetes supports several types of probes, including:

- **HTTP Probe**: Checks the health of the application by making an HTTP GET request to a specified endpoint.
  
- **TCP Probe**: Tests the container\'s health by attempting to open a TCP connection to the specified port.
  
- **gRPC Probe**: Uses gRPC to check the health of the application.
  
- **Command Probe**: Executes a command inside the container. If the command exits with a status code of 0, the container is considered healthy.

Here’s an example of a TCP probe configuration:

```yaml
livenessProbe:
  tcpSocket:
    port: 3306
  initialDelaySeconds: 10
  periodSeconds: 10
```

In this example, Kubernetes attempts to open a TCP connection to port 3306 every 10 seconds after an initial delay of 10 seconds. If the connection fails, the container is restarted.

## [Best Practices for Using Probes](#best-practices-for-using-probes)

To get the most out of Liveness and Readiness probes, consider the following best practices:

- **Tune Probe Timing**: Use the `initialDelaySeconds`, `periodSeconds`, `timeoutSeconds`, and `failureThreshold` fields to fine-tune your probes. This ensures they work correctly without causing unnecessary restarts.

- **Align Probes with Application Behavior**: Customize your probe configurations based on the nature of your application. For example, a database might take longer to initialize, so the Readiness probe should reflect that.

- **Monitor Probe Failures**: Regularly monitor and log probe failures. Persistent failures might indicate underlying issues with your application that need to be addressed.

- **Use Command Probes for Complex Checks**: If your application requires a more complex health check than what an HTTP or TCP probe can provide, consider using a command probe to run custom scripts.

## [Conclusion](#conclusion)

Liveness and Readiness probes are critical for maintaining the health and reliability of your Kubernetes applications. They enable Kubernetes to automatically recover from failures and ensure that your containers only serve traffic when they\'re ready. By configuring these probes appropriately, you can reduce downtime, improve user experience, and create a more resilient system.

Don’t overlook the importance of these probes in your deployments. Take the time to configure them correctly, and your applications will be much better equipped to handle the challenges of running in a dynamic, distributed environment like Kubernetes.
