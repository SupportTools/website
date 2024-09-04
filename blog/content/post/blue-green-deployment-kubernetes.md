---
title: "Blue/Green Deployment in Kubernetes"  
date: 2024-09-30T19:26:00-05:00  
draft: false  
tags: ["Kubernetes", "Blue/Green Deployment", "CI/CD", "DevOps", "Deployment Strategy"]  
categories:  
- Kubernetes  
- CI/CD  
- Deployment  
author: "Matthew Mattox - mmattox@support.tools."  
description: "Learn how to implement Blue/Green deployment in Kubernetes to ensure zero-downtime updates and seamless rollbacks for your applications."  
more_link: "yes"  
url: "/blue-green-deployment-kubernetes/"  
---

Blue/Green deployment is a powerful deployment strategy that ensures zero-downtime updates and seamless rollbacks for your Kubernetes applications. By maintaining two separate environments—one running the current version (Blue) and one running the new version (Green)—you can safely switch between versions without disrupting user traffic. In this post, we’ll guide you through setting up Blue/Green deployment in Kubernetes, explaining the benefits, the process, and how to implement it in your cluster.

<!--more-->

### What is Blue/Green Deployment?

Blue/Green deployment is a deployment strategy that involves running two identical production environments—one labeled **Blue** (the current version of the application) and one labeled **Green** (the new version). The idea is to route traffic to the Green environment once it’s fully tested and validated, while the Blue environment remains available as a fallback in case of issues with the Green version.

This approach offers several benefits:

- **Zero Downtime**: Since both versions are running simultaneously, there is no downtime when switching between them.
- **Instant Rollbacks**: If an issue occurs in the new version, you can quickly revert traffic back to the Blue environment.
- **Smooth Transitions**: Testing can be performed on the Green environment while Blue continues serving traffic, ensuring the Green version works as expected before switching.

### Step 1: Create the Blue Environment

To implement Blue/Green deployment in Kubernetes, we’ll first create the Blue environment, which represents the current version of the application running in production.

#### 1. **Create a Kubernetes Deployment for Blue**:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp-blue
spec:
  replicas: 3
  selector:
    matchLabels:
      app: myapp
      version: blue
  template:
    metadata:
      labels:
        app: myapp
        version: blue
    spec:
      containers:
      - name: myapp
        image: myapp:v1
        ports:
        - containerPort: 80
```

This defines a deployment for the Blue version of the application, running version `v1` of the `myapp` image.

#### 2. **Expose the Blue Environment Using a Service**:

Next, create a service to expose the Blue deployment to external traffic:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: myapp-service
spec:
  selector:
    app: myapp
    version: blue
  ports:
  - protocol: TCP
    port: 80
    targetPort: 80
  type: LoadBalancer
```

This service routes external traffic to the Blue environment by selecting pods labeled with `version: blue`.

### Step 2: Deploy the Green Environment

Now that the Blue environment is up and running, we’ll deploy the Green environment, representing the new version of the application.

#### 1. **Create a Kubernetes Deployment for Green**:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp-green
spec:
  replicas: 3
  selector:
    matchLabels:
      app: myapp
      version: green
  template:
    metadata:
      labels:
        app: myapp
        version: green
    spec:
      containers:
      - name: myapp
        image: myapp:v2
        ports:
        - containerPort: 80
```

In this deployment, we use the `myapp:v2` image, representing the new version of the application. This deployment runs alongside the Blue environment but doesn’t yet receive external traffic.

#### 2. **Update the Service to Point to the Green Environment**:

Once the Green environment is validated and ready for production, update the service to point to the Green deployment:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: myapp-service
spec:
  selector:
    app: myapp
    version: green
  ports:
  - protocol: TCP
    port: 80
    targetPort: 80
  type: LoadBalancer
```

This change switches traffic from the Blue environment to the Green environment without causing downtime. The Blue environment is still running and can serve as a fallback in case issues arise with the Green version.

### Step 3: Rollback If Needed

If there’s an issue with the Green deployment, rolling back to the Blue version is simple. Just update the service’s selector to point back to the Blue environment:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: myapp-service
spec:
  selector:
    app: myapp
    version: blue
  ports:
  - protocol: TCP
    port: 80
    targetPort: 80
  type: LoadBalancer
```

Traffic is instantly routed back to the Blue deployment, ensuring minimal disruption.

### Step 4: Clean Up

Once the Green environment is fully validated and no issues are detected, you can decommission the Blue environment to free up resources:

```bash
kubectl delete deployment myapp-blue
```

Alternatively, keep the Blue deployment running as a backup until the next release.

### Benefits of Blue/Green Deployment

- **Zero-Downtime Deployments**: By switching traffic between two environments, you avoid any downtime during deployments.
- **Quick Rollbacks**: If issues are detected in the Green environment, traffic can be reverted to the Blue environment instantly.
- **A/B Testing**: You can perform A/B testing by routing a subset of traffic to the Green environment while Blue continues serving the majority of users.

### Final Thoughts

Blue/Green deployment in Kubernetes is a powerful strategy for deploying new versions of applications without downtime. By maintaining two identical environments and switching traffic between them, you can ensure smooth transitions, faster rollbacks, and a better overall user experience. This approach is ideal for environments where availability and reliability are critical.
