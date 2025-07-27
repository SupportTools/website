---
title: "Setting Up a Private Docker Registry in k3s on Raspberry Pi"
date: 2024-05-18T03:26:00-05:00
draft: false
tags: ["k3s", "Raspberry Pi", "Docker", "Private Registry"]
categories:
- DevOps
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to set up a private Docker registry within a k3s cluster on Raspberry Pi, ensuring secure and efficient deployment of your own applications."
more_link: "yes"
---

Learn how to set up a private Docker registry within a k3s cluster on Raspberry Pi, ensuring secure and efficient deployment of your own applications.

<!--more-->

# [Setting Up a Private Docker Registry in k3s on Raspberry Pi](#setting-up-a-private-docker-registry-in-k3s-on-raspberry-pi)

In order to deploy our own applications, we need a private Docker registry. This guide will help you run the registry inside the k8s cluster on your Raspberry Pi.

## [The Basics](#the-basics)

First, we'll need a deployment for our Docker registry:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: docker-registry
  namespace: docker-registry
  labels:
    app: docker-registry
spec:
  replicas: 1
  selector:
    matchLabels:
      app: docker-registry
  template:
    metadata:
      labels:
        app: docker-registry
        name: docker-registry
    spec:
      containers:
      - name: registry
        image: registry:2
        ports:
        - containerPort: 5000
```

Create the namespace for the Docker registry:

```bash
kubectl create namespace docker-registry
```

Then, apply the deployment:

```bash
kubectl apply -f docker-registry.yml
```

Check if it's running:

```bash
kubectl --namespace docker-registry get all
```

## [Setting Up Services](#setting-up-services)

To make the registry accessible to other nodes and, if necessary, outside the cluster, we can expose the service using ClusterIP and NodePort settings:

```bash
kubectl --namespace docker-registry expose deploy docker-registry
```

Check the service:

```bash
kubectl --namespace docker-registry get service
```

Access the registry:

```bash
curl http://10.43.241.2:5000/v2/_catalog
{"repositories":[]}
```

For a more controlled setup, create the service with a YAML file. First, get the existing service definition:

```bash
kubectl --namespace docker-registry get service docker-registry -o yaml > service.yml
```

Edit the file to include only the required parts:

```yaml
apiVersion: v1
kind: Service
metadata:
  labels:
    app: docker-registry
  name: docker-registry
  namespace: docker-registry
spec:
  ports:
  - port: 5000
    protocol: TCP
    targetPort: 5000
  selector:
    app: docker-registry
  type: ClusterIP
```

Apply the service definition:

```bash
kubectl apply -f service.yml
```

You might see a warning about the missing `kubectl.kubernetes.io/last-applied-configuration` annotation, but the service will still be configured:

```bash
Warning: resource services/docker-registry is missing the kubectl.kubernetes.io/last-applied-configuration annotation which is required by kubectl apply. kubectl apply should only be used on resources created declaratively by either kubectl create --save-config or kubectl apply. The missing annotation will be patched automatically.
service/docker-registry configured
```

Verify that it works:

```bash
curl http://10.43.236.176:5000/v2/_catalog
{"repositories":[]}
```

By following these steps, you can set up a private Docker registry within your k3s cluster on Raspberry Pi, ensuring secure and efficient deployment of your applications.
