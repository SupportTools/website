---
title: "Kubernetes Ingress vs Service Mesh"
date: 2022-07-14T23:22:00-05:00
draft: false
tags: ["Kubernetes", "Ingress", "Service Mesh", "Networking"]
categories:
- Kubernetes
- Ingress
- Service Mesh
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Kubernetes Ingress vs Service Mesh"
more_link: "yes"
---

Getting your network up and running in Kubernetes is no easy task. No matter if you work on the operations or application side, you need to think about networking. Whether it is connecting clusters, control planes, and workers, or connecting Kubernetes Services and Pods, ensuring connectivity is a task that requires attention and effort.

You will learn what a service mesh is, what ingress is, and why you need both in this post.

<!--more-->
# [What’s A Service Mesh](#servicemesh)
In Kubernetes, applications communicate in two primary ways:
- Services
- Pod-to-Pod communication


It isn't recommended to communicate from one pod to another because pods are ephemeral. Unless they are part of a StatefulSet, they do not keep any unique identifiers, as they can go down at any time. In spite of this, pods should be able to communicate with each other in order to enable microservices to talk to one another. Backends must communicate with frontends, middleware must communicate with both backends and frontends, etc.

Services are the next primary communication method. Because Services aren't ephemeral and can only be deleted by engineers, they are preferred. Selectors (sometimes called Labels) are used to connect Pods with Services, so if a Pod goes down but the Selector in the Kubernetes Manifest remains the same, the new Pod will be connected.

This traffic is all unencrypted, and that's the problem. East-West traffic, or pod-to-pod communication, is completely unencrypted. In other words, if you have any concerns about segregation or if a Pod is compromised, there is nothing you can do out of the box.

A Service Mesh handles a lot of that for you. A Service Mesh:
- Encrypts traffic between microservices
- Helps with network latency troubleshooting
- Securely connects Kubernetes Services
- Observability for tracing and alerting

# [What’s Ingress](#ingress)
In addition to secure communication between microservices, you need an interface for interacting with front-end apps. Load balancers that are connected to services are the typical method. Although NodePorts are also available, load balancers are used mostly in the cloud.

There's a problem with cloud load balancers; they're expensive. Every cloud load balancer costs money. It may not be a big deal to have a few applications, but how about 50 or 100? Then there's the matter of managing all of those cloud load balancers. Whenever a Kubernetes Service disconnects from the load balancer, it's your job to fix it.

Management and cost nightmares are abstracted from you with Kubernetes Ingress Controllers. You can have the following features with an Ingress Controller:

- One load balancer
- Multiple applications (Kubernetes Services)sharing the same load balancer

All Kubernetes Services can share a single load balancer. Then, you can access each Kubernetes Service using host and path-based routing.

For example, below is an Ingress Spec that points to a Kubernetes Service called hello-world and outputs it on the hostname hello-world.example.com with the path /hello-world.

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ingress-hello-world
spec:
  rules:
  - host: hello-world.example.com
    http:
      paths:
      - path: /hello-world
        pathType: Prefix
        backend:
          service:
            name: hello-world
            port:
              number: 8080
```

The most common ingress controller is the NGINX Ingress Controller which is basically an Nginx Reverse Proxy with a wrapper that handles converting the Ingress Spec to an Nginx configuration. But of course, you can use any ingress controller you want with most cloud providers having their own implementation.

# [Do You Need Both?](#both)
Ingress Controllers and Service Meshes are frequently discussed between engineers. In my opinion, both are necessary. The reason is as follows.

Their jobs are different. My favorite analogy is the hammer. The handle of the hammer can be used to slam a nail in, but why would I do that if I could use the proper end?

Ingress Controllers are used for the following purposes:
- Making load balancing your apps easier

The purpose of a Service Mesh is to:
- Securing app-to-app communication
- Assist with networking in Kubernetes

It gets even better; there are tools that do both. Istio Ingress, for example, is an ingress controller that can also be used as a secure gateway that uses TLS or mTLS. That's great if you're using one of those tools. If you want it to handle both communication and security for you, make sure it does so. It is still recommended to use the right tool for the job.

As your microservice environment grows, Service Mesh and Ingress become increasingly important.

# [Popular Ingress Controllers and Service Mesh Platforms](#recommendtions)
Listed below are some of the most popular Ingress Controllers and Service Meshes used today.

For Service Mesh:
- (Consul)[https://www.consul.io/]
- (Istio)[https://istio.io/]
- (Linkerd)[https://linkerd.io/]

For Ingress Controllers:
- (NGINX Ingress Controller)[https://kubernetes.github.io/ingress-nginx/]
- (traefik)[https://doc.traefik.io/traefik/providers/kubernetes-ingress/]
- (Kong)[https://github.com/Kong/kubernetes-ingress-controller#readme]
- (Istio)[https://istio.io/]